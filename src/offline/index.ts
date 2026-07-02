/**
 * Offline layer — transparent, on-by-default-in-browsers caching + write
 * queue + CRDT sync for the unified {@link ../core/Client}. See
 * {@link ./OfflineManager} for the runtime entry point (`client.offline`).
 */

export { OfflineManager } from "./OfflineManager";
export type { OfflineManagerDeps } from "./OfflineManager";
export { ConnectivityManager } from "./ConnectivityManager";
export type { ConnectivityState, ConnectivityOptions } from "./ConnectivityManager";
export { SyncEngine } from "./SyncEngine";
export { OutboundQueue } from "./OutboundQueue";
export type { Replayer } from "./OutboundQueue";
export { SnapshotNamespace } from "./namespaces/SnapshotNamespace";
export type { SnapshotNamespaceDeps } from "./namespaces/SnapshotNamespace";
export { SpaceCache, padHandle } from "./SpaceCache";
export type { SpaceCursor } from "./SpaceCache";
export { KvCache } from "./KvCache";
export type { KvEntry } from "./KvCache";
export { DbCache, stableStringify } from "./DbCache";
export type { DbQueryPage } from "./DbCache";
export { ShardCache } from "./cache/ShardCache";
export { OfflineLockedError } from "./errors";
export { isOfflineCapable } from "./detect";

// Stores
export type { OfflineStore, OfflineEntry, QueueEntry } from "./store/OfflineStore";
export { IndexedDbStore } from "./store/IndexedDbStore";
export { NoopStore } from "./store/NoopStore";
export type { StoreName } from "./store/schema";

// Clock + CRDT primitives (useful for advanced consumers / tests).
export { HLC } from "./clock/HLC";
export type { HlcState } from "./clock/HLC";
export {
    pack,
    unpack,
    compareHlc,
    isNewer,
    ZERO_HLC,
    type HlcParts,
} from "./clock/HlcTimestamp";
export * from "./crdt/merge";
