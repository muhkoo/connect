/**
 * `client.vcs` — version control for a project in the VFS.
 *
 * Phase 1: objects, commit, log, checkout, diff. Branches and merge build on
 * this; see `docs/VCS_DESIGN.md` for the whole shape and for why the repository
 * is content-addressed while the working tree is not.
 */
import type { VfsNamespace } from "../vfs/VfsNamespace";
import { DEFAULT_MAX_ENTRIES, DEFAULT_MAX_PATH_CHARS, MAX_DEPTH, MAX_TIME, nextTurn, YIELD_EVERY } from "../vfs/bounds";
import type { VfsStat, VfsStore } from "../vfs/types";
import type { FileManifest } from "../storage/types";
import { deriveRepoKey, openSealed, seal, SealedRecordError, unseal } from "../vfs/recordCipher";
import { dirname, isSafeName, printable, segments } from "../vfs/paths";
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
    /**
     * `entries` is the most tree entries one read of history may visit - one
     * `status`, `diff` or `checkout` - and `pathChars` the most characters of
     * path those entries may add up to. The defaults are far past any real
     * project; tests lower them so a hostile tree hits them in milliseconds.
     * `Client` does not pass these, so `client.vcs` always has the defaults.
     */
    limits?: { entries?: number; pathChars?: number };
}

/** What a hash looks like: SHA-256, lowercase hex. Anything else is not an address. */
const HASH = /^[0-9a-f]{64}$/;

/**
 * What a branch name looks like - checked when a branch is created, and on
 * every read of one. HEAD, the branch list and MERGE are not hashed, so
 * anything holding the seed can put any name in them, and the names are
 * printed by everything that shows a repository's state.
 *
 * At most 200 characters, because a name is also a store key -
 * `vcs/<slug>/refs/<name>` - and the personal space answers a key past 2048
 * bytes with a server error: a planted HEAD naming a longer branch turned
 * every status, log and commit into a bare HttpError.
 */
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/;

const isHash = (value: unknown): value is string => typeof value === "string" && HASH.test(value);
const isBranch = (value: unknown): value is string => typeof value === "string" && BRANCH.test(value);

/** A JSON object, as opposed to null, an array or a scalar. */
function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Why a value is not a commit this version can read, or null when it is.
 *
 * A commit can be written by anything holding the seed and still match its
 * hash, so matching proves nothing about its shape. Every reader takes these
 * fields for granted: parents are walked as an array of addresses, `at` is
 * sorted on, and message and author are handed to whatever prints them.
 */
function commitProblem(value: unknown): string | null {
    if (!isObject(value) || value.v !== 1) return "it is not a commit this version can read";
    if (!isHash(value.tree)) return "its tree is not an object hash";
    if (!Array.isArray(value.parents) || !value.parents.every(isHash)) {
        return "its parents are not a list of object hashes";
    }
    if (typeof value.message !== "string" || typeof value.author !== "string") return "its message or author is not text";
    // A time a Date can hold: `vcs log` prints it with toISOString, which
    // throws on 1e300, and commits cannot be changed.
    if (typeof value.at !== "number" || !(Math.abs(value.at) <= MAX_TIME)) return "its time is not a time";
    return null;
}

/**
 * Is this a tree entry the walkers can follow?
 *
 * Tree objects can be written by anything holding the seed, so a hash check
 * proves only that the object is what its address says - not that it is a
 * sensible tree. An unknown kind, a file with no manifest to read or compare,
 * or a subtree "hash" that is not a hash is skipped; a skipped entry is the same
 * outcome as someone deleting it.
 */
function readableTreeEntry(value: unknown): value is TreeEntry {
    if (!isObject(value)) return false;
    if (value.kind === "tree") return typeof value.hash === "string" && HASH.test(value.hash);
    return value.kind === "file" && isObject(value.manifest) && typeof value.manifest.id === "string";
}

/** One traversal's shared state: its budgets, and the trees it has already fetched. */
interface TreeWalk {
    tree(hash: string): Promise<Record<string, TreeEntry>>;
    /**
     * Charge for the paths `prefix/<name>` about to be built, before building
     * them. True when it is time to let the event loop run: once its trees are
     * fetched, a traversal waits on nothing, like a cached walk of the VFS.
     */
    spend(prefix: string, names: Iterable<string>): boolean;
    /** Refuse a directory `depth` levels below the project root that a checkout could not write. */
    descend(depth: number): void;
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

/** Changes in path order, as `status` and `diff` return them. */
const byPath = (a: Change, b: Change): number => (a.path < b.path ? -1 : 1);

export class Repo {
    private readonly maxEntries: number;
    private readonly maxPathChars: number;
    /**
     * How many directories deep below the project a tree may nest. The
     * working tree may be written MAX_DEPTH directories below the root, and
     * the project itself is some of those: a deeper tree would check out into
     * something no walk will read, and `status` - and every checkout after,
     * which walks the tree first - would throw from then on.
     */
    private readonly maxTreeDepth: number;

    constructor(
        private readonly slug: string,
        private readonly deps: VcsNamespaceDeps,
    ) {
        // Exactly one usable name. The working tree is `/apps/<slug>` and the
        // repository key is derived from the slug, so `demo/` was a second
        // repository over the same files - and, because commit() filed the
        // walk's output under normalised paths and looked it up under the raw
        // one, a repository whose commits were EMPTY trees. Checking one of
        // those out deleted the project. Rejected rather than normalised: the
        // SDK should not guess which project was meant.
        if (!isSafeName(slug)) throw new VcsError(`"${printable(slug, 64)}" is not a project name`);
        this.maxEntries = deps.limits?.entries ?? DEFAULT_MAX_ENTRIES;
        this.maxPathChars = deps.limits?.pathChars ?? DEFAULT_MAX_PATH_CHARS;
        this.maxTreeDepth = MAX_DEPTH - segments(this.root).length;
    }

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
        //
        // Skipped only when what is there really IS this object. The next
        // tree's hash is predictable to anyone who can read the project, so a
        // forgery can be planted at it in advance; trusting mere presence would
        // make that tree unwritable for good, every later commit of the same
        // content pointing at the forgery.
        const existing = await this.deps.store.get(objectKey(this.slug, hash));
        if (existing && (await this.holds(existing, hash))) return { hash, created: false };
        await this.deps.store.put(objectKey(this.slug, hash), await seal(await this.deps.key(), value));
        return { hash, created: true };
    }

    /** Does this stored record open to an object with this hash? */
    private async holds(raw: unknown, hash: string): Promise<boolean> {
        try {
            const value = await unseal<unknown>(await this.deps.key(), raw);
            return value !== null && (await hashObject(value)) === hash;
        } catch {
            return false;
        }
    }

    /**
     * Fetch an object, and prove it is the one that was asked for.
     *
     * Content addressing is only a guarantee if the address is checked. Without
     * this a stored object could claim any hash - including its own, so a tree
     * could contain itself and `status` would follow it for ever. Every object
     * this repository has ever written verifies: `put` hashes exactly the value
     * it seals, `canonical` is independent of key order and drops `undefined`
     * exactly as JSON does, and hashing has never been versioned.
     */
    private async get<T>(hash: string): Promise<T> {
        // Checked before it becomes a storage key: it may have come out of a
        // tree or commit that something else wrote.
        if (typeof hash !== "string" || !HASH.test(hash)) {
            throw new VcsError("a reference in this repository is not an object hash");
        }
        const short = hash.slice(0, 8);
        const raw = await this.deps.store.get(objectKey(this.slug, hash));
        if (raw === null || raw === undefined) throw new VcsError(`object ${short} is missing from this repository`);
        // Opened the way the working tree opens a directory record: a value
        // that is not an envelope, does not decrypt, or is not JSON is named,
        // rather than surfacing as a bare DOMException or SyntaxError.
        let value: unknown;
        try {
            value = await openSealed(await this.deps.key(), raw);
        } catch (err) {
            if (err instanceof SealedRecordError) throw new VcsError(`object ${short} cannot be read: ${err.message}`);
            throw err;
        }
        if (value === null) throw new VcsError(`object ${short} is missing from this repository`);
        let actual: string;
        try {
            actual = await hashObject(value);
        } catch (err) {
            // JSON.parse takes nesting that hashing's recursion cannot.
            if (err instanceof RangeError) throw new VcsError(`object ${short} cannot be read: it is nested too deeply`);
            throw err;
        }
        if (actual !== hash) {
            throw new VcsError(
                `object ${short} does not match its hash: this repository did not write it, or it is corrupt`,
            );
        }
        return value as T;
    }

    /** A commit, checked to be one. See `commitProblem`. */
    private async readCommit(hash: string): Promise<Commit> {
        const value = await this.get<unknown>(hash);
        const problem = commitProblem(value);
        if (problem) throw new VcsError(`object ${hash.slice(0, 8)} is not a commit this version can read: ${problem}`);
        return value as Commit;
    }

    /**
     * Start a traversal of history: a budget shared by every branch of it, and
     * a cache of the tree objects it has fetched.
     *
     * The cache matters for the same reason the budget does. Identical
     * subtrees are one object, so a tree of honest-but-hostile shape is a
     * handful of fetches and a vast number of paths; caching keeps it to the
     * handful, and the budget stops the paths. It caches OBJECTS, never output
     * - each name a shared subtree appears at is still listed.
     */
    private treeWalk(): TreeWalk {
        const fetched = new Map<string, Promise<Record<string, TreeEntry>>>();
        let budget = this.maxEntries;
        let chars = this.maxPathChars;
        const refuse = (what: string) =>
            new VcsError(
                `stopped reading history: ${what}, which no real project does - ` +
                    "the repository may have been tampered with",
            );
        return {
            tree: (hash) => {
                let hit = fetched.get(hash);
                if (!hit) fetched.set(hash, (hit = this.readTree(hash)));
                return hit;
            },
            spend: (prefix, names) => {
                const turn = Math.floor(budget / YIELD_EVERY);
                for (const name of names) {
                    budget -= 1;
                    chars -= prefix.length + 1 + name.length;
                }
                if (budget < 0) throw refuse(`it holds more than ${this.maxEntries} entries`);
                if (chars < 0) throw refuse(`its paths add up to more than ${this.maxPathChars} characters`);
                return Math.floor(budget / YIELD_EVERY) !== turn;
            },
            descend: (depth) => {
                if (depth > this.maxTreeDepth) throw refuse(`it is nested more than ${this.maxTreeDepth} directories deep`);
            },
        };
    }

    /**
     * A tree object's entries, checked and ready to walk.
     *
     * Returned in a null-prototype map, so a name like `constructor` is looked
     * up as an entry and not found as an inherited property.
     */
    private async readTree(hash: string): Promise<Record<string, TreeEntry>> {
        const tree = await this.get<unknown>(hash);
        if (!isObject(tree) || tree.v !== 1 || !isObject(tree.entries)) {
            throw new VcsError(`object ${hash.slice(0, 8)} is not a tree this version can read`);
        }
        const entries: Record<string, TreeEntry> = Object.create(null);
        let skipped = 0;
        for (const [name, entry] of Object.entries(tree.entries)) {
            // The same name rule the working tree uses. A name is about to
            // become a path - `../x` would be written outside the project on
            // checkout - and the hash check says nothing about whether it is safe.
            if (isSafeName(name) && readableTreeEntry(entry)) entries[name] = entry;
            else skipped++;
        }
        if (skipped) {
            const what = `${skipped} unreadable entr${skipped === 1 ? "y" : "ies"}`;
            console.warn(`[muhkoo/vcs] ignoring ${what} in tree ${hash.slice(0, 8)}`);
        }
        return entries;
    }

    // ---- refs ---------------------------------------------------------------

    /**
     * A record that is not an object - HEAD, a branch ref, the branch list,
     * MERGE - opened. Null when there is none; `problem` when there is one
     * that does not open. What is inside is the caller's to check.
     */
    private async openRecord(key: string): Promise<{ value: unknown } | { problem: string } | null> {
        const raw = await this.deps.store.get(key);
        if (raw === null || raw === undefined) return null;
        try {
            return { value: await openSealed(await this.deps.key(), raw) };
        } catch (err) {
            if (err instanceof SealedRecordError) return { problem: err.message };
            throw err;
        }
    }

    private async head(): Promise<Head> {
        const record = await this.openRecord(headKey(this.slug));
        if (!record) return { branch: DEFAULT_BRANCH };
        if ("value" in record) {
            const { value } = record;
            if (isObject(value) && !Object.hasOwn(value, "detached") && isBranch(value.branch)) {
                return { branch: value.branch };
            }
            if (isObject(value) && !Object.hasOwn(value, "branch") && isHash(value.detached)) {
                return { detached: value.detached };
            }
        }
        // Checking out a branch or a commit with discardChanges writes a new
        // HEAD without reading this one.
        throw new VcsError(
            `HEAD cannot be read${"problem" in record ? `: ${record.problem}` : ""}; ` +
                "check out a branch or a commit, discarding changes, to replace it",
        );
    }

    private async setHead(head: Head): Promise<void> {
        await this.deps.store.put(headKey(this.slug), await seal(await this.deps.key(), head));
    }

    private async readRef(name: string): Promise<string | null> {
        const ref = await this.refState(name);
        if (ref !== "unreadable") return ref;
        throw new VcsError(
            `branch "${printable(name, 64)}" cannot be read: it does not name a commit; ` +
                "create the branch again, at a commit, to replace it",
        );
    }

    /** A branch's commit, null when there is no such branch, or "unreadable". */
    private async refState(name: string): Promise<string | null | "unreadable"> {
        const record = await this.openRecord(refKey(this.slug, name));
        if (!record) return null;
        if ("value" in record && isObject(record.value) && isHash(record.value.commit)) return record.value.commit;
        return "unreadable";
    }

    private async writeRef(name: string, commit: string): Promise<void> {
        await this.deps.store.put(refKey(this.slug, name), await seal(await this.deps.key(), { commit }));
        // The personal space has no prefix listing, so branches are tracked in
        // an index. Kept append-only-ish: losing a name here loses the branch.
        // An index that cannot be read at all is replaced rather than left to
        // block every branch from now on; its names were lost already.
        const index = await this.readIndex();
        if (index === "unreadable") console.warn("[muhkoo/vcs] replacing a branch list this version cannot read");
        const names = new Set(index === "unreadable" ? [] : index);
        names.add(name);
        await this.deps.store.put(
            refsIndexKey(this.slug),
            await seal(await this.deps.key(), { names: [...names].sort() }),
        );
    }

    /** Every branch name in this repository. */
    async branches(): Promise<string[]> {
        const index = await this.readIndex();
        if (index === "unreadable") {
            throw new VcsError("the list of branches cannot be read; creating a branch replaces it");
        }
        return index;
    }

    /**
     * The branch list, less any name a branch could not have been created
     * with - left out with a warning, like an unreadable entry in a tree, so
     * one planted name does not hide every real one.
     */
    private async readIndex(): Promise<string[] | "unreadable"> {
        const record = await this.openRecord(refsIndexKey(this.slug));
        if (!record) return [];
        if (!("value" in record) || !isObject(record.value) || !Array.isArray(record.value.names)) return "unreadable";
        const names = record.value.names.filter(isBranch);
        const skipped = record.value.names.length - names.length;
        if (skipped) {
            console.warn(`[muhkoo/vcs] ignoring ${skipped} branch name${skipped === 1 ? "" : "s"} this version would not accept`);
        }
        return names;
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
            const previous = await this.readCommit(parent);
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
        const record = await this.openRecord(mergeKey(this.slug));
        if (!record) return null;
        if ("value" in record && isObject(record.value) && isHash(record.value.theirs) && isBranch(record.value.name)) {
            return { theirs: record.value.theirs, name: record.value.name };
        }
        throw new VcsError(
            `the merge in progress cannot be read${"problem" in record ? `: ${record.problem}` : ""}; ` +
                "abort the merge to clear it",
        );
    }

    /**
     * Give up on a merge that stopped for conflicts: the next commit is an
     * ordinary one, with one parent. The working tree is left as it is,
     * conflict markers and all. To put it back, switch to the current branch
     * with `discardChanges` — not `checkout`, which always leaves HEAD
     * detached, so later commits would stop moving the branch.
     *
     * Also the way out when the record of the merge cannot be read, which
     * would otherwise stop every commit.
     */
    async abortMerge(): Promise<void> {
        await this.deps.store.delete(mergeKey(this.slug));
    }

    /**
     * Write a directory and everything under it, returning the tree's hash.
     *
     * Reads the working tree through ONE `walkEntries`, rather than listing
     * each directory by path and recursing. The recursion had no guard at all:
     * a directory record that names itself - which anything holding the seed
     * can plant - sent `commit` down /loop/loop/loop/... for ever. The walk has
     * the cycle guard, the budget and the depth ceiling, so a commit records
     * exactly the tree `status` compares it against.
     */
    private async writeTree(path: string): Promise<string> {
        // Each file's manifest comes with the walk. Looking every file up
        // again by path, from the root down, cost a planted deep tree 30s of
        // CPU per commit on top of a walk of under a second.
        const byParent = new Map<string, Array<{ stat: VfsStat; manifest: FileManifest | null }>>();
        await this.deps.vfs.eachEntry(path, (stat, manifest) => {
            const parent = dirname(stat.path);
            let siblings = byParent.get(parent);
            if (!siblings) byParent.set(parent, (siblings = []));
            siblings.push({ stat, manifest });
        });

        const write = async (dir: string): Promise<string> => {
            // No prototype: a file named `__proto__` would otherwise set the
            // map's prototype instead of becoming an entry, and be left out of
            // the commit without a word.
            const entries: Record<string, TreeEntry> = Object.create(null);
            for (const { stat, manifest } of byParent.get(dir) ?? []) {
                if (!manifest) entries[stat.name] = { kind: "tree", hash: await write(stat.path) };
                else entries[stat.name] = { kind: "file", manifest, size: stat.size };
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
        };
        return write(path);
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
            const commit = await this.readCommit(hash);
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
        const from = fromHash ? (await this.readCommit(fromHash)).tree : null;
        const to = (await this.readCommit(toHash)).tree;
        const changes: Change[] = [];
        await this.diffTrees(from, to, "", changes, this.treeWalk(), 0);
        return changes.sort(byPath);
    }

    private async diffTrees(
        fromHash: string | null,
        toHash: string | null,
        prefix: string,
        out: Change[],
        walk: TreeWalk,
        depth: number,
    ): Promise<void> {
        if (fromHash === toHash) return;   // identical subtrees: nothing below can differ
        if (depth) walk.descend(depth);
        const none: Record<string, TreeEntry> = Object.create(null);
        const from = fromHash ? await walk.tree(fromHash) : none;
        const to = toHash ? await walk.tree(toHash) : none;

        const names = new Set([...Object.keys(from), ...Object.keys(to)]);
        if (walk.spend(prefix, names)) await nextTurn();
        for (const name of names) {
            const a = from[name];
            const b = to[name];
            const path = `${prefix}/${name}`;

            if (a && b && a.kind === "tree" && b.kind === "tree") {
                await this.diffTrees(a.hash, b.hash, path, out, walk, depth + 1);
            } else if (a?.kind === "tree" || b?.kind === "tree") {
                // A directory replaced by a file (or the reverse) — recurse both
                // sides so every affected path is reported, not just the name.
                await this.diffTrees(
                    a?.kind === "tree" ? a.hash : null, b?.kind === "tree" ? b.hash : null, path, out, walk, depth + 1,
                );
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
        // The working tree is compared as it is walked, and a path found on
        // both sides leaves `before` as it goes, so all that is held at once
        // is the commit's map and the changes. Walking the whole tree into a
        // list, mapping that into a second map and diffing the two held every
        // path three times over: a hostile HEAD and working tree, each inside
        // both budgets, needed about 600MB.
        const changes: Change[] = [];
        await this.deps.vfs.eachEntry(this.root, ({ path: abs }, manifest) => {
            if (!manifest) return;   // a directory
            const path = abs.slice(this.root.length);
            const was = before.get(path);
            if (!was) {
                changes.push({ path, kind: "added" });
                return;
            }
            if (was.manifest.id !== manifest.id) changes.push({ path, kind: "modified" });
            before.delete(path);
        });
        for (const path of before.keys()) changes.push({ path, kind: "removed" });
        return changes.sort(byPath);
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
                const parents: string[] = (await this.readCommit(hash!)).parents;
                if (!parents.length) throw new VcsError(`"${rev}" reaches past the first commit`);
                hash = parents[0];   // first parent: the branch you were on
            }
        }
        return hash!;
    }

    /** A hash prefix a person typed → the one commit it names. */
    private async expand(prefix: string): Promise<string | null> {
        if (!/^[0-9a-f]{4,}$/.test(prefix)) return null;
        const wanted = objectKey(this.slug, prefix);
        // Only the keys under the abbreviation (usually none or one), not the
        // whole personal space. The filter below stays, for a store that
        // ignores the prefix.
        const keys = await this.deps.store.list(wanted);
        // Only keys that could be objects: a stray key under the prefix would
        // otherwise make every abbreviation of it "ambiguous".
        const hits = keys.filter((k) => k.startsWith(wanted) && HASH.test(k.slice(objectKey(this.slug, "").length)));
        // Ambiguous is an error, not a coin toss — acting on the wrong commit
        // is exactly the kind of mistake version control exists to prevent.
        if (hits.length > 1) throw new VcsError(`"${prefix}" matches ${hits.length} objects — use more characters`);
        if (!hits.length) return null;
        const hash = hits[0].slice(objectKey(this.slug, "").length);
        // Objects include trees; only a commit is a valid revision.
        const object = await this.get<unknown>(hash);
        return isObject(object) && "tree" in object ? hash : null;
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
        // Collected in full BEFORE anything is touched, so a tree that cannot
        // be read throws with the working tree exactly as it was.
        const wanted = await this.filesOf(commitHash);
        // The working tree, read once. The walk reads ahead, and leaves every
        // record cached for the check below - which, run first, opened each
        // directory by path one round trip at a time, and in a fresh process
        // asked to discard changes (so with no status read before it) doubled
        // the checkout.
        const present = await this.deps.vfs.walkEntries(this.root);
        // Every directory the commit needs, checked the same way. mkdir
        // refuses a name held by an entry this version cannot read; found only
        // when the write came, that refusal landed after the deletions below -
        // files gone, HEAD unchanged, and a message about a directory that
        // listings said was not there.
        await this.deps.vfs.assertCreatable(new Set([...wanted.keys()].map((path) => dirname(this.abs(path)))));

        // Remove what the commit does not have BEFORE writing what it does —
        // otherwise a file replaced by a directory of the same name collides.
        for (const entry of present) {
            // keepContent: history still references these manifests.
            if (entry.kind === "file" && !wanted.has(entry.path.slice(this.root.length))) {
                await this.deps.vfs.delete(entry.path, { keepContent: true }).catch(() => {});
            }
        }
        // And the reverse: a directory where the commit has a FILE. Nothing in
        // it is wanted - a path cannot be both - so the loop above has emptied
        // it of files, but it is still there, and the file cannot be written
        // over it.
        for (const entry of present) {
            if (entry.kind === "dir" && wanted.has(entry.path.slice(this.root.length))) {
                await this.deps.vfs.delete(entry.path, { recursive: true, keepContent: true });
            }
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
        walk: TreeWalk,
        depth = 0,
    ): Promise<void> {
        const entries = await walk.tree(treeHash);
        const names = Object.keys(entries);
        if (walk.spend(prefix, names)) await nextTurn();
        for (const name of names) {
            const entry = entries[name];
            const path = `${prefix}/${name}`;
            if (entry.kind === "tree") {
                walk.descend(depth + 1);
                await this.collect(entry.hash, path, out, walk, depth + 1);
            } else {
                out.set(path, entry);
            }
        }
    }

    // ---- branches -----------------------------------------------------------

    /** Create a branch at a commit (HEAD by default). Does not switch to it. */
    async branch(name: string, at?: string): Promise<string> {
        if (!isBranch(name)) throw new VcsError(`"${printable(name, 64)}" is not a usable branch name`);
        // A ref that cannot be read is replaced, as a branch list that cannot
        // be read is: every command that uses the branch reads it first, so
        // this is the only way that name ever works again.
        const existing = await this.refState(name);
        if (existing === "unreadable") console.warn(`[muhkoo/vcs] replacing branch "${name}", which cannot be read`);
        else if (existing) throw new VcsError(`branch "${name}" already exists`);
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
        let sinceTurn = 0;
        const settle = async (path: string) => {
            const conflict = await this.settlePath(path, baseFiles.get(path), ourFiles.get(path), theirFiles.get(path));
            if (conflict) conflicts.push(conflict);
            // A path both sides agree on waits on nothing, so this loop is
            // otherwise one chain of continuations: over a second at the
            // default budgets, with nothing else let in.
            if (++sinceTurn === YIELD_EVERY) {
                sinceTurn = 0;
                await nextTurn();
            }
        };
        // Every path either side has, once - ours, then theirs - without
        // building a set of them: three sides of half a million paths each is
        // already most of what a merge holds. A path only the base has was
        // deleted on both sides, which settles to nothing.
        for (const path of ourFiles.keys()) await settle(path);
        for (const path of theirFiles.keys()) if (!ourFiles.has(path)) await settle(path);

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
                queue.push(...(await this.readCommit(hash)).parents);
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
            queue.push(...(await this.readCommit(hash)).parents);
        }
        return null;
    }

    /** Every file in a commit, by path. */
    private async filesOf(commitHash: string): Promise<Map<string, TreeFile>> {
        const commit = await this.readCommit(commitHash);
        const out = new Map<string, TreeFile>();
        await this.collect(commit.tree, "", out, this.treeWalk());
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
                limits: this.deps.limits,
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
    /** See `VcsNamespaceDeps.limits`. */
    limits?: { entries?: number; pathChars?: number };
}
