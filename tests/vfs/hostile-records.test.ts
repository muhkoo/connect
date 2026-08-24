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
import { makeVfs } from "./harness";
import { seal, deriveRootKey, newDirKey, newId } from "../../src/vfs/recordCipher";
import { dirKey, ROOT_ID, type DirNode } from "../../src/vfs/types";
import { isSafeName } from "../../src/vfs/paths";

const SEED = new Uint8Array(32).fill(7);

/** Put a directory record straight into the store, as a hostile app would. */
async function plant(store: ReturnType<typeof makeVfs>["store"], id: string, key: Uint8Array, node: DirNode) {
    await store.put(dirKey(id), await seal(key, node));
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
