/**
 * End-to-end-encrypted communication sessions, built on the
 * Double Ratchet primitives in `src/crypto/`.
 *
 * `EncryptedSession` — transport-agnostic per-peer ratchet bookkeeping.
 * `BroadcastChannel` — turnkey multi-peer "room" channel composing
 * `EncryptedSession` over `WSTransport`.
 *
 * Re-exported via `export *` rather than explicit named exports so the
 * rollup-plugin-dts build (which silently drops named re-exports across
 * module boundaries) keeps everything in the public d.ts.
 */

export * from "./EncryptedSession";
export * from "./BroadcastChannel";
