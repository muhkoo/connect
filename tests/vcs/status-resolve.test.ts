import { describe, it, expect, vi } from "vitest";
import { Repo } from "../../src/vcs/VcsNamespace";
import { VcsError } from "../../src/vcs/types";
import { makeVfs } from "../vfs/harness";

function makeRepo() {
    const { vfs, store } = makeVfs();
    const key = new Uint8Array(32).fill(9);
    return { repo: new Repo("demo", { vfs, store, key: async () => key, author: () => "tester" }), vfs, store };
}
const write = (vfs: ReturnType<typeof makeVfs>["vfs"], p: string, b: string) => vfs.writeFile(`/apps/demo${p}`, b);
const read = (vfs: ReturnType<typeof makeVfs>["vfs"], p: string) => vfs.readText(`/apps/demo${p}`);

describe("status", () => {
    it("takes each file's manifest from the walk, not by looking the file up again", async () => {
        // statManifest resolves a path from the root down, so once per walked
        // file was O(depth) per file: a planted tree 50 directories deep cost
        // `status` and `commit` 30s of CPU on top of a walk of under a second.
        const { repo, vfs } = makeRepo();
        await write(vfs, "/a/b/c/one.txt", "1");
        await write(vfs, "/a/two.txt", "2");
        const lookups = vi.spyOn(vfs, "statManifest");
        await repo.commit("base");
        await write(vfs, "/a/b/c/one.txt", "changed");
        expect(await repo.status()).toEqual([{ path: "/a/b/c/one.txt", kind: "modified" }]);
        expect(lookups).not.toHaveBeenCalled();
    });

    it("reports added, modified and deleted against the last commit", async () => {
        const { repo, vfs } = makeRepo();
        await write(vfs, "/keep.txt", "keep");
        await write(vfs, "/change.txt", "before");
        await write(vfs, "/gone.txt", "bye");
        await repo.commit("base");

        await write(vfs, "/change.txt", "after");
        await write(vfs, "/new.txt", "new");
        await vfs.delete("/apps/demo/gone.txt");

        expect(await repo.status()).toEqual([
            { path: "/change.txt", kind: "modified" },
            { path: "/gone.txt", kind: "removed" },
            { path: "/new.txt", kind: "added" },
        ]);
    });

    it("is empty right after a commit", async () => {
        const { repo, vfs } = makeRepo();
        await write(vfs, "/a.txt", "one");
        await repo.commit("base");
        expect(await repo.status()).toEqual([]);
    });

    it("treats everything as added before the first commit", async () => {
        const { repo, vfs } = makeRepo();
        await write(vfs, "/a.txt", "one");
        expect(await repo.status()).toEqual([{ path: "/a.txt", kind: "added" }]);
    });

    it("writes no objects — asking what changed must not record anything", async () => {
        const { repo, vfs, store } = makeRepo();
        await write(vfs, "/a.txt", "one");
        await repo.commit("base");
        await write(vfs, "/a.txt", "two");

        const before = (await store.list()).filter((k) => k.includes("/obj/")).length;
        await repo.status();
        expect((await store.list()).filter((k) => k.includes("/obj/")).length).toBe(before);
    });
});

describe("resolve", () => {
    it("understands HEAD, branch names and full hashes", async () => {
        const { repo, vfs } = makeRepo();
        await write(vfs, "/a.txt", "one");
        const first = await repo.commit("first");

        expect(await repo.resolve("HEAD")).toBe(first);
        expect(await repo.resolve("main")).toBe(first);
        expect(await repo.resolve(first)).toBe(first);
    });

    it("walks back with ^ and ~n", async () => {
        const { repo, vfs } = makeRepo();
        await write(vfs, "/a.txt", "one");
        const first = await repo.commit("first");
        await write(vfs, "/a.txt", "two");
        const second = await repo.commit("second");
        await write(vfs, "/a.txt", "three");
        const third = await repo.commit("third");

        expect(await repo.resolve("HEAD^")).toBe(second);
        expect(await repo.resolve("HEAD~2")).toBe(first);
        expect(await repo.resolve(`${third}^^`)).toBe(first);
    });

    it("expands an abbreviated hash", async () => {
        const { repo, vfs } = makeRepo();
        await write(vfs, "/a.txt", "one");
        const first = await repo.commit("first");
        expect(await repo.resolve(first.slice(0, 8))).toBe(first);
    });

    it("asks the store only for keys under the abbreviation, never for everything", async () => {
        const { repo, vfs, store } = makeRepo();
        await write(vfs, "/a.txt", "one");
        const first = await repo.commit("first");
        store.lists.length = 0;
        expect(await repo.resolve(first.slice(0, 8))).toBe(first);
        expect(store.lists).toContain(`vcs/demo/obj/${first.slice(0, 8)}`);
        expect(store.lists).not.toContain(undefined);
    });

    it("expands an abbreviation from a store that ignores the prefix", async () => {
        const { repo, vfs, store } = makeRepo();
        await write(vfs, "/a.txt", "one");
        const first = await repo.commit("first");
        store.records.set(`vcs/demo/obj/${first.slice(0, 8)}-not-an-object`, "stray");
        store.records.set("todos/x", 1);
        store.list = async () => [...store.records.keys()];
        expect(await repo.resolve(first.slice(0, 8))).toBe(first);
    });

    it("refuses rather than guessing when it cannot tell", async () => {
        const { repo, vfs } = makeRepo();
        await write(vfs, "/a.txt", "one");
        await repo.commit("first");
        await expect(repo.resolve("nope")).rejects.toThrow(VcsError);
        await expect(repo.resolve("HEAD~5")).rejects.toThrow(/past the first commit/);
    });
});

describe("restore", () => {
    it("puts one file back without disturbing the others", async () => {
        const { repo, vfs } = makeRepo();
        await write(vfs, "/a.txt", "original");
        await write(vfs, "/b.txt", "untouched");
        await repo.commit("base");

        await write(vfs, "/a.txt", "broken");
        await write(vfs, "/b.txt", "later work");
        await repo.commit("second");

        await repo.restore("/a.txt", "HEAD^");
        expect(await read(vfs, "/a.txt")).toBe("original");
        // The whole point of a scoped restore: later work elsewhere survives.
        expect(await read(vfs, "/b.txt")).toBe("later work");
    });

    it("brings back a file that was deleted", async () => {
        const { repo, vfs } = makeRepo();
        await write(vfs, "/a.txt", "here");
        await repo.commit("base");
        await vfs.delete("/apps/demo/a.txt", { keepContent: true });

        await repo.restore("/a.txt", "HEAD");
        expect(await read(vfs, "/a.txt")).toBe("here");
    });

    it("says so when the file is not in that commit", async () => {
        const { repo, vfs } = makeRepo();
        await write(vfs, "/a.txt", "here");
        await repo.commit("base");
        await expect(repo.restore("/missing.txt", "HEAD")).rejects.toThrow(/not in HEAD/);
    });
});
