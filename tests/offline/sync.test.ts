import { describe, it, expect, vi, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { IndexedDbStore } from "../../src/offline/store/IndexedDbStore";
import { OutboundQueue } from "../../src/offline/OutboundQueue";
import { SyncEngine } from "../../src/offline/SyncEngine";
import { ConnectivityManager } from "../../src/offline/ConnectivityManager";
import { HttpError } from "../../src/core/HttpClient";
import { pack } from "../../src/offline/clock/HlcTimestamp";

beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
});

describe("OutboundQueue", () => {
    it("replays in HLC order and clears each entry on success", async () => {
        const store = new IndexedDbStore();
        const queue = new OutboundQueue(store);
        const replayed: number[] = [];
        queue.register("kv", async (e) => {
            replayed.push((e.args as { n: number }).n);
        });

        await queue.enqueue({ hlc: pack(2, 0, "n"), clientId: "c", domain: "kv", method: "set", args: { n: 2 } });
        await queue.enqueue({ hlc: pack(1, 0, "n"), clientId: "c", domain: "kv", method: "set", args: { n: 1 } });

        await queue.drain();
        expect(replayed).toEqual([1, 2]);
        expect(await queue.pending()).toBe(0);
    });

    it("drops a permanently-rejected (4xx) write but keeps draining", async () => {
        const store = new IndexedDbStore();
        const queue = new OutboundQueue(store);
        const ok: number[] = [];
        queue.register("kv", async (e) => {
            const n = (e.args as { n: number }).n;
            if (n === 1) throw new HttpError("bad request", 400, null);
            ok.push(n);
        });
        await queue.enqueue({ hlc: pack(1, 0, "n"), clientId: "c", domain: "kv", method: "set", args: { n: 1 } });
        await queue.enqueue({ hlc: pack(2, 0, "n"), clientId: "c", domain: "kv", method: "set", args: { n: 2 } });

        await queue.drain();
        expect(ok).toEqual([2]); // the 4xx entry was dropped, the next one ran
        expect(await queue.pending()).toBe(0);
    });

    it("stops on a transient (network) failure and keeps the entry", async () => {
        const store = new IndexedDbStore();
        const queue = new OutboundQueue(store);
        let attempts = 0;
        queue.register("kv", async () => {
            attempts++;
            throw new TypeError("Failed to fetch"); // transient
        });
        await queue.enqueue({ hlc: pack(1, 0, "n"), clientId: "c", domain: "kv", method: "set", args: {} });

        await expect(queue.drain()).rejects.toBeInstanceOf(TypeError);
        expect(attempts).toBe(1);
        expect(await queue.pending()).toBe(1); // still queued for next reconnect
    });
});

describe("SyncEngine", () => {
    it("drains the queue then runs catch-up tasks, gated by canSync", async () => {
        const store = new IndexedDbStore();
        const queue = new OutboundQueue(store);
        const connectivity = new ConnectivityManager();
        let canSync = false;
        const engine = new SyncEngine({ queue, connectivity, canSync: () => canSync });

        const order: string[] = [];
        queue.register("kv", async () => void order.push("drain"));
        engine.registerCatchUp(async () => void order.push("catchup"));
        await queue.enqueue({ hlc: pack(1, 0, "n"), clientId: "c", domain: "kv", method: "set", args: {} });

        // Locked → no-op.
        await engine.run();
        expect(order).toEqual([]);

        canSync = true;
        await engine.run();
        expect(order).toEqual(["drain", "catchup"]);
        expect(connectivity.current).toBe("online");
    });

    it("coalesces concurrent runs into one", async () => {
        const store = new IndexedDbStore();
        const queue = new OutboundQueue(store);
        const connectivity = new ConnectivityManager();
        const engine = new SyncEngine({ queue, connectivity, canSync: () => true });
        const task = vi.fn(async () => {});
        engine.registerCatchUp(task);

        await Promise.all([engine.run(), engine.run(), engine.run()]);
        expect(task).toHaveBeenCalledTimes(1);
    });
});
