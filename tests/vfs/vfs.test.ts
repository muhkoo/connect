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

    it("reports that the root exists, even before anything is written", async () => {
        // The root has no entry of its own, and exists("/") used to answer
        // false because of it. `vfs mount` asks exactly this question before
        // reading a mount root, so at the default root of "/" it saw nothing
        // remote on every pass and planned a local delete for every file.
        const { vfs } = makeVfs();
        expect(await vfs.exists("/")).toBe(true);
        await vfs.writeFile("/a.txt", "a");
        expect(await vfs.exists("/")).toBe(true);
        await vfs.cd("/");
        expect(await vfs.exists(".")).toBe(true);
    });

    it("still refuses to answer for the root while locked", async () => {
        // "The root exists" is only true of a filesystem we can open. Locked,
        // the honest answer is the locked error, not a reassuring true.
        const { vfs, lock } = makeVfs();
        lock();
        await expect(vfs.exists("/")).rejects.toThrow(VfsLockedError);
        await expect(vfs.stat("/")).rejects.toThrow(VfsLockedError);
    });

    it("stats the root as a directory, agreeing with exists", async () => {
        // exists("/") said true while stat("/") said not found - the same
        // disagreement that made `vfs mount` at "/" see nothing remote.
        const { vfs } = makeVfs();
        const empty = await vfs.stat("/");
        expect(empty).toMatchObject({ path: "/", name: "", kind: "dir", size: 0, versions: 0 });
        await vfs.writeFile("/a.txt", "a");
        await vfs.cd("/");
        expect(await vfs.stat(".")).toMatchObject({ path: "/", kind: "dir" });
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
        // by editing one entry in each parent, so the cost is independent of
        // how much is in it.
        const { vfs, store } = makeVfs();
        await vfs.writeFile("/apps/a/src/deep/file.ts", "x");
        const recordOf = async (path: string) => `vfs/d/${(await (vfs as any).openDir(path)).id}`;
        const subtree = await Promise.all(["/apps/a", "/apps/a/src", "/apps/a/src/deep"].map(recordOf));
        const put = store.put.bind(store);
        const written = new Set<string>();
        store.put = async (key: string, value: unknown) => {
            written.add(key);
            return put(key, value);
        };

        await vfs.rename("/apps/a", "/archive/a");

        expect(await vfs.readText("/archive/a/src/deep/file.ts")).toBe("x");
        // The two parents, and the root that gains /archive: nothing inside.
        expect(written).toEqual(new Set(["vfs/d/root", await recordOf("/apps"), await recordOf("/archive")]));
        for (const key of subtree) expect(written.has(key)).toBe(false);
    });

    it("renames within one directory in a single write, which cannot be half done", async () => {
        const { vfs, store } = makeVfs();
        await vfs.writeFile("/src/a.txt", "x");
        await vfs.mkdir("/src/lib");
        const before = store.puts;
        await vfs.rename("/src/a.txt", "/src/b.txt");
        await vfs.rename("/src/lib", "/src/util");
        expect(store.puts - before).toBe(2);
        expect(await vfs.walkEntries("/src")).toMatchObject([{ path: "/src/util" }, { path: "/src/b.txt" }]);
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

    it("keeps history across a move to another directory, and the file writable", async () => {
        // A history record is sealed with its directory's key. Moved, a file
        // kept the old directory's record key and got the new directory's
        // key to open it with: every read of its history, and every write to
        // it, failed with a bare decryption error from then on.
        // Re-sealed by the move itself, not found later under the old key:
        // once the directory it came from is deleted, that key is gone.
        const { vfs } = makeVfs();
        await vfs.writeFile("/a/x.txt", "v1");
        await vfs.writeFile("/a/x.txt", "v2");
        await vfs.writeFile("/a/y.txt", "y");
        await vfs.rename("/a/x.txt", "/b/x.txt");
        await vfs.delete("/a", { recursive: true });
        vfs.clearCache();
        expect(await vfs.history("/b/x.txt")).toHaveLength(1);
        await vfs.writeFile("/b/x.txt", "v3");
        await vfs.restore("/b/x.txt", 1);
        expect(await vfs.readText("/b/x.txt")).toBe("v1");
    });
});

describe("VFS — a move that is interrupted", () => {
    // A move between two directories writes both records, and a network
    // error between the writes leaves the entry in both. Deleting whichever
    // copy is not wanted is the obvious fix - and used to take the other's
    // contents with it: the directory record purged and every file in it
    // released, or for a file its content and its history.
    type Made = ReturnType<typeof makeVfs>;

    const setUp = async (kind: "dir" | "file"): Promise<Made> => {
        const made = makeVfs();
        if (kind === "dir") {
            await made.vfs.writeFile("/old/proj/src/main.ts", "v1");
            await made.vfs.writeFile("/old/proj/src/main.ts", "important work");
            await made.vfs.writeFile("/old/proj/README.md", "readme");
        } else {
            await made.vfs.writeFile("/old/notes.txt", "v1");
            await made.vfs.writeFile("/old/notes.txt", "important work");
        }
        await made.vfs.mkdir("/new");
        return made;
    };
    const paths = (kind: "dir" | "file", side: "old" | "new") =>
        kind === "dir" ? { top: `/${side}/proj`, file: `/${side}/proj/src/main.ts` } : { top: `/${side}/notes.txt`, file: `/${side}/notes.txt` };

    /** How many writes a move makes, counted on a move that succeeds. */
    const writesPerMove = async (kind: "dir" | "file") => {
        const { vfs, store } = await setUp(kind);
        const before = store.puts;
        await vfs.rename(paths(kind, "old").top, paths(kind, "new").top);
        return store.puts - before;
    };

    /** The move, with its `failAt`-th write failing. */
    const interrupted = async (kind: "dir" | "file", failAt: number): Promise<Made> => {
        const made = await setUp(kind);
        const put = made.store.put.bind(made.store);
        let n = 0;
        made.store.put = async (key: string, value: unknown) => {
            if (++n === failAt) throw new Error("network error");
            return put(key, value);
        };
        await expect(made.vfs.rename(paths(kind, "old").top, paths(kind, "new").top)).rejects.toThrow("network error");
        made.store.put = put;
        made.vfs.clearCache();
        return made;
    };

    /**
     * The file, whole: its content, and its history back to the first
     * version. A write to either copy adds to the one history they share.
     */
    const expectWhole = async ({ vfs }: Made, path: string) => {
        expect(await vfs.readText(path)).toBe("important work");
        const versions = await vfs.history(path);
        expect(versions.length).toBeGreaterThanOrEqual(1);
        await vfs.restore(path, versions.length - 1);
        expect(await vfs.readText(path)).toBe("v1");
    };

    for (const kind of ["dir", "file"] as const) {
        it(`leaves a ${kind} whole, whichever write fails and whichever copy is deleted`, async () => {
            const writes = await writesPerMove(kind);
            let inBoth = 0;
            for (let failAt = 1; failAt <= writes; failAt++) {
                for (const remove of ["old", "new"] as const) {
                    const made = await interrupted(kind, failAt);
                    const keep = remove === "old" ? "new" : "old";
                    const there = { old: await made.vfs.exists(paths(kind, "old").file), new: await made.vfs.exists(paths(kind, "new").file) };
                    // Never lost: it is where it was, where it was going, or both.
                    expect(there.old || there.new, `write ${failAt}`).toBe(true);
                    if (!there.old || !there.new) continue;   // not interrupted in between: nothing shared
                    inBoth++;
                    await made.vfs.delete(paths(kind, remove).top, { recursive: true });
                    made.vfs.clearCache();
                    expect(await made.vfs.exists(paths(kind, remove).top), `write ${failAt}, rm ${remove}`).toBe(false);
                    await expectWhole(made, paths(kind, keep).file);
                }
            }
            expect(inBoth).toBeGreaterThan(0);
        });
    }

    it("leaves a file whole when the copy that was written to since is the one deleted", async () => {
        // Writing a file keeps its id, and so the history record the other
        // copy shares - which now holds that copy's content.
        const writes = await writesPerMove("file");
        let inBoth = 0;
        for (let failAt = 1; failAt <= writes; failAt++) {
            const made = await interrupted("file", failAt);
            if (!(await made.vfs.exists("/old/notes.txt")) || !(await made.vfs.exists("/new/notes.txt"))) continue;
            inBoth++;
            await made.vfs.writeFile("/new/notes.txt", "edited after");
            await made.vfs.delete("/new/notes.txt");
            made.vfs.clearCache();
            await expectWhole(made, "/old/notes.txt");
        }
        expect(inBoth).toBeGreaterThan(0);
    });

    for (const side of ["old", "new"] as const) {
        it(`leaves a file whole when the directory holding its ${side} copy is deleted`, async () => {
            // The likeliest way to clean up after a file move that failed:
            // remove the folder it was moved out of. The mark is on the file,
            // one level below what is deleted.
            const writes = await writesPerMove("file");
            let inBoth = 0;
            for (let failAt = 1; failAt <= writes; failAt++) {
                const made = await interrupted("file", failAt);
                if (!(await made.vfs.exists("/old/notes.txt")) || !(await made.vfs.exists("/new/notes.txt"))) continue;
                inBoth++;
                await made.vfs.delete(`/${side}`, { recursive: true });
                made.vfs.clearCache();
                await expectWhole(made, paths("file", side === "old" ? "new" : "old").file);
            }
            expect(inBoth).toBeGreaterThan(0);
        });
    }

    for (const how of ["restore", "writeManifest"] as const) {
        it(`leaves a file whole when one copy is put back with ${how} and then deleted`, async () => {
            // Both keep the entry's mark, as writeFile does. Without it the
            // copy looks like an ordinary file, and deleting it lets go of
            // the history both copies share.
            const writes = await writesPerMove("file");
            let inBoth = 0;
            for (let failAt = 1; failAt <= writes; failAt++) {
                const made = await interrupted("file", failAt);
                if (!(await made.vfs.exists("/old/notes.txt")) || !(await made.vfs.exists("/new/notes.txt"))) continue;
                inBoth++;
                if (how === "restore") await made.vfs.restore("/new/notes.txt", 0);
                else {
                    const { manifest, size } = await made.vfs.statManifest("/old/notes.txt");
                    await made.vfs.writeManifest("/new/notes.txt", manifest, size);
                }
                await made.vfs.delete("/new/notes.txt");
                made.vfs.clearCache();
                await expectWhole(made, "/old/notes.txt");
            }
            expect(inBoth).toBeGreaterThan(0);
        });
    }

    it("leaves no mark on what a move that finished moved", async () => {
        // A mark left behind costs every later delete of the entry, or of a
        // directory above it, a read of the whole tree.
        for (const kind of ["dir", "file"] as const) {
            const { vfs } = await setUp(kind);
            await vfs.rename(paths(kind, "old").top, paths(kind, "new").top);
            vfs.clearCache();
            const entries = (await (vfs as any).openDir("/new")).node.entries;
            const name = kind === "dir" ? "proj" : "notes.txt";
            expect(entries[name], kind).toBeDefined();
            expect(entries[name].moving, kind).toBeUndefined();
        }
    });

    for (const remove of ["the old copy", "the new copy", "the directory holding the old copy"] as const) {
        it(`unmarks the copy that is left when ${remove} is deleted, so its history lets go again`, async () => {
            // A marked file keeps every version that falls off its history,
            // because the other copy may hold it. Once the other copy is gone
            // nothing cleared the mark, and each save past the limit kept one
            // more version's content for good.
            const writes = await writesPerMove("file");
            let inBoth = 0;
            for (let failAt = 1; failAt <= writes; failAt++) {
                const made = await interrupted("file", failAt);
                if (!(await made.vfs.exists("/old/notes.txt")) || !(await made.vfs.exists("/new/notes.txt"))) continue;
                inBoth++;
                const keep = remove === "the new copy" ? "/old" : "/new";
                if (remove === "the old copy") await made.vfs.delete("/old/notes.txt");
                else if (remove === "the new copy") await made.vfs.delete("/new/notes.txt");
                else await made.vfs.delete("/old", { recursive: true });
                made.vfs.clearCache();
                const left = (await (made.vfs as any).openDir(keep)).node.entries["notes.txt"];
                expect(left.moving, `write ${failAt}`).toBeUndefined();

                for (let i = 1; i <= 40; i++) await made.vfs.writeFile(`${keep}/notes.txt`, `edit ${i}`);
                // What the file names and a full history, each held once: nothing more.
                expect(made.content.blobs.size, `write ${failAt}`).toBe(21);
                expect([...made.content.blobs.values()].every((blob) => blob.refs === 1)).toBe(true);
            }
            expect(inBoth).toBeGreaterThan(0);
        });
    }

    it("keeps the marks while more than one other copy is left", async () => {
        // One copy of an interrupted move, moved again and interrupted again:
        // three copies. Deleting one leaves two that still share everything.
        const made = await interrupted("file", 4);   // the detach fails
        const put = made.store.put.bind(made.store);
        let n = 0;
        made.store.put = async (key: string, value: unknown) => {
            if (++n === 3) throw new Error("network error");   // attach, re-seal, then the detach
            return put(key, value);
        };
        await expect(made.vfs.rename("/new/notes.txt", "/third/notes.txt")).rejects.toThrow("network error");
        made.store.put = put;
        for (const path of ["/old/notes.txt", "/new/notes.txt", "/third/notes.txt"]) expect(await made.vfs.exists(path), path).toBe(true);

        await made.vfs.delete("/old/notes.txt");
        made.vfs.clearCache();
        for (const dir of ["/new", "/third"]) expect((await (made.vfs as any).openDir(dir)).node.entries["notes.txt"].moving, dir).toBe(true);
        for (let i = 1; i <= 21; i++) await made.vfs.writeFile("/new/notes.txt", `edit ${i}`);
        expect(await made.vfs.readText("/third/notes.txt")).toBe("important work");

        await made.vfs.delete("/new/notes.txt");
        made.vfs.clearCache();
        expect((await (made.vfs as any).openDir("/third")).node.entries["notes.txt"].moving).toBeUndefined();
    });

    it("unmarks the directory that is left when the other copy of it is deleted", async () => {
        // Left marked, every later delete of it, or of a directory above it,
        // reads the whole tree.
        const writes = await writesPerMove("dir");
        let inBoth = 0;
        for (let failAt = 1; failAt <= writes; failAt++) {
            for (const remove of ["old", "new"] as const) {
                const made = await interrupted("dir", failAt);
                if (!(await made.vfs.exists("/old/proj/src/main.ts")) || !(await made.vfs.exists("/new/proj/src/main.ts"))) continue;
                inBoth++;
                const keep = remove === "old" ? "/new" : "/old";
                await made.vfs.delete(`/${remove}/proj`, { recursive: true });
                made.vfs.clearCache();
                expect((await (made.vfs as any).openDir(keep)).node.entries.proj.moving, `write ${failAt}, rm ${remove}`).toBeUndefined();
                await expectWhole(made, `${keep}/proj/src/main.ts`);
            }
        }
        expect(inBoth).toBeGreaterThan(0);
    });

    it("keeps the other copy's content when a version falls off the history they share", async () => {
        // Both copies start with one manifest and one reference. Saving one
        // copy pushes that manifest onto the shared history, and once it
        // falls off the end, releasing it took the other copy's content.
        const writes = await writesPerMove("file");
        let inBoth = 0;
        for (let failAt = 1; failAt <= writes; failAt++) {
            const made = await interrupted("file", failAt);
            if (!(await made.vfs.exists("/old/notes.txt")) || !(await made.vfs.exists("/new/notes.txt"))) continue;
            inBoth++;
            for (let i = 1; i <= 21; i++) await made.vfs.writeFile("/new/notes.txt", `edit ${i}`);
            made.vfs.clearCache();
            expect(await made.vfs.readText("/old/notes.txt"), `write ${failAt}`).toBe("important work");
        }
        expect(inBoth).toBeGreaterThan(0);
    });

    it("releases content once when both copies are inside what is deleted", async () => {
        // Moved within /a, interrupted, then /a deleted: two entries, one
        // reference. Releasing per entry dropped the reference a copy
        // elsewhere holds too.
        const build = async () => {
            const made = makeVfs();
            await made.vfs.writeFile("/a/f.txt", "shared bytes");
            await made.vfs.mkdir("/a/sub");
            await made.vfs.copy("/a/f.txt", "/keep/f.txt");
            return made;
        };
        const counting = await build();
        const before = counting.store.puts;
        await counting.vfs.rename("/a/f.txt", "/a/sub/f.txt");
        const writes = counting.store.puts - before;

        let inBoth = 0;
        for (let failAt = 1; failAt <= writes; failAt++) {
            const { vfs, store, content } = await build();
            const put = store.put.bind(store);
            let n = 0;
            store.put = async (key: string, value: unknown) => {
                if (++n === failAt) throw new Error("network error");
                return put(key, value);
            };
            await vfs.rename("/a/f.txt", "/a/sub/f.txt").catch(() => {});
            store.put = put;
            vfs.clearCache();
            if ((await vfs.walk("/a")).length !== 2) continue;
            inBoth++;

            await vfs.delete("/a", { recursive: true });
            expect(await vfs.readText("/keep/f.txt")).toBe("shared bytes");
            expect([...content.blobs.values()].map((b) => b.refs)).toEqual([1]);
        }
        expect(inBoth).toBeGreaterThan(0);
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
