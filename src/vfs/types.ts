/**
 * Wire types for the VFS metadata layer.
 *
 * ## What is stored where
 *
 * The filesystem is a graph of **directory records**, one per directory, each
 * held under a personal-space KV key and encrypted client-side. A record lists
 * only its immediate children — so listing a directory is one fetch, and you
 * only ever pay for the subtrees you actually open.
 *
 * File CONTENT is not here. Bytes are written with `client.storage.writeFile`
 * exactly as any other file — into a real Space, with a real gated manifest —
 * and the entry keeps the returned `FileManifest` as its handle.
 * `client.storage.readByManifest(manifest)` then reconstructs the bytes from
 * the content-addressed shard store with no space membership or directory
 * lookup needed, which is what makes a file shareable by handing over the
 * handle alone.
 *
 * This supersedes the flat personal mirror `writeFile` already maintains
 * (`{spaceId, manifest}` keyed by manifest id): the same metadata, in the same
 * personal space, arranged as a tree you can actually navigate.
 *
 * ## Why directories have stable random ids, not content hashes
 *
 * A git-style tree keys each directory by the hash of its contents, so writing
 * one file rewrites every ancestor up to the root. Here a directory's id is
 * random and permanent, so a file write touches exactly ONE record — its
 * parent — and renaming or moving a directory edits only the parent entry
 * while the whole subtree underneath stays byte-identical and untouched.
 *
 * ## Why a directory's key lives in its parent
 *
 * Only the root key is derived from the master seed. Every other directory has
 * a random key stored in its parent's entry, which chains capabilities
 * downward: handing someone `{id, key}` for `/apps/my-app` lets them walk that
 * subtree and nothing else, because no key can be derived upward. That is the
 * seam group-sharing hangs off later without re-encrypting the filesystem.
 */

import type { FileManifest } from "../storage/types";

/** Personal-space KV key holding a directory record. */
export const dirKey = (id: string): string => `vfs/d/${id}`;
/** Personal-space KV key holding one file's prior versions. */
export const historyKey = (id: string): string => `vfs/h/${id}`;

/** The root directory's id is fixed — it is the one node reached without a parent. */
export const ROOT_ID = "root";
/** HKDF label for the seed-derived root key. Sits alongside `muhkoo-storage-v1`. */
export const VFS_ROOT_INFO = "muhkoo-vfs-v1";

export interface FileEntry {
    kind: "file";
    /**
     * Stable identity, independent of name and location. Renaming a file keeps
     * its id, so its version history follows it rather than being orphaned.
     */
    id: string;
    /** The handle: everything needed to read the current bytes back. */
    manifest: FileManifest;
    /** Plaintext byte length. */
    size: number;
    mtime: number;
    /**
     * Count of prior versions in the file's history record.
     *
     * Denormalised on purpose: the file tree wants to show "3 versions" while
     * listing a directory, and fetching every history record to answer that
     * would defeat the point of keeping history out of the directory record.
     */
    versions?: number;
}

export interface DirEntry {
    kind: "dir";
    /** Record id — `dirKey(id)` locates it. Permanent for the directory's life. */
    id: string;
    /** Base64 AES-256 key for that record. See the capability note above. */
    key: string;
    mtime: number;
}

export type Entry = FileEntry | DirEntry;

/** One directory record, as stored (before encryption). */
export interface DirNode {
    v: 1;
    /** Child name → entry. Names are unique within a directory, per filesystem. */
    entries: Record<string, Entry>;
    mtime: number;
}

/** A file's prior versions, newest first. Fetched only when asked for. */
export interface HistoryRecord {
    v: 1;
    versions: Array<{ manifest: FileManifest; size: number; mtime: number }>;
}

/** What `stat` and `list` hand back — a path-addressed view of an entry. */
export interface VfsStat {
    path: string;
    name: string;
    kind: "file" | "dir";
    size: number;
    mtime: number;
    versions: number;
}

/** The encrypted envelope every record is stored in. */
export interface SealedRecord {
    v: 1;
    /** Base64 12-byte AES-GCM IV. */
    iv: string;
    /** Base64 ciphertext with the 16-byte tag appended. */
    ct: string;
}

/** The personal-space blob store the VFS persists through. */
export interface VfsStore {
    get(key: string): Promise<unknown | null>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    /** Every key in the store — the personal space is shared, so this is NOT VFS-only. */
    list(): Promise<string[]>;
}

/** Raised when the master seed is not held, so the root key cannot be derived. */
export class VfsLockedError extends Error {
    constructor() {
        // Named rather than generic because the caller's remedy is specific and
        // not guessable from a failed decrypt: re-authenticate to recover the
        // seed. A page reload alone loses it — it is memory-only, never stored.
        super("VFS is locked: the master seed is not in memory. Sign in again to unlock.");
        this.name = "VfsLockedError";
    }
}

/** Raised for a path that does not exist. */
export class VfsNotFoundError extends Error {
    constructor(path: string) {
        super(`VFS: ${path} does not exist`);
        this.name = "VfsNotFoundError";
    }
}

/** Raised when an operation would clobber or misuse an existing entry. */
export class VfsConflictError extends Error {
    constructor(message: string) {
        super(`VFS: ${message}`);
        this.name = "VfsConflictError";
    }
}
