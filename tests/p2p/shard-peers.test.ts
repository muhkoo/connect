import { describe, it, expect, vi } from "vitest";
import { ShardClient, type ShardByteCache, type PeerBlockSource } from "../../src/storage/transport/ShardClient";

class MemCache implements ShardByteCache {
    map = new Map<string, Uint8Array>();
    async get(h: string) {
        return this.map.get(h) ?? null;
    }
    async put(h: string, b: Uint8Array) {
        this.map.set(h, b);
    }
}

const HASH = "abc123";
const BYTES = new Uint8Array([1, 2, 3, 4]);

describe("ShardClient — peer block source", () => {
    it("serves a cache hit without touching peers or origin", async () => {
        const cache = new MemCache();
        await cache.put(HASH, BYTES);
        const peers: PeerBlockSource = { getBlock: vi.fn(), announce: vi.fn() };
        const fetchFn = vi.fn();
        const c = new ShardClient({ baseUrl: "http://t", fetch: fetchFn as never, cache, peers });
        expect(await c.getShard(HASH)).toEqual(BYTES);
        expect(peers.getBlock).not.toHaveBeenCalled();
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it("asks peers on cache miss, before origin, and caches the result", async () => {
        const cache = new MemCache();
        const peers: PeerBlockSource = {
            getBlock: vi.fn(async () => BYTES),
            announce: vi.fn(),
        };
        const fetchFn = vi.fn();
        const c = new ShardClient({ baseUrl: "http://t", fetch: fetchFn as never, cache, peers });
        expect(await c.getShard(HASH)).toEqual(BYTES);
        expect(peers.getBlock).toHaveBeenCalledWith(HASH);
        expect(fetchFn).not.toHaveBeenCalled(); // peer hit → no origin egress
        expect(await cache.get(HASH)).toEqual(BYTES); // peer block cached
    });

    it("falls back to origin when no peer has the block", async () => {
        const cache = new MemCache();
        const peers: PeerBlockSource = { getBlock: vi.fn(async () => null), announce: vi.fn() };
        const fetchFn = vi.fn(async () => new Response(BYTES, { status: 200 }));
        const c = new ShardClient({ baseUrl: "http://t", fetch: fetchFn as never, cache, peers });
        expect(await c.getShard(HASH)).toEqual(BYTES);
        expect(peers.getBlock).toHaveBeenCalled();
        // Origin WAS reached. Two calls, not one: the first is the one-off batch
        // probe, which this fake answers with raw bytes rather than a batch
        // reply, so the client latches batching off and re-fetches singly. That
        // is the documented degradation against a server without the route.
        expect(fetchFn).toHaveBeenCalled();
        expect(fetchFn.mock.calls.some(([url]) => String(url).endsWith(HASH))).toBe(true);
    });

    it("falls back to origin when the peer layer throws", async () => {
        const peers: PeerBlockSource = {
            getBlock: vi.fn(async () => {
                throw new Error("mesh hiccup");
            }),
            announce: vi.fn(),
        };
        const fetchFn = vi.fn(async () => new Response(BYTES, { status: 200 }));
        const c = new ShardClient({ baseUrl: "http://t", fetch: fetchFn as never, peers });
        expect(await c.getShard(HASH)).toEqual(BYTES);
        expect(fetchFn.mock.calls.some(([url]) => String(url).endsWith(HASH))).toBe(true);
    });

    it("announces a newly-put block to peers", async () => {
        const cache = new MemCache();
        const peers: PeerBlockSource = { getBlock: vi.fn(), announce: vi.fn() };
        const fetchFn = vi.fn(async () => new Response(JSON.stringify({ dedup: false }), { status: 200 }));
        const c = new ShardClient({ baseUrl: "http://t", fetch: fetchFn as never, cache, peers });
        await c.putShard(HASH, BYTES);
        expect(peers.announce).toHaveBeenCalledWith(HASH);
    });
});
