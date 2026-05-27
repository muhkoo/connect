import { Logger } from "../utilities/Logger";

const appLogger = new Logger("connect", 'ERROR');
globalThis.appLogger = appLogger;

export * from "../messaging";
export * from "../messaging/Packet";
export * from "../types";
// Export only crypto modules that don't depend on snarkjs/ZeroKnowledge
// (snarkjs/ffjavascript use URL.createObjectURL which is incompatible with Workers).
// Excluded: ZeroKnowledge, Authenticator, DoubleRatchetManager (all depend on snarkjs).
export * from "../crypto/primitives";
export * from "../crypto/KeyStore";
export * from "../crypto/DoubleRatchet";
export * from "../crypto/ChunkCipher";
export * from "../crypto/PassphraseWrap";
export * from "../events";
export * from "../sessions";
export * from "../transport";

// Workers-compatible Groth16 verification. Drives bn128.wasm directly; does
// not pull in @zk-kit/groth16, snarkjs, or ffjavascript (all incompatible with
// CF Workers — see src/workers/groth16-verifier.ts).
export * from "./groth16-verifier";
