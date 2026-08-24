/**
 * An in-memory VFS wired to fakes, so the tree logic can be tested without a
 * network, a space, or a seed ceremony.
 *
 * The store is deliberately a real map of SEALED values rather than a plain
 * object of plaintext: encryption is part of what is being tested, and a fake
 * that skipped it would let a key-handling bug through — the exact class of bug
 * that matters most here, since a directory record carries its files' chunk
 * keys.
 */
import { VfsNamespace, type VfsContentStore } from "../../src/vfs/VfsNamespace";
import type { VfsStore } from "../../src/vfs/types";
import type { FileManifest } from "../../src/storage/types";

export function makeStore(): VfsStore & { records: Map<string, unknown>; puts: number; gets: string[] } {
    const records = new Map<string, unknown>();
    return {
        records,
        puts: 0,
        // Every read, in order — so a test can assert that resolving many paths
        // does not re-fetch the same directory record over and over.
        gets: [] as string[],
        async get(key) {
            (this as { gets: string[] }).gets.push(key);
            return records.get(key) ?? null;
        },
        async put(key, value) {
            (this as { puts: number }).puts++;
            records.set(key, value);
        },
        async delete(key) {
            records.delete(key);
        },
        async list() {
            return [...records.keys()];
        },
    };
}

/**
 * Content store that models the real thing's REFERENCE COUNTING, not just a
 * bag of bytes. Shards are content-addressed and shared, so "did deleting this
 * free the storage" and "did it free storage someone else still needs" are both
 * questions worth being able to ask in a test.
 */
export function makeContent(): VfsContentStore & { blobs: Map<string, { bytes: Uint8Array; refs: number }> } {
    const blobs = new Map<string, { bytes: Uint8Array; refs: number }>();
    let n = 0;
    const idOf = (m: FileManifest) => (m as unknown as { id: string }).id;
    return {
        blobs,
        async write(data, meta) {
            const bytes = data instanceof Uint8Array ? data : new Uint8Array(await (data as Blob).arrayBuffer());
            const id = `m${++n}`;
            blobs.set(id, { bytes, refs: 1 });
            return {
                manifest: { id, name: meta.name, size: bytes.length, type: meta.type } as unknown as FileManifest,
                size: bytes.length,
            };
        },
        async read(manifest) {
            const entry = blobs.get(idOf(manifest));
            if (!entry) throw new Error("content missing");
            return entry.bytes;
        },
        async retain(manifest) {
            const entry = blobs.get(idOf(manifest));
            if (entry) entry.refs++;
        },
        async release(manifest) {
            const entry = blobs.get(idOf(manifest));
            if (!entry) return;
            if (--entry.refs <= 0) blobs.delete(idOf(manifest));
        },
    };
}

export function makeVfs(opts: { seed?: Uint8Array | null; historyLimit?: number } = {}) {
    const store = makeStore();
    const content = makeContent();
    let seed = opts.seed === undefined ? new Uint8Array(32).fill(7) : opts.seed;
    const vfs = new VfsNamespace({
        store,
        content,
        seed: () => seed,
        historyLimit: opts.historyLimit,
    });
    return {
        vfs,
        store,
        content,
        lock: () => {
            seed = null;
            vfs.clearCache();
        },
    };
}
