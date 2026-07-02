/**
 * client.db offline behavior: read-through caching of get/query, optimistic
 * + queued writes, and replay on reconnect. DB rows are server-plaintext, so
 * they're cached as-is. Uses a toggleable in-memory table behind a fake fetch.
 */

import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { DbNamespace } from "../../src/core/namespaces/DbNamespace";
import { HttpClient } from "../../src/core/HttpClient";
import { OfflineManager } from "../../src/offline/OfflineManager";
import { IndexedDbStore } from "../../src/offline/store/IndexedDbStore";
import { DbCache } from "../../src/offline/DbCache";

beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
});

function tableFetch() {
    const rows = new Map<number, Record<string, unknown>>();
    let nextId = 1;
    const fetchFn = (async (input: any, init: any) => {
        const url = new URL(typeof input === "string" ? input : input.url);
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(init.body) : {};
        const parts = url.pathname.split("/").filter(Boolean); // api db :table [:id|query]
        const tail = parts.slice(2); // after /api/db
        const reply = (obj: unknown, status = 200) =>
            new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

        if (tail.length === 1 && method === "POST") {
            const id = nextId++;
            const row = { _id: id, ...(body.values ?? {}) };
            rows.set(id, row);
            return reply({ row, id }, 201);
        }
        if (tail[1] === "query" && method === "POST") {
            return reply({ rows: Array.from(rows.values()), nextCursor: null });
        }
        const id = Number(tail[1]);
        if (method === "GET") {
            const row = rows.get(id);
            return row ? reply({ row }) : reply({ error: "not found" }, 404);
        }
        if (method === "PATCH") {
            const row = { ...(rows.get(id) ?? { _id: id }), ...(body.values ?? {}) };
            rows.set(id, row);
            return reply({ row });
        }
        if (method === "DELETE") {
            const deleted = rows.delete(id) ? 1 : 0;
            return reply({ deleted });
        }
        return reply({ error: "not found" }, 404);
    }) as unknown as typeof fetch;
    return { fetchFn, rows };
}

async function makeOfflineDb() {
    const { fetchFn: online, rows } = tableFetch();
    let isOnline = true;
    const fetchFn = (async (input: any, init: any) => {
        if (!isOnline) throw new TypeError("Failed to fetch");
        return online(input, init);
    }) as typeof fetch;

    const manager = new OfflineManager({
        store: new IndexedDbStore(),
        session: { isAuthenticated: true, isUnlocked: true } as never,
        enabled: true,
    });
    await manager.ready();
    const http = new HttpClient({ baseUrl: "http://t", apiKey: "mk_test_pk_x", getSessionToken: () => null, fetch: fetchFn });
    const db = new DbNamespace({ http, offline: new DbCache(manager) });
    manager.registerReplayer("db", (e) => db.replay(e));
    return { db, rows, manager, setOnline: (v: boolean) => (isOnline = v) };
}

describe("client.db — offline", () => {
    it("serves get() from cache while offline after an online read", async () => {
        const { db, setOnline } = await makeOfflineDb();
        const todos = db.table("todos");
        const { id } = await todos.insert({ title: "first" });
        // Prime the row cache with an online get.
        await todos.get(id as number);

        setOnline(false);
        const cached = await todos.get(id as number);
        expect(cached).toMatchObject({ title: "first" });
    });

    it("serves query() pages from cache while offline", async () => {
        const { db, setOnline } = await makeOfflineDb();
        const todos = db.table("todos");
        await todos.insert({ title: "a" });
        await todos.insert({ title: "b" });
        await todos.query({ limit: 50 }); // cache the page

        setOnline(false);
        const page = await todos.query({ limit: 50 });
        expect(page.rows).toHaveLength(2);
    });

    it("queues an offline update, applies it optimistically, then replays", async () => {
        const { db, rows, manager, setOnline } = await makeOfflineDb();
        const todos = db.table("todos");
        const { id } = await todos.insert({ title: "draft", done: false });
        await todos.get(id as number); // prime cache

        setOnline(false);
        await todos.update(id as number, { done: true });

        // Optimistic: local cache reflects it; server does not yet.
        expect(await todos.get(id as number)).toMatchObject({ done: true });
        expect(rows.get(id as number)).toMatchObject({ done: false });
        expect(await manager.queue.pending()).toBe(1);

        setOnline(true);
        await manager.queue.drain();
        expect(rows.get(id as number)).toMatchObject({ done: true });
        expect(await manager.queue.pending()).toBe(0);
    });

    it("queues an offline delete and replays it", async () => {
        const { db, rows, manager, setOnline } = await makeOfflineDb();
        const todos = db.table("todos");
        const { id } = await todos.insert({ title: "temp" });

        setOnline(false);
        expect(await todos.delete(id as number)).toBe(1); // optimistic
        setOnline(true);
        await manager.queue.drain();
        expect(rows.has(id as number)).toBe(false);
    });
});
