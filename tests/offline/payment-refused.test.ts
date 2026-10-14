/**
 * Queued writes the accelerator refuses for payment (accelerator spec
 * 2026-10-06-paid-accounts-and-past-due, D8 and B8). Kept, in order, with everything queued after them,
 * until the next reconnect or until `client.app.access()` reports the app allowed. Never dropped, never
 * retried in a loop, and never sent under another user's session.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { IndexedDbStore } from "../../src/offline/store/IndexedDbStore";
import { OutboundQueue, type TryLock } from "../../src/offline/OutboundQueue";
import { OfflineManager } from "../../src/offline/OfflineManager";
import { SessionState } from "../../src/core/Session";
import { HttpError } from "../../src/core/HttpClient";
import { PaymentRequiredError } from "../../src/core/PaymentRequiredError";
import { pack } from "../../src/offline/clock/HlcTimestamp";
import { EventCore, EventCoreEvents } from "../../src/events/EventCore";
import type { QueueEntry } from "../../src/offline/store/OfflineStore";

beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
});

function entry(n: number, domain: QueueEntry["domain"] = "kv", method = "set") {
    return { hlc: pack(n, 0, "n"), clientId: `c${n}`, domain, method, args: { n } };
}

const refused = () => new PaymentRequiredError("Cloud Drive is for paid Muhkoo plans.", "user_plan_required");
const nOf = (e: QueueEntry) => (e.args as { n: number }).n;

/** Web Locks' `ifAvailable`, as one browser's tabs share it. */
function deviceLocks(): TryLock {
    const held = new Set<string>();
    return async (name, fn) => {
        if (held.has(name)) return false;
        held.add(name);
        try {
            await fn();
            return true;
        } finally {
            held.delete(name);
        }
    };
}

/** Every SYNC_ERROR emitted while `fn` runs. */
async function syncErrors(fn: () => Promise<void>): Promise<unknown[]> {
    const seen: unknown[] = [];
    const on = (e: CustomEvent) => seen.push(e.detail);
    EventCore.on(EventCoreEvents.SYNC_ERROR, on);
    try {
        await fn();
    } finally {
        EventCore.off(EventCoreEvents.SYNC_ERROR, on);
    }
    return seen;
}

describe("offline queue — writes refused for payment", () => {
    it("keeps a write refused for payment and every write after it, in order, and stops there", async () => {
        const queue = new OutboundQueue(new IndexedDbStore());
        const tried: number[] = [];
        queue.register("kv", async (e) => {
            tried.push(nOf(e));
            if (nOf(e) === 2) throw refused();
        });
        for (const n of [1, 2, 3]) await queue.enqueue(entry(n));

        await queue.drain();   // resolves: a refusal for payment is not the drain failing

        expect(tried).toEqual([1, 2]);                  // 3 waits behind 2
        expect(await queue.pending()).toBe(2);
    });

    it("tells the app the write is waiting, not that it was dropped", async () => {
        const queue = new OutboundQueue(new IndexedDbStore());
        queue.register("kv", async () => {
            throw refused();
        });
        await queue.enqueue(entry(1));

        const errors = await syncErrors(() => queue.drain());

        expect(errors).toEqual([
            { domain: "kv", method: "set", error: "Cloud Drive is for paid Muhkoo plans.", code: "user_plan_required", dropped: false },
        ]);
    });

    it("sends them, in order, on the next drain once the server accepts them", async () => {
        const queue = new OutboundQueue(new IndexedDbStore());
        let paid = false;
        const sent: number[] = [];
        queue.register("kv", async (e) => {
            if (!paid) throw refused();
            sent.push(nOf(e));
        });
        for (const n of [1, 2, 3]) await queue.enqueue(entry(n));
        await queue.drain();
        expect(sent).toEqual([]);

        paid = true;
        await queue.drain();

        expect(sent).toEqual([1, 2, 3]);
        expect(await queue.pending()).toBe(0);
    });

    it("keeps a refused upload and the delete queued after it, which waits behind it", async () => {
        // Head of line: the delete would be allowed, but it is not sent before the upload ahead of it.
        const queue = new OutboundQueue(new IndexedDbStore());
        const deletes: number[] = [];
        queue.register("file", async () => {
            throw new PaymentRequiredError("Cloud Drive can't save changes right now.", "owner_payment_past_due");
        });
        queue.register("db", async (e) => void deletes.push(nOf(e)));
        await queue.enqueue(entry(1, "file", "putShard"));
        await queue.enqueue(entry(2, "db", "delete"));

        await queue.drain();

        expect(deletes).toEqual([]);
        expect(await queue.pending()).toBe(2);
    });

    it("does not loop when the drain holds the device-wide lock", async () => {
        // Under the lock, a drain goes round again while the queue is not empty, for writes another tab
        // queued meanwhile. A kept write leaves it not empty, so the drain must stop at the kept write
        // instead of asking the server again at once, and again, without end.
        const queue = new OutboundQueue(new IndexedDbStore(), { tryLock: deviceLocks(), commitment: () => "c1" });
        let tries = 0;
        queue.register("kv", async () => {
            tries++;
            throw refused();
        });
        await queue.enqueue(entry(1));

        await queue.drain();

        expect(tries).toBe(1);
        expect(await queue.pending()).toBe(1);
    }, 2_000);

    it("still drops a write refused with any other 402, as before", async () => {
        // A guard: Free-tier quota refusals carry no code and are permanent, as they always were.
        const queue = new OutboundQueue(new IndexedDbStore());
        const sent: number[] = [];
        queue.register("kv", async (e) => {
            if (nOf(e) === 1) throw new HttpError("KV write quota exceeded", 402, { quotaExceeded: true });
            sent.push(nOf(e));
        });
        await queue.enqueue(entry(1));
        await queue.enqueue(entry(2));

        const errors = await syncErrors(() => queue.drain());

        expect(sent).toEqual([2]);
        expect(await queue.pending()).toBe(0);
        expect(errors).toEqual([expect.objectContaining({ domain: "kv", dropped: true })]);
    });
});

describe("offline queue — two users on one device", () => {
    // Every tab of an origin shares one queue, and a replayer builds its request from whoever is signed in
    // when it runs. A write kept for payment waits as long as the refusal lasts, so it must never go out
    // under the next user's session: it would land in their space, and a fixed key would overwrite theirs.

    it("never sends one user's kept write under another user's session, and sends it once its user is back", async () => {
        let who = "c-alice";
        const queue = new OutboundQueue(new IndexedDbStore(), { commitment: () => who });
        let paid = false;
        const sent: string[] = [];
        queue.register("kv", async (e) => {
            if (!paid) throw refused();
            sent.push(`${nOf(e)} as ${who}`);
        });
        await queue.enqueue(entry(1));      // alice's
        await queue.drain();                // refused for payment: kept

        who = "c-bob";                      // alice signs out; bob, on a paid plan, signs in
        paid = true;
        await queue.enqueue(entry(2));      // bob's
        await queue.drain();

        expect(sent).toEqual(["2 as c-bob"]);
        expect(await queue.pending()).toBe(1);          // alice's, untouched
        expect(await queue.waiting()).toEqual([]);      // nothing of bob's

        who = "c-alice";                    // alice signs in again
        await queue.drain();

        expect(sent).toEqual(["2 as c-bob", "1 as c-alice"]);
        expect(await queue.pending()).toBe(0);
    });

    it("does not loop over another user's writes when the drain holds the device-wide lock", async () => {
        // Under the lock, a drain goes round again while writes remain. Another user's never leave, so a
        // drain that counted them would ask for the queue again at once, and again, without end.
        let who = "c-alice";
        const queue = new OutboundQueue(new IndexedDbStore(), { tryLock: deviceLocks(), commitment: () => who });
        let tries = 0;
        queue.register("kv", async () => void tries++);
        await queue.enqueue(entry(1));      // alice's, queued while offline
        who = "c-bob";

        await queue.drain();

        expect(tries).toBe(0);
        expect(await queue.pending()).toBe(1);
    }, 2_000);

    it("still sends an entry an older SDK queued without saying whose it is", async () => {
        // A guard: entries queued before this version carry no commitment, and replay as they always did.
        const store = new IndexedDbStore();
        await store.enqueue(entry(1));      // straight into the store, as an older SDK wrote it
        const queue = new OutboundQueue(store, { commitment: () => "c-bob" });
        const sent: number[] = [];
        queue.register("kv", async (e) => void sent.push(nOf(e)));

        await queue.drain();

        expect(sent).toEqual([1]);
        expect(await queue.pending()).toBe(0);
    });
});

describe("OfflineManager.resume — after client.app.access() reports the app allowed", () => {
    async function unlocked(): Promise<SessionState> {
        const session = new SessionState();
        await session.setSession({ token: "t", username: "alice", commitment: "c1" });
        session.setIdentity({} as never);
        return session;
    }

    it("sends the writes kept after a refusal for payment, once", async () => {
        const manager = new OfflineManager({ store: new IndexedDbStore(), session: await unlocked(), enabled: true });
        let paid = false;
        const sent: number[] = [];
        manager.registerReplayer("kv", async (e) => {
            if (!paid) throw refused();
            sent.push(nOf(e));
        });
        try {
            await manager.enqueue(entry(1));
            await manager.queue.drain();
            paid = true;

            await manager.resume();

            expect(sent).toEqual([1]);
            expect(await manager.queue.pending()).toBe(0);
        } finally {
            manager.dispose();
        }
    });

    it("does nothing when nothing is waiting: no drain, so no 'syncing' for the app to show", async () => {
        const manager = new OfflineManager({ store: new IndexedDbStore(), session: await unlocked(), enabled: true });
        const run = vi.spyOn(manager.sync, "run");
        const states: string[] = [];
        manager.onStatusChange((s) => states.push(s));
        try {
            await manager.resume();
            expect(run).not.toHaveBeenCalled();
            expect(states).toEqual([]);
        } finally {
            manager.dispose();
        }
    });

    it("does nothing when only another user's writes are waiting", async () => {
        const session = await unlocked();
        const manager = new OfflineManager({ store: new IndexedDbStore(), session, enabled: true });
        const run = vi.spyOn(manager.sync, "run");
        try {
            await manager.enqueue(entry(1));                                                 // alice's
            await session.setSession({ token: "t2", username: "bob", commitment: "c2" });   // bob signs in
            await manager.resume();
            expect(run).not.toHaveBeenCalled();
            expect(await manager.queue.pending()).toBe(1);
        } finally {
            manager.dispose();
        }
    });

    it("sends nothing while the session is locked; the writes stay queued", async () => {
        const session = new SessionState();
        await session.setSession({ token: "t", username: "alice", commitment: "c1" });   // no identity: locked
        const manager = new OfflineManager({ store: new IndexedDbStore(), session, enabled: true });
        const sent: number[] = [];
        manager.registerReplayer("kv", async (e) => void sent.push(nOf(e)));
        try {
            await manager.enqueue(entry(1));
            await manager.resume();
            expect(sent).toEqual([]);
            expect(await manager.queue.pending()).toBe(1);
        } finally {
            manager.dispose();
        }
    });
});
