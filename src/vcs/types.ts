/**
 * Object model for version control over the VFS. See `docs/VCS_DESIGN.md`.
 *
 * Two spaces, deliberately: the WORKING TREE (`/apps/<slug>`) uses mutable
 * random directory ids so a file write touches one record; the REPOSITORY
 * (here) is content-addressed so a commit means the same thing forever. Git
 * makes the same split, for the same reason.
 */
import type { FileManifest } from "../storage/types";

/** A file in a commit. The manifest IS the content — there are no blob objects. */
export interface TreeFile {
    kind: "file";
    manifest: FileManifest;
    size: number;
}

/** A subdirectory, by the hash of its own tree object. */
export interface TreeDir {
    kind: "tree";
    hash: string;
}

export type TreeEntry = TreeFile | TreeDir;

/**
 * One directory, frozen.
 *
 * Addressed by the hash of its canonical form, so an unchanged directory has
 * the same hash in every commit containing it — a deep project costs one new
 * tree per CHANGED directory, not one per commit.
 */
export interface Tree {
    v: 1;
    entries: Record<string, TreeEntry>;
}

export interface Commit {
    v: 1;
    /** Hash of the root tree. */
    tree: string;
    /**
     * Ancestors. An ARRAY because a merge has two; the first commit has none.
     * Order matters: `parents[0]` is the branch being committed onto.
     */
    parents: string[];
    message: string;
    author: string;
    at: number;
}

/** Where a branch points, or a specific commit when detached. */
export type Head = { branch: string } | { detached: string };

/** A single change between two trees. */
export interface Change {
    path: string;
    kind: "added" | "removed" | "modified";
}

/** A path the merge could not settle on its own. */
export interface Conflict {
    path: string;
    /** `binary` cannot be merged at all — the user picks a side. */
    reason: "content" | "binary" | "modify-delete";
}

export interface MergeResult {
    /** "up-to-date" and "fast-forward" do no three-way work at all. */
    kind: "up-to-date" | "fast-forward" | "merged" | "conflicted";
    commit?: string;
    conflicts: Conflict[];
}

export interface LogEntry {
    hash: string;
    message: string;
    author: string;
    at: number;
    parents: string[];
}

/** Storage keys. Namespaced per project so repositories cannot collide. */
export const objectKey = (slug: string, hash: string): string => `vcs/${slug}/obj/${hash}`;
export const refKey = (slug: string, name: string): string => `vcs/${slug}/refs/${name}`;
export const headKey = (slug: string): string => `vcs/${slug}/HEAD`;
export const refsIndexKey = (slug: string): string => `vcs/${slug}/refs`;
/** An in-progress merge: what to make the second parent when it is committed. */
export const mergeKey = (slug: string): string => `vcs/${slug}/MERGE`;

export const DEFAULT_BRANCH = "main";

export class VcsError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "VcsError";
    }
}
