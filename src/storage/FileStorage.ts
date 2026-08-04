/**
 * `FileStorage` — top-level entry point for chunked, encrypted, erasure-coded
 * file storage.
 *
 * Pipeline for writing a file:
 *   1. Split the plaintext into fixed-size chunks (default 4 MiB).
 *   2. For each chunk:
 *        a. Generate a fresh AES-256-GCM key + 12-byte IV (`ChunkCipher`).
 *        b. Encrypt the chunk → ciphertext (plaintext.length + 16 bytes tag).
 *        c. Reed–Solomon encode the ciphertext into `dataShards + parityShards`
 *           equal-length shards (`ReedSolomonCodec`).
 *        d. PUT every shard to the content-addressed shard store, keyed by
 *           SHA-256 of the shard bytes (`ShardClient`).
 *   3. Build a `FileManifest` listing every chunk's keys, IVs, sizes, and
 *      the SHA-256 of every shard in order.
 *
 * Two ways to use the manifest:
 *   - {@link FileStorage.writeFileToShards} returns it to the caller, who is
 *     then responsible for delivering it to readers (e.g. by E2E-encrypting
 *     it as a chat message). The chat application takes this path.
 *   - {@link FileStorage.writeFile} additionally POSTs the manifest to a
 *     gated multi-user space (`SharedSpaceClient`) so any participant of the
 *     space can read the file by manifest id later.
 *
 * Reading is the inverse: {@link FileStorage.readFileFromShards} takes a
 * manifest and reassembles the plaintext; {@link FileStorage.readFile} first
 * fetches the manifest from the space.
 */

import type { FileManifest, FileStat, ChunkManifest } from "./types";
import { manifestToStat } from "./types";
import { ChunkCipher } from "../crypto/ChunkCipher";
import type { ChunkKeyMaterial } from "../crypto/ChunkCipher";
import { ReedSolomonCodec } from "./encoding";
import { ShardClient, shardHash } from "./transport/ShardClient";
import { SharedSpaceClient } from "./transport/SharedSpaceClient";
import { generateId } from "../utilities";

export interface FileStorageOptions {
    /** Talks to the content-addressed shard store. Always required. */
    shards: ShardClient;
    /**
     * Talks to the gated multi-user space holding manifests + ACLs.
     * Optional — only required by {@link FileStorage.writeFile} /
     * {@link FileStorage.readFile} / {@link FileStorage.deleteFile} /
     * {@link FileStorage.listFiles} / {@link FileStorage.readManifest}.
     *
     * Callers that ship the manifest themselves (e.g. via an encrypted chat
     * message) can omit `space` and use the `*FromShards` / `*ToShards`
     * methods directly.
     */
    space?: SharedSpaceClient;
    /**
     * Plaintext chunk size in bytes. After encryption each chunk gains 16
     * bytes (GCM tag); after RS encoding the size is rounded up to a multiple
     * of `dataShards` per chunk. Default 4 MiB — a balance between
     * round-trip cost and parallelism on the upload path.
     */
    chunkSize?: number;
    /** RS data shards per chunk (default 4). */
    dataShards?: number;
    /** RS parity shards per chunk (default 2). */
    parityShards?: number;
    /**
     * Cap on concurrent shard uploads / downloads. Tune for the network. The
     * default of 8 saturates most home connections without overwhelming the
     * server's per-IP rate limiter.
     */
    concurrency?: number;
    /**
     * Optional pre-compiled RS WebAssembly module. Defaults to the bundled
     * loader. Pass this in environments where the bundled loader path isn't
     * available (vitest, deploy-time-precompiled CF Workers).
     */
    rsWasmModule?: WebAssembly.Module;
}

/**
 * Input to {@link FileStorage.writeFile} (which writes the manifest to a
 * `SharedSpaceClient`). Carries the destination `spaceId`.
 */
export interface WriteFileInput extends WriteToShardsInput {
    /** Space to write the manifest to — must allow the caller `write`. */
    spaceId: string;
}

/**
 * Input to {@link FileStorage.writeFileToShards} (which doesn't write a
 * manifest anywhere — that's the caller's job).
 */
export interface WriteToShardsInput {
    /** Raw data, a Blob, or a File. */
    data: Uint8Array | Blob | File;
    /** Application-supplied display metadata. */
    metadata: {
        name: string;
        type: string;
        path?: string;
        lastModified?: number;
    };
    /**
     * Optional pre-allocated file id. Defaults to a fresh one. Useful for
     * resumable uploads: the same id always maps to the same manifest slot.
     */
    fileId?: string;
    /**
     * Optional upload-progress callback, invoked after each chunk finishes
     * (`completed` of `total` chunks). Lets a UI show a progress bar. Called once
     * with `(0, total)` before the first chunk so a bar can render immediately.
     */
    onProgress?: (completed: number, total: number) => void;
}

export class FileStorage {
    private readonly space: SharedSpaceClient | undefined;
    private readonly shards: ShardClient;
    private readonly chunkSize: number;
    private readonly dataShards: number;
    private readonly parityShards: number;
    private readonly concurrency: number;
    private readonly cipher = new ChunkCipher();
    private readonly codec = new ReedSolomonCodec();
    private readonly rsWasmModule?: WebAssembly.Module;

    constructor(opts: FileStorageOptions) {
        if (!opts?.shards) throw new Error("FileStorage: `shards` (ShardClient) is required");

        this.space = opts.space;
        this.shards = opts.shards;
        this.chunkSize = opts.chunkSize ?? 4 * 1024 * 1024;
        this.dataShards = opts.dataShards ?? 4;
        this.parityShards = opts.parityShards ?? 2;
        this.concurrency = Math.max(1, opts.concurrency ?? 8);
        this.rsWasmModule = opts.rsWasmModule;

        if (this.chunkSize < 1) throw new Error("FileStorage: chunkSize must be >= 1 byte");
        if (this.dataShards < 1) throw new Error("FileStorage: dataShards must be >= 1");
        if (this.parityShards < 1) throw new Error("FileStorage: parityShards must be >= 1");
    }

    // -------------------------------------------------------------------------
    // Shard-only pipeline — the caller owns the manifest. Used by chat file
    // sharing, where the manifest rides as an E2E-encrypted chat message.
    // -------------------------------------------------------------------------

    /**
     * Chunk → encrypt → encode → upload-shards. Returns the resulting manifest
     * along with a `FileStat` summary. The caller is responsible for storing
     * or transmitting the manifest however it likes.
     */
    async writeFileToShards(
        input: WriteToShardsInput,
    ): Promise<{ manifest: FileManifest; stat: FileStat }> {
        await this.codec.ready(this.rsWasmModule);

        const fileId = input.fileId ?? generateId();
        const createdAt = Date.now();
        const chunks: ChunkManifest[] = [];

        // Read the source per-chunk so the peak memory footprint stays at
        // ~chunkSize even for multi-GB files. A Blob/File is sliced lazily (only
        // the current chunk's bytes are materialized) — reading the whole thing
        // up front would blow past the browser's ~2GB ArrayBuffer cap and throw
        // "the file could not be read". A caller that already has the bytes in a
        // Uint8Array just gets zero-copy subarray views.
        const asBytes = input.data instanceof Uint8Array ? input.data : null;
        const size = asBytes ? asBytes.length : (input.data as Blob).size;
        const readChunk = async (start: number, end: number): Promise<Uint8Array> =>
            asBytes ? asBytes.subarray(start, end)
                : new Uint8Array(await (input.data as Blob).slice(start, end).arrayBuffer());

        const totalChunks = Math.max(1, Math.ceil(size / this.chunkSize));
        input.onProgress?.(0, totalChunks);

        // Within a chunk, the shard uploads are parallelized up to `this.concurrency`.
        for (let chunkIndex = 0; chunkIndex * this.chunkSize < Math.max(1, size); chunkIndex++) {
            const start = chunkIndex * this.chunkSize;
            const end = Math.min(start + this.chunkSize, size);
            const plaintext = await readChunk(start, end);
            chunks.push(await this.writeChunk(plaintext, chunkIndex));
            input.onProgress?.(chunks.length, totalChunks);
            // Stop after one iteration if the file is empty — we still emit a
            // single zero-length chunk so the manifest has a stable shape.
            if (size === 0) break;
        }

        const manifest: FileManifest = {
            id: fileId,
            name: input.metadata.name,
            size,
            type: input.metadata.type,
            path: input.metadata.path,
            lastModified: input.metadata.lastModified ?? createdAt,
            createdAt,
            chunks,
            version: 1,
        };

        return { manifest, stat: manifestToStat(manifest) };
    }

    /**
     * Inverse of {@link writeFileToShards}. Takes a manifest the caller
     * obtained somehow (chat message, share link, etc.) and reassembles the
     * plaintext. Throws if too many shards are missing or any chunk's auth
     * tag fails.
     */
    async readFileFromShards(
        manifest: FileManifest,
    ): Promise<{ data: Uint8Array; stat: FileStat }> {
        await this.codec.ready(this.rsWasmModule);

        // Materialize each chunk into plaintext, then concatenate. We don't
        // stream across chunks here because the consuming surface returns
        // `Uint8Array`; a streaming variant would reuse `readChunk` unchanged.
        const plaintextChunks: Uint8Array[] = [];
        for (const chunkManifest of [...manifest.chunks].sort((a, b) => a.chunkIndex - b.chunkIndex)) {
            plaintextChunks.push(await this.readChunk(chunkManifest));
        }
        let total = 0;
        for (const c of plaintextChunks) total += c.length;
        const out = new Uint8Array(total);
        let offset = 0;
        for (const c of plaintextChunks) {
            out.set(c, offset);
            offset += c.length;
        }
        return { data: out, stat: manifestToStat(manifest) };
    }

    /**
     * Streaming inverse of {@link writeFileToShards}: yields each chunk's
     * decrypted plaintext in order WITHOUT concatenating. Peak memory stays at
     * ~one chunk, so multi-GB files (which overflow a single `Uint8Array`) can be
     * piped straight to a file/socket. Same shard sourcing (cache → peers →
     * origin) and per-chunk auth as {@link readFileFromShards}.
     */
    async *readChunksFromShards(manifest: FileManifest): AsyncGenerator<Uint8Array> {
        await this.codec.ready(this.rsWasmModule);
        for (const chunkManifest of [...manifest.chunks].sort((a, b) => a.chunkIndex - b.chunkIndex)) {
            yield await this.readChunk(chunkManifest);
        }
    }

    // -------------------------------------------------------------------------
    // Space-backed convenience wrappers — encrypt + upload + write manifest.
    // Require a `SharedSpaceClient` to have been provided at construction.
    // -------------------------------------------------------------------------

    /** As {@link writeFileToShards}, plus POSTs the manifest to `input.spaceId`. */
    async writeFile(input: WriteFileInput): Promise<FileStat> {
        const space = this.requireSpace("writeFile");
        const { manifest, stat } = await this.writeFileToShards(input);
        await space.writeFileManifest(input.spaceId, manifest);
        return stat;
    }

    /** As {@link readFileFromShards}, but fetches the manifest from a space first. */
    async readFile(spaceId: string, fileId: string): Promise<{ data: Uint8Array; stat: FileStat }> {
        const space = this.requireSpace("readFile");
        const manifest = await space.readFileManifest(spaceId, fileId);
        return await this.readFileFromShards(manifest);
    }

    /**
     * Delete the manifest from a space. **Does not GC the shards** — those
     * are content-addressed and may be referenced by other manifests.
     * Garbage collection is a separate server-side concern (Phase D / D-ish).
     */
    async deleteFile(spaceId: string, fileId: string): Promise<boolean> {
        const space = this.requireSpace("deleteFile");
        return space.deleteFileManifest(spaceId, fileId);
    }

    /** Convenience pass-through. */
    async listFiles(spaceId: string): Promise<FileStat[]> {
        const space = this.requireSpace("listFiles");
        return space.listFiles(spaceId);
    }

    /** Read a manifest verbatim — useful for "share file" / export flows. */
    async readManifest(spaceId: string, fileId: string): Promise<FileManifest> {
        const space = this.requireSpace("readManifest");
        return space.readFileManifest(spaceId, fileId);
    }

    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------

    private requireSpace(operation: string): SharedSpaceClient {
        if (!this.space) {
            throw new Error(
                `FileStorage.${operation}: a SharedSpaceClient is required for this operation ` +
                "(constructor was called without `space`)",
            );
        }
        return this.space;
    }

    /** Encrypt + encode + upload one chunk; return its manifest entry. */
    private async writeChunk(plaintext: Uint8Array, chunkIndex: number): Promise<ChunkManifest> {
        const keyMaterial: ChunkKeyMaterial = this.cipher.generateKeyMaterial();
        const ciphertext =
            plaintext.length === 0
                ? new Uint8Array(0)
                : await this.cipher.encryptChunk(plaintext, keyMaterial);

        // An empty chunk encodes to nothing — emit a manifest entry with no
        // shards so the reader can re-emit an empty plaintext and skip the
        // shard round-trip.
        if (ciphertext.length === 0) {
            return {
                id: generateId(),
                chunkIndex,
                originalSize: 0,
                ciphertextSize: 0,
                dataShards: this.dataShards,
                parityShards: this.parityShards,
                shardSize: 0,
                shardHashes: [],
                cipher: keyMaterial,
            };
        }

        const encoded = this.codec.encode(ciphertext, this.dataShards, this.parityShards);
        const hashes = await Promise.all(encoded.shards.map((s) => shardHash(s)));
        await this.runWithConcurrency(
            encoded.shards.map((bytes, i) => async () => {
                await this.shards.putShard(hashes[i], bytes);
            }),
        );

        return {
            id: generateId(),
            chunkIndex,
            originalSize: plaintext.length,
            ciphertextSize: ciphertext.length,
            dataShards: encoded.dataShards,
            parityShards: encoded.parityShards,
            shardSize: encoded.shardSize,
            shardHashes: hashes,
            cipher: keyMaterial,
        };
    }

    /** Inverse of `writeChunk`. */
    private async readChunk(manifest: ChunkManifest): Promise<Uint8Array> {
        if (manifest.shardHashes.length === 0) {
            // Empty chunk fast path.
            return new Uint8Array(0);
        }

        // Fetch shards in parallel. Anything missing becomes a placeholder so
        // the decoder can fill it in from the parity shards (up to
        // `parityShards` allowed).
        const fetched = new Array<Uint8Array | null>(manifest.shardHashes.length);
        await this.runWithConcurrency(
            manifest.shardHashes.map((hash, i) => async () => {
                fetched[i] = await this.shards.getShard(hash);
            }),
        );

        const deadIndexes: number[] = [];
        const shards: Uint8Array[] = fetched.map((bytes, i) => {
            if (bytes === null) {
                deadIndexes.push(i);
                return new Uint8Array(manifest.shardSize);
            }
            if (bytes.length !== manifest.shardSize) {
                throw new Error(
                    `FileStorage: shard ${manifest.shardHashes[i]} has wrong size ` +
                    `(got ${bytes.length}, expected ${manifest.shardSize})`,
                );
            }
            return bytes;
        });

        if (deadIndexes.length > manifest.parityShards) {
            throw new Error(
                `FileStorage: chunk ${manifest.id} unrecoverable — ${deadIndexes.length} shards missing, ` +
                `only ${manifest.parityShards} tolerated`,
            );
        }

        const ciphertextPadded = this.codec.decode(
            shards,
            manifest.parityShards,
            deadIndexes,
            manifest.ciphertextSize,
        );
        return await this.cipher.decryptChunk(ciphertextPadded, manifest.cipher);
    }

    /** Run `tasks` with at most `this.concurrency` in flight. */
    private async runWithConcurrency(tasks: Array<() => Promise<void>>): Promise<void> {
        let cursor = 0;
        const concurrency = this.concurrency;
        async function nextWorker(): Promise<void> {
            while (cursor < tasks.length) {
                const idx = cursor++;
                await tasks[idx]();
            }
        }
        const workers = new Array(Math.min(concurrency, tasks.length))
            .fill(null)
            .map(() => nextWorker());
        await Promise.all(workers);
    }
}

export default FileStorage;
