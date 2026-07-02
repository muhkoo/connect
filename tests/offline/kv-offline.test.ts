/**
 * client.kv offline behavior: optimistic writes + durable queue + read-through
 * cache + replay on reconnect. Uses a toggleable fake personal-space fetch and
 * a real identity (so at-rest ciphertext is exercised), over an IndexedDbStore.
 */

import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { KvNamespace } from "../../src/core/namespaces/KvNamespace";
import { HttpClient } from "../../src/core/HttpClient";
import { SessionState } from "../../src/core/Session";
import { deriveIdentity } from "../../src/auth/identity";
import { OfflineManager } from "../../src/offline/OfflineManager";
import { IndexedDbStore } from "../../src/offline/store/IndexedDbStore";
import { KvCache } from "../../src/offline/KvCache";
import { StorageCipher } from "../../src/crypto/StorageCipher";

const BASE_URL = "http://localhost:8787";
const COMMITMENT = "98765432109876543210";

beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
});

function personalSpaceFetch() {
    const store = new Map<string, unknown>();
    const fetchFn = (async (input: any, init: any) => {
        const url = new URL(typeof input === "string" ? input : input.url);
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(init.body) : {};
        const tail = url.pathname.split("/").filter(Boolean).slice(3);
        const reply = (obj: unknown, status = 200) =>
            new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
        if (tail[0] === "list") return reply({ keys: Array.from(store.keys()) });
        if (tail[0] === "kv") {
            const key = decodeURIComponent(tail[1]);
            if (tail[2] === "get") return reply({ key, value: store.get(key) ?? null });
            if (method === "POST") {
                store.set(key, body.value);
                return reply({ ok: true });
            }
            if (method === "DELETE") {
                const existed = store.delete(key);
                return reply({ ok: true, existed });
            }
        }
        return reply({ error: "not found" }, 404);
    }) as unknown as typeof fetch;
    return { fetchFn, store };
}

async function makeOfflineKv() {
    const { fetchFn: online, store } = personalSpaceFetch();
    let isOnline = true;
    const fetchFn = (async (input: any, init: any) => {
        if (!isOnline) throw new TypeError("Failed to fetch");
        return online(input, init);
    }) as typeof fetch;

    const session = new SessionState();
    await session.setSession({ token: "t".repeat(64), username: "alice", commitment: COMMITMENT });
    session.setIdentity(await deriveIdentity("alice", "correct horse battery staple"));

    const manager = new OfflineManager({ store: new IndexedDbStore(), session, enabled: true });
    await manager.ready();
    const cache = new KvCache(manager);
    const http = new HttpClient({ baseUrl: BASE_URL, getSessionToken: () => session.token, fetch: fetchFn });
    const kv = new KvNamespace({ http, session, wsBaseUrl: "ws://localhost:8787", offline: cache });
    manager.registerReplayer("kv", (e) => kv.replay(e));

    return { kv, store, manager, setOnline: (v: boolean) => (isOnline = v) };
}

describe("client.kv — offline", () => {
    it("serves reads from cache while offline after an online write", async () => {
        const { kv, setOnline } = await makeOfflineKv();
        await kv.set("todos", "t1", { title: "buy milk" });

        setOnline(false);
        const got = await kv.get<{ title: string }>("todos", "t1");
        expect(got).toEqual({ title: "buy milk" });
    });

    it("queues an offline write, applies it optimistically, then replays on reconnect", async () => {
        const { kv, store, manager, setOnline } = await makeOfflineKv();

        setOnline(false);
        await kv.set("todos", "t2", { title: "offline todo" });

        // Optimistic: readable locally; durably queued; NOT yet on the server.
        expect(await kv.get<{ title: string }>("todos", "t2")).toEqual({ title: "offline todo" });
        expect(await manager.queue.pending()).toBe(1);
        expect(store.has("todos/t2")).toBe(false);

        // Reconnect → drain → the write lands server-side as ciphertext.
        setOnline(true);
        await manager.queue.drain();
        expect(await manager.queue.pending()).toBe(0);
        expect(StorageCipher.isEnvelope(store.get("todos/t2"))).toBe(true);
    });

    it("offline list reflects cached + un-synced keys", async () => {
        const { kv, setOnline } = await makeOfflineKv();
        await kv.set("todos", "t1", { a: 1 });
        setOnline(false);
        await kv.set("todos", "t2", { a: 2 }); // offline create
        const ids = await kv.list("todos");
        expect(ids.sort()).toEqual(["t1", "t2"]);
    });

    it("offline delete tombstones locally and replays", async () => {
        const { kv, store, manager, setOnline } = await makeOfflineKv();
        await kv.set("todos", "t1", { a: 1 });

        setOnline(false);
        expect(await kv.delete("todos", "t1")).toBe(true);
        expect(await kv.get("todos", "t1")).toBeNull(); // tombstoned in cache

        setOnline(true);
        await manager.queue.drain();
        expect(store.has("todos/t1")).toBe(false); // delete reached the server
    });
});
