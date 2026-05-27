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
        const response = await this.fetchFn(url, {
            method: "PUT",
            headers: { "content-type": "application/octet-stream" },
            // BufferSource is what fetch's body expects; a Uint8Array satisfies it.
            body: bytes as BodyInit,
        });
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

    /**
     * Fetch a shard by hash. Throws if the server returns a non-200; returns
     * `null` for 404 so callers can distinguish "missing" from "errored".
     */
    async getShard(hash: string): Promise<Uint8Array | null> {
        const url = this.urlForHash(hash);
        const response = await this.fetchFn(url, { method: "GET" });
        if (response.status === 404) return null;
        if (!response.ok) {
            const text = await safeText(response);
            throw new Error(`ShardClient.getShard(${hash}) failed (${response.status}): ${text}`);
        }
        const buf = await response.arrayBuffer();
        return new Uint8Array(buf);
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
