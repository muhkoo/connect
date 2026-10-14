import { describe, it, expect, beforeEach, vi } from "vitest";
import { KeyringClient, KeyringHttpError } from "../../../src/spaces/KeyringClient";
import { PinStore, spacePinKey } from "../../../src/core/trust/PinStore";
import { memoryTrustStore, type TrustStore } from "../../../src/core/trust/trustStore";
import { SpaceTrustError } from "../../../src/spaces/trust/errors";
import type { MembershipEntry } from "../../../src/spaces/trust/types";
import { log } from "../../../src/utilities";
import { FakeLogServer } from "./fakeLogServer";
import { Chain, syncFor, user, type SyncEnv, type TestUser } from "./chainHelper";

const SPACE = "sp1";
let alice: TestUser, bob: TestUser;
let server: FakeLogServer;
let store: TrustStore;
let directory: Record<string, string>;
let env: SyncEnv;

beforeEach(async () => {
    [alice, bob] = await Promise.all([user("alice"), user("bob")]);
    server = new FakeLogServer();
    store = memoryTrustStore();
    directory = { alice: alice.ik, bob: bob.ik };
    env = { spaceId: SPACE, server, store, directory, kvs: new Map() };
});

const PRIVATE_GENESIS = { visibility: "private", policy: "static", appId: "app1", baseEpoch: -1, legacyCommits: {} };
const PUBLIC_GENESIS = { ...PRIVATE_GENESIS, visibility: "public" };
const markKey = (u: TestUser) => `loghw:c-${u.name}:${SPACE}`;

/** Answers the next GET late: its page is read when the request is made, and returned only on release(). */
function holdNextFetch(srv: FakeLogServer) {
    const fetch = srv.fetchLog.bind(srv);
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const hold = { reached: new Promise<void>((r) => { reached = r; }), release: () => release() };
    let used = false;
    srv.fetchLog = async (since, limit) => {
        const page = await fetch(since, limit);
        if (!used) {
            used = true;
            reached();
            await gate;
        }
        return page;
    };
    return hold;
}

/** The relay replaces the Space's log with a correctly signed public genesis of its own. */
async function swapForPublicGenesis() {
    const forged = new Chain(SPACE);
    await forged.push(await user("mallory"), "genesis", PUBLIC_GENESIS);
    await server.truncate(-1);
    await server.postLogEntry(forged.entries[0]);
}

describe("LogSync (design §3.6–§3.7; slice rulings S7, S10)", () => {
    it("a Space without a log is unlogged", async () => {
        const s = syncFor(alice, env);
        await s.sync();
        expect(s.logEnabled).toBe(false);
    });
    it("pages through the log", async () => {
        const c = new Chain(SPACE);
        await c.genesis(alice);
        for (let i = 0; i < 4; i++) await c.push(alice, "add", { member: `m${i}`, memberIk: bob.ik, role: "viewer" });
        for (const e of c.entries) await server.postLogEntry(e);
        server.pageLimit = 2;
        server.gets = 0;
        const s = syncFor(alice, env);
        await s.sync();
        expect(server.gets).toBe(3);
        expect(s.members().map((m) => m.id).sort()).toEqual(["alice", "m0", "m1", "m2", "m3"]);
    });
    it("appends the genesis, then adds with the right prev", async () => {
        const s = syncFor(alice, env);
        await s.append("genesis", { visibility: "private", policy: "static", appId: "app1", baseEpoch: -1, legacyCommits: {} });
        await s.append("add", { member: "bob", memberIk: bob.ik, role: "viewer" });
        expect(server.entries.map((e) => [e.seq, e.op])).toEqual([[0, "genesis"], [1, "add"]]);
        expect(s.isMember("bob")).toBe(true);
    });
    it("409 Log moved: re-sync, re-sign against the new head, succeed without duplicates (Review Focus 3)", async () => {
        const s = syncFor(alice, env);
        await s.append("genesis", { visibility: "private", policy: "static", appId: "app1", baseEpoch: -1, legacyCommits: {} });
        const other = syncFor(alice, env);
        let raced = false;
        server.beforePost = async () => {
            if (raced) return;
            raced = true;
            server.beforePost = null;
            await other.append("add", { member: "carol", memberIk: bob.ik, role: "viewer" });
        };
        await s.append("add", { member: "bob", memberIk: bob.ik, role: "viewer" });
        expect(server.entries.map((e) => e.body && (e.body as { member?: string }).member)).toEqual([undefined, "carol", "bob"]);
        // The confirming sync verifies every signature: an entry signed against the old head would not admit bob.
        expect(s.isMember("bob")).toBe(true);
        expect(s.integrity).toEqual({ broken: false });
    });
    it("four 409s in a row → log-conflict", async () => {
        const s = syncFor(alice, env);
        await s.append("genesis", { visibility: "private", policy: "static", appId: "app1", baseEpoch: -1, legacyCommits: {} });
        let posts = 0;
        server.postLogEntry = async () => {
            posts++;
            throw new KeyringHttpError(409, { error: "Log moved", head: null }, "POST");
        };
        await expect(s.append("add", { member: "bob", memberIk: bob.ik, role: "viewer" })).rejects.toMatchObject({ code: "log-conflict" });
        expect(posts).toBe(4); // the first attempt and at most 3 retries (§9.2 I9)
    });
    it("a head below the high-water mark is integrity (rollback)", async () => {
        const s = syncFor(alice, env);
        await s.append("genesis", { visibility: "private", policy: "static", appId: "app1", baseEpoch: -1, legacyCommits: {} });
        await s.append("add", { member: "bob", memberIk: bob.ik, role: "viewer" });
        await server.truncate(0);
        const again = syncFor(alice, env);
        await again.sync();
        expect(again.integrity).toEqual({ broken: true, reason: "rollback" });
    });
    it("a genesis that differs from the pinned one is integrity", async () => {
        const s = syncFor(alice, env);
        await s.append("genesis", { visibility: "private", policy: "static", appId: "app1", baseEpoch: -1, legacyCommits: {} });
        await (s as unknown as { deps: { pins: PinStore } }).deps.pins.unpin("spaces", [await spacePinKey(SPACE)]);
        await (s as unknown as { deps: { pins: PinStore } }).deps.pins.pin("spaces", { [await spacePinKey(SPACE)]: "not-this-genesis" });
        await store.del(`loghw:c-alice:${SPACE}`);
        await s.sync();
        expect(s.integrity).toEqual({ broken: true, reason: "genesis-pin" });
    });
    it("TOFU: the genesis owner's IK must match the directory", async () => {
        const c = new Chain(SPACE);
        await c.genesis(alice);
        await server.postLogEntry(c.entries[0]);
        directory.alice = bob.ik; // a server-substituted directory answer
        const s = syncFor(bob, env);
        await s.sync();
        expect(s.integrity).toEqual({ broken: true, reason: "owner-identity" });
    });
    it("an add naming an IK that differs from an existing pin flags identityChanged", async () => {
        const s = syncFor(alice, env);
        await s.append("genesis", { visibility: "private", policy: "static", appId: "app1", baseEpoch: -1, legacyCommits: {} });
        await (s as unknown as { deps: { pins: PinStore } }).deps.pins.pin("identity", { bob: "an-older-fingerprint" });
        await s.append("add", { member: "bob", memberIk: bob.ik, role: "viewer" });
        expect(s.members().find((m) => m.id === "bob")!.identityChanged).toBe(true);
    });

    it("a re-sync that finds a rollback stops the append: nothing is signed against an unverified head (design §3.7 item 3)", async () => {
        const s = syncFor(alice, env);
        await s.append("genesis", { visibility: "private", policy: "static", appId: "app1", baseEpoch: -1, legacyCommits: {} });
        await s.append("add", { member: "bob", memberIk: bob.ik, role: "viewer" });
        const post = server.postLogEntry.bind(server);
        let rolledBack = false;
        server.postLogEntry = async (entry, ec) => {
            if (!rolledBack) {
                rolledBack = true;
                await server.truncate(0);
                throw new KeyringHttpError(409, { error: "Log moved", head: server.head }, "POST /keyring/log");
            }
            return post(entry, ec);
        };
        await expect(s.append("add", { member: "carol", memberIk: bob.ik, role: "viewer" })).rejects.toMatchObject({ code: "integrity" });
        expect(server.entries.map((e) => e.seq)).toEqual([0]);
    });
    it("a sync that fails after the server stored the entry is not a refusal: append resolves {seq}, the entry is not re-sent, and a later sync applies it (S4)", async () => {
        const s = syncFor(alice, env);
        await s.append("genesis", { visibility: "private", policy: "static", appId: "app1", baseEpoch: -1, legacyCommits: {} });
        const post = server.postLogEntry.bind(server);
        const fetchLog = server.fetchLog.bind(server);
        let failNextGet = false;
        server.postLogEntry = async (entry, ec) => {
            const r = await post(entry, ec);
            failNextGet = true; // the confirming GET fails once
            return r;
        };
        server.fetchLog = async (since, limit) => {
            if (failNextGet) {
                failNextGet = false;
                throw new KeyringHttpError(503, { error: "unavailable" }, "GET /keyring/log");
            }
            return fetchLog(since, limit);
        };
        const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
        let logged: unknown[] = [];
        vi.useFakeTimers();
        try {
            expect(await s.append("add", { member: "bob", memberIk: bob.ik, role: "viewer" })).toEqual({ seq: 1 });
            expect(server.entries.map((e) => [e.seq, e.op])).toEqual([[0, "genesis"], [1, "add"]]);
            expect(s.isMember("bob")).toBe(false); // stored, not yet confirmed
            await vi.advanceTimersByTimeAsync(1000);
            await vi.waitFor(() => expect(s.isMember("bob")).toBe(true));
        } finally {
            logged = warn.mock.calls.map((c) => c[1]);
            vi.useRealTimers();
            warn.mockRestore();
        }
        expect(logged).toEqual([expect.objectContaining({ spaceId: SPACE, code: 503 })]);
        expect(server.entries).toHaveLength(2);
        expect(s.integrity).toEqual({ broken: false });
    });
    it("TOFU: a genesis pin another tab wrote first is honoured, not overwritten (design §3.7 item 2)", async () => {
        const c = new Chain(SPACE);
        await c.genesis(alice);
        await server.postLogEntry(c.entries[0]);
        const s = syncFor(alice, env);
        const pins = (s as unknown as { deps: { pins: PinStore } }).deps.pins;
        await pins.pin("spaces", { [await spacePinKey(SPACE)]: "a-genesis-another-tab-pinned" });
        const get = pins.get.bind(pins);
        let raced = false;
        // This tab's read happens before the other tab's write lands.
        pins.get = async (doc, key) => {
            if (doc === "spaces" && !raced) {
                raced = true;
                return undefined;
            }
            return get(doc, key);
        };
        await s.sync();
        expect(s.integrity).toEqual({ broken: true, reason: "genesis-pin" });
    });
    it("a private genesis whose signer id is not a string is integrity, not a crash", async () => {
        const c = new Chain(SPACE);
        await c.genesis({ ...alice, name: null as unknown as string });
        await server.postLogEntry(c.entries[0]);
        const s = syncFor(bob, env);
        await s.sync();
        expect(s.integrity).toEqual({ broken: true, reason: "malformed" });
    });

    it("overlapping syncs: calls made mid-sync share one follow-up run, so an older head never lands last and membership does not revert", async () => {
        const s = syncFor(alice, env);
        await s.append("genesis", PRIVATE_GENESIS);
        await s.append("add", { member: "carol", memberIk: bob.ik, role: "viewer" });
        const hold = holdNextFetch(server);
        const first = s.sync(); // reads the log while carol is still a member
        await hold.reached;
        await syncFor(alice, env).append("remove", { member: "carol" }); // another tab removes her
        server.gets = 0;
        const second = s.sync();
        const third = s.sync();
        hold.release();
        await second;
        expect(s.isMember("carol")).toBe(false);
        await Promise.all([first, third]);
        expect(server.gets).toBe(1);
        expect(s.isMember("carol")).toBe(false);
        expect(s.integrity).toEqual({ broken: false });
    });
    it("two overlapping syncs leave the high-water mark at the higher head (design §3.7 item 3)", async () => {
        const s = syncFor(alice, env);
        await s.append("genesis", PRIVATE_GENESIS);
        await s.append("add", { member: "carol", memberIk: bob.ik, role: "viewer" });
        const tab = syncFor(alice, env);
        const hold = holdNextFetch(server);
        const late = tab.sync(); // another tab reads head 1, and its answer arrives late
        await hold.reached;
        await s.append("remove", { member: "carol" }); // this tab records head 2
        hold.release();
        await late;
        expect(await store.get(markKey(alice))).toEqual({ seq: 2, hash: server.head!.hash, humanRemovalSeq: 2 });
    });
    it("a lower head never replaces the view already held: membership does not revert, and the drop is a rollback", async () => {
        const s = syncFor(alice, env);
        await s.append("genesis", PRIVATE_GENESIS);
        await s.append("add", { member: "carol", memberIk: bob.ik, role: "viewer" });
        await s.append("remove", { member: "carol" });
        await server.truncate(1); // carol is a member again at the server's new head
        await store.del(markKey(alice)); // and only the view this LogSync holds still remembers seq 2
        await s.sync();
        expect(s.isMember("carol")).toBe(false);
        expect(s.members().map((m) => m.id)).toEqual(["alice"]);
        expect(s.integrity).toEqual({ broken: true, reason: "rollback" });
    });

    it("a private Space whose log is swapped for a valid public genesis is integrity (fork), not unlogged (design §3.7 item 3)", async () => {
        const s = syncFor(alice, env);
        await s.append("genesis", PRIVATE_GENESIS);
        await s.append("add", { member: "bob", memberIk: bob.ik, role: "viewer" });
        await swapForPublicGenesis();
        const again = syncFor(alice, env);
        await again.sync();
        expect(again.integrity).toEqual({ broken: true, reason: "fork" });
        expect(again.logEnabled).toBe(false);
    });
    it("with no mark, a pinned genesis that differs from the public one is integrity (genesis-pin) (design §3.7 item 2)", async () => {
        const s = syncFor(alice, env);
        await s.append("genesis", PRIVATE_GENESIS);
        await swapForPublicGenesis();
        await store.del(markKey(alice));
        const again = syncFor(alice, env);
        await again.sync();
        expect(again.integrity).toEqual({ broken: true, reason: "genesis-pin" });
        expect(again.logEnabled).toBe(false);
    });
    it("a public genesis this client never marked or pinned leaves the Space unlogged", async () => {
        await swapForPublicGenesis();
        const s = syncFor(bob, env);
        await s.sync();
        expect(s.logEnabled).toBe(false);
        expect(s.integrity).toEqual({ broken: false });
    });

    it("a failing background sync is logged with its code and reported through onChange; it neither throws nor changes integrity", async () => {
        const s = syncFor(alice, env);
        await s.append("genesis", PRIVATE_GENESIS);
        let changes = 0;
        s.onChange(() => changes++);
        const pins = (s as unknown as { deps: { pins: PinStore } }).deps.pins;
        pins.get = async () => { throw new SpaceTrustError("pins-rollback", "The pinned keys went back in time."); };
        const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
        let logged: unknown[] = [];
        vi.useFakeTimers();
        try {
            s.scheduleSync();
            await vi.advanceTimersByTimeAsync(1000);
            await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
            server.status = 503;
            s.scheduleSync();
            await vi.advanceTimersByTimeAsync(1000);
            await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2));
        } finally {
            logged = warn.mock.calls.map((c) => c[1]);
            vi.useRealTimers();
            warn.mockRestore();
        }
        expect(logged).toEqual([
            expect.objectContaining({ spaceId: SPACE, code: "pins-rollback" }),
            expect.objectContaining({ spaceId: SPACE, code: 503 }),
        ]);
        expect(changes).toBe(2);
        expect(s.integrity).toEqual({ broken: false });
        expect(s.logEnabled).toBe(true);
    });
});

describe("KeyringClient log routes (design §3.6)", () => {
    function client(respond: (url: string, init?: RequestInit) => Response | Promise<Response>) {
        const calls: Array<{ url: string; init?: RequestInit }> = [];
        const fetch = (async (url: string, init?: RequestInit) => {
            calls.push({ url, init });
            return respond(url, init);
        }) as typeof globalThis.fetch;
        return { calls, kc: new KeyringClient({ spaceId: "sp/1", httpBaseUrl: "https://acc.test", fetch }) };
    }
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

    it("fetchLog GETs /keyring/log with since and limit", async () => {
        const { calls, kc } = client(() => json(200, { entries: [], head: null }));
        expect(await kc.fetchLog()).toEqual({ entries: [], head: null });
        await kc.fetchLog(4, 2);
        expect(calls.map((c) => c.url)).toEqual([
            "https://acc.test/api/spaces/sp%2F1/keyring/log?since=-1&limit=500",
            "https://acc.test/api/spaces/sp%2F1/keyring/log?since=4&limit=2",
        ]);
        expect(calls[0].init?.method ?? "GET").toBe("GET");
    });
    it("postLogEntry POSTs {entry}, or {entry, ec} with a commit", async () => {
        const head = { seq: 0, hash: "h" };
        const { calls, kc } = client(() => json(200, { ok: true, head }));
        const entry = { seq: 0 } as unknown as MembershipEntry;
        expect(await kc.postLogEntry(entry)).toEqual({ ok: true, head });
        await kc.postLogEntry(entry, { epoch: 0 } as never);
        expect(calls.map((c) => [c.url, c.init?.method, JSON.parse(String(c.init?.body))])).toEqual([
            ["https://acc.test/api/spaces/sp%2F1/keyring/log", "POST", { entry: { seq: 0 } }],
            ["https://acc.test/api/spaces/sp%2F1/keyring/log", "POST", { entry: { seq: 0 }, ec: { epoch: 0 } }],
        ]);
    });
    it("a refusal is a KeyringHttpError carrying the status and the JSON body", async () => {
        const body = { error: "Log moved", head: { seq: 3, hash: "h3" } };
        const { kc } = client(() => json(409, body));
        const err = await kc.postLogEntry({ seq: 0 } as unknown as MembershipEntry).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(KeyringHttpError);
        expect(err).toMatchObject({ name: "KeyringHttpError", status: 409, body, message: "KeyringClient POST /keyring/log: 409 Log moved" });
    });
    it("a non-JSON refusal keeps its status with a null body, and the query string stays out of the message", async () => {
        const { kc } = client(() => new Response("Not Found", { status: 404 }));
        const err = await kc.fetchLog(7, 9).catch((e: unknown) => e);
        expect(err).toMatchObject({ status: 404, body: null, message: "KeyringClient GET /keyring/log: 404" });
    });
    it("probeState reports the GET /keyring/state status, or \"network\" when the request fails", async () => {
        const { calls, kc } = client(() => new Response("Not Found", { status: 404 }));
        expect(await kc.probeState()).toBe(404);
        expect(calls[0].url).toBe("https://acc.test/api/spaces/sp%2F1/keyring/state");
        expect(await client(() => json(403, { error: "Not a member" })).kc.probeState()).toBe(403);
        expect(await client(() => json(401, { error: "Unauthorized" })).kc.probeState()).toBe(401);
        expect(await client(() => { throw new TypeError("Failed to fetch"); }).kc.probeState()).toBe("network");
    });
    it("probeState and the log routes go through fetchWithRecovery when given one, so a 401 is read only after a silent re-auth (design §6.9)", async () => {
        const plain: string[] = [];
        const recovering: string[] = [];
        const kc = new KeyringClient({
            spaceId: "sp/1",
            httpBaseUrl: "https://acc.test",
            fetch: (async (url: string) => {
                plain.push(url);
                return json(200, { blobs: [] });
            }) as typeof globalThis.fetch,
            fetchWithRecovery: (async (url: string, init?: RequestInit) => {
                recovering.push(`${init?.method ?? "GET"} ${url}`);
                if (url.endsWith("/keyring/state")) return new Response("Not Found", { status: 404 });
                if (init?.method === "POST") return json(200, { ok: true, head: { seq: 0, hash: "h" } });
                return json(200, { entries: [], head: null });
            }) as typeof globalThis.fetch,
        });
        expect(await kc.probeState()).toBe(404);
        await kc.fetchLog();
        await kc.postLogEntry({ seq: 0 } as unknown as MembershipEntry);
        expect(recovering).toEqual([
            "GET https://acc.test/api/spaces/sp%2F1/keyring/state",
            "GET https://acc.test/api/spaces/sp%2F1/keyring/log?since=-1&limit=500",
            "POST https://acc.test/api/spaces/sp%2F1/keyring/log",
        ]);
        await kc.fetchBlobs("bob");
        expect(plain).toEqual(["https://acc.test/api/spaces/sp%2F1/keyring/blobs/bob"]); // the other routes keep the plain fetch
    });
});
