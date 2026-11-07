/**
 * `client.shares.shareFolder`: turn a folder of the user's own into a share, moving its files without uploading a
 * byte, and replacing the folder with a link to the share.
 *
 * The personal tree is a real `VfsNamespace` over the sealed in-memory store. Personal content is real: files are
 * sharded with `FileStorage` into a global shard map (the accelerator's `SHARDS` bucket, which `/api/shards` and
 * every Space's shard route both use), and the content store counts writes, retains and releases. Shares are the
 * real `SharesNamespace` and `Share` against `FakeShareServer` (one per share), created through `POST /api/shares`.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { HttpClient } from "../../src/core/HttpClient";
import { _resetRsWasmForTests } from "../../src/storage/encoding/ReedSolomon/wasm/rs";
import { FileStorage } from "../../src/storage/FileStorage";
import { ShardClient } from "../../src/storage/transport/ShardClient";
import type { FileManifest } from "../../src/storage/types";
import { SharesNamespace, memorySharesStore, type ShareGuestAuth, type ShareSpaceHandle } from "../../src/core/namespaces/SharesNamespace";
import { ShareFullError } from "../../src/shares";
import { Share } from "../../src/shares/Share";
import { VfsNamespace, type VfsContentStore } from "../../src/vfs/VfsNamespace";
import { VfsConflictError, dirKey } from "../../src/vfs/types";
import { linkSharing, sharingOfVfs, type SharingAccess } from "../../src/vfs/sharingAccess";
import { makeStore } from "../vfs/harness";
import { FakeShareServer, realSpaceId, SERVER_SHARE_SPACE_ID } from "./fakeShareServer";

let rsWasmModule: WebAssembly.Module;
beforeAll(async () => {
    const wasmPath = join(__dirname, "..", "..", "src", "storage", "encoding", "ReedSolomon", "wasm", "wasm_reed_solomon_erasure_bg.wasm");
    rsWasmModule = await WebAssembly.compile(readFileSync(wasmPath));
    _resetRsWasmForTests();
});

const BASE = "http://fake.test";
const ME = "ann";

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** The accelerator: share creation and listing, the global shard store, and each share's own routes. */
class World {
    readonly shards = new Map<string, Uint8Array>();
    readonly servers = new Map<string, FakeShareServer>();
    /** Shares closed by a rotation: still answering (reads), no longer listed. */
    readonly closedServers = new Map<string, FakeShareServer>();
    /** Every request, as `METHOD /path`, plus `release <manifest id>` lines from the content store, in order. */
    readonly log: string[] = [];
    /** When it returns true for a request, that request fails as a network error. */
    failWhen: ((method: string, path: string) => boolean) | null = null;

    readonly fetch: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        const path = url.pathname;
        this.log.push(`${method} ${path}`);
        if (this.failWhen?.(method, path)) throw new TypeError("fetch failed");
        const session = new Headers(init?.headers).get("X-Muhkoo-Session");
        let m: RegExpMatchArray | null;
        if (path === "/api/app/keeper") return json({ pubkey: "keeper-pub" });
        if ((m = path.match(/^\/api\/spaces\/([^/]+)\/metadata$/)) && method === "POST") return json({ ok: true });
        if (path === "/api/shares" && method === "POST") {
            const body = JSON.parse(String(init!.body));
            if (!SERVER_SHARE_SPACE_ID.test(body.spaceId)) return json({ error: "spaceId must be 1-300 letters, digits, '-' or '_'" }, 400);
            const s = new FakeShareServer({
                spaceId: body.spaceId, kind: body.kind, ownerUsername: session!, name: body.name,
                limitBytes: body.limitBytes, editPolicy: body.editPolicy,
            });
            // One shard bucket for the whole platform: the share reads what the personal path stored.
            (s as unknown as { shards: Map<string, Uint8Array> }).shards = this.shards;
            this.servers.set(body.spaceId, s);
            return json(s.info(), 201);
        }
        if ((m = path.match(/^\/api\/shares\/([^/]+)\/adopt$/)) && method === "POST") {
            // A rotation: a new Space with the same records (same ids), the old one closed with it as successor.
            const body = JSON.parse(String(init!.body)) as { from: string; remove?: string[] };
            const old = this.servers.get(body.from)!;
            const next = new FakeShareServer({
                spaceId: m[1], kind: old.kind, ownerUsername: old.ownerUsername, name: old.name,
                limitBytes: old.limitBytes, editPolicy: old.editPolicy,
                members: old.members.filter((u) => !(body.remove ?? []).includes(u)),
            });
            (next as unknown as { shards: Map<string, Uint8Array> }).shards = this.shards;
            for (const [id, f] of old.files) next.files.set(id, { manifest: { ...f.manifest }, owner: f.owner });
            next.usedBytes = old.usedBytes;
            old.closed = { successor: m[1], at: Date.now() };
            this.servers.delete(body.from);
            this.closedServers.set(body.from, old);
            this.servers.set(m[1], next);
            return json(next.info());
        }
        if (path === "/api/shares" && method === "GET") {
            return json({ shares: [...this.servers.values()].map((s) => ({ spaceId: s.spaceId, kind: s.kind, owner: s.ownerUsername, name: s.name })) });
        }
        if ((m = path.match(/^\/api\/shards\/([0-9a-f]{64})$/))) {
            if (method === "PUT") {
                this.shards.set(m[1], new Uint8Array(init!.body as Uint8Array));
                return json({ ok: true, hash: m[1] });
            }
            const b = this.shards.get(m[1]);
            return b ? new Response(b as BodyInit) : new Response("not found", { status: 404 });
        }
        if ((m = path.match(/^\/api\/(?:shares|spaces)\/([^/]+)/))) {
            const s = this.servers.get(m[1]) ?? this.closedServers.get(m[1]);
            if (!s) return json({ error: "Not found" }, 404);
            return s.fetch(input, init);
        }
        return json({ error: `no route ${method} ${path}` }, 404);
    };

    only(): FakeShareServer {
        expect(this.servers.size).toBe(1);
        return [...this.servers.values()][0];
    }

    /** Shard uploads of any kind: the global route and every Space's. */
    shardPuts(): string[] {
        return this.log.filter((l) => /^PUT \/api\/(spaces\/[^/]+\/)?shards\//.test(l));
    }
}

/** Personal content: real shards in the global store; reference counts kept per manifest id. */
function personalContent(world: World): VfsContentStore & { writes: number; refs: Map<string, number> } {
    const fs = new FileStorage({
        shards: new ShardClient({ baseUrl: BASE, pathPrefix: "/api/shards", fetch: world.fetch, batchShards: false }),
        rsWasmModule,
    });
    const refs = new Map<string, number>();
    const store = {
        writes: 0,
        refs,
        async write(data: Uint8Array | Blob, meta: { name: string; type: string }) {
            store.writes++;
            const bytes = data instanceof Uint8Array ? data : new Uint8Array(await data.arrayBuffer());
            const { manifest } = await fs.writeFileToShards({ data: bytes, metadata: { name: meta.name, type: meta.type, lastModified: Date.now() } });
            refs.set(manifest.id, 1);
            return { manifest, size: manifest.size };
        },
        async read(manifest: FileManifest) {
            return (await fs.readFileFromShards(manifest)).data;
        },
        async retain(manifest: FileManifest) {
            refs.set(manifest.id, (refs.get(manifest.id) ?? 0) + 1);
        },
        async release(manifest: FileManifest) {
            world.log.push(`release ${manifest.id}`);
            refs.set(manifest.id, (refs.get(manifest.id) ?? 0) - 1);
        },
    };
    return store;
}

function makeEnv() {
    const world = new World();
    const http = new HttpClient({ baseUrl: BASE, apiKey: "mk_test_pk_x", getSessionToken: () => ME, fetch: world.fetch });
    let n = 0;
    const handle = (id: string): ShareSpaceHandle => ({
        id,
        keyring: {
            admit: async () => {},
            loadFromCache: async () => true,
            hasAnyKey: () => true,
            requestKey: async () => {},
            pullKeys: async () => 1,
        },
        disconnect: () => {},
    });
    const spaces = {
        createSpace: async () => {
            const id = realSpaceId(`space_${++n}`); // as long as a real Space id (256 characters)
            await http.post(`/api/spaces/${id}/metadata`, { spacePubKey: id });
            return handle(id);
        },
        get: async (id: string) => handle(id),
        joinByInvite: async () => {
            throw new Error("not used");
        },
    };
    const store = makeStore();
    const content = personalContent(world);
    const vfs = new VfsNamespace({
        store,
        content,
        seed: () => new Uint8Array(32).fill(7),
        shares: { list: () => shares.list(), open: (id) => shares.open(id), me: () => ME },
    });
    const sharesStore = memorySharesStore();
    const shares: SharesNamespace = new SharesNamespace({
        http,
        me: () => ME,
        unlocked: () => true,
        spaces,
        auth: {} as ShareGuestAuth,
        store: sharesStore,
        rsWasmModule,
    });
    linkSharing(shares, vfs);
    const access = sharingOfVfs(vfs) as SharingAccess;
    return { world, vfs, store, content, shares, access, sharesStore };
}

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

async function halloween(env: ReturnType<typeof makeEnv>) {
    await env.vfs.writeFile("/Photos/Halloween/a.jpg", bytes("pumpkin"), { type: "image/jpeg" });
    await env.vfs.writeFile("/Photos/Halloween/sub/b.txt", bytes("bats and cats"));
    await env.vfs.mkdir("/Photos/Halloween/empty");
    await env.vfs.writeFile("/Photos/beach.jpg", bytes("sand"));
}

/** Run `act` once, inside the first `finishSharing` call, before the real one: a change made while sharing. */
function meanwhile(env: ReturnType<typeof makeEnv>, act: () => Promise<void>) {
    const real = env.access.finishSharing.bind(env.access);
    let once = true;
    return vi.spyOn(env.access, "finishSharing").mockImplementation(async (...args) => {
        if (once) {
            once = false;
            await act();
        }
        return real(...args);
    });
}

const manifestOf = async (env: ReturnType<typeof makeEnv>, path: string) => (await env.vfs.statManifest(path)).manifest;

let env: ReturnType<typeof makeEnv>;
beforeEach(() => {
    env = makeEnv();
});

describe("shareFolder", () => {
    it("moves every file into a new share without uploading a byte, and the folder becomes a link to it", async () => {
        await halloween(env);
        const a = await manifestOf(env, "/Photos/Halloween/a.jpg");
        const b = await manifestOf(env, "/Photos/Halloween/sub/b.txt");
        const beach = await manifestOf(env, "/Photos/beach.jpg");
        const writesBefore = env.content.writes;
        const logFrom = env.world.log.length;
        // Mark the moment the folder became a link, in the same log as the requests and releases.
        const real = env.access.finishSharing.bind(env.access);
        vi.spyOn(env.access, "finishSharing").mockImplementation(async (...args) => {
            const done = await real(...args);
            env.world.log.push("swapped");
            return done;
        });

        const share = await env.shares.shareFolder("/Photos/Halloween", { kind: "private", limitBytes: null });

        expect(share).toBeInstanceOf(Share);
        // Not a byte uploaded: no content written, no shard PUT on any route.
        expect(env.content.writes).toBe(writesBefore);
        expect(env.world.log.slice(logFrom).filter((l) => /^PUT .*\/shards\//.test(l))).toEqual([]);

        // A share named after the folder, holding the files at their paths inside it.
        const server = env.world.only();
        expect(server.spaceId).toBe(share.spaceId);
        expect(server.name).toBe("Halloween");
        const paths = [...server.files.values()].map((f) => f.manifest.path).sort();
        expect(paths).toEqual(["a.jpg", "empty", "sub/b.txt"]);

        // The folder is now a link; paths below it read from the share.
        expect(await env.vfs.readLink("/Photos/Halloween")).toEqual({ spaceId: share.spaceId });
        expect((await env.vfs.stat("/Photos/Halloween")).kind).toBe("link");
        expect((await env.vfs.list("/Photos/Halloween")).map((e) => [e.name, e.kind])).toEqual([
            ["empty", "dir"],
            ["sub", "dir"],
            ["a.jpg", "file"],
        ]);
        expect(text(await env.vfs.readFile("/Photos/Halloween/sub/b.txt"))).toBe("bats and cats");
        expect(text(await env.vfs.readFile("/Photos/Halloween/a.jpg"))).toBe("pumpkin");

        // Each personal manifest was released exactly once, and only after the folder became a link (until then
        // the folder's entries still name it). Nothing outside the folder was.
        expect(env.content.refs.get(a.id)).toBe(0);
        expect(env.content.refs.get(b.id)).toBe(0);
        expect(env.content.refs.get(beach.id)).toBe(1);
        const after = env.world.log.slice(logFrom);
        const swappedAt = after.indexOf("swapped");
        expect(swappedAt).toBeGreaterThan(-1);
        expect(after.slice(0, swappedAt).filter((l) => l.startsWith("release "))).toEqual([]);
        for (const id of [a.id, b.id]) expect(after.filter((l) => l === `release ${id}`)).toHaveLength(1);

        // The folder's records are gone from the personal store; the rest of /Photos is untouched.
        const keys = [...env.store.records.keys()];
        expect(keys.filter((k) => k.startsWith("vfs/d/"))).toHaveLength(2); // root and /Photos
        expect(text(await env.vfs.readFile("/Photos/beach.jpg"))).toBe("sand");
    });

    it("names the share from opts.name and passes kind, limit, edit policy and password through", async () => {
        await halloween(env);
        const share = await env.shares.shareFolder("/Photos/Halloween", {
            kind: "public", limitBytes: 10_000_000, password: "spooky", name: "Halloween 2026",
        });
        const server = env.world.servers.get(share.spaceId)!;
        expect(server).toMatchObject({ kind: "public", name: "Halloween 2026", limitBytes: 10_000_000 });
        expect(env.world.log.join("\n")).not.toContain("spooky");
    });

    it("keeps both of two files that share one manifest (a copy inside the folder)", async () => {
        await halloween(env);
        await env.vfs.copy("/Photos/Halloween/a.jpg", "/Photos/Halloween/sub/a-copy.jpg");
        const a = await manifestOf(env, "/Photos/Halloween/a.jpg");
        expect(env.content.refs.get(a.id)).toBe(2);

        await env.shares.shareFolder("/Photos/Halloween", { kind: "private", limitBytes: null });

        const server = env.world.only();
        expect([...server.files.values()].map((f) => f.manifest.path).sort()).toEqual(["a.jpg", "empty", "sub/a-copy.jpg", "sub/b.txt"]);
        expect(text(await env.vfs.readFile("/Photos/Halloween/sub/a-copy.jpg"))).toBe("pumpkin");
        // One reference per file that named it.
        expect(env.content.refs.get(a.id)).toBe(0);
    });

    it("a run that crashed after moving the files resumes into the same share, with no duplicates", async () => {
        await halloween(env);
        const a = await manifestOf(env, "/Photos/Halloween/a.jpg");
        const b = await manifestOf(env, "/Photos/Halloween/sub/b.txt");
        const finish = vi.spyOn(env.access, "finishSharing").mockRejectedValueOnce(new Error("tab closed"));

        await expect(env.shares.shareFolder("/Photos/Halloween", { kind: "private", limitBytes: null })).rejects.toThrow("tab closed");

        // Nothing of the user's is gone: the folder is still a folder, every file still reads, nothing let go of.
        const server = env.world.only();
        expect(server.files.size).toBe(3);
        expect(env.world.log.filter((l) => l.startsWith("release "))).toEqual([]);
        expect(env.content.refs.get(a.id)).toBe(1);
        expect(env.content.refs.get(b.id)).toBe(1);
        expect((await env.vfs.stat("/Photos/Halloween")).kind).toBe("dir");
        expect(text(await env.vfs.readFile("/Photos/Halloween/sub/b.txt"))).toBe("bats and cats");

        finish.mockRestore();
        const logFrom = env.world.log.length;
        const share = await env.shares.shareFolder("/Photos/Halloween", { kind: "private", limitBytes: null });

        // The same share, not a second one, and nothing posted twice.
        expect(share.spaceId).toBe(server.spaceId);
        expect(env.world.servers.size).toBe(1);
        expect(env.world.log.slice(logFrom)).not.toContain("POST /api/shares");
        expect(env.world.log.slice(logFrom)).not.toContain(`POST /api/spaces/${server.spaceId}/files`);
        expect(server.files.size).toBe(3);
        // The resumed run let go of each manifest, exactly once, at its end.
        expect(env.content.refs.get(a.id)).toBe(0);
        expect(env.content.refs.get(b.id)).toBe(0);
        for (const id of [a.id, b.id]) expect(env.world.log.filter((l) => l === `release ${id}`)).toHaveLength(1);
        expect(await env.vfs.readLink("/Photos/Halloween")).toEqual({ spaceId: server.spaceId });
    });

    it("a run that stopped part-way through the files resumes where it stopped", async () => {
        await halloween(env);
        const b = await manifestOf(env, "/Photos/Halloween/sub/b.txt");
        let posts = 0;
        env.world.failWhen = (method, path) => method === "POST" && /\/files$/.test(path) && ++posts === 2;

        await expect(env.shares.shareFolder("/Photos/Halloween", { kind: "private", limitBytes: null })).rejects.toThrow();
        const server = env.world.only();
        expect(server.files.size).toBe(1);
        expect((await env.vfs.stat("/Photos/Halloween")).kind).toBe("dir");
        expect(env.world.log.filter((l) => l.startsWith("release "))).toEqual([]);

        env.world.failWhen = null;
        await env.shares.shareFolder("/Photos/Halloween", { kind: "private", limitBytes: null });
        expect(env.world.servers.size).toBe(1);
        expect([...server.files.values()].map((f) => f.manifest.path).sort()).toEqual(["a.jpg", "empty", "sub/b.txt"]);
        expect(env.content.refs.get(b.id)).toBe(0);
        expect(env.world.log.filter((l) => l === `release ${b.id}`)).toHaveLength(1);
        expect(text(await env.vfs.readFile("/Photos/Halloween/sub/b.txt"))).toBe("bats and cats");
    });

    it("a file saved into the folder while it was being shared is moved too, not lost", async () => {
        await halloween(env);
        meanwhile(env, () => env.vfs.writeFile("/Photos/Halloween/late.txt", bytes("just in time")).then(() => {}));
        await env.shares.shareFolder("/Photos/Halloween", { kind: "private", limitBytes: null });
        expect(text(await env.vfs.readFile("/Photos/Halloween/late.txt"))).toBe("just in time");
        expect([...env.world.only().files.values()].map((f) => f.manifest.path)).toContain("late.txt");
    });

    it("a file moved out of the folder while it was being shared keeps its reference and stays readable", async () => {
        await halloween(env);
        const a = await manifestOf(env, "/Photos/Halloween/a.jpg");
        meanwhile(env, () => env.vfs.rename("/Photos/Halloween/a.jpg", "/Photos/a-out.jpg"));

        await env.shares.shareFolder("/Photos/Halloween", { kind: "private", limitBytes: null });

        expect((await env.vfs.stat("/Photos/Halloween")).kind).toBe("link");
        expect(text(await env.vfs.readFile("/Photos/a-out.jpg"))).toBe("pumpkin");
        expect(env.content.refs.get(a.id)).toBe(1);
        expect(env.world.log).not.toContain(`release ${a.id}`);
    });

    it("a file deleted from the folder while it was being shared is not released a second time", async () => {
        await halloween(env);
        const a = await manifestOf(env, "/Photos/Halloween/a.jpg");
        meanwhile(env, () => env.vfs.delete("/Photos/Halloween/a.jpg"));

        await env.shares.shareFolder("/Photos/Halloween", { kind: "private", limitBytes: null });

        // Once, by the delete; never by the share.
        expect(env.world.log.filter((l) => l === `release ${a.id}`)).toHaveLength(1);
        expect(env.content.refs.get(a.id)).toBe(0);
    });

    it("a folder record another device wrote into during the swap is left in place, and its files kept", async () => {
        await halloween(env);
        const b = await manifestOf(env, "/Photos/Halloween/sub/b.txt");
        const a = await manifestOf(env, "/Photos/Halloween/a.jpg");
        const before = new Set([...env.store.records.keys()].filter((k) => k.startsWith("vfs/d/")));
        // Another device: its own namespace over the same store. This one's cached copy of `sub` goes stale.
        const other = new VfsNamespace({ store: env.store, content: env.content, seed: () => new Uint8Array(32).fill(7) });
        await env.vfs.list("/Photos/Halloween/sub"); // cached here before the other device writes
        meanwhile(env, () => other.writeFile("/Photos/Halloween/sub/from-phone.txt", bytes("hello")).then(() => {}));
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        await env.shares.shareFolder("/Photos/Halloween", { kind: "private", limitBytes: null });
        warn.mockRestore();

        expect((await env.vfs.stat("/Photos/Halloween")).kind).toBe("link");
        // The `sub` record is still stored, holding the other device's file; nothing in it was let go of.
        const after = [...env.store.records.keys()].filter((k) => k.startsWith("vfs/d/"));
        const left = after.filter((k) => before.has(k) && k !== dirKey("root"));
        expect(left).toHaveLength(2); // /Photos and /Photos/Halloween/sub
        expect(env.content.refs.get(b.id)).toBe(1);
        expect(env.world.log).not.toContain(`release ${b.id}`);
        // A file in a record that was removed is let go of as usual.
        expect(env.content.refs.get(a.id)).toBe(0);
    });

    it("a run that stopped right after the swap lets go of the moved files on the next call", async () => {
        await halloween(env);
        const a = await manifestOf(env, "/Photos/Halloween/a.jpg");
        const b = await manifestOf(env, "/Photos/Halloween/sub/b.txt");
        const real = env.access.finishSharing.bind(env.access);
        const finish = vi.spyOn(env.access, "finishSharing").mockImplementationOnce(async (...args) => {
            await real(...args);
            throw new Error("tab closed");
        });
        await expect(env.shares.shareFolder("/Photos/Halloween", { kind: "private", limitBytes: null })).rejects.toThrow("tab closed");
        expect((await env.vfs.stat("/Photos/Halloween")).kind).toBe("link");
        expect(env.world.log.filter((l) => l.startsWith("release "))).toEqual([]);
        finish.mockRestore();

        const share = await env.shares.shareFolder("/Photos/Halloween", { kind: "private", limitBytes: null });
        expect(share.spaceId).toBe(env.world.only().spaceId);
        for (const id of [a.id, b.id]) expect(env.world.log.filter((l) => l === `release ${id}`)).toHaveLength(1);
        // And again: nothing left to let go of, so it is just a link that is shared already.
        await expect(env.shares.shareFolder("/Photos/Halloween", { kind: "private", limitBytes: null })).rejects.toBeInstanceOf(VfsConflictError);
        for (const id of [a.id, b.id]) expect(env.world.log.filter((l) => l === `release ${id}`)).toHaveLength(1);
    });

    it("opening the share also lets go of what a run that stopped after the swap left", async () => {
        await halloween(env);
        const a = await manifestOf(env, "/Photos/Halloween/a.jpg");
        const real = env.access.finishSharing.bind(env.access);
        vi.spyOn(env.access, "finishSharing").mockImplementationOnce(async (...args) => {
            await real(...args);
            throw new Error("tab closed");
        });
        await expect(env.shares.shareFolder("/Photos/Halloween", { kind: "private", limitBytes: null })).rejects.toThrow("tab closed");
        // Reading through the link opens the share.
        expect(text(await env.vfs.readFile("/Photos/Halloween/a.jpg"))).toBe("pumpkin");
        expect(env.world.log.filter((l) => l === `release ${a.id}`)).toHaveLength(1);
    });

    /** Start a run that stops for good just before the swap (the tab is closed): its pending list is saved. */
    async function stopBeforeSwap(): Promise<string> {
        const hung = vi.spyOn(env.access, "finishSharing").mockImplementationOnce(() => new Promise(() => {}));
        void env.shares.shareFolder("/Photos/Halloween", { kind: "private", limitBytes: null }).catch(() => {});
        await vi.waitFor(() => expect(hung).toHaveBeenCalled());
        hung.mockRestore();
        const spaceId = env.world.only().spaceId;
        expect(await env.sharesStore.get(`share-folder/pending/${spaceId}`)).not.toBeNull();
        return spaceId;
    }

    it("a link the user made to the share after deleting the folder does not release anything again", async () => {
        await halloween(env);
        const a = await manifestOf(env, "/Photos/Halloween/a.jpg");
        const b = await manifestOf(env, "/Photos/Halloween/sub/b.txt");
        const spaceId = await stopBeforeSwap();

        // Deleted from another device (so nothing here hears of it): a normal delete lets go of every file once.
        const other = new VfsNamespace({ store: env.store, content: env.content, seed: () => new Uint8Array(32).fill(7) });
        await other.delete("/Photos/Halloween", { recursive: true });
        for (const id of [a.id, b.id]) expect(env.world.log.filter((l) => l === `release ${id}`)).toHaveLength(1);

        // Then the user links the share back at the same path, and uses it.
        env.vfs.clearCache();
        await env.vfs.link("/Photos/Halloween", spaceId);
        expect(text(await env.vfs.readFile("/Photos/Halloween/a.jpg"))).toBe("pumpkin"); // opens the share
        await expect(env.shares.shareFolder("/Photos/Halloween", { kind: "private", limitBytes: null })).rejects.toBeInstanceOf(VfsConflictError);

        // Not a second time: that link is not the one a swap wrote.
        for (const id of [a.id, b.id]) expect(env.world.log.filter((l) => l === `release ${id}`)).toHaveLength(1);
    });

    it("deleting a folder that was being shared forgets the run's pending releases", async () => {
        await halloween(env);
        const spaceId = await stopBeforeSwap();
        await env.vfs.delete("/Photos/Halloween", { recursive: true });
        await vi.waitFor(async () => expect(await env.sharesStore.get(`share-folder/pending/${spaceId}`)).toBeNull());
    });

    it("letting go of content is not something client.vfs offers", () => {
        // The other steps are TypeScript-private on VfsNamespace; the release has no method there at all.
        expect("releaseManifest" in env.vfs).toBe(false);
        expect(Object.keys(env.shares)).not.toContain("vfs");
    });

    it("a folder bigger than the share's limit throws ShareFullError before anything changes", async () => {
        await halloween(env);
        const before = new Map(env.store.records);
        const logFrom = env.world.log.length;

        const err = await env.shares
            .shareFolder("/Photos/Halloween", { kind: "public", limitBytes: 10, password: "spooky" })
            .catch((e) => e);

        expect(err).toBeInstanceOf(ShareFullError);
        expect(err).toMatchObject({ limitBytes: 10, refused: 2 });
        // No share made, no Space, nothing written or released.
        expect(env.world.servers.size).toBe(0);
        expect(env.world.log.slice(logFrom).filter((l) => !l.startsWith("GET "))).toEqual([]);
        expect(env.store.records).toEqual(before);
        expect((await env.vfs.stat("/Photos/Halloween")).kind).toBe("dir");
    });

    it("refuses what is not a folder of the user's own, before making a share", async () => {
        await halloween(env);
        await expect(env.shares.shareFolder("/Photos/beach.jpg", { kind: "private", limitBytes: null })).rejects.toBeInstanceOf(VfsConflictError);
        await expect(env.shares.shareFolder("/", { kind: "private", limitBytes: null })).rejects.toBeInstanceOf(VfsConflictError);
        await expect(env.shares.shareFolder("/Home", { kind: "private", limitBytes: null })).rejects.toBeInstanceOf(VfsConflictError);
        await expect(env.shares.shareFolder("/Nope", { kind: "private", limitBytes: null })).rejects.toThrow(/does not exist/);

        // A folder that holds a link: a share cannot hold another share.
        await env.vfs.link("/Photos/Halloween/sub/elsewhere", realSpaceId("space_other"));
        await expect(env.shares.shareFolder("/Photos/Halloween", { kind: "private", limitBytes: null })).rejects.toBeInstanceOf(VfsConflictError);
        expect(env.world.servers.size).toBe(0);
    });

    it("lets go of the moved files' earlier versions and their history records", async () => {
        await halloween(env);
        const v1 = await manifestOf(env, "/Photos/Halloween/a.jpg");
        await env.vfs.writeFile("/Photos/Halloween/a.jpg", bytes("jack-o-lantern"));
        const v2 = await manifestOf(env, "/Photos/Halloween/a.jpg");
        expect(env.content.refs.get(v1.id)).toBe(1); // kept by the history
        const historyKeys = () => [...env.store.records.keys()].filter((k) => k.startsWith("vfs/h/"));
        expect(historyKeys()).toHaveLength(1);

        await env.shares.shareFolder("/Photos/Halloween", { kind: "private", limitBytes: null });

        expect(text(await env.vfs.readFile("/Photos/Halloween/a.jpg"))).toBe("jack-o-lantern");
        expect(env.content.refs.get(v2.id)).toBe(0);
        expect(env.content.refs.get(v1.id)).toBe(0);
        expect(historyKeys()).toEqual([]);
    });
});

describe("links after a rotation this client ran (final review I-1)", () => {
    it("changePassword / removeMember: the link reaches the successor at once - list, read and write - with no reload", async () => {
        await halloween(env);
        const first = await env.shares.shareFolder("/Photos/Halloween", { kind: "private", limitBytes: null });
        expect(text(await env.vfs.readFile("/Photos/Halloween/a.jpg"))).toBe("pumpkin"); // the share is kept open

        const next = await env.shares.removeMember(first.spaceId, "nobody");
        expect(next.spaceId).not.toBe(first.spaceId);
        // A file only the successor has: a read served by the closed Space would not see it.
        await next.write("fresh.txt", bytes("new space"));

        expect((await env.vfs.list("/Photos/Halloween")).map((e) => e.name)).toContain("fresh.txt");
        expect(text(await env.vfs.readFile("/Photos/Halloween/fresh.txt"))).toBe("new space");
        await env.vfs.writeFile("/Photos/Halloween/after.txt", "written after");
        const successor = env.world.servers.get(next.spaceId)!;
        expect([...successor.files.values()].map((f) => f.manifest.path)).toContain("after.txt");
        expect([...env.world.closedServers.get(first.spaceId)!.files.values()].map((f) => f.manifest.path)).not.toContain("after.txt");
    });
});

describe("a file that leaves the folder between two runs (final review I-2)", () => {
    function asMember(server: FakeShareServer, username: string): Share {
        server.members.push(username);
        const http = new HttpClient({ baseUrl: BASE, apiKey: "mk_test_pk_x", getSessionToken: () => username, fetch: env.world.fetch });
        return new Share({ http, spaceId: server.spaceId, me: username, rsWasmModule });
    }

    it("is taken back out of the share by the run that finishes; another member's upload is untouched", async () => {
        await halloween(env);
        await env.vfs.writeFile("/Photos/Halloween/secret.pdf", bytes("do not share"));
        await env.vfs.mkdir("/Photos/Halloween/private-empty");
        const finish = vi.spyOn(env.access, "finishSharing").mockRejectedValueOnce(new Error("tab closed"));
        await expect(env.shares.shareFolder("/Photos/Halloween", { kind: "private", limitBytes: null })).rejects.toThrow("tab closed");
        finish.mockRestore();
        const server = env.world.only();
        const paths = () => [...server.files.values()].map((f) => f.manifest.path).sort();
        expect(paths()).toContain("secret.pdf");
        expect(paths()).toContain("private-empty");

        // Meanwhile: a member uploads a file of their own, and the user deletes secret.pdf from the folder.
        await asMember(server, "bob").write("bob.txt", bytes("from bob"));
        await env.vfs.delete("/Photos/Halloween/secret.pdf");
        await env.vfs.delete("/Photos/Halloween/private-empty");

        await env.shares.shareFolder("/Photos/Halloween", { kind: "private", limitBytes: null });

        expect(paths()).toEqual(["a.jpg", "bob.txt", "empty", "sub/b.txt"]);
        expect((await env.vfs.list("/Photos/Halloween")).map((e) => e.name)).not.toContain("secret.pdf");
        // Nothing kept on the device once the folder is a link.
        expect(await env.sharesStore.get(`share-folder/posted/${server.spaceId}`)).toBeNull();
        expect(await env.sharesStore.get(`share-folder/posted/${server.spaceId}/0`)).toBeNull();
    });

    it("a file renamed inside the folder between runs leaves no copy at its old path", async () => {
        await halloween(env);
        const finish = vi.spyOn(env.access, "finishSharing").mockRejectedValueOnce(new Error("tab closed"));
        await expect(env.shares.shareFolder("/Photos/Halloween", { kind: "private", limitBytes: null })).rejects.toThrow("tab closed");
        finish.mockRestore();
        await env.vfs.writeFile("/Photos/Halloween/a.jpg", bytes("edited pumpkin")); // a new manifest
        await env.vfs.rename("/Photos/Halloween/a.jpg", "/Photos/Halloween/renamed.jpg");

        await env.shares.shareFolder("/Photos/Halloween", { kind: "private", limitBytes: null });

        const server = env.world.only();
        expect([...server.files.values()].map((f) => f.manifest.path).sort()).toEqual(["empty", "renamed.jpg", "sub/b.txt"]);
        expect(text(await env.vfs.readFile("/Photos/Halloween/renamed.jpg"))).toBe("edited pumpkin");
    });

    it("the ids are noted across a rotation of the share between the runs", async () => {
        await halloween(env);
        await env.vfs.writeFile("/Photos/Halloween/secret.pdf", bytes("do not share"));
        const finish = vi.spyOn(env.access, "finishSharing").mockRejectedValueOnce(new Error("tab closed"));
        await expect(env.shares.shareFolder("/Photos/Halloween", { kind: "private", limitBytes: null })).rejects.toThrow("tab closed");
        finish.mockRestore();
        const first = env.world.only();
        const next = await env.shares.removeMember(first.spaceId, "nobody");
        await env.vfs.delete("/Photos/Halloween/secret.pdf");

        const share = await env.shares.shareFolder("/Photos/Halloween", { kind: "private", limitBytes: null });

        expect(share.spaceId).toBe(next.spaceId);
        const server = env.world.servers.get(next.spaceId)!;
        expect([...server.files.values()].map((f) => f.manifest.path).sort()).toEqual(["a.jpg", "empty", "sub/b.txt"]);
    });
});

describe("take-back before posting (final review I-2, ruling 2S)", () => {
    it("a removed file that fills the share is taken back before the new one is posted (8 MB + 6 MB > 10 MB)", async () => {
        const big = (n: number, c: number) => new Uint8Array(n).fill(c);
        await env.vfs.writeFile("/Docs/secret.pdf", big(8_000_000, 1));
        const finish = vi.spyOn(env.access, "finishSharing").mockRejectedValueOnce(new Error("tab closed"));
        await expect(env.shares.shareFolder("/Docs", { kind: "private", limitBytes: 10_000_000 })).rejects.toThrow("tab closed");
        finish.mockRestore();
        const server = env.world.only();
        expect([...server.files.values()].map((f) => f.manifest.path)).toEqual(["secret.pdf"]);

        await env.vfs.delete("/Docs/secret.pdf");
        await env.vfs.writeFile("/Docs/new.bin", big(6_000_000, 2));

        await env.shares.shareFolder("/Docs", { kind: "private", limitBytes: 10_000_000 });

        expect([...server.files.values()].map((f) => f.manifest.path)).toEqual(["new.bin"]);
        expect(server.usedBytes).toBe(6_000_000);
        expect(await env.vfs.readLink("/Docs")).toEqual({ spaceId: server.spaceId });
    }, 60_000);
});
