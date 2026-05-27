/**
 * Passphrase-based wrap / unwrap helpers using WebCrypto.
 *
 * Encrypt a payload with a user-supplied passphrase before persisting it
 * somewhere the server can see (e.g. the manifest blob in a ZK-gated
 * SharedSpace, or chat-key material in a PersonalSpace). The server never
 * sees the passphrase or the plaintext — both wrap and unwrap run entirely
 * client-side.
 *
 * Algorithm (the only one this codebase has ever shipped):
 *   - PBKDF2-SHA256 with 200_000 iterations derives a 256-bit AES key from
 *     `passphrase || salt`.
 *   - AES-256-GCM encrypts the plaintext with a fresh random 12-byte IV.
 *   - The auth tag is appended to the ciphertext by WebCrypto's default
 *     GCM behaviour, so {@link WrappedPayload.ciphertext} carries it implicitly.
 *
 * The returned {@link WrappedPayload} is JSON-friendly (all base64 fields), so
 * it can be `JSON.stringify`-ed straight into a KV layer.
 */

import {
    encryptAesGcm,
    decryptAesGcm,
    deriveAesKeyFromPassphrase,
    randomBytes,
    PBKDF2_DEFAULT_ITERATIONS,
    AES_GCM_IV_BYTES,
} from "./primitives";

/**
 * The persisted, JSON-friendly representation of a passphrase-wrapped blob.
 *
 * The `alg` field is a self-describing marker — if we ever rotate KDF/cipher,
 * unwrap can switch on this value to keep older payloads readable.
 */
export interface WrappedPayload {
    /** Random per-wrap salt for PBKDF2, base64. */
    salt: string;
    /** AES-GCM IV, base64. */
    iv: string;
    /** AES-GCM ciphertext (includes 16-byte GCM auth tag), base64. */
    ciphertext: string;
    /** Algorithm marker so future readers know what they're looking at. */
    alg: "PBKDF2-SHA256/AES-256-GCM";
    /** PBKDF2 iteration count used. */
    iter: number;
}

/** Length of the PBKDF2 salt, in bytes. */
const SALT_BYTES = 16;

/** Encode a `Uint8Array` to standard base64 (with padding). */
function bytesToBase64(bytes: Uint8Array): string {
    // Build chunk-wise to avoid blowing the call stack on large payloads.
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    if (typeof btoa === "function") return btoa(binary);
    return Buffer.from(bytes).toString("base64");
}

/** Decode a base64 string back into a `Uint8Array`. */
function base64ToBytes(b64: string): Uint8Array {
    if (typeof atob === "function") {
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }
    return new Uint8Array(Buffer.from(b64, "base64"));
}

/**
 * Encrypt `plaintext` under a key derived from `passphrase`. The returned
 * payload bundles the salt, IV, and ciphertext so unwrap only needs the
 * passphrase to reverse the operation.
 */
export async function wrapWithPassphrase(
    passphrase: string,
    plaintext: Uint8Array,
): Promise<WrappedPayload> {
    if (typeof passphrase !== "string" || passphrase.length === 0) {
        throw new Error("wrapWithPassphrase: passphrase must be a non-empty string");
    }
    const salt = randomBytes(SALT_BYTES);
    const iv = randomBytes(AES_GCM_IV_BYTES);
    const key = await deriveAesKeyFromPassphrase(passphrase, salt, PBKDF2_DEFAULT_ITERATIONS);
    const ciphertext = await encryptAesGcm(key, iv, plaintext);
    return {
        salt: bytesToBase64(salt),
        iv: bytesToBase64(iv),
        ciphertext: bytesToBase64(ciphertext),
        alg: "PBKDF2-SHA256/AES-256-GCM",
        iter: PBKDF2_DEFAULT_ITERATIONS,
    };
}

/**
 * Decrypt a {@link WrappedPayload} produced by {@link wrapWithPassphrase}.
 * Throws if the passphrase is wrong, the payload is tampered with, or the
 * algorithm marker is unrecognised.
 */
export async function unwrapWithPassphrase(
    passphrase: string,
    wrapped: WrappedPayload,
): Promise<Uint8Array> {
    if (typeof passphrase !== "string" || passphrase.length === 0) {
        throw new Error("unwrapWithPassphrase: passphrase must be a non-empty string");
    }
    if (wrapped.alg !== "PBKDF2-SHA256/AES-256-GCM") {
        throw new Error(`unwrapWithPassphrase: unsupported alg "${wrapped.alg}"`);
    }
    const salt = base64ToBytes(wrapped.salt);
    const iv = base64ToBytes(wrapped.iv);
    const ciphertext = base64ToBytes(wrapped.ciphertext);
    const key = await deriveAesKeyFromPassphrase(
        passphrase,
        salt,
        wrapped.iter ?? PBKDF2_DEFAULT_ITERATIONS,
    );
    try {
        return await decryptAesGcm(key, iv, ciphertext);
    } catch {
        // WebCrypto throws a vague OperationError on GCM tag mismatch; turn it
        // into a stable, readable message so callers can react to it.
        throw new Error(
            "unwrapWithPassphrase: decryption failed (wrong passphrase or tampered payload)",
        );
    }
}
