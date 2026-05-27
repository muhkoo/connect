/**
 * AES-256-GCM encryption / decryption with raw key bytes.
 *
 * The two functions here are the single canonical AES-GCM call site in the
 * SDK. Earlier copies of this logic existed inline in `DoubleRatchet`, in the
 * storage `ChunkCipher`, and in the passphrase-wrap helpers — they all now
 * route through here so the algorithm, IV size, and tag handling stay in one
 * place.
 *
 * Conventions:
 *   - 256-bit keys only. Passing 16- or 24-byte keys throws; callers that
 *     need AES-128 should add a dedicated primitive.
 *   - 96-bit IVs. WebCrypto's recommended GCM IV length; trades the 4-byte
 *     IV economy of 128-bit for compatibility with every spec-compliant
 *     implementation.
 *   - The 16-byte GCM authentication tag is appended to the ciphertext by
 *     WebCrypto's default behavior. Callers don't manage it separately.
 *
 * If a future need arises for AAD (associated data), add an optional `aad`
 * parameter to both functions rather than introducing a parallel primitive.
 */

import { getSubtle } from "./subtle";

/** Length of the AES key in bytes. */
export const AES_GCM_KEY_BYTES = 32;

/** Length of the AES-GCM IV in bytes (WebCrypto-recommended). */
export const AES_GCM_IV_BYTES = 12;

/** Length of the AES-GCM authentication tag in bytes (appended to ciphertext). */
export const AES_GCM_TAG_BYTES = 16;

/**
 * Encrypt `plaintext` under a 32-byte AES-256 key with the supplied 12-byte
 * IV. Returns ciphertext with the 16-byte GCM tag appended (so the output
 * length is `plaintext.length + 16`).
 *
 * The IV must be unique per (key, message). Callers that generate the IV
 * randomly should grab it via `randomBytes(AES_GCM_IV_BYTES)`; callers
 * managing a counter pass their own.
 */
export async function encryptAesGcm(
    key: Uint8Array,
    iv: Uint8Array,
    plaintext: Uint8Array,
): Promise<Uint8Array> {
    assertKey(key);
    assertIv(iv);
    const cryptoKey = await importAesGcmKey(key, ["encrypt"]);
    const ciphertext = await getSubtle().encrypt(
        { name: "AES-GCM", iv: iv as BufferSource },
        cryptoKey,
        plaintext as BufferSource,
    );
    return new Uint8Array(ciphertext);
}

/**
 * Inverse of {@link encryptAesGcm}. Throws if the GCM auth tag fails — this
 * captures "wrong key", "wrong IV", or "ciphertext was tampered with",
 * indistinguishably. Callers that care about distinguishing those should
 * keep separate provenance bookkeeping, not invent a parallel MAC.
 */
export async function decryptAesGcm(
    key: Uint8Array,
    iv: Uint8Array,
    ciphertext: Uint8Array,
): Promise<Uint8Array> {
    assertKey(key);
    assertIv(iv);
    const cryptoKey = await importAesGcmKey(key, ["decrypt"]);
    const plaintext = await getSubtle().decrypt(
        { name: "AES-GCM", iv: iv as BufferSource },
        cryptoKey,
        ciphertext as BufferSource,
    );
    return new Uint8Array(plaintext);
}

async function importAesGcmKey(key: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
    return await getSubtle().importKey(
        "raw",
        key as BufferSource,
        { name: "AES-GCM" },
        false,
        usages,
    );
}

function assertKey(key: Uint8Array): void {
    if (key.byteLength !== AES_GCM_KEY_BYTES) {
        throw new Error(
            `aes-gcm: key must be ${AES_GCM_KEY_BYTES} bytes (got ${key.byteLength})`,
        );
    }
}

function assertIv(iv: Uint8Array): void {
    if (iv.byteLength !== AES_GCM_IV_BYTES) {
        throw new Error(
            `aes-gcm: iv must be ${AES_GCM_IV_BYTES} bytes (got ${iv.byteLength})`,
        );
    }
}
