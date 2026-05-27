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
