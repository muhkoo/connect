/**
 * HTTP client for the gated file-manifest store on a SharedSpace
 * (`/api/spaces/:spaceId/files`).
 *
 * A "file" in a space is its **manifest** (per-chunk keys + the SHA-256 of each
 * global shard). The shard bytes live in the open `/api/shards` store; the
 * manifest is the capability. This client only moves manifests in/out of the
 * space's gated store.
 *
 * Authorization is **session-based**, consistent with the rest of the
 * SharedSpace (keyring, websocket): the SDK's credential-stamping `fetch`
 * (from {@link HttpClient}) attaches the app key + session token, the platform
 * validates the session and injects a trusted `X-Muhkoo-User-Context`, and the
 * DO authorizes on that + channel membership. There is no per-op Groth16 proof.
 *
 * Wire protocol (server: `SharedSpaceDO`):
 *   POST   /api/spaces/:spaceId/files            body: { manifest }  → { ok, fileId }
 *   GET    /api/spaces/:spaceId/files                                → { files: FileStat[] }
 *   GET    /api/spaces/:spaceId/files/:fileId                        → { manifest }
 *   DELETE /api/spaces/:spaceId/files/:fileId                        → { ok, existed }
 */

import type { FileManifest, FileStat } from "../types";

export interface SharedSpaceClientOptions {
    /** Base URL of the accelerator (e.g. `https://api.muhkoo.dev`). */
    baseUrl: string;
    /**
     * Credential-stamping fetch — pass {@link HttpClient.fetch} so requests
     * carry the app key + session token. Defaults to `globalThis.fetch`
     * (unauthenticated; only useful in tests).
     */
    fetch?: typeof fetch;
}

export class SharedSpaceClient {
    private readonly baseUrl: string;
    private readonly fetchFn: typeof fetch;

    constructor(opts: SharedSpaceClientOptions) {
        if (!opts?.baseUrl) throw new Error("SharedSpaceClient: `baseUrl` is required");
        this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
        const f = opts.fetch ?? globalThis.fetch;
        if (typeof f !== "function") {
            throw new Error("SharedSpaceClient: `globalThis.fetch` is unavailable; pass an explicit fetch.");
        }
        this.fetchFn = f.bind(globalThis);
    }

    /** Write a file manifest into the space. Requires space membership. */
    async writeFileManifest(spaceId: string, manifest: FileManifest): Promise<void> {
        const url = `${this.filesBase(spaceId)}`;
        const res = await this.fetchFn(url, this.jsonRequest("POST", { manifest }));
        await parseOrThrow<{ ok: true; fileId: string }>(res, `writeFileManifest(${manifest.id})`);
    }

    /** Read a file manifest by id. Requires space membership. */
    async readFileManifest(spaceId: string, fileId: string): Promise<FileManifest> {
        const url = `${this.filesBase(spaceId)}/${encodeURIComponent(fileId)}`;
        const res = await this.fetchFn(url, this.jsonRequest("GET"));
        const data = await parseOrThrow<{ manifest: FileManifest }>(res, `readFileManifest(${fileId})`);
        return data.manifest;
    }

    /** Delete a file manifest by id. Requires space membership. */
    async deleteFileManifest(spaceId: string, fileId: string): Promise<boolean> {
        const url = `${this.filesBase(spaceId)}/${encodeURIComponent(fileId)}`;
        const res = await this.fetchFn(url, this.jsonRequest("DELETE"));
        const data = await parseOrThrow<{ ok: true; existed: boolean }>(res, `deleteFileManifest(${fileId})`);
        return data.existed;
    }

    /** List file summaries in the space. Requires space membership. */
    async listFiles(spaceId: string): Promise<FileStat[]> {
        const url = `${this.filesBase(spaceId)}`;
        const res = await this.fetchFn(url, this.jsonRequest("GET"));
        const data = await parseOrThrow<{ files: FileStat[] }>(res, "listFiles");
        return Array.isArray(data.files) ? data.files : [];
    }

    // -------------------------------------------------------------------------

    private filesBase(spaceId: string): string {
        return `${this.baseUrl}/api/spaces/${encodeURIComponent(spaceId)}/files`;
    }

    private jsonRequest(method: string, body?: unknown): RequestInit {
        const init: RequestInit = { method };
        if (body !== undefined) {
            init.headers = { "Content-Type": "application/json" };
            init.body = JSON.stringify(body);
        }
        return init;
    }
}

async function parseOrThrow<T>(response: Response, op: string): Promise<T> {
    let parsed: unknown = null;
    try {
        parsed = await response.json();
    } catch {
        // non-JSON body
    }
    if (!response.ok) {
        const msg =
            parsed && typeof parsed === "object" && "error" in (parsed as object)
                ? String((parsed as { error: unknown }).error)
                : `${response.status} ${response.statusText}`;
        throw new Error(`SharedSpaceClient.${op}: ${msg}`);
    }
    return parsed as T;
}

export default SharedSpaceClient;
