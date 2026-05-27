/**
 * Per-chunk AES-256-GCM encryption with random keys and IVs.
 *
 * Each chunk of a stored file gets its own freshly generated 256-bit AES key
 * and 96-bit IV. The (key, IV) pair lives in the file manifest, which the
 * application is responsible for storing under whatever access-control regime
 * it uses (in this codebase: the `SharedSpaceClient` writes manifests into
 * ZK-gated multi-user spaces; the shard store itself is open).
 *
 * Per-chunk keys (rather than a per-file DEK) lets future versions revoke or
 * re-share individual chunks without re-encrypting the whole file. The
 * additional manifest size is dominated by the shard hash list anyway.
 *
 * The cipher itself delegates to the canonical `encryptAesGcm` / `decryptAesGcm`
 * primitives — this class only wraps them with key-material generation and
 * the JSON-friendly base64 serialization the manifest needs.
 */

import { fromBase64, toBase64 } from "../utilities/bytes";
import {
    encryptAesGcm,
    decryptAesGcm,
    randomBytes,
    AES_GCM_KEY_BYTES,
    AES_GCM_IV_BYTES,
} from "./primitives";

/**
 * Per-chunk key material, base64-encoded for JSON-friendly storage in the
 * manifest. The IV is unique per chunk; the key is unique per chunk too in
 * this codebase, though that's a stricter property than AES-GCM strictly
 * requires (which is "unique IV per key").
 */
export interface ChunkKeyMaterial {
    /** Base64-encoded 32-byte AES-256 key. */
    key: string;
    /** Base64-encoded 12-byte AES-GCM IV. */
    iv: string;
}

export class ChunkCipher {
    /**
     * Generate a fresh random (key, iv) pair encoded for the manifest.
     * Callers should generate one of these per chunk before calling
     * {@link encryptChunk}.
     */
    generateKeyMaterial(): ChunkKeyMaterial {
        return {
            key: toBase64(randomBytes(AES_GCM_KEY_BYTES)),
            iv: toBase64(randomBytes(AES_GCM_IV_BYTES)),
        };
    }

    /**
     * Encrypt `plaintext` under the supplied key + IV. Returns the AES-GCM
     * ciphertext with the 16-byte auth tag appended (WebCrypto's default
     * GCM behavior).
     */
    async encryptChunk(plaintext: Uint8Array, material: ChunkKeyMaterial): Promise<Uint8Array> {
        return encryptAesGcm(fromBase64(material.key), fromBase64(material.iv), plaintext);
    }

    /**
     * Inverse of {@link encryptChunk}. Throws if the auth tag fails — that
     * means the ciphertext was tampered with, the key/iv was wrong, or the
     * shards were reassembled incorrectly.
     */
    async decryptChunk(ciphertext: Uint8Array, material: ChunkKeyMaterial): Promise<Uint8Array> {
        try {
            return await decryptAesGcm(
                fromBase64(material.key),
                fromBase64(material.iv),
                ciphertext,
            );
        } catch {
            // WebCrypto throws a vague OperationError on GCM tag mismatch.
            // Surface a stable, readable message so callers can react to it.
            throw new Error(
                "ChunkCipher.decryptChunk: decryption failed (key/iv mismatch, corrupted ciphertext, or reassembly error)",
            );
        }
    }
}

export default ChunkCipher;
