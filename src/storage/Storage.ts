import { _objectId } from '../utilities';
import { Network } from '../network';
import { ReedSolomon } from './encoding';
import { Message } from '../messaging/Message';
import { appLogger } from '../core';

/**
 * @public
 *
 * Storage class for reading and writing data with Reed-Solomon encoding
 * Uses REST API via Network class for data transmission
 */
export type StorageOptions = {
    network: Network;
    /** Number of data shards for Reed-Solomon encoding (default: 4) */
    dataShards?: number;
    /** Number of parity shards for Reed-Solomon encoding (default: 2) */
    parityShards?: number;
    /** Maximum chunk size in bytes before encoding (default: 2.5MB) */
    chunkSize?: number;
}

/**
 * @public
 *
 * File metadata structure
 */
export type FileStat = {
    id: string;
    size: number;
    lastModified: Date | number;
    type: string;
    name: string;
    path?: string;
    /** Hash of the original data */
    hash?: string;
}

/**
 * @internal
 *
 * Encoded chunk metadata
 */
type EncodedChunk = {
    id: string;
    shards: Uint8Array[];
    parityShards: number;
    originalSize: number;
    chunkIndex: number;
}

/**
 * Storage class for reading and writing data with Reed-Solomon encoding
 *
 * Features:
 * - Reed-Solomon encoding for data redundancy and fault tolerance
 * - REST API communication via Network class
 * - Chunked upload/download for large files
 * - Automatic encoding/decoding with configurable redundancy
 *
 * @example
 * ```typescript
 * const storage = new Storage({
 *   network: myNetworkInstance,
 *   dataShards: 4,
 *   parityShards: 2
 * });
 *
 * // Write data
 * const fileStat = await storage.write(fileData, metadata);
 *
 * // Read data
 * const data = await storage.read(fileStat.id);
 * ```
 */
export class Storage {
    private network: Network;
    private encoder: ReedSolomon;
    private dataShards: number;
    private parityShards: number;
    private chunkSize: number;
    private activeUploads: Map<string, EncodedChunk[]> = new Map();

    constructor(options: StorageOptions) {
        if (!options.network) {
            throw new Error("No network instance provided");
        }

        this.network = options.network;
        this.encoder = new ReedSolomon();
        this.dataShards = options.dataShards || 4;
        this.parityShards = options.parityShards || 2;
        this.chunkSize = options.chunkSize || 2.5 * 1024 * 1024; // 2.5MB default

        // Listen for encoding results
        this.setupEncoderListeners();

        appLogger.debug('[Storage] Initialized with', {
            dataShards: this.dataShards,
            parityShards: this.parityShards,
            chunkSize: this.chunkSize
        });
    }

    /**
     * Setup event listeners for Reed-Solomon encoder
     */
    private setupEncoderListeners(): void {
        this.encoder.encoder.on('encoded', (event: CustomEvent) => {
            appLogger.debug('[Storage] Data encoded successfully', event.detail);
        });

        this.encoder.encoder.on('decoded', (event: CustomEvent) => {
            appLogger.debug('[Storage] Data decoded successfully', event.detail);
        });
    }

    /**
     * Write data to storage with Reed-Solomon encoding
     *
     * Process:
     * 1. Convert File/Blob to Uint8Array chunks
     * 2. Encode each chunk with Reed-Solomon for redundancy
     * 3. Upload encoded shards via REST API
     * 4. Return metadata with storage references
     *
     * @param data - File, Blob, or Uint8Array to store
     * @param metadata - File metadata
     * @returns FileStat with storage information
     */
    public async write(
        data: File | Blob | Uint8Array,
        metadata: Omit<FileStat, 'id' | 'hash'>
    ): Promise<FileStat> {
        const fileId = _objectId();
        appLogger.debug('[Storage] Writing file', { fileId, name: metadata.name });

        try {
            // Convert to Uint8Array
            let buffer: Uint8Array;
            if (data instanceof File || data instanceof Blob) {
                buffer = new Uint8Array(await data.arrayBuffer());
            } else {
                buffer = data;
            }

            // Handle empty data as special case (no encoding needed)
            if (buffer.length === 0) {
                appLogger.debug('[Storage] Empty file, skipping encoding');
                const uploadResult = await this.uploadEncodedChunks(fileId, []);

                return {
                    id: fileId,
                    size: 0,
                    lastModified: metadata.lastModified || Date.now(),
                    type: metadata.type,
                    name: metadata.name,
                    path: metadata.path,
                    hash: uploadResult.hash
                };
            }

            // Split into chunks
            const chunks = this.splitIntoChunks(buffer);
            appLogger.debug('[Storage] Split into chunks', { count: chunks.length });

            const encodedChunks: EncodedChunk[] = [];

            // Encode each chunk with Reed-Solomon
            for (let i = 0; i < chunks.length; i++) {
                const chunk = chunks[i];
                const chunkId = _objectId();

                // Wait for encoding to complete
                const shards = await this.encodeChunk(chunk);

                const encodedChunk: EncodedChunk = {
                    id: chunkId,
                    shards,
                    parityShards: this.parityShards,
                    originalSize: chunk.length,
                    chunkIndex: i
                };

                encodedChunks.push(encodedChunk);
            }

            // Upload all encoded chunks via REST API
            const uploadResult = await this.uploadEncodedChunks(fileId, encodedChunks);

            // Create file stat
            const fileStat: FileStat = {
                id: fileId,
                size: buffer.length,
                lastModified: metadata.lastModified || Date.now(),
                type: metadata.type,
                name: metadata.name,
                path: metadata.path,
                hash: uploadResult.hash
            };

            appLogger.debug('[Storage] Write complete', { fileId, hash: fileStat.hash });
            return fileStat;

        } catch (error) {
            appLogger.error('[Storage] Write failed', error);
            throw new Error(`Failed to write file: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * Read data from storage with Reed-Solomon decoding
     *
     * Process:
     * 1. Fetch encoded chunks via REST API
     * 2. Decode each chunk using Reed-Solomon
     * 3. Reassemble original data
     * 4. Return complete Uint8Array
     *
     * @param fileId - The file ID to read
     * @returns The original data as Uint8Array
     */
    public async read(fileId: string): Promise<Uint8Array> {
        appLogger.debug('[Storage] Reading file', { fileId });

        try {
            // Fetch encoded chunks from server
            const encodedChunks = await this.downloadEncodedChunks(fileId);
            appLogger.debug('[Storage] Downloaded chunks', { count: encodedChunks.length });

            // Handle empty file
            if (encodedChunks.length === 0) {
                appLogger.debug('[Storage] Empty file, no decoding needed');
                return new Uint8Array(0);
            }

            // Sort chunks by index
            encodedChunks.sort((a, b) => a.chunkIndex - b.chunkIndex);

            const decodedChunks: Uint8Array[] = [];

            // Decode each chunk
            for (const encodedChunk of encodedChunks) {
                const decoded = await this.decodeChunk(
                    encodedChunk.shards,
                    encodedChunk.parityShards
                );

                // Trim to original size (remove padding)
                const trimmed = decoded.slice(0, encodedChunk.originalSize);
                decodedChunks.push(trimmed);
            }

            // Reassemble all chunks
            const totalSize = decodedChunks.reduce((sum, chunk) => sum + chunk.length, 0);
            const result = new Uint8Array(totalSize);
            let offset = 0;

            for (const chunk of decodedChunks) {
                result.set(chunk, offset);
                offset += chunk.length;
            }

            appLogger.debug('[Storage] Read complete', { fileId, size: result.length });
            return result;

        } catch (error) {
            appLogger.error('[Storage] Read failed', error);
            throw new Error(`Failed to read file: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    // ============================================================================
    // Private Helper Methods
    // ============================================================================

    /**
     * Split data into chunks for encoding
     */
    private splitIntoChunks(data: Uint8Array): Uint8Array[] {
        const chunks: Uint8Array[] = [];
        for (let i = 0; i < data.length; i += this.chunkSize) {
            const end = Math.min(i + this.chunkSize, data.length);
            chunks.push(data.slice(i, end));
        }
        return chunks.length > 0 ? chunks : [new Uint8Array(0)];
    }

    /**
     * Encode a single chunk using Reed-Solomon
     */
    private async encodeChunk(chunk: Uint8Array): Promise<Uint8Array[]> {
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                reject(new Error('Encoding timeout'));
            }, 30000);

            const handleEncoded = (event: CustomEvent) => {
                clearTimeout(timeoutId);
                this.encoder.encoder.off('encoded', handleEncoded);
                const shards = event.detail.shards as Uint8Array[];
                resolve(shards);
            };

            this.encoder.encoder.on('encoded', handleEncoded);

            // Convert Uint8Array to Buffer for encoding
            const buffer = Buffer.from(chunk);
            this.encoder.encode(buffer, this.dataShards, this.parityShards);
        });
    }

    /**
     * Decode shards using Reed-Solomon
     */
    private async decodeChunk(
        shards: Uint8Array[],
        parityShards: number
    ): Promise<Uint8Array> {
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                reject(new Error('Decoding timeout'));
            }, 30000);

            const handleDecoded = (event: CustomEvent) => {
                clearTimeout(timeoutId);
                this.encoder.encoder.off('decoded', handleDecoded);
                const decoded = event.detail.buffer as Uint8Array;
                resolve(decoded);
            };

            this.encoder.encoder.on('decoded', handleDecoded);

            // Find missing shards (if any)
            const deadShardIndexes: number[] = [];
            shards.forEach((shard, index) => {
                if (!shard || shard.length === 0) {
                    deadShardIndexes.push(index);
                }
            });

            this.encoder.decode(shards, parityShards, deadShardIndexes);
        });
    }

    /**
     * Upload encoded chunks via REST API
     */
    private async uploadEncodedChunks(
        fileId: string,
        encodedChunks: EncodedChunk[]
    ): Promise<{ hash: string }> {
        appLogger.debug('[Storage] Uploading encoded chunks', {
            fileId,
            chunkCount: encodedChunks.length
        });

        try {
            // Prepare upload data
            const uploadData = {
                fileId,
                chunks: encodedChunks.map(chunk => ({
                    id: chunk.id,
                    shards: Array.from(chunk.shards.map(shard => Array.from(shard))),
                    parityShards: chunk.parityShards,
                    originalSize: chunk.originalSize,
                    chunkIndex: chunk.chunkIndex
                }))
            };

            // Create message with upload data
            const message = new Message({
                subject: 'storage.upload',
                body: uploadData
            });

            // Upload via REST API
            const response = await this.network.post({
                target: 'storage',
                subject: 'storage.upload',
                message
            });

            if (response.status !== 200) {
                throw new Error(`Upload failed with status ${response.status}`);
            }

            appLogger.debug('[Storage] Upload successful', response.data);
            return {
                hash: response.data.hash || _objectId()
            };

        } catch (error) {
            appLogger.error('[Storage] Upload failed', error);
            throw error;
        }
    }

    /**
     * Download encoded chunks via REST API
     */
    private async downloadEncodedChunks(fileId: string): Promise<EncodedChunk[]> {
        appLogger.debug('[Storage] Downloading encoded chunks', { fileId });

        try {
            // Create message for download request
            const message = new Message({
                subject: 'storage.download',
                body: { fileId }
            });

            // Download via REST API
            const response = await this.network.get({
                target: 'storage',
                subject: 'storage.download',
                message
            });

            if (response.status !== 200) {
                throw new Error(`Download failed with status ${response.status}`);
            }

            // Parse response chunks
            const chunks = response.data.chunks as any[];
            return chunks.map(chunk => ({
                id: chunk.id,
                shards: chunk.shards.map((shard: number[]) => new Uint8Array(shard)),
                parityShards: chunk.parityShards,
                originalSize: chunk.originalSize,
                chunkIndex: chunk.chunkIndex
            }));

        } catch (error) {
            appLogger.error('[Storage] Download failed', error);
            throw error;
        }
    }

    /**
     * Cleanup resources
     */
    public destroy(): void {
        this.encoder.destroy();
        this.activeUploads.clear();
        appLogger.debug('[Storage] Destroyed');
    }
}

export default Storage;
