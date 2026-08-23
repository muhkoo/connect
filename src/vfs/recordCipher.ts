/**
 * Sealing for VFS metadata records.
 *
 * Every directory and history record is AES-256-GCM encrypted before it leaves
 * the process, so the server holds ciphertext and never learns a filename, a
 * directory shape, or a file size. The manifests inside carry their own chunk
 * keys, which is why the metadata must be sealed too: a readable directory
 * record would hand over the keys to its files.
 */

import { encryptAesGcm, decryptAesGcm } from "../crypto/primitives/aes-gcm";
import { deriveBitsHkdf } from "../crypto/primitives/kdf";
import { randomBytes } from "../crypto/primitives/random";
import { VFS_ROOT_INFO, type SealedRecord } from "./types";

const AES_GCM_IV_BYTES = 12;
const AES_KEY_BYTES = 32;

export function toBase64(bytes: Uint8Array): string {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
}

/** A fresh random key for a newly created directory. */
export function newDirKey(): Uint8Array {
    return randomBytes(AES_KEY_BYTES);
}

/**
 * A fresh random id.
 *
 * Ids are opaque and never derived from names or contents — a predictable id
 * would leak the directory structure through the KV key, which is the one part
 * of a record the server does see.
 */
export function newId(): string {
    return toBase64(randomBytes(16)).replace(/[+/=]/g, "").slice(0, 22);
}

/** The root key, derived from the master seed. The only key not stored in a parent. */
export async function deriveRootKey(seed: Uint8Array): Promise<Uint8Array> {
    return deriveBitsHkdf(seed, VFS_ROOT_INFO, AES_KEY_BYTES);
}

export async function seal(key: Uint8Array, value: unknown): Promise<SealedRecord> {
    const iv = randomBytes(AES_GCM_IV_BYTES);
    const plaintext = new TextEncoder().encode(JSON.stringify(value));
    const ct = await encryptAesGcm(key, iv, plaintext);
    return { v: 1, iv: toBase64(iv), ct: toBase64(ct) };
}

/**
 * Open a sealed record. Returns null for anything that is not a well-formed
 * envelope, so a missing or corrupt record reads as "absent" rather than
 * throwing — the caller can then rebuild it. A WRONG KEY still throws, because
 * silently treating an undecryptable directory as empty would present the user
 * with an empty filesystem and then let a write overwrite the real one.
 */
export async function unseal<T>(key: Uint8Array, record: unknown): Promise<T | null> {
    if (!record || typeof record !== "object") return null;
    const r = record as Partial<SealedRecord>;
    if (typeof r.iv !== "string" || typeof r.ct !== "string") return null;
    const plaintext = await decryptAesGcm(key, fromBase64(r.iv), fromBase64(r.ct));
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}
