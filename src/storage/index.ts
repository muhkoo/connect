/**
 * Storage layer — chunked, encrypted, erasure-coded file storage.
 *
 * Public surface:
 *   - {@link FileStorage}        top-level write/read/delete orchestrator
 *   - {@link ShardClient}        open content-addressed shard transport
 *   - {@link SharedSpaceClient}  gated multi-user manifest + ACL transport
 *   - {@link ReedSolomonCodec}   universal RS codec (used internally; exposed for tests)
 *
 * The chunk-level cipher (`ChunkCipher`) lives under `../crypto/` along with
 * the rest of the encryption code; consumers should import it from there.
 *
 * NOT exported from the workers build — `SharedSpaceClient` pulls in snarkjs.
 *
 * All re-exports use the `export *` form so rollup-plugin-dts emits them in
 * the rolled-up `connect.d.ts`. Named re-exports (`export { X } from`) get
 * silently dropped by the dts plugin in this codebase's layout.
 */

export * from "./FileStorage";
export * from "./types";
export * from "./encoding";
export * from "./transport/ShardClient";
export * from "./transport/SharedSpaceClient";
