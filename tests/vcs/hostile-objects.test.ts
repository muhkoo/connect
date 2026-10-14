/**
 * The repository reading objects it did not write.
 *
 * Objects are planted directly, sealed under the repo key, because that is the
 * capability the threat model grants: any app holding the master seed can
 * derive `deriveRepoKey(seed, slug)` and PUT whatever it likes at
 * `vcs/<slug>/obj/<hash>`. Content addressing only protects anything if the
 * address is CHECKED - and a tree built honestly, hash by hash, can still
 * describe more paths than any machine can list.
 */
import { describe, it, expect, vi } from "vitest";
import { Repo, VcsNamespace } from "../../src/vcs/VcsNamespace";
import { hashObject } from "../../src/vcs/hash";
import { VcsError, headKey, mergeKey, objectKey, refKey, refsIndexKey } from "../../src/vcs/types";
import { seal, unseal, newDirKey, newId, toBase64 } from "../../src/vfs/recordCipher";
import { encryptAesGcm } from "../../src/crypto/primitives/aes-gcm";
import { dirKey } from "../../src/vfs/types";
import type { FileManifest } from "../../src/storage/types";
import { makeVfs } from "../vfs/harness";

const KEY = new Uint8Array(32).fill(3);

function makeRepo(limits?: { entries?: number }) {
    const { vfs, store, content } = makeVfs({ limits });
    const repo = new Repo("demo", { vfs, store, key: async () => KEY, author: () => "tester", limits });
    return { repo, vfs, store, content };
}
type Store = ReturnType<typeof makeRepo>["store"];

/** Seal `value` into the object store at its real hash, or at `at` to forge one. */
async function putObject(store: Store, value: unknown, at?: string): Promise<string> {
    const hash = at ?? (await hashObject(value));
    await store.put(objectKey("demo", hash), await seal(KEY, value));
    return hash;
}

/** A commit over `tree`, with `main` - where HEAD points by default - moved onto it. */
async function commitTree(store: Store, tree: string): Promise<string> {
    const commit = await putObject(store, { v: 1, tree, parents: [], message: "planted", author: "x", at: 1 });
    await store.put(refKey("demo", "main"), await seal(KEY, { commit }));
    return commit;
}

const leaf = (id: string) => ({ kind: "file", manifest: { id, name: id, size: 1, type: "text/plain" }, size: 1 });

describe("an object stored under the wrong hash", () => {
    it("is refused on read, so a tree cannot contain itself", async () => {
        // No honest tree can name its own hash - that would need a SHA-256
        // fixed point. A forged one can, and the tree walkers followed it
        // forever: async recursion never overflows the stack, it simply never
        // returns, and `vcs status` hung with no output at all.
        const { repo, store } = makeRepo();
        const self = "a".repeat(64);
        await putObject(store, { v: 1, entries: { loop: { kind: "tree", hash: self }, "f.txt": leaf("m1") } }, self);
        const commit = await commitTree(store, self);

        await expect(repo.status()).rejects.toBeInstanceOf(VcsError);
        await expect(repo.diff(null, commit)).rejects.toBeInstanceOf(VcsError);
        await expect(repo.checkout(commit, { discardChanges: true })).rejects.toBeInstanceOf(VcsError);
    }, 10_000);

    it("is refused even when it is a perfectly ordinary commit", async () => {
        const { repo, vfs, store } = makeRepo();
        await vfs.writeFile("/apps/demo/a.txt", "a");
        const real = await repo.commit("the real message");
        const stored = await unseal<Record<string, unknown>>(KEY, await store.get(objectKey("demo", real)));
        await putObject(store, { ...stored, message: "a message nobody wrote" }, real);

        const err = await repo.log().catch((e) => e);
        expect(err).toBeInstanceOf(VcsError);
        expect(err.message).toMatch(/does not match/);
    });

    it("is replaced, not trusted, when a commit writes the object that belongs there", async () => {
        // Objects are skipped when already present, which is the point of
        // content addressing. Planting garbage at the hash the NEXT tree will
        // have would otherwise make that tree permanently unwritable - every
        // later commit of the same content would skip the write and keep
        // pointing at the forgery.
        const { repo, vfs, store } = makeRepo();
        await vfs.writeFile("/apps/demo/a.txt", "a");
        const { manifest, size } = await vfs.statManifest("/apps/demo/a.txt");
        const tree = await hashObject({ v: 1, entries: { "a.txt": { kind: "file", manifest, size } } });
        await putObject(store, { v: 1, entries: {} }, tree);

        await repo.commit("first");
        expect(await repo.status()).toEqual([]);
    });
});

describe("every object the repository writes", () => {
    it("verifies against the hash it is stored under", async () => {
        // The check above only holds if nothing legitimate ever fails it. Two
        // things could make an honest object fail: the stored JSON differing
        // from the hashed value (undefined fields, key order), or a name that
        // does not survive a plain object - `__proto__` set the prototype of the
        // tree's entry map and silently dropped the file from the commit.
        const { repo, vfs, store } = makeRepo();
        const manifest = {
            id: "full", name: "full.bin", size: 10, type: "application/octet-stream",
            path: undefined, lastModified: 1_726_000_000_000, createdAt: 1_726_000_000_001, version: 1,
            chunks: [{
                id: "c0", chunkIndex: 0, originalSize: 10, ciphertextSize: 26, dataShards: 4, parityShards: 2,
                shardSize: 7, shardHashes: ["00", "11", "22", "33", "44", "55"], cipher: { key: "a2V5", iv: "aXY=" },
            }],
        } as unknown as FileManifest;
        await vfs.writeManifest("/apps/demo/assets/full.bin", manifest, 10);
        await vfs.writeFile("/apps/demo/__proto__", "p");
        await vfs.writeFile("/apps/demo/constructor/index.ts", "c");
        await vfs.writeFile("/apps/demo/deep/er/café 10:30.md", "é");
        await repo.commit("first");
        await vfs.writeFile("/apps/demo/deep/er/second.md", "2");
        await repo.commit("second");

        const objects = [...store.records.keys()].filter((k) => k.startsWith("vcs/demo/obj/"));
        expect(objects.length).toBeGreaterThan(5);
        for (const key of objects) {
            const value = await unseal(KEY, store.records.get(key));
            expect(await hashObject(value), key).toBe(key.slice("vcs/demo/obj/".length));
        }
        expect(await repo.status()).toEqual([]);
        expect(await repo.log()).toHaveLength(2);
    });
});

describe("a tree that is honestly addressed but hostile", () => {
    it("throws on a fan-out past the entry budget instead of listing 2^n paths", async () => {
        // Every hash valid: T0 = {f.txt}, T(i+1) = {a: Ti, b: Ti}. Each level
        // doubles the paths, so verification cannot help - only a budget does.
        // The objects are fetched once each (identical subtrees ARE the same
        // object); it is the expansion into paths that is unbounded.
        const { repo, store, vfs } = makeRepo({ entries: 1000 });
        let tree = await putObject(store, { v: 1, entries: { "f.txt": leaf("m1") } });
        for (let i = 0; i < 14; i++) {
            tree = await putObject(store, { v: 1, entries: { a: { kind: "tree", hash: tree }, b: { kind: "tree", hash: tree } } });
        }
        const commit = await commitTree(store, tree);
        await vfs.writeFile("/apps/demo/mine.txt", "untouched");

        await expect(repo.status()).rejects.toThrow(/more than 1000 entries/);
        await expect(repo.diff(null, commit)).rejects.toThrow(/more than 1000 entries/);
        await expect(repo.checkout(commit, { discardChanges: true })).rejects.toBeInstanceOf(VcsError);
        // Thrown before anything was written or removed.
        expect(await vfs.walk("/apps/demo")).toEqual(["/apps/demo/mine.txt"]);
    }, 20_000);

    it("throws at the default limits on long names, long before they could exhaust memory", async () => {
        // Counting entries is not enough when each one can be ~16KB of path.
        // 45 trees, every hash genuine: 41 levels of 255-byte names, then
        // 10 x 10 x 99 files - a hundredth of the entry budget, and over 100
        // million characters of path. At full width it crashed `vcs status`.
        const { repo, store, vfs } = makeRepo();
        const longName = (i: number) => "n".repeat(247) + String(i).padStart(8, "0");
        const fan = (n: number, entry: (i: number) => unknown) =>
            Object.fromEntries(Array.from({ length: n }, (_, i) => [longName(i), entry(i)]));
        let tree = await putObject(store, { v: 1, entries: fan(99, (i) => leaf(`m${i}`)) });
        for (const width of [10, 10]) {
            const below = tree;
            tree = await putObject(store, { v: 1, entries: fan(width, () => ({ kind: "tree", hash: below })) });
        }
        for (let i = 41; i >= 0; i--) {
            tree = await putObject(store, { v: 1, entries: { [longName(i)]: { kind: "tree", hash: tree } } });
        }
        const commit = await commitTree(store, tree);
        await vfs.mkdir("/apps/demo", { recursive: true });

        await expect(repo.status()).rejects.toThrow(/more than \d+ characters/);
        await expect(repo.diff(null, commit)).rejects.toThrow(/more than \d+ characters/);
        await expect(repo.checkout(commit, { discardChanges: true })).rejects.toBeInstanceOf(VcsError);
    }, 30_000);

    it("charges the path of every entry it reads, against a ceiling that can be lowered", async () => {
        const { vfs, store } = makeVfs();
        const repoWith = (pathChars?: number) =>
            new Repo("demo", { vfs, store, key: async () => KEY, author: () => "t", limits: { pathChars } });
        for (let d = 0; d < 4; d++) for (let f = 0; f < 10; f++) await vfs.writeFile(`/apps/demo/d${d}/f${f}.txt`, "x");
        const commit = await repoWith().commit("forty files");
        // What collect() builds: "/d0", "/d0/f0.txt", ... - 4 directories and 40 files.
        const total = 4 * "/d0".length + 40 * "/d0/f0.txt".length;

        expect(await repoWith(total).status()).toEqual([]);
        await expect(repoWith(total - 1).status()).rejects.toThrow(`more than ${total - 1} characters`);
        await expect(repoWith(total - 1).diff(null, commit)).rejects.toBeInstanceOf(VcsError);
    });

    it("still collects identical subtrees under every name they appear at", async () => {
        // The trap in "just deduplicate trees you have seen": `vfs cp a b`
        // gives both directories the same tree hash, and dropping the second
        // one would make status report phantom deletions and checkout leave
        // fixtures/b empty.
        const { repo, vfs, store } = makeRepo();
        await vfs.writeFile("/apps/demo/fixtures/a/x.txt", "same");
        await vfs.writeFile("/apps/demo/fixtures/a/y.txt", "also same");
        await vfs.copy("/apps/demo/fixtures/a", "/apps/demo/fixtures/b");
        const first = await repo.commit("fixtures");

        // The case under test: two names, one object.
        const root = await unseal<any>(KEY, store.records.get(objectKey("demo", (await unseal<any>(
            KEY, store.records.get(objectKey("demo", first)))).tree)));
        const fixtures = await unseal<any>(KEY, store.records.get(objectKey("demo", root.entries.fixtures.hash)));
        expect(fixtures.entries.a.hash).toBe(fixtures.entries.b.hash);

        expect(await repo.status()).toEqual([]);
        expect((await repo.diff(null, first)).map((c) => c.path)).toEqual([
            "/fixtures/a/x.txt", "/fixtures/a/y.txt", "/fixtures/b/x.txt", "/fixtures/b/y.txt",
        ]);

        await vfs.delete("/apps/demo/fixtures", { recursive: true });
        await repo.commit("cleared");
        await repo.checkout(first);
        expect(await vfs.readText("/apps/demo/fixtures/b/y.txt")).toBe("also same");
        expect(await repo.status()).toEqual([]);
    });

    it("never walks a name that would leave the project, or an entry it cannot read", async () => {
        const { repo, vfs, store, content } = makeRepo();
        content.blobs.set("m-ok", { bytes: new TextEncoder().encode("ok"), refs: 1 });
        content.blobs.set("m-evil", { bytes: new TextEncoder().encode("evil"), refs: 1 });
        const tree = await putObject(store, {
            v: 1,
            entries: {
                "ok.txt": leaf("m-ok"),
                "../escaped.txt": leaf("m-evil"),
                "..": leaf("m-evil"),
                [`x${String.fromCharCode(0)}y`]: leaf("m-evil"),
                future: { kind: "symlink", target: "/etc/passwd" },
                "tree-without-hash": { kind: "tree", hash: 42 },
                "tree-with-odd-hash": { kind: "tree", hash: "../../refs/main" },
                "file-without-manifest": { kind: "file", size: 1 },
                scalar: 7,
            },
        });
        const commit = await commitTree(store, tree);
        await vfs.writeFile("/apps/demo/old.txt", "replaced by the checkout");
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        expect(await repo.diff(null, commit)).toEqual([{ path: "/ok.txt", kind: "added" }]);
        await repo.checkout(commit, { discardChanges: true });
        expect(await vfs.walk("/")).toEqual(["/apps/demo/ok.txt"]);
        expect(await repo.status()).toEqual([]);
        expect(warn).toHaveBeenCalled();
    });

    it("throws a VcsError, not a TypeError, on a tree that is not a tree", async () => {
        const { repo, store } = makeRepo();
        for (const bad of [{ v: 1, entries: null }, { v: 1 }, { v: 1, entries: [] }, 42, "tree"]) {
            const commit = await commitTree(store, await putObject(store, bad));
            await expect(repo.status(), JSON.stringify(bad)).rejects.toBeInstanceOf(VcsError);
            await expect(repo.diff(null, commit), JSON.stringify(bad)).rejects.toBeInstanceOf(VcsError);
        }
    });
});

describe("committing a working tree that is itself hostile", () => {
    it("agrees with status about a file entry it cannot compare", async () => {
        // A manifest without an id was walked and committed, then skipped when
        // the tree was read back: status said "added" for ever, while commit
        // said there was nothing to commit.
        const { repo, vfs, store } = makeRepo();
        await vfs.writeFile("/apps/demo/real.txt", "r");
        let node: any = await unseal(await (await import("../../src/vfs/recordCipher")).deriveRootKey(new Uint8Array(32).fill(7)),
            store.records.get(dirKey("root")));
        let id = "root";
        let key!: Uint8Array;
        for (const name of ["apps", "demo"]) {
            id = node.entries[name].id;
            key = Uint8Array.from(Buffer.from(node.entries[name].key, "base64"));
            node = await unseal(key, store.records.get(dirKey(id)));
        }
        node.entries["odd.txt"] = { kind: "file", id: newId(), manifest: { name: "odd.txt" }, size: 1, mtime: 1 };
        await store.put(dirKey(id), await seal(key, node));
        vfs.clearCache();
        vi.spyOn(console, "warn").mockImplementation(() => {});

        await repo.commit("first");
        expect(await repo.status()).toEqual([]);
    });

    // commit() does not go through walk(): it builds trees by listing each
    // directory BY PATH and recursing, with no guard at all. So a directory
    // record naming itself - planted in the working tree, not the repository -
    // sent `vcs commit` down /loop/a/b/a/... for ever, even once walk() itself
    // was safe.

    /** Plant /apps/demo/loop as a directory whose entries point back at itself. */
    async function plantLoop(vfs: ReturnType<typeof makeRepo>["vfs"], store: Store, fanOut: number) {
        await vfs.writeFile("/apps/demo/real.txt", "real");
        await vfs.mkdir("/apps/demo/loop");
        // Find /apps/demo's record the way the SDK does, then make loop name itself.
        let node: any = await unseal(await (await import("../../src/vfs/recordCipher")).deriveRootKey(new Uint8Array(32).fill(7)),
            store.records.get(dirKey("root")));
        let key!: Uint8Array;
        let id = "root";
        for (const name of ["apps", "demo", "loop"]) {
            const entry = node.entries[name];
            id = entry.id;
            key = Uint8Array.from(Buffer.from(entry.key, "base64"));
            node = await unseal(key, store.records.get(dirKey(id))) ?? { entries: {} };
        }
        const self = { kind: "dir", id, key: Buffer.from(key).toString("base64"), mtime: 1 };
        const entries = Object.fromEntries(Array.from({ length: fanOut }, (_, i) => [`l${i}`, self]));
        await store.put(dirKey(id), await seal(key, { v: 1, mtime: 1, entries }));
        vfs.clearCache();
        vi.spyOn(console, "warn").mockImplementation(() => {});
    }

    it("terminates on a directory that names itself once", async () => {
        const { repo, vfs, store } = makeRepo();
        await plantLoop(vfs, store, 1);
        const hash = await repo.commit("with a loop in it");
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
        // Recorded exactly as walk() sees it, so status agrees with the commit.
        expect(await repo.status()).toEqual([]);
    }, 10_000);

    it("terminates on a directory that fans out into itself", async () => {
        const { repo, vfs, store } = makeRepo();
        await plantLoop(vfs, store, 2);
        await repo.commit("with a wider loop in it");
        expect(await repo.status()).toEqual([]);
    }, 10_000);

    it("throws the limit error on a cycle-free fan-out, before writing a tree", async () => {
        const { repo, vfs, store } = makeRepo({ entries: 1000 });
        const levels = Array.from({ length: 17 }, () => ({ id: newId(), key: newDirKey() }));
        await vfs.mkdir("/apps/demo/dag", { recursive: true });
        // Re-point /apps/demo/dag's record at the first level of a fan-out DAG.
        let node: any = await unseal(await (await import("../../src/vfs/recordCipher")).deriveRootKey(new Uint8Array(32).fill(7)),
            store.records.get(dirKey("root")));
        let id = "root";
        let key!: Uint8Array;
        for (const name of ["apps", "demo", "dag"]) {
            const entry = node.entries[name];
            id = entry.id;
            key = Uint8Array.from(Buffer.from(entry.key, "base64"));
            node = await unseal(key, store.records.get(dirKey(id))) ?? { entries: {} };
        }
        const ref = (l: { id: string; key: Uint8Array }) => ({ kind: "dir", id: l.id, key: Buffer.from(l.key).toString("base64"), mtime: 1 });
        await store.put(dirKey(id), await seal(key, { v: 1, mtime: 1, entries: { a: ref(levels[0]), b: ref(levels[0]) } }));
        for (let i = 0; i < levels.length - 1; i++) {
            await store.put(dirKey(levels[i].id), await seal(levels[i].key, {
                v: 1, mtime: 1, entries: { a: ref(levels[i + 1]), b: ref(levels[i + 1]) },
            }));
        }
        vfs.clearCache();
        const before = [...store.records.keys()].filter((k) => k.startsWith("vcs/")).length;

        await expect(repo.commit("too big")).rejects.toThrow(/more than 1000 entries/);
        expect([...store.records.keys()].filter((k) => k.startsWith("vcs/")).length).toBe(before);
    }, 20_000);
});

describe("a project name that is not one", () => {
    // The working tree is /apps/<slug>. commit() groups what the walk returns
    // by NORMALISED parent path, and started from the raw one, so for
    // `--project demo/` - what tab completion produces next to a ./demo mount -
    // the root's children were filed under "/apps/demo" and looked up under
    // "/apps/demo/". The commit recorded an empty tree and reported success,
    // and checking it out deleted every file in the project. "demo/" would
    // also have been a second repository over the same files, under its own
    // key. So a slug has to be exactly one usable name.
    const deps = () => {
        const { vfs, store } = makeVfs();
        return { vfs, store, key: async () => KEY, author: () => "t", seed: () => new Uint8Array(32).fill(7) };
    };

    it("is refused before it can reach the working tree", () => {
        for (const slug of ["demo/", "/demo", "", ".", "..", "a/b", "../demo", `x${String.fromCharCode(92)}y`,
                            `x${String.fromCharCode(27)}y`]) {
            expect(() => new Repo(slug, deps()), JSON.stringify(slug)).toThrow(VcsError);
            expect(() => new VcsNamespace(deps()).open(slug), JSON.stringify(slug)).toThrow(VcsError);
        }
    });

    it("leaves real project names alone", async () => {
        const d = deps();
        for (const slug of ["demo", "my-app", "cloud-drive", "app.v2", "Café"]) {
            const repo = new VcsNamespace(d).open(slug);
            await d.vfs.writeFile(`/apps/${slug}/a.txt`, slug);
            await repo.commit("first");
            expect(await repo.status()).toEqual([]);
        }
    });
});

describe("refs and commits this SDK did not write", () => {
    // The hash check proves only that an object is what its address says, and
    // anything holding the seed can write a hash-valid commit - or any HEAD,
    // ref, branch index or MERGE record, which are not hashed at all. They were
    // read with a bare unseal and used as whatever they held: a scalar HEAD made
    // `"detached" in head` a TypeError, a commit whose parents were not an array
    // broke log() the same way, and a branch name or commit message carrying
    // escape sequences reached the terminal of everyone who ran `vcs status`.
    const ESC = String.fromCharCode(27);
    const BEL = String.fromCharCode(7);
    const osc52 = `${ESC}]52;c;Y3VybCBldmlsLnNoIHwgc2g=${BEL}fix typo`;
    const sealAt = async (store: Store, key: string, value: unknown) => store.put(key, await seal(KEY, value));

    async function withHistory() {
        const made = makeRepo();
        await made.vfs.writeFile("/apps/demo/a.txt", "a");
        const first = await made.repo.commit("first");
        return { ...made, first };
    }

    it("refuses a HEAD of the wrong shape with VcsError, not a TypeError", async () => {
        const { repo, store, first } = await withHistory();
        for (const head of ["just a string", 42, null, [], {}, { branch: 7 }, { detached: "not a hash" },
                            { branch: `main${ESC}]0;owned${BEL}` }, { branch: "main", detached: first }]) {
            await sealAt(store, headKey("demo"), head);
            await expect(repo.status(), JSON.stringify(head)).rejects.toBeInstanceOf(VcsError);
            await expect(repo.currentBranch(), JSON.stringify(head)).rejects.toBeInstanceOf(VcsError);
            await expect(repo.log(), JSON.stringify(head)).rejects.toBeInstanceOf(VcsError);
        }
    });

    it("refuses a branch ref of the wrong shape", async () => {
        const { repo, store } = await withHistory();
        for (const ref of ["abc", { commit: 42 }, { commit: "not a hash" }, [], null]) {
            await sealAt(store, refKey("demo", "main"), ref);
            await expect(repo.current(), JSON.stringify(ref)).rejects.toBeInstanceOf(VcsError);
            await expect(repo.resolve("main"), JSON.stringify(ref)).rejects.toBeInstanceOf(VcsError);
        }
    });

    it("lists only branch names it would have accepted, and repairs an index it cannot read", async () => {
        const { repo, store } = await withHistory();
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        await sealAt(store, refsIndexKey("demo"), { names: ["main", `evil${ESC}[2J`, 42, "-flag", "ok/name"] });
        expect(await repo.branches()).toEqual(["main", "ok/name"]);
        expect(warn).toHaveBeenCalled();

        for (const index of ["main", { names: "main" }, 42, null]) {
            await sealAt(store, refsIndexKey("demo"), index);
            await expect(repo.branches(), JSON.stringify(index)).rejects.toBeInstanceOf(VcsError);
        }
        // Creating a branch writes a fresh index rather than being blocked by the old one.
        await repo.branch("feature");
        expect(await repo.branches()).toEqual(["feature"]);
    });

    it("refuses a pending merge of the wrong shape, or one naming a branch it would not accept", async () => {
        const { repo, store, first } = await withHistory();
        for (const merge of ["x", { theirs: 42, name: "b" }, { theirs: "nothash", name: "b" }, { theirs: first },
                            { theirs: first, name: osc52 }]) {
            await sealAt(store, mergeKey("demo"), merge);
            await expect(repo.pendingMerge(), JSON.stringify(merge)).rejects.toBeInstanceOf(VcsError);
        }
        await sealAt(store, mergeKey("demo"), { theirs: first, name: "feature" });
        expect(await repo.pendingMerge()).toEqual({ theirs: first, name: "feature" });
    });

    it("abandons a pending merge that cannot be read, so commits work again", async () => {
        // Reading MERGE strictly made one of the wrong shape stop every
        // commit, on every branch, with nothing in the SDK that removed it.
        const { repo, store, first, vfs } = await withHistory();
        await sealAt(store, mergeKey("demo"), { theirs: first, name: 42 });
        await vfs.writeFile("/apps/demo/b.txt", "b");
        const stuck = await repo.commit("second").catch((e) => e);
        expect(stuck).toBeInstanceOf(VcsError);
        expect(stuck.message).toMatch(/abort the merge/);

        await repo.abortMerge();
        expect(await repo.pendingMerge()).toBeNull();
        const second = await repo.commit("second");
        expect((await repo.log()).find((entry) => entry.hash === second)?.parents).toEqual([first]);
    });

    it("replaces a branch ref that cannot be read when the branch is created again", async () => {
        // The ref was read before anything could write it - by commit, by
        // branch and by switch - so a malformed one killed that branch name
        // for good.
        const { repo, store, first, vfs } = await withHistory();
        for (const ref of [{ commit: "nope" }, "just a string", { commit: 42 }]) {
            await sealAt(store, refKey("demo", "main"), ref);
            const stuck = await repo.commit("next").catch((e) => e);
            expect(stuck, JSON.stringify(ref)).toBeInstanceOf(VcsError);
            expect(stuck.message).toMatch(/create the branch again/);
            await repo.branch("main", first);
            expect(await repo.current()).toBe(first);
        }
        // A garbled record, too.
        await store.put(refKey("demo", "main"), { v: 1, iv: "AAAAAAAAAAAAAAAA", ct: "AAAAAAAAAAAAAAAAAAAAAA==" });
        await expect(repo.current()).rejects.toThrow(/create the branch again/);
        await repo.branch("main", first);
        await vfs.writeFile("/apps/demo/b.txt", "b");
        await repo.commit("next");
        // A branch that CAN be read is still not replaced.
        await expect(repo.branch("main", first)).rejects.toThrow(/already exists/);
    });

    it("refuses a branch name too long to be a store key, wherever it comes from", async () => {
        // A branch name becomes a store key, `vcs/<slug>/refs/<name>`, and
        // the personal space answers a key past 2048 bytes with a 500. A
        // planted HEAD naming such a branch passed the name check, and
        // status, log and commit all failed with a bare HttpError instead of
        // saying HEAD could not be read - and how to replace it.
        const { repo, store, first, vfs } = await withHistory();
        for (const method of ["get", "put", "delete"] as const) {
            const real = (store[method] as (...args: unknown[]) => Promise<unknown>).bind(store);
            (store as any)[method] = async (key: string, ...rest: unknown[]) => {
                if (new TextEncoder().encode(`kvmeta:${key}`).length > 2048) throw new Error("Internal Server Error");
                return real(key, ...rest);
            };
        }
        const long = "b".repeat(3000);
        await expect(repo.branch(long, first)).rejects.toThrow(/not a usable branch name/);
        await expect(repo.branch("b".repeat(201), first)).rejects.toThrow(/not a usable branch name/);
        await repo.branch("b".repeat(200), first);

        await sealAt(store, headKey("demo"), { branch: long });
        await vfs.writeFile("/apps/demo/b.txt", "b");
        for (const read of [() => repo.status(), () => repo.log(), () => repo.commit("second")]) {
            await expect(read()).rejects.toThrow(/HEAD cannot be read/);
        }
        await repo.switchTo("main", { discardChanges: true });

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        await sealAt(store, refsIndexKey("demo"), { names: ["main", long] });
        expect(await repo.branches()).toEqual(["main"]);
        expect(warn).toHaveBeenCalled();
        await sealAt(store, mergeKey("demo"), { theirs: first, name: long });
        await expect(repo.pendingMerge()).rejects.toThrow(/merge in progress cannot be read/);
    });

    it("refuses a hash-valid commit of the wrong shape", async () => {
        const { repo, store, first } = await withHistory();
        const real = await unseal<Record<string, unknown>>(KEY, await store.get(objectKey("demo", first)));
        for (const change of [
            { parents: "not an array" }, { parents: [42] }, { parents: ["nothash"] }, { parents: null },
            { message: 42 }, { author: { name: "x" } }, { at: "yesterday" }, { at: Infinity }, { tree: 7 },
            { v: 2 },
            // Finite, and past what a Date can hold: `vcs log` formats it with
            // toISOString, which throws, on every run on that branch.
            { at: 1e300 }, { at: -1e17 }, { at: 8.64e15 + 1 },
        ]) {
            const commit = await putObject(store, { ...real, ...change, parents: "parents" in change ? change.parents : [first] });
            await sealAt(store, refKey("demo", "main"), { commit });
            await expect(repo.log(), JSON.stringify(change)).rejects.toBeInstanceOf(VcsError);
            await expect(repo.diff(first, commit), JSON.stringify(change)).rejects.toBeInstanceOf(VcsError);
        }
    });

    it("hands back a commit's strings as they are, when the commit is the right shape", async () => {
        // Escaping for a terminal is the printer's job - a commit message may
        // hold newlines - but only strings get that far.
        const { repo, store, first } = await withHistory();
        const real = await unseal<Record<string, unknown>>(KEY, await store.get(objectKey("demo", first)));
        const commit = await putObject(store, { ...real, parents: [first], message: osc52, author: osc52, at: 2 });
        await sealAt(store, refKey("demo", "main"), { commit });
        const top = (await repo.log()).find((entry) => entry.hash === commit)!;
        expect(top.message).toBe(osc52);
        expect(typeof top.author).toBe("string");
    });

    it("resolves an abbreviation of an object that is not a commit to nothing, not a TypeError", async () => {
        const { repo, store } = await withHistory();
        for (const value of ["hello", 42, [1, 2]]) {
            const hash = await putObject(store, value);
            await expect(repo.resolve(hash.slice(0, 12)), JSON.stringify(value)).rejects.toThrow(/no commit matches/);
        }
    });

    it("names the object in a VcsError when a stored object cannot be opened", async () => {
        const iv = toBase64(new Uint8Array(12).fill(1));
        const garbled: Array<[string, () => Promise<unknown>]> = [
            ["sealed under another key", async () => seal(new Uint8Array(32).fill(9), { v: 1 })],
            ["not base64", async () => ({ v: 1, iv: "!!!", ct: "!!!" })],
            ["not JSON", async () => ({ v: 1, iv, ct: toBase64(await encryptAesGcm(KEY, new Uint8Array(12).fill(1), new TextEncoder().encode("{nope"))) })],
            ["nested past what can be hashed", async () => ({
                v: 1, iv, ct: toBase64(await encryptAesGcm(KEY, new Uint8Array(12).fill(1),
                    new TextEncoder().encode(`{"v":1,"deep":${"[".repeat(20000)}${"]".repeat(20000)}}`))),
            })],
        ];
        for (const [label, make] of garbled) {
            const { repo, store, first } = await withHistory();
            await store.put(objectKey("demo", first), await make());
            const err = await repo.status().catch((e) => e);
            expect(err, label).toBeInstanceOf(VcsError);
            expect(err.message, label).toContain(first.slice(0, 8));
        }
    });

    it("turns a HEAD, ref, index or MERGE record that cannot be opened into VcsError", async () => {
        for (const key of [headKey("demo"), refKey("demo", "main"), refsIndexKey("demo"), mergeKey("demo")]) {
            const { repo, store } = await withHistory();
            await store.put(key, { v: 1, iv: "!!!", ct: "!!!" });
            const read = key === refsIndexKey("demo") ? repo.branches() : key === mergeKey("demo") ? repo.pendingMerge() : repo.status();
            await expect(read, key).rejects.toBeInstanceOf(VcsError);
        }
    });
});

describe("history as deep, or as long, as the working tree allows", () => {
    /** Commit a tree `levels` directories deep, ending in one file, on top of `parent`. */
    async function deepCommit(store: Store, parent: string, levels: number, manifest: unknown): Promise<string> {
        let tree = await putObject(store, { v: 1, entries: { "f.txt": { kind: "file", manifest, size: 1 } } });
        for (let i = 0; i < levels; i++) tree = await putObject(store, { v: 1, entries: { d: { kind: "tree", hash: tree } } });
        return putObject(store, { v: 1, tree, parents: [parent], message: "deep", author: "a", at: 2 });
    }

    it("refuses a tree too deep to check out, before touching the working tree", async () => {
        // A hash-valid tree 71 deep diffed and checked out, leaving a working
        // tree deeper than a walk reads: `status` threw from then on, and so
        // did checking out anything else, since that walks the tree first.
        // The project is two directories down (/apps/demo), so its tree may
        // nest 62 more.
        const { repo, vfs, store } = makeRepo();
        await vfs.writeFile("/apps/demo/a.txt", "a");
        const good = await repo.commit("good");
        const { manifest } = await vfs.statManifest("/apps/demo/a.txt");

        const tooDeep = await deepCommit(store, good, 63, manifest);
        await expect(repo.diff(good, tooDeep)).rejects.toThrow(/nested more than 62/);
        await expect(repo.checkout(tooDeep)).rejects.toBeInstanceOf(VcsError);
        expect(await vfs.walk("/apps/demo")).toEqual(["/apps/demo/a.txt"]);
        expect(await repo.current()).toBe(good);

        const fits = await deepCommit(store, good, 62, manifest);
        await repo.checkout(fits);
        expect(await repo.status()).toEqual([]);
        await repo.checkout(good, { discardChanges: true });
        expect(await vfs.walk("/apps/demo")).toEqual(["/apps/demo/a.txt"]);
    });

    it("lets timers run while it reads a tree of many paths", async () => {
        // Once its trees are fetched, reading history is promise
        // continuations and nothing else, like a cached walk.
        const { repo, store, vfs } = makeRepo({ entries: 500_000 });
        let tree = await putObject(store, { v: 1, entries: { "f.txt": leaf("m1") } });
        for (let i = 0; i < 17; i++) {
            tree = await putObject(store, { v: 1, entries: { a: { kind: "tree", hash: tree }, b: { kind: "tree", hash: tree } } });
        }
        const commit = await commitTree(store, tree);
        await vfs.mkdir("/apps/demo", { recursive: true });

        for (const read of [() => repo.diff(null, commit), () => repo.status()]) {
            let ticks = 0;
            const timer = setInterval(() => ticks++, 1);
            try {
                expect(await read()).toHaveLength(2 ** 17);
            } finally {
                clearInterval(timer);
            }
            expect(ticks).toBeGreaterThanOrEqual(5);
        }
    }, 30_000);

    it("lets timers run while it merges many paths", async () => {
        // Settling a path both sides agree on waits on nothing, so the loop
        // over every path of three sides ran as one chain of promise
        // continuations: over a second, at the default budgets, with no timer,
        // input or Ctrl-C let in.
        const { repo, store, vfs } = makeRepo({ entries: 500_000 });
        const put = (entries: Record<string, unknown>) => putObject(store, { v: 1, entries });
        let shared = await put({ "f.txt": leaf("m1") });
        for (let i = 0; i < 17; i++) shared = await put({ a: { kind: "tree", hash: shared }, b: { kind: "tree", hash: shared } });
        const commit = (tree: string, parents: string[]) =>
            putObject(store, { v: 1, tree, parents, message: "m", author: "a", at: 1 });
        const base = await commit(await put({ s: { kind: "tree", hash: shared } }), []);
        const ours = await commit(await put({ s: { kind: "tree", hash: shared }, "o.txt": leaf("mo") }), [base]);
        const theirs = await commit(await put({ s: { kind: "tree", hash: shared }, "t.txt": leaf("mt") }), [base]);
        await store.put(refKey("demo", "main"), await seal(KEY, { commit: ours }));
        await store.put(refKey("demo", "other"), await seal(KEY, { commit: theirs }));
        await vfs.mkdir("/apps/demo", { recursive: true });

        // Ticks counted from the first path settled to the last.
        let ticks = 0;
        const timer = setInterval(() => ticks++, 1);
        const settle = (repo as any).settlePath.bind(repo);
        let first = -1;
        let last = -1;
        (repo as any).settlePath = async (...args: unknown[]) => {
            if (first < 0) first = ticks;
            const result = await settle(...args);
            last = ticks;
            return result;
        };
        try {
            expect((await repo.merge("other", { discardChanges: true })).kind).toBe("merged");
        } finally {
            clearInterval(timer);
        }
        expect(last - first).toBeGreaterThanOrEqual(5);
    }, 30_000);

    it("checks out nothing when a directory it must create is held by an entry this version cannot read", async () => {
        // mkdir refuses such a name, but materialise() deleted the files the
        // target lacks FIRST, so the refusal landed half way: files gone, HEAD
        // unchanged, status dirty.
        const { repo, vfs, store } = makeRepo();
        await vfs.writeFile("/apps/demo/src/app.ts", "v1");
        await vfs.writeFile("/apps/demo/README.md", "r");
        const c1 = await repo.commit("one");
        await vfs.delete("/apps/demo/src", { recursive: true });
        await vfs.writeFile("/apps/demo/other.txt", "o");
        const c2 = await repo.commit("two");

        let node: any = await unseal(await (await import("../../src/vfs/recordCipher")).deriveRootKey(new Uint8Array(32).fill(7)),
            store.records.get(dirKey("root")));
        let id = "root";
        let key!: Uint8Array;
        for (const name of ["apps", "demo"]) {
            id = node.entries[name].id;
            key = Uint8Array.from(Buffer.from(node.entries[name].key, "base64"));
            node = await unseal(key, store.records.get(dirKey(id)));
        }
        node.entries.src = { kind: "symlink", id: newId(), target: "/elsewhere" };
        await store.put(dirKey(id), await seal(key, node));
        vfs.clearCache();
        vi.spyOn(console, "warn").mockImplementation(() => {});

        await expect(repo.checkout(c1)).rejects.toThrow(/cannot read it; a recursive delete removes it/);
        expect(await vfs.walk("/apps/demo")).toEqual(["/apps/demo/other.txt", "/apps/demo/README.md"]);
        expect(await repo.current()).toBe(c2);
        expect(await repo.status()).toEqual([]);

        // Which is then the way through.
        await vfs.delete("/apps/demo/src", { recursive: true });
        await repo.checkout(c1);
        expect(await vfs.walk("/apps/demo")).toEqual(["/apps/demo/src/app.ts", "/apps/demo/README.md"]);
    });
});
