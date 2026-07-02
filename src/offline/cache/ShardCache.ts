/**
 * `ShardCache` — a Cache-API-backed store for file-shard bytes. Shards are
 * content-addressed (the key IS the SHA-256 of the ciphertext), so caching them
 * is uniquely safe: a cache hit is self-validating, immutable, and shareable
 * across files. The Cache API (rather than IndexedDB) is the right home for
 * large binary blobs — it streams, it's purpose-built for response bodies, and
 * it has its own eviction.
 *
 * Keys are SYNTHETIC absolute URLs (`https://shard.muhkoo.local/<hash>`) rather
 * than the real shard endpoint, so the cache is addressable by hash alone — the
 * sync engine can re-PUT a deferred shard knowing only its hash, without
 * reconstructing the accelerator URL. We never fetch these synthetic URLs; they
 * exist only as cache keys.
 *
 * Every method degrades to a no-op / null where the Cache API is unavailable
 * (Node, Workers, insecure contexts), so callers don't need to branch.
 */

const CACHE_NAME = "muhkoo-shards-v1";

export class ShardCache {
    static available(): boolean {
        try {
            return typeof caches !== "undefined";
        } catch {
            return false;
        }
    }

    private key(hash: string): string {
        return `https://shard.muhkoo.local/${encodeURIComponent(hash)}`;
    }

    private open(): Promise<Cache> {
        return caches.open(CACHE_NAME);
    }

    /** Cached shard bytes, or `null` on miss / when unavailable. */
    async get(hash: string): Promise<Uint8Array | null> {
        if (!ShardCache.available()) return null;
        try {
            const cache = await this.open();
            const res = await cache.match(this.key(hash));
            if (!res) return null;
            return new Uint8Array(await res.arrayBuffer());
        } catch {
            return null;
        }
    }

    /** Store shard bytes under their hash. Best-effort. */
    async put(hash: string, bytes: Uint8Array): Promise<void> {
        if (!ShardCache.available()) return;
        try {
            const cache = await this.open();
            await cache.put(
                this.key(hash),
                new Response(bytes as BodyInit, {
                    headers: { "content-type": "application/octet-stream" },
                }),
            );
        } catch {
            /* quota / unavailable — degrade to online-only for this shard */
        }
    }

    /** Whether a shard is present in the cache. */
    async has(hash: string): Promise<boolean> {
        if (!ShardCache.available()) return false;
        try {
            const cache = await this.open();
            return Boolean(await cache.match(this.key(hash)));
        } catch {
            return false;
        }
    }
}

export default ShardCache;
