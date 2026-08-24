import { describe, it, expect } from "vitest";
import { makeVfs } from "./harness";

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
