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
/** The GCM tag appended to every ciphertext, so the shortest one there can be. */
const AES_GCM_TAG_BYTES = 16;
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
/**
 * The key a project's repository objects are sealed with.
 *
 * Per project, not one key for everything: commits, trees and refs describe a
 * single project's history, and deriving per slug keeps that blast radius small
 * if a key is ever shared to collaborate on one project.
 */
export async function deriveRepoKey(seed: Uint8Array, slug: string): Promise<Uint8Array> {
    return deriveBitsHkdf(seed, `${VFS_ROOT_INFO}:vcs:${slug}`, AES_KEY_BYTES);
}

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

/** Raised by `openSealed` when the stored value itself is at fault. `message` says how. */
export class SealedRecordError extends Error {
    constructor(reason: string) {
        super(reason);
        this.name = "SealedRecordError";
    }
}

/**
 * `unseal` for a record that must not be guessed at.
 *
 * Throws SealedRecordError for everything that is wrong WITH THE STORED VALUE:
 * not an envelope, not base64, the wrong size, a ciphertext that does not
 * authenticate under `key`, plaintext that is not JSON. Every one of those
 * surfaced before as a bare DOMException or SyntaxError naming nothing.
 *
 * Anything else - no WebCrypto in this runtime, say - is rethrown untouched.
 * Blaming the record for a failure of the runtime would tell the user a
 * healthy directory is corrupt, and invite them to delete it.
 */
export async function openSealed(key: Uint8Array, record: unknown): Promise<unknown> {
    const r = record as Partial<SealedRecord> | null;
    if (!r || typeof r !== "object" || Array.isArray(r) || typeof r.iv !== "string" || typeof r.ct !== "string") {
        throw new SealedRecordError("it is not a sealed record");
    }
    let iv: Uint8Array;
    let ct: Uint8Array;
    try {
        iv = fromBase64(r.iv);
        ct = fromBase64(r.ct);
    } catch {
        throw new SealedRecordError("its envelope is not base64");
    }
    // Checked here rather than left to the cipher, whose complaints about
    // either are indistinguishable from its complaints about the runtime.
    if (iv.length !== AES_GCM_IV_BYTES || ct.length < AES_GCM_TAG_BYTES) {
        throw new SealedRecordError("its envelope is the wrong size");
    }
    let plaintext: Uint8Array;
    try {
        plaintext = await decryptAesGcm(key, iv, ct);
    } catch (err) {
        // What the WebCrypto spec requires for a tag that does not verify:
        // a different key, or bytes that were altered.
        if ((err as { name?: unknown })?.name !== "OperationError") throw err;
        throw new SealedRecordError("it does not decrypt with the key it should");
    }
    try {
        return JSON.parse(new TextDecoder().decode(plaintext));
    } catch {
        throw new SealedRecordError("it decrypts, but not to a record");
    }
}
