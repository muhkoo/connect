import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SpaceNamespace } from "../../src/core/namespaces/SpaceNamespace";
import { Space } from "../../src/spaces/Space";
import { ChatKeyVault, type ChatKeyStore } from "../../src/core/ChatKeyVault";
import { KeyStore } from "../../src/crypto/KeyStore";
import { IdentityLockedError } from "../../src/core/trust/errors";
import type { WrappedPayload } from "../../src/crypto/PassphraseWrap";
import type { Replayer } from "../../src/offline/OutboundQueue";
import type { QueueEntry } from "../../src/offline/store/OfflineStore";
import { Client } from "../../src/core/Client";
import type { SessionState } from "../../src/core/Session";

const ME = "alice";

function setup(seed: Uint8Array | null, replies: Record<string, unknown> = {}, offline?: unknown, chatKeys?: ChatKeyVault) {
    const posted: string[] = [];
    // KeyringClient (join-request, blobs, metadata) goes through http.fetch, not http.post.
    const fetched: string[] = [];
    let blob: WrappedPayload | null = null;
    const store: ChatKeyStore = { async get() { return blob; }, async put(_k, v) { blob = v; } };
    const http = {
        baseUrl: "http://test",
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
            fetched.push(`${init?.method ?? "GET"} ${String(input)}`);
            return new Response("{}");
        }) as typeof fetch,
        get: async (path: string) => replies[path] ?? {},
        post: async (path: string) => { posted.push(path); return {}; },
        del: async () => ({}),
    };
    const session = { username: ME, seed, commitment: "c-alice" };
    const ns = new SpaceNamespace({
        http: http as never,
        session: session as never,
        wsBaseUrl: "ws://test",
        chatKeys: chatKeys ?? new ChatKeyVault(store),
        offline: offline as never,
    });
    return { ns, posted, fetched, session };
}

describe("a locked session never opens a Space (design §3.3 table)", () => {
    beforeEach(() => KeyStore.getInstance().forget(ME));
    afterEach(() => vi.restoreAllMocks());

    it("get() returns a Space with admission locked; connect refuses; join resolves false; nothing is sent", async () => {
        const { ns, posted } = setup(null);
        const space = await ns.get("space-1");
        expect(space.admission).toBe("locked");
        await expect(space.connect()).rejects.toBeInstanceOf(IdentityLockedError);
        expect(await space.join()).toBe(false);
        expect(posted).toEqual([]); // no ticket, no join-request
        expect(KeyStore.getInstance().getKeyPair(ME)).toBeNull();
    });

    // A timeout far past the test's own: a join that waited for a key would hang the test.
    it("joinSpace() returns a locked Space at once: join resolves false, no ticket, no join-request (§3.3)", async () => {
        const { ns, posted, fetched } = setup(null);
        const join = vi.spyOn(Space.prototype, "join");
        const space = await ns.joinSpace("space-3", { timeoutMs: 60_000 });
        expect(space.admission).toBe("locked");
        expect(space.keyring).toBeUndefined();
        expect(join).toHaveBeenCalledTimes(1);
        await expect(join.mock.results[0]!.value).resolves.toBe(false);
        expect(posted).toEqual([]); // no ticket
        // Only the unauthenticated policy read: no join-request, no blob pull, no member write.
        expect(fetched).toEqual(["GET http://test/api/spaces/space-3/metadata"]);
        expect(KeyStore.getInstance().getKeyPair(ME)).toBeNull();
    });

    it("joinChannel() resolves the name, then returns a locked Space the same way (§3.3)", async () => {
        const { ns, posted, fetched } = setup(null, { "/api/app/channels/general": { spaceId: "space-4" } });
        const join = vi.spyOn(Space.prototype, "join");
        const space = await ns.joinChannel("general", { timeoutMs: 60_000 });
        expect(space.id).toBe("space-4");
        expect(space.admission).toBe("locked");
        expect(space.keyring).toBeUndefined();
        expect(join).toHaveBeenCalledTimes(1);
        await expect(join.mock.results[0]!.value).resolves.toBe(false);
        expect(posted).toEqual([]);
        expect(fetched).toEqual(["GET http://test/api/spaces/space-4/metadata"]);
        expect(KeyStore.getInstance().getKeyPair(ME)).toBeNull();
    });

    it("createChannel throws IdentityLockedError before any request", async () => {
        const { ns, posted } = setup(null);
        await expect(ns.createChannel("general")).rejects.toBeInstanceOf(IdentityLockedError);
        expect(posted).toEqual([]);
    });

    it("createSpace({messaging:false}) still works while locked (the VFS content Space), and is not locked", async () => {
        const { ns, posted } = setup(null);
        const space = await ns.createSpace({ private: true, messaging: false });
        expect(posted).toHaveLength(1);
        expect(posted[0]).toMatch(/^\/api\/spaces\/.+\/metadata$/);
        // A files-only Space has no keyring and no identity, so the lock does not apply to it (§3.3).
        expect(space.admission).not.toBe("locked");
        expect(space.keyring).toBeUndefined();
    });

    it("an unlocked Space starts requesting and turns keyed once the keyring holds a key", async () => {
        const { ns } = setup(new Uint8Array(32).fill(3));
        const space = await ns.get("space-2");
        expect(space.admission).toBe("requesting");
        const seen: string[] = [];
        space.onAdmission((s) => seen.push(s));
        await space.keyring!.bootstrapNew();
        expect(space.admission).toBe("keyed");
        expect(seen).toEqual(["keyed"]);
    });
});

describe("the offline replayer after sign-in (design §3.3)", () => {
    afterEach(() => vi.restoreAllMocks());

    it("reopens a Space that was built while locked, instead of replaying into it", async () => {
        KeyStore.getInstance().forget(ME);
        const replayers = new Map<string, Replayer>();
        const offline = { enabled: true, store: {}, registerReplayer: (d: string, r: Replayer) => replayers.set(d, r) };
        const { ns, session } = setup(null, {}, offline);
        const locked = await ns.get("space-9");
        expect(locked.admission).toBe("locked");
        session.seed = new Uint8Array(32).fill(5); // the user signed in again
        const connected: Space[] = [];
        vi.spyOn(Space.prototype, "connect").mockImplementation(async function (this: Space) {
            connected.push(this);
        });
        vi.spyOn(Space.prototype, "isConnected").mockReturnValue(true);
        const sent: unknown[] = [];
        vi.spyOn(Space.prototype, "sendRaw").mockImplementation((f: unknown) => void sent.push(f));
        const entry = { seq: 1, hlc: "h", clientId: "c", domain: "space", method: "sendRaw", args: { spaceId: "space-9", frame: { spaceMessage: "x" } } };
        await replayers.get("space")!(entry as QueueEntry);
        expect(connected).toHaveLength(1);
        expect(connected[0]).not.toBe(locked);
        expect(connected[0]!.admission).toBe("requesting");
        expect(sent).toEqual([{ spaceMessage: "x" }]);
    });
});

describe("a files-only Space (messaging: false) needs no identity, locked or not (design §3.3)", () => {
    beforeEach(() => KeyStore.getInstance().forget(ME));

    const brokenVault = () => {
        const calls: string[] = [];
        const store: ChatKeyStore = {
            async get() { calls.push("get"); throw new Error("503"); },
            async put() { calls.push("put"); throw new Error("503"); },
        };
        return { vault: new ChatKeyVault(store), calls };
    };

    it("an unlocked namespace whose vault throws still creates the VFS content Space, and reopens it, not locked", async () => {
        const { vault, calls } = brokenVault();
        const { ns, posted } = setup(new Uint8Array(32).fill(3), {}, undefined, vault);

        const created = await ns.createSpace({ private: true, messaging: false });
        expect(posted).toEqual([`/api/spaces/${encodeURIComponent(created.id)}/metadata`]);
        expect(created.admission).not.toBe("locked");
        expect(created.keyring).toBeUndefined();

        const reopened = await ns.get(created.id, "static", { messaging: false });
        expect(reopened.admission).not.toBe("locked");
        expect(reopened.keyring).toBeUndefined();

        expect(calls).toEqual([]); // the chat-key vault is never asked
        expect(KeyStore.getInstance().getKeyPair(ME)).toBeNull();
    });

    it("client.vfs reaches its content Space with the chat-key vault down", async () => {
        const requests: string[] = [];
        const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
        const client = new Client({
            baseUrl: "http://test",
            apiKey: "mk_test_pk_x",
            fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input);
                requests.push(`${init?.method ?? "GET"} ${url}`);
                if (url.includes("/kv/chat-keys")) return json({ error: "unavailable" }, 503);
                if (url.endsWith("/kv/vfs%2Fspace/get")) return json({ value: "vfs-space-1" });
                return json({});
            }) as typeof fetch,
        } as never);
        const session = (client as unknown as { session: SessionState }).session;
        await session.setSession({ token: "tok", username: ME, commitment: "c-alice" });
        session.setSeed(new Uint8Array(32).fill(3));
        const content = (client.vfs as unknown as { deps: { content: { release(m: unknown): Promise<void> } } }).deps.content;

        await content.release({ chunks: [{ shardHashes: ["h1"] }], size: 3 });

        expect(requests).toContain("POST http://test/api/storage/release");
        expect(requests.filter((r) => r.includes("chat-keys"))).toEqual([]);
    });
});
