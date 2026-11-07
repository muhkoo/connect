/**
 * An in-memory accelerator for share tests. It applies the server's rules as built (accelerator
 * `durable-objects/space/files.ts` + `share.ts` + the platform routes), not an idealised version:
 *
 * - Identity: `X-Muhkoo-Session: <username>` is the signed-in user (every caller has an account).
 * - Access: the owner and `members` reach `/files` and the Space shards; anyone else 403.
 * - `canChangeFile`: no recorded uploader, or the caller is the uploader, or the share owner, or (private +
 *   `editPolicy: "any"` + member).
 * - Uploader (`fowner:`) is stamped on a file id's first write and never re-stamped.
 * - `share_full`: a write that grows the share past `limitBytes` is refused 402 `{ code, limitBytes,
 *   usedBytes }` (no `refused`). Shard PUTs check `used + shard bytes`; `/files` POST checks
 *   `used - previous size + new size` (the server grounds the charge to the manifest size).
 * - `share_closed`: POST/DELETE on `/files` and shard PUTs → 409 `{ error, code, successor }`.
 * - `GET /api/spaces/:id/share` is 404 from the public router (platform-only); `GET /api/shares/:id` needs a
 *   session and returns `ShareInfo` (`members` by username, `names` for display).
 */

import { shardHash } from "../../src/storage/transport/ShardClient";
import type { ShareInfo } from "../../src/shares";

/**
 * The accelerator's share-id rule (`isValidShareSpaceId`), written out here rather than imported from the SDK, so
 * an SDK rule that drifts from the server's fails these tests instead of agreeing with itself.
 */
export const SERVER_SHARE_SPACE_ID = /^[A-Za-z0-9_-]{1,300}$/;

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * A Space id the length the SDK really makes them: 256 base64url characters (a P-384 public key JWK). Short fixture
 * ids once hid a 128-character cap that refused every real share, so share tests use these. `label` leads the id,
 * so ids sort and read as their labels do; the rest is a deterministic filler.
 */
export function realSpaceId(label: string): string {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(label)) throw new Error(`realSpaceId: bad label ${JSON.stringify(label)}`);
    let h = 0x811c9dc5;
    for (const c of label) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
    let id = `${label}_`;
    while (id.length < 256) {
        h = Math.imul(h ^ id.length, 0x01000193) >>> 0;
        id += B64URL[h & 63];
    }
    return id;
}

interface StoredFile {
    manifest: { id: string; size: number; [k: string]: unknown };
    owner: string | null;
}

export interface FakeShareOptions {
    spaceId: string;
    kind: "public" | "private";
    ownerUsername: string;
    name?: string;
    limitBytes?: number | null;
    editPolicy?: "own" | "any";
    members?: string[];
}

export interface FakeCall {
    method: string;
    path: string;
    headers: Headers;
}

export class FakeShareServer {
    readonly base = "http://fake.test";
    readonly spaceId: string;
    kind: "public" | "private";
    ownerUsername: string;
    name: string;
    limitBytes: number | null;
    editPolicy: "own" | "any";
    members: string[];
    /** `ShareInfo.names`: display names of uploaders and admitted members, by username. */
    names: Record<string, string> = {};
    closed: { successor: string; at: number } | null = null;
    usedBytes = 0;
    readonly files = new Map<string, StoredFile>();
    readonly shards = new Map<string, Uint8Array>();
    readonly calls: FakeCall[] = [];
    /** When it returns true for a request, that request fails as a network error (nothing reaches the "server"). */
    failWhen: ((method: string, path: string) => boolean) | null = null;

    constructor(opts: FakeShareOptions) {
        // The server makes no share at an id its share routes refuse.
        if (!SERVER_SHARE_SPACE_ID.test(opts.spaceId)) throw new Error(`FakeShareServer: the server refuses share id ${opts.spaceId}`);
        this.spaceId = opts.spaceId;
        this.kind = opts.kind;
        this.ownerUsername = opts.ownerUsername;
        this.name = opts.name ?? "Share";
        this.limitBytes = opts.limitBytes ?? null;
        this.editPolicy = opts.editPolicy ?? "own";
        this.members = opts.members ?? [];
    }

    /** Store a file directly (e.g. a legacy file with no uploader). */
    seed(manifest: StoredFile["manifest"], owner: string | null): void {
        this.files.set(manifest.id, { manifest, owner });
        this.usedBytes += manifest.size;
    }

    info(): ShareInfo {
        return {
            kind: this.kind,
            ownerUsername: this.ownerUsername,
            limitBytes: this.limitBytes,
            usedBytes: this.usedBytes,
            editPolicy: this.editPolicy,
            name: this.name,
            closed: this.closed,
            members: [...this.members],
            names: { ...this.names },
        };
    }

    readonly fetch: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        const headers = new Headers(init?.headers);
        this.calls.push({ method, path: url.pathname, headers });
        if (this.failWhen?.(method, url.pathname)) throw new TypeError("fetch failed");
        const body = init?.body;
        return this.route(method, url.pathname, headers, body);
    };

    private async route(method: string, path: string, headers: Headers, body: unknown): Promise<Response> {
        const session = headers.get("X-Muhkoo-Session");

        const sharesInfo = path.match(/^\/api\/shares\/([^/]+)$/);
        if (sharesInfo) {
            if (!session) return json({ error: "Session required", code: "session_required" }, 401);
            if (sharesInfo[1] !== this.spaceId) return json({ error: "Not found" }, 404);
            if (!this.belongs(session)) return json({ error: "Not a member of this share" }, 403);
            return json(this.info(), 200);
        }

        const m = path.match(/^\/api\/spaces\/([^/]+)\/(.*)$/);
        if (!m) return json({ error: "Not found" }, 404);
        const [, spaceId, sub] = m;
        if (sub === "share" || sub.startsWith("share/")) return json({ error: "Not found" }, 404);
        if (spaceId !== this.spaceId) return json({ error: "Not found" }, 404);

        const caller = session;
        if (!caller) return json({ error: "Authentication required" }, 401);
        if (!this.belongs(caller)) return json({ error: "Not a member of this share" }, 403);

        const shard = sub.match(/^shards\/([0-9a-f]{64})$/);
        if (shard) {
            const hash = shard[1];
            if (method === "GET") {
                const bytes = this.shards.get(hash);
                return bytes ? new Response(bytes as BodyInit, { status: 200 }) : new Response("Shard not found", { status: 404 });
            }
            if (method !== "PUT") return new Response("Method not allowed", { status: 405 });
            if (this.closed) return json(this.closedBody(), 409);
            const bytes = new Uint8Array(body as Uint8Array);
            const full = this.full(this.usedBytes, this.usedBytes + bytes.byteLength);
            if (full) return full;
            if ((await shardHash(bytes)) !== hash) return json({ error: "Hash mismatch" }, 400);
            const dedup = this.shards.has(hash);
            this.shards.set(hash, bytes);
            return json({ ok: true, hash, size: bytes.byteLength, dedup }, 200);
        }

        if (sub === "files" || sub.startsWith("files/")) {
            if (this.closed && (method === "POST" || method === "DELETE")) return json(this.closedBody(), 409);
            const fileId = decodeURIComponent(sub.slice("files".length).replace(/^\//, ""));
            if (!fileId) {
                if (method === "GET") {
                    const files = [...this.files.values()].map(({ manifest, owner }) => ({
                        id: manifest.id,
                        name: manifest.name,
                        size: manifest.size,
                        type: manifest.type,
                        path: manifest.path,
                        lastModified: manifest.lastModified,
                        createdAt: manifest.createdAt,
                        chunkCount: 0,
                        shardCount: 0,
                        owner,
                    }));
                    return json({ files }, 200);
                }
                if (method === "POST") {
                    const manifest = (JSON.parse(String(body)) as { manifest: StoredFile["manifest"] }).manifest;
                    const prev = this.files.get(manifest.id);
                    if (prev && !this.mayChange(prev.owner, caller)) {
                        return json({ error: "This file belongs to another member of this space" }, 403);
                    }
                    const before = this.usedBytes;
                    const total = before - (prev?.manifest.size ?? 0) + manifest.size;
                    const full = this.full(before, total);
                    if (full) return full;
                    // The server stamps the uploader on a file id's first write, and on a legacy row with none.
                    this.files.set(manifest.id, { manifest, owner: prev?.owner ?? caller });
                    this.usedBytes = total;
                    return json({ ok: true, fileId: manifest.id }, 200);
                }
                return new Response("Method not allowed", { status: 405 });
            }
            const rec = this.files.get(fileId);
            if (method === "GET") {
                if (!rec) return json({ error: "File not found" }, 404);
                return json({ manifest: rec.manifest, owner: rec.owner }, 200);
            }
            if (method === "DELETE") {
                if (!rec) return json({ ok: true, existed: false }, 200);
                if (!this.mayChange(rec.owner, caller)) {
                    return json({ error: "This file belongs to another member of this space" }, 403);
                }
                this.files.delete(fileId);
                this.usedBytes = Math.max(0, this.usedBytes - rec.manifest.size);
                return json({ ok: true, existed: true }, 200);
            }
            return new Response("Method not allowed", { status: 405 });
        }
        return json({ error: "Not found" }, 404);
    }

    private belongs(id: string): boolean {
        return id === this.ownerUsername || this.members.includes(id);
    }

    private mayChange(fileOwner: string | null, caller: string): boolean {
        if (fileOwner === null || fileOwner === caller) return true;
        if (caller === this.ownerUsername) return true;
        return this.kind === "private" && this.editPolicy === "any" && this.members.includes(caller);
    }

    private full(before: number, after: number): Response | null {
        if (this.limitBytes === null) return null;
        if (after <= before || after <= this.limitBytes) return null;
        return json({ code: "share_full", limitBytes: this.limitBytes, usedBytes: before }, 402);
    }

    private closedBody() {
        return { error: "This share is closed", code: "share_closed", successor: this.closed!.successor };
    }
}

function json(body: unknown, status: number): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
