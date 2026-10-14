/**
 * The VFS reading a record it did not write.
 *
 * These craft the record directly rather than going through the SDK, because
 * that is the capability the threat model actually grants: hosted auth hands
 * every app the master seed, so any app can derive the root key, seal whatever
 * it likes, and PUT it at a predictable personal-space key. The write-side
 * checks are not in that path at all — the read side is the only one that runs.
 */
import { describe, it, expect, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeVfs } from "./harness";
import { seal, unseal, deriveRootKey, newDirKey, newId } from "../../src/vfs/recordCipher";
import {
    dirKey, historyKey, ROOT_ID, VfsConflictError, VfsCorruptRecordError, VfsLimitError, VfsNotFoundError, type DirNode,
} from "../../src/vfs/types";
import { isSafeName } from "../../src/vfs/paths";
import { DEFAULT_MAX_ENTRIES, WALK_CONCURRENCY } from "../../src/vfs/bounds";
import { encryptAesGcm } from "../../src/crypto/primitives/aes-gcm";

const SEED = new Uint8Array(32).fill(7);

type Store = ReturnType<typeof makeVfs>["store"];

/** Put a directory record straight into the store, as a hostile app would. */
async function plant(store: Store, id: string, key: Uint8Array, node: DirNode) {
    await store.put(dirKey(id), await seal(key, node));
}

/** Seal ANY value as a directory record - including ones that are not a DirNode at all. */
async function plantValue(store: Store, id: string, key: Uint8Array, value: unknown) {
    await store.put(dirKey(id), await seal(key, value));
}

/** A directory record exactly as stored, decrypted - what a write really persisted. */
async function readRecord(store: Store, id: string, key: Uint8Array): Promise<any> {
    return unseal(key, await store.get(dirKey(id)));
}

/** The id and key of a directory the SDK made, found the way the SDK finds it. */
async function locate(store: Store, path: string): Promise<{ id: string; key: Uint8Array }> {
    let id = ROOT_ID;
    let key = await deriveRootKey(SEED);
    for (const name of path.split("/").filter(Boolean)) {
        const entry = (await readRecord(store, id, key)).entries[name];
        id = entry.id;
        key = Uint8Array.from(Buffer.from(entry.key, "base64"));
    }
    return { id, key };
}

const fileEntry = (name: string) => ({
    kind: "file", id: newId(), manifest: { id: `m-${name}`, name, size: 1, type: "text/plain" }, size: 1, mtime: 1,
});

/** A directory as a hostile record describes one: an id and a key, handed out freely. */
function hostileDir() {
    const key = newDirKey();
    return { id: newId(), key, entry: { kind: "dir", id: "", key: Buffer.from(key).toString("base64"), mtime: 1 } };
}
const dirEntry = (d: ReturnType<typeof hostileDir>) => ({ ...d.entry, id: d.id });

/**
 * WebCrypto, counted and made late: each call settles up to three turns of
 * the event loop after it would have - varied, and the same every run - as
 * on a machine whose thread pool is busy. `busy()` is how many calls have
 * yet to settle.
 */
function slowCrypto() {
    const subtle = globalThis.crypto.subtle as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    let busy = 0;
    let calls = 0;
    const spies = ["decrypt", "encrypt", "importKey", "deriveBits", "digest"].map((method) => {
        const real = subtle[method].bind(subtle);
        return vi.spyOn(subtle, method).mockImplementation(async (...args: unknown[]) => {
            busy++;
            try {
                const out = await real(...args);
                for (let turns = calls++ % 4; turns > 0; turns--) await new Promise((resolve) => setImmediate(resolve));
                return out;
            } finally {
                busy--;
            }
        });
    });
    return { busy: () => busy, restore: () => spies.forEach((spy) => spy.mockRestore()) };
}

/** Plant `root` naming each of `children`, in a fresh VFS. */
async function plantRoot(store: Store, children: Record<string, unknown>) {
    await plantValue(store, ROOT_ID, await deriveRootKey(SEED), { v: 1, mtime: 1, entries: children });
}

/**
 * Hang a chain of directories named `names` off the existing directory at
 * `under`, the last holding one file. Planted, because the SDK will not write
 * a tree deeper than a walk reads.
 */
async function plantChain(store: Store, under: string, names: string[], file = "deep.txt") {
    const links = names.map(() => hostileDir());
    const parent = await locate(store, under);
    // An empty directory has no record of its own until something is written to it.
    const record = (await readRecord(store, parent.id, parent.key)) ?? { v: 1, mtime: 1, entries: {} };
    record.entries[names[0]] = dirEntry(links[0]);
    await plantValue(store, parent.id, parent.key, record);
    for (let i = 0; i < links.length; i++) {
        const entries = i + 1 < links.length ? { [names[i + 1]]: dirEntry(links[i + 1]) } : { [file]: fileEntry(file) };
        await plantValue(store, links[i].id, links[i].key, { v: 1, mtime: 1, entries });
    }
}

describe("a record with unusable entry names", () => {
    it("drops them from list() instead of turning them into path structure", async () => {
        const { vfs, store } = makeVfs({ seed: SEED });
        const rootKey = await deriveRootKey(SEED);
        const childKey = newDirKey();
        const childId = newId();

        await plant(store, ROOT_ID, rootKey, {
            v: 1, mtime: Date.now(),
            entries: { good: { kind: "dir", id: childId, key: Buffer.from(childKey).toString("base64"), mtime: Date.now() } },
        } as unknown as DirNode);

        const bs = String.fromCharCode(92);
        await plant(store, childId, childKey, {
            v: 1, mtime: Date.now(),
            entries: {
                "fine.txt": { kind: "file", id: newId(), manifest: { id: "m1", name: "fine.txt", size: 1, type: "text/plain" }, size: 1, mtime: Date.now() },
                "..": { kind: "file", id: newId(), manifest: { id: "m2", name: "..", size: 1, type: "text/plain" }, size: 1, mtime: Date.now() },
                "a/b": { kind: "file", id: newId(), manifest: { id: "m3", name: "a/b", size: 1, type: "text/plain" }, size: 1, mtime: Date.now() },
                [`x${bs}y`]: { kind: "file", id: newId(), manifest: { id: "m4", name: "xy", size: 1, type: "text/plain" }, size: 1, mtime: Date.now() },
            },
        } as unknown as DirNode);

        vi.spyOn(console, "warn").mockImplementation(() => {});
        vfs.clearCache();
        const names = (await vfs.list("/good")).map((e) => e.name);
        expect(names).toEqual(["fine.txt"]);
    });

    it("never emits a path outside the subtree it walked", async () => {
        const { vfs, store } = makeVfs({ seed: SEED });
        const rootKey = await deriveRootKey(SEED);
        const childKey = newDirKey();
        const childId = newId();

        await plant(store, ROOT_ID, rootKey, {
            v: 1, mtime: Date.now(),
            entries: { sub: { kind: "dir", id: childId, key: Buffer.from(childKey).toString("base64"), mtime: Date.now() } },
        } as unknown as DirNode);
        await plant(store, childId, childKey, {
            v: 1, mtime: Date.now(),
            entries: {
                "../../escaped": { kind: "file", id: newId(), manifest: { id: "m5", name: "escaped", size: 1, type: "text/plain" }, size: 1, mtime: Date.now() },
            },
        } as unknown as DirNode);

        vi.spyOn(console, "warn").mockImplementation(() => {});
        vfs.clearCache();
        for (const path of await vfs.walk("/sub")) expect(path.startsWith("/sub/")).toBe(true);
    });

    const bs = String.fromCharCode(92);

    /** /good holding one usable file and `n` readable entries whose NAMES are unusable. */
    async function withUnusable(n: number, extra: Record<string, unknown> = {}) {
        const made = makeVfs({ seed: SEED });
        await made.vfs.writeFile("/good/fine.txt", "fine");
        const good = await locate(made.store, "/good");
        const record = await readRecord(made.store, good.id, good.key);
        const bad = Object.fromEntries(Array.from({ length: n }, (_, i) => [`x${bs}${i}`, fileEntry(`bad${i}`)]));
        await plantValue(made.store, good.id, good.key, { ...record, entries: { ...record.entries, ...bad, ...extra } });
        made.vfs.clearCache();
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        return { ...made, good, bad, warn };
    }

    it("sets them aside once per record, not once per visit", async () => {
        // They used to be filtered - a regex, an encode and a warning each -
        // every time a walk visited the directory, and never charged to the
        // budget. A record reached 900,000 times through a fan-out cost 900,000
        // times its size in unbilled work: minutes of CPU, and a warning per
        // entry per visit.
        const { vfs, store, good, warn } = await withUnusable(20);
        const [d0, d1] = [hostileDir(), hostileDir()];
        const goodEntry = { kind: "dir", id: good.id, key: Buffer.from(good.key).toString("base64"), mtime: 1 };
        await plantRoot(store, { top: dirEntry(d0) });
        await plantValue(store, d0.id, d0.key, {
            v: 1, mtime: 1, entries: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`a${i}`, dirEntry(d1)])),
        });
        await plantValue(store, d1.id, d1.key, {
            v: 1, mtime: 1, entries: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`b${i}`, goodEntry])),
        });
        vfs.clearCache();
        warn.mockClear();

        expect(await vfs.walk("/")).toHaveLength(900);
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it("cannot be reached by looking the name up exactly, either", async () => {
        // list() hid them while stat() and readFile() still found them by
        // name, so the two disagreed about what was in the directory.
        const { vfs } = await withUnusable(1);
        expect(await vfs.exists(`/good/x${bs}0`)).toBe(false);
        await expect(vfs.stat(`/good/x${bs}0`)).rejects.toBeInstanceOf(VfsNotFoundError);
        await expect(vfs.readFile(`/good/x${bs}0`)).rejects.toBeInstanceOf(VfsNotFoundError);
    });

    it("survive a write to a sibling", async () => {
        const { vfs, store, good, bad } = await withUnusable(3);
        await vfs.writeFile("/good/new.txt", "n");
        const entries = (await readRecord(store, good.id, good.key)).entries;
        for (const [name, value] of Object.entries(bad)) expect(entries[name], name).toEqual(value);
    });

    it("still count as references for sweep(), and go with a recursive delete", async () => {
        // Hidden from every read, but the entry itself is one this version
        // understands: sweep must not call what it points at an orphan, and
        // deleting the directory must let go of its content like any other.
        const kept = hostileDir();
        const { vfs, store, content } = await withUnusable(1, { [`d${bs}ir`]: dirEntry(kept) });
        await plantValue(store, kept.id, kept.key, { v: 1, mtime: 1, entries: {} });
        content.blobs.set("m-bad0", { bytes: new Uint8Array([1]), refs: 1 });

        expect((await vfs.sweep()).removed).toEqual([]);
        expect(store.records.has(dirKey(kept.id))).toBe(true);

        await vfs.delete("/good", { recursive: true });
        expect(content.blobs.has("m-bad0")).toBe(false);
        expect(store.records.has(dirKey(kept.id))).toBe(false);
    });
});

describe("a record that points at itself", () => {
    it("terminates instead of walking forever", async () => {
        // No id cycle is even needed once names are validated, but the record
        // format permits one and nothing else would stop it.
        const { vfs, store } = makeVfs({ seed: SEED });
        const rootKey = await deriveRootKey(SEED);
        const loopKey = newDirKey();
        const loopId = newId();
        const b64 = Buffer.from(loopKey).toString("base64");

        await plant(store, ROOT_ID, rootKey, {
            v: 1, mtime: Date.now(),
            entries: { loop: { kind: "dir", id: loopId, key: b64, mtime: Date.now() } },
        } as unknown as DirNode);
        // Its own child is itself.
        await plant(store, loopId, loopKey, {
            v: 1, mtime: Date.now(),
            entries: { loop: { kind: "dir", id: loopId, key: b64, mtime: Date.now() } },
        } as unknown as DirNode);

        vi.spyOn(console, "warn").mockImplementation(() => {});
        vfs.clearCache();
        const paths = await vfs.walk("/loop");
        expect(Array.isArray(paths)).toBe(true);
        expect(paths.length).toBeLessThan(200);
    }, 20_000);
});

describe("walk() over a hostile tree", () => {
    // The cycle guard used to be a set of PATHS. A record with two entries
    // that both point back at itself makes a fresh path at every level -
    // /loop/a, /loop/b, /loop/a/a, ... - so the guard never fired and 2^64
    // visits ran the process out of memory. Directory records are cached by
    // id, so there was no network to slow it down either. Two ~120-byte
    // records were enough to kill `vfs mount`, `vcs status` and the IDE.

    it("terminates at once on a directory that fans out into itself", async () => {
        const { vfs, store } = makeVfs({ seed: SEED });
        const loop = hostileDir();
        await plantRoot(store, { loop: dirEntry(loop) });
        await plantValue(store, loop.id, loop.key, {
            v: 1, mtime: 1,
            entries: { a: dirEntry(loop), b: dirEntry(loop), "f.txt": fileEntry("f.txt") },
        });
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        vfs.clearCache();

        expect(await vfs.walk("/loop")).toEqual(["/loop/f.txt"]);
        expect(await vfs.walk("/")).toEqual(["/loop/f.txt"]);
        expect(warn.mock.calls.some(([m]) => /cycle/.test(String(m)))).toBe(true);
    }, 10_000);

    it("throws on a cycle-free tree that fans out past the entry budget", async () => {
        // No cycle anywhere: D0 -> {a, b} -> D1 -> {a, b} -> ... Each level
        // doubles the paths, so an ancestor check alone cannot stop it. Only a
        // budget can - and it must THROW, because a partial list reads as
        // "everything past the cut was deleted" to a sync.
        const { vfs, store } = makeVfs({ seed: SEED, limits: { entries: 1000 } });
        const levels = Array.from({ length: 17 }, hostileDir);
        await plantRoot(store, { dag: dirEntry(levels[0]) });
        for (let i = 0; i < levels.length - 1; i++) {
            await plantValue(store, levels[i].id, levels[i].key, {
                v: 1, mtime: 1, entries: { a: dirEntry(levels[i + 1]), b: dirEntry(levels[i + 1]) },
            });
        }
        await plantValue(store, levels.at(-1)!.id, levels.at(-1)!.key, {
            v: 1, mtime: 1, entries: { "f.txt": fileEntry("f.txt") },
        });
        vfs.clearCache();

        const err = await vfs.walk("/dag").catch((e) => e);
        expect(err).toBeInstanceOf(VfsLimitError);
        expect(err.limit).toBe("entries");
        expect(err.at).toMatch(/^\/dag\/[ab]\//);
        await expect(vfs.glob("**/f.txt")).rejects.toBeInstanceOf(VfsLimitError);
    }, 20_000);

    it("counts the budget across the whole walk, not per directory", async () => {
        const { vfs } = makeVfs({ seed: SEED, limits: { entries: 150 } });
        for (let d = 0; d < 4; d++) for (let f = 0; f < 40; f++) await vfs.writeFile(`/d${d}/f${f}.txt`, "x");
        await expect(vfs.walk("/")).rejects.toBeInstanceOf(VfsLimitError);

        const roomy = makeVfs({ seed: SEED, limits: { entries: 164 } });   // 4 dirs + 160 files
        for (let d = 0; d < 4; d++) for (let f = 0; f < 40; f++) await roomy.vfs.writeFile(`/d${d}/f${f}.txt`, "x");
        expect(await roomy.vfs.walk("/")).toHaveLength(160);
    });

    it("throws past the depth ceiling instead of returning what it had", async () => {
        const { vfs, store } = makeVfs({ seed: SEED });
        const shallow = "/" + Array.from({ length: 60 }, (_, i) => `s${i}`).join("/") + "/ok.txt";
        await vfs.writeFile(shallow, "fine");
        expect(await vfs.walk("/")).toEqual([shallow]);

        await plantChain(store, "/", Array.from({ length: 66 }, (_, i) => `l${i}`));
        vfs.clearCache();
        const err = await vfs.walk("/").catch((e) => e);
        expect(err).toBeInstanceOf(VfsLimitError);
        expect(err.limit).toBe("depth");
        // Where, not just that: a walk of the tree to find it would hit the
        // same ceiling, so the error is the only pointer the user gets.
        expect(err.path).toBe("/");
        expect(err.at).toBe("/" + Array.from({ length: 65 }, (_, i) => `l${i}`).join("/"));
        expect(err.message).toContain("/l0/l1/l2");
    });

    it("warns about a cycle once, however many times the walk reaches it", async () => {
        // The warning went out on every visit, so a self-referencing
        // directory reached through a fan-out printed a line per path - up to
        // the whole entry budget of them, into the user's terminal.
        const { vfs, store } = makeVfs({ seed: SEED });
        const [d0, d1, loop] = [hostileDir(), hostileDir(), hostileDir()];
        await plantRoot(store, { top: dirEntry(d0) });
        const fan = (prefix: string, to: ReturnType<typeof hostileDir>) =>
            Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`${prefix}${i}`, dirEntry(to)]));
        await plantValue(store, d0.id, d0.key, { v: 1, mtime: 1, entries: fan("a", d1) });
        await plantValue(store, d1.id, d1.key, { v: 1, mtime: 1, entries: fan("b", loop) });
        await plantValue(store, loop.id, loop.key, {
            v: 1, mtime: 1, entries: { again: dirEntry(loop), "f.txt": fileEntry("f.txt") },
        });
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        vfs.clearCache();
        warn.mockClear();

        expect(await vfs.walk("/")).toHaveLength(900);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toMatch(/cycle/);
    });

    it("lets timers run all through a long walk of a many-level fan-out", async () => {
        // Once every record is cached, a walk is nothing but promise
        // continuations, and all of those run before any timer or signal
        // handler gets a turn: `vfs mount` could not be stopped with Ctrl-C,
        // and a browser tab froze, until a walk of a big tree had finished.
        // A yield used to park only the one branch that crossed the boundary
        // while every other branch in flight kept the microtask queue full, so
        // on a tree that fans out at every level a timer got 0-1 turns in
        // seconds. Two levels of fan-out never showed it.
        const { vfs, store } = makeVfs({ seed: SEED });
        const levels = Array.from({ length: 7 }, hostileDir);
        await plantRoot(store, { dag: dirEntry(levels[0]) });
        for (let i = 0; i < levels.length - 1; i++) {
            await plantValue(store, levels[i].id, levels[i].key, {
                v: 1, mtime: 1, entries: Object.fromEntries(Array.from({ length: 7 }, (_, n) => [`${n}`, dirEntry(levels[i + 1])])),
            });
        }
        vfs.clearCache();
        const total = 7 + 7 ** 2 + 7 ** 3 + 7 ** 4 + 7 ** 5 + 7 ** 6;
        expect(await vfs.walkEntries("/dag")).toHaveLength(total);   // every record cached: nothing left to wait on

        let ticks = 0;
        const timer = setInterval(() => ticks++, 1);
        try {
            expect(await vfs.walkEntries("/dag")).toHaveLength(total);
        } finally {
            clearInterval(timer);
        }
        // One turn per few thousand entries; well over a dozen in this walk.
        expect(ticks).toBeGreaterThanOrEqual(5);
    }, 30_000);

    it("returns exactly what listing each directory in turn would, in the same order", async () => {
        // The traversal changed shape - one directory at a time, reading
        // ahead - and nothing a caller sees may change with it.
        const { vfs, store } = makeVfs({ seed: SEED });
        for (const path of ["/b/z.txt", "/b/a/y.txt", "/a.txt", "/c/d/e/f.txt", "/c/d/g.txt", "/c/Ä.md", "/c/ä/x", "/B/q"]) {
            await vfs.writeFile(path, "x");
        }
        await vfs.mkdir("/empty");
        const shared = await locate(store, "/b/a");
        const c = await locate(store, "/c");
        const record = await readRecord(store, c.id, c.key);
        record.entries.again = { kind: "dir", id: shared.id, key: Buffer.from(shared.key).toString("base64"), mtime: 1 };
        record.entries.loop = { kind: "dir", id: c.id, key: Buffer.from(c.key).toString("base64"), mtime: 1 };
        await plantValue(store, c.id, c.key, record);
        vfs.clearCache();
        vi.spyOn(console, "warn").mockImplementation(() => {});

        const reference = async (dir: string, above: string[]): Promise<string[]> => {
            const out: string[] = [];
            for (const entry of await vfs.list(dir)) {
                if (entry.kind === "dir") {
                    const id = (await locate(store, entry.path)).id;
                    if (above.includes(id)) continue;
                    out.push(entry.path, ...(await reference(entry.path, [...above, id])));
                } else {
                    out.push(entry.path);
                }
            }
            return out;
        };
        const expected = await reference("/", [ROOT_ID]);
        expect(expected).toContain("/c/again/y.txt");
        expect(expected.some((p) => p.startsWith("/c/loop"))).toBe(false);
        expect((await vfs.walkEntries("/")).map((e) => e.path)).toEqual(expected);
    });

    it("keeps at most WALK_CONCURRENCY record fetches in flight across the whole walk", async () => {
        // The pool was per DIRECTORY: a few fetches in each directory being
        // listed, so that many per level, multiplying down the tree. Records
        // are cached by id, so on a planted fan-out nothing ever waited and
        // every visit up to the entry budget was in flight at once - gigabytes
        // of heap for a few dozen records. One pool now serves the whole walk.
        //
        // And it is sized for the network, not for memory: it bounds FETCHES,
        // at most one record each, while what grew was visits. Eight for the
        // whole walk made a cold walk of a real project three to six times
        // slower than the published SDK, a round trip per eight directories.
        const { vfs, store } = makeVfs({ seed: SEED });
        const plantTree = async (d: ReturnType<typeof hostileDir>, depth: number): Promise<void> => {
            const kids = depth ? Array.from({ length: 6 }, hostileDir) : [];
            await plantValue(store, d.id, d.key, {
                v: 1, mtime: 1,
                entries: Object.fromEntries([...kids.map((k, i) => [`d${i}`, dirEntry(k)]), ["f.txt", fileEntry("f")]]),
            });
            for (const k of kids) await plantTree(k, depth - 1);
        };
        const top = hostileDir();
        await plantRoot(store, { top: dirEntry(top) });
        await plantTree(top, 3);
        vfs.clearCache();

        // Gets are answered in rounds, each once the walk has asked for all it
        // will: a round is a round trip. Every record is decrypted on the
        // thread pool, and settles when it settles - so a round was counted
        // at the first turn of the event loop with a get waiting, and split
        // in two when a decryption landed a turn late, which under load
        // failed 1 run in 5. Now a round waits until nothing the walk started
        // is still being decrypted, which no timing can move. The crypto here
        // is made late on purpose, so that this is what is tested.
        const get = store.get.bind(store);
        let waiting: Array<() => void> = [];
        store.get = (key: string) => new Promise((resolve) => waiting.push(() => resolve(get(key))));
        const crypto = slowCrypto();
        let done = false;
        const walked = vfs.walkEntries("/").finally(() => (done = true));
        let rounds = 0;
        let most = 0;
        try {
            while (!done) {
                await new Promise((resolve) => setImmediate(resolve));
                if (crypto.busy() || !waiting.length) continue;
                rounds++;
                most = Math.max(most, waiting.length);
                const round = waiting;
                waiting = [];
                for (const answer of round) answer();
            }
        } finally {
            crypto.restore();
        }
        const entries = await walked;
        // /top, then 6 directories and a file in it and in each of the next two
        // levels, then a lone file in each of the 216 at the bottom.
        expect(entries).toHaveLength(1 + 7 + 6 * 7 + 36 * 7 + 216);
        expect(most).toBeLessThanOrEqual(WALK_CONCURRENCY);
        expect(most).toBeGreaterThanOrEqual(WALK_CONCURRENCY - 1);
        // 259 records five levels deep: a round per level, and a few more for
        // the 216 at the bottom. Eight at a time took 36.
        expect(rounds).toBeLessThanOrEqual(10);
    }, 30_000);

    it("stays inside a 512MB heap on planted fan-outs at the DEFAULT limits", async () => {
        // The budgets counted OUTPUT, while the walk's in-flight state - a
        // visit, its closures and a copied ancestor set per directory - grew
        // with the fan-out. 29 planted records inside both default budgets
        // crashed a 3GB heap; so did 25 {a, b} records under `vcs status`.
        // This runs the real defaults, in a child process with a small heap,
        // because a crash here would take the test runner down with it.
        const fixture = fileURLToPath(new URL("./fixtures/fanout-walk.mts", import.meta.url));
        const run = (...args: string[]) => spawnSync(process.execPath, ["--max-old-space-size=512", "--import", "tsx", fixture, ...args], {
            cwd: fileURLToPath(new URL("../..", import.meta.url)),
            encoding: "utf8",
            timeout: 170_000,
        });
        // The biggest side a hostile tree can be, from the default budgets:
        // raise them and these cases grow with them.
        const { side } = JSON.parse(run("--sizes").stdout);
        expect(side).toBeGreaterThan(0.9 * DEFAULT_MAX_ENTRIES);
        const expected: Record<string, RegExp> = {
            "in-budget fan-out: walk": /^ok 490227$/,
            // Depth first, so the longest paths come first: either ceiling may trip.
            "over-budget fan-out: walk": /^VfsLimitError:(entries|pathChars)$/,
            "binary fan-out: walk": /^VfsLimitError:entries$/,
            "binary fan-out: vcs status": /^VfsLimitError:entries$/,
            "binary fan-out: vcs commit": /^VfsLimitError:entries$/,
            "two-byte names at the path budget: walk": /^VfsLimitError:pathChars$/,
            "repository fan-out: vcs status": /^VcsError$/,
            // Every file on both sides a change, and x.txt.
            "hostile HEAD and working tree, both in budget: vcs status": new RegExp(`^ok ${2 * side + 1}$`),
            "hostile base, ours and theirs, each in budget: vcs merge": /^ok merged$/,
        };
        // One process a case, so that what one case leaves for the collector
        // is not counted against the next.
        for (const name of Object.keys(expected)) {
            const child = run(name);
            expect(child.stderr, name).not.toMatch(/heap out of memory|FATAL/);
            expect(child.status, child.stderr).toBe(0);
            const { result, peakMB } = JSON.parse(child.stdout);
            expect(result, name).toMatch(expected[name]);
            // Not just inside the heap, but clear of its edge: a million a
            // side finished `status` 6MB short of it, and crashed `merge`.
            expect(peakMB, name).toBeLessThan(400);
        }
    }, 180_000);

    it("stops fetching once it has failed", async () => {
        // The walk rejects on the first bad record, but its workers used to
        // carry on through every remaining sibling, fetching and discarding
        // each one - in the background, while a sync's next pass started.
        const { vfs, store } = makeVfs({ seed: SEED });
        for (let d = 0; d < 100; d++) await vfs.writeFile(`/r/d${String(d).padStart(3, "0")}/f.txt`, "x");
        const bad = await locate(store, "/r/d000");
        await plantValue(store, bad.id, bad.key, 42);
        vfs.clearCache();

        let gets = 0;
        const get = store.get.bind(store);
        store.get = async (key: string) => {
            gets++;
            await new Promise((resolve) => setTimeout(resolve, 2));
            return get(key);
        };
        await expect(vfs.walk("/")).rejects.toBeInstanceOf(VfsCorruptRecordError);
        const atRejection = gets;
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(gets).toBe(atRejection);
        // The root, /r, and a pool's worth: one of them the slot the failure freed.
        expect(atRejection).toBeLessThanOrEqual(WALK_CONCURRENCY + 3);
    });

    it("lists a directory reachable from two parents under both", async () => {
        // Not a cycle. rename() attaches before it detaches, so an interrupted
        // move leaves a subtree under two names, marked so that deleting
        // either is safe. A walk that deduplicated by id would show it under
        // whichever parent a concurrent visit reached first, and a sync would
        // see the other path vanish and reappear from pass to pass.
        const { vfs, store } = makeVfs({ seed: SEED });
        const shared = hostileDir();
        const parents = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`p${i}`, dirEntry(shared)]));
        await plantRoot(store, parents);
        await plantValue(store, shared.id, shared.key, { v: 1, mtime: 1, entries: { "f.txt": fileEntry("f.txt") } });
        vfs.clearCache();

        expect(await vfs.walk("/")).toEqual(Array.from({ length: 10 }, (_, i) => `/p${i}/f.txt`));
    });

    it("treats a pointer above where the walk started as a cycle too", async () => {
        // /a/b/up points back at /a. From the root that is plainly a cycle; a
        // walk starting at /a/b has to agree, or mounting /a/b would list
        // /a/b/up/b/up/... 64 levels deep while mounting / lists none of it.
        const { vfs, store } = makeVfs({ seed: SEED });
        const a = hostileDir();
        const b = hostileDir();
        await plantRoot(store, { a: dirEntry(a) });
        await plantValue(store, a.id, a.key, { v: 1, mtime: 1, entries: { b: dirEntry(b), "top.txt": fileEntry("top.txt") } });
        await plantValue(store, b.id, b.key, { v: 1, mtime: 1, entries: { up: dirEntry(a), "x.txt": fileEntry("x.txt") } });
        vi.spyOn(console, "warn").mockImplementation(() => {});
        vfs.clearCache();

        expect(await vfs.walk("/")).toEqual(["/a/b/x.txt", "/a/top.txt"]);
        expect(await vfs.walk("/a/b")).toEqual(["/a/b/x.txt"]);
    });
});

describe("walk() over paths as long as they may be", () => {
    // Counting entries does not bound memory, because the size of each entry
    // is the attacker's to choose. A name may be 255 bytes and a tree 64
    // levels deep, so one path can be ~16KB - and every path is its own flat
    // string. Forty-odd records of long names, under the entry budget, made a
    // walk hold gigabytes of path text and crash the process.

    /** A 255-byte name: the longest one allowed, and still a perfectly usable one. */
    const longName = (i: number) => "n".repeat(247) + String(i).padStart(8, "0");

    /**
     * / -> a chain of `chain` long names -> L1 { w1 long names -> L2 } ->
     * L2 { w2 long names -> L3 } -> L3 { w3 long-named files }. No cycle, and
     * every record is small.
     */
    async function plantLongPaths(store: Store, { chain, w1, w2, w3 }: Record<string, number>) {
        const links = Array.from({ length: chain }, hostileDir);
        const [l1, l2, l3] = [hostileDir(), hostileDir(), hostileDir()];
        await plantRoot(store, { [longName(0)]: dirEntry(links[0]) });
        for (let i = 0; i < chain; i++) {
            await plantValue(store, links[i].id, links[i].key, {
                v: 1, mtime: 1, entries: { [longName(i + 1)]: dirEntry(i + 1 < chain ? links[i + 1] : l1) },
            });
        }
        const fan = (n: number, to: ReturnType<typeof hostileDir>) =>
            Object.fromEntries(Array.from({ length: n }, (_, i) => [longName(i), dirEntry(to)]));
        await plantValue(store, l1.id, l1.key, { v: 1, mtime: 1, entries: fan(w1, l2) });
        await plantValue(store, l2.id, l2.key, { v: 1, mtime: 1, entries: fan(w2, l3) });
        await plantValue(store, l3.id, l3.key, {
            v: 1, mtime: 1, entries: Object.fromEntries(Array.from({ length: w3 }, (_, i) => [longName(i), fileEntry(`f${i}`)])),
        });
    }

    it("throws at the default limits long before the paths could exhaust memory", async () => {
        // ~10,000 entries - a hundredth of the entry budget - whose paths are
        // ~11KB each: over 100 million characters of path text. At full width
        // the same shape is ~1M entries and ~11GB.
        const { vfs, store } = makeVfs({ seed: SEED });
        await plantLongPaths(store, { chain: 41, w1: 10, w2: 10, w3: 99 });
        vfs.clearCache();

        const err = await vfs.walk("/").catch((e) => e);
        expect(err).toBeInstanceOf(VfsLimitError);
        expect(err.limit).toBe("pathChars");
    }, 30_000);

    it("charges every path it emits, directories included, across the whole walk", async () => {
        const build = async (limits?: { pathChars?: number }) => {
            const made = makeVfs({ seed: SEED, limits });
            for (let d = 0; d < 4; d++) for (let f = 0; f < 10; f++) await made.vfs.writeFile(`/d${d}/f${f}.txt`, "x");
            return made.vfs;
        };
        const all = await (await build()).walkEntries("/");
        const total = all.reduce((n, e) => n + e.path.length, 0);

        expect(await (await build({ pathChars: total })).walk("/")).toHaveLength(40);
        const err = await (await build({ pathChars: total - 1 })).walk("/").catch((e) => e);
        expect(err).toBeInstanceOf(VfsLimitError);
        expect(err.limit).toBe("pathChars");
        expect(err.max).toBe(total - 1);
    });

    it("also bounds glob() and a copy of the same tree", async () => {
        const { vfs, store } = makeVfs({ seed: SEED, limits: { pathChars: 200_000 } });
        await plantLongPaths(store, { chain: 10, w1: 5, w2: 5, w3: 20 });
        vfs.clearCache();
        const top = `/${longName(0)}`;
        await expect(vfs.glob("**/*")).rejects.toBeInstanceOf(VfsLimitError);
        const before = store.puts;
        const err = await vfs.copy(top, "/copy").catch((e) => e);
        expect(err).toBeInstanceOf(VfsLimitError);
        expect(err.limit).toBe("pathChars");
        expect(store.puts).toBe(before);
    }, 30_000);
});

describe("copy() over a real or a hostile tree", () => {
    it("lets timers run through its dry run", async () => {
        // The dry run checks the whole tree before anything is written, and
        // with the records cached it waits on nothing: 1.6s of it gave a 1ms
        // interval one turn, and `vfs cp -r` ignored Ctrl-C until it was over.
        const { vfs, store } = makeVfs({ seed: SEED });
        const top = hostileDir();
        const middle = hostileDir();
        const leaves = Array.from({ length: 50 }, hostileDir);
        await plantRoot(store, { src: dirEntry(top) });
        // Every directory in at most four places, as a copy allows.
        await plantValue(store, top.id, top.key, {
            v: 1, mtime: 1, entries: Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`b${i}`, dirEntry(middle)])),
        });
        await plantValue(store, middle.id, middle.key, {
            v: 1, mtime: 1, entries: Object.fromEntries(leaves.map((leaf, i) => [`c${i}`, dirEntry(leaf)])),
        });
        for (const leaf of leaves) {
            await plantValue(store, leaf.id, leaf.key, {
                v: 1, mtime: 1, entries: Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`f${i}.txt`, fileEntry(`f${i}`)])),
            });
        }
        vfs.clearCache();
        expect(await vfs.walkEntries("/src")).toHaveLength(4 + 4 * 50 + 4 * 50 * 500);   // and now cached

        let ticks = 0;
        let beforeFirstWrite = -1;
        const put = store.put.bind(store);
        store.put = async (key: string, value: unknown) => {
            if (beforeFirstWrite < 0) beforeFirstWrite = ticks;
            return put(key, value);
        };
        const timer = setInterval(() => ticks++, 1);
        try {
            await vfs.copy("/src", "/dst");
        } finally {
            clearInterval(timer);
        }
        // A turn every few thousand entries: a dozen in the dry run.
        expect(beforeFirstWrite).toBeGreaterThanOrEqual(5);
    }, 60_000);

    // copy mints a new id, key and stored record per directory, so an
    // unbounded copy does not just hang - it writes records to the store, and
    // to the user's bill. Its guard counted the TOTAL directories seen against
    // the DEPTH limit, so it refused any ordinary tree with more than 64
    // directories in it, while also calling a merely shared subtree a cycle.

    /** A fan-out DAG: `levels` records deep, each naming the next twice. No cycle. */
    async function plantDag(store: Store, levels: number) {
        const dirs = Array.from({ length: levels }, hostileDir);
        await plantRoot(store, { dag: dirEntry(dirs[0]) });
        for (let i = 0; i < dirs.length - 1; i++) {
            await plantValue(store, dirs[i].id, dirs[i].key, {
                v: 1, mtime: 1, entries: { a: dirEntry(dirs[i + 1]), b: dirEntry(dirs[i + 1]) },
            });
        }
        await plantValue(store, dirs.at(-1)!.id, dirs.at(-1)!.key, {
            v: 1, mtime: 1, entries: { "f.txt": fileEntry("f.txt") },
        });
    }

    it("copies an ordinary tree with more than 64 directories", async () => {
        const { vfs } = makeVfs({ seed: SEED });
        for (let i = 0; i < 70; i++) await vfs.writeFile(`/src/d${i}/f.txt`, `file ${i}`);
        await vfs.copy("/src", "/copy");
        const copied = await vfs.walk("/copy");
        expect(copied).toHaveLength(70);
        expect(await vfs.readText("/copy/d69/f.txt")).toBe("file 69");
    });

    it("copies a shared subtree once under each name - it is not a cycle", async () => {
        // Two interrupted moves, one inside the other: the innermost
        // directory is in four places, which is as shared as a real tree gets.
        const { vfs, store, content } = makeVfs({ seed: SEED });
        await plantDag(store, 3);
        content.blobs.set("m-f.txt", { bytes: new TextEncoder().encode("leaf"), refs: 1 });
        vfs.clearCache();

        await vfs.copy("/dag", "/copy");
        expect(await vfs.walk("/copy")).toHaveLength(4);   // 2^2 paths to the one leaf
        expect(await vfs.readText("/copy/b/a/f.txt")).toBe("leaf");
    });

    it("refuses a tree that names one directory over and over, before writing anything", async () => {
        // Three records - D0 naming D1 300 times, D1 naming D2 300 times -
        // are 90,000 directories to a copy, each a sealed write and a round
        // trip, well inside the entry budget. Only an interrupted move puts a
        // real directory in more than one place.
        const { vfs, store } = makeVfs({ seed: SEED });
        const [d0, d1, d2] = [hostileDir(), hostileDir(), hostileDir()];
        const fan = (prefix: string, to: ReturnType<typeof hostileDir>) =>
            Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`${prefix}${i}`, dirEntry(to)]));
        await plantRoot(store, { dag: dirEntry(d0) });
        await plantValue(store, d0.id, d0.key, { v: 1, mtime: 1, entries: fan("a", d1) });
        await plantValue(store, d1.id, d1.key, { v: 1, mtime: 1, entries: fan("b", d2) });
        vfs.clearCache();
        const before = store.puts;

        const err = await vfs.copy("/dag", "/copy").catch((e) => e);
        expect(err).toBeInstanceOf(VfsLimitError);
        expect(err.limit).toBe("shared");
        expect(err.at).toBe("/dag/a0/b4");   // depth first: D2's fifth appearance comes first
        expect(store.puts).toBe(before);
        expect(await vfs.exists("/copy")).toBe(false);
    });

    it("still refuses a true cycle, and attaches nothing", async () => {
        const { vfs, store } = makeVfs({ seed: SEED });
        const loop = hostileDir();
        await plantRoot(store, { loop: dirEntry(loop) });
        await plantValue(store, loop.id, loop.key, { v: 1, mtime: 1, entries: { again: dirEntry(loop) } });
        vfs.clearCache();

        await expect(vfs.copy("/loop", "/c")).rejects.toThrow(/cycle/);
        expect(await vfs.exists("/c")).toBe(false);
    });

    it("throws the limit error on a tree past the entry budget, having written nothing", async () => {
        // Checked BEFORE the first write. Checking as it went meant a copy
        // that was going to fail first wrote up to a whole budget's worth of
        // records - one network round trip each - and took a reference to
        // every file it passed, all of it left behind unreachable. (A planted
        // fan-out now stops sooner, at MAX_SHARED; this is a plain wide tree.)
        const { vfs, store, content } = makeVfs({ seed: SEED, limits: { entries: 100 } });
        for (let d = 0; d < 10; d++) for (let f = 0; f < 10; f++) await vfs.writeFile(`/big/d${d}/f${f}.txt`, "x");
        const before = store.puts;
        const refs = [...content.blobs.values()].map((b) => b.refs);

        const err = await vfs.copy("/big", "/copy").catch((e) => e);
        expect(err).toBeInstanceOf(VfsLimitError);
        expect(err.limit).toBe("entries");
        expect(err.at.startsWith("/big/")).toBe(true);
        expect(await vfs.exists("/copy")).toBe(false);
        expect(store.puts).toBe(before);
        expect([...content.blobs.values()].map((b) => b.refs)).toEqual(refs);
    });

    it("refuses a planted fan-out too deep to copy, having written nothing", async () => {
        const { vfs, store, content } = makeVfs({ seed: SEED });
        await plantDag(store, 17);
        content.blobs.set("m-f.txt", { bytes: new TextEncoder().encode("leaf"), refs: 1 });
        vfs.clearCache();
        const before = store.puts;

        await expect(vfs.copy("/dag", "/copy")).rejects.toBeInstanceOf(VfsLimitError);
        expect(store.puts).toBe(before);
        expect(content.blobs.get("m-f.txt")!.refs).toBe(1);
    });

    it("refuses a cycle before taking a reference to anything beside it", async () => {
        const { vfs, store, content } = makeVfs({ seed: SEED });
        const loop = hostileDir();
        await plantRoot(store, { loop: dirEntry(loop) });
        await plantValue(store, loop.id, loop.key, {
            v: 1, mtime: 1, entries: { "a.txt": fileEntry("a.txt"), again: dirEntry(loop) },
        });
        content.blobs.set("m-a.txt", { bytes: new TextEncoder().encode("a"), refs: 1 });
        vfs.clearCache();
        const before = store.puts;

        await expect(vfs.copy("/loop", "/c")).rejects.toThrow(/cycle/);
        expect(store.puts).toBe(before);
        expect(content.blobs.get("m-a.txt")!.refs).toBe(1);
    });

    it("throws the limit error past the depth ceiling, counted where the copy would land", async () => {
        const { vfs, store } = makeVfs({ seed: SEED });
        await vfs.mkdir("/deep");
        await plantChain(store, "/deep", Array.from({ length: 66 }, (_, i) => `l${i}`), "x.txt");
        vfs.clearCache();
        const puts = store.puts;
        const err = await vfs.copy("/deep", "/deep2").catch((e) => e);
        expect(err).toBeInstanceOf(VfsLimitError);
        expect(err.limit).toBe("depth");
        // /deep2 is one directory down, so its l63 would be the 65th. Named
        // where it would land, like any write refused for depth: a source
        // that is merely deep is not something to delete.
        expect(err.path).toBe("/deep2");
        expect(err.at).toBe("/deep2/" + Array.from({ length: 64 }, (_, i) => `l${i}`).join("/"));
        expect(store.puts).toBe(puts);
    });
});

describe("a directory record of the wrong shape", () => {
    // unseal() hands back whatever JSON.parse produced. Before this, only a
    // literal `null` fell through to "empty directory"; `entries: null`, a bare
    // number, or a record from some future format reached Object.entries and
    // threw a TypeError - and because walk() fans out through Promise.all, one
    // such leaf failed the walk of the ENTIRE tree with a message naming
    // nothing. Now it is a typed error that names the record. It must never be
    // read as empty, though: the next write would seal an empty record over the
    // real one.
    const MALFORMED: Array<[string, unknown]> = [
        ["entries: null", { v: 1, mtime: 1, entries: null }],
        ["no entries at all", { v: 1, mtime: 1 }],
        ["entries as an array", { v: 1, mtime: 1, entries: [] }],
        ["a bare number", 42],
        ["a bare string", "not a directory"],
        ["a boolean", true],
        ["an array", [{ v: 1, entries: {} }]],
        ["an unknown version", { v: 2, mtime: 1, entries: { "a.txt": fileEntry("a.txt") } }],
        ["no version", { mtime: 1, entries: {} }],
        // Sealed, but sealing nothing. Only a record that is not STORED at all
        // is an empty directory.
        ["a sealed null", null],
    ];

    async function withBad(value: unknown) {
        const made = makeVfs({ seed: SEED });
        await made.vfs.writeFile("/good/ok.txt", "fine");
        await made.vfs.writeFile("/bad/was-here.txt", "x");
        const bad = await locate(made.store, "/bad");
        await plantValue(made.store, bad.id, bad.key, value);
        made.vfs.clearCache();
        vi.spyOn(console, "warn").mockImplementation(() => {});
        return { ...made, bad };
    }

    it.each(MALFORMED)("%s: list() throws a typed error naming the record", async (_label, value) => {
        const { vfs, bad } = await withBad(value);
        const err = await vfs.list("/bad").catch((e) => e);
        expect(err).toBeInstanceOf(VfsCorruptRecordError);
        expect(err.id).toBe(bad.id);
        expect(err.path).toBe("/bad");
        expect(err.message).toContain("/bad");
    });

    it.each(MALFORMED)("%s: walking the whole tree throws it too, not a TypeError", async (_label, value) => {
        const { vfs } = await withBad(value);
        await expect(vfs.walk("/")).rejects.toBeInstanceOf(VfsCorruptRecordError);
    });

    it("is never overwritten by a write into it", async () => {
        const { vfs, store, bad } = await withBad({ v: 2, mtime: 1, entries: { "a.txt": fileEntry("a.txt") } });
        const stored = store.records.get(dirKey(bad.id));

        await expect(vfs.writeFile("/bad/new.txt", "n")).rejects.toBeInstanceOf(VfsCorruptRecordError);
        await expect(vfs.mkdir("/bad/sub", { recursive: true })).rejects.toBeInstanceOf(VfsCorruptRecordError);
        expect(store.records.get(dirKey(bad.id))).toBe(stored);
    });

    it("is not mistaken for an absent record when it is not even sealed", async () => {
        // The store returns null only for a key that is not there. Something
        // that IS there but is not an envelope was written by something other
        // than this SDK - and reading it as "absent" would let the next write
        // replace it.
        for (const raw of [{ v: 1, entries: {} }, "plain text", 0, { iv: 5, ct: 6 }]) {
            const { vfs, store, bad } = await withBad({ v: 1, mtime: 1, entries: {} });
            await store.put(dirKey(bad.id), raw);
            vfs.clearCache();
            await expect(vfs.list("/bad"), JSON.stringify(raw)).rejects.toBeInstanceOf(VfsCorruptRecordError);
            await expect(vfs.writeFile("/bad/x.txt", "x"), JSON.stringify(raw)).rejects.toBeInstanceOf(VfsCorruptRecordError);
            expect(store.records.get(dirKey(bad.id))).toBe(raw);
        }
    });

    it("leaves the rest of the tree readable", async () => {
        const { vfs } = await withBad({ v: 1, mtime: 1, entries: null });
        expect(await vfs.readText("/good/ok.txt")).toBe("fine");
        expect((await vfs.list("/")).map((e) => e.name)).toEqual(["bad", "good"]);
    });

    it("can still be removed with a recursive delete", async () => {
        // The one way out has to work: the user sees the error and removes the
        // directory. Its subtree cannot be enumerated, so it is detached rather
        // than purged, and whatever it held is left for sweep().
        const { vfs } = await withBad({ v: 1, mtime: 1, entries: null });
        await expect(vfs.delete("/bad")).rejects.toBeInstanceOf(VfsCorruptRecordError);
        await vfs.delete("/bad", { recursive: true });
        expect(await vfs.exists("/bad")).toBe(false);
        expect(await vfs.walk("/")).toEqual(["/good/ok.txt"]);
    });

    it("does not stop a recursive delete of a directory above it", async () => {
        const { vfs, store } = makeVfs({ seed: SEED });
        await vfs.writeFile("/outer/inner/x.txt", "x");
        await vfs.writeFile("/outer/y.txt", "y");
        const inner = await locate(store, "/outer/inner");
        await plantValue(store, inner.id, inner.key, 42);
        vfs.clearCache();
        vi.spyOn(console, "warn").mockImplementation(() => {});

        await vfs.delete("/outer", { recursive: true });
        expect(await vfs.exists("/outer")).toBe(false);
    });

    it("stops sweep() before it deletes anything", async () => {
        // sweep decides what is unreachable; with part of the tree unreadable
        // it cannot know, and a guess here is a deletion.
        const { vfs, store } = await withBad(42);
        await store.put("vfs/d/orphan", { v: 1, iv: "x", ct: "y" });
        await expect(vfs.sweep()).rejects.toBeInstanceOf(VfsCorruptRecordError);
        expect(store.records.has("vfs/d/orphan")).toBe(true);
    });

    it("an ABSENT record is still an empty directory", async () => {
        // Unchanged, and deliberately so: a directory exists as soon as its
        // parent names it, before its own record is ever written.
        const { vfs, store } = makeVfs({ seed: SEED });
        const rootKey = await deriveRootKey(SEED);
        await plant(store, ROOT_ID, rootKey, {
            v: 1, mtime: 1,
            entries: { empty: { kind: "dir", id: newId(), key: Buffer.from(newDirKey()).toString("base64"), mtime: 1 } },
        } as unknown as DirNode);
        vfs.clearCache();
        expect(await vfs.list("/empty")).toEqual([]);
        await vfs.writeFile("/empty/now.txt", "n");
        expect(await vfs.readText("/empty/now.txt")).toBe("n");
    });

    it("prints nothing from the record raw, so a message cannot drive a terminal", async () => {
        // The format version comes from the record, and used to reach
        // err.message verbatim. The CLI prints messages, so an escape sequence
        // planted there ran in the user's terminal: clearing lines, or writing
        // the clipboard. (An id cannot carry one any more - an entry whose id
        // this SDK could not have minted is hidden before anything is fetched -
        // but the message escapes it too, and keeps the raw value on `.id`.)
        const { vfs, store } = makeVfs({ seed: SEED });
        const ESC = String.fromCharCode(27);
        const BEL = String.fromCharCode(7);
        const CSI = String.fromCharCode(0x9b);
        const src = hostileDir();
        await plantRoot(store, { src: dirEntry(src) });
        await plantValue(store, src.id, src.key, { v: `${ESC}]52;c;cHduZWQ=${BEL}${CSI}2J`, mtime: 1, entries: {} });
        vfs.clearCache();

        const err = await vfs.walk("/").catch((e) => e);
        expect(err).toBeInstanceOf(VfsCorruptRecordError);
        expect(err.id).toBe(src.id);
        const control = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f]");
        expect(control.test(err.message), JSON.stringify(err.message)).toBe(false);
        expect(err.message).toContain("\\u001b");

        const raw = new VfsCorruptRecordError(`${ESC}[2K`, "/x", "a reason");
        expect(raw.id).toBe(`${ESC}[2K`);
        expect(control.test(raw.message)).toBe(false);
    });

    it("does not tell the user to delete the root", async () => {
        const { vfs, store } = makeVfs({ seed: SEED });
        await plantValue(store, ROOT_ID, await deriveRootKey(SEED), 42);
        vfs.clearCache();
        const err = await vfs.list("/").catch((e) => e);
        expect(err).toBeInstanceOf(VfsCorruptRecordError);
        expect(err.message).not.toContain("{ recursive: true }");
        expect(err.message).toMatch(/root/);
        await expect(vfs.delete("/", { recursive: true })).rejects.toThrow(/cannot be deleted/);
    });
});

describe("a directory record that does not decrypt or parse", () => {
    // The shape checks run on what unseal() returns, but a record can fail
    // before that: sealed under some other key, ciphertext that does not
    // authenticate, an envelope that is not base64, plaintext that is not
    // JSON. Each threw a bare DOMException or SyntaxError that named nothing -
    // and which delete and purge did not recognise, so the directory could
    // not be removed and deleting its parent stopped half way.
    const iv = Buffer.alloc(12).toString("base64");
    const UNOPENABLE: Array<[string, (key: Uint8Array) => Promise<unknown>]> = [
        ["sealed under another key", async () => seal(newDirKey(), { v: 1, mtime: 1, entries: {} })],
        ["ciphertext that does not authenticate", async () => ({ v: 1, iv, ct: Buffer.alloc(40).toString("base64") })],
        ["an envelope that is not base64", async () => ({ v: 1, iv: "!!!", ct: "!!!" })],
        ["ciphertext cut short", async () => ({ v: 1, iv, ct: "AAAA" })],
        ["an IV of the wrong size", async () => ({ v: 1, iv: "", ct: Buffer.alloc(40).toString("base64") })],
        ["plaintext that is not JSON", async (key) => {
            const bytes = await encryptAesGcm(key, new Uint8Array(12), new TextEncoder().encode("{not json"));
            return { v: 1, iv, ct: Buffer.from(bytes).toString("base64") };
        }],
    ];

    async function withUnopenable(make: (key: Uint8Array) => Promise<unknown>) {
        const made = makeVfs({ seed: SEED });
        await made.vfs.writeFile("/outer/a-first.txt", "A");
        await made.vfs.writeFile("/outer/b-sub/inner.txt", "I");
        await made.vfs.writeFile("/outer/bad/was.txt", "x");
        await made.vfs.writeFile("/outer/z-last.txt", "Z");
        const bad = await locate(made.store, "/outer/bad");
        await made.store.put(dirKey(bad.id), await make(bad.key));
        made.vfs.clearCache();
        vi.spyOn(console, "warn").mockImplementation(() => {});
        return { ...made, bad };
    }

    it.each(UNOPENABLE)("%s: is a typed error naming the record, from list() and from a walk", async (_label, make) => {
        const { vfs, bad } = await withUnopenable(make);
        const err = await vfs.list("/outer/bad").catch((e) => e);
        expect(err).toBeInstanceOf(VfsCorruptRecordError);
        expect(err.id).toBe(bad.id);
        expect(err.path).toBe("/outer/bad");
        await expect(vfs.walk("/")).rejects.toBeInstanceOf(VfsCorruptRecordError);
        await expect(vfs.sweep()).rejects.toBeInstanceOf(VfsCorruptRecordError);
    });

    it.each(UNOPENABLE)("%s: can be removed, and does not stop its parent's removal", async (_label, make) => {
        const { vfs } = await withUnopenable(make);
        await vfs.delete("/outer/bad", { recursive: true });
        expect(await vfs.exists("/outer/bad")).toBe(false);

        const again = await withUnopenable(make);
        await again.vfs.delete("/outer", { recursive: true });
        expect(await again.vfs.exists("/outer")).toBe(false);
        // Everything readable was released; only the unreadable part is left to sweep().
        expect(again.content.blobs.size).toBe(1);
    });
});

describe("a delete that fails part way", () => {
    // Deleting used to release content as it went and detach the entry last.
    // Anything failing in between - a network error, most simply - left the
    // entry in place with some of its content already released, and the
    // obvious next step, trying again, released that content a second time.
    // Content is reference-counted and shared by copies, so the second
    // release freed bytes another file still used.

    it("releases nothing when it cannot read the whole subtree, so a retry is safe", async () => {
        const { vfs, store } = makeVfs({ seed: SEED });
        await vfs.writeFile("/outer/a-first.txt", "precious");
        await vfs.copy("/outer/a-first.txt", "/keep/copy.txt");   // one manifest, two owners
        await vfs.writeFile("/outer/b-sub/inner.txt", "I");
        await vfs.writeFile("/outer/bad/was.txt", "x");
        const bad = await locate(store, "/outer/bad");
        vfs.clearCache();

        const get = store.get.bind(store);
        let failures = 1;
        store.get = async (key: string) => {
            if (key === dirKey(bad.id) && failures-- > 0) throw new Error("network down");
            return get(key);
        };
        await expect(vfs.delete("/outer", { recursive: true })).rejects.toThrow("network down");
        expect(await vfs.readText("/outer/a-first.txt")).toBe("precious");
        expect(await vfs.readText("/keep/copy.txt")).toBe("precious");

        await vfs.delete("/outer", { recursive: true });
        expect(await vfs.exists("/outer")).toBe(false);
        expect(await vfs.readText("/keep/copy.txt")).toBe("precious");
    });

    it("releases nothing when the write that detaches the entry fails", async () => {
        const { vfs, store, content } = makeVfs({ seed: SEED });
        await vfs.writeFile("/d/f.txt", "keep me");
        await vfs.writeFile("/d/sub/g.txt", "and me");
        const d = await locate(store, "/d");

        const put = store.put.bind(store);
        let failures = 2;
        store.put = async (key: string, value: unknown) => {
            if (key === dirKey(d.id) && failures-- > 0) throw new Error("network down");
            return put(key, value);
        };
        await expect(vfs.delete("/d/f.txt")).rejects.toThrow("network down");
        await expect(vfs.delete("/d/sub", { recursive: true })).rejects.toThrow("network down");
        expect(await vfs.readText("/d/f.txt")).toBe("keep me");
        expect(await vfs.readText("/d/sub/g.txt")).toBe("and me");

        await vfs.delete("/d/f.txt");
        await vfs.delete("/d/sub", { recursive: true });
        expect(await vfs.list("/d")).toEqual([]);
        expect(content.blobs.size).toBe(0);
    });
});

describe("a write deeper than a walk will read", () => {
    // A walk throws past 64 directories below where it starts, and nothing
    // stopped a write from going deeper. A legitimate tree written 65 deep
    // under / was accepted, and then every walk of the root - every pass of
    // `vfs mount` at its default root - threw for good. Writes are measured
    // from the root, so no walk from anywhere can be refused what the SDK
    // wrote.
    const dirs = (n: number, p = "e") => "/" + Array.from({ length: n }, (_, i) => `${p}${i}`).join("/");

    it("is refused, for a file, a directory or a manifest, having written nothing", async () => {
        const { vfs, store, content } = makeVfs({ seed: SEED });
        await vfs.writeFile(`${dirs(64)}/ok.txt`, "fine");   // in the 64th directory: as deep as a walk goes
        await vfs.mkdir(dirs(64, "m"), { recursive: true });
        const puts = store.puts;
        const blobs = content.blobs.size;

        for (const attempt of [
            () => vfs.writeFile(`${dirs(65)}/deep.txt`, "x"),
            () => vfs.mkdir(dirs(65), { recursive: true }),
            () => vfs.mkdir(`${dirs(64, "m")}/one-more`),
            () => vfs.writeManifest(`${dirs(65)}/deep.bin`, { id: "m1" } as any, 1),
        ]) {
            const err = await attempt().catch((e) => e);
            expect(err, String(attempt)).toBeInstanceOf(VfsLimitError);
            expect(err.limit).toBe("depth");
            expect(err.message).not.toMatch(/recursive delete/);
        }
        expect(store.puts).toBe(puts);
        expect(content.blobs.size).toBe(blobs);
        expect(await vfs.walk("/")).toEqual([`${dirs(64)}/ok.txt`]);
    });

    it("is refused for a directory moved or copied to where it, or what is in it, would be too deep", async () => {
        const { vfs, store } = makeVfs({ seed: SEED });
        await vfs.writeFile("/src/a/b.txt", "b");   // src, then a below it
        await vfs.mkdir(dirs(63), { recursive: true });
        const puts = store.puts;

        // /e0/.../e62/src is the 64th directory and fine; src/a would be the 65th.
        const copied = await vfs.copy("/src", `${dirs(63)}/src`).catch((e) => e);
        expect(copied).toBeInstanceOf(VfsLimitError);
        expect(copied.limit).toBe("depth");
        // About where it was going: nothing is wrong with /src, so the error
        // neither names it nor advises deleting it, as it did.
        expect(copied.path).toBe(`${dirs(63)}/src`);
        expect(copied.at).toBe(`${dirs(63)}/src/a`);
        expect(copied.message).not.toMatch(/recursive delete/);
        expect(store.puts).toBe(puts);

        const moved = await vfs.rename("/src", `${dirs(63)}/e63/src`).catch((e) => e);
        expect(moved).toBeInstanceOf(VfsLimitError);
        expect(store.puts).toBe(puts);

        // A file may sit in the 64th directory, and a directory may BE it.
        await vfs.rename("/src/a/b.txt", `${dirs(63)}/b.txt`);
        await vfs.rename("/src/a", `${dirs(63)}/a`);
        expect(await vfs.walk("/")).toEqual([`${dirs(63)}/b.txt`]);
    });

    it("is refused for a directory moved to where what is in it would be too deep, having moved nothing", async () => {
        // rename measured only the moved directory's own new place, so one
        // move of a 40-deep tree under a 30-deep directory was accepted, and
        // every walk of the root threw from then on.
        const { vfs, store } = makeVfs({ seed: SEED });
        await vfs.writeFile(`/a${dirs(40)}/f.txt`, "x");
        await vfs.mkdir(`/b${dirs(30)}`, { recursive: true });
        const puts = store.puts;

        const moved = await vfs.rename("/a", `/b${dirs(30)}/a`).catch((e) => e);
        expect(moved).toBeInstanceOf(VfsLimitError);
        expect(moved.limit).toBe("depth");
        // About the destination, like any write refused for depth.
        expect(moved.path).toBe(`/b${dirs(30)}/a`);
        expect(moved.at).toBe(`/b${dirs(30)}/a${dirs(33)}`);
        expect(moved.message).not.toMatch(/recursive delete/);
        expect(store.puts).toBe(puts);
        expect(await vfs.walk("/")).toEqual([`/a${dirs(40)}/f.txt`]);

        // As deep as it may go, it goes.
        await vfs.rename("/a", `/b${dirs(22)}/a`);
        expect(await vfs.walk("/")).toEqual([`/b${dirs(22)}/a${dirs(40)}/f.txt`]);
    });

    it("is refused for a directory moved one level deeper when what is in it is already as deep as it may be", async () => {
        const { vfs, store } = makeVfs({ seed: SEED });
        await vfs.mkdir(`/a${dirs(63)}`, { recursive: true });   // 64 deep: the most there may be
        await vfs.mkdir("/b");
        const puts = store.puts;

        const moved = await vfs.rename("/a", "/b/a").catch((e) => e);
        expect(moved).toBeInstanceOf(VfsLimitError);
        expect(moved.limit).toBe("depth");
        expect(store.puts).toBe(puts);
        // Beside itself, no deeper, it moves.
        await vfs.rename("/a", "/c");
        expect(await vfs.walkEntries("/c")).toHaveLength(63);
    });

    it("reads nothing below a directory moved no deeper than it was", async () => {
        // Measuring what is below costs a read of all of it, so it is paid
        // only by a move that takes a tree deeper.
        const { vfs, store } = makeVfs({ seed: SEED });
        await vfs.writeFile("/p/q/src/deep/er/f.txt", "x");
        await vfs.mkdir("/r/s", { recursive: true });
        vfs.clearCache();
        const deep = await locate(store, "/p/q/src/deep");
        store.gets.length = 0;
        await vfs.rename("/p/q/src", "/r/s/src");
        await vfs.rename("/r/s/src", "/src");
        expect(store.gets).not.toContain(dirKey(deep.id));
        expect(await vfs.walk("/")).toEqual(["/src/deep/er/f.txt"]);
    });
});

describe("numbers in a record that are not numbers", () => {
    // readableEntry checked kind, id, key and manifest, and toStat passed the
    // rest through, so a VfsStat could carry an mtime of "yesterday", 1e300 or
    // an object, and a size of "lots". The CLI formats rows with
    // `new Date(mtime).toISOString()`, which throws on any of those: one entry
    // killed `vfs ls` and `vfs stat` for its whole directory.
    const sane = (s: { mtime: number; size: number; versions: number }) => {
        expect(() => new Date(s.mtime).toISOString(), JSON.stringify(s)).not.toThrow();
        expect(Number.isSafeInteger(s.size) && s.size >= 0, JSON.stringify(s)).toBe(true);
        expect(Number.isSafeInteger(s.versions) && s.versions >= 0, JSON.stringify(s)).toBe(true);
    };

    it("come back from list, stat and walk as numbers a Date can hold", async () => {
        const { vfs, store } = makeVfs({ seed: SEED });
        await vfs.writeFile("/d/ok.txt", "a");
        const d = await locate(store, "/d");
        const record = await readRecord(store, d.id, d.key);
        record.entries["odd.txt"] = { ...fileEntry("odd.txt"), size: "lots", mtime: 1e300, versions: { x: 1 } };
        record.entries["neg.txt"] = { ...fileEntry("neg.txt"), size: -5, mtime: Number.MAX_VALUE, versions: 2.5 };
        record.entries.sub = { ...dirEntry(hostileDir()), mtime: "yesterday" };
        await plantValue(store, d.id, d.key, record);
        vfs.clearCache();

        const listed = await vfs.list("/d");
        expect(listed.map((e) => e.name)).toEqual(["sub", "neg.txt", "odd.txt", "ok.txt"]);
        for (const entry of listed) sane(entry);
        for (const entry of await vfs.walkEntries("/")) sane(entry);
        sane(await vfs.stat("/d/odd.txt"));
        expect((await vfs.stat("/d/ok.txt")).size).toBe(1);
    });

    it("in the root record and in a file's history too", async () => {
        const { vfs, store } = makeVfs({ seed: SEED });
        await vfs.writeFile("/a.txt", "one");
        await vfs.writeFile("/a.txt", "two");
        const rootKey = await deriveRootKey(SEED);
        const root = await readRecord(store, ROOT_ID, rootKey);
        root.mtime = { evil: true };
        await plantValue(store, ROOT_ID, rootKey, root);
        const fileId = root.entries["a.txt"].id;
        await store.put(`vfs/h/${fileId}`, await seal(rootKey, {
            v: 1, versions: [{ manifest: { id: "m1" }, size: "big", mtime: "then" }, 42],
        }));
        vfs.clearCache();

        sane(await vfs.stat("/"));
        const history = await vfs.history("/a.txt");
        expect(history).toHaveLength(1);
        for (const version of history) sane({ ...version, versions: 0 });

        await store.put(`vfs/h/${fileId}`, await seal(rootKey, { v: 1, versions: "none" }));
        expect(await vfs.history("/a.txt")).toEqual([]);
    });
});

describe("a value nested deeper than anything this SDK writes", () => {
    // JSON.parse takes nesting that JSON.stringify's recursion cannot. A
    // hidden entry nested 20,000 deep was kept to be written back, and every
    // write to its directory - a delete of a sibling included - then threw
    // RangeError: Maximum call stack size exceeded. At the root, every
    // top-level create and delete failed for good.
    const deep = (n: number) => `${"[".repeat(n)}${"]".repeat(n)}`;

    async function withDeep(where: "hidden" | "visible" | "field") {
        const made = makeVfs({ seed: SEED });
        await made.vfs.writeFile("/d/a.txt", "a");
        const d = await locate(made.store, "/d");
        const record = await readRecord(made.store, d.id, d.key);
        const marker = "__DEEP__";
        if (where === "hidden") record.entries.weird = { kind: "future", id: "x", data: marker };
        if (where === "visible") record.entries["deep.txt"] = { ...fileEntry("deep.txt"), manifest: { id: "m-deep", extra: marker } };
        if (where === "field") record.extra = marker;
        // Built by hand: seal() itself cannot stringify it.
        const text = JSON.stringify(record).replace(`"${marker}"`, deep(20_000));
        const iv = new Uint8Array(12).fill(5);
        const ct = await encryptAesGcm(d.key, iv, new TextEncoder().encode(text));
        await made.store.put(dirKey(d.id), { v: 1, iv: Buffer.from(iv).toString("base64"), ct: Buffer.from(ct).toString("base64") });
        made.vfs.clearCache();
        vi.spyOn(console, "warn").mockImplementation(() => {});
        return { ...made, d };
    }

    it.each(["hidden", "visible", "field"] as const)("in a %s value: is dropped on read, so the directory stays writable", async (where) => {
        const { vfs, store, d } = await withDeep(where);
        expect((await vfs.list("/d")).map((e) => e.name)).toEqual(["a.txt"]);
        await vfs.writeFile("/d/b.txt", "b");
        await vfs.delete("/d/a.txt");
        expect(await vfs.walk("/")).toEqual(["/d/b.txt"]);
        const stored = await readRecord(store, d.id, d.key);
        expect(Object.keys(stored.entries)).toEqual(["b.txt"]);
        expect(Object.hasOwn(stored, "extra")).toBe(false);
    });

    it("keeps what this SDK writes, which is nowhere near that deep", async () => {
        const { vfs } = makeVfs({ seed: SEED });
        const manifest = { id: "m", chunks: [{ shardHashes: ["a", "b"], cipher: { key: "k", iv: "i" } }] } as any;
        await vfs.writeManifest("/d/full.bin", manifest, 1);
        vfs.clearCache();
        expect((await vfs.statManifest("/d/full.bin")).manifest).toEqual(manifest);
    });

    it("refuses a write that could not be stored with a typed error naming the directory", async () => {
        const { vfs, store } = makeVfs({ seed: SEED });
        await vfs.writeFile("/d/a.txt", "a");
        const d = await locate(store, "/d");
        const before = store.records.get(dirKey(d.id));
        let manifest: any = { id: "m-deep" };
        for (let i = 0; i < 20_000; i++) manifest = { id: "m-deep", inner: manifest };

        const err = await vfs.writeManifest("/d/deep.bin", manifest, 1).catch((e) => e);
        expect(err).toBeInstanceOf(VfsConflictError);
        expect(err.message).toContain("/d");
        expect(store.records.get(dirKey(d.id))).toBe(before);
        await vfs.writeFile("/d/b.txt", "b");
        expect(await vfs.walk("/d")).toEqual(["/d/a.txt", "/d/b.txt"]);
    });
});

describe("a version history this SDK did not write", () => {
    // A history record is sealed with its directory's key, so anything
    // holding the seed can write one - and an earlier version of this SDK
    // left some sealed with a key their directory no longer has.

    /** /a/f.txt written twice, so its history holds v1; that history, opened; and an empty /b. */
    async function withHistory() {
        const made = makeVfs({ seed: SEED });
        await made.vfs.writeFile("/a/f.txt", "v1");
        await made.vfs.writeFile("/a/f.txt", "v2");
        await made.vfs.mkdir("/b");
        const a = await locate(made.store, "/a");
        const id: string = (await readRecord(made.store, a.id, a.key)).entries["f.txt"].id;
        const history = await unseal<any>(a.key, await made.store.get(historyKey(id)));
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        return { ...made, a, id, history, warn };
    }

    /** Move /a/f.txt to /b the way an earlier version did: both records rewritten, the history left alone. */
    async function movedTheOldWay(store: Store) {
        const a = await locate(store, "/a");
        const b = await locate(store, "/b");
        const from = await readRecord(store, a.id, a.key);
        const to = (await readRecord(store, b.id, b.key)) ?? { v: 1, mtime: 1, entries: {} };
        to.entries["f.txt"] = from.entries["f.txt"];
        delete from.entries["f.txt"];
        await plantValue(store, b.id, b.key, to);
        await plantValue(store, a.id, a.key, from);
    }

    it("reads only the versions it can, so history and restore agree about which is which", async () => {
        // history() skipped a version that was not an object and restore()
        // did not, so restore(0) meant a different version from the first
        // one listed - and restoring a version with no manifest wrote an
        // entry that then vanished from every listing.
        const { vfs, store, a, id, history } = await withHistory();
        const [v1] = history.versions;
        await store.put(historyKey(id), await seal(a.key, { ...history, versions: [42, { manifest: "nope" }, { size: 1 }, v1] }));
        vfs.clearCache();
        expect(await vfs.history("/a/f.txt")).toHaveLength(1);
        await vfs.restore("/a/f.txt", 0);
        expect(await vfs.readText("/a/f.txt")).toBe("v1");
    });

    it("drops a version nested too deeply to write back, so the file stays writable and movable", async () => {
        // JSON.parse takes nesting JSON.stringify's recursion cannot, and a
        // history is written back on every save: every writeFile and restore
        // of the file threw a bare RangeError, and a move to another
        // directory threw half way, leaving the file in both.
        const made = await withHistory();
        const { vfs, store, a, warn } = made;
        await vfs.writeFile("/a/g.txt", "g1");
        await vfs.writeFile("/a/g.txt", "g2");
        const plantDeep = async (name: string) => {
            const id: string = (await readRecord(store, a.id, a.key)).entries[name].id;
            const history = await unseal<any>(a.key, await store.get(historyKey(id)));
            const marker = "__DEEP__";
            const text = JSON.stringify({ ...history, versions: [{ ...history.versions[0], note: marker }] })
                .replace(`"${marker}"`, `${"[".repeat(20_000)}${"]".repeat(20_000)}`);
            const iv = new Uint8Array(12).fill(5);
            const ct = await encryptAesGcm(a.key, iv, new TextEncoder().encode(text));
            await store.put(historyKey(id), { v: 1, iv: Buffer.from(iv).toString("base64"), ct: Buffer.from(ct).toString("base64") });
        };
        await plantDeep("f.txt");
        await plantDeep("g.txt");
        vfs.clearCache();

        expect(await vfs.history("/a/f.txt")).toEqual([]);
        expect(warn.mock.calls.flat().join("\n")).toMatch(/\/a\/f\.txt/);
        // Moved first: the move is what writes this history back.
        await vfs.rename("/a/f.txt", "/b/f.txt");
        vfs.clearCache();
        expect(await vfs.walk("/b")).toEqual(["/b/f.txt"]);
        expect(await vfs.exists("/a/f.txt")).toBe(false);
        // Saved first: the save is.
        for (const path of ["/a/g.txt", "/b/f.txt"]) {
            await vfs.writeFile(path, "v3");
            await vfs.restore(path, 0);
            expect(await vfs.readText(path), path).toMatch(/^[gv]2$/);
            expect(await vfs.history(path), path).toHaveLength(2);
        }
    });

    it("drops a field beside the versions nested too deeply to write back, so the file stays writable and movable", async () => {
        // Fields other than `versions` are kept and written back, for a newer
        // version's sake - but not one JSON.stringify cannot write, or every
        // save of the file throws a bare RangeError.
        const { vfs, store, a, id, history } = await withHistory();
        const text = JSON.stringify({ ...history, extra: "__DEEP__" }).replace(`"__DEEP__"`, `${"[".repeat(20_000)}${"]".repeat(20_000)}`);
        const iv = new Uint8Array(12).fill(6);
        const ct = await encryptAesGcm(a.key, iv, new TextEncoder().encode(text));
        await store.put(historyKey(id), { v: 1, iv: Buffer.from(iv).toString("base64"), ct: Buffer.from(ct).toString("base64") });
        vfs.clearCache();

        await vfs.writeFile("/a/f.txt", "v3");
        await vfs.rename("/a/f.txt", "/b/f.txt");
        vfs.clearCache();
        expect(await vfs.readText("/b/f.txt")).toBe("v3");
        expect(await vfs.history("/b/f.txt")).toHaveLength(2);
    });

    it("finds the key a file's history was sealed with when an earlier version moved it, and re-seals it", async () => {
        // Moved between directories by an earlier version, a file kept a
        // history its new directory could not open: it could never be
        // saved again, and nothing said how to get out.
        const { vfs, store, id } = await withHistory();
        await movedTheOldWay(store);
        vfs.clearCache();

        expect(await vfs.history("/b/f.txt")).toHaveLength(1);
        // Sealed with /b's key now, so that search is made once.
        const b = await locate(store, "/b");
        expect((await unseal<any>(b.key, await store.get(historyKey(id))))?.versions).toHaveLength(1);
        await vfs.writeFile("/b/f.txt", "v3");
        await vfs.restore("/b/f.txt", 1);
        expect(await vfs.readText("/b/f.txt")).toBe("v1");
    });

    it.each(["an entry it cannot follow", "a record that does not open"])(
        "finds it for either half of an interrupted move, past %s",
        async (unknown) => {
            // The search for the other half gave up if the tree held anything
            // it could not follow or open - one newer SDK's entry anywhere -
            // and the half whose own key did not open the history could not
            // be saved. A key that opens it is proof enough, wherever it is.
            const build = async () => {
                const made = await withHistory();
                await made.vfs.writeFile("/newer/x.txt", "x");
                const newer = await locate(made.store, "/newer");
                await plantValue(made.store, newer.id, newer.key, unknown === "a record that does not open" ? 42 : {
                    v: 1, mtime: 1, entries: { link: { kind: "symlink", id: "abcDEF123", target: "/a" } },
                });
                made.vfs.clearCache();
                return made;
            };
            const counting = await build();
            const before = counting.store.puts;
            await counting.vfs.rename("/a/f.txt", "/b/f.txt");
            const writes = counting.store.puts - before;

            let inBoth = 0;
            for (let failAt = 1; failAt <= writes; failAt++) {
                const { vfs, store, id } = await build();
                const put = store.put.bind(store);
                let n = 0;
                store.put = async (key: string, value: unknown) => {
                    if (++n === failAt) throw new Error("network error");
                    return put(key, value);
                };
                await vfs.rename("/a/f.txt", "/b/f.txt").catch(() => {});
                store.put = put;
                vfs.clearCache();
                if (!(await vfs.exists("/a/f.txt")) || !(await vfs.exists("/b/f.txt"))) continue;
                inBoth++;
                // Which half's key the shared history opens with - and still
                // does once the other half has read it: re-sealed for one half,
                // it would be the other half that searched every time.
                const opensWith = async () => {
                    const halves = [];
                    for (const dir of ["/a", "/b"]) {
                        const key = (await locate(store, dir)).key;
                        if (await unseal(key, await store.get(historyKey(id))).then(() => true, () => false)) halves.push(dir);
                    }
                    return halves;
                };
                const sealedFor = await opensWith();
                expect(sealedFor, `write ${failAt}`).toHaveLength(1);
                for (const path of ["/a/f.txt", "/b/f.txt"]) {
                    expect(await vfs.history(path), `write ${failAt}, ${path}`).not.toHaveLength(0);
                }
                expect(await opensWith(), `write ${failAt}`).toEqual(sealedFor);
                for (const path of ["/a/f.txt", "/b/f.txt"]) await vfs.writeFile(path, "more");
            }
            expect(inBoth).toBeGreaterThan(0);
        },
    );

    it("says what to do when no key in the tree opens it", async () => {
        const { vfs, store, id, history } = await withHistory();
        await store.put(historyKey(id), await seal(newDirKey(), history));
        vfs.clearCache();
        await expect(vfs.writeFile("/a/f.txt", "v3")).rejects.toThrow(/cannot be read.*Nothing has been changed.*a copy/s);
        expect(await vfs.readText("/a/f.txt")).toBe("v2");
        await vfs.copy("/a/f.txt", "/a/g.txt");
        await vfs.writeFile("/a/g.txt", "v3");
    });
});

describe("sweep() past a record no path can name", () => {
    it("counts an unreadable record behind an unusable name as unknown, and with force keeps it and goes on", async () => {
        // The entry's name is hidden, so no path reaches it, and the record it
        // points at does not decrypt. sweep() threw on it with the advice to
        // delete it recursively - which needs a path - so orphans piled up
        // for good, force or no force.
        const { vfs, store } = makeVfs({ seed: SEED });
        await vfs.writeFile("/a.txt", "a");
        const bad = hostileDir();
        await plantValue(store, bad.id, newDirKey(), { v: 1, mtime: 1, entries: {} });   // the wrong key
        const rootKey = await deriveRootKey(SEED);
        const root = await readRecord(store, ROOT_ID, rootKey);
        root.entries[`x${String.fromCharCode(92)}y`] = dirEntry(bad);
        await plantValue(store, ROOT_ID, rootKey, root);
        await store.put("vfs/d/orphan", await seal(newDirKey(), { v: 1, mtime: 1, entries: {} }));
        vfs.clearCache();
        vi.spyOn(console, "warn").mockImplementation(() => {});

        expect(await vfs.walk("/")).toEqual(["/a.txt"]);
        await expect(vfs.sweep()).rejects.toBeInstanceOf(VfsConflictError);
        expect(store.records.has("vfs/d/orphan")).toBe(true);

        expect((await vfs.sweep({ force: true })).removed).toEqual(["vfs/d/orphan"]);
        expect(store.records.has(dirKey(bad.id))).toBe(true);
        expect(await vfs.readText("/a.txt")).toBe("a");
    });

    it("still throws for an unreadable record a path can reach, which a recursive delete removes", async () => {
        const { vfs, store } = makeVfs({ seed: SEED });
        await vfs.writeFile("/bad/x.txt", "x");
        const bad = await locate(store, "/bad");
        await plantValue(store, bad.id, bad.key, 42);
        vfs.clearCache();
        await expect(vfs.sweep({ force: true })).rejects.toBeInstanceOf(VfsCorruptRecordError);
    });
});

describe("an entry whose id this SDK could never have minted", () => {
    // readableEntry took any non-empty string as an id. The id becomes a store
    // key, and Client's store puts the key in a URL: a lone surrogate makes
    // encodeURIComponent throw URIError, and an id past the Durable Object's
    // 2048-byte key limit gets a 500. Every walk of every directory above such
    // an entry failed, on every mount pass, and nothing could remove it - a
    // recursive delete of it or its parent read it first, and sweep() did too.
    // A file's id is a store key as well: its history record's.

    /** The harness store, made to fail on a key the way Client's store and the server do. */
    function strictStore(store: Store) {
        const asked: string[] = [];
        for (const method of ["get", "put", "delete"] as const) {
            const real = (store[method] as (...args: unknown[]) => Promise<unknown>).bind(store);
            (store as any)[method] = async (key: string, ...rest: unknown[]) => {
                asked.push(key);
                encodeURIComponent(key);
                if (new TextEncoder().encode(key).length > 2048) throw new Error("Keys cannot be larger than 2048 bytes");
                return real(key, ...rest);
            };
        }
        return asked;
    }

    const BAD_IDS: Array<[string, string]> = [
        ["a lone surrogate", "ab\ud800cd"],
        ["3000 characters", "A".repeat(3000)],
        ["a path", "../h/x"],
        ["a control character", `a${String.fromCharCode(27)}]52;c;eA==${String.fromCharCode(7)}`],
        ["an empty string", ""],
    ];

    async function withBadIds(id: string) {
        const made = makeVfs({ seed: SEED });
        await made.vfs.writeFile("/src/app.ts", "a");
        await made.vfs.writeFile("/junk/x.txt", "x");
        const junk = await locate(made.store, "/junk");
        const record = await readRecord(made.store, junk.id, junk.key);
        record.entries.stuck = { kind: "dir", id, key: Buffer.from(newDirKey()).toString("base64"), mtime: 1 };
        record.entries["stuck.txt"] = { ...fileEntry("stuck.txt"), id };
        await plantValue(made.store, junk.id, junk.key, record);
        made.vfs.clearCache();
        const asked = strictStore(made.store);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        return { ...made, asked, warn };
    }

    it.each(BAD_IDS)("%s: is hidden, never fetched, and does not stop anything above it", async (_label, id) => {
        const { vfs, asked } = await withBadIds(id);
        expect(await vfs.walk("/")).toEqual(["/junk/x.txt", "/src/app.ts"]);
        expect(await vfs.exists("/junk/stuck")).toBe(false);
        await vfs.delete("/junk", { recursive: true });
        expect(await vfs.walk("/")).toEqual(["/src/app.ts"]);
        await vfs.sweep({ force: true });
        expect(asked.filter((key) => key.includes(id) && id)).toEqual([]);
    });

    it.each(BAD_IDS)("%s: can be replaced by a write to its exact name", async (_label, id) => {
        const { vfs } = await withBadIds(id);
        await vfs.writeFile("/junk/stuck", "now a file");
        await vfs.writeFile("/junk/stuck.txt", "and this");
        expect(await vfs.readText("/junk/stuck")).toBe("now a file");
        expect(await vfs.readText("/junk/stuck.txt")).toBe("and this");
    });

    it("prints nothing from such an id", async () => {
        const { vfs, warn } = await withBadIds(BAD_IDS[3][1]);
        await vfs.walk("/");
        await vfs.delete("/junk", { recursive: true });
        const control = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f]");
        for (const [message] of warn.mock.calls) expect(control.test(String(message))).toBe(false);
    });
});

describe("a delete that cannot read the whole tree to find the other copy", () => {
    // Deleting half of an interrupted move reads the tree to see whether the
    // other half is still there. With part of the tree unknown - a record
    // that does not open, or an entry this version cannot follow, either of
    // which may be where the other copy is - it cannot know, and keeping
    // what may be the other copy's costs only storage.
    it.each(["a record that does not open", "an entry it cannot follow"])(
        "detaches half of an interrupted move without letting go of anything, past %s",
        async (unknown) => {
            const { vfs, store, content } = makeVfs({ seed: SEED });
            await vfs.writeFile("/old/notes.txt", "important work");
            await vfs.mkdir("/new");
            await vfs.writeFile("/junk/x.txt", "x");
            const put = store.put.bind(store);
            let n = 0;
            store.put = async (key: string, value: unknown) => {
                if (++n === 3) throw new Error("network error");   // the move's detach
                return put(key, value);
            };
            await expect(vfs.rename("/old/notes.txt", "/new/notes.txt")).rejects.toThrow("network error");
            store.put = put;
            const junk = await locate(store, "/junk");
            if (unknown === "a record that does not open") await plantValue(store, junk.id, junk.key, 42);
            else {
                const record = await readRecord(store, junk.id, junk.key);
                record.entries.link = { kind: "symlink", id: "abcDEF123", target: "/new" };
                await plantValue(store, junk.id, junk.key, record);
            }
            vfs.clearCache();
            expect(await vfs.exists("/old/notes.txt")).toBe(true);
            expect(await vfs.exists("/new/notes.txt")).toBe(true);
            const blobs = [...content.blobs.values()].map((b) => b.refs);

            const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
            try {
                await vfs.delete("/old/notes.txt");
                expect(warn.mock.calls.flat().join("\n")).toMatch(/kept what it held/);
            } finally {
                warn.mockRestore();
            }
            expect(await vfs.exists("/old/notes.txt")).toBe(false);
            expect(await vfs.readText("/new/notes.txt")).toBe("important work");
            expect([...content.blobs.values()].map((b) => b.refs)).toEqual(blobs);
        },
    );
});

describe("a recursive delete of a tree that points back above itself", () => {
    // subtree() skipped a record it had already collected, but never the
    // directories ABOVE the target. An entry under /junk naming the root
    // pulled the whole filesystem into the delete: every file's content
    // released, every directory record deleted, the root's included. Under a
    // name no listing shows, nothing even hinted it was there. Two tabs racing
    // renames can leave the same shape without any attacker.

    async function withPointer(name: string, at: "root" | "/keep") {
        const made = makeVfs({ seed: SEED });
        await made.vfs.writeFile("/keep/precious.txt", "precious");
        await made.vfs.writeFile("/keep/junk/trash.txt", "t");
        const junk = await locate(made.store, "/keep/junk");
        const target = at === "root"
            ? { id: ROOT_ID, key: await deriveRootKey(SEED) }
            : await locate(made.store, at);
        const record = await readRecord(made.store, junk.id, junk.key);
        record.entries[name] = { kind: "dir", id: target.id, key: Buffer.from(target.key).toString("base64"), mtime: 1 };
        await plantValue(made.store, junk.id, junk.key, record);
        made.vfs.clearCache();
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        return { ...made, junk, warn };
    }

    it.each([
        ["the root, under a name listings show", "up", "root"],
        ["the root, under a name no listing shows", "..", "root"],
        ["a directory above it, under a name listings show", "up", "/keep"],
        ["a directory above it, under a name no listing shows", "..", "/keep"],
    ] as const)("leaves %s alone", async (_label, name, at) => {
        const { vfs, store, content, junk, warn } = await withPointer(name, at);
        const trash = (await vfs.statManifest("/keep/junk/trash.txt")).manifest.id;

        await vfs.delete("/keep/junk", { recursive: true });

        vfs.clearCache();
        expect(store.records.has(dirKey(ROOT_ID))).toBe(true);
        expect(await vfs.readText("/keep/precious.txt")).toBe("precious");
        expect(await vfs.walk("/")).toEqual(["/keep/precious.txt"]);
        // What really was under /keep/junk still goes.
        expect(store.records.has(dirKey(junk.id))).toBe(false);
        expect(content.blobs.has(trash)).toBe(false);
        expect(content.blobs.size).toBe(1);
        expect(warn.mock.calls.some(([m]) => /above \/keep\/junk/.test(String(m)))).toBe(true);
    });

    it("only detaches an entry that is itself a pointer to a directory above it", async () => {
        const { vfs, store } = await withPointer("up", "/keep");
        const keep = await locate(store, "/keep");

        await vfs.delete("/keep/junk/up", { recursive: true });

        vfs.clearCache();
        expect(store.records.has(dirKey(keep.id))).toBe(true);
        expect(await vfs.readText("/keep/precious.txt")).toBe("precious");
        expect(await vfs.walk("/")).toEqual(["/keep/junk/trash.txt", "/keep/precious.txt"]);
    });
});

describe("an entry this version cannot read", () => {
    // A record is fine but one ENTRY in it is not: an unknown kind (perhaps
    // from a newer SDK), a missing id or key, a bare scalar. Hiding it is the
    // same outcome as someone deleting it. Dropping it from the stored record
    // is not: the next ordinary write into the directory would erase what a
    // newer version put there. So it is invisible to every read and carried
    // through every write untouched - until a write to that exact name.
    const odd = {
        future: { kind: "symlink", id: "sym1", target: "/elsewhere", mtime: 1 },
        scalar: 42,
        nothing: null,
        "dir-without-key": { kind: "dir", id: "d1", mtime: 1 },
        "dir-with-bad-key": { kind: "dir", id: "d2", key: "not base64!", mtime: 1 },
        "file-without-id": { kind: "file", manifest: { id: "m9" }, size: 1, mtime: 1 },
        "file-without-manifest": { kind: "file", id: "f1", size: 1, mtime: 1 },
        // Version control needs the manifest's id to tell versions apart, and
        // skips an entry without one; the working tree has to agree, or
        // `status` reports the file as added after every commit.
        "manifest-without-id": { kind: "file", id: "f2", manifest: { name: "x" }, size: 1, mtime: 1 },
    };

    async function withOdd() {
        const made = makeVfs({ seed: SEED });
        await made.vfs.writeFile("/d/good.txt", "g");
        const d = await locate(made.store, "/d");
        const record = await readRecord(made.store, d.id, d.key);
        await plantValue(made.store, d.id, d.key, { ...record, entries: { ...record.entries, ...odd } });
        made.vfs.clearCache();
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        return { ...made, d, warn };
    }

    it("is hidden from every read", async () => {
        const { vfs, warn } = await withOdd();
        expect((await vfs.list("/d")).map((e) => e.name)).toEqual(["good.txt"]);
        expect(await vfs.walk("/")).toEqual(["/d/good.txt"]);
        expect(await vfs.glob("/d/*")).toEqual(["/d/good.txt"]);
        for (const name of Object.keys(odd)) {
            expect(await vfs.exists(`/d/${name}`), name).toBe(false);
            await expect(vfs.stat(`/d/${name}`), name).rejects.toThrow(VfsNotFoundError);
            await expect(vfs.list(`/d/${name}`), name).rejects.toThrow(VfsNotFoundError);
        }
        expect(warn).toHaveBeenCalled();
    });

    it("survives a write to a sibling", async () => {
        const { vfs, store, d } = await withOdd();
        await vfs.writeFile("/d/sibling.txt", "s");
        await vfs.mkdir("/d/subdir");
        await vfs.delete("/d/good.txt");

        const entries = (await readRecord(store, d.id, d.key)).entries;
        for (const [name, value] of Object.entries(odd)) expect(entries[name], name).toEqual(value);
        expect(Object.keys(entries).sort()).toEqual([...Object.keys(odd), "sibling.txt", "subdir"].sort());
    });

    it("can be replaced by a write to that exact name, and then stays replaced", async () => {
        // writeFile and writeManifest are requests to put THIS at that name,
        // so they may. Nothing else is (see below).
        const { vfs, store, d } = await withOdd();
        const { manifest } = await vfs.statManifest("/d/good.txt");
        await vfs.writeFile("/d/future", "now a file");
        await vfs.writeManifest("/d/scalar", manifest, 1);
        expect(await vfs.readText("/d/future")).toBe("now a file");
        expect(await vfs.readText("/d/scalar")).toBe("g");
        expect((await readRecord(store, d.id, d.key)).entries.future.kind).toBe("file");
        expect((await readRecord(store, d.id, d.key)).entries.scalar.kind).toBe("file");

        // Deleting the replacement must not bring the hidden original back.
        await vfs.delete("/d/future");
        await vfs.delete("/d/scalar");
        vfs.clearCache();
        const entries = (await readRecord(store, d.id, d.key)).entries;
        expect(Object.hasOwn(entries, "future")).toBe(false);
        expect(Object.hasOwn(entries, "scalar")).toBe(false);
        expect(await vfs.exists("/d/future")).toBe(false);
    });

    it("is not replaced by a rename, a copy or a mkdir onto its name", async () => {
        // Each of these refuses an existing destination, and treated a hidden
        // one as free: an older SDK moving a file onto the name of a newer
        // SDK's entry erased that entry without a word - the very loss that
        // keeping hidden entries is meant to prevent.
        const { vfs, store, d } = await withOdd();
        await vfs.writeFile("/other.txt", "o");
        const refused = [
            () => vfs.rename("/d/good.txt", "/d/future"),
            () => vfs.copy("/other.txt", "/d/future"),
            () => vfs.mkdir("/d/future"),
            () => vfs.mkdir("/d/future", { recursive: true }),
            () => vfs.writeFile("/d/future/inside.txt", "x"),   // creates /d/future as a parent
        ];
        for (const attempt of refused) await expect(attempt(), String(attempt)).rejects.toThrow(/cannot read/);

        const entries = (await readRecord(store, d.id, d.key)).entries;
        expect(entries.future).toEqual(odd.future);
        expect(await vfs.readText("/d/good.txt")).toBe("g");
    });

    it("is removed by a recursive delete of its exact name, which takes nothing else with it", async () => {
        // mkdir, rename and copy refuse such a name, and a checkout that
        // needed it was refused too - while delete said the name did not
        // exist. Short of writing a file there first, the only way to clear
        // it was deleting the whole directory around it.
        const { vfs, store, d, content } = await withOdd();
        const blobs = content.blobs.size;
        for (const name of Object.keys(odd)) {
            await expect(vfs.delete(`/d/${name}`), name).rejects.toThrow(/recursive delete/);
            await vfs.delete(`/d/${name}`, { recursive: true });
            expect(Object.hasOwn((await readRecord(store, d.id, d.key)).entries, name), name).toBe(false);
        }
        await vfs.mkdir("/d/future");
        expect(await vfs.walk("/")).toEqual(["/d/good.txt"]);
        expect(content.blobs.size).toBe(blobs);
        await expect(vfs.delete("/d/never-there", { recursive: true })).rejects.toBeInstanceOf(VfsNotFoundError);
    });

    it("keeps its directory non-empty for a plain delete", async () => {
        // Otherwise `delete` without `recursive` would see an "empty"
        // directory and erase the entries it cannot read along with it.
        const { vfs } = await withOdd();
        await vfs.delete("/d/good.txt");
        await expect(vfs.delete("/d")).rejects.toBeInstanceOf(VfsConflictError);
    });

    it("is not copied, and does not stop the copy", async () => {
        const { vfs } = await withOdd();
        await vfs.copy("/d", "/copy");
        expect(await vfs.walk("/copy")).toEqual(["/copy/good.txt"]);
    });

    it("stops sweep() unless forced, rather than guessing what it references", async () => {
        // A newer SDK's entry may be the only thing keeping some record
        // reachable. This version cannot follow it, so it cannot call anything
        // an orphan with confidence.
        const { vfs, store } = await withOdd();
        await store.put("vfs/d/sym1", { v: 1, iv: "x", ct: "y" });
        await expect(vfs.sweep()).rejects.toBeInstanceOf(VfsConflictError);
        expect(store.records.has("vfs/d/sym1")).toBe(true);
        await vfs.sweep({ force: true });
        expect(store.records.has("vfs/d/sym1")).toBe(false);
    });
});

describe("names that are also Object.prototype members", () => {
    // Entry maps used to be ordinary objects straight out of JSON.parse, looked
    // up with bare brackets. So `entries["constructor"]` found the inherited
    // Object constructor - a phantom entry no listing ever showed - and
    // `entries["__proto__"] = entry` set the object's PROTOTYPE instead of
    // adding a key, which JSON.stringify then left out: a write that reported
    // success and stored nothing. Plain folder names, not an attack; the fix is
    // a null-prototype map, never a rule against the names.
    const PROTO_NAMES = ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf", "isPrototypeOf"];

    it("are not phantom entries on an empty filesystem", async () => {
        const { vfs } = makeVfs({ seed: SEED });
        for (const name of PROTO_NAMES) {
            expect(await vfs.exists(`/${name}`), name).toBe(false);
            await expect(vfs.stat(`/${name}`), name).rejects.toThrow(VfsNotFoundError);
        }
    });

    it("can be real directories, created explicitly or as parents", async () => {
        const { vfs } = makeVfs({ seed: SEED });
        await vfs.mkdir("/src/constructor", { recursive: true });
        await vfs.writeFile("/src/constructor/index.ts", "a");
        await vfs.writeFile("/src/toString/index.ts", "b");

        vfs.clearCache();
        expect(await vfs.readText("/src/constructor/index.ts")).toBe("a");
        expect(await vfs.readText("/src/toString/index.ts")).toBe("b");
        expect((await vfs.list("/src")).map((e) => e.name)).toEqual(["constructor", "toString"]);
    });

    it("keeps a file named __proto__, in an existing directory and a brand-new one", async () => {
        // The second write goes into a directory created by the same call, so
        // its record is the empty-directory fallback rather than an unsealed
        // one - a separate construction site that needs the same map.
        const { vfs } = makeVfs({ seed: SEED });
        await vfs.writeFile("/__proto__", "hi");
        await vfs.writeFile("/fresh/__proto__", "nested");

        vfs.clearCache();
        expect(await vfs.readText("/__proto__")).toBe("hi");
        expect(await vfs.readText("/fresh/__proto__")).toBe("nested");
        expect((await vfs.list("/")).map((e) => e.name)).toEqual(["fresh", "__proto__"]);
        expect(await vfs.walk("/")).toEqual(["/fresh/__proto__", "/__proto__"]);
    });

    it("survive a copy", async () => {
        const { vfs } = makeVfs({ seed: SEED });
        await vfs.writeFile("/a/__proto__", "p");
        await vfs.writeFile("/a/constructor/x.ts", "c");
        await vfs.copy("/a", "/b");

        vfs.clearCache();
        expect(await vfs.readText("/b/__proto__")).toBe("p");
        expect(await vfs.readText("/b/constructor/x.ts")).toBe("c");
    });
});

describe("isSafeName", () => {
    it("accepts real filenames, including extensionless and dot-files", () => {
        for (const n of ["index.ts", "Makefile", ".gitignore", "a b.txt", "café.png"]) {
            expect(isSafeName(n), n).toBe(true);
        }
    });

    it("rejects anything that would become path structure or hide itself", () => {
        const bs = String.fromCharCode(92);
        for (const n of ["", ".", "..", "a/b", `a${bs}b`, `a${String.fromCharCode(0)}b`,
                         `a${String.fromCharCode(10)}b`, `${String.fromCharCode(0x202e)}gpj.exe`, "x".repeat(300)]) {
            expect(isSafeName(n), JSON.stringify(n)).toBe(false);
        }
    });
});
