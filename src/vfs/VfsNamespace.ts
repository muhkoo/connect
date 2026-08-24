/**
 * `client.vfs` — a real filesystem over Muhkoo primitives.
 *
 * Metadata is a graph of encrypted directory records in the user's personal
 * space; file content is chunked, encrypted and stored in the global
 * content-addressed shard store, referenced by manifest. See `types.ts` for
 * why directories carry stable random ids and why each key lives in its parent.
 *
 * ## Consistency
 *
 * Every mutation is a read-modify-write of exactly ONE directory record, so a
 * write cannot leave the tree half-updated: either the parent names the new
 * child or it does not. Two tabs writing different directories never conflict;
 * two tabs writing the SAME directory resolve last-writer-wins at the personal
 * space, which carries an HLC per key. Orphaned records (a directory whose
 * parent entry lost the race) are unreachable rather than corrupting — they
 * cost storage until a future sweep, which is the trade this shape makes in
 * exchange for single-record writes.
 */

import type { FileManifest } from "../storage/types";
import {
    dirKey,
    historyKey,
    ROOT_ID,
    VfsConflictError,
    VfsLockedError,
    VfsNotFoundError,
    type DirEntry,
    type DirNode,
    type Entry,
    type FileEntry,
    type HistoryRecord,
    type VfsStat,
    type VfsStore,
} from "./types";
import { deriveRootKey, fromBase64, newDirKey, newId, seal, toBase64, unseal } from "./recordCipher";
import {
    assertValidName, basename, contentTypeFor, dirname, isSafeName, isUnder, join, normalizePath, resolveFrom, segments,
} from "./paths";
import { globToRegExp } from "./glob";

/**
 * The slice of content storage the VFS needs.
 *
 * Narrow on purpose: the VFS knows how to name and arrange things, not how to
 * shard them. The adapter in `Client` resolves the content space and calls
 * `client.storage.writeFile` unchanged — the file still lands in a real Space
 * with a real gated manifest, and the VFS just keeps the handle somewhere
 * better than a flat mirror.
 */
export interface VfsContentStore {
    write(
        data: Uint8Array | Blob,
        meta: { name: string; type: string },
    ): Promise<{ manifest: FileManifest; size: number }>;
    read(manifest: FileManifest): Promise<Uint8Array>;
    /**
     * Drop a reference to a manifest's shards.
     *
     * Shards are content-addressed and reference-counted, so deleting a file is
     * not enough to reclaim the bytes — without this, every version ever
     * written stays on disk and billed forever. Best-effort: a failure here
     * leaks storage but must not block the delete.
     */
    release(manifest: FileManifest): Promise<void>;
    /**
     * Take an ADDITIONAL reference to shards that already exist.
     *
     * Needed when a manifest gains a second owner without new bytes being
     * written — copying a file. Without it the copy holds a handle to shards
     * with a refcount of one, and deleting the original frees the bytes out
     * from under it.
     */
    retain(manifest: FileManifest): Promise<void>;
}

export interface VfsNamespaceDeps {
    store: VfsStore;
    /**
     * Subscribe to the personal space's raw change feed, if the runtime has one.
     * Optional so the VFS works headlessly (a CLI, a test) with no socket.
     */
    subscribe?: (handler: (frame: unknown) => void) => () => void;
    content: VfsContentStore;
    /** The in-memory master seed, or null when locked. Read per call — it can change. */
    seed: () => Uint8Array | null;
    /** Versions retained per file. */
    historyLimit?: number;
}

/** A directory record plus the key it was opened with. */
interface OpenDir {
    id: string;
    key: Uint8Array;
    node: DirNode;
}

/**
 * How deep a tree may be before we stop walking it.
 *
 * Well past anything a real project needs, and low enough that a malformed or
 * hostile record cannot spend the caller's memory before the cycle guard sees a
 * repeat.
 */
const MAX_DEPTH = 64;

const DEFAULT_HISTORY_LIMIT = 20;

export class VfsNamespace {
    private rootKey: Uint8Array | null = null;
    /**
     * Decrypted directory records, by id.
     *
     * The file tree re-lists constantly while typing, and every miss is a
     * network round trip plus a decrypt. Invalidated precisely on write rather
     * than by TTL — a stale directory listing shows files that are not there.
     */
    private cache = new Map<string, Promise<OpenDir>>();
    private readonly historyLimit: number;

    constructor(private readonly deps: VfsNamespaceDeps) {
        this.historyLimit = deps.historyLimit ?? DEFAULT_HISTORY_LIMIT;
    }

    /**
     * The working directory relative paths resolve against.
     *
     * Kept here rather than left to each caller so that a CLI, a script and the
     * SDK all agree on what "here" means — the alternative is every consumer
     * re-implementing `cd`, and disagreeing about `..`.
     */
    private _cwd = "/";

    /** The current working directory. Always absolute. */
    get cwd(): string {
        return this._cwd;
    }

    /**
     * Change the working directory.
     *
     * Verifies the target is a real directory, so a typo fails here — where the
     * message can name the path — rather than turning every later relative path
     * into a confusing "does not exist".
     */
    async cd(path: string): Promise<string> {
        const target = this.resolve(path);
        if (target !== "/") {
            const found = await this.find(target);
            if (!found) throw new VfsNotFoundError(target);
            if (found.entry.kind !== "dir") throw new VfsConflictError(`${target} is not a directory`);
        }
        this._cwd = target;
        return target;
    }

    /** Resolve a path against the working directory. Absolute paths pass through. */
    resolve(path: string): string {
        return resolveFrom(this._cwd, path);
    }

    /** True when the master seed is held, so the root key can be derived. */
    get unlocked(): boolean {
        return this.deps.seed() !== null;
    }

    /**
     * Drop every cached record.
     *
     * Call after signing in as someone else — the cache is keyed by directory
     * id with no notion of whose filesystem it came from, and serving one
     * identity's directories to another would be the worst possible bug here.
     */
    clearCache(): void {
        this.cache.clear();
        this.rootKey = null;
        this._cwd = "/";   // a different identity's tree has different directories
    }

    /**
     * Call `handler` when this filesystem changes somewhere else — another tab,
     * another machine, the CLI.
     *
     * Deliberately a NOTIFICATION, not a diff: the frame names a record id, and
     * a record id is not a path (paths are resolved by walking, and the walk is
     * what the change may have invalidated). So the cache is dropped and the
     * caller re-reads whatever it is actually showing. Trying to translate a
     * record id back into a path would mean maintaining a reverse index that
     * could itself go stale.
     *
     * Returns an unsubscribe function. A runtime with no socket (a CLI) gets a
     * no-op rather than an error — watching is an optimisation, never required
     * for correctness.
     */
    watch(handler: () => void): () => void {
        if (!this.deps.subscribe) return () => {};
        return this.deps.subscribe((raw) => {
            let frame: { _t?: string; key?: string };
            try {
                frame = typeof raw === "string" ? JSON.parse(raw) : (raw as typeof frame);
            } catch {
                return;
            }
            if (frame?._t !== "change" || typeof frame.key !== "string") return;
            if (!frame.key.startsWith("vfs/")) return;   // someone else's data on the shared feed

            // Drop only the record that changed.
            //
            // Clearing everything looked cheap and is not: our own writes echo
            // back, so a sync that writes a few hundred files emptied the cache
            // a few hundred times, and every path resolution in flight went back
            // to the network for the root and every directory below it. The key
            // names the record, so there is no need to guess.
            const id = frame.key.startsWith("vfs/d/") ? frame.key.slice("vfs/d/".length) : null;
            if (id) this.cache.delete(id);
            else this.cache.clear();   // a shape we do not recognise: be safe
            handler();
        });
    }

    // ---- reads --------------------------------------------------------------

    async exists(path: string): Promise<boolean> {
        return (await this.find(path)) !== null;
    }

    async stat(path: string): Promise<VfsStat> {
        const found = await this.find(path);
        if (!found) throw new VfsNotFoundError(this.resolve(path));
        return toStat(this.resolve(path), found.name, found.entry);
    }

    /** Immediate children of a directory. One record fetch. */
    async list(path = "."): Promise<VfsStat[]> {
        const dir = await this.openDir(path);
        const base = this.resolve(path);
        return Object.entries(dir.node.entries)
            // Validate the name HERE, where it is read.
            //
            // A directory record is sealed under a key derivable from the master
            // seed, so its contents are not necessarily something this SDK
            // wrote, and the write-side check never sees them. An unusable name
            // is dropped rather than thrown on: one bad entry must not make the
            // whole directory unlistable, and callers walk this output straight
            // into filesystem paths.
            .filter(([name]) => {
                if (isSafeName(name)) return true;
                this.warn(`ignoring entry with an unusable name in ${base}`);
                return false;
            })
            .map(([name, entry]) => toStat(join(base, name), name, entry))
            .sort(byDirsThenName);
    }

    private warn(message: string): void {
        // Kept quiet by default in a browser console that the user cannot act
        // on, but never silent: a dropped entry is a real difference between
        // what is stored and what is shown.
        console.warn(`[muhkoo/vfs] ${message}`);
    }

    /**
     * Every file path under a prefix, depth-first.
     *
     * Deliberately separate from `list`: this walks the whole subtree, which is
     * one fetch per directory. Fine for a project, wrong as a default.
     */
    async walk(path = "."): Promise<string[]> {
        const out: string[] = [];
        // Guard against a tree that is not one.
        //
        // `visit` recurses on a PATH, re-resolved from the root each time, so a
        // record whose entry points back at an ancestor - or, before names were
        // validated, an entry simply named ".." - recurses forever and grows
        // `out` without bound. Nothing in the format prevents that, and `mount`
        // calls this on every sync pass.
        const seen = new Set<string>();
        const visit = async (dirPath: string, depth: number): Promise<void> => {
            if (depth > MAX_DEPTH) {
                this.warn(`stopping at ${dirPath}: deeper than ${MAX_DEPTH} levels`);
                return;
            }
            if (seen.has(dirPath)) {
                this.warn(`stopping at ${dirPath}: already visited (the tree contains a cycle)`);
                return;
            }
            seen.add(dirPath);
            for (const entry of await this.list(dirPath)) {
                if (entry.kind === "dir") await visit(entry.path, depth + 1);
                else out.push(entry.path);
            }
        };
        await visit(this.resolve(path), 0);
        return out;
    }

    async readFile(path: string): Promise<Uint8Array> {
        const entry = await this.expectFile(path);
        return this.deps.content.read(entry.manifest);
    }

    async readText(path: string): Promise<string> {
        return new TextDecoder().decode(await this.readFile(path));
    }

    /**
     * A file's manifest — the handle itself, without reading the bytes.
     *
     * Version control records manifests rather than content, so a commit costs
     * a hash and a reference, not a copy.
     */
    async statManifest(path: string): Promise<{ manifest: FileManifest; size: number }> {
        const entry = await this.expectFile(path);
        return { manifest: entry.manifest, size: entry.size };
    }

    /**
     * Read content by its manifest, wherever it came from.
     *
     * A merge needs the COMMON ANCESTOR's version of a file, which by definition
     * is not in the working tree any more. The manifest is the whole capability,
     * so no path lookup is involved.
     */
    async readByManifest(manifest: FileManifest): Promise<Uint8Array> {
        return this.deps.content.read(manifest);
    }

    /**
     * Pin content that something other than the working tree depends on.
     *
     * A commit references a manifest, so it is an OWNER of that content — without
     * a reference of its own, deleting the file from the working tree would free
     * shards the history still needs, and checking out an older commit would find
     * the content gone. (It did, in test.)
     */
    async retainManifest(manifest: FileManifest): Promise<void> {
        await this.deps.content.retain(manifest);
    }

    /**
     * Point a path at content that already exists.
     *
     * This is how a checkout restores a file: the bytes are in the shard store
     * already, so nothing is uploaded or downloaded — only the directory record
     * changes. Takes a reference, because a second path now depends on those
     * shards.
     */
    async writeManifest(path: string, manifest: FileManifest, size: number): Promise<VfsStat> {
        const target = this.resolve(path);
        const name = basename(target);
        assertValidName(name);
        await this.mkdir(dirname(target), { recursive: true });

        const parent = await this.openDir(dirname(target));
        const prior = parent.node.entries[name];
        if (prior?.kind === "dir") throw new VfsConflictError(`${target} is a directory`);

        await this.deps.content.retain(manifest);
        const entry: FileEntry = {
            kind: "file",
            id: prior?.id ?? newId(),
            manifest,
            size,
            mtime: Date.now(),
            versions: prior?.versions ?? 0,
        };
        await this.mutate(parent, (node) => {
            node.entries[name] = entry;
        });
        return toStat(target, name, entry);
    }

    // ---- writes -------------------------------------------------------------

    /**
     * Create a directory. `recursive` creates missing parents and tolerates an
     * existing target, matching `mkdir -p`.
     */
    async mkdir(path: string, opts: { recursive?: boolean } = {}): Promise<void> {
        const target = this.resolve(path);
        if (target === "/") return;
        const parts = segments(target);

        let current = "/";
        for (let i = 0; i < parts.length; i++) {
            const name = parts[i];
            const isLast = i === parts.length - 1;
            const next = join(current, name);
            const existing = (await this.openDir(current)).node.entries[name];

            if (existing) {
                if (existing.kind === "file") throw new VfsConflictError(`${next} is a file`);
                if (isLast && !opts.recursive) throw new VfsConflictError(`${next} already exists`);
            } else {
                if (!isLast && !opts.recursive) throw new VfsNotFoundError(current);
                await this.createDir(current, name);
            }
            current = next;
        }
    }

    /**
     * Write a file, creating parent directories as needed.
     *
     * The previous version is pushed onto the file's history record before the
     * directory entry is replaced, so an interrupted write can lose the new
     * version but never the old one.
     */
    async writeFile(
        path: string,
        data: Uint8Array | string | Blob,
        opts: { type?: string } = {},
    ): Promise<VfsStat> {
        const target = this.resolve(path);
        const name = basename(target);
        assertValidName(name);
        const parentPath = dirname(target);
        await this.mkdir(parentPath, { recursive: true });

        const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
        const { manifest, size } = await this.deps.content.write(bytes, {
            name,
            type: opts.type ?? contentTypeFor(name),
        });

        const parent = await this.openDir(parentPath);
        const prior = parent.node.entries[name];
        if (prior?.kind === "dir") throw new VfsConflictError(`${target} is a directory`);

        const id = prior?.id ?? newId();
        let versions = prior?.versions ?? 0;
        if (prior) versions = await this.pushHistory(parent, id, prior as FileEntry);

        const entry: FileEntry = { kind: "file", id, manifest, size, mtime: Date.now(), versions };
        await this.mutate(parent, (node) => {
            node.entries[name] = entry;
        });
        return toStat(target, name, entry);
    }

    /**
     * Delete a file, or a directory when `recursive`.
     *
     * `keepContent` removes the entry WITHOUT releasing its shards. A checkout
     * needs that: the file is leaving the working tree, but commits still
     * reference the same manifest, and releasing would free content history
     * depends on.
     */
    async delete(path: string, opts: { recursive?: boolean; keepContent?: boolean } = {}): Promise<void> {
        const target = this.resolve(path);
        if (target === "/") throw new VfsConflictError("the root directory cannot be deleted");
        const name = basename(target);
        const parent = await this.openDir(dirname(target));
        const entry = parent.node.entries[name];
        if (!entry) throw new VfsNotFoundError(target);

        if (entry.kind === "dir") {
            const child = await this.openDirById(entry.id, fromBase64(entry.key));
            const empty = Object.keys(child.node.entries).length === 0;
            if (!empty && !opts.recursive) throw new VfsConflictError(`${target} is not empty`);
            await this.purge(child);
        } else if (opts.keepContent) {
            await this.deps.store.delete(historyKey(entry.id)).catch(() => {});
        } else {
            await this.releaseFile(parent, entry);
        }

        await this.mutate(parent, (node) => {
            delete node.entries[name];
        });
    }

    /**
     * Move or rename. Works across directories, which is the same operation:
     * detach the entry from one parent and attach it to another.
     *
     * A directory move is O(1) regardless of how much is inside it — the
     * subtree records are not touched at all, because nothing in them records
     * its own path.
     */
    async rename(from: string, to: string): Promise<void> {
        const src = this.resolve(from);
        const dst = this.resolve(to);
        if (src === dst) return;
        if (src === "/") throw new VfsConflictError("the root directory cannot be moved");
        if (isUnder(dst, src)) throw new VfsConflictError(`cannot move ${src} into itself`);

        const dstName = basename(dst);
        assertValidName(dstName);

        const srcParent = await this.openDir(dirname(src));
        const entry = srcParent.node.entries[basename(src)];
        if (!entry) throw new VfsNotFoundError(src);

        await this.mkdir(dirname(dst), { recursive: true });
        const dstParent = await this.openDir(dirname(dst));
        if (dstParent.node.entries[dstName]) throw new VfsConflictError(`${dst} already exists`);

        // Attach before detaching. If the second write fails the entry is
        // reachable from both parents — visible and fixable. The other order
        // would lose the subtree entirely.
        const moved: Entry = { ...entry, mtime: Date.now() };
        await this.mutate(dstParent, (node) => {
            node.entries[dstName] = moved;
        });

        // Re-open: same-parent moves mutated the record we are about to edit.
        const detachFrom = await this.openDir(dirname(src));
        await this.mutate(detachFrom, (node) => {
            delete node.entries[basename(src)];
        });
    }

    /**
     * Copy a file or a directory tree.
     *
     * Copying a FILE moves no bytes: content is immutable and content-addressed,
     * so the new entry simply points at the same manifest. A 200 MB asset
     * duplicates in one small metadata write, and the shard store already holds
     * exactly one copy of it.
     *
     * The copy gets a NEW file id, so it does not inherit or share history —
     * two paths sharing an id would mean saving one silently pushed a version
     * onto the other.
     */
    async copy(from: string, to: string): Promise<VfsStat> {
        const src = this.resolve(from);
        const dst = this.resolve(to);
        if (src === "/") throw new VfsConflictError("the root directory cannot be copied");
        if (src === dst) throw new VfsConflictError(`${dst} already exists`);
        if (isUnder(dst, src)) throw new VfsConflictError(`cannot copy ${src} into itself`);

        const found = await this.find(src);
        if (!found) throw new VfsNotFoundError(src);

        const dstName = basename(dst);
        assertValidName(dstName);
        await this.mkdir(dirname(dst), { recursive: true });
        const dstParent = await this.openDir(dirname(dst));
        if (dstParent.node.entries[dstName]) throw new VfsConflictError(`${dst} already exists`);

        const copied = await this.cloneEntry(found.entry);
        await this.mutate(dstParent, (node) => {
            node.entries[dstName] = copied;
        });
        return toStat(dst, dstName, copied);
    }

    /**
     * Paths matching a glob, relative to the whole filesystem.
     *
     * Matching happens on the client over a walk of the tree, so the cost is one
     * record fetch per directory — cheap for a project, and worth knowing before
     * pointing it at the root of a large filesystem. Use `walk` when the prefix
     * already narrows it.
     */
    async glob(pattern: string, opts: { from?: string } = {}): Promise<string[]> {
        const re = globToRegExp(this.resolve(pattern));
        return (await this.walk(opts.from ?? ".")).filter((path) => re.test(path));
    }

    /**
     * Delete metadata records no longer reachable from the root.
     *
     * These accumulate because every write touches exactly one record: if two
     * tabs edit the same directory, last-writer-wins at the personal space can
     * leave a child whose parent entry lost the race. Unreachable is harmless —
     * it is invisible and undecryptable-by-nobody — but it costs storage, so
     * this reclaims it.
     *
     * Deliberately explicit, never automatic: a sweep racing another tab's
     * in-flight write could delete a record that is about to be referenced.
     * Run it when the filesystem is idle.
     */
    async sweep(opts: { force?: boolean } = {}): Promise<{ removed: string[] }> {
        const root = await this.root();
        const reachable = new Set<string>();
        const visit = async (dir: OpenDir): Promise<void> => {
            // `reachable` was already the visited set - it just was not being
            // TESTED before recursing, so a cycle looped forever. Here the
            // consequence would have been worse than a hang: sweep decides what
            // to delete, and it never got as far as deciding.
            if (reachable.has(dirKey(dir.id))) return;
            reachable.add(dirKey(dir.id));
            for (const entry of Object.values(dir.node.entries)) {
                if (entry.kind === "dir") {
                    await visit(await this.openDirById(entry.id, fromBase64(entry.key)));
                } else {
                    reachable.add(historyKey(entry.id));
                }
            }
        };
        await visit(root);

        // Only ever consider OUR records: the personal space is shared with
        // chat keys, space keys and the legacy file mirror, and a sweep that
        // reached beyond its own namespace would be a data-loss bug.
        const mine = (await this.deps.store.list()).filter((k) => /^vfs\/[dh]\//.test(k));
        const orphans = mine.filter((k) => !reachable.has(k));

        // A root that read as EMPTY while orphans exist is the shape of a failed
        // load, not of a fresh filesystem — deleting here would wipe a tree we
        // merely failed to reach. Refuse unless the caller insists.
        const rootEmpty = Object.keys(root.node.entries).length === 0;
        if (rootEmpty && orphans.length && !opts.force) {
            throw new VfsConflictError(
                `refusing to sweep ${orphans.length} record(s) with an empty root — ` +
                    "this looks like a failed load rather than an empty filesystem; pass { force: true } if it really is empty",
            );
        }

        for (const key of orphans) await this.deps.store.delete(key).catch(() => {});
        return { removed: orphans };
    }

    // ---- history ------------------------------------------------------------

    /** Prior versions of a file, newest first. One record fetch. */
    async history(path: string): Promise<Array<{ size: number; mtime: number }>> {
        const entry = await this.expectFile(path);
        const record = await this.readHistory(await this.openDir(dirname(path)), entry.id);
        return record.versions.map(({ size, mtime }) => ({ size, mtime }));
    }

    /**
     * Restore a prior version, where 0 is the most recent one.
     *
     * The current version is pushed onto history first, so restoring is itself
     * undoable rather than a one-way door.
     */
    async restore(path: string, index = 0): Promise<VfsStat> {
        const target = this.resolve(path);
        const name = basename(target);
        const parent = await this.openDir(dirname(target));
        const entry = parent.node.entries[name];
        if (!entry || entry.kind !== "file") throw new VfsNotFoundError(target);

        const record = await this.readHistory(parent, entry.id);
        const version = record.versions[index];
        if (!version) throw new VfsNotFoundError(`${target} version ${index}`);

        const versions = await this.pushHistory(parent, entry.id, entry);
        const restored: FileEntry = {
            kind: "file",
            id: entry.id,
            manifest: version.manifest,
            size: version.size,
            mtime: Date.now(),
            versions,
        };
        await this.mutate(parent, (node) => {
            node.entries[name] = restored;
        });
        return toStat(target, name, restored);
    }

    // ---- internals ----------------------------------------------------------

    private async expectFile(path: string): Promise<FileEntry> {
        const found = await this.find(path);
        if (!found) throw new VfsNotFoundError(this.resolve(path));
        if (found.entry.kind !== "file") throw new VfsConflictError(`${this.resolve(path)} is a directory`);
        return found.entry;
    }

    /** Resolve a path to its entry, or null. Root has no entry of its own. */
    private async find(path: string): Promise<{ name: string; entry: Entry } | null> {
        const target = this.resolve(path);
        if (target === "/") return null;
        const parent = await this.openDirOrNull(dirname(target));
        if (!parent) return null;
        const name = basename(target);
        const entry = parent.node.entries[name];
        return entry ? { name, entry } : null;
    }

    private async root(): Promise<OpenDir> {
        const seed = this.deps.seed();
        if (!seed) throw new VfsLockedError();
        if (!this.rootKey) this.rootKey = await deriveRootKey(seed);
        return this.openDirById(ROOT_ID, this.rootKey);
    }

    /** Open a directory by path, creating nothing. Throws if it is missing. */
    private async openDir(path: string): Promise<OpenDir> {
        const dir = await this.openDirOrNull(path);
        if (!dir) throw new VfsNotFoundError(this.resolve(path));
        return dir;
    }

    private async openDirOrNull(path: string): Promise<OpenDir | null> {
        let dir = await this.root();
        for (const name of segments(this.resolve(path))) {
            const entry: Entry | undefined = dir.node.entries[name];
            if (!entry || entry.kind !== "dir") return null;
            dir = await this.openDirById(entry.id, fromBase64(entry.key));
        }
        return dir;
    }

    private openDirById(id: string, key: Uint8Array): Promise<OpenDir> {
        const hit = this.cache.get(id);
        if (hit) return hit;

        // The PROMISE goes in the cache, not the resolved value.
        //
        // Reading a project means resolving hundreds of paths that share the
        // same handful of directories. Caching only the settled value leaves
        // every concurrent reader to miss and fire its own request for the same
        // record — which is how loading one project turned into thousands of
        // identical `vfs/d/<id>` fetches, most of them in flight at once.
        const pending = (async () => {
            const raw = await this.deps.store.get(dirKey(id));
            // An absent record is an EMPTY directory, not an error: the root
            // exists before anything has been written to it, and a directory is
            // created by its parent naming it rather than by its own record
            // appearing.
            const node = (await unseal<DirNode>(key, raw)) ?? { v: 1, entries: {}, mtime: Date.now() };
            return { id, key, node } satisfies OpenDir;
        })().catch((err) => {
            // A failed read must not be remembered, or one blip poisons the
            // directory for the life of the session.
            if (this.cache.get(id) === pending) this.cache.delete(id);
            throw err;
        });

        this.cache.set(id, pending);
        return pending;
    }

    /** Apply an edit to a directory record and persist it. */
    private async mutate(dir: OpenDir, edit: (node: DirNode) => void): Promise<void> {
        edit(dir.node);
        dir.node.mtime = Date.now();
        await this.deps.store.put(dirKey(dir.id), await seal(dir.key, dir.node));
        this.cache.set(dir.id, Promise.resolve(dir));
    }

    private async createDir(parentPath: string, name: string): Promise<void> {
        assertValidName(name);
        const parent = await this.openDir(parentPath);
        const entry: DirEntry = { kind: "dir", id: newId(), key: toBase64(newDirKey()), mtime: Date.now() };
        await this.mutate(parent, (node) => {
            node.entries[name] = entry;
        });
    }

    /** Recursively remove a subtree's records. Best-effort: unreachable ≠ fatal. */
    private async purge(dir: OpenDir, seen = new Set<string>()): Promise<void> {
        // A record that references an ancestor would otherwise recurse forever:
        // the id is only removed from the cache AFTER the loop, so re-entering
        // it hits the same cached record every time.
        if (seen.has(dir.id)) return;
        seen.add(dir.id);
        for (const entry of Object.values(dir.node.entries)) {
            if (entry.kind === "dir") {
                await this.purge(await this.openDirById(entry.id, fromBase64(entry.key)), seen);
            } else {
                await this.releaseFile(dir, entry);
            }
        }
        this.cache.delete(dir.id);
        await this.deps.store.delete(dirKey(dir.id)).catch(() => {});
    }

    /**
     * Deep-copy an entry. Files reuse their manifest (no bytes move); each
     * directory gets a fresh id and key, so the copy is independent of the
     * original — writing into one must never appear in the other.
     */
    private async cloneEntry(entry: Entry, seen = new Set<string>()): Promise<Entry> {
        if (entry.kind === "file") {
            // Same bytes, second owner: take a reference so deleting either one
            // leaves the other readable.
            await this.deps.content.retain(entry.manifest);
            return { kind: "file", id: newId(), manifest: entry.manifest, size: entry.size, mtime: Date.now(), versions: 0 };
        }
        // The most expensive walker to leave unguarded: it mints a NEW id, key
        // and stored record at every level, so a cyclic tree does not merely
        // hang - it writes records to the store, and to the user's bill, in an
        // unbounded loop.
        if (seen.has(entry.id) || seen.size > MAX_DEPTH) {
            throw new VfsConflictError("VFS: refusing to copy a directory that contains a cycle");
        }
        seen.add(entry.id);
        const source = await this.openDirById(entry.id, fromBase64(entry.key));
        const clone: DirEntry = { kind: "dir", id: newId(), key: toBase64(newDirKey()), mtime: Date.now() };
        const node: DirNode = { v: 1, entries: {}, mtime: Date.now() };
        for (const [name, child] of Object.entries(source.node.entries)) {
            // Names are validated on read everywhere else; a copy must not be
            // the way a bad one is carried into a fresh record.
            if (!isSafeName(name)) {
                this.warn(`skipping entry with an unusable name while copying`);
                continue;
            }
            node.entries[name] = await this.cloneEntry(child, seen);
        }
        const open: OpenDir = { id: clone.id, key: fromBase64(clone.key), node };
        await this.deps.store.put(dirKey(open.id), await seal(open.key, node));
        this.cache.set(open.id, Promise.resolve(open));
        return clone;
    }

    /**
     * Let go of a file's bytes: the current manifest and every retained
     * version, then the history record itself.
     */
    private async releaseFile(parent: OpenDir, entry: FileEntry): Promise<void> {
        const record = await this.readHistory(parent, entry.id).catch(() => ({ v: 1, versions: [] } as HistoryRecord));
        const manifests = [entry.manifest, ...record.versions.map((v) => v.manifest)];
        for (const manifest of manifests) await this.deps.content.release(manifest).catch(() => {});
        await this.deps.store.delete(historyKey(entry.id)).catch(() => {});
    }

    private async readHistory(parent: OpenDir, fileId: string): Promise<HistoryRecord> {
        const raw = await this.deps.store.get(historyKey(fileId));
        return (await unseal<HistoryRecord>(parent.key, raw)) ?? { v: 1, versions: [] };
    }

    /** Push `entry` onto its history record. Returns the new version count. */
    private async pushHistory(parent: OpenDir, fileId: string, entry: FileEntry): Promise<number> {
        const record = await this.readHistory(parent, fileId);
        record.versions.unshift({ manifest: entry.manifest, size: entry.size, mtime: entry.mtime });
        // Bounded, because this is a single stored value. Unchanged chunks are
        // deduped by the content-addressed shard store, so the cost of keeping
        // versions is this record's own growth — which is what the cap bounds.
        const evicted = record.versions.slice(this.historyLimit);
        record.versions = record.versions.slice(0, this.historyLimit);
        // A version that falls off the end is unreachable — release its shards
        // or the cap bounds the record's size while the storage grows forever.
        for (const v of evicted) await this.deps.content.release(v.manifest).catch(() => {});
        await this.deps.store.put(historyKey(fileId), await seal(parent.key, record));
        return record.versions.length;
    }
}

function toStat(path: string, name: string, entry: Entry): VfsStat {
    return {
        path,
        name,
        kind: entry.kind,
        size: entry.kind === "file" ? entry.size : 0,
        mtime: entry.mtime,
        versions: entry.kind === "file" ? (entry.versions ?? 0) : 0,
    };
}

/** Directories first, then alphabetical — what every file explorer does. */
function byDirsThenName(a: VfsStat, b: VfsStat): number {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
}
