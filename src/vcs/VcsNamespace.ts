/**
 * `client.vcs` — version control for a project in the VFS.
 *
 * Phase 1: objects, commit, log, checkout, diff. Branches and merge build on
 * this; see `docs/VCS_DESIGN.md` for the whole shape and for why the repository
 * is content-addressed while the working tree is not.
 */
import type { VfsNamespace } from "../vfs/VfsNamespace";
import type { VfsStore } from "../vfs/types";
import { deriveRepoKey, seal, unseal } from "../vfs/recordCipher";
import { hashObject } from "./hash";
import { merge3Text } from "./merge3";
import {
    DEFAULT_BRANCH,
    VcsError,
    headKey,
    mergeKey,
    objectKey,
    refKey,
    refsIndexKey,
    type Change,
    type Commit,
    type Conflict,
    type Head,
    type LogEntry,
    type MergeResult,
    type Tree,
    type TreeEntry,
    type TreeFile,
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
/**
 * Types never worth attempting a three-way merge on.
 *
 * NOT application/octet-stream: that is the UNKNOWN case, which is what every
 * extensionless text file gets labelled, so it must reach the content sniff
 * rather than being rejected on the label.
 */
const BINARY_TYPE = /^(image|audio|video|font)\/|^application\/(wasm|zip|pdf|x-tar|gzip)/;

/**
 * Does this look like text a person could resolve conflict markers in?
 *
 * A NUL byte is the classic tell and the one git uses — no textual encoding we
 * care about produces one. Invalid UTF-8 is the other: decoding it would
 * corrupt the file on write-back even if the merge itself succeeded.
 */
function looksTextual(bytes: Uint8Array): boolean {
    if (bytes.includes(0)) return false;
    try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return true;
    } catch {
        return false;
    }
}

/** Compare two path → entry maps into a change list. */
function comparePaths(before: Map<string, TreeFile>, after: Map<string, TreeFile>): Change[] {
    const changes: Change[] = [];
    for (const [path, entry] of after) {
        const was = before.get(path);
        if (!was) changes.push({ path, kind: "added" });
        else if (was.manifest.id !== entry.manifest.id) changes.push({ path, kind: "modified" });
    }
    for (const path of before.keys()) if (!after.has(path)) changes.push({ path, kind: "removed" });
    return changes.sort((a, b) => (a.path < b.path ? -1 : 1));
}

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
    async commit(message: string, parents?: string[]): Promise<string> {
        if (!message.trim()) throw new VcsError("a commit needs a message");
        const tree = await this.writeTree(this.root);
        const parent = await this.current();

        // Finish an interrupted merge: the recorded other side becomes the
        // second parent. Losing this would produce a single-parent commit, and
        // the merge would look as though it never happened — the branches would
        // still appear diverged.
        const pending = parents ? null : await this.pendingMerge();
        const resolved = parents ?? (pending ? [parent!, pending.theirs] : parent ? [parent] : []);

        if (!parents && !pending && parent) {
            const previous = await this.get<Commit>(parent);
            // An empty commit is almost always a mistake — the user believes
            // they saved something they did not.
            if (previous.tree === tree) throw new VcsError("nothing to commit — the project is unchanged");
        }

        const commit: Commit = {
            v: 1,
            tree,
            parents: resolved,
            message: message.trim(),
            author: this.deps.author(),
            at: Date.now(),
        };
        const { hash } = await this.put(commit);
        await this.advance(hash);
        if (pending) await this.deps.store.delete(mergeKey(this.slug)).catch(() => {});
        return hash;
    }

    /** Move whatever HEAD points at onto a new commit. */
    private async advance(hash: string): Promise<void> {
        const head = await this.head();
        if ("detached" in head) await this.setHead({ detached: hash });
        else await this.writeRef(head.branch, hash);
    }

    /** The other side of a merge that stopped for conflicts, if any. */
    async pendingMerge(): Promise<{ theirs: string; name: string } | null> {
        const raw = await this.deps.store.get(mergeKey(this.slug));
        return raw ? await unseal<{ theirs: string; name: string }>(await this.deps.key(), raw) : null;
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
    /**
     * What has changed since the last commit.
     *
     * Compares the WORKING TREE against HEAD without writing any objects: the
     * common case is answering "anything to commit?", and a `status` that
     * quietly stored a tree object every time would litter the repository with
     * trees for states nobody chose to keep.
     */
    async status(): Promise<Change[]> {
        const head = await this.current();
        const before = head ? await this.filesOf(head) : new Map<string, TreeFile>();
        const after = await this.workingFiles();
        return comparePaths(before, after);
    }

    /** The working tree as a path → entry map, mirroring `filesOf`. */
    private async workingFiles(): Promise<Map<string, TreeFile>> {
        const out = new Map<string, TreeFile>();
        for (const abs of await this.deps.vfs.walk(this.root)) {
            const stat = await this.deps.vfs.statManifest(abs);
            out.set(abs.slice(this.root.length), { kind: "file", manifest: stat.manifest, size: stat.size });
        }
        return out;
    }

    /**
     * Turn what a person typed into a commit hash.
     *
     * Accepts a branch name, `HEAD`, a full or abbreviated hash, and trailing
     * `^` / `~n` to walk back through parents — so `show abc123^` means "the
     * commit before that one" the way anyone who has used git expects.
     */
    async resolve(rev: string): Promise<string> {
        const m = /^(.*?)((?:\^|~\d+)*)$/.exec(rev.trim());
        if (!m) throw new VcsError(`cannot understand "${rev}"`);
        const [, base, steps] = m;

        let hash: string | null = null;
        if (!base || base === "HEAD") hash = await this.current();
        else if (await this.readRef(base)) hash = await this.readRef(base);
        else hash = await this.expand(base);
        if (!hash) throw new VcsError(`no commit matches "${rev}"`);

        for (const step of steps.match(/\^|~\d+/g) ?? []) {
            const back = step === "^" ? 1 : Number(step.slice(1));
            for (let i = 0; i < back; i++) {
                const parents: string[] = (await this.get<Commit>(hash!)).parents;
                if (!parents.length) throw new VcsError(`"${rev}" reaches past the first commit`);
                hash = parents[0];   // first parent: the branch you were on
            }
        }
        return hash!;
    }

    /** A hash prefix a person typed → the one commit it names. */
    private async expand(prefix: string): Promise<string | null> {
        if (!/^[0-9a-f]{4,}$/.test(prefix)) return null;
        const keys = await this.deps.store.list();
        const wanted = objectKey(this.slug, prefix);
        const hits = keys.filter((k) => k.startsWith(wanted));
        // Ambiguous is an error, not a coin toss — acting on the wrong commit
        // is exactly the kind of mistake version control exists to prevent.
        if (hits.length > 1) throw new VcsError(`"${prefix}" matches ${hits.length} objects — use more characters`);
        if (!hits.length) return null;
        const hash = hits[0].slice(objectKey(this.slug, "").length);
        // Objects include trees; only a commit is a valid revision.
        const object = await this.get<{ v: number; tree?: string }>(hash);
        return object && "tree" in object ? hash : null;
    }

    /**
     * Put one file back to the way it was in a commit.
     *
     * Scoped to a path on purpose — recovering one file you broke should not
     * mean rewinding everything else you have done since.
     */
    async restore(path: string, rev = "HEAD"): Promise<void> {
        const hash = await this.resolve(rev);
        const files = await this.filesOf(hash);
        const key = path.startsWith(this.root) ? path.slice(this.root.length) : path.startsWith("/") ? path : `/${path}`;
        const entry = files.get(key);
        if (!entry) throw new VcsError(`${key} is not in ${rev}`);
        await this.deps.vfs.writeManifest(this.abs(key), entry.manifest, entry.size);
    }

    async checkout(commitHash: string, opts: { discardChanges?: boolean } = {}): Promise<void> {
        await this.guardWorkingTree(opts.discardChanges);
        await this.materialise(commitHash);
        // DETACHED on purpose: committing from a historical state must not
        // silently rewrite whichever branch you happened to be on. `switchTo`
        // is how you re-attach.
        await this.setHead({ detached: commitHash });
    }

    /** Make the working tree match a commit, leaving HEAD alone. */
    private async materialise(commitHash: string): Promise<void> {
        const commit = await this.get<Commit>(commitHash);
        const wanted = new Map<string, TreeFile>();
        await this.collect(commit.tree, "", wanted);

        // Remove what the commit does not have BEFORE writing what it does —
        // otherwise a file replaced by a directory of the same name collides.
        for (const abs of await this.deps.vfs.walk(this.root)) {
            const path = abs.slice(this.root.length);
            // keepContent: history still references these manifests.
            if (!wanted.has(path)) await this.deps.vfs.delete(abs, { keepContent: true }).catch(() => {});
        }
        for (const [path, entry] of wanted) {
            await this.deps.vfs.writeManifest(this.abs(path), entry.manifest, entry.size);
        }
    }

    /** Project-relative path → absolute VFS path. */
    private abs(path: string): string {
        return `${this.root}${path}`;
    }

    private async collect(
        treeHash: string,
        prefix: string,
        out: Map<string, TreeFile>,
    ): Promise<void> {
        const tree = await this.get<Tree>(treeHash);
        for (const [name, entry] of Object.entries(tree.entries)) {
            const path = `${prefix}/${name}`;
            if (entry.kind === "tree") await this.collect(entry.hash, path, out);
            else out.set(path, entry);
        }
    }

    // ---- branches -----------------------------------------------------------

    /** Create a branch at a commit (HEAD by default). Does not switch to it. */
    async branch(name: string, at?: string): Promise<string> {
        if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(name)) throw new VcsError(`"${name}" is not a usable branch name`);
        if (await this.readRef(name)) throw new VcsError(`branch "${name}" already exists`);
        const commit = at ?? (await this.current());
        if (!commit) throw new VcsError("cannot branch an empty repository — commit something first");
        await this.writeRef(name, commit);
        return commit;
    }

    /**
     * Move onto a branch, bringing the working tree with it.
     *
     * Unlike {@link checkout}, this ATTACHES head: later commits advance the
     * branch. Checking out a bare commit deliberately does not, so that
     * committing from a historical state cannot silently rewrite a branch.
     */
    async switchTo(name: string, opts: { discardChanges?: boolean } = {}): Promise<void> {
        const commit = await this.readRef(name);
        if (!commit) throw new VcsError(`no branch named "${name}"`);
        await this.guardWorkingTree(opts.discardChanges);
        await this.materialise(commit);
        await this.setHead({ branch: name });
    }

    /**
     * Refuse to overwrite work that was never recorded.
     *
     * Moving between commits REPLACES the working tree, so uncommitted edits
     * are gone — and unlike an ordinary overwrite, the person did not ask for
     * anything to be written. Naming the files is the point: "you have changes"
     * with no list leaves them guessing what they are about to lose.
     */
    private async guardWorkingTree(discard?: boolean): Promise<void> {
        if (discard) return;
        const pending = await this.status();
        if (!pending.length) return;
        const names = pending.slice(0, 5).map((c) => c.path).join(", ");
        const more = pending.length > 5 ? `, and ${pending.length - 5} more` : "";
        throw new VcsError(
            `${pending.length} uncommitted change(s) would be lost: ${names}${more}. ` +
                "Commit them first, or pass { discardChanges: true } to throw them away.",
        );
    }

    /** The branch HEAD is on, or null when detached. */
    async currentBranch(): Promise<string | null> {
        const head = await this.head();
        return "detached" in head ? null : head.branch;
    }

    // ---- merge --------------------------------------------------------------

    /**
     * Merge another branch into the current one.
     *
     * Every part of this is client-side by necessity: the server holds
     * ciphertext and cannot compare versions, so base, ours and theirs are all
     * fetched and decrypted here.
     */
    async merge(name: string, opts: { discardChanges?: boolean } = {}): Promise<MergeResult> {
        const theirs = await this.readRef(name);
        if (!theirs) throw new VcsError(`no branch named "${name}"`);
        // A merge writes to the working tree as freely as a switch does.
        await this.guardWorkingTree(opts.discardChanges);
        const ours = await this.current();
        if (!ours) throw new VcsError("nothing to merge into — commit something first");
        if (ours === theirs) return { kind: "up-to-date", conflicts: [] };

        const base = await this.mergeBase(ours, theirs);
        if (base === theirs) return { kind: "up-to-date", conflicts: [] };
        if (base === ours) {
            // Fast-forward: our history is contained in theirs, so there is
            // nothing to combine — just move.
            await this.materialise(theirs);
            await this.advance(theirs);
            return { kind: "fast-forward", commit: theirs, conflicts: [] };
        }

        const [baseFiles, ourFiles, theirFiles] = await Promise.all([
            base ? this.filesOf(base) : new Map<string, TreeFile>(),
            this.filesOf(ours),
            this.filesOf(theirs),
        ]);

        const conflicts: Conflict[] = [];
        for (const path of new Set([...ourFiles.keys(), ...theirFiles.keys(), ...baseFiles.keys()])) {
            const b = baseFiles.get(path);
            const o = ourFiles.get(path);
            const t = theirFiles.get(path);
            const conflict = await this.settlePath(path, b, o, t);
            if (conflict) conflicts.push(conflict);
        }

        if (conflicts.length) {
            // Record what to merge with, so finishing is just: fix the files,
            // then commit. Losing this would silently produce a commit with one
            // parent, and the merge would appear never to have happened.
            await this.deps.store.put(mergeKey(this.slug), await seal(await this.deps.key(), { theirs, name }));
            return { kind: "conflicted", conflicts };
        }

        const commit = await this.commit(`Merge ${name}`, [ours, theirs]);
        return { kind: "merged", commit, conflicts: [] };
    }

    /** Decide one path. Returns a conflict when it cannot be settled. */
    private async settlePath(
        path: string,
        b: TreeFile | undefined,
        o: TreeFile | undefined,
        t: TreeFile | undefined,
    ): Promise<Conflict | null> {
        const id = (f?: TreeFile) => f?.manifest.id;
        if (id(o) === id(t)) return null;                       // already agree

        if (!o && !b && t) return this.take(path, t);            // only they added it
        if (!t && !b && o) return null;                          // only we added it
        if (id(o) === id(b)) {                                   // only they touched it
            if (!t) { await this.deps.vfs.delete(this.abs(path), { keepContent: true }).catch(() => {}); return null; }
            return this.take(path, t);
        }
        if (id(t) === id(b)) return null;                        // only we touched it

        // Both sides moved. A file one side deleted and the other edited is not
        // a merge decision a tool should make silently.
        if (!o || !t) return { path, reason: "modify-delete" };

        // Definitely-binary types are rejected WITHOUT reading them — merging
        // bytes line-by-line produces corruption, not a result, and these files
        // are exactly the large ones.
        if (BINARY_TYPE.test(o.manifest.type ?? "") || BINARY_TYPE.test(t.manifest.type ?? "")) {
            return { path, reason: "binary" };
        }

        const [baseBytes, ourBytes, theirBytes] = await Promise.all([
            b ? this.deps.vfs.readByManifest(b.manifest) : Promise.resolve(new Uint8Array()),
            this.deps.vfs.readByManifest(o.manifest),
            this.deps.vfs.readByManifest(t.manifest),
        ]);

        // Then judge by CONTENT, not by the declared type.
        //
        // The type is a hint we do not own: a content store may omit it, and
        // plenty of real text files carry no extension to derive one from
        // (Makefile, LICENSE, .gitignore, .env). Trusting it alone turned every
        // one of those into an unmergeable false conflict.
        if (![ourBytes, theirBytes, baseBytes].every(looksTextual)) return { path, reason: "binary" };

        const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
        const { text, conflicted } = merge3Text(decode(baseBytes), decode(ourBytes), decode(theirBytes));
        await this.deps.vfs.writeFile(this.abs(path), text);
        return conflicted ? { path, reason: "content" } : null;
    }

    private async take(path: string, entry: TreeFile): Promise<null> {
        await this.deps.vfs.writeManifest(this.abs(path), entry.manifest, entry.size);
        return null;
    }

    /**
     * The most recent commit reachable from both.
     *
     * Walks our ancestry into a set, then theirs breadth-first until it hits it —
     * so the first match is the nearest, which is what a three-way merge needs.
     */
    async mergeBase(a: string, b: string): Promise<string | null> {
        const ancestors = new Set<string>();
        const collect = async (start: string): Promise<void> => {
            const queue = [start];
            while (queue.length) {
                const hash = queue.shift()!;
                if (ancestors.has(hash)) continue;
                ancestors.add(hash);
                queue.push(...(await this.get<Commit>(hash)).parents);
            }
        };
        await collect(a);

        const queue = [b];
        const seen = new Set<string>();
        while (queue.length) {
            const hash = queue.shift()!;
            if (seen.has(hash)) continue;
            seen.add(hash);
            if (ancestors.has(hash)) return hash;
            queue.push(...(await this.get<Commit>(hash)).parents);
        }
        return null;
    }

    /** Every file in a commit, by path. */
    private async filesOf(commitHash: string): Promise<Map<string, TreeFile>> {
        const commit = await this.get<Commit>(commitHash);
        const out = new Map<string, TreeFile>();
        await this.collect(commit.tree, "", out);
        return out;
    }

}

/**
 * Version control over the VFS.
 *
 * One repository per project, addressed by slug — the same slug the VFS stores
 * that project's working tree under. `client.vcs.open("my-app")` is the whole
 * entry point.
 */
export class VcsNamespace {
    private readonly repos = new Map<string, Repo>();

    constructor(private readonly deps: VcsNamespaceOptions) {}

    /** The repository for one project. Cheap and cached; creates nothing. */
    open(slug: string): Repo {
        let repo = this.repos.get(slug);
        if (!repo) {
            repo = new Repo(slug, {
                vfs: this.deps.vfs,
                store: this.deps.store,
                key: async () => {
                    const seed = this.deps.seed();
                    if (!seed) throw new VcsError("client.vcs: no session — sign in first.");
                    return deriveRepoKey(seed, slug);
                },
                author: this.deps.author,
            });
            this.repos.set(slug, repo);
        }
        return repo;
    }
}

export interface VcsNamespaceOptions {
    vfs: VfsNamespace;
    store: VfsStore;
    /** The in-memory master seed, or null when locked. Read per call. */
    seed: () => Uint8Array | null;
    author: () => string;
}
