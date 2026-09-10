/**
 * The Workers-safe slice of the public surface.
 *
 * This is the ONLY place a platform delta is expressed. Everything here is
 * importable in every runtime the SDK targets — Node, browsers, and Cloudflare
 * Workers — because nothing in its import closure reaches a package that
 * workerd cannot run.
 *
 * EXCLUDED, and why. Four packages break the Workers build (they need
 * `URL.createObjectURL` / `worker_threads`): `snarkjs`, `@zk-kit/groth16`,
 * `circomlibjs`, `ffjavascript`. The entire repo reaches them through just six
 * edges, so the boundary is narrower than it looks:
 *
 *   src/crypto/ZeroKnowledge.ts:1    import '@zk-kit/groth16'      (static)
 *   src/crypto/ZeroKnowledge.ts:84   import('circomlibjs')         (dynamic)
 *   src/auth/poseidon.ts:16          import 'circomlibjs'          (static)
 *   src/auth/proof.ts:39             import('snarkjs')             (dynamic)
 *   src/personal/PersonalSpaceClient.ts:40  import('snarkjs')      (dynamic)
 *
 * Those taint exactly: `crypto/{ZeroKnowledge,Authenticator,DoubleRatchetManager,index}`,
 * `auth/{poseidon,proof,index}`, `core/{Client,namespaces/AuthNamespace,namespaces/HostedAuth}`,
 * and all of `personal/`. Everything else under `src/` is clean.
 *
 * TWO TRAPS worth knowing before editing this file:
 *
 *  1. The crypto imports below are DEEP on purpose. `src/crypto/index.ts` is the
 *     tainted barrel (it re-exports ZeroKnowledge); switching any of these five
 *     to `export * from "./crypto"` breaks the Workers build immediately.
 *
 *  2. `src/personal` is tainted ONLY dynamically, so it looks clean to a
 *     static-import check. The Workers build inlines dynamic imports
 *     (`inlineDynamicImports: true`), so adding it would bundle snarkjs and
 *     fail at deploy with no earlier signal. Do not add it.
 *
 * The `no-snarkjs closure` assertion in `tests/api/export-surface.test.ts`
 * enforces all of the above by walking the real static AND dynamic import graph.
 */

export * from "./messaging";
export * from "./messaging/Packet";
export * from "./types";

// Deep crypto imports — see trap 1 above.
export * from "./crypto/primitives";
export * from "./crypto/KeyStore";
export * from "./crypto/DoubleRatchet";
export * from "./crypto/ChunkCipher";
export * from "./crypto/PassphraseWrap";

export * from "./events";
export * from "./sessions";
export * from "./transport";

// Universal Groth16 verification. Drives bn128.wasm directly, with no snarkjs /
// ffjavascript dependency, so it runs anywhere WebAssembly does. This is the
// reason the Workers build exists at all.
export * from "./workers/groth16-verifier";
