/**
 * Reed–Solomon erasure-coding codec.
 *
 * Wraps the WASM-backed `encode` / `reconstruct` primitives in `wasm/rs.ts`
 * with shard-padding bookkeeping so callers can hand it any-length input and
 * get back uniform-size shards.
 *
 * Usage:
 *   const codec = new ReedSolomonCodec();
 *   await codec.ready();
 *   const { shards, shardSize, originalSize } = codec.encode(plaintext, 4, 2);
 *   // 6 shards (4 data + 2 parity), each `shardSize` bytes
 *   // …ship them, lose up to 2, then …
 *   const recovered = codec.decode(shards, 2, deadIndexes, originalSize);
 *
 * Why the explicit `originalSize`: RS pads input to make every data shard the
 * same length. The decoder must trim that padding back off after recovery.
 * The caller is responsible for stashing `originalSize` somewhere durable
 * (the file manifest, in this codebase).
 */

import { initRsWasm, encode as wasmEncode, reconstruct as wasmReconstruct } from "./wasm/rs";

export interface EncodeResult {
    /** All `dataShards + parityShards` shards. All have length `shardSize`. */
    shards: Uint8Array[];
    /** Length of every shard (data and parity). */
    shardSize: number;
    /** Length of the original input before padding. Needed to trim on decode. */
    originalSize: number;
    /** How many of the leading shards are data (the rest are parity). */
    dataShards: number;
    /** How many parity shards trail the data shards. */
    parityShards: number;
}

export class ReedSolomonCodec {
    /**
     * Resolves once the WASM module is loaded; safe to call repeatedly.
     *
     * Pass `wasmModule` to use a pre-compiled module (e.g. in tests where the
     * rollup-inlined loader path isn't available, or in CF Workers where you
     * want to load the module at deploy time). Default path uses the bundled
     * base64-inlined wasm — works in Node, browsers, and Workers.
     */
    ready(wasmModule?: WebAssembly.Module): Promise<void> {
        return initRsWasm(wasmModule);
    }

    /**
     * Split `data` into `dataShards` equal-size chunks (zero-padded to fit),
     * compute `parityShards` parity shards, and return all of them.
     */
    encode(data: Uint8Array, dataShards: number, parityShards: number): EncodeResult {
        if (dataShards < 1) throw new Error("ReedSolomonCodec.encode: dataShards must be >= 1");
        if (parityShards < 1) throw new Error("ReedSolomonCodec.encode: parityShards must be >= 1");
        if (data.length === 0) throw new Error("ReedSolomonCodec.encode: data is empty");

        // The wbindgen-generated WASM in `wasm-reed-solomon-erasure@0.2.2` takes
        // the `parity_shard` count separately and infers `total = data.length +
        // parity_shard`. Every shard must be the same length, so we pad the
        // input to `dataShards * shardSize` with trailing zeros.
        const shardSize = Math.ceil(data.length / dataShards);
        const splitInputs: Uint8Array[] = [];
        for (let i = 0; i < dataShards; i++) {
            // Each shard is its own backing ArrayBuffer so the WASM side
            // doesn't observe overlapping views (which would confuse the
            // wbindgen length lookups).
            const shard = new Uint8Array(shardSize);
            const start = i * shardSize;
            const end = Math.min(start + shardSize, data.length);
            if (start < data.length) {
                shard.set(data.subarray(start, end));
            }
            splitInputs.push(shard);
        }

        const shards = wasmEncode(splitInputs, parityShards);
        // The underlying call returns N+M shards; first N are the (padded)
        // data shards we just sent in, last M are the parity shards.
        return {
            shards,
            shardSize,
            originalSize: data.length,
            dataShards,
            parityShards,
        };
    }

    /**
     * Reconstruct the original `data` from `shards`. Up to `parityShards`
     * shards may be missing; for each missing shard, pass an empty
     * `Uint8Array` placeholder at its position and list the position in
     * `deadShardIndexes`.
     *
     * `originalSize` is required so the trailing zero-padding can be trimmed.
     */
    decode(
        shards: Uint8Array[],
        parityShards: number,
        deadShardIndexes: number[],
        originalSize: number,
    ): Uint8Array {
        if (parityShards < 1) throw new Error("ReedSolomonCodec.decode: parityShards must be >= 1");
        if (shards.length <= parityShards) {
            throw new Error("ReedSolomonCodec.decode: shards.length must be > parityShards");
        }
        if (deadShardIndexes.length > parityShards) {
            throw new Error(
                `ReedSolomonCodec.decode: too many missing shards (${deadShardIndexes.length} > ${parityShards})`,
            );
        }

        const dataShards = shards.length - parityShards;
        const recovered =
            deadShardIndexes.length === 0
                ? shards
                : wasmReconstruct(shards, parityShards, new Uint32Array(deadShardIndexes));

        // Concatenate the leading `dataShards`, then trim padding back off.
        const shardSize = recovered[0]?.length ?? 0;
        const out = new Uint8Array(dataShards * shardSize);
        for (let i = 0; i < dataShards; i++) {
            out.set(recovered[i], i * shardSize);
        }
        return out.subarray(0, originalSize);
    }
}

export default ReedSolomonCodec;
