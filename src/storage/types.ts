/**
 * Wire types for the storage layer.
 *
 * The `FileManifest` is the single piece of metadata the system needs to
 * reassemble a file: per-chunk encryption material, RS parameters, and the
 * SHA-256 content hashes of every shard that belongs to the chunk. With the
 * manifest in hand, a reader can pull each shard from the open content-
 * addressed shard store, decode, decrypt, and concatenate to recover the
 * original bytes.
 *
 * The manifest itself lives inside a `SharedSpaceDO` (Phase B) which gates
 * access by ZK proof + ACL. Shards are stored in the open content-addressed
 * `ShardStoreDO` — anyone can put/get any shard, but without the manifest
 * (which has the keys) the ciphertext is just noise.
 */

import type { ChunkKeyMaterial } from "../crypto/ChunkCipher";

/**
 * One chunk's metadata. A file is the concatenation of `chunks` in order.
 *
 * - `originalSize` is the chunk's plaintext length, before AES-GCM expanded
 *   it by 16 bytes for the auth tag and before RS padded it for shard
 *   alignment.
 * - `ciphertextSize` is the AES-GCM output length (plaintext + 16). This is
 *   what the RS decoder trims back to.
 * - `shardHashes` lists every shard's SHA-256 in encoding order — the first
 *   `dataShards` are data shards, the trailing `parityShards` are parity.
 */
export interface ChunkManifest {
    /** Stable per-chunk ID (uuid-like). Useful for client-side resume / dedup. */
    id: string;
    /** Position of this chunk in the file (0-indexed). */
    chunkIndex: number;
    /** Plaintext byte length of the chunk before encryption. */
    originalSize: number;
    /** AES-GCM ciphertext byte length (originalSize + 16 for the tag). */
    ciphertextSize: number;
    /** Number of RS data shards. */
    dataShards: number;
    /** Number of RS parity shards. */
    parityShards: number;
    /** Length in bytes of every shard (data and parity are equal). */
    shardSize: number;
    /** SHA-256 (hex) of each shard's ciphertext bytes, in shard order. */
    shardHashes: string[];
    /** Per-chunk AES-256-GCM key + IV. Plain in the manifest — gating happens at the SpaceDO. */
    cipher: ChunkKeyMaterial;
}

/**
 * Top-level manifest for a single stored file. Persisted in the user's
 * SharedSpace by file id; readable / writable per the space's ACL.
 */
export interface FileManifest {
    /** Stable file ID. Assigned by the SDK at write time; used to read or delete. */
    id: string;
    /** Human-readable filename (display only — not used by the shard store). */
    name: string;
    /** Total plaintext byte length. Sum of chunk `originalSize`s. */
    size: number;
    /** MIME type the application supplied at write time. Opaque to storage. */
    type: string;
    /** Optional virtual path / folder hint for the application. */
    path?: string;
    /** When the file was last modified per the application (ms epoch). */
    lastModified: number;
    /** When this manifest was created on the SDK side (ms epoch). */
    createdAt: number;
    /** Ordered list of chunks. Concatenate them in index order to rebuild the file. */
    chunks: ChunkManifest[];
    /** SDK schema version. Bump on breaking manifest-shape changes. */
    version: 1;
}

/**
 * Lightweight summary returned by `FileStorage.writeFile` and surfaced in
 * directory-style listings. The full manifest is only fetched when actually
 * reassembling the file.
 */
export interface FileStat {
    id: string;
    name: string;
    size: number;
    type: string;
    path?: string;
    lastModified: number;
    createdAt: number;
    chunkCount: number;
    shardCount: number;
}

/** Distil a `FileManifest` into a `FileStat`. */
export function manifestToStat(manifest: FileManifest): FileStat {
    let shardCount = 0;
    for (const c of manifest.chunks) shardCount += c.shardHashes.length;
    return {
        id: manifest.id,
        name: manifest.name,
        size: manifest.size,
        type: manifest.type,
        path: manifest.path,
        lastModified: manifest.lastModified,
        createdAt: manifest.createdAt,
        chunkCount: manifest.chunks.length,
        shardCount,
    };
}
