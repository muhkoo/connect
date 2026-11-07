/**
 * The `Share` object: a folder view over a share Space's file records, and the file operations on it, against a
 * fake server that applies the accelerator's real rules (uploader stamping, canChangeFile, share_full,
 * share_closed). Every caller is a signed-in account (a share "guest" is an ordinary member).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { HttpClient } from "../../src/core/HttpClient";
import { HttpError } from "../../src/core/HttpError";
import { _resetRsWasmForTests } from "../../src/storage/encoding/ReedSolomon/wasm/rs";
import { ShareFullError, ShareClosedError } from "../../src/shares";
import { Share } from "../../src/shares/Share";
import { FakeShareServer, realSpaceId, type FakeShareOptions } from "./fakeShareServer";

let rsWasmModule: WebAssembly.Module;
beforeAll(async () => {
    const wasmPath = join(__dirname, "..", "..", "src", "storage", "encoding", "ReedSolomon", "wasm", "wasm_reed_solomon_erasure_bg.wasm");
    rsWasmModule = await WebAssembly.compile(readFileSync(wasmPath));
    _resetRsWasmForTests();
});

const SPACE = realSpaceId("share_1"); // as long as a real Space id (256 characters)
function server(over: Partial<FakeShareOptions> = {}) {
    return new FakeShareServer({ spaceId: SPACE, kind: "public", ownerUsername: "ann", name: "Wedding", members: ["gus", "hal"], ...over });
}

function http(s: FakeShareServer, session: string | null) {
    return new HttpClient({ baseUrl: s.base, apiKey: "mk_test_pk_x", getSessionToken: () => session, fetch: s.fetch });
}

function asUser(s: FakeShareServer, username: string): Share {
    return new Share({ http: http(s, username), spaceId: SPACE, me: username, rsWasmModule });
}

const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);

describe("Share folder view", () => {
    it("builds nested folders from paths, with an empty dir record; dirs first, then by name", async () => {
        const s = server();
        const ann = asUser(s, "ann");
        await ann.write("a/b.jpg", bytes(10), { type: "image/jpeg" });
        await ann.write("a/c/d.jpg", bytes(20), { type: "image/jpeg" });
        await ann.write("top.txt", bytes(3));
        await ann.mkdir("empty");

        const root = await ann.list();
        expect(root.map((e) => [e.name, e.kind])).toEqual([
            ["a", "dir"],
            ["empty", "dir"],
            ["top.txt", "file"],
        ]);
        expect(root.find((e) => e.name === "empty")).toMatchObject({ path: "empty", size: 0 });

        const a = await ann.list("a");
        expect(a.map((e) => [e.path, e.kind])).toEqual([
            ["a/c", "dir"],
            ["a/b.jpg", "file"],
        ]);
        expect(a[1]).toMatchObject({ size: 10, uploader: "ann", uploaderName: "ann", canChange: true });

        expect((await ann.list("a/c")).map((e) => e.path)).toEqual(["a/c/d.jpg"]);
        expect(await ann.list("empty")).toEqual([]);

        // The empty dir is a zero-byte record typed inode/directory.
        const rec = [...s.files.values()].find((f) => f.manifest.path === "empty")!;
        expect(rec.manifest).toMatchObject({ size: 0, type: "inode/directory", name: "empty" });
    });

    it("reads back what was written", async () => {
        const s = server();
        const ann = asUser(s, "ann");
        const data = new Uint8Array(5000).map((_, i) => i % 251);
        await ann.write("docs/x.bin", data);
        expect(await ann.read("docs/x.bin")).toEqual(data);
        expect(await ann.read("/docs/x.bin")).toEqual(data);
    });

    it("a public-share member's canChange is true only on their own files; the owner's everywhere", async () => {
        const s = server();
        const ann = asUser(s, "ann");
        const gus = asUser(s, "gus");
        const hal = asUser(s, "hal");
        await ann.write("ann.jpg", bytes(4));
        await gus.write("gus.jpg", bytes(4));
        await hal.write("hal.jpg", bytes(4));
        s.seed({ id: "legacy", name: "old.jpg", size: 1, type: "image/jpeg", path: "old.jpg", lastModified: 1, createdAt: 1, chunks: [], version: 1 }, null);

        const byName = (es: Awaited<ReturnType<Share["list"]>>) => Object.fromEntries(es.map((e) => [e.name, e]));

        const asGus = byName(await gus.list());
        expect(asGus["gus.jpg"]).toMatchObject({ uploader: "gus", uploaderName: "gus", canChange: true });
        expect(asGus["hal.jpg"]).toMatchObject({ uploader: "hal", canChange: false });
        expect(asGus["ann.jpg"]).toMatchObject({ uploader: "ann", uploaderName: "ann", canChange: false });
        expect(asGus["old.jpg"]).toMatchObject({ uploader: "", uploaderName: "Unknown", canChange: true });

        const asAnn = byName(await ann.list());
        expect(Object.values(asAnn).every((e) => e.canChange)).toBe(true);
        expect(asAnn["hal.jpg"].uploaderName).toBe("hal");

        // A display name from `ShareInfo.names` labels the uploader; the username stays the identity.
        s.names = { hal: "Hal the Photographer" };
        const named = byName(await gus.list());
        expect(named["hal.jpg"]).toMatchObject({ uploader: "hal", uploaderName: "Hal the Photographer", canChange: false });
        expect(named["gus.jpg"].uploaderName).toBe("gus");

        // The server agrees: a member cannot delete someone else's file.
        await expect(gus.delete("hal.jpg")).rejects.toBeInstanceOf(HttpError);
        await gus.delete("gus.jpg");
        expect((await ann.list()).map((e) => e.name)).not.toContain("gus.jpg");
    });

    it("every request carries the key and the session; no guest header", async () => {
        const s = server();
        const gus = asUser(s, "gus");
        await gus.write("p.jpg", bytes(100));
        await gus.read("p.jpg");
        await gus.list();
        expect(s.calls.length).toBeGreaterThan(3);
        for (const c of s.calls) {
            expect(c.path === `/api/shares/${SPACE}` || c.path.startsWith(`/api/spaces/${SPACE}/`)).toBe(true);
            expect(c.headers.get("X-Muhkoo-Key")).toBe("mk_test_pk_x");
            expect(c.headers.get("X-Muhkoo-Session")).toBe("gus");
            expect(c.headers.get("X-Muhkoo-Guest")).toBeNull();
        }
        // Shards go to the Space's shard route, never the global store.
        expect(s.calls.some((c) => c.method === "PUT" && c.path.startsWith(`/api/spaces/${SPACE}/shards/`))).toBe(true);
    });

    it("a member's canChange follows editPolicy on a private share", async () => {
        for (const [policy, expected] of [["own", false], ["any", true]] as const) {
            const s = server({ kind: "private", editPolicy: policy, members: ["bob", "cat"] });
            await asUser(s, "cat").write("cat.txt", bytes(2));
            const [entry] = await asUser(s, "bob").list();
            expect(entry).toMatchObject({ uploader: "cat", canChange: expected });
        }
    });
});

describe("Share writes", () => {
    it("writeMany of 5 photos with room for 3 writes 3 and throws ShareFullError with refused 2", async () => {
        const s = server({ limitBytes: 3500 });
        const gus = asUser(s, "gus");
        const items = [1, 2, 3, 4, 5].map((i) => ({ path: `photos/${i}.jpg`, data: bytes(1000, i), type: "image/jpeg" }));
        const err = await gus.writeMany(items).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ShareFullError);
        expect(err).toMatchObject({ refused: 2, limitBytes: 3500, usedBytes: 3000 });
        expect((await gus.list("photos")).map((e) => e.name)).toEqual(["1.jpg", "2.jpg", "3.jpg"]);
        expect(await asUser(s, "ann").usage()).toEqual({ usedBytes: 3000, limitBytes: 3500 });
    });

    it("a share_full from a shard upload also counts the item as refused", async () => {
        const s = server({ limitBytes: 1500 });
        const ann = asUser(s, "ann");
        await ann.write("one.bin", bytes(1000));
        // used 1000; a 2000-byte file's shards push it past 1500 before its manifest is written.
        const err = await ann.writeMany([{ path: "two.bin", data: bytes(2000) }]).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ShareFullError);
        expect(err).toMatchObject({ refused: 1 });
    });

    it("writeMany returns every entry when all fit", async () => {
        const s = server();
        const entries = await asUser(s, "ann").writeMany([
            { path: "x/1.txt", data: bytes(1) },
            { path: "x/2.txt", data: new Blob([bytes(2)]) },
        ]);
        expect(entries.map((e) => [e.path, e.size, e.kind])).toEqual([["x/1.txt", 1, "file"], ["x/2.txt", 2, "file"]]);
    });

    it("write over an existing path replaces that record (same id, same uploader)", async () => {
        const s = server();
        const ann = asUser(s, "ann");
        await ann.write("f.txt", bytes(5));
        await ann.write("f.txt", bytes(9));
        expect(s.files.size).toBe(1);
        expect((await ann.list())[0]).toMatchObject({ size: 9 });
    });

    it("rename keeps the uploader and moves everything under a dir", async () => {
        const s = server();
        const gus = asUser(s, "gus");
        const ann = asUser(s, "ann");
        await gus.write("g.jpg", bytes(5));
        await ann.rename("g.jpg", "moved/h.jpg");
        const [e] = await ann.list("moved");
        expect(e).toMatchObject({ path: "moved/h.jpg", name: "h.jpg", uploader: "gus", uploaderName: "gus", canChange: true });
        expect(await ann.read("moved/h.jpg")).toEqual(bytes(5));

        await ann.mkdir("d/empty");
        await ann.write("d/x.txt", bytes(1));
        await ann.rename("d", "e");
        expect((await ann.list()).map((x) => x.name)).toEqual(["e", "moved"]);
        expect((await ann.list("e")).map((x) => x.path)).toEqual(["e/empty", "e/x.txt"]);
        expect(s.files.size).toBe(3);
    });

    it("deleting a dir removes every record under it", async () => {
        const s = server();
        const ann = asUser(s, "ann");
        await ann.write("a/b.jpg", bytes(1));
        await ann.write("a/c/d.jpg", bytes(1));
        await ann.mkdir("a/c/e");
        await ann.write("ab.txt", bytes(1)); // a sibling that merely shares the prefix "a"
        await ann.delete("a");
        expect([...s.files.values()].map((f) => f.manifest.path)).toEqual(["ab.txt"]);
        expect(s.usedBytes).toBe(1);
    });

    it("a 409 share_closed raises ShareClosedError with the successor", async () => {
        const s = server();
        const ann = asUser(s, "ann");
        await ann.write("a.txt", bytes(1));
        s.closed = { successor: "share_2", at: 1 };
        for (const op of [() => ann.write("b.txt", bytes(1)), () => ann.delete("a.txt"), () => ann.mkdir("z")]) {
            const err = await op().catch((e: unknown) => e);
            expect(err).toBeInstanceOf(ShareClosedError);
            expect((err as ShareClosedError).successor).toBe("share_2");
        }
        // Reads still work on a closed share.
        expect(await ann.read("a.txt")).toEqual(bytes(1));
    });

    it("rejects paths that escape or are empty", async () => {
        const ann = asUser(server(), "ann");
        for (const p of ["", "/", "a/../b", "./a", "a//b"]) {
            await expect(ann.write(p, bytes(1))).rejects.toThrow(/path/i);
        }
    });
});

const legacy = (id: string, path: string) => ({
    id, name: path.split("/").pop()!, size: 1, type: "text/plain", path, lastModified: 1, createdAt: 1, chunks: [], version: 1,
});
const paths = (s: FakeShareServer) => [...s.files.values()].map((f) => f.manifest.path as string).sort();

describe("Share review fixes", () => {
    it("refuses a path whose parent is a file, in write, writeMany, mkdir and rename", async () => {
        const s = server();
        const ann = asUser(s, "ann");
        await ann.write("b.txt", bytes(1));
        await ann.write("x.txt", bytes(1));
        await expect(ann.write("b.txt/c", bytes(1))).rejects.toThrow(/b\.txt is a file/);
        await expect(ann.writeMany([{ path: "b.txt/c/d", data: bytes(1) }])).rejects.toThrow(/b\.txt is a file/);
        await expect(ann.mkdir("b.txt/d")).rejects.toThrow(/b\.txt is a file/);
        await expect(ann.rename("x.txt", "b.txt/x.txt")).rejects.toThrow(/b\.txt is a file/);
        expect(paths(s)).toEqual(["b.txt", "x.txt"]);
        expect((await ann.list()).map((e) => e.name)).toEqual(["b.txt", "x.txt"]);
    });

    it("refuses a folder rename or delete up front when any record under it is someone else's; nothing changes", async () => {
        const s = server();
        await asUser(s, "gus").write("d/g.txt", bytes(1));
        await asUser(s, "hal").write("d/h.txt", bytes(1));
        const gus = asUser(s, "gus");
        const before = s.calls.length;
        await expect(gus.rename("d", "e")).rejects.toThrow(/d\/h\.txt/);
        await expect(gus.delete("d")).rejects.toThrow(/d\/h\.txt/);
        expect(s.calls.slice(before).filter((c) => c.method !== "GET")).toEqual([]);
        expect(paths(s)).toEqual(["d/g.txt", "d/h.txt"]);
    });

    it("a rename that fails part-way names what moved, and the same rename again finishes it", async () => {
        const s = server();
        const ann = asUser(s, "ann");
        for (const n of [1, 2, 3]) await ann.write(`d/${n}.txt`, bytes(n));
        let posts = 0;
        s.failWhen = (method, path) => method === "POST" && path.endsWith("/files") && ++posts === 2;
        const err = await ann.rename("d", "e").catch((e: unknown) => e as Error);
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toMatch(/already moved: e\/1\.txt/);
        expect(paths(s)).toEqual(["d/2.txt", "d/3.txt", "e/1.txt"]);

        s.failWhen = null;
        await asUser(s, "ann").rename("d", "e"); // a fresh Share for the same share resumes too
        expect(paths(s)).toEqual(["e/1.txt", "e/2.txt", "e/3.txt"]);
        expect(await ann.read("e/3.txt")).toEqual(bytes(3));
    });

    it("a rename onto a folder holding files it did not move is refused", async () => {
        const s = server();
        const ann = asUser(s, "ann");
        await ann.write("d/1.txt", bytes(1));
        await ann.write("e/other.txt", bytes(1));
        await expect(ann.rename("d", "e")).rejects.toThrow(/e already exists/);
        expect(paths(s)).toEqual(["d/1.txt", "e/other.txt"]);
    });

    it("an overwrite the caller may not make is refused before any shard is uploaded", async () => {
        const s = server();
        await asUser(s, "gus").write("g.jpg", bytes(10));
        const before = s.calls.length;
        await expect(asUser(s, "hal").write("g.jpg", bytes(10))).rejects.toMatchObject({ status: 403 });
        expect(s.calls.slice(before).some((c) => c.method === "PUT")).toBe(false);
    });

    it("a legacy file with no uploader is claimed by its first writer, and by a renamer", async () => {
        const s = server();
        s.seed(legacy("l1", "old1.txt"), null);
        s.seed(legacy("l2", "old2.txt"), null);
        const gus = asUser(s, "gus");
        const entry = await gus.write("old1.txt", bytes(2));
        expect(entry).toMatchObject({ uploader: "gus", canChange: true });
        expect(s.files.get("l1")!.owner).toBe("gus");
        expect((await asUser(s, "hal").list()).find((e) => e.name === "old1.txt")).toMatchObject({ uploader: "gus", canChange: false });

        await asUser(s, "ann").rename("old2.txt", "new2.txt");
        expect(s.files.get("l2")!.owner).toBe("ann");
    });
});
