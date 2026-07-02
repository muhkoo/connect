import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { IndexedDbStore } from "../../src/offline/store/IndexedDbStore";
import { pack } from "../../src/offline/clock/HlcTimestamp";

// Reset the in-memory IndexedDB between tests so each starts from a clean DB.
beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
});

describe("IndexedDbStore", () => {
    it("round-trips get/put/delete on a keyed store", async () => {
        const store = new IndexedDbStore();
        await store.put("kv-cache", "c1|todos/a", { v: 1 });
        expect(await store.get("kv-cache", "c1|todos/a")).toEqual({ v: 1 });
        await store.delete("kv-cache", "c1|todos/a");
        expect(await store.get("kv-cache", "c1|todos/a")).toBeNull();
    });

    it("prefix-scans in key order and isolates by prefix", async () => {
        const store = new IndexedDbStore();
        await store.put("kv-cache", "c1|todos/b", 2);
        await store.put("kv-cache", "c1|todos/a", 1);
        await store.put("kv-cache", "c1|notes/x", 9);
        await store.put("kv-cache", "c2|todos/a", 7);
        const todos = await store.prefix<number>("kv-cache", "c1|todos/");
        expect(todos.map((e) => e.key)).toEqual(["c1|todos/a", "c1|todos/b"]);
        expect(todos.map((e) => e.value)).toEqual([1, 2]);
    });

    it("range-scans handle-ordered space messages", async () => {
        const store = new IndexedDbStore();
        for (const h of ["s1|003", "s1|001", "s1|002", "s2|001"]) {
            await store.put("space-messages", h, { h });
        }
        const range = await store.range("space-messages", "s1|", "s1|￿");
        expect(range.map((e) => e.key)).toEqual(["s1|001", "s1|002", "s1|003"]);
    });

    it("durable queue: enqueue assigns seq, queued() returns HLC order", async () => {
        const store = new IndexedDbStore();
        // Enqueue out of HLC order; queued() must sort by hlc.
        await store.enqueue({ hlc: pack(3, 0, "n"), clientId: "c", domain: "kv", method: "set", args: { id: 3 } });
        await store.enqueue({ hlc: pack(1, 0, "n"), clientId: "c", domain: "kv", method: "set", args: { id: 1 } });
        await store.enqueue({ hlc: pack(2, 0, "n"), clientId: "c", domain: "kv", method: "set", args: { id: 2 } });
        const queued = await store.queued();
        expect(queued.map((q) => (q.args as { id: number }).id)).toEqual([1, 2, 3]);
        expect(queued.every((q) => typeof q.seq === "number")).toBe(true);

        // Dequeue the middle entry by its seq.
        const mid = queued[1];
        await store.dequeue(mid.seq);
        const after = await store.queued();
        expect(after.map((q) => (q.args as { id: number }).id)).toEqual([1, 3]);
    });

    it("persists across reconnections to the same database", async () => {
        const a = new IndexedDbStore();
        await a.put("meta", "nodeId", "node-123");
        // A fresh store instance opens the same underlying DB.
        const b = new IndexedDbStore();
        expect(await b.get("meta", "nodeId")).toBe("node-123");
    });
});
