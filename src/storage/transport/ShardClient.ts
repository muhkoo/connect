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
     * Optional offline byte cache. When present, GETs are served cache-first and
     * populated on success, and PUTs write the cache before the network so a
     * just-uploaded file reads back offline. See {@link ShardByteCache}.
     */
    cache?: ShardByteCache;
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
    private readonly cache?: ShardByteCache;
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
        this.cache = opts.cache;
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
            response = await this.fetchFn(url, {
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
            throw new Error(`ShardClient.putShard(${hash}) failed (${response.status}): ${text}`);
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
        const response = await this.fetchFn(url, {
            method: "PUT",
            headers: { "content-type": "application/octet-stream" },
            body: bytes as BodyInit,
        });
        if (!response.ok) {
            const text = await safeText(response);
            throw new Error(`ShardClient.putShard(${hash}) failed (${response.status}): ${text}`);
        }
    }

    /**
     * Fetch a shard by hash. Throws if the server returns a non-200; returns
     * `null` for 404 so callers can distinguish "missing" from "errored".
     */
    async getShard(hash: string): Promise<Uint8Array | null> {
        // Cache-first: a hit is content-verified by construction (key == hash).
        if (this.cache) {
            const cached = await this.cache.get(hash);
            if (cached) return cached;
        }
        // No peers → straight to origin.
        if (!this.peers) return this.fetchFromOrigin(hash);

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
                this.fetchFromOrigin(hash).then(win, fail);
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

    /** Fetch a shard from origin. Returns `null` for 404 (or offline when a
     *  cache is present, so RS recovery can proceed); throws otherwise. */
    private async fetchFromOrigin(hash: string): Promise<Uint8Array | null> {
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
