import { describe, it, expect } from "vitest";
import { Repo } from "../../src/vcs/VcsNamespace";
import { VcsError } from "../../src/vcs/types";
import { makeVfs } from "../vfs/harness";

function makeRepo() {
    const { vfs, store } = makeVfs();
    const key = new Uint8Array(32).fill(3);
    return { repo: new Repo("demo", { vfs, store, key: async () => key, author: () => "tester" }), vfs };
}
const write = (vfs: ReturnType<typeof makeVfs>["vfs"], path: string, body: string) =>
    vfs.writeFile(`/apps/demo${path}`, body);
const read = (vfs: ReturnType<typeof makeVfs>["vfs"], path: string) => vfs.readText(`/apps/demo${path}`);

describe("branches", () => {
    it("creates a branch at the current commit and switches between them", async () => {
        const { repo, vfs } = makeRepo();
        await write(vfs, "/a.txt", "base");
        await repo.commit("first");

        await repo.branch("feature");
        await repo.switchTo("feature");
        expect(await repo.currentBranch()).toBe("feature");

        await write(vfs, "/a.txt", "on feature");
        await repo.commit("feature work");

        await repo.switchTo("main");
        // Switching restores the working tree, so main is untouched by feature.
        expect(await read(vfs, "/a.txt")).toBe("base");

        await repo.switchTo("feature");
        expect(await read(vfs, "/a.txt")).toBe("on feature");
    });

    it("advances only the branch you are on", async () => {
        const { repo, vfs } = makeRepo();
        await write(vfs, "/a.txt", "base");
        const first = await repo.commit("first");
        await repo.branch("feature");

        await write(vfs, "/a.txt", "main moved");
        const second = await repo.commit("main work");

        await repo.switchTo("feature");
        expect(await repo.current()).toBe(first);   // feature stayed put
        await repo.switchTo("main");
        expect(await repo.current()).toBe(second);
    });

    it("refuses a duplicate or unusable branch name", async () => {
        const { repo, vfs } = makeRepo();
        await write(vfs, "/a.txt", "base");
        await repo.commit("first");
        await repo.branch("feature");
        await expect(repo.branch("feature")).rejects.toThrow(/already exists/);
        await expect(repo.branch("bad name")).rejects.toThrow(VcsError);
    });

    it("leaves HEAD detached after checking out a bare commit", async () => {
        // Committing from a historical state must not silently rewrite the
        // branch you happened to be on.
        const { repo, vfs } = makeRepo();
        await write(vfs, "/a.txt", "one");
        const first = await repo.commit("first");
        await write(vfs, "/a.txt", "two");
        const second = await repo.commit("second");

        await repo.checkout(first);
        expect(await repo.currentBranch()).toBeNull();
        await repo.switchTo("main");
        expect(await repo.current()).toBe(second);
    });
});

describe("protecting uncommitted work", () => {
    it("refuses to switch away from changes that were never committed", async () => {
        // Switching REPLACES the working tree. Doing that over work nobody
        // recorded destroys it, and the person never asked for a write.
        const { repo, vfs } = makeRepo();
        await write(vfs, "/a.txt", "committed");
        await repo.commit("base");
        await repo.branch("feature");

        await write(vfs, "/a.txt", "work in progress");
        await expect(repo.switchTo("feature")).rejects.toThrow(/uncommitted/);
        expect(await read(vfs, "/a.txt")).toBe("work in progress");
    });

    it("names the files at risk rather than just saying no", async () => {
        const { repo, vfs } = makeRepo();
        await write(vfs, "/a.txt", "one");
        await repo.commit("base");
        await repo.branch("feature");
        await write(vfs, "/a.txt", "edited");
        await expect(repo.switchTo("feature")).rejects.toThrow(/a\.txt/);
    });

    it("goes ahead when the changes are explicitly thrown away", async () => {
        const { repo, vfs } = makeRepo();
        await write(vfs, "/a.txt", "committed");
        await repo.commit("base");
        await repo.branch("feature");
        await write(vfs, "/a.txt", "work in progress");

        await repo.switchTo("feature", { discardChanges: true });
        expect(await read(vfs, "/a.txt")).toBe("committed");
    });

    it("guards checkout and merge the same way", async () => {
        const { repo, vfs } = makeRepo();
        await write(vfs, "/a.txt", "one");
        const first = await repo.commit("base");
        await repo.branch("feature");
        await write(vfs, "/a.txt", "uncommitted");

        await expect(repo.checkout(first)).rejects.toThrow(/uncommitted/);
        await expect(repo.merge("feature")).rejects.toThrow(/uncommitted/);
    });
});

describe("merge base", () => {
    it("finds the commit two branches diverged from", async () => {
        const { repo, vfs } = makeRepo();
        await write(vfs, "/a.txt", "base");
        const base = await repo.commit("base");

        await repo.branch("feature");
        await write(vfs, "/main.txt", "main");
        const ours = await repo.commit("main work");

        await repo.switchTo("feature");
        await write(vfs, "/feature.txt", "feature");
        const theirs = await repo.commit("feature work");

        expect(await repo.mergeBase(ours, theirs)).toBe(base);
    });
});

describe("merge", () => {
    it("fast-forwards when our history is contained in theirs", async () => {
        const { repo, vfs } = makeRepo();
        await write(vfs, "/a.txt", "one");
        await repo.commit("first");
        await repo.branch("feature");
        await repo.switchTo("feature");
        await write(vfs, "/a.txt", "two");
        await repo.commit("second");

        await repo.switchTo("main");
        const result = await repo.merge("feature");
        expect(result.kind).toBe("fast-forward");
        expect(await read(vfs, "/a.txt")).toBe("two");
    });

    it("reports up-to-date when there is nothing to bring over", async () => {
        const { repo, vfs } = makeRepo();
        await write(vfs, "/a.txt", "one");
        await repo.commit("first");
        await repo.branch("feature");
        expect((await repo.merge("feature")).kind).toBe("up-to-date");
    });

    it("combines changes made to different files", async () => {
        const { repo, vfs } = makeRepo();
        await write(vfs, "/shared.txt", "base");
        await repo.commit("base");
        await repo.branch("feature");

        await write(vfs, "/main-only.txt", "from main");
        await repo.commit("main work");

        await repo.switchTo("feature");
        await write(vfs, "/feature-only.txt", "from feature");
        await repo.commit("feature work");

        await repo.switchTo("main");
        const result = await repo.merge("feature");

        expect(result.kind).toBe("merged");
        expect(await read(vfs, "/main-only.txt")).toBe("from main");
        expect(await read(vfs, "/feature-only.txt")).toBe("from feature");

        // The merge commit records BOTH sides, or the branches would still look
        // diverged afterwards.
        const log = await repo.log();
        expect(log[0].parents).toHaveLength(2);
    });

    it("merges edits to different parts of the SAME file", async () => {
        const { repo, vfs } = makeRepo();
        await write(vfs, "/a.txt", "one\ntwo\nthree");
        await repo.commit("base");
        await repo.branch("feature");

        await write(vfs, "/a.txt", "ONE\ntwo\nthree");
        await repo.commit("main edits the top");

        await repo.switchTo("feature");
        await write(vfs, "/a.txt", "one\ntwo\nTHREE");
        await repo.commit("feature edits the bottom");

        await repo.switchTo("main");
        expect((await repo.merge("feature")).kind).toBe("merged");
        expect(await read(vfs, "/a.txt")).toBe("ONE\ntwo\nTHREE");
    });

    it("stops with conflict markers when both sides changed the same lines", async () => {
        const { repo, vfs } = makeRepo();
        await write(vfs, "/a.txt", "one\ntwo\nthree");
        await repo.commit("base");
        await repo.branch("feature");

        await write(vfs, "/a.txt", "one\nOURS\nthree");
        await repo.commit("main");

        await repo.switchTo("feature");
        await write(vfs, "/a.txt", "one\nTHEIRS\nthree");
        await repo.commit("feature");

        await repo.switchTo("main");
        const result = await repo.merge("feature");

        expect(result.kind).toBe("conflicted");
        expect(result.conflicts).toEqual([{ path: "/a.txt", reason: "content" }]);
        const text = await read(vfs, "/a.txt");
        expect(text).toContain("<<<<<<<");
        expect(text).toContain("OURS");
        expect(text).toContain("THEIRS");
    });

    it("finishes a conflicted merge on the next commit, with two parents", async () => {
        // Resolving is ordinary editing; the recorded other side is what makes
        // the eventual commit a real merge rather than a single-parent commit
        // that leaves the branches looking diverged.
        const { repo, vfs } = makeRepo();
        await write(vfs, "/a.txt", "base");
        await repo.commit("base");
        await repo.branch("feature");
        await write(vfs, "/a.txt", "ours");
        await repo.commit("main");
        await repo.switchTo("feature");
        await write(vfs, "/a.txt", "theirs");
        await repo.commit("feature");
        await repo.switchTo("main");

        expect((await repo.merge("feature")).kind).toBe("conflicted");
        expect(await repo.pendingMerge()).not.toBeNull();

        await write(vfs, "/a.txt", "resolved by hand");
        const hash = await repo.commit("resolve the merge");

        const log = await repo.log();
        expect(log[0].hash).toBe(hash);
        expect(log[0].parents).toHaveLength(2);
        expect(await repo.pendingMerge()).toBeNull();
        expect(await read(vfs, "/a.txt")).toBe("resolved by hand");
    });

    it("will not merge a binary file, it asks", async () => {
        // Three-way merging bytes produces corruption, not a result.
        const { repo, vfs } = makeRepo();
        await vfs.writeFile("/apps/demo/logo.png", new Uint8Array([1, 2, 3]));
        await repo.commit("base");
        await repo.branch("feature");

        await vfs.writeFile("/apps/demo/logo.png", new Uint8Array([4, 5, 6]));
        await repo.commit("main");
        await repo.switchTo("feature");
        await vfs.writeFile("/apps/demo/logo.png", new Uint8Array([7, 8, 9]));
        await repo.commit("feature");

        await repo.switchTo("main");
        const result = await repo.merge("feature");
        expect(result.conflicts).toEqual([{ path: "/logo.png", reason: "binary" }]);
    });

    it("merges an extensionless text file, which has no type to go by", async () => {
        // Makefile, LICENSE, .gitignore, .env — judging these by their declared
        // type makes every one an unmergeable false conflict.
        const { repo, vfs } = makeRepo();
        // Non-adjacent edits: diff3 needs an unchanged line between them, or
        // this conflicts for a reason that has nothing to do with the type.
        await write(vfs, "/Makefile", "build:\n\tesbuild\n\ntest:\n\tvitest");
        await repo.commit("base");
        await repo.branch("feature");

        await write(vfs, "/Makefile", "build:\n\tesbuild --minify\n\ntest:\n\tvitest");
        await repo.commit("main");
        await repo.switchTo("feature");
        await write(vfs, "/Makefile", "build:\n\tesbuild\n\ntest:\n\tvitest run");
        await repo.commit("feature");

        await repo.switchTo("main");
        expect((await repo.merge("feature")).kind).toBe("merged");
        expect(await read(vfs, "/Makefile")).toBe("build:\n\tesbuild --minify\n\ntest:\n\tvitest run");
    });

    it("treats bytes that are not valid text as binary, whatever they are named", async () => {
        // Decoding these to merge them would corrupt the file on write-back.
        const { repo, vfs } = makeRepo();
        const invalid = new Uint8Array([0xff, 0xfe, 0x41, 0x42]);
        await vfs.writeFile("/apps/demo/data.txt", invalid);
        await repo.commit("base");
        await repo.branch("feature");
        await vfs.writeFile("/apps/demo/data.txt", new Uint8Array([0xff, 0xfe, 0x43]));
        await repo.commit("main");
        await repo.switchTo("feature");
        await vfs.writeFile("/apps/demo/data.txt", new Uint8Array([0xff, 0xfe, 0x44]));
        await repo.commit("feature");

        await repo.switchTo("main");
        expect((await repo.merge("feature")).conflicts).toEqual([{ path: "/data.txt", reason: "binary" }]);
    });

    it("asks when one side edited a file the other deleted", async () => {
        const { repo, vfs } = makeRepo();
        await write(vfs, "/a.txt", "base");
        await repo.commit("base");
        await repo.branch("feature");

        await write(vfs, "/a.txt", "edited on main");
        await repo.commit("main edits");

        await repo.switchTo("feature");
        await vfs.delete("/apps/demo/a.txt");
        await repo.commit("feature deletes");

        await repo.switchTo("main");
        const result = await repo.merge("feature");
        expect(result.conflicts).toEqual([{ path: "/a.txt", reason: "modify-delete" }]);
    });
});
