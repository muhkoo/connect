/**
 * Spaces — the fan-out group-encryption layer.
 *
 * A `Space` (formerly `Room`) is the unit everything builds on: a client-owned
 * keypair (public key = id), a symmetric group key distributed server-blind via
 * the keyring, single-seal fan-out messages persisted as history, plus the
 * legacy Double Ratchet + file surface.
 */

export { Space, type SpaceDeps, type SpaceFileMetadata, type SpaceMessageEvent } from "./Space";
export {
    SpaceKeyring,
    KEEPER_MEMBER_ID,
    type KeyringTransport,
    type SpaceKeyCache,
    type SpaceKeyringDeps,
} from "./SpaceKeyring";
export { KeyringClient, type KeyringClientDeps } from "./KeyringClient";
export { SpacePacketCipher, type EpochKeyProvider } from "./SpacePacketCipher";
export * as cipher from "./SpaceCipher";
export type {
    HistoryPolicy,
    WrappedKey,
    SpaceMetadata,
    JoinRequest,
    SealedPacketHeaders,
} from "./types";
