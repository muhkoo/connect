/**
 * VFS link entries and the `/Home/Shared` mount.
 *
 * Shares are the real `Share` class against the fake accelerator the share tests use, so a path under
 * `/Home/Shared` or under a link exercises the same requests a signed-in member would make. The personal tree is
 * the usual in-memory sealed store.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { HttpClient } from "../../src/core/HttpClient";
import { HttpError } from "../../src/core/HttpError";
import { _resetRsWasmForTests } from "../../src/storage/encoding/ReedSolomon/wasm/rs";
import { Share } from "../../src/shares/Share";
import type { ShareSummary } from "../../src/shares";
import { VfsNamespace } from "../../src/vfs/VfsNamespace";
import { VfsConflictError, VfsNotFoundError } from "../../src/vfs/types";
import { shareNames } from "../../src/vfs/sharesMount";
import { Repo } from "../../src/vcs/VcsNamespace";
import { VcsError, objectKey } from "../../src/vcs/types";
import { unseal } from "../../src/vfs/recordCipher";
import { makeContent, makeStore } from "./harness";
import { FakeShareServer, realSpaceId } from "../shares/fakeShareServer";

let rsWasmModule: WebAssembly.Module;
beforeAll(async () => {
    const wasmPath = join(__dirname, "..", "..", "src", "storage", "encoding", "ReedSolomon", "wasm", "wasm_reed_solomon_erasure_bg.wasm");
    rsWasmModule = await WebAssembly.compile(readFileSync(wasmPath));
    _resetRsWasmForTests();
});

const ME = "ann";
/** Share ids the length the SDK makes them (256 characters), so a cap on ids cannot hide behind short fixtures. */
const PARTY = realSpaceId("space_party");
const PARTY2 = realSpaceId("space_party2");
const OTHER = realSpaceId("space_other");
const GONE = realSpaceId("space_gone");
const TRIP = realSpaceId("space_trip");

interface FakeShares {
    servers: Map<string, FakeShareServer>;
    summaries: ShareSummary[];
    add(spaceId: string, name: string, owner?: string): FakeShareServer;
    opened: string[];
    /** How many opens still hand back the Space asked for even if it is closed (a rotation racing the open). */
    staleOpens: number;
}

function fakeShares(): FakeShares {
    const servers = new Map<string, FakeShareServer>();
    const summaries: ShareSummary[] = [];
    return {
        servers,
        summaries,
        opened: [],
        staleOpens: 0,
        add(spaceId, name, owner = ME) {
            const s = new FakeShareServer({ spaceId, kind: "private", ownerUsername: owner, name, members: [ME] });
            servers.set(spaceId, s);
            summaries.push({ spaceId, kind: "private", owner, name });
            return s;
        },
    };
}

function shareFor(s: FakeShareServer): Share {
    const http = new HttpClient({ baseUrl: s.base, apiKey: "mk_test_pk_x", getSessionToken: () => ME, fetch: s.fetch });
    return new Share({ http, spaceId: s.spaceId, me: ME, rsWasmModule });
}

function makeLinkedVfs(shares: FakeShares | null = fakeShares()) {
    const store = makeStore();
    const content = makeContent();
    const vfs = new VfsNamespace({
        store,
        content,
        seed: () => new Uint8Array(32).fill(7),
        shares: shares
            ? {
                list: async () => [...shares.summaries],
                open: async (spaceId) => {
                    shares.opened.push(spaceId);
                    // As `client.shares.open` does: follow a closed Space to its successor.
                    let s = shares.servers.get(spaceId);
                    if (shares.staleOpens > 0) shares.staleOpens--;
                    else while (s?.closed) s = shares.servers.get(s.closed.successor);
                    if (!s) throw new HttpError("not a member", 403, { error: "not a member" });
                    return shareFor(s);
                },
                me: () => ME,
            }
            : undefined,
    });
    return { vfs, store, content, shares };
}

const text = (b: Uint8Array) => new TextDecoder().decode(b);
const bytes = (s: string) => new TextEncoder().encode(s);

describe("link entries", () => {
    it("lists a link as kind 'link' with its target, and resolves paths under it into the share", async () => {
        const { vfs, shares } = makeLinkedVfs();
        const party = shares!.add(PARTY, "Party");
        await shareFor(party).write("photos/a.jpg", bytes("A"));
        await vfs.mkdir("/Photos");
        await vfs.writeFile("/Photos/mine.txt", "mine");
        await vfs.link("/Photos/Halloween", PARTY);

        const listed = await vfs.list("/Photos");
        expect(listed.map((s) => [s.name, s.kind])).toEqual([["Halloween", "link"], ["mine.txt", "file"]]);
        expect(listed[0].target).toEqual({ spaceId: PARTY });
        expect(await vfs.stat("/Photos/Halloween")).toMatchObject({ kind: "link", target: { spaceId: PARTY } });
        expect(await vfs.readLink("/Photos/Halloween")).toEqual({ spaceId: PARTY });

        // Through the link: the share's own tree.
        expect((await vfs.list("/Photos/Halloween")).map((s) => [s.path, s.kind])).toEqual([["/Photos/Halloween/photos", "dir"]]);
        expect(text(await vfs.readFile("/Photos/Halloween/photos/a.jpg"))).toBe("A");
        await vfs.writeFile("/Photos/Halloween/photos/b.txt", "B");
        expect(text(await shareFor(party).read("photos/b.txt"))).toBe("B");
        expect(await vfs.stat("/Photos/Halloween/photos/b.txt")).toMatchObject({ kind: "file", size: 1, path: "/Photos/Halloween/photos/b.txt" });
        expect(await vfs.exists("/Photos/Halloween/photos/nope")).toBe(false);
        await expect(vfs.stat("/Photos/Halloween/nope")).rejects.toBeInstanceOf(VfsNotFoundError);
    });

    it("refuses writeFile and writeManifest over a link's name, and leaves the link alone", async () => {
        const { vfs, shares } = makeLinkedVfs();
        shares!.add(PARTY, "Party");
        await vfs.link("/Party", PARTY);
        await expect(vfs.writeFile("/Party", "clobber")).rejects.toBeInstanceOf(VfsConflictError);
        const { manifest, size } = await vfs.writeFile("/x.txt", "x").then(() => vfs.statManifest("/x.txt"));
        await expect(vfs.writeManifest("/Party", manifest, size)).rejects.toBeInstanceOf(VfsConflictError);
        expect(await vfs.readLink("/Party")).toEqual({ spaceId: PARTY });
    });

    it("refuses writeFile over a link even with no shares wired (a bare VFS)", async () => {
        const { vfs } = makeLinkedVfs(null);
        await vfs.link("/Party", PARTY);
        await expect(vfs.writeFile("/Party", "clobber")).rejects.toBeInstanceOf(VfsConflictError);
        await expect(vfs.mkdir("/Party")).rejects.toBeInstanceOf(VfsConflictError);
        expect((await vfs.list("/")).map((s) => s.kind)).toEqual(["link"]);
    });

    it("refuses a link at a name that exists, and at /Home/Shared", async () => {
        const { vfs } = makeLinkedVfs();
        await vfs.writeFile("/taken", "x");
        await expect(vfs.link("/taken", PARTY)).rejects.toBeInstanceOf(VfsConflictError);
        await vfs.link("/Party", PARTY);
        await expect(vfs.link("/Party", OTHER)).rejects.toBeInstanceOf(VfsConflictError);
        await expect(vfs.link("/Home/Shared", PARTY)).rejects.toBeInstanceOf(VfsConflictError);
        await expect(vfs.link("/bad", "not a space id!")).rejects.toThrow();
        await expect(vfs.readLink("/taken")).rejects.toBeInstanceOf(VfsConflictError);
    });

    it("takes any id the server's share routes take: a real 256-char Space id, up to 300 characters; not ':', '/' or longer", async () => {
        const { vfs } = makeLinkedVfs();
        expect(PARTY).toHaveLength(256);
        await vfs.link("/Real", PARTY);
        expect(await vfs.readLink("/Real")).toEqual({ spaceId: PARTY });
        await vfs.link("/Longest", "A".repeat(300));
        expect(await vfs.readLink("/Longest")).toEqual({ spaceId: "A".repeat(300) });
        for (const bad of ["A".repeat(301), `${PARTY.slice(0, 100)}:x`, `${PARTY.slice(0, 100)}/x`]) {
            await expect(vfs.link("/Bad", bad), bad).rejects.toThrow(/not a share id/);
        }
    });

    it("walkEntries reports a link and does not descend into it; walk under /Home/Shared/<name> does", async () => {
        const { vfs, shares } = makeLinkedVfs();
        const party = shares!.add(PARTY, "Party");
        await shareFor(party).write("a/b.txt", bytes("b"));
        await vfs.writeFile("/docs/readme.md", "hi");
        await vfs.link("/docs/Party", PARTY);

        const entries = await vfs.walkEntries("/");
        expect(entries.map((e) => [e.path, e.kind])).toEqual([
            ["/docs", "dir"],
            ["/docs/Party", "link"],
            ["/docs/readme.md", "file"],
        ]);
        expect(await vfs.walk("/")).toEqual(["/docs/readme.md"]);
        // Nothing was asked of the share by the walk of the personal tree.
        expect(shares!.opened).toEqual([]);

        expect(await vfs.walk("/Home/Shared/Party")).toEqual(["/Home/Shared/Party/a/b.txt"]);
        expect((await vfs.walkEntries("/docs/Party")).map((e) => [e.path, e.kind])).toEqual([
            ["/docs/Party/a", "dir"],
            ["/docs/Party/a/b.txt", "file"],
        ]);
    });

    it("deleting a link removes only the link; the share's files stay", async () => {
        const { vfs, shares } = makeLinkedVfs();
        const party = shares!.add(PARTY, "Party");
        await shareFor(party).write("keep.txt", bytes("k"));
        await vfs.link("/Party", PARTY);
        await vfs.delete("/Party");
        expect(await vfs.exists("/Party")).toBe(false);
        expect(text(await shareFor(party).read("keep.txt"))).toBe("k");

        // And inside a folder deleted recursively.
        await vfs.mkdir("/box");
        await vfs.writeFile("/box/f.txt", "f");
        await vfs.link("/box/Party", PARTY);
        await vfs.delete("/box", { recursive: true });
        expect(await vfs.exists("/box")).toBe(false);
        expect(text(await shareFor(party).read("keep.txt"))).toBe("k");
    });

    it("moves and copies a link as an entry; the copy points at the same share", async () => {
        const { vfs } = makeLinkedVfs();
        await vfs.mkdir("/a");
        await vfs.mkdir("/b");
        await vfs.link("/a/Party", PARTY);
        await vfs.rename("/a/Party", "/b/Party");
        expect(await vfs.exists("/a/Party")).toBe(false);
        const moved = await vfs.stat("/b/Party");
        expect(moved).toMatchObject({ kind: "link", target: { spaceId: PARTY } });
        await vfs.copy("/b", "/c");
        expect(await vfs.readLink("/c/Party")).toEqual({ spaceId: PARTY });
        // The move mark is gone: the record holds a plain link.
        expect((await vfs.list("/b"))[0].kind).toBe("link");
    });

    it("refuses to move or copy across a share boundary", async () => {
        const { vfs, shares } = makeLinkedVfs();
        const party = shares!.add(PARTY, "Party");
        shares!.add(OTHER, "Other");
        await shareFor(party).write("in.txt", bytes("i"));
        await vfs.writeFile("/mine.txt", "m");
        await vfs.link("/Party", PARTY);

        const boundary = /move across a share boundary/;
        await expect(vfs.rename("/mine.txt", "/Party/mine.txt")).rejects.toThrow(boundary);
        await expect(vfs.rename("/Party/in.txt", "/in.txt")).rejects.toThrow(boundary);
        await expect(vfs.copy("/Party/in.txt", "/in.txt")).rejects.toThrow(boundary);
        await expect(vfs.copy("/mine.txt", "/Home/Shared/Party/mine.txt")).rejects.toThrow(boundary);
        await expect(vfs.rename("/Home/Shared/Party/in.txt", "/Home/Shared/Other/in.txt")).rejects.toThrow(boundary);
        await expect(vfs.rename("/mine.txt", "/Home/Shared/x")).rejects.toBeInstanceOf(VfsConflictError);
        // Nothing moved.
        expect(text(await vfs.readFile("/mine.txt"))).toBe("m");
        expect(text(await shareFor(party).read("in.txt"))).toBe("i");

        // Within one share it works, by either route.
        await vfs.rename("/Party/in.txt", "/Home/Shared/Party/moved.txt");
        expect(text(await vfs.readFile("/Party/moved.txt"))).toBe("i");
        await vfs.copy("/Party/moved.txt", "/Party/copy.txt");
        expect(text(await shareFor(party).read("copy.txt"))).toBe("i");
    });

    it("mkdir and delete inside a share go to the share", async () => {
        const { vfs, shares } = makeLinkedVfs();
        const party = shares!.add(PARTY, "Party");
        await vfs.mkdir("/Home/Shared/Party/new");
        expect((await shareFor(party).list()).map((e) => [e.name, e.kind])).toEqual([["new", "dir"]]);
        await expect(vfs.mkdir("/Home/Shared/Party/new")).rejects.toBeInstanceOf(VfsConflictError);
        await vfs.writeFile("/Home/Shared/Party/new/f.txt", "f");
        await expect(vfs.delete("/Home/Shared/Party/new")).rejects.toBeInstanceOf(VfsConflictError);
        await vfs.delete("/Home/Shared/Party/new", { recursive: true });
        expect(await shareFor(party).list()).toEqual([]);
        // The share itself is not deleted through the VFS.
        await expect(vfs.delete("/Home/Shared/Party", { recursive: true })).rejects.toBeInstanceOf(VfsConflictError);
    });

    it("sweep neither refuses nor removes anything because of a link", async () => {
        const { vfs, store } = makeLinkedVfs();
        await vfs.writeFile("/a/f.txt", "f");
        await vfs.link("/a/Party", PARTY);
        const before = [...store.records.keys()].sort();
        expect(await vfs.sweep()).toEqual({ removed: [] });
        expect([...store.records.keys()].sort()).toEqual(before);
    });

    it("a link to a share the user is not a member of reads as not found", async () => {
        const { vfs } = makeLinkedVfs();
        await vfs.link("/Gone", GONE);
        await expect(vfs.list("/Gone")).rejects.toBeInstanceOf(VfsNotFoundError);
        await expect(vfs.stat("/Gone/x")).rejects.toBeInstanceOf(VfsNotFoundError);
        expect(await vfs.exists("/Gone/x")).toBe(false);
        // The link itself is still there.
        expect(await vfs.readLink("/Gone")).toEqual({ spaceId: GONE });
    });
});

describe("/Home and /Home/Shared", () => {
    it("/Home lists a virtual Shared beside the user's real /Home entries", async () => {
        const { vfs } = makeLinkedVfs();
        expect((await vfs.list("/Home")).map((s) => [s.path, s.kind])).toEqual([["/Home/Shared", "dir"]]);
        expect(await vfs.stat("/Home")).toMatchObject({ kind: "dir", path: "/Home" });
        expect(await vfs.exists("/Home/Shared")).toBe(true);

        await vfs.writeFile("/Home/notes.txt", "n");
        await vfs.mkdir("/Home/Music");
        expect((await vfs.list("/Home")).map((s) => [s.name, s.kind])).toEqual([
            ["Music", "dir"],
            ["Shared", "dir"],
            ["notes.txt", "file"],
        ]);
    });

    it("shows a real /Home/Shared as 'Shared (yours)', reachable by that name", async () => {
        // A user's own folder that happens to be called Shared, made by a VFS with no shares wired.
        const { vfs, store, content } = makeLinkedVfs(null);
        await vfs.writeFile("/Home/Shared/old.txt", "old");
        // The same tree, with shares.
        const both = new VfsNamespace({
            store,
            content,
            seed: () => new Uint8Array(32).fill(7),
            shares: { list: async () => [], open: async () => { throw new HttpError("no", 403); } },
        });
        expect((await both.list("/Home")).map((s) => [s.path, s.name])).toEqual([
            ["/Home/Shared", "Shared"],
            ["/Home/Shared (yours)", "Shared (yours)"],
        ]);
        expect(text(await both.readFile("/Home/Shared (yours)/old.txt"))).toBe("old");
        expect(await both.walk("/")).toEqual(["/Home/Shared (yours)/old.txt"]);
        await both.writeFile("/Home/Shared (yours)/new.txt", "new");
        // Written into the user's own folder: the VFS without shares sees it at its real path.
        vfs.clearCache();
        expect(text(await vfs.readFile("/Home/Shared/new.txt"))).toBe("new");
        // And the virtual Shared was not touched by any of it.
        expect((await both.list("/Home/Shared")).length).toBe(0);
    });

    it("refuses to create /Home/Shared itself", async () => {
        const { vfs } = makeLinkedVfs();
        await expect(vfs.mkdir("/Home/Shared")).rejects.toBeInstanceOf(VfsConflictError);
        await expect(vfs.writeFile("/Home/Shared", "x")).rejects.toBeInstanceOf(VfsConflictError);
        await expect(vfs.delete("/Home/Shared", { recursive: true })).rejects.toBeInstanceOf(VfsConflictError);
        // Nor a file or a link where the Home folder goes.
        await expect(vfs.writeFile("/Home", "x")).rejects.toBeInstanceOf(VfsConflictError);
        await expect(vfs.link("/Home", PARTY)).rejects.toBeInstanceOf(VfsConflictError);
        const { manifest, size } = await vfs.writeFile("/m.txt", "m").then(() => vfs.statManifest("/m.txt"));
        await expect(vfs.writeManifest("/Home", manifest, size)).rejects.toBeInstanceOf(VfsConflictError);
        await expect(vfs.rename("/m.txt", "/Home")).rejects.toBeInstanceOf(VfsConflictError);
        expect((await vfs.stat("/Home")).kind).toBe("dir");
    });

    it("lists shares by name; same-named ones get the owner, then a number", async () => {
        const { vfs, shares } = makeLinkedVfs();
        shares!.add(realSpaceId("s1"), "Party", "ann");
        shares!.add(realSpaceId("s2"), "Party", "bob");
        shares!.add(realSpaceId("s3"), "Party", "bob");
        shares!.add(realSpaceId("s4"), "Trip", "cat");
        expect((await vfs.list("/Home/Shared")).map((s) => [s.name, s.kind])).toEqual([
            ["Party", "dir"],
            ["Party (2)", "dir"],
            ["Party (bob)", "dir"],
            ["Trip", "dir"],
        ]);
        await shareFor(shares!.servers.get(realSpaceId("s2"))!).write("bob.txt", bytes("bob"));
        expect(text(await vfs.readFile("/Home/Shared/Party (bob)/bob.txt"))).toBe("bob");
        expect(await vfs.list("/Home/Shared/Party")).toEqual([]);
    });
});

describe("fix round 1", () => {
    it("names follow owner and name, not the server's order, so rotating a share does not swap names", async () => {
        const { vfs, shares } = makeLinkedVfs();
        // The server lists by Space id; bob's sorts first.
        shares!.add(realSpaceId("a_bob"), "Party", "bob");
        shares!.add(realSpaceId("m_ann"), "Party", ME);
        await shareFor(shares!.servers.get(realSpaceId("m_ann"))!).write("ann.txt", bytes("ann"));
        await shareFor(shares!.servers.get(realSpaceId("a_bob"))!).write("bob.txt", bytes("bob"));
        expect((await vfs.list("/Home/Shared")).map((s) => s.name)).toEqual(["Party", "Party (bob)"]);
        expect(text(await vfs.readFile("/Home/Shared/Party/ann.txt"))).toBe("ann");

        // Ann's share is rotated: a new Space id that now sorts before bob's, listed first by the server.
        const rotated = shares!.add(realSpaceId("0_ann"), "Party", ME);
        await shareFor(rotated).write("ann.txt", bytes("ann2"));
        shares!.summaries.splice(0, shares!.summaries.length, shares!.summaries[2], shares!.summaries[0]);
        expect((await vfs.list("/Home/Shared")).map((s) => s.name)).toEqual(["Party", "Party (bob)"]);
        expect(text(await vfs.readFile("/Home/Shared/Party/ann.txt"))).toBe("ann2");
        expect(text(await vfs.readFile("/Home/Shared/Party (bob)/bob.txt"))).toBe("bob");
    });

    it("orders other people's same-named shares by owner, whatever their Space ids", () => {
        const before = shareNames([
            { spaceId: realSpaceId("s1"), kind: "private", owner: "cat", name: "Trip" },
            { spaceId: realSpaceId("s2"), kind: "private", owner: "bob", name: "Trip" },
        ], ME);
        const after = shareNames([
            { spaceId: realSpaceId("s0"), kind: "private", owner: "cat", name: "Trip" },
            { spaceId: realSpaceId("s9"), kind: "private", owner: "bob", name: "Trip" },
        ], ME);
        const owners = (all: ReturnType<typeof shareNames>) => all.map(({ name, share }) => [name, share.owner]);
        expect(owners(before)).toEqual([["Trip", "bob"], ["Trip (cat)", "cat"]]);
        expect(owners(after)).toEqual(owners(before));
    });

    it("eachEntry refuses a share, a link and /Home/Shared; walk and walkEntries still walk them", async () => {
        const { vfs, shares } = makeLinkedVfs();
        const party = shares!.add(PARTY, "Party");
        await shareFor(party).write("a.txt", bytes("a"));
        await vfs.link("/Party", PARTY);
        for (const path of ["/Home/Shared/Party", "/Home/Shared", "/Party", "/Party/sub"]) {
            await expect(vfs.eachEntry(path, () => {}), path).rejects.toBeInstanceOf(VfsConflictError);
        }
        expect(await vfs.walk("/Party")).toEqual(["/Party/a.txt"]);
        expect((await vfs.walkEntries("/Home/Shared")).map((e) => e.path)).toEqual(["/Home/Shared/Party", "/Home/Shared/Party/a.txt"]);
        // The user's own tree still walks with manifests, and a link in it is visited without one.
        await vfs.writeFile("/f.txt", "f");
        const seen: Array<[string, boolean]> = [];
        await vfs.eachEntry("/", (stat, manifest) => void seen.push([stat.path, manifest !== null]));
        expect(seen).toEqual([["/Party", false], ["/f.txt", true]]);
    });

    it("refuses writes under /Home/Shared/<X> when the user's own /Home/Shared has <X>; reads go to the share", async () => {
        const { vfs, store, content } = makeLinkedVfs(null);
        await vfs.writeFile("/Home/Shared/Party/mine.txt", "mine");
        const shares = fakeShares();
        const party = shares.add(PARTY, "Party");
        shares.add(TRIP, "Trip");
        await shareFor(party).write("theirs.txt", bytes("theirs"));
        const wired = new VfsNamespace({
            store, content, seed: () => new Uint8Array(32).fill(7),
            shares: { list: async () => shares.summaries, open: async (id) => shareFor(shares.servers.get(id)!), me: () => ME },
        });
        const yours = /\/Home\/Shared \(yours\)\/Party/;
        await expect(wired.writeFile("/Home/Shared/Party/mine.txt", "x")).rejects.toThrow(yours);
        await expect(wired.delete("/Home/Shared/Party/theirs.txt")).rejects.toThrow(yours);
        await expect(wired.mkdir("/Home/Shared/Party/d")).rejects.toThrow(yours);
        await expect(wired.rename("/Home/Shared/Party/theirs.txt", "/Home/Shared/Party/t2.txt")).rejects.toThrow(yours);
        await expect(wired.copy("/Home/Shared/Trip/none", "/Home/Shared/Party/x")).rejects.toThrow(yours);
        await expect(wired.rename("/Home/Shared (yours)/Party/mine.txt", "/Home/Shared/Party/mine.txt")).rejects.toThrow(yours);
        // Reads still reach the share; the user's own folder is under its new name.
        expect(text(await wired.readFile("/Home/Shared/Party/theirs.txt"))).toBe("theirs");
        expect(text(await wired.readFile("/Home/Shared (yours)/Party/mine.txt"))).toBe("mine");
        expect((await shareFor(party).list()).map((e) => e.name)).toEqual(["theirs.txt"]);
        // A share whose name the user's folder does not hold is written as usual.
        await wired.writeFile("/Home/Shared/Trip/t.txt", "t");
        expect(text(await shareFor(shares.servers.get(TRIP)!).read("t.txt"))).toBe("t");
    });
});

describe("version control and shares", () => {
    const KEY = new Uint8Array(32).fill(3);
    function repoOver(vfs: VfsNamespace, store: ReturnType<typeof makeStore>) {
        return new Repo("demo", { vfs, store, key: async () => KEY, author: () => "tester" });
    }

    it("refuses a project that is a link, or inside one", async () => {
        for (const linkAt of ["/apps/demo", "/apps"]) {
            const { vfs, store, shares } = makeLinkedVfs();
            const party = shares!.add(PARTY, "Party");
            await shareFor(party).write("a.txt", bytes("a"));
            await vfs.link(linkAt, PARTY);
            const repo = repoOver(vfs, store);
            await expect(repo.commit("x"), linkAt).rejects.toBeInstanceOf(VcsError);
            await expect(repo.status(), linkAt).rejects.toBeInstanceOf(VcsError);
            await expect(repo.checkout("0".repeat(64), { discardChanges: true }), linkAt).rejects.toBeInstanceOf(VcsError);
            // The share's files are untouched.
            expect(text(await shareFor(party).read("a.txt"))).toBe("a");
        }
    });

    it("commits a project holding a link without a tree for the link, and a checkout leaves the link alone", async () => {
        const { vfs, store } = makeLinkedVfs();
        await vfs.writeFile("/apps/demo/a.txt", "a");
        await vfs.link("/apps/demo/Party", PARTY);
        const repo = repoOver(vfs, store);
        const hash = await repo.commit("with a link");
        const commit = await unseal<{ tree: string }>(KEY, await store.get(objectKey("demo", hash)));
        const tree = await unseal<{ entries: Record<string, unknown> }>(KEY, await store.get(objectKey("demo", commit.tree)));
        expect(Object.keys(tree.entries)).toEqual(["a.txt"]);
        expect(await repo.status()).toEqual([]);
        await vfs.writeFile("/apps/demo/a.txt", "changed");
        await repo.checkout(hash, { discardChanges: true });
        expect(await vfs.readText("/apps/demo/a.txt")).toBe("a");
        expect(await vfs.readLink("/apps/demo/Party")).toEqual({ spaceId: PARTY });
    });
});

/**
 * What the server's adopt does to a share: a new Space with the same file records (same ids) and shards, the old
 * one closed with the new one as its successor, and the share listed under the new Space id.
 */
function rotate(shares: FakeShares, from: string, to: string): FakeShareServer {
    const old = shares.servers.get(from)!;
    const next = new FakeShareServer({ spaceId: to, kind: old.kind, ownerUsername: old.ownerUsername, name: old.name, members: [...old.members] });
    for (const [id, f] of old.files) next.files.set(id, { manifest: { ...f.manifest }, owner: f.owner });
    for (const [h, b] of old.shards) next.shards.set(h, b);
    next.usedBytes = old.usedBytes;
    shares.servers.set(to, next);
    old.closed = { successor: to, at: Date.now() };
    const summary = shares.summaries.find((x) => x.spaceId === from)!;
    summary.spaceId = to;
    return next;
}

describe("a share rotated while the VFS has it open (final review I-1)", () => {
    it("a write through a link that is refused as closed reopens the share and lands in its successor", async () => {
        const { vfs, shares } = makeLinkedVfs();
        const party = shares!.add(PARTY, "Party");
        await shareFor(party).write("a.txt", bytes("A"));
        await vfs.link("/Party", PARTY);
        expect(text(await vfs.readFile("/Party/a.txt"))).toBe("A"); // opened and kept

        const next = rotate(shares!, PARTY, PARTY2);
        await vfs.writeFile("/Party/b.txt", "B");

        expect(text(await shareFor(next).read("b.txt"))).toBe("B");
        expect([...party.files.values()].map((f) => f.manifest.path)).toEqual(["a.txt"]);
        // And reads now come from the successor too: a file only it has.
        await shareFor(next).write("c.txt", bytes("C"));
        expect((await vfs.list("/Party")).map((s) => s.name)).toEqual(["a.txt", "b.txt", "c.txt"]);
        expect(text(await vfs.readFile("/Party/c.txt"))).toBe("C");
    });

    it("reads of a share kept open are checked again after a while, so a rotation elsewhere is noticed", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
            const { vfs, shares } = makeLinkedVfs();
            const party = shares!.add(PARTY, "Party");
            await shareFor(party).write("a.txt", bytes("A"));
            await vfs.link("/Party", PARTY);
            expect((await vfs.list("/Party")).map((s) => s.name)).toEqual(["a.txt"]);

            const next = rotate(shares!, PARTY, PARTY2);
            await shareFor(next).write("new.txt", bytes("N"));
            vi.setSystemTime(Date.now() + 31_000);

            expect((await vfs.list("/Party")).map((s) => s.name)).toEqual(["a.txt", "new.txt"]);
            expect(text(await vfs.readFile("/Party/new.txt"))).toBe("N");
        } finally {
            vi.useRealTimers();
        }
    });

    it("a share found closed when it is opened is never served", async () => {
        const { vfs, shares } = makeLinkedVfs();
        shares!.add(PARTY, "Party");
        await vfs.link("/Party", PARTY);
        const next = rotate(shares!, PARTY, PARTY2);
        await shareFor(next).write("only-new.txt", bytes("N"));
        // The source hands back the old, closed Space once (a rotation between its lookup and the open).
        shares!.staleOpens = 1;
        expect((await vfs.list("/Party")).map((s) => s.name)).toEqual(["only-new.txt"]);
        expect(shares!.opened).toEqual([PARTY, PARTY]);
    });

    it("/Home/Shared/<name> reaches the successor after a rotation, with no reload", async () => {
        const { vfs, shares } = makeLinkedVfs();
        const party = shares!.add(PARTY, "Party");
        await shareFor(party).write("a.txt", bytes("A"));
        expect(text(await vfs.readFile("/Home/Shared/Party/a.txt"))).toBe("A");

        const next = rotate(shares!, PARTY, PARTY2);
        await vfs.writeFile("/Home/Shared/Party/b.txt", "B");
        expect(text(await shareFor(next).read("b.txt"))).toBe("B");
        await vfs.delete("/Home/Shared/Party/a.txt");
        expect([...next.files.values()].map((f) => f.manifest.path)).toEqual(["b.txt"]);
    });
});
