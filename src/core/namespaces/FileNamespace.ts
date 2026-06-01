/**
 * `client.storage` — file storage. Hides the `FileStorage` / `ShardClient` /
 * `SharedSpaceClient` primitives behind the unified client.
 *
 *   const { stat, manifest } = await client.storage.writeFile({ spaceId, data, metadata })
 *   const { data }          = await client.storage.readFile(spaceId, fileId)
 *   const files             = await client.storage.listFiles()          // my shared files
 *   const files             = await client.storage.listFiles({ spaceId }) // a space's files
 *   await client.storage.deleteFile(spaceId, fileId)
 *
 * Model:
 *   - **Files are written to a SharedSpace** (never the personal space). A file
 *     is its manifest (per-chunk keys + global shard hashes); the manifest lives
 *     in the space's gated, metered `/files` store, the shard ciphertext in the
 *     global open `/api/shards` store.
 *   - **The manifest is the capability** — anyone holding it reads the file from
 *     the global shards, anywhere ({@link readByManifest}). Share a file by
 *     sharing its manifest.
 *   - **Personal discovery mirror** — on a successful write the SDK also records
 *     the manifest in the user's `client.kv` under a reserved collection, so
 *     {@link listFiles} (no `spaceId`) can show "files I've shared" without
 *     enumerating spaces. The mirror is unmetered and is NOT a write path.
 *
 * For small structured values use `client.kv` instead.
 */

import type { HttpClient } from "../HttpClient";
import type { KvNamespace } from "./KvNamespace";
import { FileStorage } from "../../storage/FileStorage";
import { ShardClient } from "../../storage/transport/ShardClient";
import { SharedSpaceClient } from "../../storage/transport/SharedSpaceClient";
import { manifestToStat, type FileManifest, type FileStat } from "../../storage/types";

/** Reserved `client.kv` collection holding the personal manifest mirror. */
const MIRROR_COLLECTION = "__files__";

export interface FileNamespaceDeps {
    http: HttpClient;
    baseUrl: string;
    /** Used for the unmetered personal discovery mirror. */
    kv: KvNamespace;
    /**
     * Optional pre-compiled Reed–Solomon WASM module. Defaults to the bundled
     * loader; pass one where the bundled loader path isn't available (vitest,
     * deploy-time-precompiled environments). Forwarded to {@link FileStorage}.
     */
    rsWasmModule?: WebAssembly.Module;
}

export interface WriteFileOptions {
    /** SharedSpace the file is written to (obtain via `client.space`). */
    spaceId: string;
    data: Uint8Array | Blob | File;
    metadata: { name: string; type: string; path?: string; lastModified?: number };
}

/** What the personal mirror stores per file. */
interface MirrorEntry {
    spaceId: string;
    manifest: FileManifest;
}

export class StorageNamespace {
    private fileStorage: FileStorage | null = null;

    constructor(private readonly deps: FileNamespaceDeps) {}

    /**
     * Write a file to a SharedSpace: shard ciphertext → the global store, the
     * manifest → the space's gated store, and a mirror copy → the caller's
     * personal index. Returns the `stat` and the `manifest` (share the manifest
     * to let others read the file).
     */
    async writeFile(input: WriteFileOptions): Promise<{ stat: FileStat; manifest: FileManifest }> {
        if (!input?.spaceId) {
            throw new Error("client.storage.writeFile: `spaceId` is required (files live in a SharedSpace).");
        }
        const fs = this.fs();
        const { manifest, stat } = await fs.writeFileToShards({
            data: input.data,
            metadata: input.metadata,
        });
        // Authoritative, metered write: the manifest into the space's gated store.
        await this.space().writeFileManifest(input.spaceId, manifest);
        // Best-effort personal discovery mirror (unmetered). A failure here
        // leaves the file intact in the space — log and continue.
        try {
            await this.deps.kv.set<MirrorEntry>(MIRROR_COLLECTION, manifest.id, {
                spaceId: input.spaceId,
                manifest,
            });
        } catch (err) {
            console.warn("client.storage.writeFile: discovery mirror failed (file still written):", err);
        }
        return { stat, manifest };
    }

    /** Read a file from its space (resolves the manifest, then the shards). */
    async readFile(spaceId: string, fileId: string): Promise<{ data: Uint8Array; stat: FileStat }> {
        return this.fs().readFile(spaceId, fileId);
    }

    /**
     * Read a file straight from a manifest — the capability path. No space
     * membership needed; this is how a shared file is opened.
     */
    async readByManifest(manifest: FileManifest): Promise<{ data: Uint8Array; stat: FileStat }> {
        return this.fs().readFileFromShards(manifest);
    }

    /**
     * List files. With no argument, returns the caller's own shared files from
     * the personal mirror; with `{ spaceId }`, lists that space's files.
     */
    async listFiles(opts?: { spaceId?: string }): Promise<FileStat[]> {
        if (opts?.spaceId) return this.space().listFiles(opts.spaceId);
        const ids = await this.deps.kv.list(MIRROR_COLLECTION);
        const entries = await Promise.all(
            ids.map((id) => this.deps.kv.get<MirrorEntry>(MIRROR_COLLECTION, id)),
        );
        return entries
            .filter((e): e is MirrorEntry => Boolean(e?.manifest))
            .map((e) => manifestToStat(e.manifest));
    }

    /** Delete a file from its space and remove the personal mirror entry. */
    async deleteFile(spaceId: string, fileId: string): Promise<boolean> {
        const existed = await this.fs().deleteFile(spaceId, fileId);
        try {
            await this.deps.kv.delete(MIRROR_COLLECTION, fileId);
        } catch {
            // mirror cleanup is best-effort
        }
        return existed;
    }

    /** Read a manifest verbatim (e.g. to share a file). */
    async getManifest(spaceId: string, fileId: string): Promise<FileManifest> {
        return this.fs().readManifest(spaceId, fileId);
    }

    // -------------------------------------------------------------------------
    // Internals — lazily built so an unauthenticated client is cheap to create.
    // -------------------------------------------------------------------------

    private fs(): FileStorage {
        if (!this.fileStorage) {
            this.fileStorage = new FileStorage({
                shards: this.shards(),
                space: this.space(),
                rsWasmModule: this.deps.rsWasmModule,
            });
        }
        return this.fileStorage;
    }

    private _shards: ShardClient | null = null;
    private shards(): ShardClient {
        // Global, content-addressed shard store. The credential-stamping fetch
        // attaches the app key so PUTs are attributed + quota-gated; GETs are open.
        if (!this._shards) {
            this._shards = new ShardClient({
                baseUrl: this.deps.baseUrl,
                pathPrefix: "/api/shards",
                fetch: this.deps.http.fetch,
            });
        }
        return this._shards;
    }

    private _space: SharedSpaceClient | null = null;
    private space(): SharedSpaceClient {
        if (!this._space) {
            this._space = new SharedSpaceClient({
                baseUrl: this.deps.baseUrl,
                fetch: this.deps.http.fetch,
            });
        }
        return this._space;
    }
}

export default StorageNamespace;
