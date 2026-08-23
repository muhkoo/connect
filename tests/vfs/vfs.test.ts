import { describe, it, expect } from "vitest";
import { makeVfs } from "./harness";
import { VfsConflictError, VfsLockedError, VfsNotFoundError } from "../../src/vfs/types";

describe("VFS — files and directories", () => {
    it("writes a file, creating its parents, and reads it back", async () => {
        const { vfs } = makeVfs();
        await vfs.writeFile("/apps/my-app/src/App.tsx", "hello");

        expect(await vfs.readText("/apps/my-app/src/App.tsx")).toBe("hello");
        expect((await vfs.list("/")).map((e) => e.name)).toEqual(["apps"]);
        expect((await vfs.list("/apps/my-app")).map((e) => e.name)).toEqual(["src"]);
    });

    it("round-trips binary content unchanged", async () => {
        // The IDE's old VFS was Record<string,string> and would mangle this.
        const { vfs } = makeVfs();
        const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]);
        await vfs.writeFile("/apps/a/logo.png", png);
        expect(await vfs.readFile("/apps/a/logo.png")).toEqual(png);
    });

    it("lists directories before files, each alphabetically", async () => {
        const { vfs } = makeVfs();
        await vfs.writeFile("/z.txt", "z");
        await vfs.writeFile("/a.txt", "a");
        await vfs.mkdir("/src");
        await vfs.mkdir("/lib");
        expect((await vfs.list("/")).map((e) => e.name)).toEqual(["lib", "src", "a.txt", "z.txt"]);
    });

    it("reports stat for files and directories", async () => {
        const { vfs } = makeVfs();
        await vfs.writeFile("/notes.md", "abcde");
        const file = await vfs.stat("/notes.md");
        expect(file).toMatchObject({ path: "/notes.md", name: "notes.md", kind: "file", size: 5 });

        await vfs.mkdir("/empty");
        expect(await vfs.stat("/empty")).toMatchObject({ kind: "dir", size: 0 });
    });

    it("walks a whole subtree", async () => {
        const { vfs } = makeVfs();
        await vfs.writeFile("/apps/a/src/main.tsx", "1");
        await vfs.writeFile("/apps/a/index.html", "2");
        await vfs.writeFile("/apps/b/x.ts", "3");
        expect((await vfs.walk("/apps")).sort()).toEqual([
            "/apps/a/index.html",
            "/apps/a/src/main.tsx",
            "/apps/b/x.ts",
        ]);
        expect(await vfs.walk("/apps/b")).toEqual(["/apps/b/x.ts"]);
    });

    it("reports existence without throwing", async () => {
        const { vfs } = makeVfs();
        await vfs.writeFile("/a.txt", "a");
        expect(await vfs.exists("/a.txt")).toBe(true);
        expect(await vfs.exists("/nope.txt")).toBe(false);
        expect(await vfs.exists("/deeply/missing/path.txt")).toBe(false);
        await expect(vfs.stat("/nope.txt")).rejects.toThrow(VfsNotFoundError);
    });
});

describe("VFS — mkdir", () => {
    it("refuses to create a directory that already exists", async () => {
        const { vfs } = makeVfs();
        await vfs.mkdir("/src");
        await expect(vfs.mkdir("/src")).rejects.toThrow(VfsConflictError);
        await vfs.mkdir("/src", { recursive: true }); // -p tolerates it
    });

    it("refuses to create a directory over a file", async () => {
        const { vfs } = makeVfs();
        await vfs.writeFile("/src", "i am a file");
        await expect(vfs.mkdir("/src/deeper", { recursive: true })).rejects.toThrow(/is a file/);
    });

    it("will not create intermediate directories without recursive", async () => {
        const { vfs } = makeVfs();
        await expect(vfs.mkdir("/a/b/c")).rejects.toThrow(VfsNotFoundError);
    });

    it("keeps an empty directory, which the old IDE VFS could not represent", async () => {
        const { vfs } = makeVfs();
        await vfs.mkdir("/assets");
        expect((await vfs.list("/")).map((e) => e.name)).toEqual(["assets"]);
        expect(await vfs.list("/assets")).toEqual([]);
    });
});

describe("VFS — rename and move", () => {
    it("renames a file in place", async () => {
        const { vfs } = makeVfs();
        await vfs.writeFile("/a.txt", "content");
        await vfs.rename("/a.txt", "/b.txt");
        expect(await vfs.exists("/a.txt")).toBe(false);
        expect(await vfs.readText("/b.txt")).toBe("content");
    });

    it("moves a file across directories", async () => {
        const { vfs } = makeVfs();
        await vfs.writeFile("/src/a.txt", "x");
        await vfs.rename("/src/a.txt", "/lib/nested/b.txt");
        expect(await vfs.readText("/lib/nested/b.txt")).toBe("x");
        expect(await vfs.list("/src")).toEqual([]);
    });

    it("moves a directory without touching its subtree records", async () => {
        // The point of stable directory ids: the whole subtree is re-parented
        // by editing one entry, so the cost is independent of how much is in it.
        const { vfs, store } = makeVfs();
        await vfs.writeFile("/apps/a/src/deep/file.ts", "x");
        const before = store.puts;

        await vfs.rename("/apps/a", "/archive/a");

        expect(await vfs.readText("/archive/a/src/deep/file.ts")).toBe("x");
        // Attach to the new parent, detach from the old, and mkdir /archive.
        expect(store.puts - before).toBeLessThanOrEqual(3);
    });

    it("refuses to clobber an existing entry", async () => {
        const { vfs } = makeVfs();
        await vfs.writeFile("/a.txt", "a");
        await vfs.writeFile("/b.txt", "b");
        await expect(vfs.rename("/a.txt", "/b.txt")).rejects.toThrow(VfsConflictError);
        expect(await vfs.readText("/b.txt")).toBe("b"); // untouched
    });

    it("refuses to move a directory into its own subtree", async () => {
        // Would detach the subtree from the root and strand every record in it.
        const { vfs } = makeVfs();
        await vfs.writeFile("/src/a.txt", "a");
        await expect(vfs.rename("/src", "/src/nested")).rejects.toThrow(/into itself/);
        expect(await vfs.readText("/src/a.txt")).toBe("a");
    });

    it("keeps history across a rename", async () => {
        // History follows the file id, not the path.
        const { vfs } = makeVfs();
        await vfs.writeFile("/a.txt", "v1");
        await vfs.writeFile("/a.txt", "v2");
        await vfs.rename("/a.txt", "/b.txt");
        expect(await vfs.history("/b.txt")).toHaveLength(1);
        await vfs.restore("/b.txt", 0);
        expect(await vfs.readText("/b.txt")).toBe("v1");
    });
});

describe("VFS — delete", () => {
    it("deletes a file", async () => {
        const { vfs } = makeVfs();
        await vfs.writeFile("/a.txt", "a");
        await vfs.delete("/a.txt");
        expect(await vfs.exists("/a.txt")).toBe(false);
    });

    it("refuses to delete a non-empty directory without recursive", async () => {
        const { vfs } = makeVfs();
        await vfs.writeFile("/src/a.txt", "a");
        await expect(vfs.delete("/src")).rejects.toThrow(/not empty/);
        expect(await vfs.exists("/src/a.txt")).toBe(true);
    });

    it("deletes a subtree recursively and reclaims its records", async () => {
        const { vfs, store } = makeVfs();
        await vfs.writeFile("/src/deep/a.txt", "a");
        await vfs.writeFile("/src/deep/b.txt", "b");
        const before = store.records.size;

        await vfs.delete("/src", { recursive: true });

        expect(await vfs.exists("/src")).toBe(false);
        // Orphaned records are a real cost in this design; deleting must not leak them.
        expect(store.records.size).toBeLessThan(before);
    });

    it("refuses to delete the root", async () => {
        const { vfs } = makeVfs();
        await expect(vfs.delete("/")).rejects.toThrow(VfsConflictError);
    });
});

describe("VFS — versioning", () => {
    it("keeps prior versions and restores them", async () => {
        const { vfs } = makeVfs();
        await vfs.writeFile("/a.txt", "v1");
        await vfs.writeFile("/a.txt", "v2");
        await vfs.writeFile("/a.txt", "v3");

        expect(await vfs.readText("/a.txt")).toBe("v3");
        expect(await vfs.history("/a.txt")).toHaveLength(2);
        expect((await vfs.stat("/a.txt")).versions).toBe(2);

        await vfs.restore("/a.txt", 0);
        expect(await vfs.readText("/a.txt")).toBe("v2");
    });

    it("makes restoring itself undoable", async () => {
        const { vfs } = makeVfs();
        await vfs.writeFile("/a.txt", "v1");
        await vfs.writeFile("/a.txt", "v2");
        await vfs.restore("/a.txt", 0); // back to v1
        // v2 must still be reachable, or restore would be a one-way door.
        await vfs.restore("/a.txt", 0);
        expect(await vfs.readText("/a.txt")).toBe("v2");
    });

    it("caps history so one record cannot grow without bound", async () => {
        const { vfs } = makeVfs({ historyLimit: 3 });
        for (let i = 1; i <= 8; i++) await vfs.writeFile("/a.txt", `v${i}`);
        expect(await vfs.history("/a.txt")).toHaveLength(3);
        expect(await vfs.readText("/a.txt")).toBe("v8");
    });

    it("has no history for a file written once", async () => {
        const { vfs } = makeVfs();
        await vfs.writeFile("/a.txt", "only");
        expect(await vfs.history("/a.txt")).toEqual([]);
    });
});

describe("VFS — encryption and locking", () => {
    it("never writes a filename the server could read", async () => {
        const { vfs, store } = makeVfs();
        await vfs.writeFile("/apps/secret-project/passwords.txt", "hunter2");

        const blob = JSON.stringify([...store.records.values()]);
        expect(blob).not.toContain("secret-project");
        expect(blob).not.toContain("passwords.txt");
        expect(blob).not.toContain("hunter2");
        // Only the sealed envelope shape is visible.
        for (const record of store.records.values()) {
            expect(Object.keys(record as object).sort()).toEqual(["ct", "iv", "v"]);
        }
    });

    it("does not leak the directory structure through record keys", async () => {
        const { vfs, store } = makeVfs();
        await vfs.writeFile("/apps/my-app/App.tsx", "x");
        for (const key of store.records.keys()) {
            expect(key).not.toContain("my-app");
            expect(key).not.toContain("App.tsx");
            expect(key).toMatch(/^vfs\/[dh]\//);
        }
    });

    it("refuses to operate while locked instead of showing an empty filesystem", async () => {
        // The dangerous failure: treating an undecryptable root as empty and
        // then letting a write overwrite the real one.
        const { vfs, lock } = makeVfs();
        await vfs.writeFile("/a.txt", "a");
        lock();
        await expect(vfs.list("/")).rejects.toThrow(VfsLockedError);
        await expect(vfs.writeFile("/b.txt", "b")).rejects.toThrow(VfsLockedError);
        expect(vfs.unlocked).toBe(false);
    });

    it("survives a cold start — nothing is kept in memory", async () => {
        const { vfs, store, content } = makeVfs();
        await vfs.writeFile("/apps/a/src/main.tsx", "source");
        await vfs.mkdir("/apps/a/assets");

        // A brand-new namespace over the same records: a different tab, or a reload.
        const { VfsNamespace } = await import("../../src/vfs/VfsNamespace");
        const fresh = new VfsNamespace({ store, content, seed: () => new Uint8Array(32).fill(7) });

        expect(await fresh.readText("/apps/a/src/main.tsx")).toBe("source");
        expect((await fresh.list("/apps/a")).map((e) => e.name)).toEqual(["assets", "src"]);
    });

    it("cannot read another identity's filesystem", async () => {
        const { vfs, store, content } = makeVfs();
        await vfs.writeFile("/a.txt", "mine");

        const { VfsNamespace } = await import("../../src/vfs/VfsNamespace");
        const other = new VfsNamespace({ store, content, seed: () => new Uint8Array(32).fill(9) });
        // A wrong key must fail loudly, not read as an empty filesystem.
        await expect(other.list("/")).rejects.toThrow();
    });
});

describe("VFS — path handling", () => {
    it("normalises paths so the same file is one entry", async () => {
        const { vfs } = makeVfs();
        await vfs.writeFile("/src/a.txt", "first");
        await vfs.writeFile("src//./a.txt", "second");
        expect(await vfs.list("/src")).toHaveLength(1);
        expect(await vfs.readText("/src/a.txt")).toBe("second");
    });

    it("resolves .. without escaping the root", async () => {
        const { vfs } = makeVfs();
        await vfs.writeFile("/a.txt", "x");
        expect(await vfs.readText("/src/../a.txt")).toBe("x");
        expect(await vfs.readText("/../../a.txt")).toBe("x");
    });

    it("resolves a trailing .. rather than creating an unaddressable name", async () => {
        // `/ok/..` IS the root, so this is a no-op — normalisation means a `..`
        // entry can never be created through a path in the first place.
        const { vfs } = makeVfs();
        await vfs.mkdir("/ok/..");
        expect(await vfs.list("/")).toEqual([]);
    });

    it("refuses to write to the root itself", async () => {
        // The empty basename is the one name normalisation cannot rescue.
        const { vfs } = makeVfs();
        await expect(vfs.writeFile("/", "x")).rejects.toThrow(/cannot be empty/);
    });
});
