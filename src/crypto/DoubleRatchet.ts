import { RatchetState, CipherMessage, CipherMessageHeader } from './types.d';
import { KeyStore } from './KeyStore';
import { deserialize, toHex, fromHex, concatBytes, utf8Encode } from '../utilities';
import {
    encryptAesGcm,
    decryptAesGcm,
    deriveBitsHkdf,
    randomBytes,
    AES_GCM_IV_BYTES,
} from './primitives';

// We rely on the WebCrypto global (`crypto`/`globalThis.crypto`) — present in
// browsers, CF Workers, and Node 19+. No `require('crypto')` Node fallback;
// supported runtimes all expose WebCrypto natively.

async function getPubKeyHex(pubKey: CryptoKey): Promise<string> {
    const exported = await crypto.subtle.exportKey('raw', pubKey);
    return toHex(new Uint8Array(exported));
}

async function keysEqual(key1: CryptoKey, key2: CryptoKey): Promise<boolean> {
    const hex1 = await getPubKeyHex(key1);
    const hex2 = await getPubKeyHex(key2);
    return hex1 === hex2;
}


class DoubleRatchet {
    private state: RatchetState;
    private sessionType: 'global' | 'specific';
    private maxSkip: number = 3000;
    private overlapPeriod: number = 30000; // ms
    private windowSize: number = 100; // messages per DH ratchet

    constructor(senderId: string, recipientId: string, sessionType: 'global' | 'specific', isClient: boolean = true) {
        this.sessionType = sessionType;
        const keyStore = KeyStore.getInstance();
        const senderKeyPair = keyStore.getKeyPair(senderId);
        const recipientKeyPair = keyStore.getKeyPair(recipientId);

        if (!senderKeyPair || !senderKeyPair.privateKey) {
            throw new Error(`Missing own key pair for sender ${senderId}`);
        }
        if (!recipientKeyPair || !recipientKeyPair.publicKey) {
            throw new Error(`Missing public key for recipient ${recipientId}`);
        }

        this.state = {
            clientDhPriv: isClient ? senderKeyPair.privateKey : null,
            clientDhPub: isClient ? senderKeyPair.publicKey : recipientKeyPair.publicKey,
            serverDhPriv: isClient ? null : senderKeyPair.privateKey,
            serverDhPub: isClient ? recipientKeyPair.publicKey : senderKeyPair.publicKey,
            rootKey: null,
            sendChainKey: null,
            recvChainKey: null,
            sendCount: 0,
            recvCount: 0,
            prevChainLength: 0,
            currentSkippedKeys: new Map(),
            oldSkippedMessageKeys: new Map(),
        };

        appLogger.debug(`Constructor: senderId=${senderId}, recipientId=${recipientId}, isClient=${isClient}`);
    }

    private hkdf(input: Uint8Array, info: string, length: number): Promise<Uint8Array> {
        return deriveBitsHkdf(input, info, length);
    }

    public async initializeSession(isClient: boolean = true): Promise<void> {
        appLogger.debug(`Initializing session: isClient=${isClient}, sessionType=${this.sessionType}`);
        const ownPriv = isClient ? this.state.clientDhPriv : this.state.serverDhPriv;
        if (!ownPriv) {
            throw new Error('Missing own private key');
        }
        const remotePub = isClient ? this.state.serverDhPub : this.state.clientDhPub;
        const sharedSecret = await crypto.subtle.deriveBits(
            { name: 'ECDH', public: remotePub },
            ownPriv,
            384
        );
        const keys = await this.hkdf(new Uint8Array(sharedSecret), 'DoubleRatchetInit', 32);
        this.state.rootKey = keys;
        this.state.sendChainKey = this.state.rootKey;
        this.state.recvChainKey = this.state.rootKey;
        appLogger.debug(`Initialized: rootKey set`);
    }

    private async dhRatchet(newPubKey: CryptoKey, isClient: boolean = true): Promise<void> {
        appLogger.debug(`DH ratchet: isClient=${isClient}`);
        const ownPriv = isClient ? this.state.clientDhPriv : this.state.serverDhPriv;
        if (!ownPriv) {
            throw new Error('Missing own private key');
        }
        const sharedSecret = await crypto.subtle.deriveBits(
            { name: 'ECDH', public: newPubKey },
            ownPriv,
            384
        );
        const input = concatBytes(this.state.rootKey!, new Uint8Array(sharedSecret));
        const keys = await this.hkdf(input, 'DoubleRatchetDH', 64);
        this.state.rootKey = keys.subarray(0, 32);
        this.state.recvChainKey = keys.subarray(32);
        this.state.sendChainKey = isClient ? this.state.recvChainKey : this.state.rootKey;
        this.state.prevChainLength = this.state.sendCount;
        this.state.sendCount = 0;
        this.state.recvCount = 0;
        appLogger.debug(`DH ratchet complete`);
    }

    private async symmetricRatchet(chainKey: Uint8Array): Promise<[Uint8Array, Uint8Array]> {
        const keys = await this.hkdf(chainKey, 'DoubleRatchetMsg', 64);
        const messageKey = keys.subarray(0, 32);
        const newChainKey = keys.subarray(32);
        appLogger.debug(`Symmetric ratchet: messageKey generated`);
        return [messageKey, newChainKey];
    }

    public async encrypt(
        plaintext: string,
        newDhKey: boolean = false,
        senderId: string,
        recipientId: string,
        sessionId: string,
        sessionType: 'global' | 'specific'
    ): Promise<CipherMessage> {
        if (sessionType !== this.sessionType) {
            throw new Error(`Session type mismatch: expected ${this.sessionType}, got ${sessionType}`);
        }

        const keyStore = KeyStore.getInstance();
        if (this.sessionType === 'specific' && this.state.sendCount >= this.windowSize && this.state.sendCount > 0) {
            newDhKey = true;
        }
        if (newDhKey && this.sessionType === 'specific') {
            appLogger.debug(`Generating new DH key pair for ${senderId}`);
            const ecdhKeyPair = await crypto.subtle.generateKey(
                { name: 'ECDH', namedCurve: 'P-384' },
                true,
                ['deriveKey', 'deriveBits']
            );
            this.state.clientDhPriv = ecdhKeyPair.privateKey as CryptoKey;
            this.state.clientDhPub = ecdhKeyPair.publicKey as CryptoKey;
            keyStore.keys.set(senderId, { privateKey: ecdhKeyPair.privateKey as CryptoKey, publicKey: ecdhKeyPair.publicKey as CryptoKey });
            await this.dhRatchet(this.state.serverDhPub, true);
        }

        const [messageKey, newChainKey] = await this.symmetricRatchet(this.state.sendChainKey!);
        this.state.sendChainKey = newChainKey;

        const iv = randomBytes(AES_GCM_IV_BYTES);
        const encrypted = await encryptAesGcm(messageKey, iv, utf8Encode(plaintext));
        const cipherTextWithTag = toHex(encrypted);
        appLogger.debug(`Encrypt: plaintextLength=${plaintext.length}, ciphertextLength=${encrypted.byteLength}`);

        this.state.sendCount++;
        const dehydratedSender = await keyStore.dehydrateKeyPair(senderId);
        const header: CipherMessageHeader = {
            dhPub: dehydratedSender.ecdhPub,
            prevChainLength: this.state.prevChainLength,
            messageNumber: this.state.sendCount,
            sessionId,
            sessionType,
            senderId,
            recipientId,
            timestamp: Date.now(),
            signature: '',
        };
        appLogger.debug(`Message header:`, header);
        appLogger.debug(`Message header:`, keyStore.getAuthKeyPair(senderId)!.privateKey!);
        const sign = await crypto.subtle.sign(
            { name: 'ECDSA', hash: 'SHA-256' },
            keyStore.getAuthKeyPair(senderId)!.privateKey!,
            utf8Encode(JSON.stringify({
                dhPub: header.dhPub,
                prevChainLength: header.prevChainLength,
                messageNumber: header.messageNumber,
                sessionId,
                sessionType,
                senderId,
                recipientId,
                timestamp: header.timestamp
            }))
        );
        header.signature = toHex(new Uint8Array(sign));

        appLogger.debug(`Encrypted: sessionId=${sessionId}, messageNumber=${this.state.sendCount}, sender=${senderId}, recipient=${recipientId}`);
        return {
            header,
            ciphertext: cipherTextWithTag,
            nonce: toHex(iv),
        };
    }

    private cleanOldSkippedKeys(): void {
        const now = Date.now();
        for (const skipped of this.state.oldSkippedMessageKeys.entries()) {
            // [pubHex, { created }]
            const pubHex = skipped[0];
            const data = skipped[1];
            const created = data.created;
            if (now > created + this.overlapPeriod) {
                this.state.oldSkippedMessageKeys.delete(pubHex);
            }
        }
    }

    public async decrypt(message: CipherMessage, isClient: boolean = true): Promise<string> {
        // const { header, ciphertext, nonce } = message;
        const header = message.header;
        const ciphertext = message.ciphertext;
        const nonce = message.nonce;
        if (header.sessionType !== this.sessionType) {
            throw new Error(`Session type mismatch: expected ${this.sessionType}, got ${header.sessionType}`);
        }

        const keyStore = KeyStore.getInstance();
        const verify = await crypto.subtle.verify(
            { name: 'ECDSA', hash: 'SHA-256' },
            keyStore.getAuthKeyPair(header.senderId)!.publicKey,
            fromHex(header.signature),
            utf8Encode(JSON.stringify({
                dhPub: header.dhPub,
                prevChainLength: header.prevChainLength,
                messageNumber: header.messageNumber,
                sessionId: header.sessionId,
                sessionType: header.sessionType,
                senderId: header.senderId,
                recipientId: header.recipientId,
                timestamp: header.timestamp
            }))
        );
        if (!verify) {
            throw new Error('Invalid signature');
        }

        const maxAge = 5 * 60 * 1000;
        if (Math.abs(Date.now() - header.timestamp) > maxAge) {
            throw new Error('CipherMessage too old, possible replay attack');
        }

        appLogger.debug(`Decrypting: sessionId=${header.sessionId}, messageNumber=${header.messageNumber}, sender=${header.senderId}, recipient=${header.recipientId}`);

        if (!ciphertext || !nonce || !header.dhPub) {
            throw new Error('Invalid message: missing ciphertext, nonce, or dhPub');
        }

        if (!/^[0-9a-fA-F]+$/.test(ciphertext) || ciphertext.length % 2 !== 0) {
            throw new Error(`Invalid ciphertext: not a valid hex string (length=${ciphertext.length})`);
        }

        if (!/^[0-9a-fA-F]+$/.test(nonce) || nonce.length % 2 !== 0) {
            throw new Error(`Invalid nonce: not a valid hex string (length=${nonce.length})`);
        }

        const ciphertextBuffer = fromHex(ciphertext);
        const nonceBuffer = fromHex(nonce);
        if (nonceBuffer.length !== 12) {
            throw new Error(`Invalid nonce: must be 12 bytes (length=${nonceBuffer.length})`);
        }

        const senderPubJwk = JSON.parse(deserialize(header.dhPub));
        const senderPubKey = await crypto.subtle.importKey(
            'jwk',
            senderPubJwk,
            { name: 'ECDH', namedCurve: 'P-384' },
            true,
            []
        );
        const senderPubHex = await getPubKeyHex(senderPubKey as CryptoKey);
        const currentSenderPub = isClient ? this.state.serverDhPub : this.state.clientDhPub;
        const currentSenderPubHex = await getPubKeyHex(currentSenderPub);

        this.cleanOldSkippedKeys();

        let messageKey: Uint8Array;
        if (senderPubHex === currentSenderPubHex) {
            // Current chain
            if (header.messageNumber > this.state.recvCount) {
                const numSkips = header.messageNumber - this.state.recvCount - 1;
                if (numSkips > this.maxSkip) {
                    throw new Error('Too many skipped messages');
                }
                for (let i = 0; i < numSkips; i++) {
                    const [skippedKey, newChainKey] = await this.symmetricRatchet(this.state.recvChainKey!);
                    this.state.currentSkippedKeys.set(this.state.recvCount + 1 + i, skippedKey);
                    this.state.recvChainKey = newChainKey;
                }
            }

            if (this.state.currentSkippedKeys.has(header.messageNumber)) {
                messageKey = this.state.currentSkippedKeys.get(header.messageNumber)!;
                this.state.currentSkippedKeys.delete(header.messageNumber);
                appLogger.debug(`Using skipped key for messageNumber=${header.messageNumber}`);
            } else {
                const [msgKey, newChainKey] = await this.symmetricRatchet(this.state.recvChainKey!);
                messageKey = msgKey;
                this.state.recvChainKey = newChainKey;
            }

            this.state.recvCount = Math.max(this.state.recvCount, header.messageNumber);
        } else {
            // Check if new DH pub
            const expectedPubKey = keyStore.getKeyPair(header.senderId)!.publicKey;
            if (!(await keysEqual(senderPubKey as CryptoKey, expectedPubKey))) {
                // New DH key, handle skip on old chain before ratchet
                const oldSenderPubHex = currentSenderPubHex;
                const numSkips = header.prevChainLength - this.state.recvCount;
                if (numSkips > this.maxSkip) {
                    throw new Error('Too many skipped messages on old chain');
                }
                let oldSkips = this.state.oldSkippedMessageKeys.get(oldSenderPubHex)?.skips || new Map<number, Uint8Array>();
                let tempRecvChainKey = this.state.recvChainKey!;
                for (let i = 0; i < numSkips; i++) {
                    const [skippedKey, newChainKey] = await this.symmetricRatchet(tempRecvChainKey);
                    oldSkips.set(this.state.recvCount + 1 + i, skippedKey);
                    tempRecvChainKey = newChainKey;
                }
                this.state.oldSkippedMessageKeys.set(oldSenderPubHex, { skips: oldSkips, created: Date.now() });

                // Clear current skipped
                this.state.currentSkippedKeys.clear();

                // Perform DH ratchet
                await this.dhRatchet(senderPubKey as CryptoKey, isClient);

                // Update state sender pub
                if (isClient) {
                    this.state.serverDhPub = senderPubKey as CryptoKey;
                } else {
                    this.state.clientDhPub = senderPubKey as CryptoKey;
                }

                // Update keyStore
                keyStore.storeRemotePublicKeys(header.senderId, senderPubKey as CryptoKey, keyStore.getAuthKeyPair(header.senderId)!.publicKey);

                // Now derive message key for new chain
                if (header.messageNumber > this.state.recvCount) {
                    const numSkipsNew = header.messageNumber - this.state.recvCount - 1;
                    if (numSkipsNew > this.maxSkip) {
                        throw new Error('Too many skipped messages');
                    }
                    for (let i = 0; i < numSkipsNew; i++) {
                        const [skippedKey, newChainKey] = await this.symmetricRatchet(this.state.recvChainKey!);
                        this.state.currentSkippedKeys.set(this.state.recvCount + 1 + i, skippedKey);
                        this.state.recvChainKey = newChainKey;
                    }
                }

                if (this.state.currentSkippedKeys.has(header.messageNumber)) {
                    messageKey = this.state.currentSkippedKeys.get(header.messageNumber)!;
                    this.state.currentSkippedKeys.delete(header.messageNumber);
                } else {
                    const [msgKey, newChainKey] = await this.symmetricRatchet(this.state.recvChainKey!);
                    messageKey = msgKey;
                    this.state.recvChainKey = newChainKey;
                }

                this.state.recvCount = Math.max(this.state.recvCount, header.messageNumber);
            } else {
                // Old chain
                const oldData = this.state.oldSkippedMessageKeys.get(senderPubHex);
                if (oldData && oldData.skips.has(header.messageNumber)) {
                    messageKey = oldData.skips.get(header.messageNumber)!;
                    oldData.skips.delete(header.messageNumber);
                    if (oldData.skips.size === 0) {
                        this.state.oldSkippedMessageKeys.delete(senderPubHex);
                    }
                    appLogger.debug(`Using old skipped key for messageNumber=${header.messageNumber} on old chain`);
                } else {
                    throw new Error('No key for message on old chain');
                }
            }
        }

        try {
            const decrypted = await decryptAesGcm(messageKey, nonceBuffer, ciphertextBuffer);
            appLogger.debug(`Decrypted successfully: sessionId=${header.sessionId}, messageNumber=${header.messageNumber}`);
            return new TextDecoder().decode(decrypted);
        } catch (error) {
            appLogger.error(`Decryption failed: ${error instanceof Error ? error.message : 'unknown error'}`);
            throw new Error(`Decryption failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        }
    }

    public getState(): RatchetState {
        return { ...this.state };
    }

    public setState(state: RatchetState): void {
        this.state = { ...state };
    }
}

export {
    RatchetState,
    CipherMessage,
    CipherMessageHeader,
    DoubleRatchet,
}