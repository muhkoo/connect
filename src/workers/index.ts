import { Logger } from "../utilities/Logger";

const appLogger = new Logger("connect", 'ERROR');
globalThis.appLogger = appLogger;

export * from "../messaging";
export * from "../messaging/Packet";
export * from "../types";
// Export only crypto modules that don't depend on snarkjs/ZeroKnowledge
// (snarkjs/ffjavascript use URL.createObjectURL which is incompatible with Workers)
// Excluded: ZeroKnowledge, Authenticator, DoubleRatchetManager (all depend on snarkjs)
export * from "../crypto/KeyStore";
export * from "../crypto/DoubleRatchet";
export * from "../events";

// Re-export @zk-kit/groth16 verify for Workers-compatible ZK proof verification
// Note: Only verification is supported in Workers (no proof generation)
// The rollup config patches ffjavascript to avoid URL.createObjectURL
export { verify as verifyGroth16Proof, buildBn128 } from "@zk-kit/groth16";
