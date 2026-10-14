/**
 * A shard upload made with a stale session (accelerator spec 2026-10-06-paid-accounts-and-past-due, B5
 * and B8). On a paid-only app the accelerator refuses a PUT without a valid session with
 * `401 session_required`. A tab left open for over a day holds such a session, so every upload path
 * re-establishes the session once and sends the PUT again, as `HttpClient`'s own requests always have.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { HttpClient } from "../../src/core/HttpClient";
import { Client } from "../../src/core/Client";
import { SessionState } from "../../src/core/Session";
import { ShardClient, type ShardByteCache } from "../../src/storage/transport/ShardClient";
import { SpaceNamespace } from "../../src/core/namespaces/SpaceNamespace";
import { MessageNamespace } from "../../src/core/namespaces/MessageNamespace";
import { StorageNamespace } from "../../src/core/namespaces/FileNamespace";
import { KvNamespace } from "../../src/core/namespaces/KvNamespace";
import { ChatKeyVault, type ChatKeyStore } from "../../src/core/ChatKeyVault";
import { IndexedDbStore } from "../../src/offline/store/IndexedDbStore";
import { pack } from "../../src/offline/clock/HlcTimestamp";
import type { WrappedPayload } from "../../src/crypto/PassphraseWrap";

const BASE_URL = "http://test";
const HASH = "cd".repeat(32);

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * An accelerator that refuses a shard PUT made with the stale token, `401 session_required`, as a
 * paid-only app does, and accepts everything else. A re-authentication swaps the token for a fresh one.
 * `puts` records the token each PUT carried.
 */
function staleSession() {
    const session = { username: "alice", seed: new Uint8Array(32).fill(7), commitment: "c-alice", token: "stale" };
    const puts: Array<string | null> = [];
    const onUnauthorized = vi.fn(async () => {
        session.token = "fresh";
        return true;
    });
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const token = new Headers(init?.headers).get("X-Muhkoo-Session");
        if ((init?.method ?? "GET") === "PUT" && url.includes("/api/shards/")) {
            puts.push(token);
            if (token !== "fresh") return json({ error: "A signed-in session is required", code: "session_required" }, 401);
            return json({ ok: true, dedup: false });
        }
        return json({ ok: true });
    }) as typeof fetch;
    const http = new HttpClient({ baseUrl: BASE_URL, getSessionToken: () => session.token, fetch: fetchFn, onUnauthorized });
    return { session, http, puts, onUnauthorized };
}

/** Every PUT sent with the stale token was sent again with the fresh one, after one re-authentication at least. */
function expectRecovered(puts: Array<string | null>, onUnauthorized: { mock: { calls: unknown[] } }) {
    expect(onUnauthorized.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(puts.filter((t) => t === "stale").length).toBeGreaterThanOrEqual(1);
    expect(puts.filter((t) => t === "fresh").length).toBe(puts.filter((t) => t === "stale").length);
}

describe("ShardClient — a PUT with a stale session", () => {
    it("re-establishes the session once and sends the PUT again", async () => {
        const { http, puts, onUnauthorized } = staleSession();
        const shards = new ShardClient({ baseUrl: BASE_URL, fetch: http.fetch, fetchWithRecovery: http.fetchWithRecovery });
        await expect(shards.putShard(HASH, new Uint8Array([1, 2, 3]))).resolves.toEqual({ dedup: false });
        expect(puts).toEqual(["stale", "fresh"]);
        expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });

    it("tries once: a PUT still refused after re-authentication fails", async () => {
        const { http, puts, onUnauthorized } = staleSession();
        onUnauthorized.mockImplementation(async () => true);   // "recovered", but the token stays stale
        const shards = new ShardClient({ baseUrl: BASE_URL, fetch: http.fetch, fetchWithRecovery: http.fetchWithRecovery });
        await expect(shards.putShard(HASH, new Uint8Array([1]))).rejects.toThrow(/failed \(401\)/);
        expect(puts).toEqual(["stale", "stale"]);
        expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });

    it("re-establishes the session for a background upload too, which then lands rather than waiting in the queue", async () => {
        const { http, puts } = staleSession();
        const bytes = new Map<string, Uint8Array>();
        const cache: ShardByteCache = { get: async (h) => bytes.get(h) ?? null, put: async (h, b) => void bytes.set(h, b) };
        const deferred: string[] = [];
        const shards = new ShardClient({
            baseUrl: BASE_URL,
            fetch: http.fetch,
            fetchWithRecovery: http.fetchWithRecovery,
            cache,
            backgroundUpload: true,
            deferUpload: async (h) => void deferred.push(h),
        });
        await shards.putShard(HASH, new Uint8Array([4, 5]));
        await vi.waitFor(() => expect(puts).toEqual(["stale", "fresh"]));
        expect(deferred).toEqual([]);
    });

    it("reads keep the plain fetch: a read never re-authenticates", async () => {
        const { http, onUnauthorized } = staleSession();
        const shards = new ShardClient({ baseUrl: BASE_URL, fetch: http.fetch, fetchWithRecovery: http.fetchWithRecovery });
        await shards.hasShard(HASH);
        expect(onUnauthorized).not.toHaveBeenCalled();
    });
});

describe("every upload path re-establishes a stale session", () => {
    const FILE = new Uint8Array(Array.from({ length: 64 }, (_, i) => i));

    it("a files-only Space (client.vfs's content space)", async () => {
        const { http, session, puts, onUnauthorized } = staleSession();
        const ns = new SpaceNamespace({ http, session: session as never, wsBaseUrl: "ws://test" });
        const space = await ns.get("space-files", "static", { messaging: false });
        await space.putFile(FILE, { name: "a.bin", type: "application/octet-stream" });
        expectRecovered(puts, onUnauthorized);
    });

    it("a Space with messaging", async () => {
        const { http, session, puts, onUnauthorized } = staleSession();
        let blob: WrappedPayload | null = null;
        const store: ChatKeyStore = { async get() { return blob; }, async put(_k, v) { blob = v; } };
        const ns = new SpaceNamespace({ http, session: session as never, wsBaseUrl: "ws://test", chatKeys: new ChatKeyVault(store) });
        const space = await ns.get("space-chat");
        await space.putFile(FILE, { name: "a.bin", type: "application/octet-stream" });
        expectRecovered(puts, onUnauthorized);
    });

    it("a room (client.message.room)", async () => {
        const { http, session, puts, onUnauthorized } = staleSession();
        const messages = new MessageNamespace({ http, session: session as never, wsBaseUrl: "ws://test" });
        await messages.room("general").putFile(FILE, { name: "a.bin", type: "application/octet-stream" });
        expectRecovered(puts, onUnauthorized);
    });

    it("client.storage.writeFile", async () => {
        const { http, session, puts, onUnauthorized } = staleSession();
        const kv = new KvNamespace({ http, session: session as never, wsBaseUrl: "ws://test" });
        const storage = new StorageNamespace({ http, baseUrl: BASE_URL, kv });
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});   // the discovery mirror needs an identity
        try {
            await storage.writeFile({ spaceId: "space-1", data: FILE, metadata: { name: "a.bin", type: "application/octet-stream" } });
        } finally {
            warn.mockRestore();
        }
        expectRecovered(puts, onUnauthorized);
    });
});

describe("the offline queue's replay of a deferred upload", () => {
    beforeEach(() => {
        globalThis.indexedDB = new IDBFactory();
        // The Cache API, in memory: the replay reads the deferred bytes from it.
        const cached = new Map<string, Uint8Array>();
        vi.stubGlobal("caches", {
            open: async () => ({
                match: async (key: string) => (cached.has(key) ? new Response(cached.get(key) as BodyInit) : undefined),
                put: async (key: string, res: Response) => void cached.set(key, new Uint8Array(await res.arrayBuffer())),
            }),
        });
    });
    afterEach(() => vi.unstubAllGlobals());

    it("re-establishes the session and sends the upload, rather than leaving it queued", async () => {
        const puts: Array<string | null> = [];
        const client = new Client({
            baseUrl: BASE_URL,
            apiKey: "mk_test_pk_x",
            offline: { enabled: true, store: new IndexedDbStore() },
            fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
                const sent = new Headers(init?.headers).get("X-Muhkoo-Session");
                if ((init?.method ?? "GET") === "PUT" && String(input).includes("/api/shards/")) {
                    puts.push(sent);
                    if (sent !== "fresh") return json({ error: "A signed-in session is required", code: "session_required" }, 401);
                    return json({ ok: true, dedup: false });
                }
                return json({ ok: true });
            }) as typeof fetch,
        });
        const session = (client as unknown as { session: SessionState }).session;
        await session.setSession({ token: "stale", username: "alice", commitment: "c-alice" });
        vi.spyOn(client.auth.zk, "recover").mockImplementation(async () => {
            await session.setSession({ token: "fresh", username: "alice", commitment: "c-alice" });
            return true;
        });
        try {
            await client.offline.fileCache!.put(HASH, new Uint8Array([9, 9]));
            await client.offline.enqueue({ hlc: pack(1, 0, "n"), clientId: "c1", domain: "file", method: "putShard", args: { hash: HASH } });

            await client.offline.queue.drain();

            expect(puts).toEqual(["stale", "fresh"]);
            expect(await client.offline.queue.pending()).toBe(0);
        } finally {
            client.offline.dispose();
        }
    });
});
