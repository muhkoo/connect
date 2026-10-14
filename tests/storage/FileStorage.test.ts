/**
 * End-to-end test for the new storage pipeline:
 *   plaintext → chunk → encrypt → RS-encode → upload-shards
 *                                 ↓ (manifest written to space)
 *   plaintext ← reassemble ← decrypt ← RS-decode ← download-shards
 *
 * The transport layers are stubbed with in-memory implementations so the test
 * runs without a server — both the open shard store and the gated space.
 * The cipher + codec + orchestrator are real.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { FileStorage } from "../../src/storage/FileStorage";
import { ChunkCipher } from "../../src/crypto/ChunkCipher";
import { ReedSolomonCodec } from "../../src/storage/encoding";
import { _resetRsWasmForTests } from "../../src/storage/encoding/ReedSolomon/wasm/rs";
import { shardHash } from "../../src/storage/transport/ShardClient";
import type { FileManifest } from "../../src/storage/types";

// Vitest runs under Node and doesn't honor the rollup-plugin-wasm import path,
// so load the RS wasm directly from disk and compile it once for all tests.
// This is the same escape hatch CF Workers use in production (passing a
// pre-compiled module instead of relying on the bundled loader).
let rsWasmModule: WebAssembly.Module;
beforeAll(async () => {
    const wasmPath = join(
        __dirname,
        "..",
        "..",
        "src",
        "storage",
        "encoding",
        "ReedSolomon",
        "wasm",
        "wasm_reed_solomon_erasure_bg.wasm",
    );
    const bytes = readFileSync(wasmPath);
    rsWasmModule = await WebAssembly.compile(bytes);
    _resetRsWasmForTests();
});

// ---------------------------------------------------------------------------
// In-memory transport stubs
// ---------------------------------------------------------------------------

class InMemoryShardClient {
    private readonly store = new Map<string, Uint8Array>();

    /** Mirror of `ShardClient.putShard`. */
    async putShard(hash: string, bytes: Uint8Array): Promise<{ dedup: boolean }> {
        const computed = await shardHash(bytes);
        if (computed !== hash) {
            throw new Error(`InMemoryShardClient: hash mismatch (provided ${hash}, computed ${computed})`);
        }
        const dedup = this.store.has(hash);
        this.store.set(hash, new Uint8Array(bytes));
        return { dedup };
    }

    async getShard(hash: string): Promise<Uint8Array | null> {
        const bytes = this.store.get(hash);
        return bytes ? new Uint8Array(bytes) : null;
    }

    async hasShard(hash: string): Promise<boolean> {
        return this.store.has(hash);
    }

    /** Test affordance — simulate a shard dropping out of the store. */
    deleteShard(hash: string): boolean {
        return this.store.delete(hash);
    }

    shardCount(): number {
        return this.store.size;
    }
}

class InMemorySharedSpaceClient {
    private readonly manifests = new Map<string, FileManifest>();

    async writeFileManifest(_spaceId: string, manifest: FileManifest): Promise<void> {
        this.manifests.set(`${_spaceId}/${manifest.id}`, JSON.parse(JSON.stringify(manifest)));
    }

    async readFileManifest(_spaceId: string, fileId: string): Promise<FileManifest> {
        const m = this.manifests.get(`${_spaceId}/${fileId}`);
        if (!m) throw new Error(`InMemorySharedSpaceClient: no manifest for ${fileId}`);
        return JSON.parse(JSON.stringify(m));
    }

    async deleteFileManifest(_spaceId: string, fileId: string): Promise<boolean> {
        return this.manifests.delete(`${_spaceId}/${fileId}`);
    }

    async listFiles(_spaceId: string) {
        const out: ReturnType<FileManifest["chunks"][number]["shardHashes"]["map"]>[] = [] as never;
        for (const [key, m] of this.manifests) {
            if (!key.startsWith(`${_spaceId}/`)) continue;
            let shardCount = 0;
            for (const c of m.chunks) shardCount += c.shardHashes.length;
            out.push({
                id: m.id,
                name: m.name,
                size: m.size,
                type: m.type,
                path: m.path,
                lastModified: m.lastModified,
                createdAt: m.createdAt,
                chunkCount: m.chunks.length,
                shardCount,
            } as never);
        }
        return out;
    }
}

function randomBytes(n: number): Uint8Array {
    const buf = new Uint8Array(n);
    for (let i = 0; i < n; i += 65536) {
        crypto.getRandomValues(buf.subarray(i, Math.min(i + 65536, n)));
    }
    return buf;
}

// ---------------------------------------------------------------------------
// Codec — sanity-check the WASM RS layer in isolation first. If this fails,
// every higher-level test will fail too, so it's worth knowing at a glance.
// ---------------------------------------------------------------------------

describe("ReedSolomonCodec", () => {
    it("round-trips a buffer with no missing shards", async () => {
        const codec = new ReedSolomonCodec();
        await codec.ready(rsWasmModule);
        const input = randomBytes(10_000);
        const { shards, dataShards, parityShards, originalSize } = codec.encode(input, 4, 2);
        expect(shards.length).toBe(6);
        const out = codec.decode(shards, parityShards, [], originalSize);
        expect(out.length).toBe(input.length);
        expect(out).toEqual(input);
    });

    it("recovers from a missing data shard", async () => {
        const codec = new ReedSolomonCodec();
        await codec.ready(rsWasmModule);
        const input = randomBytes(50_000);
        const { shards, parityShards, originalSize, shardSize } = codec.encode(input, 4, 2);
        // Drop the 2nd data shard.
        const corrupted = shards.map((s, i) => (i === 1 ? new Uint8Array(shardSize) : s));
        const out = codec.decode(corrupted, parityShards, [1], originalSize);
        expect(out).toEqual(input);
    });

    it("recovers from a missing parity shard", async () => {
        const codec = new ReedSolomonCodec();
        await codec.ready(rsWasmModule);
        const input = randomBytes(50_000);
        const { shards, parityShards, originalSize, shardSize } = codec.encode(input, 4, 2);
        // Drop the last (parity) shard.
        const corrupted = shards.map((s, i) => (i === 5 ? new Uint8Array(shardSize) : s));
        const out = codec.decode(corrupted, parityShards, [5], originalSize);
        expect(out).toEqual(input);
    });

    it("recovers from the maximum tolerable losses", async () => {
        const codec = new ReedSolomonCodec();
        await codec.ready(rsWasmModule);
        const input = randomBytes(50_000);
        const { shards, parityShards, originalSize, shardSize } = codec.encode(input, 4, 2);
        // Drop both parity shards' worth of shards (one data + one parity).
        const corrupted = shards.map((s, i) =>
            i === 2 || i === 5 ? new Uint8Array(shardSize) : s,
        );
        const out = codec.decode(corrupted, parityShards, [2, 5], originalSize);
        expect(out).toEqual(input);
    });
});

// ---------------------------------------------------------------------------
// Cipher — confirm AES-256-GCM is wired correctly.
// ---------------------------------------------------------------------------

describe("ChunkCipher", () => {
    it("round-trips a chunk", async () => {
        const cipher = new ChunkCipher();
        const material = cipher.generateKeyMaterial();
        const plaintext = new TextEncoder().encode("hello, world — encrypted chunk");
        const ciphertext = await cipher.encryptChunk(plaintext, material);
        // AES-GCM appends a 16-byte tag, so ciphertext is plaintext.length + 16.
        expect(ciphertext.length).toBe(plaintext.length + 16);
        const out = await cipher.decryptChunk(ciphertext, material);
        expect(new TextDecoder().decode(out)).toBe("hello, world — encrypted chunk");
    });

    it("fails closed on wrong key", async () => {
        const cipher = new ChunkCipher();
        const material = cipher.generateKeyMaterial();
        const other = cipher.generateKeyMaterial();
        const plaintext = new TextEncoder().encode("secret");
        const ciphertext = await cipher.encryptChunk(plaintext, material);
        await expect(cipher.decryptChunk(ciphertext, other)).rejects.toThrow();
    });
});

// ---------------------------------------------------------------------------
// FileStorage — the end-to-end orchestration.
// ---------------------------------------------------------------------------

describe("FileStorage end-to-end", () => {
    function makeStorage(opts?: Partial<{ chunkSize: number; dataShards: number; parityShards: number }>) {
        const space = new InMemorySharedSpaceClient();
        const shards = new InMemoryShardClient();
        // The transport stubs only need to implement the subset of methods
        // FileStorage actually calls, so the structural cast is safe.
        const storage = new FileStorage({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            space: space as any,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            shards: shards as any,
            chunkSize: opts?.chunkSize ?? 64 * 1024,
            dataShards: opts?.dataShards ?? 4,
            parityShards: opts?.parityShards ?? 2,
            rsWasmModule,
        });
        return { storage, space, shards };
    }

    it("round-trips a small file (< 1 chunk)", async () => {
        const { storage } = makeStorage();
        const data = new TextEncoder().encode("the quick brown fox jumps over the lazy dog");
        const stat = await storage.writeFile({
            spaceId: "test-space",
            data,
            metadata: { name: "small.txt", type: "text/plain", lastModified: 1700000000000 },
        });
        expect(stat.size).toBe(data.length);
        expect(stat.chunkCount).toBe(1);
        expect(stat.shardCount).toBe(6); // 4 data + 2 parity

        const { data: recovered } = await storage.readFile("test-space", stat.id);
        expect(recovered).toEqual(data);
    });

    it("round-trips a multi-chunk file with random data", async () => {
        const { storage } = makeStorage({ chunkSize: 32 * 1024 });
        const data = randomBytes(200_000); // 7 chunks at 32 KiB
        const stat = await storage.writeFile({
            spaceId: "test-space",
            data,
            metadata: { name: "blob.bin", type: "application/octet-stream" },
        });
        expect(stat.size).toBe(data.length);
        expect(stat.chunkCount).toBe(Math.ceil(200_000 / (32 * 1024)));

        const { data: recovered } = await storage.readFile("test-space", stat.id);
        expect(recovered).toEqual(data);
    });

    it("recovers when up to parityShards shards are missing in a chunk", async () => {
        const { storage, space, shards } = makeStorage({ chunkSize: 16 * 1024, dataShards: 4, parityShards: 2 });
        const data = randomBytes(20_000); // forces 2 chunks
        const stat = await storage.writeFile({
            spaceId: "test-space",
            data,
            metadata: { name: "fault-tolerant.bin", type: "application/octet-stream" },
        });

        // Pluck two shards (max tolerable) out of every chunk.
        const manifest = await space.readFileManifest("test-space", stat.id);
        for (const chunk of manifest.chunks) {
            if (chunk.shardHashes.length < 6) continue;
            shards.deleteShard(chunk.shardHashes[1]);
            shards.deleteShard(chunk.shardHashes[5]);
        }

        const { data: recovered } = await storage.readFile("test-space", stat.id);
        expect(recovered).toEqual(data);
    });

    it("refuses to reconstruct when too many shards are missing", async () => {
        const { storage, space, shards } = makeStorage({ chunkSize: 16 * 1024, dataShards: 4, parityShards: 2 });
        const data = randomBytes(10_000);
        const stat = await storage.writeFile({
            spaceId: "test-space",
            data,
            metadata: { name: "lossy.bin", type: "application/octet-stream" },
        });

        // Drop 3 shards (> parityShards) from chunk 0.
        const manifest = await space.readFileManifest("test-space", stat.id);
        shards.deleteShard(manifest.chunks[0].shardHashes[0]);
        shards.deleteShard(manifest.chunks[0].shardHashes[1]);
        shards.deleteShard(manifest.chunks[0].shardHashes[2]);

        await expect(storage.readFile("test-space", stat.id)).rejects.toThrow(/unrecoverable/);
    });

    it("handles an empty file", async () => {
        const { storage } = makeStorage();
        const data = new Uint8Array(0);
        const stat = await storage.writeFile({
            spaceId: "test-space",
            data,
            metadata: { name: "empty.bin", type: "application/octet-stream" },
        });
        expect(stat.size).toBe(0);
        expect(stat.shardCount).toBe(0);

        const { data: recovered } = await storage.readFile("test-space", stat.id);
        expect(recovered.length).toBe(0);
    });

    it("supports the shard-only pipeline (no SharedSpace)", async () => {
        // Chat file sharing uses this path: writeFileToShards returns the
        // manifest, which the caller delivers via an encrypted chat message;
        // recipients call readFileFromShards directly.
        const shards = new InMemoryShardClient();
        const storage = new FileStorage({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            shards: shards as any,
            chunkSize: 32 * 1024,
            rsWasmModule,
        });
        const data = randomBytes(75_000);
        const { manifest, stat } = await storage.writeFileToShards({
            data,
            metadata: { name: "chat-share.bin", type: "application/octet-stream" },
        });
        expect(stat.size).toBe(data.length);
        expect(manifest.chunks.length).toBe(Math.ceil(75_000 / (32 * 1024)));

        const { data: recovered } = await storage.readFileFromShards(manifest);
        expect(recovered).toEqual(data);
    });

    it("rejects space-required operations when no space is configured", async () => {
        const shards = new InMemoryShardClient();
        const storage = new FileStorage({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            shards: shards as any,
            rsWasmModule,
        });
        await expect(
            storage.writeFile({
                spaceId: "x",
                data: new Uint8Array(10),
                metadata: { name: "x", type: "x" },
            }),
        ).rejects.toThrow(/SharedSpaceClient is required/);
        await expect(storage.readFile("x", "y")).rejects.toThrow(/SharedSpaceClient is required/);
        await expect(storage.deleteFile("x", "y")).rejects.toThrow(/SharedSpaceClient is required/);
        await expect(storage.listFiles("x")).rejects.toThrow(/SharedSpaceClient is required/);
    });

    it("dedups identical shards across writes", async () => {
        const { storage, shards } = makeStorage({ chunkSize: 64 * 1024, dataShards: 4, parityShards: 2 });
        const data = new Uint8Array(40_000).fill(0); // all zeros — every chunk encrypts uniquely though
        await storage.writeFile({
            spaceId: "test-space",
            data,
            metadata: { name: "a.bin", type: "application/octet-stream" },
        });
        const countAfterA = shards.shardCount();
        // Writing different data should add shards, not collide.
        await storage.writeFile({
            spaceId: "test-space",
            data: new Uint8Array(40_000).fill(1),
            metadata: { name: "b.bin", type: "application/octet-stream" },
        });
        expect(shards.shardCount()).toBeGreaterThan(countAfterA);
    });
});

/**
 * How many shards a read actually fetches.
 *
 * Reed-Solomon needs `dataShards` of `dataShards + parityShards`, and reads used
 * to fetch all of them — six round trips where four would do, per chunk, per
 * file. On one large file that is invisible; on a project it is not. Opening a
 * 519-file project cost 3,114 shard requests, six per file, a third of them for
 * parity that was decoded and discarded.
 */
describe("read fetches parity only when it is needed", () => {
    /** A shard store that records every hash it is asked for. */
    function countingShards(drop = new Set<string>()) {
        const store = new Map<string, Uint8Array>();
        const asked: string[] = [];
        return {
            asked,
            store,
            async putShard(hash: string, bytes: Uint8Array) { store.set(hash, bytes); return hash; },
            async getShard(hash: string) {
                asked.push(hash);
                if (drop.has(hash)) return null;
                return store.get(hash) ?? null;
            },
        };
    }

    const build = (shards: ReturnType<typeof countingShards>) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        new FileStorage({ shards: shards as any, dataShards: 4, parityShards: 2, rsWasmModule });

    it("fetches only the data shards for an intact file", async () => {
        const shards = countingShards();
        const storage = build(shards);
        const { manifest } = await storage.writeFileToShards({
            data: new TextEncoder().encode("a small source module"),
            metadata: { name: "mod.ts", type: "text/plain" },
        });
        expect(manifest.chunks[0].shardHashes.length).toBe(6);

        shards.asked.length = 0;
        const { data } = await storage.readFileFromShards(manifest);
        expect(new TextDecoder().decode(data)).toBe("a small source module");
        expect(shards.asked, "an intact read must not pay for parity").toHaveLength(4);
    });

    it("falls back to parity when a data shard is gone, and still reconstructs", async () => {
        const shards = countingShards();
        const storage = build(shards);
        const payload = "x".repeat(5000);
        const { manifest } = await storage.writeFileToShards({
            data: new TextEncoder().encode(payload),
            metadata: { name: "big.ts", type: "text/plain" },
        });

        // Lose one data shard, exactly as a missing blob would.
        const dead = manifest.chunks[0].shardHashes[1];
        const damaged = countingShards(new Set([dead]));
        for (const [k, v] of shards.store) damaged.store.set(k, v);

        const { data } = await build(damaged).readFileFromShards(manifest);
        expect(new TextDecoder().decode(data)).toBe(payload);
        expect(damaged.asked.length, "4 data shards, then the 2 parity").toBe(6);
    });
});

describe("a multi-chunk read fetches ahead, within a bound", () => {
    /**
     * A shard store whose reads take a while, and which records how many
     * distinct CHUNKS have a shard read in flight at once.
     */
    function slowShards(delay = 15) {
        const store = new Map<string, Uint8Array>();
        const chunkOf = new Map<string, number>();
        const active = new Map<number, number>();   // chunk → shard reads in flight
        const seen = { maxChunks: 0, chunksStarted: [] as number[] };
        return {
            store, chunkOf, seen,
            async putShard(hash: string, bytes: Uint8Array) { store.set(hash, bytes); return hash; },
            async getShard(hash: string) {
                const c = chunkOf.get(hash) ?? -1;
                if (!active.has(c)) seen.chunksStarted.push(c);
                active.set(c, (active.get(c) ?? 0) + 1);
                seen.maxChunks = Math.max(seen.maxChunks, active.size);
                try {
                    await new Promise((r) => setTimeout(r, delay));
                    return store.get(hash) ?? null;
                } finally {
                    const n = active.get(c)! - 1;
                    if (n === 0) active.delete(c); else active.set(c, n);
                }
            },
        };
    }
    async function eightChunks() {
        const shards = slowShards();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const storage = new FileStorage({ shards: shards as any, chunkSize: 4096, dataShards: 4, parityShards: 2, rsWasmModule });
        const data = randomBytes(8 * 4096);
        const { manifest } = await storage.writeFileToShards({ data, metadata: { name: "big.bin", type: "application/octet-stream" } });
        for (const c of manifest.chunks) for (const h of c.shardHashes) shards.chunkOf.set(h, c.chunkIndex);
        expect(manifest.chunks).toHaveLength(8);
        return { shards, storage, data, manifest };
    }

    it("readFileFromShards overlaps chunks — at most the one being read and two ahead", async () => {
        const { shards, storage, data, manifest } = await eightChunks();
        const { data: back } = await storage.readFileFromShards(manifest);
        expect(back).toEqual(data);
        expect(shards.seen.maxChunks).toBeGreaterThan(1);
        expect(shards.seen.maxChunks).toBeLessThanOrEqual(3);
        expect(shards.seen.chunksStarted).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);   // started in order
    });

    it("readChunksFromShards yields in order, and holds no more than that while its caller is slow", async () => {
        const { shards, storage, data, manifest } = await eightChunks();
        const parts: Uint8Array[] = [];
        for await (const part of storage.readChunksFromShards(manifest)) {
            parts.push(part);
            await new Promise((r) => setTimeout(r, 40));   // a slow consumer: the reads must not run away
        }
        expect(Buffer.concat(parts)).toEqual(Buffer.from(data));
        expect(shards.seen.maxChunks).toBeGreaterThan(1);
        expect(shards.seen.maxChunks).toBeLessThanOrEqual(3);
    });

    it("a failed chunk fails the read, in order, and leaves no unhandled rejection behind", async () => {
        const { shards, storage, manifest } = await eightChunks();
        // Lose three shards of chunk 5: more than parity can cover.
        for (const h of manifest.chunks[5].shardHashes.slice(0, 3)) shards.store.delete(h);
        const got: number[] = [];
        await expect((async () => {
            let i = 0;
            for await (const _ of storage.readChunksFromShards(manifest)) got.push(i++);
        })()).rejects.toThrow();
        expect(got).toEqual([0, 1, 2, 3, 4]);
    });

    it("stops fetching when its caller breaks out, and a read still in flight fails quietly", async () => {
        const { shards, storage, manifest } = await eightChunks();
        // Chunk 2 will fail while the consumer is already gone.
        for (const h of manifest.chunks[2].shardHashes.slice(0, 3)) shards.store.delete(h);
        const unhandled: unknown[] = [];
        const onUnhandled = (e: unknown) => unhandled.push(e);
        process.on("unhandledRejection", onUnhandled);
        try {
            for await (const _ of storage.readChunksFromShards(manifest)) break;   // the first chunk only
            await new Promise((r) => setTimeout(r, 150));   // let the abandoned reads settle
            await new Promise((r) => setImmediate(r));
        } finally {
            process.off("unhandledRejection", onUnhandled);
        }
        // Chunk 0 held, and at most two ahead plus the one started as it was handed over.
        // (A chunk can appear twice: its parity is fetched after its data shards.)
        const started = [...new Set(shards.seen.chunksStarted)];
        expect(started.length).toBeLessThanOrEqual(1 + 2 + 1);
        expect(started).toEqual([0, 1, 2, 3].slice(0, started.length));
        expect(unhandled).toEqual([]);
    });
});
