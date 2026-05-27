import { AuthPublicInput, Field, Poseidon } from './ZeroKnowledge';
import { Authenticator, AuthToken } from './Authenticator';
import { DoubleRatchet } from './DoubleRatchet';
import { KeyStore } from './KeyStore';
import { CipherMessage, RatchetState } from './types.d';
import { toHex, fromBase64Url } from '../utilities';


class DoubleRatchetManager {
    private sessions: Map<string, DoubleRatchet> = new Map();
    private sessionStates: Map<string, RatchetState> = new Map(); // In-memory storage for session states
    private keyStore: KeyStore;
    private _authenticator: Authenticator;
    private registeredUsers: Map<string, { commitment: Field; salt: Field }> = new Map();
    private id: string; // Unique ID for this manager (e.g., client1, server1)

    constructor(id: string) {
        this.id = id;
        this.keyStore = KeyStore.getInstance();
        this._authenticator = new Authenticator();
    }

    get authenticator(): Authenticator {
        return this._authenticator;
    }

    public async addTrustedServer(serverId: string, publicKey: CryptoKey): Promise<void> {
        this._authenticator.addTrustedServer(serverId, publicKey);
    }

    public async registerZK(
        clientId: string,
        secret: Field,
        salt: Field,
        ecdsaPub: CryptoKey,
    ): Promise<void> {
        await this._authenticator.initializeZK();
        console.log(`Registering ZK for ${clientId}...`);
        console.log('ECDSA Public Key:', ecdsaPub);
        const ecdsaJwk = await crypto.subtle.exportKey('jwk', ecdsaPub);
        const ecdsaHex = toHex(fromBase64Url(ecdsaJwk.x!)).slice(0, 64);
        const ecdsaPubField = new Field(BigInt('0x' + ecdsaHex));
        const ecdsaPubHash = await Poseidon.hash([ecdsaPubField]);
        const commitment = await Poseidon.hash([secret, salt, ecdsaPubHash]);
        console.log(`Commitment for ${clientId}:`, { commitment, salt });
        this.registeredUsers.set(clientId, { commitment, salt });
        appLogger.debug(`Registered ${clientId}: commitment=${commitment.toString()}, salt=${salt.toString()}`);

    }

    public async performHandshake(
        senderId: string,
        recipientId: string,
        zkProof: any,
        publicInput: AuthPublicInput,
        clientPublicKey: CryptoKey, // ECDH pub for session
        clientAuthPublicKey: CryptoKey, // ECDSA pub for auth
        authToken: AuthToken // Client-generated token
    ): Promise<void> {
        await this._authenticator.initializeZK();

        const userData = this.registeredUsers.get(senderId);
        if (!userData) {
            throw new Error(`No registered commitment for ${senderId}`);
        }

        const isZKValid = await this._authenticator.verifyZKProof(
            zkProof,
            publicInput,
            userData.commitment,
            clientAuthPublicKey
        );
        if (!isZKValid) {
            throw new Error(`ZK handshake failed for ${senderId}`);
        }

        // Verify client-provided auth token
        if (!await this._authenticator.verifyAuthToken(authToken, clientAuthPublicKey)) {
            throw new Error(`Token verification failed for ${senderId}`);
        }

        // Store only public keys
        await this.keyStore.storeRemotePublicKeys(senderId, clientPublicKey, clientAuthPublicKey);
        const serverKeyPair = this.keyStore.getKeyPair(recipientId)!;
        const serverAuth = this.keyStore.getAuthKeyPair(recipientId)!;
        await this.keyStore.storeRemotePublicKeys(recipientId, serverKeyPair.publicKey, serverAuth.publicKey);
        appLogger.debug(`Handshake completed for ${senderId} -> ${recipientId}`);
    }

    public async initializeSession(
        senderId: string,
        recipientId: string,
        isClient: boolean = true,
        sessionType: 'global' | 'specific' = 'specific',
        sessionId?: string,
        zkProof?: any,
        publicInput?: AuthPublicInput,
        clientPublicKey?: CryptoKey,
        clientAuthPublicKey?: CryptoKey,
        clientEcdhPrivateKey?: CryptoKey,
        clientAuthPrivateKey?: CryptoKey
    ): Promise<string> {
        const keyStore = KeyStore.getInstance();
        const recipientKeyPair = keyStore.getKeyPair(recipientId);
        if (!recipientKeyPair?.publicKey && sessionType === 'specific' && isClient) {
            // Generate auth token from client auth private key if provided
            const authToken = clientAuthPrivateKey ?
                await this._authenticator.generateAuthToken(senderId, clientAuthPrivateKey) :
                await this._authenticator.generateAuthToken(senderId, this.keyStore.getAuthKeyPair(senderId)!.privateKey!);

            await this.performHandshake(
                senderId,
                recipientId,
                zkProof!,
                publicInput!,
                clientPublicKey!,
                clientAuthPublicKey!,
                authToken
            );
        } else if (!recipientKeyPair?.publicKey) {
            throw new Error(`Missing public key for ${recipientId}. Perform handshake or register first.`);
        }

        const finalSessionId = sessionId || (sessionType === 'specific'
            ? [senderId, recipientId].sort().join(':') + `:${Date.now()}`
            : `${senderId}:${recipientId}:${Date.now()}`);

        const ratchet = new DoubleRatchet(senderId, recipientId, sessionType, isClient);
        await ratchet.initializeSession(isClient);
        this.sessions.set(finalSessionId, ratchet);
        await this.saveState(finalSessionId, ratchet.getState());
        appLogger.debug(`Session initialized: ${finalSessionId}, type=${sessionType}`);
        return finalSessionId;
    }

    public async encrypt(
        senderId: string,
        recipientId: string,
        sessionId: string,
        plaintext: string,
        newDhKey: boolean = false,
        sessionType: 'global' | 'specific' = 'specific'
    ): Promise<CipherMessage> {
        let ratchet = this.sessions.get(sessionId);
        if (!ratchet) {
            const state = await this.loadState(sessionId);
            if (!state) throw new Error(`Session not found: ${sessionId}`);
            ratchet = new DoubleRatchet(senderId, recipientId, sessionType, false);
            ratchet.setState(state);
            this.sessions.set(sessionId, ratchet);
        }

        const message = await ratchet.encrypt(plaintext, newDhKey, senderId, recipientId, sessionId, sessionType);
        await this.saveState(sessionId, ratchet.getState());
        appLogger.debug('KeyStore after encrypt:', Array.from(this.keyStore.keys.entries()).map(([id]) => `${id}: publicKey`));
        return message;
    }

    public async decrypt(message: CipherMessage, isClient: boolean = true): Promise<string> {
        // const { sessionId, sessionType, senderId, recipientId } = message.header;
        const header = message.header;
        let ratchet = this.sessions.get(header.sessionId);
        if (!ratchet) {
            const state = await this.loadState(header.sessionId);
            if (!state) throw new Error(`Session not found: ${header.sessionId}`);
            ratchet = new DoubleRatchet(header.senderId, header.recipientId, header.sessionType, isClient);
            ratchet.setState(state);
            this.sessions.set(header.sessionId, ratchet);
        }

        const plaintext = await ratchet.decrypt(message, isClient);
        await this.saveState(header.sessionId, ratchet.getState());
        return plaintext;
    }

    public async getSessionSharedSecret(sessionId: string): Promise<Uint8Array | null> {
        let ratchet = this.sessions.get(sessionId);
        if (!ratchet) {
            const state = await this.loadState(sessionId);
            if (!state || !state.rootKey) {
                appLogger.debug(`No shared secret found for session: ${sessionId}`);
                return null;
            }
            return state.rootKey;
        }

        const state = ratchet.getState();
        if (!state.rootKey) {
            appLogger.debug(`Session ${sessionId} not initialized yet`);
            return null;
        }

        return state.rootKey;
    }

    private async saveState(sessionId: string, state: RatchetState): Promise<void> {
        appLogger.debug(`Saving state in memory: sessionId=${sessionId}`);
        // Store the state directly in memory
        // No need to serialize/deserialize as we're keeping it in memory
        this.sessionStates.set(`${this.id}-${sessionId}`, state);
    }

    private async loadState(sessionId: string): Promise<RatchetState | null> {
        appLogger.debug(`Loading state from memory: sessionId=${sessionId}`);
        // Retrieve the state directly from memory
        const state = this.sessionStates.get(`${this.id}-${sessionId}`);
        return state || null;
    }
}

export { DoubleRatchetManager, RatchetState, CipherMessage, AuthPublicInput };