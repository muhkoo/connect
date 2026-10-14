/**
 * A batch of shard reads stays small enough for the server to send.
 *
 * Reads gathered in one window go out as one `POST /batch`, and the server
 * refuses a batch above 24 MiB of shard bytes with a 413. Capped by count
 * alone, about 25 one-MiB shards in one window - a few large files read at
 * once - drew that 413, and every read in the batch failed with it: "chunk ...
 * unrecoverable" once a cache turns errors into missing shards.
 *
 * The fake server here applies the same ceiling as the real one, on raw bytes,
 * and reports what each batch's response weighed on the wire.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { ShardClient } from "../../src/storage/transport/ShardClient";
import { FileStorage } from "../../src/storage/FileStorage";
import { _resetRsWasmForTests } from "../../src/storage/encoding/ReedSolomon/wasm/rs";
import type { FileManifest } from "../../src/storage/types";

const MiB = 1024 * 1024;
/** What the client keeps a batch's response under, base64 and JSON included. */
const BUDGET = 16 * MiB;
/** The server's ceiling: raw shard bytes in one batch. */
const SERVER_MAX_BATCH_BYTES = 24 * MiB;

const HASH = (n: number) => n.toString(16).padStart(64, "0");

type Batch = { hashes: string[]; status: number; responseBytes: number };

/**
 * A shard store with the batch route. `refuse` decides a 413, by default the
 * server's own rule. PUTs are stored, so FileStorage can write through it.
 */
function server(
    present: Map<string, Uint8Array>,
    opts: { refuse?: (rawBytes: number, hashes: string[]) => boolean } = {},
) {
    const refuse = opts.refuse ?? ((rawBytes: number) => rawBytes > SERVER_MAX_BATCH_BYTES);
    const batches: Batch[] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
        if (url.endsWith("/batch")) {
            const hashes = JSON.parse(String(init?.body)).hashes as string[];
            const shards: Record<string, string> = {};
            const missing: string[] = [];
            let rawBytes = 0;
            for (const hash of new Set(hashes)) {
                const bytes = present.get(hash);
                if (!bytes) { missing.push(hash); continue; }
                rawBytes += bytes.length;
                shards[hash] = Buffer.from(bytes).toString("base64");
            }
            if (refuse(rawBytes, hashes)) {
                batches.push({ hashes, status: 413, responseBytes: 0 });
                return new Response(`Batch too large (${rawBytes} bytes); request fewer hashes`, { status: 413 });
            }
            const body = JSON.stringify({ shards, missing });
            batches.push({ hashes, status: 200, responseBytes: body.length });
            return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
        }
        const hash = decodeURIComponent(url.split("/").pop()!);
        if (init?.method === "PUT") {
            present.set(hash, new Uint8Array(init.body as Uint8Array));
            return new Response(JSON.stringify({ ok: true, hash, dedup: false }), { status: 200 });
        }
        const bytes = present.get(hash);
        return bytes ? new Response(bytes as BodyInit, { status: 200 }) : new Response("Shard not found", { status: 404 });
    };
    return { batches, fetchFn: fetchFn as unknown as typeof fetch };
}

const client = (fetchFn: typeof fetch) => new ShardClient({ baseUrl: "https://api.muhkoo.test", fetch: fetchFn });

/** `count` shards of `size` bytes, each filled with its own number. */
function shards(count: number, size: number, from = 1): Map<string, Uint8Array> {
    const out = new Map<string, Uint8Array>();
    for (let i = from; i < from + count; i++) out.set(HASH(i), new Uint8Array(size).fill(i % 256));
    return out;
}

describe("shard batches — a response the server will send", () => {
    it("splits thirty one-MiB shards read at once into batches that each stay within the budget", async () => {
        const present = shards(30, MiB);
        const { batches, fetchFn } = server(present);
        const c = client(fetchFn);

        const got = await Promise.all([...present.keys()].map((hash) => c.getShard(hash, { size: MiB })));

        expect(got.every((bytes, i) => bytes?.length === MiB && bytes[0] === i + 1)).toBe(true);
        expect(batches.map((batch) => batch.status)).toEqual([200, 200, 200]);   // 11 + 11 + 8
        for (const batch of batches) expect(batch.responseBytes).toBeLessThanOrEqual(BUDGET);
        expect(batches.flatMap((batch) => batch.hashes).sort()).toEqual([...present.keys()].sort());
    });

    it("fetches a shard too large for the budget in a batch of its own", async () => {
        const present = shards(3, 1024);
        const big = HASH(99);
        present.set(big, new Uint8Array(13 * MiB).fill(99));   // 17.3 MiB as base64
        const { batches, fetchFn } = server(present);
        const c = client(fetchFn);
        const [first, second, third] = [...present.keys()];

        const got = await Promise.all([
            c.getShard(first, { size: 1024 }),
            c.getShard(big, { size: 13 * MiB }),
            c.getShard(second, { size: 1024 }),
            c.getShard(third, { size: 1024 }),
        ]);

        expect(got.map((bytes) => bytes?.length)).toEqual([1024, 13 * MiB, 1024, 1024]);
        expect(batches.map((batch) => batch.hashes)).toEqual([[first, second, third], [big]]);
    });

    it("still sends small reads together, in one request", async () => {
        const present = shards(200, 4096);
        const { batches, fetchFn } = server(present);
        const c = client(fetchFn);

        const got = await Promise.all([...present.keys()].map((hash) => c.getShard(hash, { size: 4096 })));

        expect(got.every((bytes) => bytes?.length === 4096)).toBe(true);
        expect(batches).toHaveLength(1);
        expect(batches[0].hashes).toHaveLength(200);
    });
});

describe("shard batches — a batch the server refuses as too large", () => {
    it("splits it in half and asks again, so the read still succeeds", async () => {
        // No size given, so the client cannot know the batch is too large
        // until the server says so.
        const present = shards(30, MiB);
        const { batches, fetchFn } = server(present);
        const c = client(fetchFn);

        const got = await Promise.all([...present.keys()].map((hash) => c.getShard(hash)));

        expect(got.every((bytes, i) => bytes?.length === MiB && bytes[0] === i + 1)).toBe(true);
        expect(batches.map((batch) => [batch.hashes.length, batch.status])).toEqual([[30, 413], [15, 200], [15, 200]]);
    });

    it("splits no further than one hash per batch: log2(n) levels at most", async () => {
        const present = shards(8, 16);
        const { batches, fetchFn } = server(present, { refuse: (_raw, hashes) => hashes.length > 1 });
        const c = client(fetchFn);

        const got = await Promise.all([...present.keys()].map((hash) => c.getShard(hash)));

        expect(got.every((bytes) => bytes?.length === 16)).toBe(true);
        // 8, then 4 + 4, then four 2s, then eight 1s: three levels of splitting.
        expect(batches.map((batch) => batch.hashes.length).sort((a, b) => b - a))
            .toEqual([8, 4, 4, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1]);
    });

    it("reports a single shard the server refuses as an error, without asking again", async () => {
        const present = shards(1, 16);
        const { batches, fetchFn } = server(present, { refuse: () => true });
        const c = client(fetchFn);

        await expect(c.getShard(HASH(1))).rejects.toThrow("413");
        expect(batches).toHaveLength(1);
    });

    it("cancels the 413 response body before sending the split requests", async () => {
        // Under undici (the CLI, Node), an unread response body holds the
        // connection until garbage collection — the 413 must be released
        // before the halves go out, not left for the caller to read.
        const present = shards(2, 16);
        const order: string[] = [];
        let calls = 0;
        const fetchFn = (async (_url: string, init?: RequestInit) => {
            calls++;
            if (calls === 1) {
                // The oversized batch, refused — a fake Response whose body.cancel
                // records the call instead of a real server round-trip.
                return {
                    status: 413,
                    ok: false,
                    body: { cancel: async () => { order.push("cancel"); } },
                    text: async () => "Batch too large",
                } as unknown as Response;
            }
            // A split request, parsed the same way the fake server does.
            order.push("fetch");
            const hashes = JSON.parse(String(init?.body)).hashes as string[];
            const shardsOut: Record<string, string> = {};
            for (const hash of hashes) shardsOut[hash] = Buffer.from(present.get(hash)!).toString("base64");
            const body = JSON.stringify({ shards: shardsOut, missing: [] });
            return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
        }) as unknown as typeof fetch;
        const c = client(fetchFn);

        const got = await Promise.all([...present.keys()].map((hash) => c.getShard(hash)));

        expect(got.every((bytes) => bytes?.length === 16)).toBe(true);
        expect(order[0]).toBe("cancel");
        expect(order.filter((e) => e === "fetch")).toHaveLength(2);
    });
});

describe("shard batches — files read through FileStorage", () => {
    let rsWasmModule: WebAssembly.Module;
    beforeAll(async () => {
        const wasmPath = join(
            __dirname, "..", "..", "src", "storage", "encoding", "ReedSolomon", "wasm", "wasm_reed_solomon_erasure_bg.wasm",
        );
        rsWasmModule = await WebAssembly.compile(readFileSync(wasmPath));
        _resetRsWasmForTests();
    });

    it("reads several large files at once", async () => {
        // A 4 MiB chunk is four one-MiB data shards, so seven such files read
        // together ask for 28 MiB in one window.
        const present = new Map<string, Uint8Array>();
        const { batches, fetchFn } = server(present);
        const storage = new FileStorage({ shards: client(fetchFn), rsWasmModule });
        const files = Array.from({ length: 7 }, (_, i) => new Uint8Array(4 * MiB).fill(i + 1));
        const manifests: FileManifest[] = [];
        for (const [i, data] of files.entries()) {
            manifests.push((await storage.writeFileToShards({ data, metadata: { name: `f${i}`, type: "application/octet-stream" } })).manifest);
        }

        const read = await Promise.all(manifests.map((manifest) => storage.readFileFromShards(manifest)));

        for (const [i, { data }] of read.entries()) {
            expect(data.length).toBe(4 * MiB);
            expect(data.every((byte) => byte === i + 1)).toBe(true);
        }
        expect(batches.every((batch) => batch.status === 200)).toBe(true);
        for (const batch of batches) expect(batch.responseBytes).toBeLessThanOrEqual(BUDGET);
    });
});
