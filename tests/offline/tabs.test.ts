/**
 * Two tabs of one origin: two OfflineManagers over one IndexedDB, as two tabs
 * share it.
 */
import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { IndexedDbStore } from "../../src/offline/store/IndexedDbStore";
import { OfflineManager } from "../../src/offline/OfflineManager";
import type { TryLock } from "../../src/offline/OutboundQueue";
import { SessionState } from "../../src/core/Session";
import { pack, unpack } from "../../src/offline/clock/HlcTimestamp";

beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
});

/** Web Locks' `ifAvailable`, as the tabs of one browser share it. `taken` lists every name it granted. */
function deviceLocks(): { tryLock: TryLock; taken: string[] } {
    const held = new Set<string>();
    const taken: string[] = [];
    const tryLock: TryLock = async (name, fn) => {
        if (held.has(name)) return false;
        held.add(name);
        taken.push(name);
        try {
            await fn();
            return true;
        } finally {
            held.delete(name);
        }
    };
    return { tryLock, taken };
}

async function signedIn(commitment = "c1"): Promise<SessionState> {
    const session = new SessionState();
    await session.setSession({ token: "t", username: "u", commitment });
    return session;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function entry(n: number) {
    return { hlc: pack(n, 0, "n"), clientId: `c${n}`, domain: "kv" as const, method: "set", args: { n } };
}

describe("offline queue — two tabs", () => {
    it("replays each queued write once when two tabs drain the shared queue at once", async () => {
        const session = await signedIn();
        const locks = deviceLocks();
        const tabs = [0, 1].map(() => new OfflineManager({ store: new IndexedDbStore(), session, enabled: true, locks: locks.tryLock }));
        const replayed: number[] = [];
        for (const tab of tabs) {
            tab.registerReplayer("kv", async (queued) => {
                await sleep(5);
                replayed.push((queued.args as { n: number }).n);
            });
        }
        try {
            for (const n of [1, 2, 3]) await tabs[0].enqueue(entry(n));

            await Promise.all(tabs.map((tab) => tab.queue.drain()));

            expect(replayed).toEqual([1, 2, 3]);
            expect(await tabs[1].queue.pending()).toBe(0);
            expect(locks.taken).toEqual(["muhkoo:offline-drain:c1"]);
        } finally {
            for (const tab of tabs) tab.dispose();
        }
    });

    it("drains, after another tab's drain stopped on a failure, only what is left", async () => {
        const session = await signedIn();
        const locks = deviceLocks();
        const [first, second] = [0, 1].map(() => new OfflineManager({ store: new IndexedDbStore(), session, enabled: true, locks: locks.tryLock }));
        const replayed: string[] = [];
        first.registerReplayer("kv", async (queued) => {
            const { n } = queued.args as { n: number };
            if (n === 2) throw new TypeError("Failed to fetch");   // transient: the drain stops here
            replayed.push(`first:${n}`);
        });
        second.registerReplayer("kv", async (queued) => void replayed.push(`second:${(queued.args as { n: number }).n}`));
        try {
            for (const n of [1, 2, 3]) await first.enqueue(entry(n));

            await expect(first.queue.drain()).rejects.toBeInstanceOf(TypeError);
            await second.queue.drain();

            expect(replayed).toEqual(["first:1", "second:2", "second:3"]);
            expect(await first.queue.pending()).toBe(0);
        } finally {
            first.dispose();
            second.dispose();
        }
    });

    it("replays what a tab queued while another tab was draining, once that tab has left the drain to it", async () => {
        // The second tab found the first draining and skipped its own drain,
        // but the first had read the queue before the second's write was in
        // it: one pass, and that write waited for the next time either tab
        // came back online.
        const session = await signedIn();
        const locks = deviceLocks();
        const [first, second] = [0, 1].map(() => new OfflineManager({ store: new IndexedDbStore(), session, enabled: true, locks: locks.tryLock }));
        const replayed: string[] = [];
        let reached!: () => void;
        let go!: () => void;
        const replaying = new Promise<void>((resolve) => (reached = resolve));
        const released = new Promise<void>((resolve) => (go = resolve));
        first.registerReplayer("kv", async (queued) => {
            const { n } = queued.args as { n: number };
            if (n === 1) {
                reached();
                await released;
            }
            replayed.push(`first:${n}`);
        });
        second.registerReplayer("kv", async (queued) => void replayed.push(`second:${(queued.args as { n: number }).n}`));
        try {
            await first.enqueue(entry(1));
            const draining = first.queue.drain();
            await replaying;                          // first holds the lock, its pass already read
            await second.enqueue(entry(2));
            await second.queue.drain();               // first is draining: second leaves it
            go();
            await draining;

            expect(replayed).toEqual(["first:1", "first:2"]);
            expect(await second.queue.pending()).toBe(0);
        } finally {
            first.dispose();
            second.dispose();
        }
    });

    it("drains without the lock when no one is signed in", async () => {
        const locks = deviceLocks();
        const tab = new OfflineManager({ store: new IndexedDbStore(), session: new SessionState(), enabled: true, locks: locks.tryLock });
        const replayed: number[] = [];
        tab.registerReplayer("kv", async (queued) => void replayed.push((queued.args as { n: number }).n));
        try {
            await tab.enqueue(entry(1));
            await tab.queue.drain();
            expect(replayed).toEqual([1]);
            expect(locks.taken).toEqual([]);
        } finally {
            tab.dispose();
        }
    });
});

describe("HLC node ids — two tabs", () => {
    it("gives each tab its own node id, under the device's", async () => {
        const session = await signedIn();
        const first = new OfflineManager({ store: new IndexedDbStore(), session, enabled: true });
        await first.ready();
        const second = new OfflineManager({ store: new IndexedDbStore(), session, enabled: true });
        await second.ready();
        try {
            const a = unpack(await first.nextHlc()).nodeId;
            const b = unpack(await second.nextHlc()).nodeId;
            const device = await new IndexedDbStore().get<string>("meta", "nodeId");

            expect(a).not.toBe(b);
            expect(device).toBeTruthy();
            expect(a.startsWith(`${device}.`)).toBe(true);
            expect(b.startsWith(`${device}.`)).toBe(true);
        } finally {
            first.dispose();
            second.dispose();
        }
    });

    it("never mints one stamp in two tabs", async () => {
        const session = await signedIn();
        const first = new OfflineManager({ store: new IndexedDbStore(), session, enabled: true });
        await first.ready();
        const second = new OfflineManager({ store: new IndexedDbStore(), session, enabled: true });
        await second.ready();
        try {
            const mint = (tab: OfflineManager) => Promise.all(Array.from({ length: 200 }, () => tab.nextHlc()));
            const [a, b] = await Promise.all([mint(first), mint(second)]);
            expect(new Set([...a, ...b]).size).toBe(400);
        } finally {
            first.dispose();
            second.dispose();
        }
    });

    it("still gives two tabs that start together on a new device distinct node ids", async () => {
        const session = await signedIn();
        const tabs = [0, 1].map(() => new OfflineManager({ store: new IndexedDbStore(), session, enabled: true }));
        try {
            const ids = await Promise.all(tabs.map(async (tab) => unpack(await tab.nextHlc()).nodeId));
            expect(ids[0]).not.toBe(ids[1]);
        } finally {
            for (const tab of tabs) tab.dispose();
        }
    });
});
