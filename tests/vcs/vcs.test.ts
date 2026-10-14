import { describe, it, expect, beforeEach } from "vitest";
import { Repo } from "../../src/vcs/VcsNamespace";
import { canonical, hashObject } from "../../src/vcs/hash";
import { VcsError } from "../../src/vcs/types";
import { makeVfs } from "../vfs/harness";

function makeRepo() {
    const { vfs, store } = makeVfs();
    const key = new Uint8Array(32).fill(3);
    const repo = new Repo("demo", {
        vfs,
        store,
        key: async () => key,
        author: () => "tester",
    });
    return { repo, vfs, store };
}

const write = (vfs: ReturnType<typeof makeVfs>["vfs"], path: string, body: string) =>
    vfs.writeFile(`/apps/demo${path}`, body);

describe("canonical form", () => {
    it("does not depend on key order", async () => {
        // Two clients building the same tree must agree on its hash, or history
        // forks for no reason.
        expect(canonical({ b: 1, a: 2 })).toBe(canonical({ a: 2, b: 1 }));
        expect(await hashObject({ b: 1, a: 2 })).toBe(await hashObject({ a: 2, b: 1 }));
    });

    it("sorts nested keys too, and keeps array order", () => {
        expect(canonical({ x: { d: 1, c: 2 } })).toBe('{"x":{"c":2,"d":1}}');
        expect(canonical([3, 1, 2])).toBe("[3,1,2]");   // arrays are ordered data
    });

    it("distinguishes values that merely look alike", async () => {
        expect(await hashObject({ a: 1 })).not.toBe(await hashObject({ a: "1" }));
    });
});

describe("commit", () => {
    it("records the project and returns a hash", async () => {
        const { repo, vfs } = makeRepo();
        await write(vfs, "/src/App.tsx", "one");
        const hash = await repo.commit("first");
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
        expect(await repo.current()).toBe(hash);
    });

    it("chains commits by parent", async () => {
        const { repo, vfs } = makeRepo();
        await write(vfs, "/a.txt", "one");
        const first = await repo.commit("first");
        await write(vfs, "/a.txt", "two");
        const second = await repo.commit("second");

        const log = await repo.log();
        expect(log.map((l) => l.message)).toEqual(["second", "first"]);
        expect(log[0].parents).toEqual([first]);
        expect(second).not.toBe(first);
    });

    it("refuses an empty commit", async () => {
        // Almost always a mistake: the user thinks they saved something.
        const { repo, vfs } = makeRepo();
        await write(vfs, "/a.txt", "one");
        await repo.commit("first");
        await expect(repo.commit("again")).rejects.toThrow(/nothing to commit/);
    });

    it("refuses a commit with no message", async () => {
        const { repo, vfs } = makeRepo();
        await write(vfs, "/a.txt", "one");
        await expect(repo.commit("   ")).rejects.toThrow(VcsError);
    });

    it("gives an unchanged directory the same tree hash across commits", async () => {
        // The payoff for content-addressing: an untouched subtree costs nothing
        // and prunes the diff walk entirely.
        const { repo, vfs, store } = makeRepo();
        await write(vfs, "/deep/nested/a.txt", "unchanged");
        await write(vfs, "/top.txt", "one");
        await repo.commit("first");
        const objectsAfterFirst = [...store.records.keys()].filter((k) => k.startsWith("vcs/demo/obj/")).length;

        await write(vfs, "/top.txt", "two");
        await repo.commit("second");
        const objectsAfterSecond = [...store.records.keys()].filter((k) => k.startsWith("vcs/demo/obj/")).length;

        // Root tree + commit are new; /deep and /deep/nested are reused.
        expect(objectsAfterSecond - objectsAfterFirst).toBeLessThanOrEqual(2);
    });
});

describe("diff", () => {
    it("reports additions, modifications and removals", async () => {
        const { repo, vfs } = makeRepo();
        await write(vfs, "/keep.txt", "same");
        await write(vfs, "/edit.txt", "before");
        await write(vfs, "/gone.txt", "bye");
        const first = await repo.commit("first");

        await write(vfs, "/edit.txt", "after");
        await write(vfs, "/new.txt", "hello");
        await vfs.delete("/apps/demo/gone.txt");
        const second = await repo.commit("second");

        expect(await repo.diff(first, second)).toEqual([
            { path: "/edit.txt", kind: "modified" },
            { path: "/gone.txt", kind: "removed" },
            { path: "/new.txt", kind: "added" },
        ]);
    });

    it("treats the first commit as all additions", async () => {
        const { repo, vfs } = makeRepo();
        await write(vfs, "/a.txt", "one");
        const first = await repo.commit("first");
        expect(await repo.diff(null, first)).toEqual([{ path: "/a.txt", kind: "added" }]);
    });

    it("sees nothing between a commit and itself", async () => {
        const { repo, vfs } = makeRepo();
        await write(vfs, "/a.txt", "one");
        const first = await repo.commit("first");
        expect(await repo.diff(first, first)).toEqual([]);
    });

    it("reports paths inside a changed subdirectory", async () => {
        const { repo, vfs } = makeRepo();
        await write(vfs, "/src/deep/a.txt", "one");
        const first = await repo.commit("first");
        await write(vfs, "/src/deep/a.txt", "two");
        const second = await repo.commit("second");
        expect(await repo.diff(first, second)).toEqual([{ path: "/src/deep/a.txt", kind: "modified" }]);
    });
});

describe("checkout", () => {
    it("puts the project back, without moving file content", async () => {
        const { repo, vfs, content } = { ...makeRepo(), content: null as never };
        await write(vfs, "/a.txt", "original");
        const first = await repo.commit("first");

        await write(vfs, "/a.txt", "changed");
        await write(vfs, "/extra.txt", "added later");
        await repo.commit("second");

        await repo.checkout(first);
        expect(await vfs.readText("/apps/demo/a.txt")).toBe("original");
        expect(await vfs.exists("/apps/demo/extra.txt")).toBe(false);
        void content;
    });

    it("restores a file that was deleted", async () => {
        const { repo, vfs } = makeRepo();
        await write(vfs, "/gone.txt", "still here");
        const first = await repo.commit("first");

        await vfs.delete("/apps/demo/gone.txt");
        await repo.commit("removed it");

        await repo.checkout(first);
        expect(await vfs.readText("/apps/demo/gone.txt")).toBe("still here");
    });

    it("keeps content readable after checking out past a delete", async () => {
        // The trap: removing a file from the working tree normally releases its
        // shards. History references the same manifest, so a checkout must not
        // free content a commit still needs.
        const { repo, vfs } = makeRepo();
        await write(vfs, "/a.txt", "keep me");
        const first = await repo.commit("first");

        await write(vfs, "/b.txt", "second file");
        const second = await repo.commit("second");

        await repo.checkout(first);    // drops b.txt from the working tree
        await repo.checkout(second);   // and brings it back
        expect(await vfs.readText("/apps/demo/b.txt")).toBe("second file");
    });

    it("restores nested directories", async () => {
        const { repo, vfs } = makeRepo();
        await write(vfs, "/src/deep/a.txt", "nested");
        const first = await repo.commit("first");
        await vfs.delete("/apps/demo/src", { recursive: true });
        await repo.commit("cleared");

        await repo.checkout(first);
        expect(await vfs.readText("/apps/demo/src/deep/a.txt")).toBe("nested");
    });

    it("turns a directory back into the file it replaced", async () => {
        // It deleted the files the commit lacks, leaving `thing/` empty but
        // there, and then could not write the file `thing`: the files were
        // gone, HEAD had not moved, and status reported them removed.
        const { repo, vfs } = makeRepo();
        await write(vfs, "/keep.txt", "k");
        await write(vfs, "/thing", "a file");
        const first = await repo.commit("thing is a file");
        await vfs.delete("/apps/demo/thing");
        await write(vfs, "/thing/inner.txt", "now a directory");
        await write(vfs, "/thing/sub/deeper.txt", "and deeper");
        const second = await repo.commit("thing is a directory");

        await repo.checkout(first);
        expect(await vfs.readText("/apps/demo/thing")).toBe("a file");
        expect(await vfs.walk("/apps/demo")).toEqual(["/apps/demo/keep.txt", "/apps/demo/thing"]);
        expect(await repo.status()).toEqual([]);
        // And back: the content the directory held is still there to restore.
        await repo.checkout(second);
        expect(await vfs.readText("/apps/demo/thing/sub/deeper.txt")).toBe("and deeper");
    });

    it("reads the working tree with read-ahead, not one directory at a time", async () => {
        // Asked to discard changes, a checkout has no status to read the tree
        // first, so in a fresh process nothing is cached. Checking every
        // directory it needs BEFORE walking the tree opened each record by
        // path, one round trip after another, and doubled the checkout.
        const { repo, vfs, store } = makeRepo();
        for (let d = 0; d < 40; d++) await write(vfs, `/d${d}/sub/f.txt`, `${d}`);
        const first = await repo.commit("first");
        await write(vfs, "/new.txt", "n");
        await repo.commit("second");
        vfs.clearCache();

        // Gets are answered in rounds, each once the checkout has asked for
        // all it will: a round is a round trip.
        const get = store.get.bind(store);
        let waiting: Array<{ key: string; answer: () => void }> = [];
        store.get = (key: string) =>
            new Promise((resolve) => waiting.push({ key, answer: () => resolve(get(key)) }));
        let done = false;
        const checkout = repo.checkout(first, { discardChanges: true }).finally(() => (done = true));
        let directoryRounds = 0;
        while (!done) {
            await new Promise((resolve) => setImmediate(resolve));
            const round = waiting;
            waiting = [];
            if (round.some(({ key }) => key.startsWith("vfs/d/"))) directoryRounds++;
            for (const { answer } of round) answer();
        }
        await checkout;
        store.get = get;
        expect(await vfs.exists("/apps/demo/new.txt")).toBe(false);
        // 83 directory records, five levels deep. One at a time was 80 rounds.
        expect(directoryRounds).toBeLessThanOrEqual(10);
    });
});

describe("log", () => {
    it("is empty in a fresh repository", async () => {
        const { repo } = makeRepo();
        expect(await repo.log()).toEqual([]);
        expect(await repo.current()).toBeNull();
    });

    it("respects the limit", async () => {
        const { repo, vfs } = makeRepo();
        for (let i = 0; i < 5; i++) {
            await write(vfs, "/a.txt", `v${i}`);
            await repo.commit(`commit ${i}`);
        }
        expect(await repo.log(3)).toHaveLength(3);
    });
});
