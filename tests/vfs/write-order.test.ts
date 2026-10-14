import { describe, it, expect, vi } from "vitest";
import { makeContent, makeStore, makeVfs } from "./harness";
import { VfsNamespace } from "../../src/vfs/VfsNamespace";
import { dirKey, VfsConflictError, VfsNotFoundError, type VfsStore } from "../../src/vfs/types";

/**
 * Hold back one write of one record, as a slow request is held up, while every
 * other write is stored at once. Whatever is sent while it is held lands
 * BEFORE it - which is what the personal space does with two writes of one key
 * sent together: it stores whichever request finishes last.
 *
 * `key` is a record's key, or a test of keys: `isHistory` holds the nth write
 * of any file's history. `fail` lets the write go as a failure instead, as a
 * dropped connection does. Holds stack: each wraps the store as it finds it.
 */
function holdWrite(made: ReturnType<typeof makeVfs>, key: string | ((key: string) => boolean), nth: number) {
    const { store } = made;
    const put = store.put.bind(store);
    const matches = typeof key === "string" ? (k: string) => k === key : key;
    let seen = 0;
    let reached!: () => void;
    let settle!: (err?: Error) => void;
    const holding = new Promise<void>((resolve) => (reached = resolve));
    const settled = new Promise<Error | undefined>((resolve) => (settle = resolve));
    store.put = async (k: string, value: unknown) => {
        if (matches(k) && ++seen === nth) {
            reached();
            const err = await settled;
            if (err) throw err;
        }
        return put(k, value);
    };
    return { holding, release: () => settle(), fail: () => settle(new Error("network")) };
}

const isHistory = (key: string) => key.startsWith("vfs/h/");

/** What the store holds, read by a namespace that has cached nothing. */
function fresh(made: ReturnType<typeof makeVfs>): VfsNamespace {
    return new VfsNamespace({ store: made.store, content: made.content, seed: () => new Uint8Array(32).fill(7) });
}

/**
 * A VFS whose change feed the test drives. `echo(key)` delivers the frame the
 * personal space sends after a write of `key` - our own writes included, which
 * is how `watch()` comes to drop a record this tab is still writing.
 */
function watched() {
    const made = makeVfs();
    let deliver!: (frame: unknown) => void;
    const vfs = new VfsNamespace({
        store: made.store,
        content: made.content,
        seed: () => new Uint8Array(32).fill(7),
        subscribe: (handler) => {
            deliver = handler;
            return () => {};
        },
    });
    vfs.watch(() => {});
    return { ...made, vfs, echo: (key: string) => deliver({ _t: "change", key }) };
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => (resolve = done));
    return { promise, resolve };
}

async function recordKey(vfs: VfsNamespace, path: string): Promise<string> {
    return dirKey(((await (vfs as any).openDir(path)) as { id: string }).id);
}

async function names(vfs: VfsNamespace, path: string): Promise<string[]> {
    return (await vfs.list(path)).map((stat) => stat.name);
}

/**
 * `names`, for a listing that must arrive while the test is still holding a
 * write. One that waits for that write fails here within a second, rather than
 * hanging until the test times out.
 */
async function namesWhileHeld(vfs: VfsNamespace, path: string): Promise<string[]> {
    let found: string[] | undefined;
    // A listing that throws fails the test as itself, not as a wait that timed out.
    let failed: { err: unknown } | undefined;
    void names(vfs, path).then((got) => (found = got), (err) => (failed = { err }));
    await vi.waitFor(() => {
        if (failed) return;
        expect(found, `the listing of ${path} waited for the held write`).toBeDefined();
    }, { interval: 1 });
    if (failed) throw failed.err;
    return found!;
}

/**
 * Wait until a listing of `path` reads `expected`. For a directory whose write
 * is held: an edit is made to the cached record and its write queued in the
 * same step, so once the listing shows the edit, its write is waiting behind
 * the held one.
 */
function listed(vfs: VfsNamespace, path: string, expected: string[]): Promise<void> {
    return vi.waitFor(async () => {
        expect(await names(vfs, path)).toEqual(expected);
    }, { interval: 1 });
}

/**
 * Wait until a read of record `key` has begun: gone to the store, or waiting
 * to. Either way its promise is in the cache, put there in the same step as
 * the store is asked - so whatever the store was asked, it was asked by now.
 */
function fetching(vfs: VfsNamespace, key: string): Promise<void> {
    const id = key.slice("vfs/d/".length);
    return vi.waitFor(() => {
        expect((vfs as any).cache.has(id)).toBe(true);
    }, { interval: 1 });
}

/** The write of record `key` queued last, while it is in flight. */
function lastWrite(vfs: VfsNamespace, key: string): Promise<void> | undefined {
    return (vfs as any).writing.get(key.slice("vfs/d/".length));
}

/** A promise's outcome, without waiting on it here: "done", or what it threw. */
function outcome(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(() => "done", (err: unknown) => err);
}

/** Let everything that is not waiting on a held write run as far as it can. */
async function quiet(): Promise<void> {
    for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Every file the store names, by path, each read through to its content: a
 * file whose content has been let go of fails the read, and the test with it.
 */
async function everyFile(made: ReturnType<typeof makeVfs>): Promise<Record<string, string>> {
    const reader = fresh(made);
    const files: Record<string, string> = {};
    for (const path of await reader.walk("/")) files[path] = await reader.readText(path);
    return files;
}

/**
 * Every key written from here on, in order - and a write of `failing` fails,
 * as a dropped connection does. `stop()` puts the store back as it was.
 */
function writesFailing(store: VfsStore, failing: string) {
    const put = store.put.bind(store);
    const keys: string[] = [];
    store.put = async (k: string, value: unknown) => {
        keys.push(k);
        if (k === failing) throw new Error("network");
        return put(k, value);
    };
    return { keys, stop: () => void (store.put = put) };
}

describe("VFS — writes of one directory record", () => {
    it("keeps a file deleted when it is deleted while the move that put it there is still being written", async () => {
        // The Trash: "Move to Trash" is a rename into /.trash/files, and its
        // last write clears the move mark on the new entry. The entry already
        // shows in the listing - the edit is made to the cached record before
        // the write goes out - so Delete forever can be clicked with that write
        // still in flight. The delete's write, sent after it, landed first, and
        // the move's then put the entry back: still listed, its content
        // already let go.
        const made = makeVfs();
        const { vfs } = made;
        await vfs.writeFile("/a/f.txt", "x");
        await vfs.mkdir("/b");
        // /b is written twice by the move: the entry, marked; then the mark cleared.
        const held = holdWrite(made, await recordKey(vfs, "/b"), 2);

        const move = vfs.rename("/a/f.txt", "/b/f.txt");
        await held.holding;
        expect(await names(vfs, "/b")).toEqual(["f.txt"]);
        const del = vfs.delete("/b/f.txt");
        await listed(vfs, "/b", []);
        held.release();
        await Promise.all([move, del]);

        expect(await fresh(made).list("/b")).toEqual([]);
        expect(await vfs.list("/b")).toEqual([]);
    });

    it("keeps both of two files written into one directory at once, the first write held up", async () => {
        const made = makeVfs();
        const { vfs } = made;
        await vfs.mkdir("/a");
        const held = holdWrite(made, await recordKey(vfs, "/a"), 1);

        const first = vfs.writeFile("/a/one.txt", "1");
        await held.holding;
        const second = vfs.writeFile("/a/two.txt", "2");
        await listed(vfs, "/a", ["one.txt", "two.txt"]);
        held.release();
        await Promise.all([first, second]);

        const stored = fresh(made);
        expect(await names(stored, "/a")).toEqual(["one.txt", "two.txt"]);
        expect(await stored.readText("/a/two.txt")).toBe("2");
    });

    it("still writes a record after an earlier write of it failed", async () => {
        // The earlier write's failure is its caller's to handle. A write
        // waiting behind it must still go out.
        const made = makeVfs();
        const { vfs, store } = made;
        await vfs.mkdir("/a");
        const key = await recordKey(vfs, "/a");
        const put = store.put.bind(store);
        let fail!: () => void;
        const failing = new Promise<void>((resolve) => (fail = resolve));
        let reached!: () => void;
        const holding = new Promise<void>((resolve) => (reached = resolve));
        let first = true;
        store.put = async (k: string, value: unknown) => {
            if (k === key && first) {
                first = false;
                reached();
                await failing;
                throw new Error("network");
            }
            return put(k, value);
        };

        const one = vfs.writeFile("/a/one.txt", "1");
        await holding;
        const two = vfs.writeFile("/a/two.txt", "2");
        await listed(vfs, "/a", ["one.txt", "two.txt"]);
        fail();
        await expect(one).rejects.toThrow("network");
        await two;

        expect(await fresh(made).readText("/a/two.txt")).toBe("2");
    });

    it("keeps a directory cached when its write fails with the next write of it already queued", async () => {
        // The queued write carries every edit made to the record so far, the
        // failed one's included, and is about to store them. Dropping the
        // cache in that window sent every read to the store, for a copy older
        // than the one on its way.
        const made = makeVfs();
        const { vfs, store } = made;
        await vfs.writeFile("/a/old.txt", "0");
        const key = await recordKey(vfs, "/a");
        const put = store.put.bind(store);
        const firstSent = deferred();
        const fail = deferred();
        const secondSent = deferred();
        const release = deferred();
        let seen = 0;
        store.put = async (k: string, value: unknown) => {
            if (k === key && ++seen === 1) {
                firstSent.resolve();
                await fail.promise;
                throw new Error("network");
            }
            if (k === key && seen === 2) {
                secondSent.resolve();
                await release.promise;
            }
            return put(k, value);
        };

        const one = vfs.writeFile("/a/one.txt", "1");
        await firstSent.promise;
        const two = vfs.writeFile("/a/two.txt", "2");
        await listed(vfs, "/a", ["old.txt", "one.txt", "two.txt"]);
        fail.resolve();
        await expect(one).rejects.toThrow("network");
        await secondSent.promise;

        // The second write still held: the listing comes from the cache.
        const gets = store.gets.length;
        expect(await namesWhileHeld(vfs, "/a")).toEqual(["old.txt", "one.txt", "two.txt"]);
        expect(store.gets.length).toBe(gets);

        release.resolve();
        await two;
        const stored = fresh(made);
        expect(await names(stored, "/a")).toEqual(["old.txt", "one.txt", "two.txt"]);
        expect(await stored.readText("/a/two.txt")).toBe("2");
    });

    it("keeps every file whose write worked when a write of their directory fails once part way through", async () => {
        // Three files saved into one folder at once. The first write of the
        // folder's record fails, a transient error, with the second file's
        // write queued behind it; the third file is saved after the failure.
        const made = makeVfs();
        const { vfs, store } = made;
        await vfs.mkdir("/d");
        const key = await recordKey(vfs, "/d");
        const put = store.put.bind(store);
        const sent = deferred();
        const fail = deferred();
        let seen = 0;
        store.put = async (k: string, value: unknown) => {
            if (k === key && ++seen === 1) {
                sent.resolve();
                await fail.promise;
                throw new Error("transient 503");
            }
            return put(k, value);
        };
        // The file's name if its write worked, null if it threw.
        const outcome = (write: Promise<unknown>, name: string) => write.then(() => name, () => null);

        const a = outcome(vfs.writeFile("/d/a", "a"), "a");
        const b = outcome(vfs.writeFile("/d/b", "b"), "b");
        await sent.promise;
        await listed(vfs, "/d", ["a", "b"]);
        fail.resolve();
        expect(await a).toBeNull();
        const c = outcome(vfs.writeFile("/d/c", "c"), "c");
        const worked = (await Promise.all([a, b, c])).filter((name) => name !== null);

        expect(worked).toEqual(["b", "c"]);
        const stored = await names(fresh(made), "/d");
        expect(stored).toEqual(expect.arrayContaining(worked));
        expect(await names(vfs, "/d")).toEqual(stored);
    });
});

describe("VFS — a read of a directory record being written", () => {
    it("reads a directory being written as the write leaves it, not as the store had it before", async () => {
        // Our own writes echo back over the personal-space socket, and
        // `watch()` drops the record each one names. A read after that went
        // straight to the store - which, with the write still in flight, holds
        // the copy from before it.
        const made = watched();
        const { vfs, echo } = made;
        await vfs.writeFile("/a/old.txt", "0");
        const key = await recordKey(vfs, "/a");
        const held = holdWrite(made, key, 1);

        const write = vfs.writeFile("/a/one.txt", "1");
        await held.holding;
        echo(key);
        const reading = names(vfs, "/a");
        await fetching(vfs, key);
        held.release();
        await write;

        expect(await reading).toEqual(["old.txt", "one.txt"]);
    });

    it("keeps both edits when a directory is edited from a read taken while its last write was in flight", async () => {
        // The second edit is made to what the read returned, and its write is
        // queued behind the first. Made to the copy from before the first
        // write, it was sent after it - and stored over it.
        const made = watched();
        const { vfs, echo } = made;
        await vfs.writeFile("/a/old.txt", "0");
        const key = await recordKey(vfs, "/a");
        const held = holdWrite(made, key, 1);

        const first = vfs.writeFile("/a/one.txt", "1");
        await held.holding;
        echo(key);
        const second = vfs.writeFile("/a/two.txt", "2");
        await fetching(vfs, key);
        held.release();
        await Promise.all([first, second]);

        expect(await names(fresh(made), "/a")).toEqual(["old.txt", "one.txt", "two.txt"]);
        expect(await names(vfs, "/a")).toEqual(["old.txt", "one.txt", "two.txt"]);
    });

    it("keeps an edit made from the cache while a read that waited for the write is still being answered", async () => {
        // A write that lands puts the record it wrote back in the cache, and
        // the next edit of the directory is made to that. A read that waited
        // for the write and then fetched a copy of its own would leave two
        // records for one directory, each edited and written, the later
        // undoing the earlier.
        const made = watched();
        const { vfs, store, echo } = made;
        await vfs.writeFile("/a/old.txt", "0");
        const key = await recordKey(vfs, "/a");
        const held = holdWrite(made, key, 1);
        // A fetch of /a answers with the record as it was when asked, however
        // long the answer then takes to arrive.
        const get = store.get.bind(store);
        const answer = deferred();
        store.get = async (k: string) => {
            const value = await get(k);
            if (k === key) await answer.promise;
            return value;
        };

        const first = vfs.writeFile("/a/one.txt", "1");
        await held.holding;
        echo(key);
        const second = vfs.writeFile("/a/two.txt", "2");
        await fetching(vfs, key);
        held.release();
        await first;
        await vfs.writeFile("/a/three.txt", "3");
        answer.resolve();
        await second;

        expect(await names(fresh(made), "/a")).toEqual(["old.txt", "one.txt", "three.txt", "two.txt"]);
        expect(await names(vfs, "/a")).toEqual(["old.txt", "one.txt", "three.txt", "two.txt"]);
    });

    it("gives reads that waited for a write that failed one copy of the directory between them", async () => {
        // A failed write that is the last one queued drops the cached record.
        // After an echo, what the cache held was the promise of a read waiting
        // for that write, so every read after it fetched a copy of its own. Of
        // two copies of one record, each edited and written, the later undid
        // the earlier: here, one of two files saved into the folder vanished.
        const made = watched();
        const { vfs, store, echo } = made;
        await vfs.writeFile("/a/old.txt", "0");
        const key = await recordKey(vfs, "/a");
        const put = store.put.bind(store);
        const sent = deferred();
        const fail = deferred();
        let seen = 0;
        store.put = async (k: string, value: unknown) => {
            if (k === key && ++seen === 1) {
                sent.resolve();
                await fail.promise;
                throw new Error("network");
            }
            return put(k, value);
        };

        const one = vfs.writeFile("/a/one.txt", "1");
        await sent.promise;
        echo(key);
        const two = vfs.writeFile("/a/two.txt", "2");
        await fetching(vfs, key);
        // A second echo, of some other write of /a, lets a second read in.
        echo(key);
        const three = vfs.writeFile("/a/three.txt", "3");
        await fetching(vfs, key);
        const gets = store.gets.length;
        fail.resolve();
        await expect(one).rejects.toThrow("network");
        await Promise.all([two, three]);

        const fetched = store.gets.slice(gets).filter((k) => k === key);
        expect(await names(fresh(made), "/a")).toEqual(["old.txt", "three.txt", "two.txt"]);
        expect(await names(vfs, "/a")).toEqual(["old.txt", "three.txt", "two.txt"]);
        expect(fetched).toHaveLength(1);   // one copy, fetched once
    });

    it("waits for a write queued while a read waited, when the write it waited for failed", async () => {
        // A read waits for the write in flight when it starts. While it waits,
        // an operation that already held the directory can queue another write
        // of it: an overwrite holds it across storing the old version's
        // history. If the first write then fails, the second is still on its
        // way, and the store answers with the copy from before it. An edit
        // made to that copy was stored over the overwrite.
        const made = watched();
        const { vfs, store, echo } = made;
        await vfs.writeFile("/a/old.txt", "0");
        const key = await recordKey(vfs, "/a");
        const put = store.put.bind(store);
        const sent = deferred();
        const fail = deferred();
        const historySent = deferred();
        const history = deferred();
        let seen = 0;
        let historyHeld = false;
        store.put = async (k: string, value: unknown) => {
            if (k === key && ++seen === 1) {
                sent.resolve();
                await fail.promise;
                throw new Error("network");
            }
            if (k.startsWith("vfs/h/") && !historyHeld) {
                historyHeld = true;
                historySent.resolve();
                await history.promise;
            }
            return put(k, value);
        };

        const one = vfs.writeFile("/a/one.txt", "1");
        await sent.promise;
        const over = vfs.writeFile("/a/old.txt", "new");
        await historySent.promise;
        echo(key);
        const three = vfs.writeFile("/a/three.txt", "3");
        await fetching(vfs, key);
        // The overwrite's write is queued behind the first while the read waits.
        const first = lastWrite(vfs, key);
        history.resolve();
        await vi.waitFor(() => expect(lastWrite(vfs, key)).not.toBe(first), { interval: 1 });
        fail.resolve();
        await expect(one).rejects.toThrow("network");
        await Promise.all([over, three]);

        // one.txt too: the overwrite's write carried the failed edit, made to the same record.
        const stored = fresh(made);
        expect(await names(stored, "/a")).toEqual(["old.txt", "one.txt", "three.txt"]);
        expect(await stored.readText("/a/old.txt")).toBe("new");
        expect(await names(vfs, "/a")).toEqual(["old.txt", "one.txt", "three.txt"]);
        expect(await vfs.readText("/a/old.txt")).toBe("new");
    });

    it("does not hold up a read of another directory while one is being written", async () => {
        const made = watched();
        const { vfs, store, echo } = made;
        await vfs.writeFile("/a/old.txt", "0");
        await vfs.writeFile("/b/x.txt", "x");
        const a = await recordKey(vfs, "/a");
        const b = await recordKey(vfs, "/b");
        const held = holdWrite(made, a, 1);

        const write = vfs.writeFile("/a/one.txt", "1");
        await held.holding;
        echo(b);
        const gets = store.gets.length;
        const puts = store.puts;
        expect(await namesWhileHeld(vfs, "/b")).toEqual(["x.txt"]);
        expect(store.gets.slice(gets)).toContain(b);   // from the store, not the cache
        expect(store.puts).toBe(puts);                  // with the write of /a still held
        held.release();
        await write;
    });
});

describe("VFS — one copy of a directory record", () => {
    it("keeps a file saved into a directory while an overwrite there waits, when a write of the directory fails", async () => {
        // An overwrite holds the directory across storing the old version's
        // history. A write of the directory failing meanwhile dropped the
        // cached record, so the next save read a second copy and stored it,
        // with its file. The overwrite then stored the first copy over it:
        // three.txt, saved, was gone, and one.txt, whose save failed, was back.
        const made = makeVfs();
        const { vfs } = made;
        await vfs.writeFile("/a/old.txt", "0");
        const key = await recordKey(vfs, "/a");
        const failing = holdWrite(made, key, 1);
        const history = holdWrite(made, isHistory, 1);

        const one = vfs.writeFile("/a/one.txt", "1");
        await failing.holding;
        const over = vfs.writeFile("/a/old.txt", "new");
        await history.holding;
        failing.fail();
        await expect(one).rejects.toThrow("network");
        await vfs.writeFile("/a/three.txt", "3");
        history.release();
        await over;

        const stored = fresh(made);
        expect(await names(stored, "/a")).toEqual(["old.txt", "three.txt"]);
        expect(await stored.readText("/a/old.txt")).toBe("new");
        expect(await stored.readText("/a/three.txt")).toBe("3");
        expect(await names(vfs, "/a")).toEqual(["old.txt", "three.txt"]);
    });

    it("makes two edits held across a failed write of their directory to one copy of it", async () => {
        // Two overwrites in one directory, each holding it across storing its
        // file's history, with a write of the directory failing between the
        // two. The first held the copy from before the failure, the second
        // read a fresh one, and each edited and stored its own: whichever was
        // stored last undid the other.
        const made = makeVfs();
        const { vfs } = made;
        await vfs.writeFile("/a/old.txt", "0");
        await vfs.writeFile("/a/other.txt", "0");
        const key = await recordKey(vfs, "/a");
        const failing = holdWrite(made, key, 1);
        const firstHistory = holdWrite(made, isHistory, 1);
        const secondHistory = holdWrite(made, isHistory, 2);

        const one = vfs.writeFile("/a/one.txt", "1");
        await failing.holding;
        const first = vfs.writeFile("/a/old.txt", "new old");
        await firstHistory.holding;
        failing.fail();
        await expect(one).rejects.toThrow("network");
        const second = vfs.writeFile("/a/other.txt", "new other");
        await secondHistory.holding;
        firstHistory.release();
        secondHistory.release();
        await Promise.all([first, second]);

        const stored = fresh(made);
        expect(await names(stored, "/a")).toEqual(["old.txt", "other.txt"]);
        expect(await stored.readText("/a/old.txt")).toBe("new old");
        expect(await stored.readText("/a/other.txt")).toBe("new other");
        expect(await names(vfs, "/a")).toEqual(["old.txt", "other.txt"]);
        expect(await vfs.readText("/a/old.txt")).toBe("new old");
        expect(await vfs.readText("/a/other.txt")).toBe("new other");
    });

    it("refuses an overwrite whose file another save replaced while it stored the old version's history", async () => {
        // The overwrite pushes the version it found onto the file's history,
        // then writes its entry. Another save of the file in between replaced
        // that version, so it is no longer the one being overwritten: writing
        // on regardless lost the other save, from the file and its history.
        const made = makeVfs();
        const { vfs } = made;
        await vfs.writeFile("/a/old.txt", "0");
        const history = holdWrite(made, isHistory, 1);

        const over = vfs.writeFile("/a/old.txt", "first");
        await history.holding;
        await vfs.writeFile("/a/old.txt", "second");
        history.release();
        await expect(over).rejects.toThrow(VfsConflictError);

        const stored = fresh(made);
        expect(await names(stored, "/a")).toEqual(["old.txt"]);
        expect(await stored.readText("/a/old.txt")).toBe("second");
        expect(await stored.history("/a/old.txt")).toHaveLength(1);
        expect(await vfs.readText("/a/old.txt")).toBe("second");
    });

    it("keeps every file saved at once into a folder that does not exist yet", async () => {
        // Each save makes the folder with `mkdir -p`, which looks before it
        // makes: all of them look, then all of them make. Every one after
        // the first finds the folder there by then, and must use it - not
        // fail because it is there, nor replace it.
        const made = makeVfs();
        const { vfs } = made;
        await vfs.writeFile("/x.txt", "x");
        const files = Array.from({ length: 10 }, (_, i) => `f${i}`);
        await Promise.all(files.map((name) => vfs.writeFile(`/new/sub/${name}`, name)));

        expect(await names(fresh(made), "/new/sub")).toEqual(files);
        expect(await names(vfs, "/new/sub")).toEqual(files);
    });

    it("lets go of a folder's contents once when two deletes of it run at once", async () => {
        // A recursive delete reads the whole folder before it detaches it.
        // Two at once both read it, and the second, finding it detached
        // already, let go of everything in it again. Content is counted and
        // shared with copies, so that freed bytes a copy still needed.
        const made = makeVfs();
        const { vfs } = made;
        await vfs.writeFile("/a/f.txt", "f");
        await vfs.copy("/a/f.txt", "/kept.txt");

        const deletes = await Promise.allSettled([vfs.delete("/a", { recursive: true }), vfs.delete("/a", { recursive: true })]);

        expect(deletes.map((d) => d.status).sort()).toEqual(["fulfilled", "rejected"]);
        expect(deletes.find((d) => d.status === "rejected")).toMatchObject({ reason: expect.any(VfsNotFoundError) });
        expect(await names(fresh(made), "/")).toEqual(["kept.txt"]);
        expect(await fresh(made).readText("/kept.txt")).toBe("f");
    });

    it("refuses the second of two moves onto one name made at once", async () => {
        // Each move looks at the destination before it waits on the writes
        // that make its way there. Both found it free, and the second wrote
        // over the first: one.txt, moved, was in neither place.
        const made = makeVfs();
        const { vfs } = made;
        await vfs.writeFile("/a/one.txt", "1");
        await vfs.writeFile("/b/two.txt", "2");

        const moves = await Promise.allSettled([vfs.rename("/a/one.txt", "/c/x.txt"), vfs.rename("/b/two.txt", "/c/x.txt")]);

        expect(moves.map((m) => m.status).sort()).toEqual(["fulfilled", "rejected"]);
        expect(moves.find((m) => m.status === "rejected")).toMatchObject({ reason: expect.any(VfsConflictError) });
        // Both files are still there: one moved, the other where it was.
        const stored = fresh(made);
        const files = await stored.walk("/");
        expect(files).toHaveLength(2);
        expect(files).toContain("/c/x.txt");
        expect((await Promise.all(files.map((path) => stored.readText(path)))).sort()).toEqual(["1", "2"]);
    });

    it("refuses the second of two moves of one file to two places made at once", async () => {
        // Each move reads the file before it waits on the writes that make
        // its way there, and the first to go on marks it as being moved. The
        // second took it regardless, marked or not: the file ended up named
        // in both places and marked in neither, one id, history and content
        // between them - and deleting either let go of what the other used.
        const made = makeVfs();
        const { vfs } = made;
        await vfs.writeFile("/a/f.txt", "f");
        await vfs.writeFile("/b/x.txt", "x");
        await vfs.writeFile("/c/y.txt", "y");

        const moves = await Promise.allSettled([vfs.rename("/a/f.txt", "/b/f.txt"), vfs.rename("/a/f.txt", "/c/f.txt")]);

        expect(moves.map((m) => m.status).sort()).toEqual(["fulfilled", "rejected"]);
        expect(moves.find((m) => m.status === "rejected")).toMatchObject({ reason: expect.any(VfsConflictError) });
        const stored = fresh(made);
        const moved = (await stored.walk("/")).filter((path) => path.endsWith("/f.txt"));
        expect(moved).toHaveLength(1);
        expect(moved[0]).not.toBe("/a/f.txt");
        expect(await stored.readText(moved[0])).toBe("f");
        expect(await vfs.readText(moved[0])).toBe("f");
        expect(await names(vfs, "/a")).toEqual([]);
    });

    it("refuses to delete a folder that a move marked while the delete was reading it", async () => {
        // A delete reads everything it will let go of before it detaches the
        // entry, and looks for the other half of a move only if something
        // there is marked as being moved. A move that marked the folder in
        // between came too late for that look: the delete detached the folder
        // and purged its records and content, and the move then put the purged
        // folder in its new place, where nothing in it could be read.
        //
        // A move made in this namespace once the delete has begun is now
        // refused at its start (see "refuses a move of a file inside a folder
        // a recursive delete has begun..."). This one is made in another, on
        // the same store - as another device would - and its writes reach
        // this namespace as changes.
        const made = watched();
        const { vfs, store, echo } = made;
        await vfs.writeFile("/a/d/f.txt", "f");
        await vfs.writeFile("/b/x.txt", "x");
        const folder = await recordKey(vfs, "/a/d");
        const parent = await recordKey(vfs, "/a");
        const b = await recordKey(vfs, "/b");
        const destination = holdWrite(made, b, 1);
        // The delete reads /a/d from the store, and the answer is held.
        echo(folder);
        const get = store.get.bind(store);
        const asked = deferred();
        const answer = deferred();
        store.get = async (k: string) => {
            if (k === folder) {
                asked.resolve();
                await answer.promise;
            }
            return get(k);
        };

        const del = vfs.delete("/a/d", { recursive: true });
        await asked.promise;            // the delete has read /a/d's entry, not marked
        const move = fresh(made).rename("/a/d", "/b/d");
        await destination.holding;      // the move has marked /a/d, and is putting it in /b
        echo(parent);                   // the mark reaches this namespace
        answer.resolve();
        await expect(del).rejects.toThrow(VfsConflictError);
        destination.release();
        await move;
        echo(b);

        const stored = fresh(made);
        expect(await stored.walk("/")).toEqual(["/b/d/f.txt", "/b/x.txt"]);
        expect(await stored.readText("/b/d/f.txt")).toBe("f");
        expect(await vfs.readText("/b/d/f.txt")).toBe("f");
    });

    it("refuses to delete a folder that a move marked after the delete looked for the other half of a move in it", async () => {
        // Something in the folder is half of an interrupted move, so the
        // delete reads the tree for the other half - and for anything else
        // named twice - before it detaches the folder. A move that marked the
        // folder and put it in /b after that read had passed /b was not in
        // what it found, and the folder was purged from under the move.
        //
        // Made in another namespace on the same store, as in the test above.
        const made = watched();
        const { vfs, store, echo } = made;
        await vfs.writeFile("/a/d/g.txt", "g");
        await vfs.writeFile("/a/d/f.txt", "f");
        await vfs.writeFile("/b/x.txt", "x");
        await vfs.mkdir("/c");
        await vfs.writeFile("/z/z.txt", "z");
        const parent = await recordKey(vfs, "/a");
        const folder = await recordKey(vfs, "/a/d");
        const detach = holdWrite(made, folder, 2);
        const interrupted = vfs.rename("/a/d/f.txt", "/c/f.txt");
        await detach.holding;
        detach.fail();
        await expect(interrupted).rejects.toThrow("network");
        // The delete's read of the tree reaches /z after /b, and is held there.
        const last = await recordKey(vfs, "/z");
        echo(last);
        const get = store.get.bind(store);
        const asked = deferred();
        const answer = deferred();
        store.get = async (k: string) => {
            if (k === last) {
                asked.resolve();
                await answer.promise;
            }
            return get(k);
        };
        const destination = holdWrite(made, await recordKey(vfs, "/b"), 1);

        const del = vfs.delete("/a/d", { recursive: true });
        await asked.promise;            // the delete has looked through /b
        const move = fresh(made).rename("/a/d", "/b/d");
        await destination.holding;      // the move has marked /a/d, and is putting it in /b
        echo(parent);                   // the mark reaches this namespace
        answer.resolve();
        await expect(del).rejects.toThrow(VfsConflictError);
        destination.release();
        await move;

        const stored = fresh(made);
        expect(await stored.readText("/b/d/g.txt")).toBe("g");
        expect(await stored.readText("/b/d/f.txt")).toBe("f");
        expect(await stored.readText("/c/f.txt")).toBe("f");
    });

    it("still deletes half of an interrupted move of a folder that does not open", async () => {
        // The mark checks above look for a mark set since the delete read the
        // entry, not for any mark: this folder was marked all along, and an
        // unreadable folder is detached without being read, so nothing else
        // says whether it is half of a move. Refusing it would leave the user
        // a folder that no delete could ever remove.
        const made = makeVfs();
        const { vfs, store } = made;
        await vfs.writeFile("/a/d/f.txt", "f");
        await vfs.writeFile("/b/x.txt", "x");
        const folder = await recordKey(vfs, "/a/d");
        const detach = holdWrite(made, await recordKey(vfs, "/a"), 2);
        const interrupted = vfs.rename("/a/d", "/b/d");
        await detach.holding;
        detach.fail();
        await expect(interrupted).rejects.toThrow("network");
        await store.put(folder, "not a record");
        vfs.clearCache();

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
            await vfs.delete("/a/d", { recursive: true });
        } finally {
            warn.mockRestore();
        }

        expect(await names(fresh(made), "/a")).toEqual([]);
        expect(await names(fresh(made), "/b")).toEqual(["d", "x.txt"]);
    });
});

describe("VFS — clearCache with work in flight", () => {
    it("does not cache a directory whose write was in flight when the cache was cleared", async () => {
        // clearCache is for signing in as someone else. A write sent before
        // it landed after it, and put the record it wrote back in the cache.
        const made = makeVfs();
        const { vfs, store } = made;
        await vfs.writeFile("/a/old.txt", "0");
        const key = await recordKey(vfs, "/a");
        const held = holdWrite(made, key, 1);

        const write = vfs.writeFile("/a/one.txt", "1");
        await held.holding;
        vfs.clearCache();
        held.release();
        await write;

        const gets = store.gets.length;
        expect(await names(vfs, "/a")).toEqual(["old.txt", "one.txt"]);
        expect(store.gets.slice(gets)).toContain(key);   // from the store, not the cache
    });

    it("does not cache a read that was waiting for a write when the cache was cleared", async () => {
        // A read that waited for a write which then failed put its own copy
        // back in the cache, and the cache it put it in was the cleared one.
        const made = watched();
        const { vfs, store, echo } = made;
        await vfs.writeFile("/a/old.txt", "0");
        const key = await recordKey(vfs, "/a");
        const held = holdWrite(made, key, 1);

        const write = vfs.writeFile("/a/one.txt", "1");
        await held.holding;
        echo(key);
        const reading = names(vfs, "/a");
        await fetching(vfs, key);
        vfs.clearCache();
        held.fail();
        await expect(write).rejects.toThrow("network");
        expect(await reading).toEqual(["old.txt"]);

        const gets = store.gets.length;
        expect(await names(vfs, "/a")).toEqual(["old.txt"]);
        expect(store.gets.slice(gets)).toContain(key);   // from the store, not the cache
    });

    it("does not keep the root key of the identity signed in before the cache was cleared", async () => {
        // Each identity has a personal space of its own. A read begun before
        // the switch was still deriving the old identity's root key, and kept
        // it: the next identity's root was then sealed with the old one's key.
        const spaces = { a: makeStore(), b: makeStore() };
        let space = spaces.a;
        let seed = new Uint8Array(32).fill(7);
        const store: VfsStore = {
            get: (k) => space.get(k),
            put: (k, value) => space.put(k, value),
            delete: (k) => space.delete(k),
            list: () => space.list(),
        };
        const content = makeContent();
        const vfs = new VfsNamespace({ store, content, seed: () => seed });
        await vfs.writeFile("/a.txt", "a");
        vfs.clearCache();

        const before = vfs.list("/");   // deriving a's root key
        space = spaces.b;
        seed = new Uint8Array(32).fill(9);
        vfs.clearCache();
        await before;
        await vfs.writeFile("/b.txt", "b");

        const b = new VfsNamespace({ store: spaces.b, content, seed: () => new Uint8Array(32).fill(9) });
        expect(await names(b, "/")).toEqual(["b.txt"]);
        expect(await names(vfs, "/")).toEqual(["b.txt"]);
    });
});

describe("VFS — a move in progress", () => {
    it("refuses to delete a folder while a move of it is under way, rather than purging it from its new place", async () => {
        // The delete began after the move had marked the folder, so it took
        // the folder for half of an interrupted move and looked for the other
        // half - which the move had not yet put in /b. Finding none, it purged
        // the folder, and the move then put the purged folder in /b.
        const made = makeVfs();
        const { vfs } = made;
        await vfs.writeFile("/a/d/f.txt", "f");
        await vfs.writeFile("/b/x.txt", "x");
        const mark = holdWrite(made, await recordKey(vfs, "/a"), 1);   // the move's first step: /a/d marked

        const move = vfs.rename("/a/d", "/b/d");
        await mark.holding;
        const del = outcome(vfs.delete("/a/d", { recursive: true }));
        await quiet();
        mark.release();
        await move;

        expect(await del).toBeInstanceOf(VfsConflictError);
        const stored = fresh(made);
        expect(await stored.walk("/")).toEqual(["/b/d/f.txt", "/b/x.txt"]);
        expect(await stored.readText("/b/d/f.txt")).toBe("f");
        expect(await vfs.readText("/b/d/f.txt")).toBe("f");
    });

    it("refuses to delete a file while a move of it is under way, rather than letting go of its content", async () => {
        const made = makeVfs();
        const { vfs } = made;
        await vfs.writeFile("/a/f.txt", "f");
        await vfs.writeFile("/b/x.txt", "x");
        const mark = holdWrite(made, await recordKey(vfs, "/a"), 1);

        const move = vfs.rename("/a/f.txt", "/b/f.txt");
        await mark.holding;
        const del = outcome(vfs.delete("/a/f.txt"));
        await quiet();
        mark.release();
        await move;

        expect(await del).toBeInstanceOf(VfsConflictError);
        const stored = fresh(made);
        expect(await stored.walk("/")).toEqual(["/b/f.txt", "/b/x.txt"]);
        expect(await stored.readText("/b/f.txt")).toBe("f");
    });

    it("refuses a second move of a file that starts while the first is still writing", async () => {
        // The second move found the file marked - by the first - and took it
        // for half of an interrupted move, which it finished: the file ended
        // up named in both places, with one content reference between them.
        const made = makeVfs();
        const { vfs } = made;
        await vfs.writeFile("/a/f.txt", "f");
        await vfs.mkdir("/b");
        await vfs.mkdir("/c");
        const attach = holdWrite(made, await recordKey(vfs, "/b"), 1);   // the first move putting it in /b

        const first = vfs.rename("/a/f.txt", "/b/f.txt");
        await attach.holding;
        const second = await outcome(vfs.rename("/a/f.txt", "/c/f.txt"));
        attach.release();
        await first;

        expect(second).toBeInstanceOf(VfsConflictError);
        const stored = fresh(made);
        expect(await stored.walk("/")).toEqual(["/b/f.txt"]);
        expect(await stored.readText("/b/f.txt")).toBe("f");
    });

    it("refuses to delete a folder while something in it is being moved, rather than purging what the move carries", async () => {
        const made = makeVfs();
        const { vfs } = made;
        await vfs.writeFile("/a/d/f.txt", "f");
        await vfs.writeFile("/b/x.txt", "x");
        const mark = holdWrite(made, await recordKey(vfs, "/a"), 1);   // /a/d marked, on its way to /b

        const move = vfs.rename("/a/d", "/b/d");
        await mark.holding;
        expect(await outcome(vfs.delete("/a", { recursive: true }))).toBeInstanceOf(VfsConflictError);
        mark.release();
        await move;

        const stored = fresh(made);
        expect(await stored.walk("/")).toEqual(["/b/d/f.txt", "/b/x.txt"]);
        expect(await stored.readText("/b/d/f.txt")).toBe("f");
    });

    it("refuses to delete a folder that something in it was moved out of while the delete read it", async () => {
        // The delete read /a, then /a/d; the whole move of /a/d to /b ran in
        // between. The delete then re-checked only /a itself - unchanged -
        // and purged everything it had read, /a/d's record included: /b/d was
        // left pointing at a record that no longer existed.
        //
        // Made in another namespace on the same store, as above: in this one
        // the move is now refused at its start.
        const made = watched();
        const { vfs, store, echo } = made;
        await vfs.writeFile("/a/d/f.txt", "f");
        await vfs.writeFile("/b/x.txt", "x");
        const a = await recordKey(vfs, "/a");
        const folder = await recordKey(vfs, "/a/d");
        echo(folder);                         // so the delete reads /a/d from the store
        const get = store.get.bind(store);
        const asked = deferred();
        const answer = deferred();
        store.get = async (k: string) => {
            if (k === folder) {
                asked.resolve();
                await answer.promise;
            }
            return get(k);
        };

        const del = outcome(vfs.delete("/a", { recursive: true }));
        await asked.promise;                  // the delete has read /a, with d in it
        await fresh(made).rename("/a/d", "/b/d");   // the whole move, start to finish
        echo(a);                              // and this namespace has heard of it
        answer.resolve();

        expect(await del).toBeInstanceOf(VfsConflictError);
        const stored = fresh(made);
        expect(await stored.walk("/")).toEqual(["/b/d/f.txt", "/b/x.txt"]);
        expect(await stored.readText("/b/d/f.txt")).toBe("f");
    });

    it("refuses to delete a folder when something in it was marked for a move while the delete read the tree", async () => {
        // /a holds half of an interrupted move, so the delete read the whole
        // tree before it detached /a. A move of /a/d marked it meanwhile -
        // after the delete had read /a - and the delete, re-checking only /a
        // itself, purged /a/d from under the move.
        //
        // Made in another namespace on the same store, as above. Its mark is
        // seen once it has landed and been reported, so the write held is the
        // one after it, putting /a/d in /b.
        const made = watched();
        const { vfs, store, echo } = made;
        await vfs.writeFile("/a/d/f.txt", "f");
        await vfs.writeFile("/a/g.txt", "g");
        await vfs.writeFile("/b/x.txt", "x");
        await vfs.mkdir("/c");
        await vfs.writeFile("/z/z.txt", "z");
        const a = await recordKey(vfs, "/a");
        // Half of an interrupted move of /a/g.txt: its detach from /a fails.
        const detach = holdWrite(made, a, 2);
        const interrupted = vfs.rename("/a/g.txt", "/c/g.txt");
        await detach.holding;
        detach.fail();
        await expect(interrupted).rejects.toThrow("network");
        // The delete's read of the tree reaches /z last, and is held there.
        const last = await recordKey(vfs, "/z");
        echo(last);
        const get = store.get.bind(store);
        const asked = deferred();
        const answer = deferred();
        store.get = async (k: string) => {
            if (k === last) {
                asked.resolve();
                await answer.promise;
            }
            return get(k);
        };

        const attach = holdWrite(made, await recordKey(vfs, "/b"), 1);

        const del = outcome(vfs.delete("/a", { recursive: true }));
        await asked.promise;                  // it has read /a, and the tree up to /z
        const move = fresh(made).rename("/a/d", "/b/d");
        await attach.holding;                 // /a/d marked, and on its way to /b
        echo(a);                              // the mark reaches this namespace
        answer.resolve();

        expect(await del).toBeInstanceOf(VfsConflictError);
        attach.release();
        await move;
        const stored = fresh(made);
        expect(await stored.readText("/b/d/f.txt")).toBe("f");
        expect(await stored.readText("/c/g.txt")).toBe("g");
    });

    it("lets go only of what a folder holds when it is deleted, not of a file moved out of it while the delete read it", async () => {
        // The delete read /a, then waited on /a/sub. A move took /a/f.txt to
        // /b meanwhile - made in another namespace on the same store, as
        // above - and the change to /a was reported. The delete let go of what
        // its OWN read of /a named - f.txt's content among it, which /b/f.txt
        // still used.
        const made = watched();
        const { vfs, store, echo } = made;
        await vfs.writeFile("/a/f.txt", "f");
        await vfs.writeFile("/a/sub/s.txt", "s");
        await vfs.mkdir("/b");
        const a = await recordKey(vfs, "/a");
        const sub = await recordKey(vfs, "/a/sub");
        echo(sub);
        const get = store.get.bind(store);
        const asked = deferred();
        const answer = deferred();
        store.get = async (k: string) => {
            if (k === sub) {
                asked.resolve();
                await answer.promise;
            }
            return get(k);
        };

        const del = vfs.delete("/a", { recursive: true });
        await asked.promise;                  // the delete has read /a, f.txt in it
        await fresh(made).rename("/a/f.txt", "/b/f.txt");
        echo(a);                              // a change to /a reported: the next read of /a is a fresh copy
        answer.resolve();
        await del;

        const stored = fresh(made);
        expect(await stored.walk("/")).toEqual(["/b/f.txt"]);
        expect(await stored.readText("/b/f.txt")).toBe("f");
    });

    it("leaves a file it could not move unmarked, when another move took its destination first", async () => {
        // The loser had marked its file as half of a move before it found the
        // destination taken. Left marked, every version that fell off the
        // file's history was kept for good, and every delete of it read the
        // whole tree looking for a second half that does not exist.
        const made = makeVfs();
        const { vfs, store } = made;
        await vfs.writeFile("/a/one.txt", "1");
        await vfs.writeFile("/b/two.txt", "2");
        await vfs.writeFile("/z/z.txt", "z");
        const z = await recordKey(vfs, "/z");
        const sources = ["/a/one.txt", "/b/two.txt"];

        const moves = await Promise.allSettled(sources.map((path) => vfs.rename(path, "/c/x.txt")));

        expect(moves.map((m) => m.status).sort()).toEqual(["fulfilled", "rejected"]);
        const left = sources[moves.findIndex((m) => m.status === "rejected")];
        const reader = fresh(made);
        expect(await reader.readText(left)).toBe(left === "/a/one.txt" ? "1" : "2");
        // A delete of an entry marked as half of a move reads the whole tree
        // for the other half; a delete of one that is not, does not.
        const gets = store.gets.length;
        await reader.delete(left);
        expect(store.gets.slice(gets)).not.toContain(z);
    });

    it("writes nothing to the folder a move leaves when the entry is gone from it by then", async () => {
        const made = watched();
        const { vfs, store, echo } = made;
        await vfs.writeFile("/a/f.txt", "f");
        await vfs.mkdir("/b");
        const a = await recordKey(vfs, "/a");
        const attach = holdWrite(made, await recordKey(vfs, "/b"), 1);

        const move = vfs.rename("/a/f.txt", "/b/f.txt");
        await attach.holding;                 // /a/f.txt marked; on its way to /b
        // Another device takes it out of /a, keeping its content, and the change reaches this tab.
        await fresh(made).delete("/a/f.txt", { keepContent: true });
        echo(a);
        const put = store.put.bind(store);
        let writesOfA = 0;
        store.put = async (k: string, value: unknown) => {
            if (k === a) writesOfA++;
            return put(k, value);
        };
        attach.release();
        await move;

        expect(writesOfA).toBe(0);
        const stored = fresh(made);
        expect(await names(stored, "/a")).toEqual([]);
        expect(await stored.readText("/b/f.txt")).toBe("f");
    });

    it("refuses a second move of a file that was already marked when a delete of it read it, and the delete goes ahead", async () => {
        // /a/f.txt was already marked when the delete read it - the surviving
        // half of an earlier interrupted move, with /c/f.txt the other half.
        // A second move of it does not mark it a second time - it is marked
        // already - so markedMeanwhile and currentSubtree, which only notice
        // a mark APPEAR, see nothing. Without a check of inMotion right before
        // the detach, the delete went ahead while the second move was putting
        // the file in /d, took /a/f.txt for the sole survivor of the
        // interrupted move and settled /c/f.txt as unmarked - and deleting
        // either of /c or /d then freed the other's content. That check
        // refused the delete. Now the delete holds /a/f.txt from its start
        // (see `deleting`), and it is the second move that is refused, before
        // it writes anything.
        const made = watched();
        const { vfs, store, echo } = made;
        await vfs.writeFile("/a/f.txt", "f");
        await vfs.mkdir("/c");
        await vfs.mkdir("/d");
        await vfs.mkdir("/z");
        const a = await recordKey(vfs, "/a");
        // Half of an interrupted move of /a/f.txt to /c: the detach from /a fails.
        const detach = holdWrite(made, a, 2);
        const interrupted = vfs.rename("/a/f.txt", "/c/f.txt");
        await detach.holding;
        detach.fail();
        await expect(interrupted).rejects.toThrow("network");

        // The delete's read of the whole tree, for the other copy, is held
        // while it reads /z - unrelated, just somewhere to pause it.
        const z = await recordKey(vfs, "/z");
        echo(z);
        const get = store.get.bind(store);
        const asked = deferred();
        const answer = deferred();
        store.get = async (k: string) => {
            if (k === z) {
                asked.resolve();
                await answer.promise;
            }
            return get(k);
        };

        const del = outcome(vfs.delete("/a/f.txt"));
        await asked.promise;                  // it has read /a, already marked, and is reading the tree for /c/f.txt
        // A second move of the same, already-marked file starts.
        const second = await outcome(vfs.rename("/a/f.txt", "/d/f.txt"));
        answer.resolve();

        expect(second).toBeInstanceOf(VfsConflictError);
        expect(await del).toBe("done");

        const stored = fresh(made);
        expect(await names(stored, "/a")).toEqual([]);
        expect(await names(stored, "/d")).toEqual([]);
        // The other half keeps the content.
        expect(await stored.readText("/c/f.txt")).toBe("f");
    });

    it("refuses a second move of a file that was already marked when a delete of its folder read it, and the delete goes ahead", async () => {
        // Same race as above, one level down: /a/x.txt, inside the folder
        // being recursively deleted, was already marked when the delete read
        // /a's subtree - the surviving half of an earlier interrupted move.
        // The post-subtree inMotion check ran before the second move started,
        // and currentSubtree only notices a mark APPEAR, so neither sees it.
        // The `ids` loop inside the detach edit, re-checked right before it,
        // refused the delete. Now the delete holds /a, and everything it read
        // below it, from its start, and the second move is refused instead.
        const made = watched();
        const { vfs, store, echo } = made;
        await vfs.writeFile("/a/x.txt", "f");
        await vfs.mkdir("/c");
        await vfs.mkdir("/d");
        await vfs.mkdir("/z");
        const a = await recordKey(vfs, "/a");
        const detach = holdWrite(made, a, 2);
        const interrupted = vfs.rename("/a/x.txt", "/c/x.txt");
        await detach.holding;
        detach.fail();
        await expect(interrupted).rejects.toThrow("network");

        const z = await recordKey(vfs, "/z");
        echo(z);
        const get = store.get.bind(store);
        const asked = deferred();
        const answer = deferred();
        store.get = async (k: string) => {
            if (k === z) {
                asked.resolve();
                await answer.promise;
            }
            return get(k);
        };

        const del = outcome(vfs.delete("/a", { recursive: true }));
        await asked.promise;                  // /a's subtree is read, x.txt already marked; now reading the tree for /c/x.txt
        const second = await outcome(vfs.rename("/a/x.txt", "/d/x.txt"));
        answer.resolve();

        expect(second).toBeInstanceOf(VfsConflictError);
        expect(await del).toBe("done");

        const stored = fresh(made);
        expect(await names(stored, "/")).toEqual(["c", "d", "z"]);
        expect(await names(stored, "/d")).toEqual([]);
        // The other half keeps the content.
        expect(await stored.readText("/c/x.txt")).toBe("f");
    });

    for (const variant of ["a mark with no other half", "half of an interrupted move"] as const) {
        it(`refuses a move of a file a delete of it has begun, while the delete looks for the other half of a move (${variant})`, async () => {
            // /a/f.txt was marked when the delete read it, so the delete read
            // the tree for its other half. A move of it started meanwhile, put
            // it in /b, and failed to take it from /a. Ended, it was no longer
            // being moved, and the delete - finding the entry as it had read
            // it, marked, and nothing in `inMotion` - let go of what /b/f.txt
            // then named: at once, or once the other half, /c/f.txt, was
            // deleted in the ordinary way. Refused at its start, the move
            // cannot do that.
            const made = watched();
            const { vfs, store, echo } = made;
            await vfs.writeFile("/a/f.txt", "f");
            await vfs.mkdir("/b");
            await vfs.mkdir("/c");
            await vfs.writeFile("/z/z.txt", "z");
            const a = await recordKey(vfs, "/a");
            // An earlier move of it to /c, interrupted: it could not put it in
            // /c, or it could not take it from /a.
            const interrupt = variant === "a mark with no other half"
                ? holdWrite(made, await recordKey(vfs, "/c"), 1)
                : holdWrite(made, a, 2);
            const interrupted = vfs.rename("/a/f.txt", "/c/f.txt");
            await interrupt.holding;
            interrupt.fail();
            await expect(interrupted).rejects.toThrow("network");
            // The delete's read of the tree is held while it reads /z.
            const z = await recordKey(vfs, "/z");
            echo(z);
            const get = store.get.bind(store);
            const asked = deferred();
            const answer = deferred();
            store.get = async (k: string) => {
                if (k === z) {
                    asked.resolve();
                    await answer.promise;
                }
                return get(k);
            };

            const del = outcome(vfs.delete("/a/f.txt"));
            await asked.promise;                  // it has read /a/f.txt, marked, and is reading the tree for the other half
            const writes = writesFailing(store, a);   // the move's write of /a, taking it from there, would fail
            const move = await outcome(vfs.rename("/a/f.txt", "/b/f.txt"));
            writes.stop();
            answer.resolve();

            expect(move).toBeInstanceOf(VfsConflictError);
            expect(writes.keys).toEqual([]);      // refused at its start, it wrote nothing
            expect(await del).toBe("done");
            store.get = get;
            const files = await everyFile(made);
            expect(files).not.toHaveProperty("/b/f.txt");
            expect(files).toEqual(variant === "a mark with no other half" ? { "/z/z.txt": "z" } : { "/c/f.txt": "f", "/z/z.txt": "z" });
        });
    }

    for (const paused of ["reading what it holds", "looking for the other half of a move"] as const) {
        it(`refuses a move of a file inside a folder a recursive delete has begun, while the delete is ${paused}`, async () => {
            // The same as a move of the folder itself: the delete of /a lets
            // go of everything below /a, so a move out of it that the delete
            // does not see - started after its checks, or ended before its
            // detach - can leave the file named in /b with its content gone.
            const made = watched();
            const { vfs, store, echo } = made;
            await vfs.writeFile("/a/sub/f.txt", "f");
            await vfs.mkdir("/a/other");
            await vfs.mkdir("/b");
            await vfs.mkdir("/c");
            await vfs.mkdir("/z");
            const sub = await recordKey(vfs, "/a/sub");
            let held: string;
            if (paused === "reading what it holds") {
                held = await recordKey(vfs, "/a/other");
            } else {
                // f.txt marked, with no other half: an earlier move of it could
                // not put it in /c. So the delete reads the tree for it.
                const attach = holdWrite(made, await recordKey(vfs, "/c"), 1);
                const interrupted = vfs.rename("/a/sub/f.txt", "/c/f.txt");
                await attach.holding;
                attach.fail();
                await expect(interrupted).rejects.toThrow("network");
                held = await recordKey(vfs, "/z");
            }
            echo(held);
            const get = store.get.bind(store);
            const asked = deferred();
            const answer = deferred();
            store.get = async (k: string) => {
                if (k === held) {
                    asked.resolve();
                    await answer.promise;
                }
                return get(k);
            };

            const del = outcome(vfs.delete("/a", { recursive: true }));
            await asked.promise;
            const writes = writesFailing(store, sub);   // the move's write of /a/sub would fail
            const move = await outcome(vfs.rename("/a/sub/f.txt", "/b/f.txt"));
            writes.stop();
            answer.resolve();

            expect(move).toBeInstanceOf(VfsConflictError);
            expect(writes.keys).toEqual([]);
            expect(await del).toBe("done");
            store.get = get;
            // f.txt went with /a. It is named nowhere else, so nothing lost its content.
            expect(await everyFile(made)).toEqual({});
            expect(await names(fresh(made), "/")).toEqual(["b", "c", "z"]);
        });
    }

    it("refuses a move of the other half of an interrupted move, by its other name, while a delete of the folder holding this half looks for it", async () => {
        // /a/x.txt and /c/x.txt are one file, left in both by an interrupted
        // move, and /c is not on the way to /a. A move of /c/x.txt to /b that
        // failed to take it from /c went unseen by the delete of /a, which had
        // read /b and /c before: it kept the content for /c/x.txt and took the
        // mark off it, and an ordinary delete of /c/x.txt then let go of what
        // /b/x.txt named. The delete holds what it read below /a by id, so the
        // move is refused, whatever name it is asked for by.
        const made = watched();
        const { vfs, store, echo } = made;
        await vfs.writeFile("/a/x.txt", "f");
        await vfs.mkdir("/b");
        await vfs.mkdir("/c");
        await vfs.mkdir("/z");
        const a = await recordKey(vfs, "/a");
        const c = await recordKey(vfs, "/c");
        const detach = holdWrite(made, a, 2);
        const interrupted = vfs.rename("/a/x.txt", "/c/x.txt");
        await detach.holding;
        detach.fail();
        await expect(interrupted).rejects.toThrow("network");
        const z = await recordKey(vfs, "/z");
        echo(z);
        const get = store.get.bind(store);
        const asked = deferred();
        const answer = deferred();
        store.get = async (k: string) => {
            if (k === z) {
                asked.resolve();
                await answer.promise;
            }
            return get(k);
        };

        const del = outcome(vfs.delete("/a", { recursive: true }));
        await asked.promise;                  // /a read, x.txt marked in it; now reading the tree for the other half
        const writes = writesFailing(store, c);   // the move's write of /c, taking it from there, would fail
        const move = await outcome(vfs.rename("/c/x.txt", "/b/x.txt"));
        writes.stop();
        answer.resolve();

        expect(move).toBeInstanceOf(VfsConflictError);
        expect(writes.keys).toEqual([]);
        expect(await del).toBe("done");
        store.get = get;
        expect(await everyFile(made)).toEqual({ "/c/x.txt": "f" });
        // Deleted in the ordinary way, the last copy lets go of the content, and nothing else named it.
        await fresh(made).delete("/c/x.txt");
        expect(await everyFile(made)).toEqual({});
    });

    it("lets a move go ahead once a delete that held it has finished or failed", async () => {
        // A delete lets go of what it holds however it ends. Kept, none of it
        // could be moved in this namespace again.
        const made = makeVfs();
        const { vfs } = made;
        await vfs.writeFile("/a/f.txt", "f");
        await vfs.writeFile("/a/g.txt", "g");
        await vfs.mkdir("/c");
        // /a/f.txt and /c/f.txt: one file, left in both by an interrupted move.
        const detach = holdWrite(made, await recordKey(vfs, "/a"), 2);
        const interrupted = vfs.rename("/a/f.txt", "/c/f.txt");
        await detach.holding;
        detach.fail();
        await expect(interrupted).rejects.toThrow("network");

        await expect(vfs.delete("/a")).rejects.toThrow("is not empty");   // failed
        await vfs.rename("/a/g.txt", "/b/g.txt");
        await vfs.delete("/a/f.txt");                                       // finished: /c/f.txt is left
        await vfs.rename("/c/f.txt", "/b/f.txt");

        expect(await everyFile(made)).toEqual({ "/b/f.txt": "f", "/b/g.txt": "g" });
    });
});

describe("VFS — edits that wait for a write of their record", () => {
    it("sends twenty files saved into one folder at once in two writes of it", async () => {
        // While a write of a folder is in flight, every edit made to it waits
        // for the next one - and each used to queue a write of its own: twenty
        // files, twenty full-record writes, each billed.
        const made = makeVfs();
        const { vfs, store } = made;
        await vfs.mkdir("/d");
        const key = await recordKey(vfs, "/d");
        const files = Array.from({ length: 20 }, (_, i) => `f${String(i).padStart(2, "0")}.txt`);
        const put = store.put.bind(store);
        let writes = 0;
        store.put = async (k: string, value: unknown) => {
            if (k === key) writes++;
            return put(k, value);
        };
        const first = holdWrite(made, key, 1);

        const saving = files.map((name) => vfs.writeFile(`/d/${name}`, name));
        await first.holding;
        await listed(vfs, "/d", files);          // every edit made; the first write still held
        first.release();
        const stats = await Promise.all(saving);

        expect(stats.map((stat) => stat.name)).toEqual(files);
        expect(writes).toBe(2);
        const stored = fresh(made);
        expect(await names(stored, "/d")).toEqual(files);
        for (const name of files) expect(await stored.readText(`/d/${name}`)).toBe(name);
    });

    it("fails every save that rode on a combined write that failed, with the one error, and a retry of them works", async () => {
        const made = makeVfs();
        const { vfs } = made;
        await vfs.mkdir("/d");
        const key = await recordKey(vfs, "/d");
        const first = holdWrite(made, key, 1);
        const combined = holdWrite(made, key, 2);

        const one = vfs.writeFile("/d/one.txt", "1");
        await first.holding;
        const rest = ["a.txt", "b.txt", "c.txt"].map((name) => outcome(vfs.writeFile(`/d/${name}`, name)));
        await listed(vfs, "/d", ["a.txt", "b.txt", "c.txt", "one.txt"]);
        first.release();
        await one;
        await combined.holding;
        combined.fail();
        const errors = await Promise.all(rest);

        expect(errors[0]).toBeInstanceOf(Error);
        expect((errors[0] as Error).message).toBe("network");
        expect(errors.every((err) => err === errors[0])).toBe(true);   // one write, one error
        expect(await names(fresh(made), "/d")).toEqual(["one.txt"]);
        expect(await names(vfs, "/d")).toEqual(["one.txt"]);
        await Promise.all(["a.txt", "b.txt", "c.txt"].map((name) => vfs.writeFile(`/d/${name}`, name)));
        expect(await names(fresh(made), "/d")).toEqual(["a.txt", "b.txt", "c.txt", "one.txt"]);
    });

    it("puts an edit made after a write was sent into the next write, not that one", async () => {
        const made = makeVfs();
        const { vfs } = made;
        await vfs.mkdir("/d");
        const key = await recordKey(vfs, "/d");
        const first = holdWrite(made, key, 1);
        const second = holdWrite(made, key, 2);

        const one = vfs.writeFile("/d/one.txt", "1");
        await first.holding;
        const two = vfs.writeFile("/d/two.txt", "2");
        await listed(vfs, "/d", ["one.txt", "two.txt"]);
        first.release();
        await second.holding;                    // the write carrying two.txt is on its way
        const three = vfs.writeFile("/d/three.txt", "3");
        await listed(vfs, "/d", ["one.txt", "three.txt", "two.txt"]);
        second.release();
        await Promise.all([one, two, three]);

        expect(await names(fresh(made), "/d")).toEqual(["one.txt", "three.txt", "two.txt"]);
    });
});
