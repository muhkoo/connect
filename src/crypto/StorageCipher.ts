/**
 * `StorageCipher` — transparent at-rest encryption for `client.storage`.
 *
 * Derives a single AES-256-GCM key from the user's ZK identity (HKDF over the
 * secret, salted with the identity salt) and uses it to seal/open the JSON
 * values the storage namespace persists. The accelerator only ever sees the
 * {@link EncryptedEnvelope} — opaque ciphertext + a per-value random IV.
 *
 * The key is deterministic in the identity, so the same `(username, password)`
 * decrypts the same data on any device — no key material is shipped or stored.
 */

import {
    deriveBitsHkdf,
    encryptAesGcm,
    decryptAesGcm,
    randomBytes,
    AES_GCM_IV_BYTES,
    AES_GCM_KEY_BYTES,
} from "./primitives";
import { fromHex, toBase64, fromBase64, utf8Encode, utf8Decode } from "../utilities/bytes";

/** The on-the-wire shape of an encrypted value. `_enc` tags the scheme. */
export interface EncryptedEnvelope {
    _enc: "a256gcm";
    /** Base64 random 12-byte GCM IV. */
    iv: string;
    /** Base64 ciphertext with the appended 16-byte GCM tag. */
    ct: string;
}

/** HKDF label binding the derived key to the storage-at-rest purpose. */
const STORAGE_KEY_INFO = "muhkoo-storage-v1";

export class StorageCipher {
    /** Lazily-derived AES key, memoized for the cipher's lifetime. */
    private readonly keyPromise: Promise<Uint8Array>;

    constructor(secretHex: string, saltHex: string) {
        this.keyPromise = deriveBitsHkdf(
            fromHex(secretHex),
            STORAGE_KEY_INFO,
            AES_GCM_KEY_BYTES,
            fromHex(saltHex),
        );
    }

    /** Seal a JSON-serializable value into an {@link EncryptedEnvelope}. */
    async encrypt(value: unknown): Promise<EncryptedEnvelope> {
        const key = await this.keyPromise;
        const iv = randomBytes(AES_GCM_IV_BYTES);
        const plaintext = utf8Encode(JSON.stringify(value));
        const ciphertext = await encryptAesGcm(key, iv, plaintext);
        return { _enc: "a256gcm", iv: toBase64(iv), ct: toBase64(ciphertext) };
    }

    /** Open an {@link EncryptedEnvelope} back into the original value. */
    async decrypt<T = unknown>(envelope: EncryptedEnvelope): Promise<T> {
        const key = await this.keyPromise;
        const iv = fromBase64(envelope.iv);
        const ciphertext = fromBase64(envelope.ct);
        const plaintext = await decryptAesGcm(key, iv, ciphertext);
        return JSON.parse(utf8Decode(plaintext)) as T;
    }

    /** Type guard — is `v` an encrypted envelope (vs. a plaintext value)? */
    static isEnvelope(v: unknown): v is EncryptedEnvelope {
        return (
            !!v &&
            typeof v === "object" &&
            (v as { _enc?: unknown })._enc === "a256gcm" &&
            typeof (v as { iv?: unknown }).iv === "string" &&
            typeof (v as { ct?: unknown }).ct === "string"
        );
    }
}

export default StorageCipher;
