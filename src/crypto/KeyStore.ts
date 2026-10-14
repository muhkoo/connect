import { serialize, deserialize, toBase64, fromBase64, fromBase64Url, concatBytes, utf8Decode } from '../utilities';
interface KeyPair {
    privateKey: CryptoKey | null;
    publicKey: CryptoKey;
}

interface AuthKeyPair {
    privateKey: CryptoKey | null;
    publicKey: CryptoKey;
}

interface DehydratedKeys {
    ecdhPub: string; // ECDH public key in JWK format
    ecdhPriv: string; // ECDH private key in JWK format
    ecdsaPub: string; // ECDSA public key in JWK format
    ecdsaPriv: string; // ECDSA private key in JWK format
}

/** A member's own ECDH and ECDSA pairs, held outside the store until {@link KeyStore.replaceOwnKeyPair}. */
interface OwnKeyPair {
    ecdh: KeyPair;
    ecdsa: AuthKeyPair;
}

class KeyStore {
    private static instance: KeyStore;
    private _keys: Map<string, KeyPair> = new Map();
    private _authKeys: Map<string, AuthKeyPair> = new Map();
    /** The exact pairs marked vault-backed, so a pair written over them later is never taken for them. */
    private _vaultBacked: Map<string, OwnKeyPair> = new Map();

    private constructor() { }

    public static getInstance(): KeyStore {
        if (!KeyStore.instance) {
            KeyStore.instance = new KeyStore();
        }
        return KeyStore.instance;
    }

    get keys(): Map<string, KeyPair> {
        return this._keys;
    }

    get authKeys(): Map<string, AuthKeyPair> {
        return this._authKeys;
    }

    public async generateOwnKeyPair(id: string): Promise<KeyPair> {
        if (this._keys.has(id)) {
            throw new Error(`Key pair for ${id} already exists.`);
        }
        const ecdhKeyPair = await crypto.subtle.generateKey(
            { name: 'ECDH', namedCurve: 'P-384' },
            true,
            ['deriveKey', 'deriveBits']
        );
        this._keys.set(id, { privateKey: ecdhKeyPair.privateKey, publicKey: ecdhKeyPair.publicKey });

        const ecdsaKeyPair = await crypto.subtle.generateKey(
            { name: 'ECDSA', namedCurve: 'P-384' },
            true,
            ['sign', 'verify']
        );
        this._authKeys.set(id, { privateKey: ecdsaKeyPair.privateKey, publicKey: ecdsaKeyPair.publicKey });

        const dehydrated = await this.dehydrateKeyPair(id);
        appLogger.debug(`Generated key pair for ${id}: publicKey=${dehydrated.ecdhPub.slice(0, 16)}...`);
        return { privateKey: ecdhKeyPair.privateKey, publicKey: ecdhKeyPair.publicKey };
    }

    public async storeRemotePublicKeys(id: string, ecdhPublicKey: CryptoKey, ecdsaPublicKey: CryptoKey): Promise<void> {
        const existing = this._keys.get(id);
        if (!existing || !existing.privateKey) {
            this._keys.set(id, { privateKey: null, publicKey: ecdhPublicKey });
        }
        const existingAuth = this._authKeys.get(id);
        if (!existingAuth || !existingAuth.privateKey) {
            this._authKeys.set(id, { privateKey: null, publicKey: ecdsaPublicKey });
        }
        const dehydrated = await this.dehydrateKeyPair(id);
        appLogger.debug(`Stored remote public keys for ${id}: ecdhPub=${dehydrated.ecdhPub.slice(0, 16)}...`);
    }

    /** Generate an own pair without touching the store; {@link replaceOwnKeyPair} puts it in place. */
    public async generateKeyPair(): Promise<OwnKeyPair> {
        const ecdh = await crypto.subtle.generateKey(
            { name: 'ECDH', namedCurve: 'P-384' },
            true,
            ['deriveKey', 'deriveBits']
        );
        const ecdsa = await crypto.subtle.generateKey(
            { name: 'ECDSA', namedCurve: 'P-384' },
            true,
            ['sign', 'verify']
        );
        return {
            ecdh: { privateKey: ecdh.privateKey, publicKey: ecdh.publicKey },
            ecdsa: { privateKey: ecdsa.privateKey, publicKey: ecdsa.publicKey },
        };
    }

    public async hydrateKeyPair(id: string, dehydrated: DehydratedKeys): Promise<void> {
        const { ecdh, ecdsa } = await this.importKeyPair(dehydrated);
        const existing = this._keys.get(id);
        if (!existing || !existing.privateKey) {
            this._keys.set(id, ecdh);
        }
        const existingAuth = this._authKeys.get(id);
        if (!existingAuth || !existingAuth.privateKey) {
            this._authKeys.set(id, ecdsa);
        }
    }

    /** Import a dehydrated pair without touching the store; {@link replaceOwnKeyPair} puts it in place. */
    public async importKeyPair(dehydrated: DehydratedKeys): Promise<OwnKeyPair> {
        const ecdhPubJwk = JSON.parse(deserialize(dehydrated.ecdhPub));
        const ecdhPublicKey = await crypto.subtle.importKey(
            'jwk',
            ecdhPubJwk,
            { name: 'ECDH', namedCurve: 'P-384' },
            true,
            []
        );
        const ecdsaPubJwk = JSON.parse(deserialize(dehydrated.ecdsaPub));
        const ecdsaPublicKey = await crypto.subtle.importKey(
            'jwk',
            ecdsaPubJwk,
            { name: 'ECDSA', namedCurve: 'P-384' },
            true,
            ['verify']
        );
        let ecdhPrivateKey: CryptoKey | null = null;
        let ecdsaPrivateKey: CryptoKey | null = null;
        if (dehydrated.ecdhPriv) {
            const ecdhPrivJwk = JSON.parse(deserialize(dehydrated.ecdhPriv));
            ecdhPrivateKey = await crypto.subtle.importKey(
                'jwk',
                ecdhPrivJwk,
                { name: 'ECDH', namedCurve: 'P-384' },
                true,
                ['deriveKey', 'deriveBits']
            );
        }
        if (dehydrated.ecdsaPriv) {
            const ecdsaPrivJwk = JSON.parse(deserialize(dehydrated.ecdsaPriv));
            ecdsaPrivateKey = await crypto.subtle.importKey(
                'jwk',
                ecdsaPrivJwk,
                { name: 'ECDSA', namedCurve: 'P-384' },
                true,
                ['sign']
            );
        }
        return {
            ecdh: { privateKey: ecdhPrivateKey, publicKey: ecdhPublicKey },
            ecdsa: { privateKey: ecdsaPrivateKey, publicKey: ecdsaPublicKey },
        };
    }

    public getKeyPair(id: string): KeyPair | null {
        return this._keys.get(id) || null;
    }

    public getAuthKeyPair(id: string): AuthKeyPair | null {
        return this._authKeys.get(id) || null;
    }

    /** Record that the pair `id` holds now came from the seed-wrapped vault (ChatKeyVault). */
    public markVaultBacked(id: string): void {
        const ecdh = this._keys.get(id);
        const ecdsa = this._authKeys.get(id);
        if (ecdh && ecdsa) this._vaultBacked.set(id, { ecdh, ecdsa });
    }

    /**
     * Put `pair` in place as `id`'s own pair and mark it vault-backed, in one
     * synchronous step: whatever `id` held before is dropped, so a pair minted
     * while the vault pair was being fetched or generated is never kept and
     * marked in its place (design §3.3).
     */
    public replaceOwnKeyPair(id: string, pair: OwnKeyPair): void {
        this.forget(id);
        this._keys.set(id, pair.ecdh);
        this._authKeys.set(id, pair.ecdsa);
        this._vaultBacked.set(id, { ecdh: pair.ecdh, ecdsa: pair.ecdsa });
    }

    /**
     * Whether `id`'s own pair was loaded from, or persisted to, the vault in this
     * tab, and is still the very pair that was marked. A Space identity must be
     * vault-backed (design §3.3): any other pair, such as one minted by a locked
     * DM subscription, never takes part, even one that lands over the marked pair.
     */
    public isVaultBacked(id: string): boolean {
        const marked = this._vaultBacked.get(id);
        return !!marked && marked.ecdh.privateKey != null
            && this._keys.get(id) === marked.ecdh && this._authKeys.get(id) === marked.ecdsa;
    }

    /** Drop every key held for `id` (SpecA §6.4 `KeyStore.forget`). */
    public forget(id: string): void {
        this._keys.delete(id);
        this._authKeys.delete(id);
        this._vaultBacked.delete(id);
    }

    public async dehydrateKeyPair(id: string): Promise<DehydratedKeys> {
        const keyPair = this._keys.get(id);
        const authKeyPair = this._authKeys.get(id);
        if (!keyPair || !authKeyPair) {
            throw new Error(`No key pair for ${id}`);
        }
        return this.exportKeyPair({ ecdh: keyPair, ecdsa: authKeyPair });
    }

    /** Dehydrate a pair that is not (yet) in the store, in the same format as {@link dehydrateKeyPair}. */
    public async exportKeyPair(pair: OwnKeyPair): Promise<DehydratedKeys> {
        const keyPair = pair.ecdh;
        const authKeyPair = pair.ecdsa;
        const ecdhPubJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
        const ecdhPrivJwk = keyPair.privateKey ? await crypto.subtle.exportKey('jwk', keyPair.privateKey) : null;
        const ecdsaPubJwk = await crypto.subtle.exportKey('jwk', authKeyPair.publicKey);
        const ecdsaPrivJwk = authKeyPair.privateKey ? await crypto.subtle.exportKey('jwk', authKeyPair.privateKey) : null;
        const ecdhPubBase64 = JSON.stringify(ecdhPubJwk).replace(/=+$/, '');
        const ecdhPrivBase64 = ecdhPrivJwk ? JSON.stringify(ecdhPrivJwk).replace(/=+$/, '') : '';
        const ecdsaPubBase64 = JSON.stringify(ecdsaPubJwk).replace(/=+$/, '');
        const ecdsaPrivBase64 = ecdsaPrivJwk ? JSON.stringify(ecdsaPrivJwk).replace(/=+$/, '') : '';
        return {
            ecdhPub: serialize(ecdhPubBase64),
            ecdhPriv: ecdhPrivBase64 ? serialize(ecdhPrivBase64) : '',
            ecdsaPub: serialize(ecdsaPubBase64),
            ecdsaPriv: ecdsaPrivBase64 ? serialize(ecdsaPrivBase64) : '',
        };
    }

    public async getRawEcdsaPublicKey(id: string): Promise<Uint8Array | null> {
        const authKeyPair = this._authKeys.get(id);
        if (!authKeyPair) {
            return null;
        }
        const jwk = await crypto.subtle.exportKey('jwk', authKeyPair.publicKey);
        const x = fromBase64Url(jwk.x!);
        const y = fromBase64Url(jwk.y!);
        // SEC1 uncompressed point: 0x04 || x || y
        return concatBytes(new Uint8Array([0x04]), x, y);
    }

    public async packDehydratedKeys(id: string): Promise<string> {
        const dehydrated = await this.dehydrateKeyPair(id);
        const combined = JSON.stringify(dehydrated);
        return toBase64(new TextEncoder().encode(combined));
    }

    public async hydrateFromPacked(id: string, masterKey: string): Promise<void> {
        const decoded = utf8Decode(fromBase64(masterKey));
        const dehydrated: DehydratedKeys = JSON.parse(decoded);
        await this.hydrateKeyPair(id, dehydrated);
    }
}

export { KeyStore, KeyPair, AuthKeyPair, DehydratedKeys };