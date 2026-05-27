/**
 * Passphrase-based wrap / unwrap helpers using WebCrypto.
 *
 * Designed to be paired with {@link PersonalSpaceClient}: encrypt a payload
 * with a user-supplied passphrase before `put`-ing it into the per-user space,
 * then decrypt after `get`. The accelerator's PersonalSpaceDO never sees the
 * passphrase or plaintext — both wrap and unwrap run entirely client-side.
 *
 * Algorithm:
 *   - PBKDF2-SHA256 with 200_000 iterations derives a 256-bit AES key from
 *     `passphrase || salt`.
 *   - AES-256-GCM encrypts the plaintext with a fresh random 12-byte IV.
 *   - The auth tag is appended to the ciphertext by WebCrypto's default
 *     GCM behaviour, so {@link WrappedPayload.ciphertext} carries it implicitly.
 *
 * The returned {@link WrappedPayload} is JSON-friendly (all base64 fields), so
 * it can be `JSON.stringify`-ed straight into the DO's KV layer.
 */

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

/**
 * Iteration count for PBKDF2. 200k is a reasonable default for 2024-2026
 * browsers — slow enough to deter offline guessing of weak passphrases,
 * fast enough that it runs in well under a second even on mobile.
 */
const PBKDF2_ITERATIONS = 200_000;

/** Length of the PBKDF2 salt, in bytes. */
const SALT_BYTES = 16;

/** Length of the AES-GCM IV, in bytes. WebCrypto recommends 12 for GCM. */
const IV_BYTES = 12;

/** Length of the derived AES key, in bits. */
const KEY_BITS = 256;

/**
 * Resolve the WebCrypto subtle interface. Browsers expose it as
 * `crypto.subtle`; Node 16+ exposes it as `globalThis.crypto.subtle` too.
 * Throws a clear error if the runtime is too old.
 */
function subtle(): SubtleCrypto {
    const subtleCrypto = (globalThis.crypto as Crypto | undefined)?.subtle;
    if (!subtleCrypto) {
        throw new Error(
            "wrap.ts: `globalThis.crypto.subtle` is not available. " +
            "Modern browsers, Node 16+, and CF Workers provide it natively.",
        );
    }
    return subtleCrypto;
}

/** Generate `n` cryptographically random bytes backed by a plain ArrayBuffer. */
function randomBytes(n: number): Uint8Array {
    // Allocate against a non-shared ArrayBuffer so the result satisfies
    // WebCrypto's BufferSource type under strict TS lib settings (where
    // Uint8Array<ArrayBufferLike> isn't directly assignable to BufferSource).
    const buf = new Uint8Array(new ArrayBuffer(n));
    (globalThis.crypto as Crypto).getRandomValues(buf);
    return buf;
}

/** Encode a `Uint8Array` to standard base64 (with padding). */
function bytesToBase64(bytes: Uint8Array): string {
    // btoa is available in browsers and modern Node; build the binary string
    // chunk-wise to avoid blowing the stack on large payloads.
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    if (typeof btoa === "function") return btoa(binary);
    // Node fallback — Buffer is global there.
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
 * Derive a 256-bit AES-GCM key from the passphrase + salt using PBKDF2-SHA256.
 * Returns a `CryptoKey` usable for both encrypt and decrypt — kept in one
 * place so wrap and unwrap can't drift.
 */
async function deriveKey(
    passphrase: string,
    salt: Uint8Array,
    iterations: number,
): Promise<CryptoKey> {
    const s = subtle();
    const passphraseKey = await s.importKey(
        "raw",
        new TextEncoder().encode(passphrase),
        { name: "PBKDF2" },
        false,
        ["deriveKey"],
    );
    return await s.deriveKey(
        {
            name: "PBKDF2",
            // Cast to BufferSource — WebCrypto's lib.d.ts wants
            // ArrayBufferView<ArrayBuffer>, which Uint8Array<ArrayBufferLike>
            // isn't directly assignable to under strict TS settings.
            salt: salt as BufferSource,
            iterations,
            hash: "SHA-256",
        },
        passphraseKey,
        { name: "AES-GCM", length: KEY_BITS },
        false,
        ["encrypt", "decrypt"],
    );
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
    const iv = randomBytes(IV_BYTES);
    const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
    const ciphertext = new Uint8Array(
        await subtle().encrypt(
            { name: "AES-GCM", iv: iv as BufferSource },
            key,
            plaintext as BufferSource,
        ),
    );
    return {
        salt: bytesToBase64(salt),
        iv: bytesToBase64(iv),
        ciphertext: bytesToBase64(ciphertext),
        alg: "PBKDF2-SHA256/AES-256-GCM",
        iter: PBKDF2_ITERATIONS,
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
    const key = await deriveKey(passphrase, salt, wrapped.iter ?? PBKDF2_ITERATIONS);
    try {
        const plaintext = await subtle().decrypt(
            { name: "AES-GCM", iv: iv as BufferSource },
            key,
            ciphertext as BufferSource,
        );
        return new Uint8Array(plaintext);
    } catch {
        // WebCrypto throws a vague OperationError on GCM tag mismatch; turn it
        // into a stable, readable message so callers can react to it.
        throw new Error("unwrapWithPassphrase: decryption failed (wrong passphrase or tampered payload)");
    }
}
