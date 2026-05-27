import { Logger } from "../utilities/Logger";

const appLogger = new Logger("connect", 'ERROR');
globalThis.appLogger = appLogger;

export * from "../messaging";
export * from "../messaging/Packet";
export * from "../types";
export * from "../crypto";
export * from "../events";
export * from "../sessions";
export * from "../transport";
// Universal Groth16 verifier (bn128.wasm-driven). Works anywhere WebAssembly
// runs: Node, browsers, CF Workers. The same code path the workers build uses.
export * from "../workers/groth16-verifier";
// PersonalSpaceClient + passphrase wrap helpers. Pulls in snarkjs as an
// external — the consuming app's import map (or bundler) resolves it.
export * from "../personal";
