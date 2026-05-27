/**
 * Key-derivation primitives — PBKDF2 (for passphrase → key) and HKDF (for
 * symmetric key material → expanded key material).
 *
 * PBKDF2 is the slow, salted KDF the passphrase-wrap helper uses to harden
 * user passwords against offline guessing. HKDF is the fast, deterministic
 * KDF the Double Ratchet uses to derive root + chain + message keys from
 * shared secrets.
 *
 * Both are SHA-256-backed everywhere in this codebase — keep it that way
 * unless there's a concrete reason to diverge.
 */

import { getSubtle } from "./subtle";

/**
 * Iteration count default for PBKDF2 passphrase hardening. Tuned for
 * 2024–2026 hardware: slow enough to deter offline guessing of weak
 * passphrases (~100ms on commodity laptops), fast enough that interactive
 * unlock stays sub-second.
 */
export const PBKDF2_DEFAULT_ITERATIONS = 200_000;

/**
 * Derive a 256-bit AES-GCM key from `passphrase + salt` via PBKDF2-SHA256.
 *
 * Returned as raw bytes (not a `CryptoKey`) so callers can hand it straight
 * to {@link encryptAesGcm} — that's the convention everywhere else in the
 * primitive layer. If a future caller needs the non-extractable
 * `CryptoKey` form, add a parallel `deriveCryptoKeyFromPassphrase` variant
 * rather than overloading this one.
 */
export async function deriveAesKeyFromPassphrase(
    passphrase: string,
    salt: Uint8Array,
    iterations: number = PBKDF2_DEFAULT_ITERATIONS,
): Promise<Uint8Array> {
    if (typeof passphrase !== "string" || passphrase.length === 0) {
        throw new Error("kdf.deriveAesKeyFromPassphrase: passphrase must be a non-empty string");
    }
    const s = getSubtle();
    const passphraseKey = await s.importKey(
        "raw",
        new TextEncoder().encode(passphrase),
        { name: "PBKDF2" },
        false,
        ["deriveBits"],
    );
    const bits = await s.deriveBits(
        {
            name: "PBKDF2",
            salt: salt as BufferSource,
            iterations,
            hash: "SHA-256",
        },
        passphraseKey,
        256,
    );
    return new Uint8Array(bits);
}

/**
 * HKDF-Expand with SHA-256, returning `lengthBytes` raw bytes of key material.
 *
 * `info` is the per-purpose label (e.g. `"DoubleRatchetMsg"`). Optional
 * `salt` defaults to an empty buffer, matching the way the Double Ratchet
 * code has always used it.
 *
 * Note: this is intentionally a one-shot Extract-then-Expand call rather than
 * exposing Extract and Expand separately — every call site in this codebase
 * wants the same shape, and a richer API can be added later if needed.
 */
export async function deriveBitsHkdf(
    inputKeyMaterial: Uint8Array,
    info: string,
    lengthBytes: number,
    salt: Uint8Array = new Uint8Array(0),
): Promise<Uint8Array> {
    if (lengthBytes <= 0) {
        throw new Error(`kdf.deriveBitsHkdf: lengthBytes must be > 0 (got ${lengthBytes})`);
    }
    const s = getSubtle();
    const key = await s.importKey(
        "raw",
        inputKeyMaterial as BufferSource,
        { name: "HKDF" },
        false,
        ["deriveBits"],
    );
    const bits = await s.deriveBits(
        {
            name: "HKDF",
            hash: "SHA-256",
            salt: salt as BufferSource,
            info: new TextEncoder().encode(info) as BufferSource,
        },
        key,
        lengthBytes * 8,
    );
    return new Uint8Array(bits);
}
