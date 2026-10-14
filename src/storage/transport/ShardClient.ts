/**
 * HTTP client for the open content-addressed shard store.
 *
 * Each shard is named by the lowercase hex SHA-256 of its ciphertext bytes.
 * The server verifies the hash on PUT, so the address authenticates the
 * contents — there's no benefit to ACLing PUT/GET, and making them open
 * enables cross-user dedup down the line.
 *
 * Wire protocol:
 *   PUT  /api/shards/:hash    body: shard bytes (application/octet-stream)
 *                             200 { ok: true, hash, size, dedup: boolean }
 *                             400 if hash doesn't match body
 *
 *   GET  /api/shards/:hash    200 with shard bytes (application/octet-stream)
 *                             404 if absent
 *
 *   HEAD /api/shards/:hash    200 if present (no body) — used by callers to
 *                             skip a PUT they'd otherwise dedup-rewrite. The
 *                             server can ignore the optimization if it wants.
 */

import { toHex } from "../../utilities/bytes";
import { paymentRequiredFrom } from "../../core/PaymentRequiredError";

/**
 * How long concurrent shard reads are gathered before one batch is sent.
 *
 * Long enough to collect what a concurrent directory walk issues at the same
 * moment, short enough that a single read does not feel it.
 */
const SHARD_BATCH_WINDOW_MS = 6;

/** Hashes per batch. Must not exceed what the server will accept. */
const SHARD_BATCH_MAX = 256;

/**
 * Expected response bytes per batch, which a batch is split to stay under.
 *
 * The server refuses a batch above 24 MiB of shard bytes with a 413, and the
 * reads in a refused batch fail. Counting hashes alone, about 25 one-MiB
 * shards in one window - a few large files read at once - drew it. This
 * leaves the server's ceiling well clear.
 */
const SHARD_BATCH_BUDGET_BYTES = 16 * 1024 * 1024;

/** An entry's JSON around its base64: the quoted hash, a colon, quotes and a comma, rounded up. */
const SHARD_BATCH_ENTRY_BYTES = 128;

/**
 * What a shard adds to a batch's response: base64 is 4 bytes for every 3.
 *
 * A shard whose size the caller did not give counts as its entry alone, so
 * reads without sizes batch by count, as they always have — kept for the
 * pinned "many concurrent reads → ONE request" test
 * (`shard-batching.test.ts`). No SDK read path is size-less today:
 * `FileStorage.readChunk` always passes `shardSize`. The server reads and
 * base64-encodes every shard before it checks the total
 * (`ShardsController.ts`), so a very large size-less batch can fail with a
 * 5xx before the client ever sees a 413. The split in `sendShardBatch` is a
 * best-effort net for that case, not a guarantee.
 */
function batchCost(size: number | undefined): number {
    const bytes = typeof size === "number" && Number.isFinite(size) && size > 0 ? size : 0;
    return Math.ceil(bytes / 3) * 4 + SHARD_BATCH_ENTRY_BYTES;
}

/** One caller of `getShard`, waiting on a batch. */
type ShardWaiter = { resolve: (v: Uint8Array | null) => void; reject: (e: unknown) => void };

/** Decode base64 without `atob`'s per-character loop cost on large shards. */
function bytesFromBase64(b64: string): Uint8Array {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
}

/** Peer head-start (ms) before origin joins the race in {@link ShardClient.getShard}. */
const HEDGE_MS = 500;

/**
 * A content-addressed byte cache for shards (the offline layer's `ShardCache`
 * satisfies this structurally). Declared here as a minimal interface so the
 * storage layer doesn't import the offline module — keeping the dependency
 * arrow one-way (offline → storage).
 */
export interface ShardByteCache {
    get(hash: string): Promise<Uint8Array | null>;
    put(hash: string, bytes: Uint8Array): Promise<void>;
}

/**
 * A peer block source (the p2p layer's `PeerExchange` satisfies this
 * structurally). Consulted between the local cache and origin: a block fetched
 * from a peer is verified by hash before use. Declared here so the storage layer
 * doesn't import the p2p module (dependency arrow stays p2p → storage).
 */
export interface PeerBlockSource {
    getBlock(hash: string, opts?: { timeoutMs?: number }): Promise<Uint8Array | null>;
    announce(hash: string): void;
}

export interface ShardClientOptions {
    /** Base URL of the accelerator (e.g. `https://muhkoo-accelerator.workers.dev`). */
    baseUrl: string;
    /**
     * Path prefix for the shard endpoints, joined to `baseUrl` before the
     * hash. Defaults to `/api/shards`, which targets a global shard store
     * (e.g. a dedicated `ShardStoreDO`). Pass a room-scoped value like
     * `/api/spaces/{roomId}/shards` to keep shards bound to a specific
     * `SharedSpaceDO` — that's the path the chat application uses today.
     *
     * Leading slash optional; trailing slash stripped. The final URL is
     * always `${baseUrl}${normalizedPrefix}/${encodeURIComponent(hash)}`.
     */
    pathPrefix?: string;
    /**
     * Optional custom fetch implementation. Defaults to `globalThis.fetch`.
     * Provided so callers can inject retries / auth / instrumentation.
     */
    fetch?: typeof fetch;
    /**
     * The same fetch with the client's silent re-authentication
     * (`HttpClient.fetchWithRecovery`), used for uploads only. A paid-only
     * app refuses a PUT made with a dead session with `401 session_required`;
     * through this, the session is re-established once and the PUT sent
     * again, which is safe because its bytes can be sent twice. Reads keep
     * {@link fetch}. Defaults to {@link fetch}.
     */
    fetchWithRecovery?: typeof fetch;
    /**
     * Optional offline byte cache. When present, GETs are served cache-first and
     * populated on success, and PUTs write the cache before the network so a
     * just-uploaded file reads back offline. See {@link ShardByteCache}.
     */
    cache?: ShardByteCache;
    /**
     * Coalesce concurrent origin reads into `POST {pathPrefix}/batch`. On by
     * default: it is what keeps opening a project from costing one request per
     * shard. Set false to force one-at-a-time — useful against a server without
     * the route, though that is detected and handled automatically.
     */
    batchShards?: boolean;
    /**
     * Called when a PUT can't reach the network (offline). Lets the caller queue
     * the upload for replay on reconnect; the bytes are already in {@link cache}
     * keyed by `hash`, so only the hash needs recording.
     */
    deferUpload?: (hash: string) => Promise<void>;
    /**
     * Optional peer block source. When present, GETs try peers between the local
     * cache and origin (peer blocks are verified by hash); PUTs announce the new
     * block to peers. Best-effort — any failure falls through to origin.
     */
    peers?: PeerBlockSource;
    /**
     * When true, {@link ShardClient.putShard} returns as soon as the shard is
     * written to {@link cache} and announced to {@link peers} — the origin PUT is
     * fired in the BACKGROUND rather than awaited. This makes a large write's
     * manifest available immediately (so a peer/worker can start pulling the
     * shards over P2P right away) while origin catches up as a durable fallback.
     * On a background-PUT failure the shard is handed to {@link deferUpload} (if
     * present) for replay. Requires a {@link cache} so the bytes survive locally
     * until the background upload lands. No-op without a cache.
     */
    backgroundUpload?: boolean;
}

/**
 * Compute the lowercase hex SHA-256 of `bytes`. Available via WebCrypto in
 * every runtime this SDK targets.
 */
export async function shardHash(bytes: Uint8Array): Promise<string> {
    const subtle = (globalThis.crypto as Crypto | undefined)?.subtle;
    if (!subtle) {
        throw new Error("shardHash: `globalThis.crypto.subtle` is unavailable in this runtime.");
    }
    const digest = await subtle.digest("SHA-256", bytes as BufferSource);
    return toHex(new Uint8Array(digest));
}

export class ShardClient {
    private readonly baseUrl: string;
    private readonly pathPrefix: string;
    private readonly fetchFn: typeof fetch;
    /** What a PUT goes through: {@link ShardClientOptions.fetchWithRecovery} when given, else {@link fetchFn}. */
    private readonly putFn: typeof fetch;
    private readonly cache?: ShardByteCache;
    /** Hashes waiting for the next batch, each with everyone awaiting it and its size if a caller gave it. */
    private pendingShards!: Map<string, { size?: number; waiters: ShardWaiter[] }>;
    private batchTimer!: ReturnType<typeof setTimeout> | null;
    /** False once the server is known not to have the batch route. */
    private batchSupported!: boolean;
    private readonly deferUpload?: (hash: string) => Promise<void>;
    private readonly peers?: PeerBlockSource;
    private readonly backgroundUpload: boolean;

    constructor(opts: ShardClientOptions) {
        if (!opts?.baseUrl) throw new Error("ShardClient: `baseUrl` is required");
        // Strip trailing slash so url concatenation stays clean.
        this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
        // Normalize prefix to leading-slash + no-trailing-slash form so the
        // URL builder can blindly append `/{hash}`.
        const rawPrefix = opts.pathPrefix ?? "/api/shards";
        const withSlash = rawPrefix.startsWith("/") ? rawPrefix : `/${rawPrefix}`;
        this.pathPrefix = withSlash.replace(/\/+$/, "");
        const f = opts.fetch ?? globalThis.fetch;
        if (typeof f !== "function") {
            throw new Error("ShardClient: `globalThis.fetch` is unavailable; pass an explicit fetch.");
        }
        this.fetchFn = f.bind(globalThis);
        this.putFn = opts.fetchWithRecovery ?? this.fetchFn;
        this.cache = opts.cache;
        // Coalescing state. `batchSupported` latches false against a deployment
        // without the batch route, so we degrade once rather than per request.
        this.pendingShards = new Map();
        this.batchTimer = null;
        this.batchSupported = opts.batchShards !== false;
        this.deferUpload = opts.deferUpload;
        this.peers = opts.peers;
        // Background upload needs a local cache to hold the bytes until the PUT
        // lands; without one it would race the reader against a not-yet-uploaded
        // origin, so we quietly ignore the flag when there's no cache.
        this.backgroundUpload = Boolean(opts.backgroundUpload && opts.cache);
    }

    /** Build the URL for a given shard hash — exposed for callers that want to log or pre-resolve. */
    urlForHash(hash: string): string {
        return `${this.baseUrl}${this.pathPrefix}/${encodeURIComponent(hash)}`;
    }

    /**
     * Upload a shard. The server verifies SHA-256(body) matches `:hash` and
     * rejects with 400 if not, so the caller is the source of truth on
     * naming. Re-uploading an existing shard is idempotent — the server
     * returns `dedup: true` in that case.
     */
    async putShard(hash: string, bytes: Uint8Array): Promise<{ dedup: boolean }> {
        const url = this.urlForHash(hash);
        // Write the cache first so a just-uploaded file reads back even if the
        // network PUT then fails (offline). The bytes are content-addressed, so
        // this is safe to keep regardless of upload outcome.
        if (this.cache) await this.cache.put(hash, bytes);
        // Tell the swarm we now hold this block, so peers can pull it from us.
        if (this.peers) this.peers.announce(hash);
        // Background mode: the bytes are cached + announced, so return now and let
        // origin catch up asynchronously (a peer can already pull this block). The
        // PUT is enqueued through a bounded worker pool so a big file doesn't fire
        // hundreds of concurrent uploads at once.
        if (this.backgroundUpload) {
            this.enqueueBackgroundUpload(url, hash);
            return { dedup: false };
        }
        let response: Response;
        try {
            response = await this.putFn(url, {
                method: "PUT",
                headers: { "content-type": "application/octet-stream" },
                // BufferSource is what fetch's body expects; a Uint8Array satisfies it.
                body: bytes as BodyInit,
            });
        } catch (err) {
            // Network unreachable (offline). If a defer hook is wired, queue the
            // upload for replay and report success — the bytes are cached.
            if (this.deferUpload) {
                await this.deferUpload(hash);
                return { dedup: false };
            }
            throw err;
        }
        if (!response.ok) {
            const text = await safeText(response);
            // Refused for payment: its own class, which the offline queue keeps
            // and an app can tell from any other failure.
            throw paymentRequiredFrom(response.status, text)
                ?? new Error(`ShardClient.putShard(${hash}) failed (${response.status}): ${text}`);
        }
        let dedup = false;
        try {
            const json = (await response.json()) as { dedup?: boolean };
            dedup = Boolean(json?.dedup);
        } catch {
            // Server returned 200 with no body — treat as fresh upload.
        }
        return { dedup };
    }

    // ── bounded background-upload pool (backgroundUpload mode) ──
    private bgActive = 0;
    private readonly bgQueue: Array<() => void> = [];
    private static readonly BG_CONCURRENCY = 6;

    /** Queue a shard's origin PUT to run in the background under a concurrency
     *  cap. Bytes are re-read from {@link cache} at upload time (not held in the
     *  queue) so a large file's backlog doesn't pin a second copy in memory. */
    private enqueueBackgroundUpload(url: string, hash: string): void {
        const run = async () => {
            this.bgActive++;
            try {
                const bytes = this.cache ? await this.cache.get(hash) : null;
                if (bytes) await this.uploadToOrigin(url, hash, bytes);
            } catch {
                // Origin unreachable/failed — queue for replay if we can; otherwise
                // the block is still cached + peer-served, so a later re-PUT covers it.
                if (this.deferUpload) { try { await this.deferUpload(hash); } catch { /* best-effort */ } }
            } finally {
                this.bgActive--;
                const next = this.bgQueue.shift();
                if (next) next();
            }
        };
        if (this.bgActive < ShardClient.BG_CONCURRENCY) void run();
        else this.bgQueue.push(() => void run());
    }

    /** PUT the shard bytes to origin, verifying the server accepted them.
     *  Used by the background-upload path; throws on network/HTTP failure. */
    private async uploadToOrigin(url: string, hash: string, bytes: Uint8Array): Promise<void> {
        const response = await this.putFn(url, {
            method: "PUT",
            headers: { "content-type": "application/octet-stream" },
            body: bytes as BodyInit,
        });
        if (!response.ok) {
            const text = await safeText(response);
            throw paymentRequiredFrom(response.status, text)
                ?? new Error(`ShardClient.putShard(${hash}) failed (${response.status}): ${text}`);
        }
    }

    /**
     * Fetch a shard by hash. Throws if the server returns a non-200; returns
     * `null` for 404 so callers can distinguish "missing" from "errored".
     *
     * `size`, the shard's byte length when known (a manifest's `shardSize`),
     * lets concurrent reads be batched within what the server will send.
     */
    async getShard(hash: string, opts: { size?: number } = {}): Promise<Uint8Array | null> {
        // Cache-first: a hit is content-verified by construction (key == hash).
        if (this.cache) {
            const cached = await this.cache.get(hash);
            if (cached) return cached;
        }
        // No peers → straight to origin.
        if (!this.peers) return this.fetchFromOrigin(hash, opts.size);

        // HEDGED RACE: prefer a peer (saves origin egress) but never let a slow
        // or missing peer stall delivery — give the peer a short head start, then
        // start origin in parallel and take whichever returns the block first.
        const peers = this.peers;
        return new Promise<Uint8Array | null>((resolve, reject) => {
            let done = false;
            let originStarted = false;
            let timer: ReturnType<typeof setTimeout> | null = null;
            const win = (b: Uint8Array | null) => {
                if (done) return;
                done = true;
                if (timer) clearTimeout(timer);
                resolve(b);
            };
            const fail = (e: unknown) => {
                if (!done) { done = true; reject(e); }
            };
            const startOrigin = () => {
                if (originStarted || done) return;
                originStarted = true;
                if (timer) { clearTimeout(timer); timer = null; }
                this.fetchFromOrigin(hash, opts.size).then(win, fail);
            };
            timer = setTimeout(startOrigin, HEDGE_MS);
            peers.getBlock(hash).then(
                (b) => {
                    if (b) {
                        if (this.cache) void this.cache.put(hash, b);
                        win(b); // peer delivered first
                    } else {
                        startOrigin(); // peer miss → don't wait out the hedge
                    }
                },
                () => startOrigin(), // peer error → origin now
            );
        });
    }

    /**
     * Fetch from origin, COALESCING concurrent requests into one batch.
     *
     * A shard is not a file. A project is thousands of small source modules,
     * each split into shards, so reading one at a time made opening a project
     * cost thousands of requests — 2,086 for a 519-file project. Latency, not
     * bytes, is what that spends: Chromium took 18.4s over those requests and
     * Brave, which filters every one, took 37.5s for identical work. Batching
     * collapses whatever is in flight at the same moment into a single POST,
     * which is why it helps most exactly where it hurt most.
     *
     * Callers are unchanged: `getShard` still asks for one shard and gets one
     * shard. The window is a few milliseconds — long enough to gather the reads
     * a concurrent walk issues together, short enough not to be felt by a lone
     * read.
     *
     * Falls back permanently to one-at-a-time if the server has no batch route,
     * so a new SDK keeps working against an older deployment.
     */
    private fetchFromOrigin(hash: string, size?: number): Promise<Uint8Array | null> {
        if (!this.batchSupported) return this.fetchOneFromOrigin(hash);
        return new Promise<Uint8Array | null>((resolve, reject) => {
            const pending = this.pendingShards.get(hash);
            if (pending) {
                pending.waiters.push({ resolve, reject });
                pending.size ??= size;
                return;
            }
            this.pendingShards.set(hash, { size, waiters: [{ resolve, reject }] });
            if (this.batchTimer === null) {
                this.batchTimer = setTimeout(() => { void this.flushShardBatch(); }, SHARD_BATCH_WINDOW_MS);
            }
        });
    }

    /** Send one batch of whatever has accumulated, and settle those callers. */
    private async flushShardBatch(): Promise<void> {
        this.batchTimer = null;
        if (this.pendingShards.size === 0) return;

        // As many as fit: at most SHARD_BATCH_MAX hashes, and a response
        // expected to stay within SHARD_BATCH_BUDGET_BYTES. One that does not
        // fit is skipped for a smaller one behind it. The first always goes,
        // so a shard over the budget by itself is fetched alone.
        const waiters: Array<readonly [string, ShardWaiter[]]> = [];
        let cost = 0;
        for (const [h, pending] of this.pendingShards) {
            if (waiters.length === SHARD_BATCH_MAX) break;
            const next = batchCost(pending.size);
            if (waiters.length > 0 && cost + next > SHARD_BATCH_BUDGET_BYTES) continue;
            waiters.push([h, pending.waiters]);
            cost += next;
        }
        for (const [h] of waiters) this.pendingShards.delete(h);
        // Anything over the cap or the budget waits for the next window
        // rather than being dropped or silently truncated.
        if (this.pendingShards.size > 0 && this.batchTimer === null) {
            this.batchTimer = setTimeout(() => { void this.flushShardBatch(); }, SHARD_BATCH_WINDOW_MS);
        }
        await this.sendShardBatch(waiters);
    }

    /** POST one batch and settle everyone waiting on it. Never throws. */
    private async sendShardBatch(waiters: ReadonlyArray<readonly [string, ShardWaiter[]]>): Promise<void> {
        const hashes = waiters.map(([h]) => h);
        let shards: Record<string, string>;
        try {
            const res = await this.fetchFn(`${this.baseUrl}${this.pathPrefix}/batch`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ hashes }),
            });
            if (res.status === 413 && waiters.length > 1) {
                // Too large for the server after all: a size was not given,
                // or was wrong. Ask for each half on its own. Halving reaches
                // one hash per batch within log2(n) levels, and one hash the
                // server refuses is an error like any other, below.
                // Release the body first: under undici (the CLI, Node), an
                // unread body holds the connection until garbage collection.
                await res.body?.cancel().catch(() => {});
                const half = Math.ceil(waiters.length / 2);
                await Promise.all([
                    this.sendShardBatch(waiters.slice(0, half)),
                    this.sendShardBatch(waiters.slice(half)),
                ]);
                return;
            }
            if (res.status === 404 || res.status === 405) {
                // No batch route on this deployment. Stop trying, and serve
                // everyone individually — including the batch we just gathered.
                this.batchSupported = false;
                for (const [h, ws] of waiters) {
                    this.fetchOneFromOrigin(h).then(
                        (b) => ws.forEach((w) => w.resolve(b)),
                        (e) => ws.forEach((w) => w.reject(e)),
                    );
                }
                return;
            }
            if (!res.ok) throw new Error(`ShardClient batch failed (${res.status}): ${await safeText(res)}`);
            const parsed: unknown = await res.json().catch(() => null);
            // A 200 is not proof the batch route exists. A catch-all handler, a
            // proxy, or an older deployment can answer this POST with something
            // else entirely, and trusting the shape would resolve every hash to
            // `null` — reads silently returning "missing" for shards that are
            // right there. Anything not shaped like a batch reply is treated as
            // "no batch route", exactly like a 404.
            const candidate = (parsed as { shards?: unknown } | null)?.shards;
            if (!candidate || typeof candidate !== "object") {
                this.batchSupported = false;
                for (const [h, ws] of waiters) {
                    this.fetchOneFromOrigin(h).then(
                        (b) => ws.forEach((w) => w.resolve(b)),
                        (e) => ws.forEach((w) => w.reject(e)),
                    );
                }
                return;
            }
            shards = candidate as Record<string, string>;
        } catch (err) {
            // Offline with a cache behaves as it does for a single fetch: report
            // absence so Reed-Solomon recovery can still be attempted.
            for (const [, ws] of waiters) {
                if (this.cache) ws.forEach((w) => w.resolve(null));
                else ws.forEach((w) => w.reject(err));
            }
            return;
        }

        for (const [hash, ws] of waiters) {
            const b64 = shards[hash];
            if (typeof b64 !== "string") { ws.forEach((w) => w.resolve(null)); continue; }
            let bytes: Uint8Array;
            try { bytes = bytesFromBase64(b64); }
            catch (e) { ws.forEach((w) => w.reject(e)); continue; }
            if (this.cache) void this.cache.put(hash, bytes);
            ws.forEach((w) => w.resolve(bytes));
        }
    }

    /** Fetch a shard from origin. Returns `null` for 404 (or offline when a
     *  cache is present, so RS recovery can proceed); throws otherwise. */
    private async fetchOneFromOrigin(hash: string): Promise<Uint8Array | null> {
        const url = this.urlForHash(hash);
        let response: Response;
        try {
            response = await this.fetchFn(url, { method: "GET" });
        } catch (err) {
            if (this.cache) return null;
            throw err;
        }
        if (response.status === 404) return null;
        if (!response.ok) {
            const text = await safeText(response);
            throw new Error(`ShardClient.getShard(${hash}) failed (${response.status}): ${text}`);
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (this.cache) void this.cache.put(hash, bytes);
        return bytes;
    }

    /**
     * Check whether a shard exists. Lets the caller skip a PUT they'd otherwise
     * dedup-rewrite. The server can implement this as a HEAD or return a small
     * JSON body — we don't depend on either.
     */
    async hasShard(hash: string): Promise<boolean> {
        const url = this.urlForHash(hash);
        const response = await this.fetchFn(url, { method: "HEAD" });
        return response.status === 200;
    }
}

async function safeText(response: Response): Promise<string> {
    try { return await response.text(); } catch { return ""; }
}
