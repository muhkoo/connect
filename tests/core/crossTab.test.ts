/**
 * The browser's cross-tab coordination, in Node: `navigator.locks` is a fake
 * that grants as one browser does, the BroadcastChannel is Node's own,
 * which reaches every other channel of the same name in the process, and
 * IndexedDB is `fake-indexeddb`, one per test, which every coordinator of
 * that test shares as the tabs of one origin do.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { drainLock, vfsCoordinator } from "../../src/core/crossTab";
import { VfsConflictError } from "../../src/vfs/types";
import { VfsNamespace } from "../../src/vfs/VfsNamespace";
import type { VfsCoordinator } from "../../src/vfs/coordinator";
import { makeContent, makeStore } from "../vfs/harness";

/**
 * Web Locks as one browser grants them: one holder per name, the rest in
 * order; `ifAvailable`; `signal`; and `mode: "shared"`, for any number of
 * holders at once. Shared holds are asked for only with `ifAvailable`, as
 * the move locks are, so none waits here, and nothing waits for one.
 */
function fakeWebLocks() {
    const tails = new Map<string, Promise<void>>();
    const held = new Set<string>();
    const shared = new Map<string, number>();   // shared holders, by name
    const asked: string[] = [];
    return {
        asked,
        async request<T>(
            name: string,
            options: { ifAvailable?: boolean; signal?: AbortSignal; mode?: "exclusive" | "shared" },
            callback: (lock: unknown) => Promise<T>,
        ): Promise<T> {
            if (options.mode === "shared") {
                asked.push(`${name} (shared)`);
                if (!options.ifAvailable) throw new Error("this fake grants a shared lock only with ifAvailable");
                if (held.has(name) || tails.has(name)) return callback(null);
                shared.set(name, (shared.get(name) ?? 0) + 1);
                try {
                    return await callback({ name, mode: "shared" });
                } finally {
                    const left = shared.get(name)! - 1;
                    if (left > 0) shared.set(name, left);
                    else shared.delete(name);
                }
            }
            asked.push(name);
            if (options.ifAvailable && (held.has(name) || tails.has(name) || shared.has(name))) return callback(null);
            const before = tails.get(name) ?? Promise.resolve();
            let release!: () => void;
            const mine = new Promise<void>((resolve) => (release = resolve));
            const tail = before.then(() => mine);
            tails.set(name, tail);
            try {
                await new Promise<void>((resolve, reject) => {
                    options.signal?.addEventListener("abort", () => reject(new DOMException("The lock request was aborted", "AbortError")));
                    void before.then(resolve);
                });
            } catch (err) {
                release();   // its place in line passes straight on
                void tail.then(() => {
                    if (tails.get(name) === tail) tails.delete(name);
                });
                throw err;
            }
            held.add(name);
            try {
                return await callback({ name, mode: "exclusive" });
            } finally {
                held.delete(name);
                release();
                if (tails.get(name) === tail) tails.delete(name);
            }
        },
    };
}

function inABrowserTab() {
    const locks = fakeWebLocks();
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { locks });
    return locks;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

/** What `promise` settles to, or "still pending" if it has not within `ms`. */
const within = <T>(promise: Promise<T>, ms = 1000): Promise<T | "still pending"> =>
    Promise.race([promise, new Promise<"still pending">((resolve) => setTimeout(() => resolve("still pending"), ms))]);

/**
 * An IndexedDB slow to open: each open asked for is made in `real` only
 * `ms` later - or, without `ms`, once `settle` is called - and its events
 * passed on. `opens` counts the opens asked for, and `opened` settles once
 * one of them has succeeded.
 */
function slowOpen(real: IDBFactory, ms?: number) {
    let opens = 0;
    const held: Array<() => void> = [];
    let succeeded!: () => void;
    const opened = new Promise<void>((resolve) => (succeeded = resolve));
    const factory = {
        open(name: string, version?: number) {
            opens++;
            const request: Record<string, unknown> = {};
            const on = (event: string) => (request[`on${event}`] as ((event?: unknown) => void) | undefined);
            const go = () => {
                const inner = real.open(name, version);
                Object.defineProperty(request, "result", { get: () => inner.result });
                inner.onupgradeneeded = (event) => on("upgradeneeded")?.(event);
                inner.onsuccess = () => {
                    on("success")?.();
                    succeeded();
                };
                inner.onerror = () => on("error")?.();
                inner.onblocked = () => on("blocked")?.();
            };
            if (ms === undefined) held.push(go);
            else setTimeout(go, ms);
            return request;
        },
    };
    return {
        factory,
        get opens() {
            return opens;
        },
        opened,
        settle: () => {
            for (const go of held.splice(0)) go();
        },
    };
}

/**
 * An IndexedDB whose first `hung` opens never answer - no success, error or
 * blocked, unless the test fires one - and whose later opens are made in
 * `real`. `requests` holds every open asked for, in order.
 */
function hungOpens(real: IDBFactory, hung: number) {
    const requests: Array<Record<string, unknown>> = [];
    const factory = {
        open(name: string, version?: number) {
            const request = requests.length < hung ? {} : (real.open(name, version) as unknown as Record<string, unknown>);
            requests.push(request);
            return request;
        },
    };
    return { factory, requests };
}

/** Fake `setTimeout` and the clock, and nothing else: fake-indexeddb runs on `setImmediate`. */
const fakeTimers = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("cross-tab coordination", () => {
    it("is off outside a browser tab", () => {
        vi.stubGlobal("navigator", { locks: fakeWebLocks() });
        expect(typeof window).toBe("undefined");
        expect(vfsCoordinator(() => "c1")).toBeUndefined();
        expect(drainLock()).toBeUndefined();
    });

    it("is off in a browser without Web Locks", () => {
        vi.stubGlobal("window", {});
        vi.stubGlobal("navigator", {});
        expect(vfsCoordinator(() => "c1")).toBeUndefined();
        expect(drainLock()).toBeUndefined();
    });

    it("holds one lock per user and record, one tab at a time", async () => {
        const locks = inABrowserTab();
        const a = vfsCoordinator(() => "c1")!;
        const b = vfsCoordinator(() => "c1")!;
        try {
            const order: string[] = [];
            let release!: () => void;
            const first = a.lock("r1", async () => {
                order.push("a in");
                await new Promise<void>((resolve) => (release = resolve));
                order.push("a out");
            });
            await tick();
            const second = b.lock("r1", async () => void order.push("b in"));
            await tick();
            expect(order).toEqual(["a in"]);
            release();
            await Promise.all([first, second]);
            expect(order).toEqual(["a in", "a out", "b in"]);
            expect(locks.asked).toEqual(["muhkoo:vfs:c1:r1", "muhkoo:vfs:c1:r1"]);
        } finally {
            a.close();
            b.close();
        }
    });

    it("tells the user's other tabs which record it wrote, and not itself", async () => {
        inABrowserTab();
        const a = vfsCoordinator(() => "c1")!;
        const b = vfsCoordinator(() => "c1")!;
        const heardByA: Array<string | null> = [];
        const heardByB: Array<string | null> = [];
        a.onAnnounce((id) => heardByA.push(id));
        b.onAnnounce((id) => heardByB.push(id));
        try {
            a.listen();
            b.listen();
            a.announce("r1");
            await vi.waitFor(() => expect(heardByB).toEqual([null, "r1"]));
            await tick();
            expect(heardByA).toEqual([null]);
        } finally {
            a.close();
            b.close();
        }
    });

    it("announces on muhkoo:vfs:<commitment> as { id, writer }, hears others' writers, and ignores its own", async () => {
        inABrowserTab();
        const a = vfsCoordinator(() => "c1")!;
        const wire = new globalThis.BroadcastChannel("muhkoo:vfs:c1");
        const onWire: unknown[] = [];
        wire.onmessage = (event) => void onWire.push(event.data);
        const heard: Array<string | null> = [];
        a.onAnnounce((id) => heard.push(id));
        try {
            a.listen();
            a.announce("r1");
            await vi.waitFor(() => expect(onWire).toHaveLength(1));
            const sent = onWire[0] as { id: unknown; writer: unknown };
            expect(sent.id).toBe("r1");
            expect(typeof sent.writer).toBe("string");

            wire.postMessage({ id: "r2", writer: "another tab" });
            wire.postMessage({ id: "r3", writer: sent.writer });   // its own writer id, as if it came back
            wire.postMessage({ id: "r4", writer: "another tab" });
            await vi.waitFor(() => expect(heard).toEqual([null, "r2", "r4"]));
        } finally {
            wire.close();
            a.close();
        }
    });

    it("follows a change of user: hears the new user's tabs, not the old one's, and says it may have missed some", async () => {
        const locks = inABrowserTab();
        let who = "alice";
        const tab = vfsCoordinator(() => who)!;
        const alice = vfsCoordinator(() => "alice")!;
        const bob = vfsCoordinator(() => "bob")!;
        const heard: Array<string | null> = [];
        tab.onAnnounce((id) => heard.push(id));
        try {
            tab.listen();
            tab.listen();
            expect(heard).toEqual([null]);              // once: it is hearing alice's tabs now
            who = "bob";
            await tab.lock("r1", async () => {});
            expect(heard).toEqual([null, null]);        // bob's now: what bob's tabs said before was missed
            expect(locks.asked).toEqual(["muhkoo:vfs:bob:r1"]);
            alice.announce("from-alice");
            bob.announce("from-bob");
            await vi.waitFor(() => expect(heard).toEqual([null, null, "from-bob"]));
            await tick();
            expect(heard).toEqual([null, null, "from-bob"]);
        } finally {
            tab.close();
            alice.close();
            bob.close();
        }
    });

    it("gives up waiting for a lock another tab has held too long, with a conflict, and writes nothing", async () => {
        inABrowserTab();
        const a = vfsCoordinator(() => "c1")!;
        const b = vfsCoordinator(() => "c1", { lockWaitMs: 30 })!;
        try {
            let release!: () => void;
            const holding = a.lock("r1", () => new Promise<void>((resolve) => (release = resolve)));
            await tick();
            let ran = false;
            await expect(b.lock("r1", async () => void (ran = true))).rejects.toThrow(VfsConflictError);
            expect(ran).toBe(false);
            release();
            await holding;
            await expect(b.lock("r1", async () => "after")).resolves.toBe("after");
        } finally {
            a.close();
            b.close();
        }
    });

    it("passes on what the write itself throws, an abort included, and a write longer than the wait is not cut short", async () => {
        inABrowserTab();
        const a = vfsCoordinator(() => "c1", { lockWaitMs: 30 })!;
        try {
            const abort = new DOMException("the request was aborted", "AbortError");
            await expect(a.lock("r1", async () => { throw abort; })).rejects.toBe(abort);
            await expect(
                a.lock("r1", async () => {
                    await new Promise((resolve) => setTimeout(resolve, 80));
                    return "landed";
                }),
            ).resolves.toBe("landed");
        } finally {
            a.close();
        }
    });

    it("writes without a lock when no one is signed in", async () => {
        const locks = inABrowserTab();
        const a = vfsCoordinator(() => null)!;
        try {
            await expect(a.lock("r1", async () => "ran")).resolves.toBe("ran");
            expect(locks.asked).toEqual([]);
        } finally {
            a.close();
        }
    });

    it("holds an entry's move lock, muhkoo:vfs:<commitment>:moving:<id>, until it is let go, and no tab can have it meanwhile", async () => {
        const locks = inABrowserTab();
        const a = vfsCoordinator(() => "c1")!;
        const b = vfsCoordinator(() => "c1")!;
        try {
            const release = await a.holdMoving("e1");
            expect(release).toBeTypeOf("function");
            expect(await b.holdMoving("e1")).toBeNull();
            expect(await a.holdMoving("e1")).toBeNull();     // nor the same tab, a second time
            const other = await b.holdMoving("e2");
            expect(other).toBeTypeOf("function");
            release!();
            await tick();
            const after = await b.holdMoving("e1");
            expect(after).toBeTypeOf("function");
            after!();
            other!();
            expect(locks.asked).toEqual([
                "muhkoo:vfs:c1:moving:e1",
                "muhkoo:vfs:c1:moving:e1",
                "muhkoo:vfs:c1:moving:e1",
                "muhkoo:vfs:c1:moving:e2",
                "muhkoo:vfs:c1:moving:e1",
            ]);
        } finally {
            a.close();
            b.close();
        }
    });

    it("gives this tab an entry's move lock again straight after it let go of it, before the browser has", async () => {
        // The browser lets go of a lock only once the callback's promise has
        // settled. Asked for again at once - a move or a delete straight after
        // another of the same entry in this tab - it was still held, and this
        // tab's own lock refused it.
        const locks = inABrowserTab();
        const a = vfsCoordinator(() => "c1")!;
        try {
            const first = await a.holdMoving("e1");
            first!();
            const again = await a.holdMoving("e1");
            expect(again).toBeTypeOf("function");
            again!();
            expect(locks.asked).toEqual(["muhkoo:vfs:c1:moving:e1", "muhkoo:vfs:c1:moving:e1"]);
        } finally {
            a.close();
        }
    });

    it("holds no move lock when no one is signed in", async () => {
        const locks = inABrowserTab();
        const a = vfsCoordinator(() => null)!;
        try {
            expect(await a.holdMoving("e1")).toBeTypeOf("function");
            expect(await a.holdMoving("e1")).toBeTypeOf("function");
            expect(locks.asked).toEqual([]);
        } finally {
            a.close();
        }
    });

    it("writes, moves and deletes without the locks where the browser refuses Web Locks, and asks no more", async () => {
        // An opaque origin - a sandboxed iframe, a data: document - or a site
        // whose data the user has blocked: Web Locks refuse with a
        // SecurityError, in every tab of the site alike.
        vi.stubGlobal("window", {});
        const refusal = new DOMException("Access to the Locks API is denied in this context.", "SecurityError");
        const asked: string[] = [];
        vi.stubGlobal("navigator", {
            locks: {
                request: (name: string) => {
                    asked.push(name);
                    return Promise.reject(refusal);
                },
            },
        });
        for (const first of ["lock", "holdMoving"]) {
            asked.length = 0;
            const a = vfsCoordinator(() => "c1")!;
            try {
                if (first === "holdMoving") expect(await a.holdMoving("e1")).toBeTypeOf("function");
                await expect(a.lock("r1", async () => "written")).resolves.toBe("written");
                await expect(a.lock("r1", async () => "again")).resolves.toBe("again");
                const release = await a.holdMoving("e1");
                expect(release).toBeTypeOf("function");
                expect(await a.holdMoving("e1")).toBeTypeOf("function");
                expect(await a.holdMoving("d1", true)).toBeTypeOf("function");
                release!();
                expect(asked).toHaveLength(1);   // refused once: not asked again
            } finally {
                a.close();
            }
        }
    });

    it("passes on any other refusal of a lock, rather than writing or waiting for ever", async () => {
        vi.stubGlobal("window", {});
        const refusal = new DOMException("the document is not fully active", "InvalidStateError");
        vi.stubGlobal("navigator", { locks: { request: () => Promise.reject(refusal) } });
        const a = vfsCoordinator(() => "c1")!;
        try {
            let ran = false;
            await expect(a.lock("r1", async () => void (ran = true))).rejects.toBe(refusal);
            expect(ran).toBe(false);
            await expect(a.holdMoving("e1")).rejects.toBe(refusal);
        } finally {
            a.close();
        }
    });

    it("passes on a SecurityError that the write or the drain itself throws, runs it once, and goes on asking for locks", async () => {
        const locks = inABrowserTab();
        const a = vfsCoordinator(() => "c1")!;
        const tryLock = drainLock()!;
        const denied = new DOMException("denied", "SecurityError");
        try {
            let runs = 0;
            await expect(a.lock("r1", async () => { runs++; throw denied; })).rejects.toBe(denied);
            await expect(tryLock("muhkoo:offline-drain:c1", async () => { runs++; throw denied; })).rejects.toBe(denied);
            expect(runs).toBe(2);
            await a.lock("r1", async () => {});
            await tryLock("muhkoo:offline-drain:c1", async () => {});
            expect(locks.asked).toEqual(["muhkoo:vfs:c1:r1", "muhkoo:offline-drain:c1", "muhkoo:vfs:c1:r1", "muhkoo:offline-drain:c1"]);
        } finally {
            a.close();
        }
    });

    it("hears nothing, rather than failing, where the browser refuses a BroadcastChannel", async () => {
        const locks = inABrowserTab();
        let made = 0;
        vi.stubGlobal(
            "BroadcastChannel",
            class {
                constructor() {
                    made++;
                    throw new DOMException("Can't create BroadcastChannel in an opaque origin", "SecurityError");
                }
            },
        );
        const a = vfsCoordinator(() => "c1")!;
        const heard: Array<string | null> = [];
        a.onAnnounce((id) => heard.push(id));
        try {
            a.listen();
            a.listen();
            a.announce("r1");
            await expect(a.lock("r1", async () => "written")).resolves.toBe("written");
            expect(heard).toEqual([null]);   // told once that it may have missed some
            expect(made).toBe(1);            // and not asked again for the same user
            expect(locks.asked).toEqual(["muhkoo:vfs:c1:r1"]);
        } finally {
            a.close();
        }
    });

    it("shares a folder's move lock among moves into it, in one tab or two, and keeps it from a move or delete of the folder", async () => {
        const locks = inABrowserTab();
        const a = vfsCoordinator(() => "c1")!;
        const b = vfsCoordinator(() => "c1")!;
        try {
            const intoA = await a.holdMoving("d1", true);
            const intoB = await b.holdMoving("d1", true);
            const intoA2 = await a.holdMoving("d1", true);   // a second move into it, in the same tab
            expect([intoA, intoB, intoA2].map((release) => typeof release)).toEqual(["function", "function", "function"]);
            expect(await a.holdMoving("d1")).toBeNull();
            expect(await b.holdMoving("d1")).toBeNull();
            intoA!();
            intoA2!();
            await tick();
            expect(await a.holdMoving("d1")).toBeNull();     // b's is still held
            intoB!();
            await tick();
            const whole = await b.holdMoving("d1");
            expect(whole).toBeTypeOf("function");
            expect(await a.holdMoving("d1", true)).toBeNull();
            whole!();
            expect(locks.asked).toEqual([
                "muhkoo:vfs:c1:moving:d1 (shared)",
                "muhkoo:vfs:c1:moving:d1 (shared)",
                "muhkoo:vfs:c1:moving:d1 (shared)",
                "muhkoo:vfs:c1:moving:d1",
                "muhkoo:vfs:c1:moving:d1",
                "muhkoo:vfs:c1:moving:d1",
                "muhkoo:vfs:c1:moving:d1",
                "muhkoo:vfs:c1:moving:d1 (shared)",
            ]);
        } finally {
            a.close();
            b.close();
        }
    });

    it("gives this tab a folder's move lock straight after it let go of it, held shared or not", async () => {
        // As for one entry's move lock: the browser has not let go of it yet.
        inABrowserTab();
        const a = vfsCoordinator(() => "c1")!;
        try {
            const whole = await a.holdMoving("d1");
            whole!();
            const into = await a.holdMoving("d1", true);
            expect(into).toBeTypeOf("function");
            const into2 = await a.holdMoving("d1", true);
            expect(into2).toBeTypeOf("function");
            into!();
            into2!();
            const again = await a.holdMoving("d1");
            expect(again).toBeTypeOf("function");
            again!();
        } finally {
            a.close();
        }
    });

    it("drains only when no other tab is draining", async () => {
        const locks = inABrowserTab();
        const tryLock = drainLock()!;
        let release!: () => void;
        const first = tryLock("muhkoo:offline-drain:c1", () => new Promise<void>((resolve) => (release = resolve)));
        await tick();
        let ran = false;
        await expect(tryLock("muhkoo:offline-drain:c1", async () => void (ran = true))).resolves.toBe(false);
        expect(ran).toBe(false);
        release();
        await expect(first).resolves.toBe(true);
        expect(locks.asked).toEqual(["muhkoo:offline-drain:c1", "muhkoo:offline-drain:c1"]);
    });

    it("drains without the lock where the browser refuses Web Locks, and passes on any other refusal", async () => {
        vi.stubGlobal("window", {});
        let refusal = new DOMException("Access to the Locks API is denied in this context.", "SecurityError");
        let asked = 0;
        vi.stubGlobal("navigator", {
            locks: {
                request: () => {
                    asked++;
                    return Promise.reject(refusal);
                },
            },
        });
        const tryLock = drainLock()!;
        let ran = 0;
        await expect(tryLock("muhkoo:offline-drain:c1", async () => void ran++)).resolves.toBe(true);
        await expect(tryLock("muhkoo:offline-drain:c1", async () => void ran++)).resolves.toBe(true);
        expect(ran).toBe(2);
        expect(asked).toBe(1);   // refused once: not asked again

        refusal = new DOMException("the document is not fully active", "InvalidStateError");
        await expect(drainLock()!("muhkoo:offline-drain:c1", async () => void ran++)).rejects.toBe(refusal);
        expect(ran).toBe(2);
    });
});

describe("cross-tab coordination — how often each folder has been written", () => {
    it("counts a write only once its IndexedDB transaction has completed", async () => {
        inABrowserTab();
        const a = vfsCoordinator(() => "c1")!;
        const completed: string[] = [];
        const transaction = IDBDatabase.prototype.transaction;
        const spy = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
            const tx = transaction.apply(this, args);
            // Not the one that makes the database.
            if (tx.mode !== "versionchange") tx.addEventListener("complete", () => completed.push(tx.mode));
            return tx;
        });
        try {
            const [before] = await a.counters(["r1"]);
            await a.begin("r1");
            expect(completed).toEqual(["readonly", "readwrite"]);
            const counted = await a.bump("r1");
            expect(completed).toEqual(["readonly", "readwrite", "readwrite"]);   // stored by the time it said so
            expect(counted).toBeTypeOf("string");
            expect(counted).not.toBe(before);
        } finally {
            spy.mockRestore();
            a.close();
        }
    });

    it("reads what the last count wrote, and nothing for a record whose write has begun and not been counted", async () => {
        inABrowserTab();
        const a = vfsCoordinator(() => "c1")!;
        try {
            const [r1, r2] = await a.counters(["r1", "r2"]);
            expect(r1).toBeTypeOf("string");
            expect(await a.begin("r1")).toBe(r1);                       // as the last write left it
            expect(await a.counters(["r1", "r2"])).toEqual([null, r2]);  // being written
            const counted = await a.bump("r1");
            expect(counted).not.toBe(r1);
            expect(await a.counters(["r1", "r2"])).toEqual([counted, r2]);
            // In a database of its own, not the offline layer's.
            expect((await indexedDB.databases()).map((db) => db.name)).toEqual(["muhkoo.vfs"]);
        } finally {
            a.close();
        }
    });

    it("leaves a record whose write a tab began and never counted out of date for every tab, until a later write of it is counted", async () => {
        inABrowserTab();
        const a = vfsCoordinator(() => "c1")!;
        const b = vfsCoordinator(() => "c1")!;
        try {
            const [before] = await b.counters(["r1"]);
            await a.begin("r1");
            a.close();                                    // the tab goes before its write is counted
            expect(await b.counters(["r1"])).toEqual([null]);
            expect(await b.begin("r1")).not.toBe(before); // no copy read before can hold this
            const counted = await b.bump("r1");
            expect(counted).not.toBe(before);
            expect(await b.counters(["r1"])).toEqual([counted]);
        } finally {
            b.close();
        }
    });

    it("shares one user's counts between that user's tabs, not with another user's, and follows a change of user", async () => {
        inABrowserTab();
        let who = "c1";
        const a = vfsCoordinator(() => "c1")!;
        const b = vfsCoordinator(() => "c1")!;
        const other = vfsCoordinator(() => "c2")!;
        const tab = vfsCoordinator(() => who)!;
        try {
            const [mine] = await b.counters(["r1"]);
            const [theirs] = await other.counters(["r1"]);
            await a.begin("r1");
            const counted = await a.bump("r1");
            expect(counted).not.toBe(mine);
            expect(await b.counters(["r1"])).toEqual([counted]);
            expect(await other.counters(["r1"])).toEqual([theirs]);
            expect(await tab.counters(["r1"])).toEqual([counted]);
            who = "c2";
            expect(await tab.counters(["r1"])).toEqual([theirs]);
        } finally {
            for (const coordinator of [a, b, other, tab]) coordinator.close();
        }
    });

    it("counts nothing when no one is signed in", async () => {
        inABrowserTab();
        const a = vfsCoordinator(() => null)!;
        try {
            expect(await a.counters(["r1"])).toEqual([null]);
            expect(await a.begin("r1")).toBeNull();
            expect(await a.bump("r1")).toBeNull();
            expect(await indexedDB.databases()).toEqual([]);
        } finally {
            a.close();
        }
    });

    it("tells nothing, rather than failing, when IndexedDB will not open, so that every copy is read again", async () => {
        const refusing = { open: () => { throw new DOMException("denied", "SecurityError"); } };
        const failing = {
            open: () => {
                const request: { onerror?: () => void } = {};
                setTimeout(() => request.onerror?.(), 0);
                return request;
            },
        };
        for (const idb of [refusing, failing, undefined]) {
            inABrowserTab();
            vi.stubGlobal("indexedDB", idb);
            const a = vfsCoordinator(() => "c1")!;
            try {
                expect(await a.counters(["r1", "r2"])).toEqual([null, null]);
                expect(await a.begin("r1")).toBeNull();
                expect(await a.bump("r1")).toBeNull();
                await expect(a.lock("r1", async () => "written")).resolves.toBe("written");
            } finally {
                a.close();
                vi.unstubAllGlobals();
            }
        }
    });

    it("gives up waiting for an IndexedDB open that does not settle, telling nothing, asks for no other, and uses it once it opens", async () => {
        // Waited for without end, it kept every later operation waiting too,
        // inside the locks: every read and write of every folder in this tab.
        // So each operation waits for it no longer than the limit. The open
        // itself is kept, though, not closed when it settles at last: closed,
        // and opened again by the next operation, an IndexedDB that always
        // takes longer than the limit to open was never used, and none of the
        // tab's writes was counted - beside a tab whose IndexedDB opened in
        // time, a write the other tab could take its copy for current over.
        inABrowserTab();
        const slow = slowOpen(indexedDB);   // opens once `settle` is called, and not before
        vi.stubGlobal("indexedDB", slow.factory);
        const a = vfsCoordinator(() => "c1", { countWaitMs: 30 })!;
        try {
            expect(await within(a.counters(["r1", "r2"]))).toEqual([null, null]);
            expect(await within(a.begin("r1"))).toBeNull();
            expect(await within(a.counters(["r1"]))).toEqual([null]);
            expect(slow.opens).toBe(1);   // each waits for the one open asked for
            slow.settle();
            await slow.opened;
            const [before] = await a.counters(["r1"]);
            expect(before).toBeTypeOf("string");
            await a.begin("r1");
            const counted = await a.bump("r1");
            expect(counted).toBeTypeOf("string");
            expect(counted).not.toBe(before);
            expect(await a.counters(["r1"])).toEqual([counted]);
            expect(slow.opens).toBe(1);   // kept, and used, rather than closed and opened again
        } finally {
            a.close();
        }
    });

    it("uses an IndexedDB that opens more slowly than the limit from the moment it opens, and asks to open it only once", async () => {
        inABrowserTab();
        const slow = slowOpen(indexedDB, 300);
        vi.stubGlobal("indexedDB", slow.factory);
        const a = vfsCoordinator(() => "c1", { countWaitMs: 50 })!;
        try {
            // Still opening: each gives up after the limit, and tells nothing.
            expect(await within(a.counters(["r1"]))).toEqual([null]);
            expect(await within(a.lock("r1", async () => [await a.begin("r1"), await a.bump("r1")]))).toEqual([null, null]);
            await slow.opened;
            const [before] = await a.counters(["r1"]);
            expect(before).toBeTypeOf("string");
            const written = await a.lock("r1", async () => [await a.begin("r1"), await a.bump("r1")]);
            expect(written).toEqual([before, expect.any(String)]);
            expect(written[1]).not.toBe(before);
            expect(await a.counters(["r1"])).toEqual([written[1]]);
            expect(slow.opens).toBe(1);
        } finally {
            a.close();
        }
    });

    it("gives up on an operation once the limit has passed since it was asked for, the open and the transaction together", async () => {
        // So a read of a folder waits for IndexedDB no longer than the limit,
        // and a write - a `begin` and a `bump` - no longer than twice that,
        // however near the limit the database opens before a transaction
        // that does not complete.
        inABrowserTab();
        const slow = slowOpen(indexedDB, 150);
        vi.stubGlobal("indexedDB", slow.factory);
        const transaction = IDBDatabase.prototype.transaction;
        const spy = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
            const tx = transaction.apply(this, args);
            if (tx.mode === "versionchange") return tx;
            // Neither its completion nor an abort is ever heard of.
            return { objectStore: (name: string) => tx.objectStore(name), abort: () => tx.abort() } as unknown as IDBTransaction;
        });
        const a = vfsCoordinator(() => "c1", { countWaitMs: 200 })!;
        try {
            // Opened after 150 ms, and given up on at 200, not 350.
            expect(await within(a.counters(["r1"]), 280)).toEqual([null]);
            await slow.opened;
        } finally {
            spy.mockRestore();
            a.close();
        }
    });

    it("opens IndexedDB again after an open that failed or was blocked, and closes a blocked one that opens after all", async () => {
        for (const how of ["error", "blocked"] as const) {
            inABrowserTab();
            const real = indexedDB;
            const first: Array<Record<string, unknown>> = [];
            vi.stubGlobal("indexedDB", {
                open: (name: string, version?: number) => {
                    if (first.length) return real.open(name, version);
                    const request: Record<string, unknown> = {};
                    first.push(request);
                    setTimeout(() => (request[`on${how}`] as (() => void) | undefined)?.(), 0);
                    return request;
                },
            });
            // A limit no answer here comes near: what is told is the open's
            // failure, not the limit.
            const a = vfsCoordinator(() => "c1", { countWaitMs: 5_000 })!;
            try {
                expect(await within(a.counters(["r1"]), 500)).toEqual([null]);
                expect(await within(a.counters(["r1"]), 500)).toEqual([expect.any(String)]);
                if (how === "blocked") {
                    // Opened at last, once whatever blocked it let go: another
                    // is in use by now, and this one is not kept.
                    let closed = false;
                    first[0].result = { close: () => void (closed = true) };
                    (first[0].onsuccess as () => void)();
                    expect(closed).toBe(true);
                    expect(await within(a.counters(["r1"]), 500)).toEqual([expect.any(String)]);
                }
            } finally {
                a.close();
                vi.unstubAllGlobals();
            }
        }
    });

    it("drops an IndexedDB open that has not answered within 30 seconds, and the next call asks for one new open, used once it opens", async () => {
        // Waited for for as long as it did not answer, an open that never
        // would left the tab without counts for as long as the tab lived:
        // each call 3 seconds longer, and none of its writes counted. Until
        // 30 seconds have passed, though, every call waits for the one open
        // asked for, as each does for one that is merely slow.
        fakeTimers();
        inABrowserTab();
        const idb = hungOpens(indexedDB, 1);
        vi.stubGlobal("indexedDB", idb.factory);
        const a = vfsCoordinator(() => "c1")!;   // the real limits: 3 seconds a call, 30 an open
        /** What `promise` has settled to once `ms` more have passed. */
        const after = async <T>(ms: number, promise: Promise<T>): Promise<T> => {
            await vi.advanceTimersByTimeAsync(ms);
            return promise;
        };
        try {
            expect(await after(3_000, a.counters(["r1"]))).toEqual([null]);   // asked at 0 s: the open is asked for
            expect(await after(3_000, a.begin("r1"))).toBeNull();             // at 3 s
            await vi.advanceTimersByTimeAsync(20_000);
            expect(await after(3_000, a.bump("r1"))).toBeNull();              // at 26 s
            await vi.advanceTimersByTimeAsync(999);
            expect(await after(3_000, a.counters(["r1"]))).toEqual([null]);   // at 29.999 s
            expect(idb.requests).toHaveLength(1);
            // Dropped at 30 seconds: the next call asks for one new open,
            // however many calls ask at once, and every call uses it.
            vi.useRealTimers();
            expect(await within(Promise.all([a.counters(["r1"]), a.counters(["r2"])]))).toEqual([
                [expect.any(String)],
                [expect.any(String)],
            ]);
            expect(idb.requests).toHaveLength(2);
            const written = await within(a.lock("r1", async () => [await a.begin("r1"), await a.bump("r1")]));
            expect(written).toEqual([expect.any(String), expect.any(String)]);
            expect(await within(a.counters(["r1"]))).toEqual([(written as string[])[1]]);
            expect(idb.requests).toHaveLength(2);   // kept, once it opened
        } finally {
            vi.useRealTimers();
            a.close();
        }
    });

    it("closes a dropped IndexedDB open that opens after all, and keeps the one opened since", async () => {
        fakeTimers();
        inABrowserTab();
        const idb = hungOpens(indexedDB, 2);
        vi.stubGlobal("indexedDB", idb.factory);
        const a = vfsCoordinator(() => "c1")!;
        try {
            const first = a.counters(["r1"]);
            await vi.advanceTimersByTimeAsync(30_000);
            expect(await first).toEqual([null]);
            const second = a.counters(["r1"]);   // asks for a second open, which does not answer either
            await vi.advanceTimersByTimeAsync(30_000);
            expect(await second).toEqual([null]);
            expect(idb.requests).toHaveLength(2);
            vi.useRealTimers();
            const [counter] = (await within(a.counters(["r1"]))) as Array<string | null>;   // the third opens
            expect(counter).toBeTypeOf("string");
            expect(idb.requests).toHaveLength(3);
            // The first opens at last and the second fails, both long after
            // they were dropped: the first is closed, and the open in use is
            // kept, with no other asked for.
            let closed = false;
            idb.requests[0].result = { close: () => void (closed = true) };
            (idb.requests[0].onsuccess as () => void)();
            (idb.requests[1].onerror as () => void)();
            expect(closed).toBe(true);
            expect(await within(a.counters(["r1"]))).toEqual([counter]);
            expect(idb.requests).toHaveLength(3);
        } finally {
            vi.useRealTimers();
            a.close();
        }
    });

    it("still drops the open under way 30 seconds after it was asked for when opens dropped before it answer late meanwhile", async () => {
        // A dropped open that opens or fails at last is no longer the one
        // under way, and stops nothing of the one that is. Had either stopped
        // that one's drop, and that one never answered, the tab was left
        // without counts for as long as it lived.
        fakeTimers();
        inABrowserTab();
        const idb = hungOpens(indexedDB, 3);
        vi.stubGlobal("indexedDB", idb.factory);
        const a = vfsCoordinator(() => "c1")!;   // the real limits: 3 seconds a call, 30 an open
        try {
            const first = a.counters(["r1"]);   // at 0 s: asks for an open, which does not answer
            await vi.advanceTimersByTimeAsync(30_000);
            expect(await first).toEqual([null]);
            const second = a.counters(["r1"]);   // at 30 s, the first dropped: asks for a second, which does not answer either
            await vi.advanceTimersByTimeAsync(30_000);
            expect(await second).toEqual([null]);
            const third = a.counters(["r1"]);   // at 60 s, the second dropped: asks for a third, which does not answer either
            await vi.advanceTimersByTimeAsync(3_000);
            expect(await third).toEqual([null]);
            expect(idb.requests).toHaveLength(3);
            // At 63 s, while the third is still waited for, the first opens
            // at last and the second fails: the first is closed, and neither
            // touches the third.
            let closed = false;
            idb.requests[0].result = { close: () => void (closed = true) };
            (idb.requests[0].onsuccess as () => void)();
            (idb.requests[1].onerror as () => void)();
            expect(closed).toBe(true);
            await vi.advanceTimersByTimeAsync(26_999);
            const last = a.counters(["r1"]);   // at 89.999 s: still waits for the third
            await vi.advanceTimersByTimeAsync(3_000);
            expect(await last).toEqual([null]);
            expect(idb.requests).toHaveLength(3);
            // Dropped at 90 s, 30 after it was asked for: the next call asks
            // for a fourth, which opens.
            vi.useRealTimers();
            expect(await within(a.counters(["r1"]))).toEqual([expect.any(String)]);
            expect(idb.requests).toHaveLength(4);
        } finally {
            vi.useRealTimers();
            a.close();
        }
    });

    it("keeps an IndexedDB open that answers within 30 seconds for every later call, however long after", async () => {
        // Dropped only while it has not answered: once it has opened, it is
        // no longer under way, and nothing drops it.
        fakeTimers();
        inABrowserTab();
        const slow = slowOpen(indexedDB);   // opens once `settle` is called, and not before
        vi.stubGlobal("indexedDB", slow.factory);
        const a = vfsCoordinator(() => "c1")!;
        try {
            const first = a.counters(["r1"]);
            await vi.advanceTimersByTimeAsync(3_000);
            expect(await first).toEqual([null]);
            await vi.advanceTimersByTimeAsync(26_000);
            slow.settle();   // at 29 s
            await slow.opened;
            await vi.advanceTimersByTimeAsync(60_000);
            const later = a.counters(["r1"]);
            expect(slow.opens).toBe(1);
            expect(await later).toEqual([expect.any(String)]);
        } finally {
            vi.useRealTimers();
            a.close();
        }
    });

    it("counts the writes of a tab whose IndexedDB is slow to open once it has opened, so that a tab whose IndexedDB is quick reads again", async () => {
        // Its opens given up on, and each closed when it opened at last, the
        // slow tab never counted a write: the quick tab's counter never moved,
        // and it took a copy read before the slow tab's write for current.
        inABrowserTab();
        const quick = vfsCoordinator(() => "c1")!;   // its IndexedDB answers at once
        const slow = slowOpen(indexedDB, 300);
        vi.stubGlobal("indexedDB", slow.factory);
        const a = vfsCoordinator(() => "c1", { countWaitMs: 50 })!;
        try {
            const [copy] = await quick.counters(["r1"]);
            // Still opening: this write is not counted, as one where IndexedDB fails is not.
            expect(await a.lock("r1", async () => [await a.begin("r1"), await a.bump("r1")])).toEqual([null, null]);
            await slow.opened;
            const written = await a.lock("r1", async () => [await a.begin("r1"), await a.bump("r1")]);
            expect(written).toEqual([expect.any(String), expect.any(String)]);
            expect(await quick.lock("r1", () => quick.begin("r1"))).not.toBe(copy);   // so the quick tab reads r1 again
        } finally {
            a.close();
            quick.close();
        }
    });

    it("gives up on an IndexedDB transaction that does not complete, telling nothing, and lets go of the lock", async () => {
        inABrowserTab();
        const a = vfsCoordinator(() => "c1", { countWaitMs: 30 })!;
        const b = vfsCoordinator(() => "c1")!;
        const transaction = IDBDatabase.prototype.transaction;
        const spy = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
            const tx = transaction.apply(this, args);
            // Not the one that makes the database: that opens it.
            if (tx.mode === "versionchange") return tx;
            // Neither its completion nor an abort is ever heard of.
            return { objectStore: (name: string) => tx.objectStore(name), abort: () => tx.abort() } as unknown as IDBTransaction;
        });
        try {
            expect(await within(a.counters(["r1"]))).toEqual([null]);
            const written = a.lock("r1", async () => [await a.begin("r1"), await a.bump("r1")]);
            expect(await within(written)).toEqual([null, null]);
            spy.mockRestore();
            expect(await within(b.lock("r1", async () => "next"))).toBe("next");
        } finally {
            spy.mockRestore();
            a.close();
            b.close();
        }
    });

    it("takes every copy for out of date once IndexedDB has been cleared", async () => {
        // Cleared, every count starts again: a count read before could come
        // round again with writes in between that it did not hold.
        inABrowserTab();
        const a = vfsCoordinator(() => "c1")!;
        try {
            const [before] = await a.counters(["r1"]);
            await new Promise((resolve, reject) => {
                const request = indexedDB.deleteDatabase("muhkoo.vfs");
                request.onsuccess = resolve;
                request.onerror = reject;
            });
            const [after] = await a.counters(["r1"]);
            expect(after).toBeTypeOf("string");
            expect(after).not.toBe(before);
        } finally {
            a.close();
        }
    });
});

describe("cross-tab coordination — client.vfs where the browser will not coordinate", () => {
    const SEED = new Uint8Array(32).fill(7);

    /** A namespace on `coordinator`: saves, a move, deletes and reads - each takes a lock, reads a count or listens. */
    async function use(coordinator: VfsCoordinator): Promise<string[]> {
        const vfs = new VfsNamespace({ store: makeStore(), content: makeContent(), seed: () => SEED, coordinator });
        await vfs.mkdir("/d");
        await vfs.writeFile("/d/f.txt", "f");
        await vfs.writeFile("/d/g.txt", "g");
        await vfs.rename("/d/f.txt", "/f.txt");
        await vfs.delete("/d/g.txt");
        await vfs.writeFile("/d/h.txt", "h");
        await vfs.delete("/d", { recursive: true });
        expect(await vfs.readText("/f.txt")).toBe("f");
        return vfs.walk("/");
    }

    it("works as it does without one where the browser refuses Web Locks", async () => {
        vi.stubGlobal("window", {});
        const refusal = new DOMException("Access to the Locks API is denied in this context.", "SecurityError");
        vi.stubGlobal("navigator", { locks: { request: () => Promise.reject(refusal) } });
        const coordinator = vfsCoordinator(() => "c1")!;
        try {
            expect(await within(use(coordinator))).toEqual(["/f.txt"]);
        } finally {
            coordinator.close();
        }
    });

    it("works where the browser refuses a BroadcastChannel", async () => {
        inABrowserTab();
        vi.stubGlobal(
            "BroadcastChannel",
            class {
                constructor() {
                    throw new DOMException("The operation is insecure.", "SecurityError");
                }
            },
        );
        const coordinator = vfsCoordinator(() => "c1")!;
        try {
            expect(await within(use(coordinator))).toEqual(["/f.txt"]);
        } finally {
            coordinator.close();
        }
    });

    it("keeps a save of a tab whose IndexedDB is slow to open, made once it has opened, beside a tab whose IndexedDB is quick", async () => {
        // Neither tab hears the other here, as when an announcement comes
        // late: only the counts can tell the quick tab that its copy of /d is
        // out of date. The slow tab's opens given up on, and each closed when
        // it opened at last, it never counted a write, and the quick tab wrote
        // its copy over the slow tab's save.
        inABrowserTab();
        vi.stubGlobal(
            "BroadcastChannel",
            class {
                constructor() {
                    throw new DOMException("The operation is insecure.", "SecurityError");
                }
            },
        );
        const quick = vfsCoordinator(() => "c1")!;
        const slow = slowOpen(indexedDB, 300);
        vi.stubGlobal("indexedDB", slow.factory);
        const late = vfsCoordinator(() => "c1", { countWaitMs: 50 })!;
        const store = makeStore();
        const content = makeContent();
        const a = new VfsNamespace({ store, content, seed: () => SEED, coordinator: late });
        const b = new VfsNamespace({ store, content, seed: () => SEED, coordinator: quick });
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
            await b.mkdir("/d");
            await a.list("/d");          // still opening: read without a count
            await slow.opened;
            await b.list("/d");          // the quick tab's copy of /d
            await a.writeFile("/d/a.txt", "a");
            await b.writeFile("/d/b.txt", "b");
            const s = new VfsNamespace({ store, content, seed: () => SEED });
            expect((await s.list("/d")).map((stat) => stat.name)).toEqual(["a.txt", "b.txt"]);
            expect(warn).not.toHaveBeenCalled();
            expect(slow.opens).toBe(1);
        } finally {
            warn.mockRestore();
            late.close();
            quick.close();
        }
    });

    it("works where IndexedDB never answers, and says once that its writes could not be counted", async () => {
        inABrowserTab();
        vi.stubGlobal("indexedDB", { open: () => ({}) });
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const coordinator = vfsCoordinator(() => "c1", { countWaitMs: 5 })!;
        try {
            expect(await within(use(coordinator), 3000)).toEqual(["/f.txt"]);
            // Once for the Client, not once for each folder it wrote: a loss
            // needs another tab that can count, which the warning says. Two
            // Clients in one tab would each say it, which it says too.
            expect(warn).toHaveBeenCalledTimes(1);
            expect(String(warn.mock.calls[0][0])).toMatch(/may be lost only if another tab of this app can count its writes/);
            expect(String(warn.mock.calls[0][0])).toMatch(/Said once per Client, /);
        } finally {
            warn.mockRestore();
            coordinator.close();
        }
    });
});
