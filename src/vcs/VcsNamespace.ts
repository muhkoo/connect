/**
 * `client.vcs` — version control for a project in the VFS.
 *
 * Phase 1: objects, commit, log, checkout, diff. Branches and merge build on
 * this; see `docs/VCS_DESIGN.md` for the whole shape and for why the repository
 * is content-addressed while the working tree is not.
 */
import type { VfsNamespace } from "../vfs/VfsNamespace";
import type { VfsStore } from "../vfs/types";
import { seal, unseal } from "../vfs/recordCipher";
import { hashObject } from "./hash";
import {
    DEFAULT_BRANCH,
    VcsError,
    headKey,
    objectKey,
    refKey,
    refsIndexKey,
    type Change,
    type Commit,
    type Head,
    type LogEntry,
    type Tree,
    type TreeEntry,
} from "./types";

export interface VcsNamespaceDeps {
    vfs: VfsNamespace;
    store: VfsStore;
    /** The key repository objects are sealed with — the project's own. */
    key: () => Promise<Uint8Array>;
    /** Who to record as the author. */
    author: () => string;
}

/** A project's repository. One per `/apps/<slug>`. */
export class Repo {
    constructor(
        private readonly slug: string,
        private readonly deps: VcsNamespaceDeps,
    ) {}

    private get root(): string {
        return `/apps/${this.slug}`;
    }

    // ---- objects ------------------------------------------------------------

    /** Store an object, returning its hash and whether it was new. */
    private async put(value: unknown): Promise<{ hash: string; created: boolean }> {
        const hash = await hashObject(value);
        // Content-addressed, so re-writing an identical object is a no-op —
        // worth skipping because an unchanged directory is written on every
        // commit that touches any of its siblings.
        const existing = await this.deps.store.get(objectKey(this.slug, hash));
        if (existing) return { hash, created: false };
        await this.deps.store.put(objectKey(this.slug, hash), await seal(await this.deps.key(), value));
        return { hash, created: true };
    }

    private async get<T>(hash: string): Promise<T> {
        const raw = await this.deps.store.get(objectKey(this.slug, hash));
        const value = raw ? await unseal<T>(await this.deps.key(), raw) : null;
        if (!value) throw new VcsError(`object ${hash.slice(0, 8)} is missing from this repository`);
        return value;
    }

    // ---- refs ---------------------------------------------------------------

    private async head(): Promise<Head> {
        const raw = await this.deps.store.get(headKey(this.slug));
        const value = raw ? await unseal<Head>(await this.deps.key(), raw) : null;
        return value ?? { branch: DEFAULT_BRANCH };
    }

    private async setHead(head: Head): Promise<void> {
        await this.deps.store.put(headKey(this.slug), await seal(await this.deps.key(), head));
    }

    private async readRef(name: string): Promise<string | null> {
        const raw = await this.deps.store.get(refKey(this.slug, name));
        return raw ? await unseal<{ commit: string }>(await this.deps.key(), raw).then((v) => v?.commit ?? null) : null;
    }

    private async writeRef(name: string, commit: string): Promise<void> {
        await this.deps.store.put(refKey(this.slug, name), await seal(await this.deps.key(), { commit }));
        // The personal space has no prefix listing, so branches are tracked in
        // an index. Kept append-only-ish: losing a name here loses the branch.
        const names = new Set(await this.branches());
        names.add(name);
        await this.deps.store.put(
            refsIndexKey(this.slug),
            await seal(await this.deps.key(), { names: [...names].sort() }),
        );
    }

    /** Every branch name in this repository. */
    async branches(): Promise<string[]> {
        const raw = await this.deps.store.get(refsIndexKey(this.slug));
        const value = raw ? await unseal<{ names: string[] }>(await this.deps.key(), raw) : null;
        return value?.names ?? [];
    }

    /** The commit HEAD resolves to, or null in an empty repository. */
    async current(): Promise<string | null> {
        const head = await this.head();
        return "detached" in head ? head.detached : this.readRef(head.branch);
    }

    // ---- commit -------------------------------------------------------------

    /**
     * Freeze the working tree as a commit.
     *
     * Trees are written bottom-up so a directory's hash is known before its
     * parent references it. Nothing is written to the shard store: file entries
     * carry the manifest the VFS already holds.
     */
    async commit(message: string): Promise<string> {
        if (!message.trim()) throw new VcsError("a commit needs a message");
        const tree = await this.writeTree(this.root);
        const parent = await this.current();

        if (parent) {
            const previous = await this.get<Commit>(parent);
            // An empty commit is almost always a mistake — the user thinks they
            // saved something they did not.
            if (previous.tree === tree) throw new VcsError("nothing to commit — the project is unchanged");
        }

        const commit: Commit = {
            v: 1,
            tree,
            parents: parent ? [parent] : [],
            message: message.trim(),
            author: this.deps.author(),
            at: Date.now(),
        };
        const { hash } = await this.put(commit);

        const head = await this.head();
        if ("detached" in head) await this.setHead({ detached: hash });
        else await this.writeRef(head.branch, hash);
        return hash;
    }

    /** Write a directory and everything under it, returning the tree's hash. */
    private async writeTree(path: string): Promise<string> {
        const entries: Record<string, TreeEntry> = {};
        for (const entry of await this.deps.vfs.list(path)) {
            if (entry.kind === "dir") {
                entries[entry.name] = { kind: "tree", hash: await this.writeTree(entry.path) };
            } else {
                const stat = await this.deps.vfs.statManifest(entry.path);
                entries[entry.name] = { kind: "file", manifest: stat.manifest, size: entry.size };
            }
        }
        const { hash, created } = await this.put({ v: 1, entries } satisfies Tree);

        // A NEW tree means this directory's contents are newly recorded, so the
        // repository takes its own reference to their content. Without it, a
        // later working-tree delete frees shards the commit still needs and the
        // history becomes unreadable.
        //
        // Retaining per new tree rather than per changed FILE slightly
        // over-retains — an unchanged file in a directory whose sibling changed
        // gets a second reference. That errs towards keeping content, which is
        // the correct direction to err in.
        if (created) {
            for (const entry of Object.values(entries)) {
                if (entry.kind === "file") await this.deps.vfs.retainManifest(entry.manifest);
            }
        }
        return hash;
    }

    // ---- history ------------------------------------------------------------

    /** Commits reachable from HEAD, newest first. */
    async log(limit = 50): Promise<LogEntry[]> {
        const start = await this.current();
        if (!start) return [];

        const out: LogEntry[] = [];
        const seen = new Set<string>();
        // Breadth-first over parents so a merge's two sides both appear, and
        // `seen` keeps a diamond from listing the shared history twice.
        const queue = [start];
        while (queue.length && out.length < limit) {
            const hash = queue.shift()!;
            if (seen.has(hash)) continue;
            seen.add(hash);
            const commit = await this.get<Commit>(hash);
            out.push({
                hash,
                message: commit.message,
                author: commit.author,
                at: commit.at,
                parents: commit.parents,
            });
            queue.push(...commit.parents);
        }
        return out.sort((a, b) => b.at - a.at);
    }

    // ---- diff ---------------------------------------------------------------

    /**
     * What changed between two commits.
     *
     * Identical subtree hashes prune the walk: an untouched directory is one
     * comparison regardless of how much is inside it. That is the payoff for
     * content-addressing the trees.
     */
    async diff(fromHash: string | null, toHash: string): Promise<Change[]> {
        const from = fromHash ? (await this.get<Commit>(fromHash)).tree : null;
        const to = (await this.get<Commit>(toHash)).tree;
        const changes: Change[] = [];
        await this.diffTrees(from, to, "", changes);
        return changes.sort((a, b) => (a.path < b.path ? -1 : 1));
    }

    private async diffTrees(
        fromHash: string | null,
        toHash: string | null,
        prefix: string,
        out: Change[],
    ): Promise<void> {
        if (fromHash === toHash) return;   // identical subtrees: nothing below can differ
        const from = fromHash ? await this.get<Tree>(fromHash) : { v: 1 as const, entries: {} };
        const to = toHash ? await this.get<Tree>(toHash) : { v: 1 as const, entries: {} };

        for (const name of new Set([...Object.keys(from.entries), ...Object.keys(to.entries)])) {
            const a = from.entries[name];
            const b = to.entries[name];
            const path = `${prefix}/${name}`;

            if (a && b && a.kind === "tree" && b.kind === "tree") {
                await this.diffTrees(a.hash, b.hash, path, out);
            } else if (a?.kind === "tree" || b?.kind === "tree") {
                // A directory replaced by a file (or the reverse) — recurse both
                // sides so every affected path is reported, not just the name.
                await this.diffTrees(a?.kind === "tree" ? a.hash : null, b?.kind === "tree" ? b.hash : null, path, out);
                if (a?.kind === "file") out.push({ path, kind: "removed" });
                if (b?.kind === "file") out.push({ path, kind: "added" });
            } else if (!a && b) {
                out.push({ path, kind: "added" });
            } else if (a && !b) {
                out.push({ path, kind: "removed" });
            } else if (a?.kind === "file" && b?.kind === "file" && a.manifest.id !== b.manifest.id) {
                out.push({ path, kind: "modified" });
            }
        }
    }

    // ---- checkout -----------------------------------------------------------

    /**
     * Replace the working tree with a commit's.
     *
     * Moves no file content: entries carry manifests the shard store already
     * holds, so this rewrites directory records only.
     */
    async checkout(commitHash: string): Promise<void> {
        const commit = await this.get<Commit>(commitHash);
        const wanted = new Map<string, TreeEntry & { kind: "file" }>();
        await this.collect(commit.tree, this.root, wanted);

        // Remove what the commit does not have, before writing what it does —
        // otherwise a file replaced by a directory of the same name collides.
        for (const path of await this.deps.vfs.walk(this.root)) {
            // keepContent: history still references these manifests.
            if (!wanted.has(path)) await this.deps.vfs.delete(path, { keepContent: true }).catch(() => {});
        }
        for (const [path, entry] of wanted) {
            await this.deps.vfs.writeManifest(path, entry.manifest, entry.size);
        }
        await this.setHead({ detached: commitHash });
    }

    private async collect(
        treeHash: string,
        prefix: string,
        out: Map<string, TreeEntry & { kind: "file" }>,
    ): Promise<void> {
        const tree = await this.get<Tree>(treeHash);
        for (const [name, entry] of Object.entries(tree.entries)) {
            const path = `${prefix}/${name}`;
            if (entry.kind === "tree") await this.collect(entry.hash, path, out);
            else out.set(path, entry);
        }
    }
}
