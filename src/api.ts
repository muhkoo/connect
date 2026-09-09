/**
 * The canonical public surface of `@muhkoo/connect`.
 *
 * Every public symbol is reachable from exactly this file. The platform entries
 * (`src/browser/index.ts`, `src/server/index.ts`, `src/workers/index.ts`) name
 * ZERO symbols — they re-export this module, or `./api.universal` for workerd —
 * so they cannot drift from each other or from the shipped types.
 *
 * That drift was real: before this file existed the surface was hand-maintained
 * in three entries plus `src/core/index.ts`, and they disagreed on 33 + 17
 * values and 18 types. `client.db` and `VERSION` were both unreachable from the
 * browser entry, and therefore from `dist/connect.d.ts`, for their whole lives.
 *
 * TWO RULES.
 *
 *  1. Anything importable in every runtime belongs in `./api.universal`, not
 *     here. That file is the single declared platform delta; see its header for
 *     the snarkjs/circomlibjs boundary it encodes.
 *
 *  2. Adding a module here adds it to the public API of all three builds. The
 *     surface is pinned by `api-surface.txt` and asserted by
 *     `tests/api/export-surface.test.ts`, so any change shows up as a
 *     reviewable diff rather than a silent publish.
 *
 * A NOTE ON FORM, because the old comments here were wrong. The entries used to
 * claim `rollup-plugin-dts` "silently drops named cross-module re-exports".
 * It does not, and did not — verified against the installed 6.2.3, and the
 * in-tree proof is that `src/offline/index.ts` and `src/p2p/index.ts` are
 * written entirely as named re-exports and all 39 of their symbols reach
 * `dist/connect.d.ts`. The real cause of the missing types was that the d.ts
 * was rolled from a NAMESPACED entry (`export * as core from './core'`) while
 * the JS came from a flat one, so top-level `Client` was absent by ES
 * semantics, not by plugin bug. Star and named re-exports are both fine here;
 * use whichever reads better.
 */

// The Workers-safe slice: messaging, types, the untainted crypto primitives,
// events, sessions, transport, and the Groth16 verifier.
export * from "./api.universal";

// Full crypto, including the parts workerd cannot run (ZeroKnowledge,
// Authenticator, DoubleRatchetManager pull in @zk-kit/groth16).
export * from "./crypto";

// Identity + auth. `./auth` is the barrel; deviceStore and passkey are separate
// because apps need them directly (origin-bound passkey checks, paired-device
// persistence).
export * from "./auth";
export * from "./auth/deviceStore";
export * from "./auth/passkey";

// Proof-gated per-user KV (the building block under `client.kv`), and the
// chunked/encrypted/erasure-coded file storage under `client.storage`.
export * from "./personal";
export * from "./storage";

// The unified Client and its transport/session plumbing.
export * from "./core/Client";
export * from "./core/HttpClient";
export * from "./core/Session";
// `Room` is the pre-2026-05 name for `Space`, kept as an alias for consumers.
export * from "./core/Room";

// Namespaces hanging off the Client.
export * from "./core/namespaces/AuthNamespace";
export * from "./core/namespaces/HostedAuth";
export * from "./core/namespaces/KvNamespace";
export * from "./core/namespaces/DbNamespace";
export * from "./core/namespaces/FileNamespace";
export * from "./core/namespaces/MessageNamespace";
export * from "./core/namespaces/SpaceNamespace";
export * from "./core/namespaces/AgentsNamespace";
export * from "./core/namespaces/FunctionsNamespace";
export * from "./core/namespaces/AccessTokensNamespace";

// The encrypted filesystem and its history.
export * from "./vfs/VfsNamespace";
export * from "./vfs/types";
export * from "./vcs/VcsNamespace";
export * from "./vcs/types";
export * from "./vcs/merge3";

// App-describing decorators (@MuhkooAgent/@MuhkooSpace/@MuhkooDB/@MuhkooFunction).
export * from "./core/agents/describe";

// Offline caching + durable write queue + CRDT sync, and the opt-in P2P block
// exchange among Space members.
export * from "./offline";
export * from "./p2p";

// The fan-out group-encryption layer.
export * from "./spaces/Space";
export * from "./spaces/SpaceKeyring";
export * from "./spaces/SpacePacketCipher";
export * from "./spaces/KeyringClient";
export * from "./network/PacketCipher";

// Byte/base58/id helpers and the decorators. Previously reachable only from the
// server build, which is why `base58Encode` and friends were server-only.
export * from "./utilities";

// The build stamp. Previously server-only, so a browser consumer could not read
// the version that `Client` logs to the console on construction.
export { VERSION } from "./version";

// The process-global logger bootstrap. Importing this module is also what
// installs `globalThis.appLogger` for the eight modules that read it bare.
export { appLogger, Logger } from "./runtime/appLogger";
