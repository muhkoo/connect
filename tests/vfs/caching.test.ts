import { describe, it, expect } from "vitest";
import { makeVfs } from "./harness";
import { VfsNamespace } from "../../src/vfs/VfsNamespace";
import { newDirKey, seal, toBase64 } from "../../src/vfs/recordCipher";
import { dirKey, historyKey } from "../../src/vfs/types";

/**
 * `top` directories under `path`, and `each` under every one of those, each
 * its own record. The bottom ones have no record at all, which is how a
 * directory nothing has been written into is stored, and each reads as empty.
 * Returns how many directories there are below `path`.
 */
async function plantDirs(made: ReturnType<typeof makeVfs>, path: string, top: number, each: number): Promise<number> {
    const { vfs, store } = made;
    await vfs.mkdir(path, { recursive: true });
    const at = (await (vfs as any).openDir(path)) as { id: string; key: Uint8Array };
    const key = newDirKey();
    const dir = (id: string) => ({ kind: "dir", id, key: toBase64(key), mtime: 1 });
    const names = (n: number, prefix: string, id: (i: number) => string) =>
        Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}${i}`, dir(id(i))]));
    await store.put(dirKey(at.id), await seal(at.key, { v: 1, mtime: 1, entries: names(top, "m", (i) => `${at.id}-${i}`) }));
    for (let i = 0; i < top; i++) {
        await store.put(dirKey(`${at.id}-${i}`), await seal(key, { v: 1, mtime: 1, entries: names(each, "d", (j) => `${at.id}-${i}-${j}`) }));
    }
    vfs.clearCache();
    return top + top * each;
}

describe("walk", () => {
    it("returns exactly the same order as a depth-first walk", async () => {
        // The parallel version must be a pure speed change: mount, the CLI's
        // tree, and the project context all consume this order.
        const { vfs } = makeVfs();
        for (const p of [
            "/a/1.txt", "/a/deep/x.txt", "/a/deep/y.txt", "/b/2.txt",
            "/b/nested/more/z.txt", "/c.txt", "/a/deep/deeper/w.txt",
        ]) await vfs.writeFile(p, p);

        const got = await vfs.walk("/");
        // Depth-first, directories before files at each level (byDirsThenName).
        expect(got).toEqual([
            "/a/deep/deeper/w.txt", "/a/deep/x.txt", "/a/deep/y.txt", "/a/1.txt",
            "/b/nested/more/z.txt", "/b/2.txt", "/c.txt",
        ]);
    });

    it("lists sibling directories concurrently", async () => {
        // The point of the change. With five sibling directories a sequential
        // walk issues five round trips end to end; a parallel one overlaps them.
        const { vfs, store } = makeVfs();
        for (let i = 0; i < 5; i++) await vfs.writeFile(`/dir${i}/f.txt`, "x");
        vfs.clearCache();

        let inFlight = 0, peak = 0;
        const real = store.get.bind(store);
        store.get = async (key: string) => {
            inFlight++; peak = Math.max(peak, inFlight);
            try { return await real(key); } finally { inFlight--; }
        };

        await vfs.walk("/");
        expect(peak).toBeGreaterThan(1);
    });

    it("still terminates on a cycle when visits overlap", async () => {
        // The visited set is claimed before the first await, so two concurrent
        // visits to one directory cannot both get through.
        const { vfs } = makeVfs();
        await vfs.writeFile("/a/b/c.txt", "x");
        const paths = await vfs.walk("/");
        expect(paths).toEqual(["/a/b/c.txt"]);
    });
});

describe("directory record caching", () => {
    it("fetches a shared directory once, however many files are read at once", async () => {
        // The failure this guards against: loading a project fired thousands of
        // identical `vfs/d/<id>` requests because every concurrent path
        // resolution missed the cache and started its own.
        const { vfs, store } = makeVfs();
        for (let i = 0; i < 20; i++) await vfs.writeFile(`/apps/demo/src/f${i}.ts`, `export const x = ${i};`);

        vfs.clearCache();
        store.gets.length = 0;

        await Promise.all(Array.from({ length: 20 }, (_, i) => vfs.readText(`/apps/demo/src/f${i}.ts`)));

        const dirReads = store.gets.filter((k) => k.startsWith("vfs/d/"));
        const distinct = new Set(dirReads);
        // /, /apps, /apps/demo, /apps/demo/src — four directories, read once each.
        expect(distinct.size).toBe(4);
        expect(dirReads.length).toBe(distinct.size);
    });

    it("does not re-read directories for sequential reads either", async () => {
        const { vfs, store } = makeVfs();
        for (let i = 0; i < 10; i++) await vfs.writeFile(`/apps/demo/src/f${i}.ts`, "x");

        vfs.clearCache();
        store.gets.length = 0;
        for (let i = 0; i < 10; i++) await vfs.readText(`/apps/demo/src/f${i}.ts`);

        expect(store.gets.filter((k) => k.startsWith("vfs/d/")).length).toBe(4);
    });

    it("makes no store reads on a second walk of an unchanged tree of more than 5,000 directories", async () => {
        // The cache is what keeps a file tree that re-lists as the user types,
        // and a mount that walks on every change, off the network. Bounded at
        // 4,096 records, it forgot every one of a larger tree: a depth-first
        // walk reads each record once, in the same order every time, so the
        // least recently used was always the next one wanted, and every walk
        // fetched the whole tree again - on 5,000 directories, 25s and 10,000
        // gets a mount pass at 30ms a get, against 0.06s and none.
        const made = makeVfs();
        const dirs = await plantDirs(made, "/t", 60, 90);
        expect(dirs).toBeGreaterThan(5_000);
        const { vfs, store } = made;

        const first = await vfs.walkEntries("/");
        expect(first).toHaveLength(1 + dirs);
        store.gets.length = 0;
        const second = await vfs.walkEntries("/");
        expect(second).toEqual(first);
        expect(store.gets).toEqual([]);
    }, 30_000);

    it("keeps both of two concurrent saves into one directory, while the namespace reads thousands of other directories", async () => {
        // Every save into /a through one namespace edits the ONE record the
        // cache holds for it, so two saves at once each write the other's edit
        // too. A cache that forgot /a while a save still held it - bounded, and
        // more than it held read since - handed the second save a fresh copy,
        // and the first then wrote its stale one over it: both resolved, and
        // the second file was gone.
        const made = makeVfs();
        const { vfs, store, content } = made;
        await vfs.writeFile("/a/f.txt", "v1");
        expect(await plantDirs(made, "/other", 60, 90)).toBeGreaterThan(5_000);
        const f = ((await (vfs as any).openDir("/a")) as { node: { entries: Record<string, { id: string }> } }).node.entries["f.txt"];

        // The first save opens /a, then reads f.txt's history before it writes
        // /a: held there while everything else happens.
        let reached!: () => void;
        const atHistory = new Promise<void>((resolve) => (reached = resolve));
        let release!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        const get = store.get.bind(store);
        store.get = async (key: string) => {
            if (key === historyKey(f.id)) {
                reached();
                await held;
            }
            return get(key);
        };
        const first = vfs.writeFile("/a/f.txt", "v2");
        await atHistory;
        await vfs.walkEntries("/other");
        await vfs.writeFile("/a/g.txt", "g");
        release();
        await first;

        // What the store holds, read by a namespace that has cached nothing.
        const fresh = new VfsNamespace({ store, content, seed: () => new Uint8Array(32).fill(7) });
        expect((await fresh.list("/a")).map((stat) => stat.name).sort()).toEqual(["f.txt", "g.txt"]);
        expect(await fresh.readText("/a/f.txt")).toBe("v2");
        expect(await fresh.readText("/a/g.txt")).toBe("g");
    }, 30_000);

    it("forgets a failed read instead of caching the failure", async () => {
        const { vfs, store } = makeVfs();
        await vfs.writeFile("/apps/demo/a.txt", "hello");
        vfs.clearCache();

        const real = store.get.bind(store);
        let fail = true;
        store.get = async (key: string) => {
            if (fail && key.startsWith("vfs/d/")) throw new Error("network");
            return real(key);
        };

        await expect(vfs.readText("/apps/demo/a.txt")).rejects.toThrow("network");
        fail = false;
        // One blip must not poison the directory for the life of the session.
        expect(await vfs.readText("/apps/demo/a.txt")).toBe("hello");
    });
});
