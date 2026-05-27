/**
 * Low-level crypto primitives — single canonical implementations of
 * AES-256-GCM, PBKDF2, HKDF, random-bytes, and the `getSubtle()` resolver.
 *
 * Higher-level helpers (ChunkCipher, PassphraseWrap, DoubleRatchet) compose
 * these primitives. New crypto features should reach for these before
 * importing `crypto.subtle` directly.
 */

export { getSubtle } from "./subtle";
export { randomBytes } from "./random";

export {
    encryptAesGcm,
    decryptAesGcm,
    AES_GCM_KEY_BYTES,
    AES_GCM_IV_BYTES,
    AES_GCM_TAG_BYTES,
} from "./aes-gcm";

export {
    deriveAesKeyFromPassphrase,
    deriveBitsHkdf,
    PBKDF2_DEFAULT_ITERATIONS,
} from "./kdf";
