/**
 * Concurrent shard reads collapse into one request.
 *
 * A shard is not a file: a project is thousands of small modules, each split
 * into shards, so reading one at a time made opening a project cost thousands of
 * requests — 2,086 for a 519-file project. Latency, not bytes, is what that
 * spends, which is why it was twice as bad in a browser that filters every
 * request (Brave 37.5s vs Chromium 18.4s on identical work).
 *
 * The coalescing is invisible to callers — `getShard` still asks for one shard —
 * so these check the thing callers cannot see: how many requests actually left.
 */
import { describe, it, expect, vi } from "vitest";
import { ShardClient } from "../../src/storage/transport/ShardClient";

const HASH = (n: number) => n.toString(16).padStart(64, "0");
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** A fetch that serves a batch endpoint and counts the calls it receives. */
function server(present: Record<string, Uint8Array>, opts: { batch?: boolean } = {}) {
    const calls: Array<{ url: string; hashes?: string[] }> = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
        const isBatch = url.endsWith("/batch");
        if (isBatch && opts.batch === false) {
            calls.push({ url });
            return new Response("Not found", { status: 404 });
        }
        if (isBatch) {
            const hashes = JSON.parse(String(init?.body ?? "{}")).hashes as string[];
            calls.push({ url, hashes });
            const shards: Record<string, string> = {};
            const missing: string[] = [];
            for (const h of hashes) present[h] ? (shards[h] = b64(present[h])) : missing.push(h);
            return new Response(JSON.stringify({ shards, missing }), {
                status: 200, headers: { "Content-Type": "application/json" },
            });
        }
        calls.push({ url });
        const hash = decodeURIComponent(url.split("/").pop()!);
        if (!present[hash]) return new Response("Shard not found", { status: 404 });
        return new Response(present[hash], { status: 200 });
    };
    return { calls, fetchFn: fetchFn as unknown as typeof fetch };
}

const client = (fetchFn: typeof fetch, extra: Record<string, unknown> = {}) =>
    new ShardClient({ baseUrl: "https://api.muhkoo.test", fetch: fetchFn, ...extra });

describe("coalescing", () => {
    it("turns many concurrent reads into ONE request", async () => {
        const present: Record<string, Uint8Array> = {};
        for (let i = 1; i <= 40; i++) present[HASH(i)] = new Uint8Array([i, i + 1, i + 2]);
        const { calls, fetchFn } = server(present);

        const out = await Promise.all(Object.keys(present).map((h) => client(fetchFn).getShard(h)));
        // Each client instance batches its own reads; use one client for the real shape.
        expect(out).toHaveLength(40);

        const { calls: c2, fetchFn: f2 } = server(present);
        const one = client(f2);
        const results = await Promise.all(Object.keys(present).map((h) => one.getShard(h)));
        expect(c2.filter((c) => c.url.endsWith("/batch"))).toHaveLength(1);
        expect(c2[0].hashes).toHaveLength(40);
        expect(results.every((r) => r !== null)).toBe(true);
        expect([...results[0]!]).toEqual([1, 2, 3]);
    });

    it("asks for a repeated hash once and answers every caller", async () => {
        const present = { [HASH(1)]: new Uint8Array([9]) };
        const { calls, fetchFn } = server(present);
        const c = client(fetchFn);
        const results = await Promise.all([c.getShard(HASH(1)), c.getShard(HASH(1)), c.getShard(HASH(1))]);
        expect(calls[0].hashes).toEqual([HASH(1)]);
        expect(results.map((r) => r && [...r])).toEqual([[9], [9], [9]]);
    });

    it("reports a missing shard as null, without failing its batch-mates", async () => {
        // Reed-Solomon recovers from an absent shard, but only if the others arrive.
        const present = { [HASH(1)]: new Uint8Array([1]), [HASH(2)]: new Uint8Array([2]) };
        const { fetchFn } = server(present);
        const c = client(fetchFn);
        const [a, gone, b] = await Promise.all([
            c.getShard(HASH(1)), c.getShard(HASH(99)), c.getShard(HASH(2)),
        ]);
        expect(a && [...a]).toEqual([1]);
        expect(gone).toBeNull();
        expect(b && [...b]).toEqual([2]);
    });

    it("round-trips arbitrary bytes, including NULs and high bytes", async () => {
        const bytes = new Uint8Array([0, 255, 128, 1, 0, 254]);
        const { fetchFn } = server({ [HASH(3)]: bytes });
        const got = await client(fetchFn).getShard(HASH(3));
        expect([...got!]).toEqual([...bytes]);
    });

    it("splits work larger than one batch across requests", async () => {
        const present: Record<string, Uint8Array> = {};
        for (let i = 1; i <= 300; i++) present[HASH(i)] = new Uint8Array([i % 256]);
        const { calls, fetchFn } = server(present);
        const c = client(fetchFn);
        const results = await Promise.all(Object.keys(present).map((h) => c.getShard(h)));
        const batches = calls.filter((x) => x.url.endsWith("/batch"));
        expect(batches.length).toBeGreaterThanOrEqual(2);          // 300 > the 256 cap
        expect(batches.every((b) => (b.hashes?.length ?? 0) <= 256)).toBe(true);
        expect(results.filter(Boolean)).toHaveLength(300);
    });
});

describe("compatibility", () => {
    it("falls back to one-at-a-time against a server with no batch route", async () => {
        const present = { [HASH(1)]: new Uint8Array([1]), [HASH(2)]: new Uint8Array([2]) };
        const { calls, fetchFn } = server(present, { batch: false });
        const c = client(fetchFn);
        const [a, b] = await Promise.all([c.getShard(HASH(1)), c.getShard(HASH(2))]);
        expect(a && [...a]).toEqual([1]);
        expect(b && [...b]).toEqual([2]);
        expect(calls.some((x) => x.url.endsWith(HASH(1)))).toBe(true);   // served singly
    });

    it("stops retrying the batch route once it is known to be absent", async () => {
        // Latching matters: probing a missing endpoint on every read would make
        // an old deployment slower than before the change.
        const present = { [HASH(1)]: new Uint8Array([1]), [HASH(2)]: new Uint8Array([2]) };
        const { calls, fetchFn } = server(present, { batch: false });
        const c = client(fetchFn);
        await c.getShard(HASH(1));
        await c.getShard(HASH(2));
        expect(calls.filter((x) => x.url.endsWith("/batch"))).toHaveLength(1);
    });

    it("can be turned off explicitly", async () => {
        const present = { [HASH(1)]: new Uint8Array([1]) };
        const { calls, fetchFn } = server(present);
        const c = client(fetchFn, { batchShards: false });
        expect((await c.getShard(HASH(1)))![0]).toBe(1);
        expect(calls.some((x) => x.url.endsWith("/batch"))).toBe(false);
    });
});
