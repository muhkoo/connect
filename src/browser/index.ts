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
// FileStorage + ShardClient + SharedSpaceClient (session-based, no snarkjs).
// Wrapped by `client.storage` on the unified Client.
export * from "../storage";
// AuthClient — `/api/auth/*` HTTP wrapper. Browser + server only; the
// workers build is the auth backend itself, no point importing the client.
export * from "../auth";
// Unified Client facade — the supported entry point. These use the `export *`
// form (not named `export { … } from`) because rollup-plugin-dts silently
// drops named cross-module re-exports in this codebase's layout, which would
// strip `Client` et al. from the rolled-up `connect.d.ts`. The class modules
// don't re-run core's appLogger setup (that lives in `../core/index`, which we
// deliberately don't import here).
export * from "../core/Client";
export * from "../core/HttpClient";
export * from "../core/Session";
export * from "../core/Room";
export * from "../core/namespaces/AuthNamespace";
export * from "../core/namespaces/KvNamespace";
export * from "../core/namespaces/FileNamespace";
export * from "../core/namespaces/MessageNamespace";
export * from "../core/namespaces/SpaceNamespace";
export * from "../core/namespaces/AgentsNamespace";
export * from "../core/namespaces/FunctionsNamespace";
// Fan-out group-encryption layer (Space, keyring, cipher). Flat `export *`
// for the same dts-plugin reason as the Client exports above.
export * from "../spaces/Space";
export * from "../spaces/SpaceKeyring";
export * from "../spaces/SpacePacketCipher";
export * from "../spaces/KeyringClient";
export * from "../network/PacketCipher";
