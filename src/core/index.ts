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
// Hosted auth (`client.auth.hosted`) — the redirect flow plus TV device pairing.
export { HostedAuth, DevicePairingError, ReauthRequiredError, canonicalUserCode, formatUserCode } from "./namespaces/HostedAuth";
export type {
    HostedAuthDeps,
    DevicePairingSession,
    DevicePairingPoll,
    DevicePairingRequest,
    DevicePairingErrorReason,
    StartDevicePairingOptions,
    WaitForDevicePairingOptions,
    PairedDevice,
} from "./namespaces/HostedAuth";
// Paired-device persistence on the device itself (encrypted localStorage +
// non-extractable IndexedDB key). See the module docs for what that is and
// is NOT worth.
export {
    persistDeviceIdentity,
    loadDeviceIdentity,
    clearDeviceIdentity,
    hasDeviceIdentity,
    deviceIdentityKey,
    deviceFingerprint,
    deviceIdentityIsEphemeral,
    configureDeviceStore,
    DeviceStoreUnavailableError,
    DEVICE_IDENTITY_STORAGE_KEY,
    DEVICE_KEY_DB_NAME,
} from "../auth/deviceStore";
export type { PersistedDeviceIdentity, DeviceKeyVault, DeviceBlobStore, MuhkooKeystoreBridge } from "../auth/deviceStore";
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
export { VfsNamespace } from "../vfs/VfsNamespace";
export { VfsLockedError } from "../vfs/types";
export type { VfsNamespaceDeps, VfsContentStore } from "../vfs/VfsNamespace";
export type { VfsStat, VfsStore, FileEntry, DirEntry, DirNode } from "../vfs/types";
export { VcsNamespace, Repo } from "../vcs/VcsNamespace";
export type { VcsNamespaceOptions, VcsNamespaceDeps } from "../vcs/VcsNamespace";
export { VcsError, DEFAULT_BRANCH } from "../vcs/types";
export type { Commit, Tree, TreeEntry, TreeFile, Head, Change, LogEntry, Conflict, MergeResult } from "../vcs/types";
export { merge3, merge3Text } from "../vcs/merge3";
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
// Passkeys are origin-bound: `PasskeyOriginError` lets an app tell "this passkey
// belongs to another host" apart from a cancelled prompt, and
// `rpIdUsableForOrigin` answers the same question before prompting.
//
// Deciding whether to OFFER or ATTEMPT a passkey? Use `passkeyUsableFromOrigin`
// instead. It mirrors `loginWithPasskey`'s own resolution, so a factor with no
// recorded rpId (enrolled before per-origin support) counts as usable —
// `rpIdUsableForOrigin` reports false for those, and excluding them has locked
// real users out of production.
export { PasskeyOriginError, rpIdUsableForOrigin, passkeyUsableFromOrigin } from "../auth/passkey";
export { AccessTokensNamespace, ACCESS_TOKEN_SCOPES } from "./namespaces/AccessTokensNamespace";
export type {
    Scope,
    AccessTokenInfo,
    CreateAccessTokenInput,
    CreatedAccessToken,
    AccessTokensNamespaceDeps,
} from "./namespaces/AccessTokensNamespace";

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
