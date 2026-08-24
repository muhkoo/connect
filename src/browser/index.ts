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
// Hosted auth (`client.auth.hosted`): the redirect flow + TV device pairing
// (startDevicePairing / waitForDevicePairing / approveDevicePairing / …).
// `HostedAuth` no longer declares its own `AuthUser` — it reuses the one from
// AuthNamespace above — so these two `export *`s can't produce an ambiguous
// (and therefore silently dropped) star export.
export * from "../core/namespaces/HostedAuth";
// The paired device's at-rest identity store (encrypted localStorage blob +
// non-extractable IndexedDB key). Read the module docs before relying on it:
// it is obfuscation, not protection.
export * from "../auth/deviceStore";
export * from "../core/namespaces/KvNamespace";
export * from "../core/namespaces/FileNamespace";
export * from "../core/namespaces/MessageNamespace";
export * from "../core/namespaces/SpaceNamespace";
export * from "../core/namespaces/AgentsNamespace";
export * from "../core/namespaces/FunctionsNamespace";
export * from "../core/namespaces/AccessTokensNamespace";
// The filesystem and its history. Flat `export *` for the same dts-plugin
// reason as the Client exports above — named re-exports are silently dropped,
// which would leave `client.vfs`/`client.vcs` usable but untypeable.
export * from "../vfs/VfsNamespace";
export * from "../vfs/types";
export * from "../vcs/VcsNamespace";
export * from "../vcs/types";
export * from "../vcs/merge3";
// WebAuthn helpers — notably `PasskeyOriginError` / `rpIdUsableForOrigin`, so an
// app can tell "this passkey belongs to another origin" from a cancelled prompt.
// Flat `export *` so the dts plugin keeps the TYPES (named re-exports get dropped).
export * from "../auth/passkey";
// App-describing decorators (@MuhkooAgent/@MuhkooSpace/@MuhkooDB/@MuhkooFunction
// + ejectAgentPrompt). Cherry-picked like the rest of core for the dts plugin.
export * from "../core/agents/describe";
// Offline layer — caching + durable write queue + CRDT sync (`client.offline`).
// Flat `export *` for the same dts-plugin reason as the Client exports above.
export * from "../offline";
// P2P layer — private Space-scoped peer block exchange over WebRTC. Opt-in.
export * from "../p2p";
// Fan-out group-encryption layer (Space, keyring, cipher). Flat `export *`
// for the same dts-plugin reason as the Client exports above.
export * from "../spaces/Space";
export * from "../spaces/SpaceKeyring";
export * from "../spaces/SpacePacketCipher";
export * from "../spaces/KeyringClient";
export * from "../network/PacketCipher";
