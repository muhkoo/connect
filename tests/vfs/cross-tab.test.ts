/**
 * Two tabs of one app on one device: two namespaces over one store, ordered
 * by a coordinator that behaves as Web Locks, a BroadcastChannel and
 * IndexedDB do.
 */
import { describe, it, expect, vi } from "vitest";
import { makeContent, makeStore } from "./harness";
import { VfsNamespace } from "../../src/vfs/VfsNamespace";
import type { VfsCoordinator } from "../../src/vfs/coordinator";
import { dirKey, VfsConflictError, VfsNotFoundError } from "../../src/vfs/types";

const SEED = new Uint8Array(32).fill(7);
type Store = ReturnType<typeof makeStore>;
type Content = ReturnType<typeof makeContent>;

interface TabState {
    handlers: Set<(id: string | null) => void>;
    listening: boolean;
    inbox: string[] | null;
}

/**
 * How the tabs hear of each other's writes. Late, as a browser can deliver
 * them: every announcement is held back until the test lets it in with
 * `heard()`, so it never arrives before the next tab to take the lock has
 * decided, nor before anything else the test does.
 */
const MODES = [
    { late: false, when: "" },
    { late: true, when: " (announcements late)" },
];

/**
 * The locks, channel and write counters the tabs of one browser share. A
 * lock is granted in the order asked for; an announcement reaches every
 * other tab at once - unless that tab is not listening (its channel not open
 * yet) or its messages are delayed (still on their way), as every tab's are
 * with `late`. A record's counter is one map for every tab, as IndexedDB is,
 * and a write's count is stored a moment after it is asked for, as
 * IndexedDB's transaction completes: so it is ordered with the lock only
 * because a tab waits for it before letting go. `unusable` makes IndexedDB
 * fail: for `count`, only the count after a write; for `all`, everything.
 */
function device(opts: { late?: boolean } = {}) {
    const tails = new Map<string, Promise<void>>();
    const tabs = new Set<TabState>();
    // Each entry's move lock: held by one, or shared by any number that ask
    // for it shared. Taken only if free.
    const moving = new Map<string, { shared: boolean; holders: number }>();
    // Each record's write counter: odd while a write of it is under way.
    const counts = new Map<string, number>();
    let unusable: "count" | "all" | null = null;
    // The next count of a write, held back once asked for: see `holdCount`.
    let slow: { reached: () => void; released: Promise<void> } | null = null;
    const hear = (tab: TabState, id: string | null) => {
        for (const handler of tab.handlers) handler(id);
    };
    const deliver = (tab: TabState) => {
        const inbox = tab.inbox ?? [];
        tab.inbox = opts.late ? [] : null;
        for (const id of inbox) hear(tab, id);
    };
    return {
        /** Let every tab hear what the others have announced so far. */
        heard: () => {
            for (const tab of tabs) deliver(tab);
        },
        /** IndexedDB fails from here on: for each count after a write, or for everything. */
        breakStorage: (what: "count" | "all") => void (unusable = what),
        /** Hold back the next count of a write, once asked for, until released: IndexedDB slow to store it. */
        holdCount: () => {
            let reached!: () => void;
            let go!: () => void;
            const holding = new Promise<void>((resolve) => (reached = resolve));
            slow = { reached, released: new Promise<void>((resolve) => (go = resolve)) };
            return { holding, release: () => go() };
        },
        tab() {
            const me: TabState = { handlers: new Set(), listening: true, inbox: opts.late ? [] : null };
            tabs.add(me);
            const coordinator: VfsCoordinator = {
                async lock<T>(id: string, fn: () => Promise<T>): Promise<T> {
                    coordinator.listen();
                    const before = tails.get(id) ?? Promise.resolve();
                    let release!: () => void;
                    const mine = new Promise<void>((resolve) => (release = resolve));
                    const tail = before.then(() => mine);
                    tails.set(id, tail);
                    await before;
                    try {
                        return await fn();
                    } finally {
                        release();
                        if (tails.get(id) === tail) tails.delete(id);
                    }
                },
                announce(id) {
                    for (const tab of tabs) {
                        if (tab === me || !tab.listening) continue;
                        if (tab.inbox) tab.inbox.push(id);
                        else for (const handler of tab.handlers) handler(id);
                    }
                },
                onAnnounce(handler) {
                    me.handlers.add(handler);
                    return () => void me.handlers.delete(handler);
                },
                listen() {
                    if (me.listening) return;
                    me.listening = true;
                    hear(me, null);
                },
                async counters(ids) {
                    return ids.map((id) => {
                        if (unusable === "all") return null;
                        const n = counts.get(id) ?? 0;
                        return n % 2 === 0 ? String(n) : null;
                    });
                },
                async begin(id) {
                    if (unusable === "all") return null;
                    const n = counts.get(id) ?? 0;
                    if (n % 2 === 0) counts.set(id, n + 1);
                    return String(n);
                },
                async bump(id) {
                    const held = slow;
                    slow = null;
                    if (held) {
                        held.reached();
                        await held.released;
                    }
                    await new Promise((resolve) => setTimeout(resolve, 0));
                    if (unusable) return null;
                    const n = counts.get(id) ?? 0;
                    const next = n % 2 === 0 ? n + 2 : n + 1;
                    counts.set(id, next);
                    return String(next);
                },
                async holdMoving(id, shared = false) {
                    const now = moving.get(id);
                    if (now && !(shared && now.shared)) return null;
                    const lock = now ?? { shared, holders: 0 };
                    lock.holders++;
                    moving.set(id, lock);
                    let held = true;
                    return () => {
                        if (!held) return;
                        held = false;
                        if (--lock.holders === 0 && moving.get(id) === lock) moving.delete(id);
                    };
                },
            };
            return {
                coordinator,
                /** Stop hearing the other tabs, as before a channel is open. */
                deafen: () => void (me.listening = false),
                /** Hold what the other tabs announce until `deliver`. */
                delay: () => void (me.inbox ??= []),
                deliver: () => deliver(me),
            };
        },
    };
}

function twoTabs(late = false) {
    const dev = device({ late });
    const store = makeStore();
    const content = makeContent();
    const A = dev.tab();
    const B = dev.tab();
    const open = (tab: { coordinator: VfsCoordinator }) =>
        new VfsNamespace({ store, content, seed: () => SEED, coordinator: tab.coordinator });
    return { dev, store, content, A, B, a: open(A), b: open(B), heard: dev.heard };
}

/** What the store holds, read by a namespace that has cached nothing. */
function stored(store: Store, content: Content): VfsNamespace {
    return new VfsNamespace({ store, content, seed: () => SEED });
}

async function names(vfs: VfsNamespace, path: string): Promise<string[]> {
    return (await vfs.list(path)).map((stat) => stat.name);
}

async function recordKey(vfs: VfsNamespace, path: string): Promise<string> {
    return dirKey(((await (vfs as any).openDir(path)) as { id: string }).id);
}

/** Hold back the `nth` write of `key`, as a slow request is held up. */
function holdPut(store: Store, key: string, nth: number) {
    const put = store.put.bind(store);
    let seen = 0;
    let reached!: () => void;
    let go!: () => void;
    const holding = new Promise<void>((resolve) => (reached = resolve));
    const released = new Promise<void>((resolve) => (go = resolve));
    store.put = async (k: string, value: unknown) => {
        if (k === key && ++seen === nth) {
            reached();
            await released;
        }
        return put(k, value);
    };
    return { holding, release: () => go() };
}

/** Fail the next read of `key`, as a dropped connection does. */
function failNextGet(store: Store, key: string): void {
    const get = store.get.bind(store);
    let failed = false;
    store.get = async (k: string) => {
        if (k === key && !failed) {
            failed = true;
            throw new Error("network");
        }
        return get(k);
    };
}

/** Fail the next write of `key`, as a dropped connection does. */
function failNextPut(store: Store, key: string): void {
    const put = store.put.bind(store);
    let failed = false;
    store.put = async (k: string, value: unknown) => {
        if (k === key && !failed) {
            failed = true;
            throw new Error("network");
        }
        return put(k, value);
    };
}

/**
 * Hold back the next read of `key` once it has read the store, as a slow
 * response is held up: it answers with what was stored when it was asked.
 */
function holdGet(store: Store, key: string) {
    const get = store.get.bind(store);
    let held = false;
    let reached!: () => void;
    let go!: () => void;
    const holding = new Promise<void>((resolve) => (reached = resolve));
    const released = new Promise<void>((resolve) => (go = resolve));
    store.get = async (k: string) => {
        if (k !== key || held) return get(k);
        held = true;
        const value = await get(k);
        reached();
        await released;
        return value;
    };
    return { holding, release: () => go() };
}

/** Hold back the first delete of `key`, as a slow request is held up. */
function holdDelete(store: Store, key: string) {
    const remove = store.delete.bind(store);
    let held = false;
    let reached!: () => void;
    let go!: () => void;
    const holding = new Promise<void>((resolve) => (reached = resolve));
    const released = new Promise<void>((resolve) => (go = resolve));
    store.delete = async (k: string) => {
        if (k === key && !held) {
            held = true;
            reached();
            await released;
        }
        return remove(k);
    };
    return { holding, release: () => go() };
}

/** Every key written from here on, in order. */
function written(store: Store): string[] {
    const put = store.put.bind(store);
    const keys: string[] = [];
    store.put = async (k: string, value: unknown) => {
        keys.push(k);
        return put(k, value);
    };
    return keys;
}

/** Hold back `tab`'s next request for the move lock of `id`, before it is made. */
function holdLockRequest(tab: { coordinator: VfsCoordinator }, id: string) {
    const hold = tab.coordinator.holdMoving.bind(tab.coordinator);
    let held = false;
    let reached!: () => void;
    let go!: () => void;
    const asking = new Promise<void>((resolve) => (reached = resolve));
    const released = new Promise<void>((resolve) => (go = resolve));
    tab.coordinator.holdMoving = async (asked: string, shared?: boolean) => {
        if (asked === id && !held) {
            held = true;
            reached();
            await released;
        }
        return hold(asked, shared);
    };
    return { asking, release: () => go() };
}

/** A promise's outcome, without waiting on it here: "done", or what it threw. */
function outcome(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(() => "done", (err: unknown) => err);
}

/**
 * Hold back `tab`'s requests for move locks held shared - a move's hold on
 * the folders on the way to where it goes - until released.
 */
function holdWayRequests(tab: { coordinator: VfsCoordinator }) {
    const hold = tab.coordinator.holdMoving.bind(tab.coordinator);
    let reached!: () => void;
    let go!: () => void;
    const asking = new Promise<void>((resolve) => (reached = resolve));
    const released = new Promise<void>((resolve) => (go = resolve));
    tab.coordinator.holdMoving = async (id: string, shared?: boolean) => {
        if (shared) {
            reached();
            await released;
        }
        return hold(id, shared);
    };
    return { asking, release: () => go() };
}

/** Fail the `nth` write of `key` from here on, as a dropped connection does. */
function failPut(store: Store, key: string, nth: number): void {
    const put = store.put.bind(store);
    let seen = 0;
    store.put = async (k: string, value: unknown) => {
        if (k === key && ++seen === nth) throw new Error("network");
        return put(k, value);
    };
}

/** The content still stored, as text. */
function contentLeft(content: Content): string[] {
    return [...content.blobs.values()].map((blob) => new TextDecoder().decode(blob.bytes)).sort();
}

describe.each(MODES)("VFS — two tabs of one device$when", ({ late }) => {
    it("keeps both files when two tabs save into one folder at once", async () => {
        // Each tab held its own copy of /d, added its file, and wrote the
        // whole record: the store kept whichever arrived last.
        const { store, content, a, b, heard } = twoTabs(late);
        await a.mkdir("/d");
        await b.list("/d");

        await Promise.all([a.writeFile("/d/a.txt", "a"), b.writeFile("/d/b.txt", "b")]);

        expect(await names(stored(store, content), "/d")).toEqual(["a.txt", "b.txt"]);
        heard();                                  // each lists the other's file once it has heard of it
        expect(await names(a, "/d")).toEqual(["a.txt", "b.txt"]);
        expect(await names(b, "/d")).toEqual(["a.txt", "b.txt"]);
    });

    it("keeps every file when two tabs each save three files into one folder at once", async () => {
        const { store, content, a, b } = twoTabs(late);
        await a.mkdir("/d");
        await b.list("/d");
        const mine = (tab: VfsNamespace, prefix: string) =>
            [1, 2, 3].map((n) => tab.writeFile(`/d/${prefix}${n}.txt`, `${prefix}${n}`));

        await Promise.all([...mine(a, "a"), ...mine(b, "b")]);

        const s = stored(store, content);
        expect(await names(s, "/d")).toEqual(["a1.txt", "a2.txt", "a3.txt", "b1.txt", "b2.txt", "b3.txt"]);
        expect(await s.readText("/d/b2.txt")).toBe("b2");
    });

    it("lists what another tab has written to a folder once it has heard of the write", async () => {
        const { a, b, heard } = twoTabs(late);
        await a.mkdir("/d");
        expect(await names(b, "/d")).toEqual([]);

        await a.writeFile("/d/a.txt", "a");
        heard();

        expect(await names(b, "/d")).toEqual(["a.txt"]);
    });

    it("re-reads a folder another tab wrote once, when it next writes it", async () => {
        const { store, content, a, b } = twoTabs(late);
        await a.writeFile("/d/one.txt", "1");
        await b.list("/d");
        const key = await recordKey(a, "/d");
        await a.writeFile("/d/two.txt", "2");
        const gets = store.gets.length;

        await b.writeFile("/d/three.txt", "3");

        expect(store.gets.slice(gets).filter((k) => k === key)).toHaveLength(1);
        expect(await names(stored(store, content), "/d")).toEqual(["one.txt", "three.txt", "two.txt"]);
    });

    it("costs one tab on its own no reads it would not make without the others", async () => {
        const reads = async (coordinator?: VfsCoordinator): Promise<number> => {
            const store = makeStore();
            const vfs = new VfsNamespace({ store, content: makeContent(), seed: () => SEED, coordinator });
            await vfs.writeFile("/d/one.txt", "1");
            await vfs.mkdir("/e");
            const before = store.gets.length;
            await Promise.all(["2", "3", "4"].map((n) => vfs.writeFile(`/d/${n}.txt`, n)));
            await vfs.rename("/d/2.txt", "/e/2.txt");
            await vfs.writeFile("/d/3.txt", "three");
            await vfs.delete("/d/4.txt");
            return store.gets.length - before;
        };
        expect(await reads(device().tab().coordinator)).toBe(await reads());
    });

    it("refuses a save of a name another tab saved first, rather than overwriting it", async () => {
        const { store, content, a, b } = twoTabs(late);
        await a.mkdir("/d");
        await b.list("/d");
        const held = holdPut(store, await recordKey(a, "/d"), 1);   // a holds /d's lock while its write is in flight

        const first = a.writeFile("/d/x.txt", "from a");
        await held.holding;
        const second = b.writeFile("/d/x.txt", "from b");
        await vi.waitFor(async () => expect(await names(b, "/d")).toEqual(["x.txt"]), { interval: 1 });   // b's edit made, its write waiting on the lock
        held.release();
        await first;

        await expect(second).rejects.toThrow(VfsConflictError);
        expect(await stored(store, content).readText("/d/x.txt")).toBe("from a");
        expect(await b.readText("/d/x.txt")).toBe("from a");
    });

    it("refuses only the save that no longer applies, and stores the rest of its write", async () => {
        // b's two saves went out in one write. Made again to /d as a left it,
        // x.txt no longer applied - a had saved one first - and y.txt did.
        const { store, content, a, b } = twoTabs(late);
        await a.mkdir("/d");
        await b.list("/d");
        const held = holdPut(store, await recordKey(a, "/d"), 1);

        const first = a.writeFile("/d/x.txt", "from a");
        await held.holding;
        const x = b.writeFile("/d/x.txt", "from b").then(() => "done", (err: unknown) => err);
        const y = b.writeFile("/d/y.txt", "y");
        await vi.waitFor(async () => expect(await names(b, "/d")).toEqual(["x.txt", "y.txt"]), { interval: 1 });   // both edits made, one write waiting on the lock
        held.release();
        await first;

        expect(await x).toBeInstanceOf(VfsConflictError);
        await y;
        const s = stored(store, content);
        expect(await names(s, "/d")).toEqual(["x.txt", "y.txt"]);
        expect(await s.readText("/d/x.txt")).toBe("from a");
        expect(await s.readText("/d/y.txt")).toBe("y");
        expect(await names(b, "/d")).toEqual(["x.txt", "y.txt"]);
    });

    it("keeps every file when two tabs each save files into a new folder of the same name at once", async () => {
        // Each tab named its own new "Photos" in /d. b's later saves found
        // b's Photos named - in b's copy of /d, its write still waiting for
        // a's - and saved into it. Under the lock, made again to /d as a
        // left it, b's mkdir found a's Photos and named nothing: the folder
        // those files went into was named nowhere, and their saves had
        // already succeeded.
        const { store, content, a, b } = twoTabs(late);
        await a.mkdir("/d");
        await b.list("/d");
        const held = holdPut(store, await recordKey(a, "/d"), 1);   // a's write of /d, naming its Photos
        const save = (tab: VfsNamespace, name: string) => tab.writeFile(`/d/Photos/${name}`, name);

        const saves = [save(a, "a1.txt"), save(a, "a2.txt")];
        await held.holding;
        saves.push(save(b, "b1.txt"), save(b, "b2.txt"));   // at once: b2's mkdir finds b1's Photos as it names it
        await vi.waitFor(async () => expect(await names(b, "/d")).toEqual(["Photos"]), { interval: 1 });   // b's Photos named in its copy, the write waiting on the lock
        saves.push(save(b, "b3.txt"));                       // later: its mkdir finds b's Photos already named
        for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
        held.release();
        await Promise.all(saves);

        const s = stored(store, content);
        const all = ["a1.txt", "a2.txt", "b1.txt", "b2.txt", "b3.txt"];
        expect(await names(s, "/d")).toEqual(["Photos"]);
        expect(await names(s, "/d/Photos")).toEqual(all);
        for (const name of all) expect(await s.readText(`/d/Photos/${name}`)).toBe(name);
    });

    it("keeps a file saved in one tab while another tab moves a file out of that folder", async () => {
        // The Trash: "Move to Trash" is a rename. Its first write of /d - the
        // entry marked as being moved - was made to the copy of /d this tab
        // held, which did not have the other tab's new file.
        const { store, content, a, b } = twoTabs(late);
        await a.writeFile("/d/old.txt", "old");
        await a.mkdir("/trash");
        await b.list("/d");
        await b.list("/trash");
        const held = holdPut(store, await recordKey(a, "/d"), 1);

        const saving = a.writeFile("/d/new.txt", "new");
        await held.holding;
        const trashing = b.rename("/d/old.txt", "/trash/old.txt");
        const dId = (await recordKey(a, "/d")).slice("vfs/d/".length);
        await vi.waitFor(() => expect((b as any).writing.has(dId)).toBe(true), { interval: 1 });   // b's mark of old.txt made to its copy of /d
        held.release();
        await Promise.all([saving, trashing]);

        const s = stored(store, content);
        expect(await names(s, "/d")).toEqual(["new.txt"]);
        expect(await names(s, "/trash")).toEqual(["old.txt"]);
        expect(await s.readText("/trash/old.txt")).toBe("old");
        expect(await s.readText("/d/new.txt")).toBe("new");
    });

    it("fails a save whose folder's lock cannot be had, shows nothing of it, and a retry works", async () => {
        const store = makeStore();
        const content = makeContent();
        const A = device().tab();
        let refuse = false;
        const coordinator: VfsCoordinator = {
            ...A.coordinator,
            lock: (id, fn) =>
                refuse ? Promise.reject(new VfsConflictError("another tab has been writing it too long")) : A.coordinator.lock(id, fn),
        };
        const vfs = new VfsNamespace({ store, content, seed: () => SEED, coordinator });
        await vfs.mkdir("/d");

        refuse = true;
        await expect(vfs.writeFile("/d/x.txt", "x")).rejects.toThrow(VfsConflictError);
        expect(await names(vfs, "/d")).toEqual([]);
        expect(await names(stored(store, content), "/d")).toEqual([]);

        refuse = false;
        await vfs.writeFile("/d/x.txt", "x");
        expect(await names(stored(store, content), "/d")).toEqual(["x.txt"]);
    });

    it("fails a save whose re-read under the lock fails, writes nothing, and a retry works", async () => {
        const { store, content, a, b } = twoTabs(late);
        await a.mkdir("/d");
        await b.list("/d");
        const key = await recordKey(a, "/d");
        const held = holdPut(store, key, 1);

        const first = a.writeFile("/d/a.txt", "a");
        await held.holding;
        const second = b.writeFile("/d/b.txt", "b");
        await vi.waitFor(async () => expect(await names(b, "/d")).toEqual(["b.txt"]), { interval: 1 });
        failNextGet(store, key);                 // the read b makes under the lock, once a has written
        held.release();
        await first;

        await expect(second).rejects.toThrow("network");
        expect(await names(b, "/d")).toEqual(["a.txt"]);
        expect(await names(stored(store, content), "/d")).toEqual(["a.txt"]);
        await b.writeFile("/d/b.txt", "b");
        expect(await names(stored(store, content), "/d")).toEqual(["a.txt", "b.txt"]);
    });

    it("starts hearing the other tabs before it first reads a folder", async () => {
        const { a, b, B, heard } = twoTabs(late);
        await a.mkdir("/d");
        B.deafen();                               // as before its channel is open

        expect(await names(b, "/d")).toEqual([]); // its first read: it hears from here on
        await a.writeFile("/d/a.txt", "a");
        heard();

        expect(await names(b, "/d")).toEqual(["a.txt"]);
    });

    it("re-reads a folder before writing it when this tab may have missed another's write of it", async () => {
        const { store, content, a, b, B } = twoTabs(late);
        await a.mkdir("/d");
        await b.list("/d");
        B.deafen();                               // as before its channel is open
        await a.writeFile("/d/a.txt", "a");       // b does not hear of this

        await b.writeFile("/d/b.txt", "b");       // b starts hearing, told it may have missed some

        expect(await names(stored(store, content), "/d")).toEqual(["a.txt", "b.txt"]);
    });

    it("refuses to delete a folder it read before it could hear another tab move something out, then deletes it", async () => {
        const { store, content, a, b, B } = twoTabs(late);
        await a.writeFile("/x/d/f.txt", "f");
        await a.mkdir("/y");
        await b.walk("/");                        // b has every record cached
        B.deafen();
        await a.rename("/x/d", "/y/d");           // b does not hear of it

        const first = await b.delete("/x", { recursive: true }).then(() => "done", (err: unknown) => err);

        expect(first).toBeInstanceOf(VfsConflictError);
        expect(await stored(store, content).readText("/y/d/f.txt")).toBe("f");
        await b.delete("/x", { recursive: true });
        expect(await names(stored(store, content), "/")).toEqual(["y"]);
        expect(await stored(store, content).readText("/y/d/f.txt")).toBe("f");
    });

    it("refuses to delete a folder inside one another tab deleted while this tab was reading it, rather than writing back what was purged", async () => {
        // b had looked up /p/d, and was reading what it held, when a deleted
        // /p. b took /p/d's lock once a had let go of it, and a had counted
        // its write of the root by then, though not its purge of /p, which
        // counts nothing - and announces nothing. b took its copy of /p for
        // current, wrote it back, and let go of x.txt's content a second
        // time: /q/x.txt, a copy, named content that was gone.
        const { store, content, a, b } = twoTabs(late);
        await a.writeFile("/p/d/x.txt", "x");
        await a.copy("/p/d/x.txt", "/q/x.txt");   // shares x.txt's content
        await b.list("/p");                       // b has / and /p cached, not /p/d
        const folder = await recordKey(a, "/p");
        const read = holdGet(store, await recordKey(a, "/p/d"));

        const del = outcome(b.delete("/p/d", { recursive: true }));
        await read.holding;                       // b is reading /p/d
        await a.delete("/p", { recursive: true });
        read.release();

        expect(await del).toBeInstanceOf(VfsNotFoundError);
        expect(store.records.has(folder)).toBe(false);   // nothing wrote /p's record back
        const s = stored(store, content);
        expect(await s.walk("/")).toEqual(["/q/x.txt"]);
        expect(await s.readText("/q/x.txt")).toBe("x");
    });

    it("refuses to delete a file in a folder another tab deleted after the delete looked, though a save in this tab has read the folder above again since", async () => {
        // b's delete found /p/x.txt in its copy of the root, and asked for
        // x.txt's lock; a then deleted /p. Before b had the lock, a save of
        // b's into the root read the root again, under the root's lock,
        // without /p, and counted its write. That copy was current by the
        // time the delete read the counters, though the delete had found /p
        // in it: b wrote /p's record back and let go of x.txt's content a
        // second time.
        const { store, content, a, b, B } = twoTabs(late);
        await a.writeFile("/p/x.txt", "x");
        await a.copy("/p/x.txt", "/q/x.txt");     // shares x.txt's content
        await b.walk("/");
        const folder = await recordKey(a, "/p");
        const file = ((await (b as any).openDir("/p")) as { node: { entries: Record<string, { id: string }> } }).node.entries["x.txt"].id;
        const lock = holdLockRequest(B, file);

        const del = outcome(b.delete("/p/x.txt"));
        await lock.asking;                        // b's delete has looked up /p/x.txt
        await a.delete("/p", { recursive: true });
        await b.writeFile("/r.txt", "r");         // b reads / again, under its lock
        lock.release();

        expect(await del).toBeInstanceOf(VfsNotFoundError);
        expect(store.records.has(folder)).toBe(false);   // nothing wrote /p's record back
        const s = stored(store, content);
        expect(await s.walk("/")).toEqual(["/q/x.txt", "/r.txt"]);
        expect(await s.readText("/q/x.txt")).toBe("x");
    });

    it("deletes a file at once while this tab's own write of its folder is still in flight", async () => {
        // The Trash's "Delete forever", clicked while the move into the Trash
        // is still clearing its mark. The folder's counter reads as unknown
        // while this tab's own write of it is under way. Were the folder
        // taken for out of date for that, and dropped, the delete would wait
        // for the write before it could look the file up again, and the file
        // would stay listed until then.
        const { store, content, a } = twoTabs(late);
        await a.writeFile("/a/f.txt", "f");
        await a.mkdir("/b");
        const held = holdPut(store, await recordKey(a, "/b"), 2);   // the move's second write of /b: the mark cleared

        const move = a.rename("/a/f.txt", "/b/f.txt");
        await held.holding;
        const del = a.delete("/b/f.txt");
        await vi.waitFor(async () => expect(await names(a, "/b")).toEqual([]), { interval: 1 });
        held.release();
        await Promise.all([move, del]);

        expect(await names(stored(store, content), "/b")).toEqual([]);
    });

    it("keeps another tab's write that this tab hears of only after writing the same folder, and warns of no loss", async () => {
        // b had not heard of a's write when it took /d's lock, and wrote its
        // own copy of /d over it: a.txt was gone, and b, hearing of it only
        // then, warned that a's write may be lost. a counts its write before
        // it lets go of the lock, and b reads /d again when the count has
        // moved since its copy was read.
        const { store, content, a, b, B } = twoTabs(late);
        await a.mkdir("/d");
        await b.list("/d");
        const key = await recordKey(a, "/d");
        B.delay();                                // what a announces reaches b late
        await a.writeFile("/d/a.txt", "a");
        const held = holdPut(store, key, 1);      // b's write of /d, once sent
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
            const writing = b.writeFile("/d/b.txt", "b");
            await held.holding;
            B.deliver();                          // heard only now
            held.release();
            await writing;
            expect(warn).not.toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
        expect(await names(stored(store, content), "/d")).toEqual(["a.txt", "b.txt"]);
    });
});

describe.each(MODES)("VFS — a move in one tab, and a move or delete of the same thing in another$when", ({ late }) => {
    it("refuses a second move, in another tab, of a file the first tab is still moving", async () => {
        // b found the file marked - by a's move, still writing - took the
        // mark for an interrupted move, and finished it: the file ended up
        // named in /b and /c, with one content reference between them.
        const { store, content, a, b } = twoTabs(late);
        await a.writeFile("/a/f.txt", "f");
        await a.mkdir("/b");
        await a.mkdir("/c");
        await b.walk("/");
        const attach = holdPut(store, await recordKey(a, "/b"), 1);   // a's move putting it in /b

        const move = outcome(a.rename("/a/f.txt", "/b/f.txt"));
        await attach.holding;                     // /a/f.txt marked, and b has heard
        const second = await outcome(b.rename("/a/f.txt", "/c/f.txt"));
        attach.release();

        expect(second).toBeInstanceOf(VfsConflictError);
        expect(await move).toBe("done");
        const s = stored(store, content);
        expect(await s.walk("/")).toEqual(["/b/f.txt"]);
        expect(await s.readText("/b/f.txt")).toBe("f");
    });

    it("refuses a rename in place, in another tab, of a file the first tab is moving elsewhere", async () => {
        // b's rename found the file marked and took it, mark and all: renamed
        // in /a while a put it in /b, one file named in two places.
        const { store, content, a, b } = twoTabs(late);
        await a.writeFile("/a/f.txt", "f");
        await a.mkdir("/b");
        await b.walk("/");
        const attach = holdPut(store, await recordKey(a, "/b"), 1);

        const move = outcome(a.rename("/a/f.txt", "/b/f.txt"));
        await attach.holding;
        const renamed = await outcome(b.rename("/a/f.txt", "/a/g.txt"));
        attach.release();

        expect(renamed).toBeInstanceOf(VfsConflictError);
        expect(await move).toBe("done");
        expect(await stored(store, content).walk("/")).toEqual(["/b/f.txt"]);
    });

    it("refuses to delete, in another tab, a file the first tab is still moving, rather than letting go of its content", async () => {
        // b found the file marked, looked for its other half - which a had
        // not yet put in /b - found none, and let go of its content: a then
        // named it in /b with nothing behind it.
        const { store, content, a, b } = twoTabs(late);
        await a.writeFile("/a/f.txt", "f");
        await a.mkdir("/b");
        await b.walk("/");
        const attach = holdPut(store, await recordKey(a, "/b"), 1);

        const move = outcome(a.rename("/a/f.txt", "/b/f.txt"));
        await attach.holding;
        const del = await outcome(b.delete("/a/f.txt"));
        attach.release();

        expect(del).toBeInstanceOf(VfsConflictError);
        expect(await move).toBe("done");
        const s = stored(store, content);
        expect(await s.walk("/")).toEqual(["/b/f.txt"]);
        expect(await s.readText("/b/f.txt")).toBe("f");
    });

    it("refuses to delete, in another tab, a folder the first tab is still moving, rather than purging it from its new place", async () => {
        const { store, content, a, b } = twoTabs(late);
        await a.writeFile("/a/d/f.txt", "f");
        await a.mkdir("/b");
        await b.walk("/");
        const attach = holdPut(store, await recordKey(a, "/b"), 1);

        const move = outcome(a.rename("/a/d", "/b/d"));
        await attach.holding;
        const del = await outcome(b.delete("/a/d", { recursive: true }));
        attach.release();

        expect(del).toBeInstanceOf(VfsConflictError);
        expect(await move).toBe("done");
        const s = stored(store, content);
        expect(await s.walk("/")).toEqual(["/b/d/f.txt"]);
        expect(await s.readText("/b/d/f.txt")).toBe("f");
    });

    it("refuses to delete, in another tab, a folder holding something the first tab is still moving", async () => {
        const { store, content, a, b, heard } = twoTabs(late);
        await a.writeFile("/a/d/f.txt", "f");
        await a.writeFile("/a/g.txt", "g");
        await a.mkdir("/b");
        await b.walk("/");
        const attach = holdPut(store, await recordKey(a, "/b"), 1);

        const move = outcome(a.rename("/a/d", "/b/d"));
        await attach.holding;
        const del = await outcome(b.delete("/a", { recursive: true }));
        attach.release();

        expect(del).toBeInstanceOf(VfsConflictError);
        expect(await move).toBe("done");
        const s = stored(store, content);
        expect(await s.walk("/")).toEqual(["/a/g.txt", "/b/d/f.txt"]);
        expect(await s.readText("/b/d/f.txt")).toBe("f");
        // Refused, it let go of the locks it did get: tried again, once it
        // has heard of the move, it works.
        heard();
        await b.delete("/a", { recursive: true });
        expect(await stored(store, content).walk("/")).toEqual(["/b/d/f.txt"]);
    });

    it("refuses a move, in another tab, of something in a folder this tab is deleting, rather than purging it from where the move put it", async () => {
        // a had checked /a and was writing / without it when b - which had
        // not heard of the delete yet - moved /a/d out. a then purged every
        // record it had read, /a/d's among them, and let go of f.txt's
        // content: /b/d named a record that no longer existed.
        const { store, content, a, b } = twoTabs(late);
        await a.writeFile("/a/d/f.txt", "f");
        await a.mkdir("/b");
        await b.walk("/");
        const detach = holdPut(store, await recordKey(a, "/"), 1);   // a's write of / without /a

        const del = outcome(a.delete("/a", { recursive: true }));
        await detach.holding;
        const move = await outcome(b.rename("/a/d", "/b/d"));
        detach.release();

        expect(move).toBeInstanceOf(VfsConflictError);
        expect(await del).toBe("done");
        const s = stored(store, content);
        expect(await names(s, "/")).toEqual(["b"]);
        expect(await names(s, "/b")).toEqual([]);
    });

    it("refuses a move of something a delete in another tab is still purging, from a tab that has not heard of the delete yet", async () => {
        // The delete holds its locks until it has let go of everything, not
        // only until its parent is written: a tab that has not yet heard of
        // that write still finds /a/d where it was, and moved it out of
        // records that were being purged.
        const { store, content, a, b, B } = twoTabs(late);
        await a.writeFile("/a/d/f.txt", "f");
        await a.mkdir("/b");
        await b.walk("/");
        B.delay();                                // what a announces reaches b late
        const purge = holdDelete(store, await recordKey(a, "/a/d"));   // a purging /a/d's record

        const del = outcome(a.delete("/a", { recursive: true }));
        await purge.holding;                      // / written without /a; the purge under way
        const move = await outcome(b.rename("/a/d", "/b/d"));
        purge.release();
        B.deliver();

        expect(move).toBeInstanceOf(VfsConflictError);
        expect(await del).toBe("done");
        expect(await names(stored(store, content), "/b")).toEqual([]);
    });

    it("refuses to delete a folder another tab saved into since the delete read it, rather than letting go of a file then moved out", async () => {
        // b saved g.txt into /a/d after a's delete had read /a/d, and a read
        // /a/d again - b's write announced - before it checked it. So a
        // purged g.txt with the rest without holding g.txt's move lock: b
        // moved it to /b while a was writing /, and a let go of its content.
        const { store, content, a, b, heard } = twoTabs(late);
        await a.writeFile("/a/d/f.txt", "f");
        await a.mkdir("/b");
        await b.walk("/");
        const folder = await recordKey(a, "/a/d");
        const root = await recordKey(a, "/");
        await b.writeFile("/a/d/e.txt", "e");
        heard();                                  // a reads /a/d from the store next
        const read = holdGet(store, folder);
        const detach = holdPut(store, root, 1);

        const del = outcome(a.delete("/a", { recursive: true }));
        await read.holding;                       // a has read /a/d, without g.txt
        await b.writeFile("/a/d/g.txt", "g");
        read.release();
        await Promise.race([del, detach.holding]);   // refused - or checked, and writing /
        await b.rename("/a/d/g.txt", "/b/g.txt");
        detach.release();

        expect(await del).toBeInstanceOf(VfsConflictError);
        const s = stored(store, content);
        expect(await s.readText("/b/g.txt")).toBe("g");
        expect(await s.readText("/a/d/f.txt")).toBe("f");
    });

    it("lets another tab delete a file a move of it left marked when the move failed part way", async () => {
        // The move's lock goes when the move does, failed or not: kept, the
        // file could not be moved or deleted in any tab again.
        const { store, content, a, b, heard } = twoTabs(late);
        await a.writeFile("/a/f.txt", "f");
        await a.mkdir("/b");
        await b.walk("/");
        failNextPut(store, await recordKey(a, "/b"));   // a's move cannot put it in /b

        await expect(a.rename("/a/f.txt", "/b/f.txt")).rejects.toThrow("network");
        heard();                                  // b knows the file is marked
        await b.delete("/a/f.txt");

        const s = stored(store, content);
        expect(await s.walk("/")).toEqual([]);
        expect(await names(s, "/")).toEqual(["a", "b"]);
    });

    it("passes on a move lock the browser will not give a delete, and lets go of the ones it was given", async () => {
        // A browser can refuse a lock request outright, as in a document that
        // is no longer fully active. The delete fails with that, not as if
        // another tab held the lock, and keeps none of the locks it did get:
        // kept, nothing in the folder could be moved or deleted in any tab.
        const { store, content, a, b, B } = twoTabs(late);
        await a.writeFile("/a/d/f.txt", "f");
        await a.mkdir("/b");
        await b.walk("/");
        const folder = ((await (b as any).openDir("/a/d")) as { id: string }).id;
        const refusal = new DOMException("the document is not fully active", "InvalidStateError");
        const hold = B.coordinator.holdMoving.bind(B.coordinator);
        B.coordinator.holdMoving = (id: string) => (id === folder ? Promise.reject(refusal) : hold(id));

        await expect(b.delete("/a", { recursive: true })).rejects.toBe(refusal);
        expect(await stored(store, content).walk("/")).toEqual(["/a/d/f.txt"]);
        await a.rename("/a/d/f.txt", "/b/f.txt");
        await a.delete("/a", { recursive: true });
        expect(await stored(store, content).walk("/")).toEqual(["/b/f.txt"]);
    });

    it("refuses a move, in another tab, of a file a delete has begun, while the delete looks for the other half of a move", async () => {
        // a's delete found f.txt marked and read the tree for its other half,
        // and took f.txt's move lock only after that. b's move, started
        // meanwhile, put it in /b, failed to take it from /a, and let go of
        // the lock: a then took it, and let go of what /b/f.txt named. a now
        // holds the lock before it looks, and b's move is refused.
        const { store, content, a, b, heard } = twoTabs(late);
        await a.writeFile("/a/f.txt", "f");
        await a.mkdir("/b");
        await a.mkdir("/c");
        await a.writeFile("/z/z.txt", "z");
        failNextPut(store, await recordKey(a, "/c"));   // a's move cannot put it in /c: marked, with no other half
        await expect(a.rename("/a/f.txt", "/c/f.txt")).rejects.toThrow("network");
        await b.walk("/");
        const source = await recordKey(b, "/a");
        const z = await recordKey(a, "/z");
        await b.writeFile("/z/y.txt", "y");
        heard();                                    // a reads /z from the store next
        const search = holdGet(store, z);

        const del = outcome(a.delete("/a/f.txt"));
        await search.holding;                       // a is reading the tree for the other half
        // b's write of /a, taking it from there, would fail.
        const put = store.put.bind(store);
        const keys: string[] = [];
        store.put = async (k: string, value: unknown) => {
            keys.push(k);
            if (k === source) throw new Error("network");
            return put(k, value);
        };
        const move = await outcome(b.rename("/a/f.txt", "/b/f.txt"));
        store.put = put;
        search.release();

        expect(move).toBeInstanceOf(VfsConflictError);
        expect(String(move)).toContain("being moved or deleted");
        expect(keys).toEqual([]);                   // refused at its start, it wrote nothing
        expect(await del).toBe("done");
        const s = stored(store, content);
        const files = await s.walk("/");
        expect(files).toEqual(["/z/y.txt", "/z/z.txt"]);
        // Nothing still named has lost its content.
        expect(await Promise.all(files.map((path) => s.readText(path)))).toEqual(["y", "z"]);
    });
});

describe.each(MODES)("VFS — a move into a folder, and a delete of that folder in another tab$when", ({ late }) => {
    it("refuses a move into a folder another tab is deleting, rather than putting what it moves where nothing names it", async () => {
        // a had checked /b/d and was writing /b without it when b moved f.txt
        // into /b/d. a then purged /b/d's record, and f.txt's entry with it:
        // f.txt was in no listing, and its content was still stored.
        const { store, content, a, b } = twoTabs(late);
        await a.writeFile("/a/f.txt", "f");
        await a.writeFile("/b/d/g.txt", "g");
        await b.walk("/");
        const detach = holdPut(store, await recordKey(a, "/b"), 1);   // a's write of /b without /b/d

        const del = outcome(a.delete("/b/d", { recursive: true }));
        await detach.holding;
        const move = await outcome(b.rename("/a/f.txt", "/b/d/f.txt"));
        detach.release();

        expect(move).toBeInstanceOf(VfsConflictError);
        expect(await del).toBe("done");
        const s = stored(store, content);
        expect(await s.walk("/")).toEqual(["/a/f.txt"]);
        expect(await s.readText("/a/f.txt")).toBe("f");
        // Nothing stored that nothing names: g.txt's content is let go of.
        expect([...content.blobs.values()].map((blob) => new TextDecoder().decode(blob.bytes))).toEqual(["f"]);
    });

    it("refuses a move into a folder it makes inside a folder another tab is deleting", async () => {
        // /b/d/e is new: b's move made it, inside /b/d, after a had read
        // /b/d. So a did not hold its lock, and a move holding that folder
        // alone went ahead: a then purged /b/d's record, and f.txt was in no
        // listing, its content still stored. /b/d is on the way to /b/d/e.
        const { store, content, a, b } = twoTabs(late);
        await a.writeFile("/a/f.txt", "f");
        await a.writeFile("/b/d/g.txt", "g");
        await b.walk("/");
        const detach = holdPut(store, await recordKey(a, "/b"), 1);   // a's write of /b without /b/d

        const del = outcome(a.delete("/b/d", { recursive: true }));
        await detach.holding;
        const move = await outcome(b.rename("/a/f.txt", "/b/d/e/f.txt"));
        detach.release();

        expect(move).toBeInstanceOf(VfsConflictError);
        expect(await del).toBe("done");
        const s = stored(store, content);
        expect(await s.walk("/")).toEqual(["/a/f.txt"]);
        expect(await s.readText("/a/f.txt")).toBe("f");
        expect([...content.blobs.values()].map((blob) => new TextDecoder().decode(blob.bytes))).toEqual(["f"]);
    });

    it("refuses to delete a folder another tab is moving something into, and deletes both once the move is done", async () => {
        // a read /b/d before b's move had put f.txt there, and purged it: b
        // then named f.txt in a record that nothing names.
        const { store, content, a, b, heard } = twoTabs(late);
        await a.writeFile("/a/f.txt", "f");
        await a.writeFile("/b/d/g.txt", "g");
        await b.walk("/");
        const attach = holdPut(store, await recordKey(a, "/b/d"), 1);   // b's move putting f.txt in /b/d

        const move = outcome(b.rename("/a/f.txt", "/b/d/f.txt"));
        await attach.holding;
        const del = await outcome(a.delete("/b/d", { recursive: true }));
        attach.release();

        expect(del).toBeInstanceOf(VfsConflictError);
        expect(await move).toBe("done");
        expect(await stored(store, content).walk("/")).toEqual(["/b/d/f.txt", "/b/d/g.txt"]);
        // Refused, it changed nothing: tried again once the move is done, and
        // heard of, it takes both.
        heard();
        await a.delete("/b/d", { recursive: true });
        expect(await stored(store, content).walk("/")).toEqual([]);
        expect(content.blobs.size).toBe(0);
    });

    it("lets two tabs move files into one folder at the same time", async () => {
        // Each move holds the folder's lock shared, so neither refuses the other.
        const { store, content, a, b } = twoTabs(late);
        await a.writeFile("/a/f.txt", "f");
        await a.writeFile("/b/g.txt", "g");
        await a.mkdir("/d");
        await b.walk("/");
        const mark = holdPut(store, await recordKey(a, "/b"), 1);   // b marking g.txt, its locks held

        const second = outcome(b.rename("/b/g.txt", "/d/g.txt"));
        await mark.holding;
        const first = await outcome(a.rename("/a/f.txt", "/d/f.txt"));
        mark.release();

        expect(first).toBe("done");
        expect(await second).toBe("done");
        const s = stored(store, content);
        expect(await s.walk("/")).toEqual(["/d/f.txt", "/d/g.txt"]);
        expect(await s.readText("/d/g.txt")).toBe("g");
    });

    it("refuses one of two moves, in two tabs, that would each put a folder below the other", async () => {
        // a moved /p/x into /q/d/e while b moved /q/d into /p/x/y. Each held
        // only the folder it went into, so neither refused the other: x ended
        // up below d and d below x, and neither was in any listing.
        const { store, content, a, b } = twoTabs(late);
        await a.writeFile("/p/x/y/k.txt", "k");
        await a.mkdir("/q/d/e", { recursive: true });
        await b.walk("/");
        const attach = holdPut(store, await recordKey(a, "/q/d/e"), 1);   // a putting x in /q/d/e, its locks held

        const first = outcome(a.rename("/p/x", "/q/d/e/x"));
        await attach.holding;
        const second = await outcome(b.rename("/q/d", "/p/x/y/d"));
        attach.release();

        expect(second).toBeInstanceOf(VfsConflictError);
        expect(await first).toBe("done");
        const s = stored(store, content);
        expect(await s.walk("/")).toEqual(["/q/d/e/x/y/k.txt"]);
        expect(await s.readText("/q/d/e/x/y/k.txt")).toBe("k");
    });

    it("refuses a move into a folder another tab deleted after the move found it, and writes nothing", async () => {
        // The delete had finished, and let go of the folder's lock, by the
        // time the move asked for it: the move then marked f.txt, and wrote
        // again to take the mark off when it could not put f.txt there.
        const { store, content, a, b, B } = twoTabs(late);
        await a.writeFile("/a/f.txt", "f");
        await a.writeFile("/b/d/g.txt", "g");
        await b.walk("/");
        const folder = ((await (b as any).openDir("/b/d")) as { id: string }).id;
        const source = await recordKey(a, "/a");
        const asked = holdLockRequest(B, folder);   // b's move has found /b/d
        const keys = written(store);

        const move = outcome(b.rename("/a/f.txt", "/b/d/f.txt"));
        await Promise.race([asked.asking, move]);
        await a.delete("/b/d", { recursive: true });
        asked.release();

        expect(await move).toBeInstanceOf(VfsNotFoundError);
        expect(keys).not.toContain(source);
        expect(store.records.has(dirKey(folder))).toBe(false);
        const s = stored(store, content);
        expect(await s.walk("/")).toEqual(["/a/f.txt"]);
        expect(await names(s, "/b")).toEqual([]);
    });

    it("refuses a move into a folder another tab replaced after the move found it", async () => {
        // The lock the move holds is the old folder's. Put in the new one,
        // nothing would stop a delete of that one meanwhile.
        const { store, content, a, b, B } = twoTabs(late);
        await a.writeFile("/a/f.txt", "f");
        await a.writeFile("/b/d/g.txt", "g");
        await b.walk("/");
        const folder = ((await (b as any).openDir("/b/d")) as { id: string }).id;
        const asked = holdLockRequest(B, folder);

        const move = outcome(b.rename("/a/f.txt", "/b/d/f.txt"));
        await Promise.race([asked.asking, move]);
        await a.delete("/b/d", { recursive: true });
        await a.mkdir("/b/d");                     // another folder, of the same name
        asked.release();

        expect(await move).toBeInstanceOf(VfsConflictError);
        const s = stored(store, content);
        expect(await s.walk("/")).toEqual(["/a/f.txt"]);
        expect(await names(s, "/b/d")).toEqual([]);
    });
});

describe("VFS — two tabs that hear of each other's writes late, or never", () => {
    it("keeps both files when two tabs save into one folder, though neither hears of the other's save", async () => {
        // The second tab to take /d's lock had heard of no write of /d, so it
        // took its copy, read before the other tab's save, for current and
        // wrote it over that save. In Brave, 3 of 4 upload checks lost a file
        // this way (Task 8).
        const { store, content, a, b } = twoTabs(true);
        await a.mkdir("/d");
        await b.list("/d");

        await a.writeFile("/d/a1.txt", "a1");
        await b.writeFile("/d/b1.txt", "b1");
        await Promise.all([a.writeFile("/d/a2.txt", "a2"), b.writeFile("/d/b2.txt", "b2")]);

        const s = stored(store, content);
        expect(await names(s, "/d")).toEqual(["a1.txt", "a2.txt", "b1.txt", "b2.txt"]);
        expect(await s.readText("/d/a1.txt")).toBe("a1");
    });

    it("keeps both files named in one folder when two tabs each move a file into it at once, though neither hears of the other's move", async () => {
        // The Trash (Task 8's M3): the second move to put its file in /trash
        // wrote its copy of /trash, without the first one's file, and the
        // first move took that file from where it was. It was in no listing.
        const { store, content, a, b } = twoTabs(true);
        await a.writeFile("/x/y.txt", "y");
        await a.writeFile("/w/z.txt", "z");
        await a.mkdir("/trash");
        await b.walk("/");

        const moves = await Promise.all([
            outcome(a.rename("/x/y.txt", "/trash/y.txt")),
            outcome(b.rename("/w/z.txt", "/trash/z.txt")),
        ]);

        expect(moves).toEqual(["done", "done"]);
        const s = stored(store, content);
        expect(await s.walk("/")).toEqual(["/trash/y.txt", "/trash/z.txt"]);
        expect(await s.readText("/trash/y.txt")).toBe("y");
        expect(await s.readText("/trash/z.txt")).toBe("z");
    });

    it("re-reads a folder before writing it when its copy was fetched while another tab was writing it", async () => {
        // b's fetch of /d was answered with /d as it stood before a's write
        // landed. Had b read /d's counter once that answer came, the count
        // would already have held a's write, and b would have written its
        // copy over a's: the counter is read before the fetch.
        const { store, content, a, b } = twoTabs(true);
        await a.mkdir("/d");
        const read = holdGet(store, await recordKey(a, "/d"));   // b's fetch, answered with /d as it is when asked
        const listing = b.list("/d");
        await read.holding;
        await a.writeFile("/d/a.txt", "a");       // lands while that answer is on its way
        read.release();
        expect((await listing).map((stat) => stat.name)).toEqual([]);

        await b.writeFile("/d/b.txt", "b");

        expect(await names(stored(store, content), "/d")).toEqual(["a.txt", "b.txt"]);
    });

    it("refuses a move into a folder inside one another tab deleted after the move found it, though it never heard of the delete", async () => {
        // Decision 9, a move's second look. b's move found /b/d/e, and was
        // given the locks on the way to it once a's delete of /b/d had let go
        // of them. Its second look read its old copy of /b, which still named
        // /b/d: it marked f.txt, put it in /b/d/e's record - which a had
        // purged - and took it from /a. f.txt was in no listing.
        const { store, content, a, b, B } = twoTabs(true);
        await a.writeFile("/a/f.txt", "f");
        await a.writeFile("/b/d/e/g.txt", "g");
        await b.walk("/");
        const source = await recordKey(a, "/a");
        const way = holdWayRequests(B);           // b's move has found /b/d/e
        const keys = written(store);

        const move = outcome(b.rename("/a/f.txt", "/b/d/e/f.txt"));
        await Promise.race([way.asking, move]);
        await a.delete("/b/d", { recursive: true });
        way.release();

        expect(await move).toBeInstanceOf(VfsNotFoundError);
        expect(keys).not.toContain(source);       // f.txt was never marked
        const s = stored(store, content);
        expect(await s.walk("/")).toEqual(["/a/f.txt"]);
        expect(await s.readText("/a/f.txt")).toBe("f");
    });

    it("lets go of nothing another tab moved out of a folder before this tab deleted it, though it never heard of the move", async () => {
        // Decision 9, a delete's check. a had read /a/d with f.txt in it. b
        // then moved f.txt to /b and let go of its lock; a took the lock,
        // checked its old copy of /a/d, and let go of f.txt's content with
        // the rest: /b/f.txt named content that was gone.
        const { store, content, a, b } = twoTabs(true);
        await a.writeFile("/a/d/f.txt", "f");
        await a.writeFile("/a/d/k.txt", "k");
        await a.mkdir("/b");
        await b.walk("/");
        await b.rename("/a/d/f.txt", "/b/f.txt");   // a does not hear of it

        expect(await outcome(a.delete("/a", { recursive: true }))).toBe("done");

        const s = stored(store, content);
        expect(await s.walk("/")).toEqual(["/b/f.txt"]);
        expect(await s.readText("/b/f.txt")).toBe("f");
        expect(contentLeft(content)).toEqual(["f"]);
    });

    it("refuses to move a file another tab deleted with its folder, though it never heard of the delete", async () => {
        // b's look at /p/x/f.txt was its old copy of /p and of /p/x. It took
        // f.txt's lock once a's delete had let go of it, marked f.txt in
        // /p/x's record - which a had purged - put it in /b, and took it from
        // /p/x: /b/f.txt named content a had let go of. /p is on the way to
        // f.txt only, not to /b.
        const { store, content, a, b } = twoTabs(true);
        await a.writeFile("/p/x/f.txt", "f");
        await a.mkdir("/b");
        await b.walk("/");
        const folder = await recordKey(a, "/p/x");
        await a.delete("/p/x", { recursive: true });   // b does not hear of it

        const move = await outcome(b.rename("/p/x/f.txt", "/b/f.txt"));

        expect(move).toBeInstanceOf(VfsNotFoundError);
        expect(store.records.has(folder)).toBe(false);   // nothing wrote /p/x's record back
        const s = stored(store, content);
        expect(await s.walk("/")).toEqual([]);
        expect(await names(s, "/p")).toEqual([]);
    });

    it("refuses to delete a file in a folder another tab deleted, though it never heard of that delete", async () => {
        // The delete's own look at the way to its target. b's look at
        // /p/x.txt was its old copy of the root and of /p. It took x.txt's
        // lock once a's delete of /p had let go of it, took its copy of /p
        // for current - a purge counts nothing - wrote /p's record back
        // without x.txt, and let go of x.txt's content a second time:
        // /q/x.txt, a copy, named content that was gone.
        const { store, content, a, b } = twoTabs(true);
        await a.writeFile("/p/x.txt", "x");
        await a.copy("/p/x.txt", "/q/x.txt");     // shares x.txt's content
        await b.walk("/");
        const folder = await recordKey(a, "/p");
        await a.delete("/p", { recursive: true });   // b does not hear of it

        expect(await outcome(b.delete("/p/x.txt"))).toBeInstanceOf(VfsNotFoundError);

        expect(store.records.has(folder)).toBe(false);   // nothing wrote /p's record back
        const s = stored(store, content);
        expect(await s.walk("/")).toEqual(["/q/x.txt"]);
        expect(await s.readText("/q/x.txt")).toBe("x");
    });

    it("refuses to delete a folder inside one another tab deleted, though it never heard of that delete", async () => {
        // As above, a folder: b read /p/d's record and what it held from its
        // old copies, wrote /p's record back without /p/d, and let go of
        // x.txt's content a second time.
        const { store, content, a, b } = twoTabs(true);
        await a.writeFile("/p/d/x.txt", "x");
        await a.copy("/p/d/x.txt", "/q/x.txt");   // shares x.txt's content
        await b.walk("/");
        const folder = await recordKey(a, "/p");
        await a.delete("/p", { recursive: true });   // b does not hear of it

        expect(await outcome(b.delete("/p/d", { recursive: true }))).toBeInstanceOf(VfsNotFoundError);

        expect(store.records.has(folder)).toBe(false);   // nothing wrote /p's record back
        const s = stored(store, content);
        expect(await s.walk("/")).toEqual(["/q/x.txt"]);
        expect(await s.readText("/q/x.txt")).toBe("x");
    });

    it("reads again a folder it is deleting that its own save into is still waiting to write, and lets go of nothing another tab moved out", async () => {
        // a's save of g.txt into /a/d was made to its old copy of /a/d, with
        // f.txt in it, and its write waited for b's write of /a/d. a's delete
        // of /a checked that copy - the one being written - and let go of
        // f.txt's content with the rest, though b had moved f.txt to /b.
        const { store, content, a, b } = twoTabs(true);
        await a.writeFile("/a/d/f.txt", "f");
        await a.writeFile("/a/d/k.txt", "k");
        await a.mkdir("/b");
        await b.walk("/");
        await b.rename("/a/d/f.txt", "/b/f.txt");    // a does not hear of it
        const held = holdPut(store, await recordKey(b, "/a/d"), 1);   // b's next write of /a/d, its lock held
        const saving = b.writeFile("/a/d/h.txt", "h");
        await held.holding;
        const own = a.writeFile("/a/d/g.txt", "g");  // made to a's copy of /a/d, its write waiting for b's lock
        await vi.waitFor(() => expect((a as any).writing.size).toBeGreaterThan(0), { interval: 1 });

        const del = outcome(a.delete("/a", { recursive: true }));
        await Promise.race([del, new Promise((resolve) => setTimeout(resolve, 20))]);
        held.release();
        await Promise.all([saving, own]);

        expect(await del).toBeInstanceOf(VfsConflictError);
        const s = stored(store, content);
        expect(await s.readText("/b/f.txt")).toBe("f");
        expect(await names(s, "/a/d")).toEqual(["g.txt", "h.txt", "k.txt"]);
    });

    it("keeps the content of the other half of an interrupted move that another tab moved, though it never heard of that move", async () => {
        // f.txt was named, marked, in /a and in /c: a move of it was
        // interrupted. b moved /c/f.txt to /b. a then deleted /a/f.txt and
        // looked through the tree for the other half: in its old copy of /b,
        // which did not name it, and in /c, read afresh, which no longer did.
        // Finding none, it let go of the content /b/f.txt names.
        const { store, content, a, b, heard } = twoTabs(true);
        await a.writeFile("/a/f.txt", "f");
        await a.mkdir("/b");
        await a.mkdir("/c");
        failPut(store, await recordKey(a, "/a"), 2);   // a's move cannot take it from /a
        await expect(a.rename("/a/f.txt", "/c/f.txt")).rejects.toThrow("network");
        await a.walk("/");                             // a has /b cached
        await b.walk("/");
        await b.writeFile("/c/x.txt", "x");
        heard();                                       // a reads /c from the store next
        await b.rename("/c/f.txt", "/b/f.txt");        // a does not hear of it

        expect(await outcome(a.delete("/a/f.txt"))).toBe("done");

        const s = stored(store, content);
        expect(await s.walk("/")).toEqual(["/b/f.txt", "/c/x.txt"]);
        expect(await s.readText("/b/f.txt")).toBe("f");
    });

    it("sweeps away nothing another tab has named, though it never heard of the write", async () => {
        // b's sweep followed its old copy of the root, which did not name /n,
        // and deleted /n's record as unreachable: x.txt was gone.
        const { store, content, a, b } = twoTabs(true);
        await a.writeFile("/keep/k.txt", "k");
        await b.walk("/");
        await a.writeFile("/n/x.txt", "x");        // b does not hear of it

        expect((await b.sweep()).removed).toEqual([]);

        expect(await stored(store, content).readText("/n/x.txt")).toBe("x");
    });

    it("with IndexedDB unusable, reads each folder again under the lock before writing it, loses nothing, and warns once per tab", async () => {
        const { dev, store, content, a, b } = twoTabs(true);
        await a.mkdir("/d");
        await b.list("/d");
        const key = await recordKey(a, "/d");
        dev.breakStorage("all");
        const gets = store.gets.length;
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
            await a.writeFile("/d/a1.txt", "a1");
            await b.writeFile("/d/b1.txt", "b1");
            await Promise.all([a.writeFile("/d/a2.txt", "a2"), b.writeFile("/d/b2.txt", "b2")]);
            expect(store.gets.slice(gets).filter((k) => k === key)).toHaveLength(4);   // one read before each write
            await b.rename("/d/a1.txt", "/e/a1.txt");
            await a.writeFile("/d/a3.txt", "a3");
            // Its writes could not be counted, so a tab whose IndexedDB worked
            // could write over them. Said once per tab, not once per folder:
            // b wrote /e and / as well, and a and b each wrote /d three times.
            const said = warn.mock.calls.map(([message]) => String(message));
            expect(said).toHaveLength(2);
            expect(said.every((message) => message.includes("/d ") && message.includes("may be lost"))).toBe(true);
        } finally {
            warn.mockRestore();
        }
        const s = stored(store, content);
        expect(await names(s, "/d")).toEqual(["a2.txt", "a3.txt", "b1.txt", "b2.txt"]);
        expect(await s.readText("/e/a1.txt")).toBe("a1");
    });

    it("makes every tab read a folder again before writing it when a write of it was begun and could not be counted", async () => {
        // a's write of /d was marked as begun, but its count, once the write
        // had landed, could not be stored. The mark stays until a count can
        // be: until then, no tab takes its copy of /d for current.
        const { dev, store, content, a, b } = twoTabs(true);
        await a.mkdir("/d");
        await b.list("/d");
        dev.breakStorage("count");
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
            await a.writeFile("/d/a.txt", "a");
            await b.writeFile("/d/b.txt", "b");
            const said = warn.mock.calls.map(([message]) => String(message));
            expect(said).toHaveLength(2);
            expect(said.every((message) => message.includes("/d ") && !message.includes("may be lost"))).toBe(true);
        } finally {
            warn.mockRestore();
        }
        expect(await names(stored(store, content), "/d")).toEqual(["a.txt", "b.txt"]);
    });

    it("with IndexedDB unusable, reads again what it deletes, and lets go of nothing another tab moved out", async () => {
        const { dev, store, content, a, b } = twoTabs(true);
        await a.writeFile("/a/d/f.txt", "f");
        await a.writeFile("/a/d/k.txt", "k");
        await a.mkdir("/b");
        await b.walk("/");
        dev.breakStorage("all");
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
            await b.rename("/a/d/f.txt", "/b/f.txt");   // a does not hear of it
            expect(await outcome(a.delete("/a", { recursive: true }))).toBe("done");
        } finally {
            warn.mockRestore();
        }
        const s = stored(store, content);
        expect(await s.walk("/")).toEqual(["/b/f.txt"]);
        expect(contentLeft(content)).toEqual(["f"]);
    });

    it("keeps another tab's save made while this tab's count of its own write is still being stored", async () => {
        // a let go of /d's lock before the count of its write was stored. b
        // took the lock, found a's write begun and not counted, read /d again
        // and wrote it. a's count, stored only then, counted b's write as
        // well: a took its own copy of /d, without b's file, for current, and
        // wrote it over b's.
        const { dev, store, content, a, b } = twoTabs(true);
        await a.mkdir("/d");
        await b.list("/d");
        const count = dev.holdCount();            // the count of a's next write
        const first = a.writeFile("/d/a1.txt", "a1");
        await count.holding;                      // a's write has landed
        const second = b.writeFile("/d/b1.txt", "b1");
        // b waits for /d's lock - or, had a let go of it, writes and counts.
        await Promise.race([second, new Promise((resolve) => setTimeout(resolve, 20))]);
        await new Promise((resolve) => setTimeout(resolve, 5));
        count.release();
        await Promise.all([first, second]);
        await new Promise((resolve) => setTimeout(resolve, 5));   // every count asked for is stored by now

        await a.writeFile("/d/a2.txt", "a2");

        expect(await names(stored(store, content), "/d")).toEqual(["a1.txt", "a2.txt", "b1.txt"]);
    });
});

describe("VFS — two tabs, one of which cannot count its writes", () => {
    it("keeps a write another tab could not count, when this tab heard of it before writing", async () => {
        // a's IndexedDB failed, so its write of /d was not counted, and /d's
        // counter did not move. b had heard of the write, though, and read
        // /d again rather than take its copy for current. Had the
        // announcement come too late, a's write would have been lost, which
        // a says.
        const { store, content, a, b, A } = twoTabs();
        await a.mkdir("/d");
        await b.list("/d");
        A.coordinator.begin = async () => null;
        A.coordinator.bump = async () => null;
        const held = holdPut(store, await recordKey(a, "/d"), 1);   // a's write of /d, in flight
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
            const first = a.writeFile("/d/a.txt", "a");
            await held.holding;
            const second = b.writeFile("/d/b.txt", "b");
            await vi.waitFor(async () => expect(await names(b, "/d")).toEqual(["b.txt"]), { interval: 1 });   // b's edit made, its write waiting on the lock
            held.release();
            await Promise.all([first, second]);
            const said = warn.mock.calls.map(([message]) => String(message));
            expect(said).toHaveLength(1);
            expect(said[0]).toContain("may be lost");
        } finally {
            warn.mockRestore();
        }
        expect(await names(stored(store, content), "/d")).toEqual(["a.txt", "b.txt"]);
    });
});
