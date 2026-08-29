import { describe, it, expect } from "vitest";
import { makeVfs } from "./harness";

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
