import { describe, it, expect, afterEach, vi } from "vitest";
import { entryHash, ecBytes, keyCommit } from "../../src/spaces/trust/canonical";
import { verifyP256 } from "../../src/spaces/trust/ik";
import { KEEPER_MEMBER_ID } from "../../src/spaces/SpaceKeyring";
import { KeyringHttpError } from "../../src/spaces/KeyringClient";
import { Space } from "../../src/spaces/Space";
import { SpaceNamespace } from "../../src/core/namespaces/SpaceNamespace";
import { ChatKeyVault, type ChatKeyStore } from "../../src/core/ChatKeyVault";
import { PinStore } from "../../src/core/trust/PinStore";
import { memoryTrustStore } from "../../src/core/trust/trustStore";
import { KeyStore } from "../../src/crypto/KeyStore";
import type { WrappedPayload } from "../../src/crypto/PassphraseWrap";
import { exportEcdhPublicKey, unwrapSpaceKey } from "../../src/spaces/SpaceCipher";
import type { WrappedKey } from "../../src/spaces/types";
import { fakePersonalKv } from "../core/trust/fakes";
import { FakeLogServer } from "./trust/fakeLogServer";
import { signerFor, user } from "./trust/chainHelper";
import { channelOf, makeTrustedSpace, someEcdhPub } from "./trust/fakeSpace";

afterEach(() => vi.useRealTimers());

describe("private channels with a signed member list (design §3.5–§3.8; slice rulings S2–S5)", () => {
    it("create() on a private Space posts genesis + ec(0), then a certified join request", async () => {
        const { space, server, transport, alice } = await makeTrustedSpace({ me: "alice", visibility: "private" });
        await space.create();
        const [g] = server.entries;
        expect(g).toMatchObject({ seq: 0, prev: "", op: "genesis", by: "alice",
            body: { visibility: "private", policy: "static", appId: "app1", baseEpoch: -1, legacyCommits: {} } });
        const [ec] = server.commits;
        const { sig: _s, ...gu } = g;
        expect(ec).toMatchObject({ v: 1, epoch: 0, prevKeyed: -1, headSeq: 0, sole: true, by: "alice", ik: g.ik,
            headHash: await entryHash(gu as never) });
        expect(ec.keyCommit).toBe(await keyCommit(0, space.keyring!.rawKey(0)!, space.id));
        const { sig, ...ecu } = ec;
        expect(await verifyP256(alice.ik, sig, ecBytes(ecu as never))).toBe(true);
        expect(transport.joinRequests[0].keyCert).toBeDefined();
        expect(space.logEnabled).toBe(true);
    });
    it("create() on a public Space writes no log", async () => {
        const { space, server } = await makeTrustedSpace({ me: "alice", visibility: "public" });
        await space.create();
        expect(server.entries).toEqual([]);
        expect(space.logEnabled).toBe(false);
        expect(space.membership()).toBeNull();
    });
    it("add() looks the IK up and signs add{member (exact case), memberIk, role}", async () => {
        const { space, server, bob } = await makeTrustedSpace({ me: "alice", visibility: "private" });
        await space.create();
        await space.add("Bob"); // exact case is kept (server brief §1)
        expect(server.entries[1]).toMatchObject({ op: "add", body: { member: "Bob", memberIk: bob.ik, role: "viewer" } });
        expect(space.membership()!.map((m) => [m.id, m.role])).toEqual([["alice", "owner"], ["Bob", "viewer"]]);
    });
    it("setRole() and leave() append role and leave entries", async () => {
        const { space, server, openAs, logSyncOf } = await makeTrustedSpace({ me: "alice", visibility: "private" });
        await space.create();
        await space.add("bob", { role: "editor" });
        expect(server.entries[1]).toMatchObject({ op: "add", body: { member: "bob", role: "editor" } });
        await space.setRole("bob", "viewer");
        expect(server.entries[2]).toMatchObject({ op: "role", by: "alice", body: { member: "bob", role: "viewer" } });
        const bobSpace = await openAs("bob");
        await logSyncOf(bobSpace).sync(); // bob's view of the log, as opening the Space would load it
        expect(bobSpace.membership()!.map((m) => [m.id, m.role])).toEqual([["alice", "owner"], ["bob", "viewer"]]);
        expect(await bobSpace.leave()).toEqual({ seq: 3 });
        expect(server.entries[3]).toMatchObject({ op: "leave", by: "bob", body: {} });
        expect(bobSpace.membership()!.map((m) => m.id)).toEqual(["alice"]);
    });
    it("remove() appends; a rotation is refused on a signed Space (S4)", async () => {
        const { space, transport } = await makeTrustedSpace({ me: "alice", visibility: "private" });
        await space.create();
        await space.add("bob");
        await space.remove("bob");
        expect(space.membership()!.map((m) => m.id)).toEqual(["alice"]);
        await expect(space.rotate()).rejects.toMatchObject({ code: "log-refused" });
        expect(transport.rotations).toEqual([]);
    });
    it("the member API refuses on a Space without a log", async () => {
        const { space } = await makeTrustedSpace({ me: "alice", visibility: "public" });
        await space.create();
        await expect(space.add("bob")).rejects.toMatchObject({ name: "SpaceTrustError", code: "log-refused" });
        await expect(space.remove("bob")).rejects.toMatchObject({ code: "log-refused" });
        await expect(space.setRole("bob", "editor")).rejects.toMatchObject({ code: "log-refused" });
        await expect(space.leave()).rejects.toMatchObject({ code: "log-refused" });
    });
    it("keys are wrapped only to log members, even if /pending still lists a removed one (Review Focus 4)", async () => {
        const { space, transport } = await makeTrustedSpace({ me: "alice", visibility: "private" });
        await space.create();
        await space.add("bob");
        await space.add("carol");
        expect(space.membership()!.map((m) => m.id)).toContain("carol");
        await space.remove("carol");
        expect(space.membership()!.map((m) => m.id)).not.toContain("carol");
        transport.pending = [
            { memberId: "carol", identityEcdhPub: await someEcdhPub() },
            { memberId: "bob", identityEcdhPub: await someEcdhPub() },
        ];
        transport.wraps.length = 0;
        await space.keyring!.admitPending();
        expect(transport.wraps.map((w) => w.target)).toEqual(["bob"]);
        const admit = vi.spyOn(space.keyring!, "admit");
        channelOf(space).emitFrame({ joinRequest: { memberId: "carol", identityEcdhPub: await someEcdhPub() } });
        await new Promise((r) => setTimeout(r, 10));
        expect(admit).not.toHaveBeenCalled(); // the frame is not even tried
        expect(transport.wraps.map((w) => w.target)).toEqual(["bob"]);
        await expect(space.admit("carol", await someEcdhPub())).rejects.toThrow(/not a member of this space/);
        expect(transport.wraps.map((w) => w.target)).toEqual(["bob"]);
    });
    it.each([
        ["log-missing", -1],
        ["rollback", 0],
    ])("while integrity is broken (%s), no key is wrapped to anyone but the keeper", async (reason, toSeq) => {
        const { space, logSync, server, transport } = await makeTrustedSpace({ me: "alice", visibility: "private" });
        await space.create();
        await space.add("bob");
        await server.truncate(toSeq); // the relay drops or rolls back the log this client already verified
        await logSync.sync();
        expect(logSync.integrity).toEqual({ broken: true, reason });
        transport.pending = [{ memberId: "bob", identityEcdhPub: await someEcdhPub() }];
        transport.wraps.length = 0;
        await space.keyring!.admitPending();
        const admit = vi.spyOn(space.keyring!, "admit");
        channelOf(space).emitFrame({ joinRequest: { memberId: "bob", identityEcdhPub: await someEcdhPub() } });
        await new Promise((r) => setTimeout(r, 10));
        expect(admit).not.toHaveBeenCalled();
        await expect(space.admit("bob", await someEcdhPub())).rejects.toThrow(/not a member of this space/);
        expect(transport.wraps).toEqual([]);
        expect(space.keyring!.canWrapTo(KEEPER_MEMBER_ID)).toBe(true);
        await space.admit(KEEPER_MEMBER_ID, await someEcdhPub());
        expect(transport.wraps.map((w) => w.target)).toEqual([KEEPER_MEMBER_ID]);
    });
    it("a rotation on a broken, unlogged view re-wraps to no member", async () => {
        const { space, logSync, server, transport, openAs } = await makeTrustedSpace({ me: "alice", visibility: "private" });
        await space.create();
        await space.add("bob");
        await (await openAs("bob")).keyring!.requestKey(); // bob is on the server roster
        await server.truncate(-1);
        await logSync.sync();
        expect(logSync.logEnabled).toBe(false);
        expect(logSync.integrity).toMatchObject({ broken: true });
        transport.wraps.length = 0;
        await space.rotate();
        expect(transport.wraps).toEqual([]);
    });
    it("a Space without a log wraps to anyone who asks, as before", async () => {
        const { space, transport } = await makeTrustedSpace({ me: "alice", visibility: "public" });
        await space.create();
        transport.pending = [{ memberId: "bob", identityEcdhPub: await someEcdhPub() }];
        transport.wraps.length = 0;
        await space.keyring!.admitPending();
        channelOf(space).emitFrame({ joinRequest: { memberId: "carol", identityEcdhPub: await someEcdhPub() } });
        await vi.waitFor(() => expect(transport.wraps.map((w) => w.target)).toEqual(["bob", "carol"]));
    });
    it("an mlog frame re-syncs within a second and notifies onMembership", async () => {
        vi.useFakeTimers();
        const { space, server, bobSync } = await makeTrustedSpace({ me: "alice", visibility: "private" });
        await space.create();
        await space.add("bob");
        const seen: Array<Array<{ id: string }> | null> = [];
        space.onMembership((m) => seen.push(m));
        await bobSync.append("leave", {}); // a peer's append lands on the server
        const gets = server.gets;
        channelOf(space).emitFrame({ mlog: { seq: 2, hash: server.head!.hash } });
        await vi.advanceTimersByTimeAsync(1000);
        await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
        expect(server.gets).toBeGreaterThan(gets);
        expect(seen.at(-1)!.map((m) => m.id)).toEqual(["alice"]);
    });
});

describe("client.space wires the member list into the Spaces it builds (design §3.8)", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        KeyStore.getInstance().forget("alice");
    });

    /**
     * A SpaceNamespace for alice whose keyring routes (log included) are served in memory; no socket is opened.
     * `keeperPub` is what GET /api/app/keeper answers. Every key wrap is recorded with the log length when it
     * was posted, and every app-route POST (channel registration included) is recorded too.
     */
    async function nsWithTrust(opts: { keeperPub?: string } = {}) {
        vi.spyOn(Space.prototype, "connect").mockResolvedValue(undefined);
        const alice = await user("alice");
        const server = new FakeLogServer();
        const wraps: Array<{ target: string; from: string; wrapped: WrappedKey; logLength: number }> = [];
        const posts: Array<{ path: string; body: unknown }> = [];
        const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
        const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = new URL(String(input));
            if (url.pathname.endsWith("/keyring/wrap") && init?.method === "POST") {
                const { targetMemberId, fromMemberId, wrapped } = JSON.parse(String(init.body));
                wraps.push({ target: targetMemberId, from: fromMemberId, wrapped, logLength: server.entries.length });
                return json({ ok: true });
            }
            if (url.pathname.endsWith("/keyring/log")) {
                try {
                    if (init?.method === "POST") {
                        const { entry, ec } = JSON.parse(String(init.body));
                        return json(await server.postLogEntry(entry, ec));
                    }
                    return json(await server.fetchLog(Number(url.searchParams.get("since")), Number(url.searchParams.get("limit"))));
                } catch (e) {
                    if (e instanceof KeyringHttpError) return json(e.body, e.status);
                    throw e;
                }
            }
            if (url.pathname.endsWith("/keyring/pending")) return json({ pending: [] });
            return json({});
        }) as typeof globalThis.fetch;
        let blob: WrappedPayload | null = null;
        const vault: ChatKeyStore = { async get() { return blob; }, async put(_k, v) { blob = v; } };
        const signer = signerFor(alice);
        const store = memoryTrustStore();
        const kv = fakePersonalKv();
        const trust = {
            signer,
            directory: { lookup: async (n: string) => ({ alice: alice.ik } as Record<string, string>)[n.toLowerCase()] },
            pins: new PinStore({ http: kv.http as never, commitment: () => "c-alice", signer, store: async () => store }),
            appId: async () => "app1",
            store: async () => store,
        };
        const http = {
            baseUrl: "http://test",
            fetch,
            get: async (path: string) => (path === "/api/app/keeper" ? { pubkey: opts.keeperPub } : {}),
            post: async (path: string, body: unknown) => {
                posts.push({ path, body });
                return {};
            },
        };
        const ns = new SpaceNamespace({
            http: http as never,
            session: { username: "alice", seed: new Uint8Array(32).fill(7), commitment: "c-alice" } as never,
            wsBaseUrl: "ws://test",
            chatKeys: new ChatKeyVault(vault),
            trust: trust as never,
        });
        return { ns, server, wraps, posts };
    }

    it("createSpace({private: true}) signs the genesis + ec(0) through the keyring route and wraps to log members only", async () => {
        const { ns, server } = await nsWithTrust();
        const space = await ns.createSpace({ private: true });
        expect(server.entries.map((e) => [e.seq, e.op, e.by])).toEqual([[0, "genesis", "alice"]]);
        expect(server.entries[0].body).toMatchObject({ visibility: "private", appId: "app1" });
        expect(server.commits).toHaveLength(1);
        expect(space.logEnabled).toBe(true);
        expect(space.keyring!.canWrapTo("mallory")).toBe(false);
        expect(space.keyring!.canWrapTo("alice")).toBe(true);
        expect(space.keyring!.canWrapTo(KEEPER_MEMBER_ID)).toBe(true);
    });
    it("createSpace() without private writes no log and wraps as before", async () => {
        const { ns, server } = await nsWithTrust();
        const space = await ns.createSpace();
        expect(server.entries).toEqual([]);
        expect(space.logEnabled).toBe(false);
        expect(space.keyring!.canWrapTo("mallory")).toBe(true);
    });
    it("createChannel(name, {private: true}) seeds the keeper after the genesis, with a key the keeper can open", async () => {
        const keeper = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-384" }, true, ["deriveBits"])) as CryptoKeyPair;
        const { ns, server, wraps, posts } = await nsWithTrust({ keeperPub: await exportEcdhPublicKey(keeper.publicKey) });
        const warn = vi.spyOn(console, "warn");
        const space = await ns.createChannel("general", { private: true });
        // The keeper admit is best-effort: a refusal would only surface as this warning.
        expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("keeper admit failed"), expect.anything());
        expect(posts.find((p) => p.path === "/api/app/channels")?.body).toEqual({
            name: "general", spaceId: space.id, visibility: "private" });
        expect(server.entries.map((e) => [e.seq, e.op, e.by])).toEqual([[0, "genesis", "alice"]]);
        expect(space.logEnabled).toBe(true);
        expect(space.keyring!.canWrapTo("mallory")).toBe(false); // the member gate is live, and the keeper passes it
        // One wrap (static policy, epoch 0), to the keeper, posted once the genesis was on the server.
        expect(wraps.map((w) => [w.target, w.from, w.wrapped.epoch, w.logLength])).toEqual([[KEEPER_MEMBER_ID, "alice", 0, 1]]);
        expect(await unwrapSpaceKey(wraps[0].wrapped, keeper.privateKey)).toEqual(space.keyring!.rawKey(0));
    });
});
