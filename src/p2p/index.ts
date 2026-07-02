/**
 * P2P layer — private, Space-scoped peer block exchange over WebRTC, with the
 * block engine hostable in a Web Worker. Best-effort: a miss falls back to
 * origin (R2). See {@link ./PeerNetwork} for the runtime entry point.
 */

export { PeerNetwork } from "./PeerNetwork";
export type { PeerNetworkOptions } from "./PeerNetwork";
export { PeerExchange } from "./PeerExchange";
export type { EngineHandle, PeerExchangeOptions } from "./PeerExchange";
// `PeerBlockSource` is canonically exported from the storage layer (ShardClient).
export { isP2pCapable } from "./detect";

// Transport
export { WebRtcTransport } from "./transport/WebRtcTransport";
export type { WebRtcTransportOptions } from "./transport/WebRtcTransport";
export type { PeerTransport, PeerId } from "./transport/PeerTransport";

// Signaling
export { SpaceSignaler, P2P_SUBJECT } from "./signaling/SpaceSignaler";
export type { SignalingSpace, SignalKind, SignalEnvelope } from "./signaling/SpaceSignaler";

// Block engine + hosts
export { BlockEngine } from "./worker/blockEngine";
export type { BlockStore, OutSink, Hasher } from "./worker/blockEngine";
export { LocalEngineHost } from "./worker/engineHost";
export type { EngineHost } from "./worker/engineHost";
export { WorkerEngineHost } from "./worker/engineClient";

// Wire protocol (advanced / interop)
export * as protocol from "./worker/protocol";
