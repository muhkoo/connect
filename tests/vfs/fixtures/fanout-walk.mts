/**
 * Walks planted fan-out trees at the DEFAULT limits and prints one JSON line
 * per case. Run in a child process with a small heap by
 * `hostile-records.test.ts`, because what it proves is that memory is bounded:
 * an entry budget that counts only output lets the in-flight work of a walk
 * grow with the tree's fan-out, and that ran a 3GB heap out of memory.
 *
 * Not a test file (vitest only collects `*.test.ts`), so it runs only when
 * that test spawns it.
 */
import { getHeapStatistics } from "node:v8";
import { makeVfs } from "../harness";
import { seal, newDirKey, newId, toBase64 } from "../../../src/vfs/recordCipher";
import { dirKey } from "../../../src/vfs/types";
import { DEFAULT_MAX_ENTRIES, DEFAULT_MAX_PATH_CHARS } from "../../../src/vfs/bounds";
import { Repo } from "../../../src/vcs/VcsNamespace";
import { hashObject } from "../../../src/vcs/hash";
import { headKey, objectKey, refKey } from "../../../src/vcs/types";

console.warn = () => {};

const SEED = new Uint8Array(32).fill(7);
type Dir = { id: string; key: Uint8Array };
const mkDir = (): Dir => ({ id: newId(), key: newDirKey() });
const ref = (d: Dir) => ({ kind: "dir", id: d.id, key: toBase64(d.key), mtime: 1 });

/**
 * Under `/apps/p`: a chain of `chain` single-child directories, then `levels`
 * levels in which every directory names the next one `k` times - or `k[l]`
 * times at level `l` - then a directory holding one file, or nothing. No
 * cycle anywhere, and a few dozen records in all.
 */
async function plant(
    chain: number,
    k: number | number[],
    levels: number,
    leafFile = true,
    name = (i: number) => `${i}`,
) {
    const width = (l: number) => (Array.isArray(k) ? k[l] : k);
    const made = makeVfs({ seed: SEED });
    await made.vfs.writeFile("/apps/p/x.txt", "x");
    const links = Array.from({ length: chain }, mkDir);
    const fan = Array.from({ length: levels + 1 }, mkDir);
    const put = async (d: Dir, entries: Record<string, unknown>) =>
        made.store.put(dirKey(d.id), await seal(d.key, { v: 1, mtime: 1, entries }));
    for (let i = 0; i < chain; i++) await put(links[i], { c: ref(i + 1 < chain ? links[i + 1] : fan[0]) });
    for (let l = 0; l < levels; l++) {
        await put(fan[l], Object.fromEntries(Array.from({ length: width(l) }, (_, i) => [name(i), ref(fan[l + 1])])));
    }
    const leaf = { kind: "file", id: newId(), manifest: { id: "m-leaf" }, size: 1, mtime: 1 };
    await put(fan[levels], leafFile ? { "f.txt": leaf } : {});

    // Hang the planted tree off /apps/p, as a hostile app would.
    const at = (await (made.vfs as any).openDir("/apps/p")) as { id: string; key: Uint8Array; node: any };
    at.node.entries.dag = ref(chain ? links[0] : fan[0]);
    await made.store.put(dirKey(at.id), await seal(at.key, at.node));
    made.vfs.clearCache();
    return made;
}

const REPO_KEY = new Uint8Array(32).fill(3);

/**
 * The largest side a hostile HEAD, branch or working tree can be at the
 * DEFAULT budgets: K1 x K2 directories of N files, every name as long as the
 * path budget allows, in characters a JS engine stores two bytes apiece.
 * Derived from the budgets, so that raising them makes these sides bigger.
 */
const K1 = 50;
const K2 = 40;
/** A little under the entry budget, for the directories and the rest of /apps/p. */
const N = Math.floor((DEFAULT_MAX_ENTRIES - 4000) / (K1 * K2));
/** A path is "/apps/p/dah/d00/d00/" and a name: 20 characters and this many. */
const NAME = Math.floor((DEFAULT_MAX_PATH_CHARS - 100_000) / (K1 * K2 * N)) - 20;
const short = (i: number) => `d${String(i).padStart(2, "0")}`;
const long = (tag: string, i: number) => tag + "\u4e2d".repeat(NAME - tag.length - String(i).length) + i;

/** Seal a repository object under its hash, as a hostile app with the seed can. */
async function putObject(store: ReturnType<typeof makeVfs>["store"], value: unknown) {
    const hash = await hashObject(value);
    await store.put(objectKey("p", hash), await seal(REPO_KEY, value));
    return hash;
}

/** A commit tree of one hostile side, every file name starting with `tag`. */
async function hostileTree(store: ReturnType<typeof makeVfs>["store"], tag: string) {
    const files = await putObject(store, { v: 1, entries: Object.fromEntries(Array.from({ length: N }, (_, i) => [
        long(tag, i), { kind: "file", manifest: { id: `${tag}${i}` }, size: 1 },
    ])) });
    const middle = await putObject(store, { v: 1, entries: Object.fromEntries(Array.from({ length: K2 }, (_, i) => [short(i), { kind: "tree", hash: files }])) });
    const upper = await putObject(store, { v: 1, entries: Object.fromEntries(Array.from({ length: K1 }, (_, i) => [short(i), { kind: "tree", hash: middle }])) });
    return putObject(store, { v: 1, entries: { dah: { kind: "tree", hash: upper } } });
}

const commitOf = (store: ReturnType<typeof makeVfs>["store"], tree: string, parents: string[], message: string) =>
    putObject(store, { v: 1, tree, parents, message, author: "a", at: 1 });

const outcome = (p: Promise<unknown>) =>
    p.then(
        (value) => `ok ${Array.isArray(value) ? value.length : typeof value === "string" ? value : ""}`.trim(),
        (err) => `${err?.name}${err?.limit ? `:${err.limit}` : ""}`,
    );

const cases: Record<string, () => Promise<string>> = {
    // The adversary's shape, cut to fit: 20 links, then six levels of 7-way
    // fan-out and one of 3-way. With /apps/p above it, 490,227 entries and
    // about 31.6 million characters of path - inside both default budgets,
    // so it must simply complete.
    async "in-budget fan-out: walk"() {
        const { vfs } = await plant(20, [7, 7, 7, 7, 7, 7, 3], 7, false);
        return outcome(vfs.walkEntries("/"));
    },
    // One level more is 5.7 million paths: past the entry budget.
    async "over-budget fan-out: walk"() {
        const { vfs } = await plant(20, 7, 8);
        return outcome(vfs.walk("/"));
    },
    // The legit-use reviewer's shape: 25 levels of {a, b}.
    async "binary fan-out: walk"() {
        const { vfs } = await plant(0, 2, 25);
        return outcome(vfs.walk("/"));
    },
    async "binary fan-out: vcs status"() {
        const { vfs, store } = await plant(0, 2, 25);
        const repo = new Repo("p", { vfs, store, key: async () => new Uint8Array(32).fill(3), author: () => "t" });
        return outcome(repo.status());
    },
    async "binary fan-out: vcs commit"() {
        const { vfs, store } = await plant(0, 2, 25);
        const repo = new Repo("p", { vfs, store, key: async () => new Uint8Array(32).fill(3), author: () => "t" });
        return outcome(repo.commit("x"));
    },
    // The most path text the budget allows, in names a JS engine stores two
    // bytes a character: 32 million characters is 64MB before anything else.
    async "two-byte names at the path budget: walk"() {
        const { vfs } = await plant(0, 7, 7, false, (i) => "\u4e2d".repeat(7) + i);
        return outcome(vfs.walk("/"));
    },
    // The repository's side: honest trees T(i+1) = {a: Ti, b: Ti} under a
    // commit, read by `status` into a map of every path.
    async "repository fan-out: vcs status"() {
        const made = makeVfs({ seed: SEED });
        await made.vfs.mkdir("/apps/p", { recursive: true });
        let tree = await putObject(made.store, { v: 1, entries: { "f.txt": { kind: "file", manifest: { id: "m" }, size: 1 } } });
        for (let i = 0; i < 25; i++) {
            tree = await putObject(made.store, { v: 1, entries: { a: { kind: "tree", hash: tree }, b: { kind: "tree", hash: tree } } });
        }
        const commit = await commitOf(made.store, tree, [], "m");
        await made.store.put(refKey("p", "main"), await seal(REPO_KEY, { commit }));
        const repo = new Repo("p", { vfs: made.vfs, store: made.store, key: async () => REPO_KEY, author: () => "t" });
        return outcome(repo.status());
    },
    // The worst case for `status`, which holds both sides at once: a HEAD
    // and a working tree each just inside both budgets, sharing no path, so
    // every file on both sides is a change.
    async "hostile HEAD and working tree, both in budget: vcs status"() {
        const made = makeVfs({ seed: SEED });
        await made.vfs.writeFile("/apps/p/x.txt", "x");
        const put = async (d: Dir, entries: Record<string, unknown>) =>
            made.store.put(dirKey(d.id), await seal(d.key, { v: 1, mtime: 1, entries }));
        const [top, mid, leaf] = [mkDir(), mkDir(), mkDir()];
        await put(top, Object.fromEntries(Array.from({ length: K1 }, (_, i) => [short(i), ref(mid)])));
        await put(mid, Object.fromEntries(Array.from({ length: K2 }, (_, i) => [short(i), ref(leaf)])));
        await put(leaf, Object.fromEntries(Array.from({ length: N }, (_, i) => [
            long("w", i), { kind: "file", id: newId(), manifest: { id: `w${i}` }, size: 1, mtime: 1 },
        ])));
        const at = (await (made.vfs as any).openDir("/apps/p")) as { id: string; key: Uint8Array; node: any };
        at.node.entries.dah = ref(top);
        await made.store.put(dirKey(at.id), await seal(at.key, at.node));

        const commit = await commitOf(made.store, await hostileTree(made.store, "h"), [], "m");
        await made.store.put(refKey("p", "main"), await seal(REPO_KEY, { commit }));
        made.vfs.clearCache();
        const repo = new Repo("p", { vfs: made.vfs, store: made.store, key: async () => REPO_KEY, author: () => "t" });
        return outcome(repo.status());
    },
    // `merge` holds three sides at once: a base, and ours and theirs agreeing
    // on every path, so nothing is written but the merge commit.
    async "hostile base, ours and theirs, each in budget: vcs merge"() {
        const made = makeVfs({ seed: SEED });
        await made.vfs.writeFile("/apps/p/x.txt", "x");
        const base = await commitOf(made.store, await hostileTree(made.store, "b"), [], "base");
        const side = await hostileTree(made.store, "o");
        const ours = await commitOf(made.store, side, [base], "ours");
        const theirs = await commitOf(made.store, side, [base], "theirs");
        await made.store.put(refKey("p", "main"), await seal(REPO_KEY, { commit: ours }));
        await made.store.put(refKey("p", "other"), await seal(REPO_KEY, { commit: theirs }));
        await made.store.put(headKey("p"), await seal(REPO_KEY, { branch: "main" }));
        made.vfs.clearCache();
        const repo = new Repo("p", { vfs: made.vfs, store: made.store, key: async () => REPO_KEY, author: () => "t" });
        return outcome(repo.merge("other", { discardChanges: true }).then((result) => result.kind));
    },
};

if (process.argv[2] === "--sizes") {
    // For the test, which cannot import this file without running it.
    process.stdout.write(JSON.stringify({ side: K1 * K2 * N }) + "\n");
} else {
    for (const name of process.argv.slice(2)) {
        // The most heap in use at any point, sampled while the case runs.
        let peak = 0;
        const sample = () => void (peak = Math.max(peak, getHeapStatistics().used_heap_size));
        const timer = setInterval(sample, 5);
        const result = await cases[name]();
        clearInterval(timer);
        sample();
        process.stdout.write(JSON.stringify({ name, result, peakMB: Math.round(peak / 1e6) }) + "\n");
    }
}
