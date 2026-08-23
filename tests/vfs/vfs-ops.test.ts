import { describe, it, expect } from "vitest";
import { makeVfs } from "./harness";
import { globToRegExp } from "../../src/vfs/glob";
import { VfsConflictError, VfsNotFoundError } from "../../src/vfs/types";

describe("VFS — copy", () => {
    it("copies a file without moving any bytes", async () => {
        // Content is immutable and content-addressed, so a copy is a second
        // handle to the same shards — not a second upload.
        const { vfs, content } = makeVfs();
        await vfs.writeFile("/a.txt", "shared bytes");
        const blobsBefore = content.blobs.size;

        await vfs.copy("/a.txt", "/b.txt");

        expect(await vfs.readText("/b.txt")).toBe("shared bytes");
        expect(content.blobs.size).toBe(blobsBefore);
    });

    it("gives the copy its own identity, so history does not bleed across", async () => {
        const { vfs } = makeVfs();
        await vfs.writeFile("/a.txt", "v1");
        await vfs.writeFile("/a.txt", "v2");
        await vfs.copy("/a.txt", "/b.txt");

        expect(await vfs.history("/b.txt")).toEqual([]);

        // Writing the copy must not push a version onto the original.
        await vfs.writeFile("/b.txt", "b-only");
        expect(await vfs.readText("/a.txt")).toBe("v2");
        expect(await vfs.history("/a.txt")).toHaveLength(1);
    });

    it("copies a directory tree, leaving the two independent", async () => {
        const { vfs } = makeVfs();
        await vfs.writeFile("/src/deep/a.txt", "a");
        await vfs.writeFile("/src/b.txt", "b");

        await vfs.copy("/src", "/backup");

        expect((await vfs.walk("/backup")).sort()).toEqual(["/backup/b.txt", "/backup/deep/a.txt"]);
        // Independent: a write into the copy must not appear in the original.
        await vfs.writeFile("/backup/new.txt", "new");
        expect(await vfs.exists("/src/new.txt")).toBe(false);
    });

    it("refuses to clobber, to copy into itself, or to copy nothing", async () => {
        const { vfs } = makeVfs();
        await vfs.writeFile("/a.txt", "a");
        await vfs.writeFile("/b.txt", "b");
        await expect(vfs.copy("/a.txt", "/b.txt")).rejects.toThrow(VfsConflictError);
        await expect(vfs.copy("/missing.txt", "/x.txt")).rejects.toThrow(VfsNotFoundError);

        await vfs.mkdir("/src");
        await expect(vfs.copy("/src", "/src/inner")).rejects.toThrow(/into itself/);
    });
});

describe("VFS — glob", () => {
    it("matches * within a single directory level", async () => {
        const { vfs } = makeVfs();
        await vfs.writeFile("/src/a.tsx", "");
        await vfs.writeFile("/src/b.css", "");
        await vfs.writeFile("/src/deep/c.tsx", "");

        expect(await vfs.glob("/src/*.tsx")).toEqual(["/src/a.tsx"]);
    });

    it("crosses directories with **", async () => {
        const { vfs } = makeVfs();
        await vfs.writeFile("/src/a.tsx", "");
        await vfs.writeFile("/src/deep/nested/c.tsx", "");
        await vfs.writeFile("/src/styles.css", "");

        expect((await vfs.glob("/src/**/*.tsx")).sort()).toEqual([
            "/src/a.tsx",
            "/src/deep/nested/c.tsx",
        ]);
    });

    it("matches brace alternatives", async () => {
        const { vfs } = makeVfs();
        await vfs.writeFile("/a.ts", "");
        await vfs.writeFile("/b.tsx", "");
        await vfs.writeFile("/c.css", "");
        expect((await vfs.glob("/*.{ts,tsx}")).sort()).toEqual(["/a.ts", "/b.tsx"]);
    });

    it("can be scoped to a subtree", async () => {
        const { vfs } = makeVfs();
        await vfs.writeFile("/apps/a/x.ts", "");
        await vfs.writeFile("/apps/b/y.ts", "");
        expect(await vfs.glob("/apps/**/*.ts", { from: "/apps/b" })).toEqual(["/apps/b/y.ts"]);
    });
});

describe("glob patterns", () => {
    const cases: Array<[string, string, boolean]> = [
        ["/src/*.ts", "/src/a.ts", true],
        // `*` must not cross a separator, or every pattern becomes `**`.
        ["/src/*.ts", "/src/deep/a.ts", false],
        ["/src/**/*.ts", "/src/deep/a.ts", true],
        // `**/` matches zero directories too, so this still finds a top-level file.
        ["/src/**/*.ts", "/src/a.ts", true],
        ["/**/*.css", "/a.css", true],
        ["/?.ts", "/a.ts", true],
        ["/?.ts", "/ab.ts", false],
        // A literal dot must not behave as a regex wildcard.
        ["/a.ts", "/axts", false],
    ];
    for (const [pattern, path, expected] of cases) {
        it(`${pattern} ${expected ? "matches" : "does not match"} ${path}`, () => {
            expect(globToRegExp(pattern).test(path)).toBe(expected);
        });
    }
});

describe("VFS — sweep", () => {
    it("removes records orphaned by a lost write race", async () => {
        const { vfs, store } = makeVfs();
        await vfs.writeFile("/src/a.txt", "a");
        await vfs.writeFile("/keep.txt", "keep");

        // Simulate the race: the child record survives, but the parent entry
        // naming it lost and no longer points at it.
        const dirKeys = [...store.records.keys()].filter((k) => k.startsWith("vfs/d/"));
        expect(dirKeys.length).toBeGreaterThan(1);
        await vfs.delete("/src", { recursive: false }).catch(() => {});
        const orphanKey = "vfs/d/orphaned-by-a-race";
        store.records.set(orphanKey, { v: 1, iv: "x", ct: "y" });

        const { removed } = await vfs.sweep();

        expect(removed).toContain(orphanKey);
        expect(store.records.has(orphanKey)).toBe(false);
        expect(await vfs.readText("/keep.txt")).toBe("keep"); // reachable, untouched
    });

    it("never touches keys outside its own namespace", async () => {
        // The personal space is shared with chat keys, space keys and the legacy
        // file mirror. Reaching beyond `vfs/` would be a data-loss bug.
        const { vfs, store } = makeVfs();
        await vfs.writeFile("/a.txt", "a");
        store.records.set("chat-keys", { some: "blob" });
        store.records.set("__files__/abc", { mirror: true });
        store.records.set("vfs/space", "space-id");

        await vfs.sweep();

        expect(store.records.has("chat-keys")).toBe(true);
        expect(store.records.has("__files__/abc")).toBe(true);
        expect(store.records.has("vfs/space")).toBe(true);
    });

    it("refuses to wipe records when the root reads as empty", async () => {
        // An empty root with orphans present is the shape of a FAILED LOAD.
        // Sweeping there would delete a tree we merely failed to reach.
        const { vfs, store } = makeVfs();
        store.records.set("vfs/d/something", { v: 1, iv: "x", ct: "y" });

        await expect(vfs.sweep()).rejects.toThrow(/failed load/);
        expect(store.records.has("vfs/d/something")).toBe(true);

        const { removed } = await vfs.sweep({ force: true });
        expect(removed).toEqual(["vfs/d/something"]);
    });

    it("is a no-op on a healthy filesystem", async () => {
        const { vfs, store } = makeVfs();
        await vfs.writeFile("/apps/a/src/main.tsx", "x");
        await vfs.mkdir("/apps/a/assets");
        const before = store.records.size;

        expect((await vfs.sweep()).removed).toEqual([]);
        expect(store.records.size).toBe(before);
    });

    it("reclaims a deleted file's history record", async () => {
        const { vfs, store } = makeVfs();
        await vfs.writeFile("/a.txt", "v1");
        await vfs.writeFile("/a.txt", "v2");
        expect([...store.records.keys()].some((k) => k.startsWith("vfs/h/"))).toBe(true);

        await vfs.delete("/a.txt");

        expect([...store.records.keys()].some((k) => k.startsWith("vfs/h/"))).toBe(false);
        expect((await vfs.sweep()).removed).toEqual([]);
    });
});

describe("VFS — reclaiming storage", () => {
    it("releases a deleted file's bytes, not just its metadata", async () => {
        // Shards are content-addressed and reference-counted; forgetting the
        // entry without releasing would keep every byte stored and billed.
        const { vfs, content } = makeVfs();
        await vfs.writeFile("/a.txt", "bytes");
        expect(content.blobs.size).toBe(1);

        await vfs.delete("/a.txt");
        expect(content.blobs.size).toBe(0);
    });

    it("releases every retained version too", async () => {
        const { vfs, content } = makeVfs();
        await vfs.writeFile("/a.txt", "v1");
        await vfs.writeFile("/a.txt", "v2");
        await vfs.writeFile("/a.txt", "v3");
        expect(content.blobs.size).toBe(3);

        await vfs.delete("/a.txt");
        expect(content.blobs.size).toBe(0);
    });

    it("releases versions that fall off the end of the history cap", async () => {
        // Otherwise the cap bounds the RECORD while storage grows forever.
        const { vfs, content } = makeVfs({ historyLimit: 2 });
        for (let i = 1; i <= 6; i++) await vfs.writeFile("/a.txt", `v${i}`);
        // current + 2 retained versions
        expect(content.blobs.size).toBe(3);
    });

    it("reclaims a whole subtree on a recursive delete", async () => {
        const { vfs, content } = makeVfs();
        await vfs.writeFile("/src/a.txt", "a");
        await vfs.writeFile("/src/deep/b.txt", "b");
        expect(content.blobs.size).toBe(2);

        await vfs.delete("/src", { recursive: true });
        expect(content.blobs.size).toBe(0);
    });

    it("keeps a copy's bytes alive when the original is deleted", async () => {
        // A copy shares the manifest, so releasing the original must not pull
        // the bytes out from under it.
        const { vfs } = makeVfs();
        await vfs.writeFile("/a.txt", "shared");
        await vfs.copy("/a.txt", "/b.txt");

        await vfs.delete("/a.txt");
        expect(await vfs.readText("/b.txt")).toBe("shared");
    });
});
