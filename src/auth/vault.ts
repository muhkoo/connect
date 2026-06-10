/**
 * Identity vault primitives (M1.0).
 *
 * The vault decouples the identity from the password: a random 32-byte **master
 * seed** yields the (unchanged) ZK identity via {@link deriveIdentityFromSeed},
 * and that seed is AES-256-GCM-wrapped under one key *per factor* (password,
 * passkey, recovery phrase). Server stores only ciphertext.
 *
 * This module holds the PURE primitives (seed gen, the memory-hard password
 * pre-hash, AES-GCM wrap/unwrap, the OPRF -> wrap-key HKDF). The networked
 * orchestration (calling the server's OPRF endpoint, fetching/storing factor
 * records) lives in the AuthNamespace, which has transport access.
 *
 * Memory-hard KDF: we use **scrypt** (vetted, in `@noble/hashes`, runs in
 * browser + Workers + Node - no wasm dependency) instead of argon2id; it is the
 * pre-hash fed into the OPRF, so even if the OPRF key ever leaked, guesses still
 * pay the scrypt cost.
 */

import { scrypt } from "@noble/hashes/scrypt.js";

const TE = new TextEncoder();

// Interactive-login scrypt params (~100ms on a laptop). N must be a power of 2.
const SCRYPT = { N: 1 << 15, r: 8, p: 1, dkLen: 32 } as const;

/** 32 random bytes - the master seed for a brand-new identity. */
export function randomSeed(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/** Memory-hard pre-hash of the password - the OPRF input. Salted by username. */
export function passwordPreHash(username: string, password: string): Uint8Array {
  return scrypt(TE.encode(password), TE.encode("muhkoo-vault-v1:" + username.toLowerCase()), SCRYPT);
}

/** HKDF the 64-byte OPRF output into a non-extractable AES-256-GCM wrap key. */
export async function wrapKeyFromOprf(oprfOutput: Uint8Array): Promise<CryptoKey> {
  const prk = await crypto.subtle.importKey("raw", oprfOutput as BufferSource, { name: "HKDF" }, false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array() as BufferSource, info: TE.encode("muhkoo-vault-wrap") as BufferSource },
    prk,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** HKDF arbitrary 32-byte key material (e.g. a passkey PRF output) into an AES-GCM wrap key. */
export async function wrapKeyFromBytes(keyMaterial: Uint8Array, info: string): Promise<CryptoKey> {
  const prk = await crypto.subtle.importKey("raw", keyMaterial as BufferSource, { name: "HKDF" }, false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array() as BufferSource, info: TE.encode(info) as BufferSource },
    prk,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** A seed wrapped under a factor key - what the server stores (base64). */
export interface WrappedSeed {
  iv: string;
  ct: string;
}

export async function wrapSeed(seed: Uint8Array, key: CryptoKey): Promise<WrappedSeed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, seed as BufferSource);
  return { iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) };
}

/** Decrypt a wrapped seed. Throws (AES-GCM tag failure) on a wrong key. */
export async function unwrapSeed(wrapped: WrappedSeed, key: CryptoKey): Promise<Uint8Array> {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(wrapped.iv) as BufferSource },
    key,
    fromBase64(wrapped.ct) as BufferSource,
  );
  return new Uint8Array(pt);
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
