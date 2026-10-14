/**
 * Coordination between the tabs of an app on one device: Web Locks, the
 * Web BroadcastChannel, and IndexedDB.
 *
 * Every factory here returns undefined unless the runtime is a browser tab
 * with both Web Locks and a BroadcastChannel - not Node (which has
 * `navigator.locks` from 24.5, but per process), not a Worker, not an old
 * WebView - and its callers then keep the behaviour they had before: one
 * tab's writes ordered among themselves only. IndexedDB is not required:
 * without it no count can be told, and every write reads its folder again
 * first. A storage-partitioned iframe gets locks, a channel and IndexedDB of
 * its own, as it gets storage of its own; to the app's other tabs it is
 * another device.
 *
 * A browser can also have these and refuse them to a document: an opaque
 * origin (a sandboxed iframe, a `data:` document), or a site whose data the
 * user has blocked. Refused Web Locks, the coordinator goes on without
 * them, as in Node (see `refusesLocks`); refused a channel, it hears
 * nothing; and an IndexedDB that does not answer in time counts nothing
 * (see `writeCounts`). `client.vfs` needed none of the three before it
 * coordinated tabs, and none of them may stop it now.
 *
 * `globalThis.BroadcastChannel` is named in full on purpose: this package
 * exports a class of its own called BroadcastChannel (the E2E room channel),
 * and an import of that in scope would silently take the Web API's place.
 */

import { VfsConflictError } from "../vfs/types";
import type { VfsCoordinator } from "../vfs/coordinator";
import type { TryLock } from "../offline/OutboundQueue";
import { generateId } from "../utilities";

/** How long a write waits for another tab to finish writing the same folder before it gives up. */
export const LOCK_WAIT_MS = 30_000;

/**
 * How long each call to the write counts - `counters`, `begin` or `bump` -
 * may take before it gives up, telling nothing, as one that failed: the
 * wait for the IndexedDB open and the call's transaction together, not
 * each. Only the call gives up, not the open: one that succeeds later,
 * within `OPEN_DROP_MS`, is kept for every later call (see `writeCounts`).
 */
const COUNT_WAIT_MS = 3_000;

/**
 * How long an IndexedDB open of the write counts may go without any answer
 * - no success, error or blocked - before it is dropped, as one that
 * failed, and the next call asks for another. See `writeCounts`.
 */
const OPEN_DROP_MS = 30_000;

/**
 * Whether `err`, from a Web Locks request that was never granted, is the
 * browser refusing Web Locks to this document altogether: an opaque origin,
 * or a site whose data the user has blocked. The browser makes that
 * decision for the site's storage, so it refuses every tab of the app
 * alike, and no tab holds the lock. The tab then goes on without it, as in
 * Node. Any other error - a document no longer fully active, say - is
 * passed on.
 */
function refusesLocks(err: unknown): boolean {
    return (err as { name?: unknown } | null)?.name === "SecurityError";
}

/** The slice of the Web Locks API used here. */
interface LockManagerLike {
    request<T>(
        name: string,
        options: { ifAvailable?: boolean; signal?: AbortSignal; mode?: "exclusive" | "shared" },
        callback: (lock: unknown) => Promise<T>,
    ): Promise<T>;
}

/** The slice of the Web BroadcastChannel used here. */
interface ChannelLike {
    onmessage: ((event: { data: unknown }) => void) | null;
    postMessage(message: unknown): void;
    close(): void;
}

// Through `unknown`: the DOM's own LockManager and BroadcastChannel types do
// not line up with these slices closely enough for a direct cast.
function webLocks(): LockManagerLike | undefined {
    if (typeof window === "undefined") return undefined;
    const locks = (globalThis as unknown as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;
    return typeof locks?.request === "function" ? locks : undefined;
}

function webChannel(): (new (name: string) => ChannelLike) | undefined {
    const Channel = (globalThis as unknown as { BroadcastChannel?: new (name: string) => ChannelLike }).BroadcastChannel;
    return typeof Channel === "function" ? Channel : undefined;
}

function webIndexedDB(): IDBFactory | undefined {
    const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    return typeof idb?.open === "function" ? idb : undefined;
}

/**
 * The IndexedDB database the write counts are kept in, one per origin, as
 * the locks are. Not one connect keeps for anything else: those are
 * `muhkoo.offline` (the offline layer), `muhkoo.trust` and `muhkoo.device.v1`.
 *
 * Its version stays 1 for good. A tab still running code that opens it at
 * version 1 would fail with a VersionError once a newer tab had made it at
 * version 2, count nothing, and so write a folder without the newer tabs
 * knowing: the writer whose write may be lost. A new store goes in a new
 * database.
 */
const COUNTS_DB = "muhkoo.vfs";
/** Its one store: `[commitment, record id]` to a count, and `CREATED` to a random id. */
const COUNTS = "counts";
const CREATED = "created";

/**
 * How often each user's directory records have been written on this
 * device: `VfsCoordinator.counters`, `begin` and `bump`, kept in IndexedDB
 * for every tab of the origin.
 *
 * A count is odd from `begin` to `bump`, while a write is under way, and
 * even once it is counted; `counters` reports an odd one as unknown. It is
 * read as `<created>:<count>`, where `created` is a random id stored when
 * the database was made: deleted - the site's data cleared - every count
 * starts again from nothing, and a counter read before could otherwise
 * come round again with writes in between that its copy does not hold.
 *
 * Each operation is one transaction, and settles once that has completed.
 * Every failure - IndexedDB missing, an open refused, blocked or failed, a
 * transaction aborted - resolves to null, which the namespace takes for out
 * of date: it reads the record again. A failed or blocked open is not kept,
 * and nor is a connection closed under it, by a newer version of this code
 * in another tab or by the database being deleted: the next operation opens
 * the database again.
 *
 * So does an operation that has not settled within `waitMs`, the open it
 * waits for and its transaction together: these are awaited inside the
 * record locks, and one waited for without end would hold the lock, and
 * stop every read and write of the tab's folders, for as long. Only the
 * operation gives up, though, not the open: there is one open under way at
 * a time, every operation waits for that one, and once it has opened the
 * database it is kept for every later operation. Given up on too, and closed
 * when it opened at last, an open that always takes longer than `waitMs`
 * would never give the tab its counts. An open that has not answered at all
 * within `OPEN_DROP_MS` is dropped, though, as one that failed: one that
 * never will would otherwise leave the tab without counts for as long as it
 * lives. Until then every operation waits for it, `waitMs` at most, and
 * tells nothing; the next operation after that asks for one new open; and
 * the dropped one, if it opens after all, is closed. The new open is
 * dropped in turn if it goes `OPEN_DROP_MS` without an answer too, and so
 * on: where IndexedDB never answers, the tab leaves behind one more open
 * that never settles every `OPEN_DROP_MS` or a little more, for as long as
 * operations keep coming, and none while none come. An operation that
 * gives up before the database has opened makes no transaction. A
 * transaction given up on is not aborted, and may still complete: IndexedDB
 * runs the read-write transactions of one store in the order they were
 * made, so a late `begin` still marks the count before any later `bump`,
 * and a late `bump` still counts its write before any later `begin`. A tab
 * that asks meanwhile waits behind it, gives up, and reads the record
 * again.
 */
function writeCounts(idb: IDBFactory | undefined, waitMs: number) {
    // The open under way, or the one that opened `opened`: one at a time.
    let connection: Promise<IDBDatabase | null> | null = null;
    // The database `connection` opened, once it has.
    let opened: IDBDatabase | null = null;
    // Drops `connection` while it is under way, once `OPEN_DROP_MS` have passed.
    let dropping: ReturnType<typeof setTimeout> | undefined;
    const forget = (db: IDBDatabase): void => {
        if (opened !== db) return;
        opened = null;
        connection = null;
        db.close();
    };
    const open = (): Promise<IDBDatabase | null> => {
        if (connection) return connection;
        let request: IDBOpenDBRequest;
        try {
            if (!idb) throw new Error("no IndexedDB");
            request = idb.open(COUNTS_DB, 1);
        } catch {
            // Not kept: the next operation tries again.
            return Promise.resolve(null);
        }
        const pending = new Promise<IDBDatabase | null>((resolve) => {
            // Not kept when it failed, or was dropped: the next operation
            // tries again. Failed after it was dropped, it changes nothing.
            const fail = (): void => {
                if (connection === pending) {
                    clearTimeout(dropping);
                    connection = null;
                }
                resolve(null);
            };
            request.onupgradeneeded = () => {
                request.result.createObjectStore(COUNTS).put(generateId(), CREATED);
            };
            request.onsuccess = () => {
                const db = request.result;
                // Blocked or dropped, and given up on, before it opened - or
                // closed by `close`. Another open may be under way by now.
                if (connection !== pending) {
                    db.close();
                    resolve(null);
                    return;
                }
                clearTimeout(dropping);
                db.onversionchange = () => forget(db);
                db.onclose = () => forget(db);
                opened = db;
                resolve(db);
            };
            // Blocked: another tab holds an older version open. Not waited for.
            request.onerror = fail;
            request.onblocked = fail;
            // No answer at all: dropped, as one that failed, and the next
            // operation asks for another - dropped in turn if it does not
            // answer either. See above.
            dropping = setTimeout(fail, OPEN_DROP_MS);
        });
        connection = pending;
        return pending;
    };

    /**
     * Run `body` in one transaction, and resolve once that has completed to
     * what the function it returns gives then - or to null, if anything
     * fails, or the database has not opened and the transaction completed
     * within `waitMs`.
     */
    const run = <T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => () => T): Promise<T | null> =>
        new Promise<T | null>((resolve) => {
            let done = false;
            const settle = (value: T | null): void => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                resolve(value);
            };
            // Given up on, but neither the open nor the transaction aborted: see above.
            const timer = setTimeout(() => settle(null), waitMs);
            void open().then((db) => {
                // Given up on while it opened: nothing to do.
                if (done) return;
                if (!db) {
                    settle(null);
                    return;
                }
                let tx: IDBTransaction | undefined;
                try {
                    tx = db.transaction(COUNTS, mode);
                    const result = body(tx.objectStore(COUNTS));
                    tx.oncomplete = () => settle(result());
                    tx.onabort = () => settle(null);
                } catch {
                    try {
                        tx?.abort();
                    } catch {
                        // Finished already.
                    }
                    // Closed under it, most likely: the next operation opens it again.
                    forget(db);
                    settle(null);
                }
            });
        });

    const count = (value: unknown): number => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0);
    const counter = (created: unknown, n: number): string | null => (typeof created === "string" ? `${created}:${n}` : null);

    return {
        async counters(who: string, ids: readonly string[]): Promise<Array<string | null>> {
            const read = await run("readonly", (store) => {
                const created = store.get(CREATED);
                const counts = ids.map((id) => store.get([who, id]));
                return () =>
                    counts.map((at) => {
                        const n = count(at.result);
                        return n % 2 === 0 ? counter(created.result, n) : null;
                    });
            });
            return read ?? ids.map(() => null);
        },
        begin(who: string, id: string): Promise<string | null> {
            return run("readwrite", (store) => {
                const created = store.get(CREATED);
                const at = store.get([who, id]);
                let n = 0;
                at.onsuccess = () => {
                    n = count(at.result);
                    // Odd already, a write began and was never counted: its mark stays.
                    if (n % 2 === 0) store.put(n + 1, [who, id]);
                };
                return () => counter(created.result, n);
            });
        },
        bump(who: string, id: string): Promise<string | null> {
            return run("readwrite", (store) => {
                const created = store.get(CREATED);
                const at = store.get([who, id]);
                let next = 0;
                at.onsuccess = () => {
                    const n = count(at.result);
                    // Past the mark `begin` stored - or, when it could not
                    // store one, past the count it found.
                    next = n % 2 === 0 ? n + 2 : n + 1;
                    store.put(next, [who, id]);
                };
                return () => counter(created.result, next);
            });
        },
        close(): void {
            // An open still under way is closed once it opens.
            connection = null;
            clearTimeout(dropping);
            if (opened) forget(opened);
        },
    };
}

/**
 * The offline queue's drain lock: `fn` runs only if no other tab is
 * draining, and `false` says another one is. See `OutboundQueue`. Where the
 * browser refuses Web Locks, `fn` runs without it, as in Node, and the
 * lock is not asked for again: see `refusesLocks`.
 */
export function drainLock(): TryLock | undefined {
    const locks = webLocks();
    if (!locks) return undefined;
    let refused = false;
    return async (name, fn) => {
        if (!refused) {
            let answered = false;
            try {
                return await locks.request(name, { ifAvailable: true }, async (lock) => {
                    answered = true;
                    if (!lock) return false;
                    await fn();
                    return true;
                });
            } catch (err) {
                if (answered || !refusesLocks(err)) throw err;
                refused = true;
            }
        }
        await fn();
        return true;
    };
}

/**
 * The `VfsCoordinator` for whoever `commitment()` names: a lock per record,
 * `muhkoo:vfs:<commitment>:<record id>`; a move lock per entry,
 * `muhkoo:vfs:<commitment>:moving:<entry id>`, taken only if free, and
 * shared by the moves into a folder; a count of each record's writes, in
 * IndexedDB `muhkoo.vfs` under `[commitment, record id]` (see
 * `writeCounts`); and announcements on the channel `muhkoo:vfs:<commitment>`
 * as `{ id, writer }`, where `writer` is this tab's random id. `close` is
 * for tests, as are `lockWaitMs` (see `LOCK_WAIT_MS`) and `countWaitMs`
 * (see `COUNT_WAIT_MS`).
 *
 * Where the browser refuses Web Locks (see `refusesLocks`), it holds no
 * lock - every write runs as it would without a coordinator, and every
 * move lock is had at once - and asks for none again.
 */
export function vfsCoordinator(
    commitment: () => string | null,
    opts: { lockWaitMs?: number; countWaitMs?: number } = {},
): (VfsCoordinator & { close(): void }) | undefined {
    const locks = webLocks();
    const Channel = webChannel();
    if (!locks || !Channel) return undefined;
    const lockWaitMs = opts.lockWaitMs ?? LOCK_WAIT_MS;
    const tab = generateId();
    const counts = writeCounts(webIndexedDB(), opts.countWaitMs ?? COUNT_WAIT_MS);
    const handlers = new Set<(id: string | null) => void>();
    // `channel` is null where the browser would not make one: see `listen`.
    let open: { who: string; channel: ChannelLike | null } | null = null;
    // Move locks this tab has let go of, until the browser has too. See `holdMoving`.
    const leaving = new Map<string, Promise<void>>();
    // The browser refused Web Locks: see `refusesLocks`.
    let refused = false;

    /**
     * Hear the channel of whoever is signed in now: opened the first time,
     * and opened again for someone else after a sign-in. What was announced
     * before it opened was not heard, which every handler is told.
     *
     * Where the browser will not make the channel - an opaque origin, or a
     * site whose data is blocked - this tab hears nothing and tells no one,
     * and does not ask again for the same user. That is safe: the counts,
     * not the announcements, decide whether a copy may be written over.
     */
    const listen = (): void => {
        const who = commitment();
        if (open?.who === who) return;
        open?.channel?.close();
        open = null;
        if (!who) return;
        let channel: ChannelLike | null = null;
        try {
            channel = new Channel(`muhkoo:vfs:${who}`);
            channel.onmessage = (event) => {
                const data = event.data as { id?: unknown; writer?: unknown } | null;
                if (typeof data?.id !== "string" || data.writer === tab) return;
                for (const handler of handlers) handler(data.id);
            };
        } catch {
            channel = null;
        }
        open = { who, channel };
        for (const handler of handlers) handler(null);
    };

    return {
        async lock<T>(id: string, fn: () => Promise<T>): Promise<T> {
            listen();
            const who = commitment();
            // Signed out: the store refuses the write itself, with a clearer
            // message. Refused Web Locks: no tab of the app can hold this
            // lock, and the write goes ahead as it would without one.
            if (!who || refused) return fn();
            // Only the WAIT is bounded. Once granted, the lock is held until
            // the write has landed or failed: let go of while a write is still
            // on its way, the next tab's write could land first and then be
            // undone by it - the very loss this lock is for.
            const waiting = new AbortController();
            const timer = setTimeout(() => waiting.abort(), lockWaitMs);
            let granted = false;
            try {
                return await locks.request(`muhkoo:vfs:${who}:${id}`, { signal: waiting.signal }, () => {
                    granted = true;
                    clearTimeout(timer);
                    return fn();
                });
            } catch (err) {
                if (!granted && waiting.signal.aborted) {
                    throw new VfsConflictError(
                        `another tab of this app has been writing this folder for over ${Math.round(lockWaitMs / 1000)} seconds; nothing was written - try again`,
                    );
                }
                if (granted || !refusesLocks(err)) throw err;
                refused = true;
            } finally {
                clearTimeout(timer);
            }
            // Refused Web Locks, before anything was written: written without one.
            return fn();
        },
        announce(id: string): void {
            listen();
            open?.channel?.postMessage({ id, writer: tab });
        },
        onAnnounce(handler: (id: string | null) => void): () => void {
            handlers.add(handler);
            return () => void handlers.delete(handler);
        },
        listen,
        // Signed out, nothing is counted: the store refuses the reads and
        // writes themselves.
        async counters(ids: readonly string[]): Promise<Array<string | null>> {
            const who = commitment();
            return who ? counts.counters(who, ids) : ids.map(() => null);
        },
        async begin(id: string): Promise<string | null> {
            const who = commitment();
            return who ? counts.begin(who, id) : null;
        },
        async bump(id: string): Promise<string | null> {
            const who = commitment();
            return who ? counts.bump(who, id) : null;
        },
        async holdMoving(id: string, shared = false): Promise<(() => void) | null> {
            const who = commitment();
            // Signed out: the store refuses the writes themselves. Refused Web
            // Locks, no tab of the app can hold this lock.
            if (!who || refused) return () => {};
            const name = `muhkoo:vfs:${who}:moving:${id}`;
            // Let go of by this tab, but perhaps not yet by the browser, which
            // lets go only once the callback below has settled. Asked for
            // before then - a move or a delete straight after another of the
            // same entry - it is still held, and this tab refuses itself.
            const before = leaving.get(name);
            if (before) await before;
            return new Promise((resolve, reject) => {
                let answered = false;
                const request = locks.request(name, { ifAvailable: true, mode: shared ? "shared" : "exclusive" }, async (lock) => {
                    answered = true;
                    if (!lock) {
                        resolve(null);
                        return;
                    }
                    // Held until this settles: when the function handed back
                    // is called, or when the tab goes and the browser lets go
                    // of everything it held.
                    let held = true;
                    await new Promise<void>((letGo) =>
                        resolve(() => {
                            if (!held) return;
                            held = false;
                            // Settles once the browser has let go of it too,
                            // and of every other hold of it this tab has let
                            // go of: two moves into one folder hold it at once.
                            const gone = Promise.all([leaving.get(name), request.then(() => {}, () => {})]).then(() => {});
                            leaving.set(name, gone);
                            void gone.then(() => {
                                if (leaving.get(name) === gone) leaving.delete(name);
                            });
                            letGo();
                        }),
                    );
                });
                request.catch((err: unknown) => {
                    if (answered || !refusesLocks(err)) {
                        reject(err);
                        return;
                    }
                    refused = true;
                    resolve(() => {});
                });
            });
        },
        close(): void {
            open?.channel?.close();
            open = null;
            counts.close();
        },
    };
}
