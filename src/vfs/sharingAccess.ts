/**
 * The VFS steps behind `client.shares.shareFolder`, kept off the public API.
 *
 * Sharing a folder lets go of personal content references and replaces a folder with a link, steps that are only
 * safe in the order `shareFolder` runs them. So they are not methods an app can call on `client.vfs`: each
 * `VfsNamespace` registers them here under itself, `Client` links its `client.shares` to its `client.vfs`, and
 * `SharesNamespace` looks them up. This module is not exported from any entry point.
 */

import type { FileManifest } from "../storage/types";

/**
 * What `shareFolder` reads of a folder before it moves anything. Paths are relative to the folder, with no
 * leading slash.
 */
export interface SharingPlan {
    /** The folder, as a path in the user's own tree. */
    path: string;
    name: string;
    /** The folder's record id: the later steps refuse to act if the entry at `path` is no longer this folder. */
    dirId: string;
    /** The share an earlier, unfinished run was moving the folder into. */
    sharing: { spaceId: string } | null;
    /** Every file below the folder, by path. `fileId` is the VFS entry id (stable across renames). */
    files: Array<{ fileId: string; path: string; manifest: FileManifest; size: number }>;
    /** Every folder below it that holds nothing at all. */
    folders: Array<{ dirId: string; path: string }>;
    /** The bytes the share will be charged: each distinct manifest once. */
    bytes: number;
}

/**
 * What `shareFolder` has put in the share, for `finishSharing` to check against the folder as it is at the end:
 * each file id with the manifest id it was moved with, and the empty folders. The folder must hold exactly these.
 */
export interface SharingMoved {
    files: ReadonlyMap<string, string>;
    emptyDirs: ReadonlySet<string>;
}

/** What `finishSharing` did once the link was in place. */
export interface SharingFinished {
    /** Each file whose entry left the user's tree with a record that was removed: these are to be let go of. */
    detached: Array<{ fileId: string; manifest: FileManifest }>;
    /**
     * Records left in the store because, read again just before removing them, they held something that is not in
     * the share (another device wrote into them). Unreachable from the tree now, but nothing in them was let go of.
     */
    kept: string[];
}

/** The steps, as `VfsNamespace` registers them. */
export interface SharingAccess {
    sharingPlan(path: string): Promise<SharingPlan>;
    markSharing(path: string, dirId: string, spaceId: string): Promise<void>;
    /** `linkId` is the id the link entry is written with (an entry id: `[A-Za-z0-9_-]{1,64}`). */
    finishSharing(path: string, dirId: string, spaceId: string, moved: SharingMoved, linkId: string): Promise<SharingFinished>;
    /** Let go of the personal reference to a manifest's content. */
    releaseManifest(manifest: FileManifest): Promise<void>;
    /** The share a link at `path` stands for, and the link entry's id (a `VfsConflictError` / `VfsNotFoundError` otherwise). */
    readLink(path: string): Promise<{ spaceId: string; linkId: string }>;
}

const byVfs = new WeakMap<object, SharingAccess>();
const byShares = new WeakMap<object, object>();
const sharesOfVfs = new WeakMap<object, object>();
const droppedHandlers = new WeakMap<object, (spaceId: string) => void>();
const rotatedHandlers = new WeakMap<object, (from: string, to: string) => void>();

/** Called by a `VfsNamespace` for itself. */
export function registerSharing(vfs: object, access: SharingAccess): void {
    byVfs.set(vfs, access);
}

/** Let `shares` (a `SharesNamespace`) use `vfs`'s sharing steps. `Client` does this for its own pair. */
export function linkSharing(shares: object, vfs: object): void {
    byShares.set(shares, vfs);
    sharesOfVfs.set(vfs, shares);
}

/** Called by a `SharesNamespace` for itself: `fn` hears of a folder marked as going to a share being deleted. */
export function onSharingDropped(shares: object, fn: (spaceId: string) => void): void {
    droppedHandlers.set(shares, fn);
}

/** Called by a `VfsNamespace` when it deleted a folder marked as being moved into `spaceId`. Never throws. */
export function sharingDropped(vfs: object, spaceId: string): void {
    const shares = sharesOfVfs.get(vfs);
    const fn = shares && droppedHandlers.get(shares);
    try {
        fn?.(spaceId);
    } catch {
        /* best-effort */
    }
}

/** Called by a `VfsNamespace` for itself: `fn` hears of a share that moved from Space `from` to Space `to`. */
export function onShareRotated(vfs: object, fn: (from: string, to: string) => void): void {
    rotatedHandlers.set(vfs, fn);
}

/**
 * Called by a `SharesNamespace` when a rotation it ran finished: the share at `from` is closed and lives on at
 * `to`, so a VFS that kept `from` open (a link, `/Home/Shared`) must open it again. Never throws.
 */
export function shareRotated(shares: object, from: string, to: string): void {
    const vfs = byShares.get(shares);
    const fn = vfs && rotatedHandlers.get(vfs);
    try {
        fn?.(from, to);
    } catch {
        /* best-effort */
    }
}

/** The sharing steps of the VFS linked to `shares`, or null. */
export function sharingFor(shares: object): SharingAccess | null {
    const vfs = byShares.get(shares);
    return (vfs && byVfs.get(vfs)) ?? null;
}

/** The sharing steps a `VfsNamespace` registered (for tests). */
export function sharingOfVfs(vfs: object): SharingAccess | null {
    return byVfs.get(vfs) ?? null;
}
