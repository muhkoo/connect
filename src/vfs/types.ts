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
import { printable } from "./paths";

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
    /** See `DirEntry.moving`. */
    moving?: true;
}

export interface DirEntry {
    kind: "dir";
    /** Record id — `dirKey(id)` locates it. Permanent for the directory's life. */
    id: string;
    /** Base64 AES-256 key for that record. See the capability note above. */
    key: string;
    mtime: number;
    /**
     * Set on both copies while a move between two directories is under way.
     *
     * A move writes two records, attaching before it detaches, and one that
     * is interrupted leaves the same entry - the same directory record, or
     * the same file id, content and history - named in both. This is how a
     * delete of either copy knows to look for the other before letting go of
     * anything. Cleared by the move's last write, and from the one copy left
     * when a delete removes the other. Left in place, it costs a delete of
     * that entry one read of the tree, and a file keeps every version that
     * falls off its history.
     *
     * Not cleared when that last write is the one that fails: the move has
     * otherwise finished, only one copy is named anywhere, and nothing comes
     * back to unmark it. A retried move of the same entry carries the mark
     * over. That copy then keeps what falls off its history for good - a
     * storage cost, never a loss.
     */
    moving?: true;
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
    /**
     * Keys in the store that start with `prefix`, or every key without one.
     * The personal space is shared, so this is NOT VFS-only. An implementation
     * may ignore `prefix` and return more (the parameter is optional so that
     * a store written for the old no-argument `list()` still fits), so callers
     * filter what they get back.
     */
    list(prefix?: string): Promise<string[]>;
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

/**
 * Raised when a directory record cannot be read: it does not decrypt or parse
 * with the key its parent holds, or it does but is not a shape this SDK can
 * read - not an object, a version other than 1, `entries` missing or not a map.
 *
 * Thrown, never read as an empty directory. The next write into an "empty"
 * directory would seal an empty record over the real one, and a record this
 * version cannot read may simply be one a NEWER version wrote. Nor is the
 * directory skipped: a sync that cannot see a subtree reads its absence as a
 * deletion. The record is left exactly as stored; a recursive delete
 * (`delete(path, { recursive: true })`) detaches it when the user wants it
 * gone.
 */
export class VfsCorruptRecordError extends Error {
    /** The record's id - `dirKey(id)` is where it is stored. */
    readonly id: string;
    /** The path it was reached through, when known. A moved subtree can have two. */
    readonly path?: string;

    constructor(id: string, path: string | undefined, reason: string) {
        // The id comes out of a parent entry, which anything holding the seed
        // can write. It is kept raw on `.id` for code, and escaped here for the
        // terminal a CLI prints this to. `reason` is built by this SDK.
        const where = `${printable(path ?? "a directory")} (record ${printable(id, 40)})`;
        // The root has no parent to be detached from; advising a delete that
        // is refused would leave the user with nothing that works.
        const remedy = id === ROOT_ID
            ? "It is the root of this filesystem, so it cannot be deleted; nothing has been changed."
            : "It has been left as stored; remove it with a recursive delete.";
        super(`VFS: ${where} cannot be read: ${reason}. ${remedy}`);
        this.name = "VfsCorruptRecordError";
        this.id = id;
        this.path = path;
    }
}

/**
 * Raised when a walk or a copy would go past a size or depth ceiling, or a
 * write would put a directory deeper than a walk reads.
 *
 * Thrown rather than returning what was gathered so far, because every caller
 * of a walk treats a path that is missing from the result as a path that does
 * not exist - and a sync then plans a deletion for it. A tree this large or
 * deep is almost always one built to be expensive to read: directory records
 * can point at the same directory many times over, so a handful of tiny
 * records can describe more paths than there are atoms.
 */
export class VfsLimitError extends Error {
    /**
     * Which ceiling was hit: total entries, total characters of path text,
     * nesting depth, or - for a copy - how many places one directory may
     * appear. Entries alone do not bound memory - a name may be 255 bytes, so
     * one path can be ~16KB - which is why path text has its own.
     */
    readonly limit: "entries" | "pathChars" | "depth" | "shared";
    /** The ceiling itself. */
    readonly max: number;
    /** Where the operation started, or for a write what it was asked to write. */
    readonly path: string;
    /**
     * Where the ceiling was reached: the directory being listed, or for depth
     * the entry one level too deep. Walking the tree to find the culprit would
     * hit the same ceiling, so this is the only pointer the caller gets.
     */
    readonly at: string;

    constructor(limit: VfsLimitError["limit"], max: number, path: string, at: string, doing = "walking") {
        const what = {
            entries: `it holds more than ${max} entries`,
            pathChars: `its paths add up to more than ${max} characters`,
            depth: `it is nested more than ${max} directories deep`,
            shared: `one directory appears in it more than ${max} times`,
        }[limit];
        // The location is made of names that passed isSafeName, so it is safe
        // to print; it is shortened only because a deep one can run to 16KB.
        // Worded for whoever reads it - a CLI prints it as it is - rather than
        // in terms of the SDK call.
        const shown = at.length > 200 ? `${at.slice(0, 200)}...` : at;
        const remedy = doing === "writing"
            ? ""
            : " If you do not recognise what is there, remove it with a recursive delete.";
        super(`VFS: stopped ${doing} ${path}: ${what} (reached at ${shown}).${remedy}`);
        this.name = "VfsLimitError";
        this.limit = limit;
        this.max = max;
        this.path = path;
        this.at = at;
    }
}
