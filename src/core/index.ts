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
export { VERSION } from "../version";
export { HttpClient, HttpError } from "./HttpClient";
export type { HttpClientOptions } from "./HttpClient";
export { SessionState, MemorySessionStore, LocalStorageSessionStore, defaultSessionStore } from "./Session";
export type { SessionStore, StoredSession } from "./Session";
export { Room } from "./Room";
export type { RoomDeps, RoomFileMetadata } from "./Room";
export { Space } from "../spaces/Space";
export type { SpaceDeps, SpaceFileMetadata, SpaceMessageEvent, EphemeralEvent, MessageDeletedEvent } from "../spaces/Space";
export { AuthNamespace, ZkAuth, VaultUnavailableError } from "./namespaces/AuthNamespace";
export type { AuthUser, RegisterParams, LoginOptions } from "./namespaces/AuthNamespace";
export { KvNamespace } from "./namespaces/KvNamespace";
export type { SetOptions, StorageChangeEvent } from "./namespaces/KvNamespace";
export { DbNamespace, DbTable } from "./namespaces/DbNamespace";
export type { DbFilterOp, DbWhereCondition, DbQuery, DbQueryResult } from "./namespaces/DbNamespace";
export { StorageNamespace } from "./namespaces/FileNamespace";
export type { WriteFileOptions } from "./namespaces/FileNamespace";
export { MessageNamespace } from "./namespaces/MessageNamespace";
export type { MessageSubscription } from "./namespaces/MessageNamespace";
export { SpaceNamespace, ChannelNotFoundError, ChannelExistsError } from "./namespaces/SpaceNamespace";
export type { SpaceNamespaceDeps } from "./namespaces/SpaceNamespace";
export { AgentsNamespace } from "./namespaces/AgentsNamespace";
export type {
    AgentConfig,
    AgentCreateInput,
    AgentUpdateInput,
    AgentProvisioned,
    AgentSkill,
    AgentTrigger,
    AgentTriggerType,
    AgentToolsConfig,
    AgentDbToolMode,
    AgentScopeOpts,
    AgentsNamespaceDeps,
} from "./namespaces/AgentsNamespace";
export { FunctionsNamespace, DEFAULT_FN_HOST_SUFFIX } from "./namespaces/FunctionsNamespace";
export type {
    FunctionConfig,
    FunctionDeployInput,
    FunctionUpdateInput,
    FunctionTriggers,
    FunctionTrigger,
    FunctionTriggerType,
    FunctionCaps,
    FunctionScopeOpts,
    FunctionInvokeOptions,
    FunctionsNamespaceDeps,
} from "./namespaces/FunctionsNamespace";

// Offline layer — transparent caching + durable write queue + CRDT sync
// (`client.offline`). On by default in browsers, a no-op in Node/Workers.
export * from "../offline";

// P2P layer — private Space-scoped peer block exchange over WebRTC. Opt-in.
export * from "../p2p";

// App-describing decorators — declare your agent-facing surface in code and
// eject a system prompt for a Programmable Agent.
export {
    MuhkooAgent,
    MuhkooSpace,
    MuhkooDB,
    MuhkooFunction,
    ejectAgentPrompt,
    ejectAgentTools,
    getMuhkooAppDescriptor,
} from "./agents/describe";
export type {
    MuhkooAgentMeta,
    MuhkooSpaceMeta,
    MuhkooDBMeta,
    MuhkooFunctionMeta,
    MuhkooDBAccess,
    MuhkooAppDescriptor,
    MuhkooAgentToolsConfig,
} from "./agents/describe";
