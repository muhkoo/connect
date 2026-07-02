import { describe, it, expect, vi } from "vitest";
import { ShardClient, type ShardByteCache } from "../../src/storage/transport/ShardClient";

/** In-memory ShardByteCache stand-in (the real ShardCache needs the Cache API). */
class MemCache implements ShardByteCache {
    map = new Map<string, Uint8Array>();
    async get(hash: string) {
        return this.map.get(hash) ?? null;
    }
    async put(hash: string, bytes: Uint8Array) {
        this.map.set(hash, bytes);
    }
}

const HASH = "abc123";
const BYTES = new Uint8Array([1, 2, 3, 4]);

describe("ShardClient — offline cache integration", () => {
    it("putShard writes the cache before the network", async () => {
        const cache = new MemCache();
        const fetchFn = vi.fn(async () => new Response(JSON.stringify({ dedup: false }), { status: 200 }));
        const client = new ShardClient({ baseUrl: "http://t", fetch: fetchFn as never, cache });
        await client.putShard(HASH, BYTES);
        expect(await cache.get(HASH)).toEqual(BYTES);
        expect(fetchFn).toHaveBeenCalledOnce();
    });

    it("putShard defers the upload when the network is down (bytes stay cached)", async () => {
        const cache = new MemCache();
        const deferred: string[] = [];
        const fetchFn = vi.fn(async () => {
            throw new TypeError("Failed to fetch");
        });
        const client = new ShardClient({
            baseUrl: "http://t",
            fetch: fetchFn as never,
            cache,
            deferUpload: async (h) => void deferred.push(h),
        });
        const res = await client.putShard(HASH, BYTES);
        expect(res.dedup).toBe(false);
        expect(deferred).toEqual([HASH]);
        expect(await cache.get(HASH)).toEqual(BYTES); // recoverable for replay
    });

    it("getShard serves a cache hit without touching the network", async () => {
        const cache = new MemCache();
        await cache.put(HASH, BYTES);
        const fetchFn = vi.fn();
        const client = new ShardClient({ baseUrl: "http://t", fetch: fetchFn as never, cache });
        expect(await client.getShard(HASH)).toEqual(BYTES);
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it("getShard populates the cache on a network hit", async () => {
        const cache = new MemCache();
        const fetchFn = vi.fn(async () => new Response(BYTES, { status: 200 }));
        const client = new ShardClient({ baseUrl: "http://t", fetch: fetchFn as never, cache });
        expect(await client.getShard(HASH)).toEqual(BYTES);
        expect(await cache.get(HASH)).toEqual(BYTES);
    });

    it("getShard treats a network failure as a missing shard (RS can recover)", async () => {
        const cache = new MemCache(); // empty
        const fetchFn = vi.fn(async () => {
            throw new TypeError("Failed to fetch");
        });
        const client = new ShardClient({ baseUrl: "http://t", fetch: fetchFn as never, cache });
        expect(await client.getShard(HASH)).toBeNull();
    });

    it("without a cache, a network failure on getShard propagates", async () => {
        const fetchFn = vi.fn(async () => {
            throw new TypeError("Failed to fetch");
        });
        const client = new ShardClient({ baseUrl: "http://t", fetch: fetchFn as never });
        await expect(client.getShard(HASH)).rejects.toBeInstanceOf(TypeError);
    });
});
