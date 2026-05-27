// Canonical home for all encryption code. Higher layers (storage, personal,
// sessions) compose these primitives + helpers rather than calling
// `crypto.subtle` directly.

export * from "./primitives";

// Ratchet stack — ECDH + per-pair Double Ratchet state.
export * from "./KeyStore";
export * from "./DoubleRatchet";
export * from "./DoubleRatchetManager";

// ZK identity + token auth (snarkjs-dependent; excluded from the workers build).
export * from "./Authenticator";
export * from "./ZeroKnowledge";

// Symmetric helpers used by the storage + personal-space layers.
export * from "./ChunkCipher";
export * from "./PassphraseWrap";
