import Client from "./Client";
import { Logger } from "../utilities/Logger";

declare global {
    var appLogger: InstanceType<typeof Logger>;
}

const appLogger = new Logger("connect", 'ERROR');
globalThis.appLogger = appLogger;

export {
    appLogger,
    Logger,
    Client,
};

// Unified client surface.
export { DEFAULT_BASE_URL } from "./Client";
export type { ClientOptions } from "./Client";
export { HttpClient, HttpError } from "./HttpClient";
export type { HttpClientOptions } from "./HttpClient";
export { SessionState, MemorySessionStore, LocalStorageSessionStore, defaultSessionStore } from "./Session";
export type { SessionStore, StoredSession } from "./Session";
export { Room } from "./Room";
export type { RoomDeps, RoomFileMetadata } from "./Room";
export { Space } from "../spaces/Space";
export type { SpaceDeps, SpaceFileMetadata, SpaceMessageEvent, EphemeralEvent, MessageDeletedEvent } from "../spaces/Space";
export { AuthNamespace, ZkAuth } from "./namespaces/AuthNamespace";
export type { AuthUser, RegisterParams, LoginOptions } from "./namespaces/AuthNamespace";
export { StorageNamespace } from "./namespaces/StorageNamespace";
export type { SetOptions, StorageChangeEvent } from "./namespaces/StorageNamespace";
export { MessageNamespace } from "./namespaces/MessageNamespace";
export type { MessageSubscription } from "./namespaces/MessageNamespace";
export { SpaceNamespace, ChannelNotFoundError, ChannelExistsError } from "./namespaces/SpaceNamespace";
export type { SpaceNamespaceDeps } from "./namespaces/SpaceNamespace";
