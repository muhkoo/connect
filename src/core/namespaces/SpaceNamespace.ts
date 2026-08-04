/**
 * `client.space` — the fan-out group-encryption surface.
 *
 *   const space = await client.space.createSpace({ historyPolicy: "static" });
 *   await space.sendMessage({ text: "hello" });
 *   space.onMessage(e => …);
 *
 *   const joined = await client.space.joinSpace(space.id); // newcomer
 *
 * A space owns a client-generated keypair whose public key is its id, a
 * symmetric group key distributed server-blind via the keyring, and a
 * persisted message log. This namespace wires the {@link Space} handle to the
 * HTTP {@link KeyringClient}, the member's identity keys (from {@link KeyStore},
 * shared with the Double Ratchet path), and a PersonalSpace-backed key cache.
 */

import type { HttpClient } from "../HttpClient";
import { HttpError } from "../HttpClient";
import type { SessionState } from "../Session";
import { KeyStore } from "../../crypto/KeyStore";
import { Space } from "../../spaces/Space";
import { SpaceKeyring, KEEPER_MEMBER_ID, type SpaceKeyCache } from "../../spaces/SpaceKeyring";
import { KeyringClient } from "../../spaces/KeyringClient";
import { generateSpaceIdentity, exportEcdhPublicKey, exportEcdsaPublicKey } from "../../spaces/SpaceCipher";
import type { HistoryPolicy, InviteLink } from "../../spaces/types";
import type { OfflineManager } from "../../offline/OfflineManager";
import { SpaceCache } from "../../offline/SpaceCache";
import { PeerNetwork } from "../../p2p/PeerNetwork";
import { isP2pCapable } from "../../p2p/detect";
import type { ChatKeyVault } from "../ChatKeyVault";
import { toBase64 } from "../../utilities";

/** Thrown by `joinChannel` when no channel with that name is registered. */
export class ChannelNotFoundError extends Error {
    constructor(readonly channelName: string) {
        super(`Channel "${channelName}" does not exist. Create it first.`);
        this.name = "ChannelNotFoundError";
    }
}

/** Thrown by `createChannel` when the name is already registered. */
export class ChannelExistsError extends Error {
    constructor(readonly channelName: string) {
        super(`Channel "${channelName}" already exists.`);
        this.name = "ChannelExistsError";
    }
}

export interface SpaceNamespaceDeps {
    http: HttpClient;
    session: SessionState;
    /** WebSocket base (ws/wss); derived from the accelerator baseUrl. */
    wsBaseUrl: string;
    /** Optional PersonalSpace-backed cache of group keys (encrypted at rest). */
    cache?: SpaceKeyCache;
    /** Offline manager — enables message caching + offline send replay. */
    offline?: OfflineManager;
    /** SDK-owned ratchet-keypair vault — gives a STABLE member keypair across
     *  reloads (rehydrate-or-provision) instead of a fresh one each session. */
    chatKeys?: ChatKeyVault;
    /** P2P swarm config — enables peer block exchange among Space members. */
    p2p?: {
        enabled?: boolean;
        /** `() => new Worker(new URL(...))` to run the block engine off-thread. */
        workerFactory?: () => Worker;
        iceServers?: RTCIceServer[];
        maxPeers?: number;
        debug?: boolean;
    };
}

export class SpaceNamespace {
    private spaceCache?: SpaceCache;
    /** Spaces built this session, by id — used to route offline send replays. */
    private readonly openSpaces = new Map<string, Space>();
    /** Unique id for THIS device/session — the P2P peer identity. A user's own
     *  devices share a member id, so the mesh MUST distinguish them by this or a
     *  device treats its siblings' signals as its own echo and never connects. */
    private readonly deviceId =
        `peer-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)}`;

    constructor(private readonly deps: SpaceNamespaceDeps) {
        if (deps.offline?.enabled) {
            this.spaceCache = new SpaceCache(deps.offline);
            // Replay queued space frames on reconnect: route each to its space
            // (reopening + connecting it if needed), then re-send the raw frame.
            deps.offline.registerReplayer("space", async (entry) => {
                const { spaceId, frame } = entry.args as { spaceId: string; frame: unknown };
                let space = this.openSpaces.get(spaceId);
                if (!space) space = await this.get(spaceId);
                await space.connect();
                if (!space.isConnected()) throw new Error(`space ${spaceId} not connected for replay`);
                space.sendRaw(frame);
            });
        }
    }

    /**
     * Create a new space: generate its keypair (public key = id), register
     * metadata, mint the initial group key, and connect. Returns the open Space.
     */
    async createSpace(opts: { historyPolicy?: HistoryPolicy; private?: boolean } = {}): Promise<Space> {
        const historyPolicy = opts.historyPolicy ?? "static";
        const identity = await generateSpaceIdentity();
        // Register the space (server records pubkey + policy; the DO is lazy).
        // For a private space the server also records the creator (this user) as
        // its first member — so the metadata POST must carry the user session.
        await this.deps.http.post(
            `/api/spaces/${encodeURIComponent(identity.id)}/metadata`,
            { spacePubKey: identity.id, historyPolicy, visibility: opts.private ? "private" : "public" },
        );
        const space = await this.build(identity.id, historyPolicy);
        await space.create();
        return space;
    }

    /** Join an existing space by id (its public key). Resolves once a key arrives. */
    async joinSpace(spaceId: string, opts: { timeoutMs?: number } = {}): Promise<Space> {
        const policy = await this.fetchPolicy(spaceId);
        const space = await this.build(spaceId, policy);
        await space.join({ timeoutMs: opts.timeoutMs });
        return space;
    }

    /** A handle to a space without auto-connecting (uses cached keys on demand). */
    async get(spaceId: string, historyPolicy: HistoryPolicy = "static"): Promise<Space> {
        return this.build(spaceId, historyPolicy);
    }

    // -------------------------------------------------------------------------
    // Channels — named, app-scoped pointers to spaces. The name → space-id
    // directory is app-public config (server-readable, scoped to this app via
    // its key); the channel CONTENTS stay fan-out E2E-encrypted. Lets chat use
    // human room names (`general`) instead of raw pubkey ids.
    // -------------------------------------------------------------------------

    /** List this app's channels (name → space-id) for the key's environment. */
    async listChannels(): Promise<Array<{ name: string; spaceId: string }>> {
        const body = await this.deps.http.get<{ channels?: Array<{ name: string; spaceId: string }> }>(
            "/api/app/channels",
        );
        return body.channels ?? [];
    }

    /** Resolve a channel name to its space id, or null if it doesn't exist. */
    async resolveChannel(name: string): Promise<string | null> {
        try {
            const body = await this.deps.http.get<{ spaceId: string }>(
                `/api/app/channels/${encodeURIComponent(name)}`,
            );
            return body.spaceId ?? null;
        } catch (err) {
            if (err instanceof HttpError && err.status === 404) return null;
            throw err;
        }
    }

    /**
     * Create a new channel: mint a fan-out space (the caller becomes its first
     * key-holder) and register `name → spaceId` in the app directory. Throws
     * {@link ChannelExistsError} if the name is already taken.
     */
    async createChannel(name: string, opts: { historyPolicy?: HistoryPolicy; private?: boolean } = {}): Promise<Space> {
        const space = await this.createSpace(opts);
        // Register name → id first so a name clash doesn't leave an admitted keeper.
        try {
            await this.deps.http.post("/api/app/channels", { name, spaceId: space.id, visibility: opts.private ? "private" : "public" });
        } catch (err) {
            if (err instanceof HttpError && err.status === 409) {
                throw new ChannelExistsError(name);
            }
            throw err;
        }
        // Admit the app keeper so the channel is joinable with no member online.
        // Best-effort: a channel still works (members admit each other) without it.
        try {
            const { pubkey } = await this.deps.http.get<{ pubkey?: string }>("/api/app/keeper");
            if (pubkey && space.keyring) await space.keyring.admit(KEEPER_MEMBER_ID, pubkey);
        } catch (err) {
            console.warn("[client.space] keeper admit failed (channel still usable):", err);
        }
        return space;
    }

    /**
     * Join an existing channel by name. Throws {@link ChannelNotFoundError} if
     * no channel with that name is registered (use {@link createChannel} first).
     */
    async joinChannel(name: string, opts: { timeoutMs?: number } = {}): Promise<Space> {
        const spaceId = await this.resolveChannel(name);
        if (!spaceId) throw new ChannelNotFoundError(name);
        return this.joinSpace(spaceId, opts);
    }

    // -------------------------------------------------------------------------
    // Invite links — shareable, keeper-gated invitations to a space. The token
    // is a capability: anyone signed in who redeems it is admitted by the
    // keeper. Mint/list/revoke require the caller to be the space's creator or
    // an existing member.
    // -------------------------------------------------------------------------

    /** Mint a shareable invite link for a space. `opts.expiresInSec` / `maxUses`
     *  bound it (0/undefined = unlimited); `opts.role` ("viewer"|"editor") is the
     *  access granted to redeemers (default viewer). Returns the link. */
    async createInviteLink(spaceId: string, opts: { expiresInSec?: number; maxUses?: number; role?: string } = {}): Promise<InviteLink> {
        return this.keyringFor(spaceId).createInviteLink(opts);
    }

    /** Set a member's role on a space ("viewer" | "editor"). Owner-only. */
    async setMemberRole(spaceId: string, username: string, role: string): Promise<void> {
        await this.keyringFor(spaceId).setMemberRole(username, role);
    }

    /** Roster with roles (owner/members only). */
    async members(spaceId: string): Promise<Array<{ memberId: string; role: string }>> {
        return this.keyringFor(spaceId).members();
    }

    /** List a space's active invite links (creator/members only). */
    async listInviteLinks(spaceId: string): Promise<InviteLink[]> {
        return this.keyringFor(spaceId).listInviteLinks();
    }

    /** Revoke an invite link by token. */
    async revokeInviteLink(spaceId: string, token: string): Promise<void> {
        await this.keyringFor(spaceId).revokeInviteLink(token);
    }

    /**
     * Join a space using an invite link: redeem the token (the keeper admits
     * this member), then connect and resolve once the group key arrives.
     * Returns the open {@link Space}.
     */
    async joinByInvite(spaceId: string, token: string, opts: { timeoutMs?: number } = {}): Promise<Space> {
        const memberId = this.myId();
        const { ecdhPub, ecdsaPub } = await this.ensureIdentity(memberId);
        await this.keyringFor(spaceId).redeemInvite({ token, identityEcdhPub: ecdhPub, identityEcdsaPub: ecdsaPub });
        return this.joinSpace(spaceId, opts);
    }

    /** The current member roster of a space (member id → identity public keys). */
    async roster(spaceId: string): Promise<Array<{ memberId: string; identityEcdhPub: string; identityEcdsaPub?: string }>> {
        return this.keyringFor(spaceId).fetchRoster();
    }

    private keyringFor(spaceId: string): KeyringClient {
        return new KeyringClient({
            spaceId,
            httpBaseUrl: this.deps.http.baseUrl,
            fetch: this.deps.http.fetch,
        });
    }

    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------

    private async build(spaceId: string, historyPolicy: HistoryPolicy): Promise<Space> {
        const memberId = this.myId();
        const { ecdhPub, ecdsaPub } = await this.ensureIdentity(memberId);
        const transport = new KeyringClient({
            spaceId,
            httpBaseUrl: this.deps.http.baseUrl,
            fetch: this.deps.http.fetch,
        });
        const keyring = new SpaceKeyring({
            spaceId,
            memberId,
            identityEcdhPub: ecdhPub,
            identityEcdsaPub: ecdsaPub,
            ownPrivateKey: () => KeyStore.getInstance().getKeyPair(memberId)?.privateKey ?? null,
            transport,
            cache: this.deps.cache,
            historyPolicy,
        });
        const space = new Space({
            name: spaceId,
            wsBaseUrl: this.deps.wsBaseUrl,
            httpBaseUrl: this.deps.http.baseUrl,
            fetch: this.deps.http.fetch,
            myId: () => memberId,
            fetchTicket: () => this.fetchTicket(),
            keyring,
            historyPolicy,
            offline: this.spaceCache,
            shardCache: this.deps.offline?.fileCache,
            deferShardUpload: this.deps.offline
                ? (hash: string) => this.deps.offline!.deferShardUpload(hash)
                : undefined,
        });
        this.openSpaces.set(spaceId, space);
        // Attach a private P2P swarm scoped to this Space (block exchange among
        // members; signaled over the Space relay). Discovery starts on connect.
        if (this.deps.p2p?.enabled && isP2pCapable()) {
            space.attachPeerNetwork(
                new PeerNetwork({
                    space,
                    myId: this.deviceId, // per-device peer id, NOT the shared member id
                    workerFactory: this.deps.p2p.workerFactory,
                    iceServers: this.deps.p2p.iceServers,
                    maxPeers: this.deps.p2p.maxPeers,
                    debug: this.deps.p2p.debug,
                }),
            );
        }
        return space;
    }

    /** Ensure the member has an identity keypair; return its public ECDH + ECDSA keys. */
    private async ensureIdentity(memberId: string): Promise<{ ecdhPub: string; ecdsaPub: string }> {
        const store = KeyStore.getInstance();
        if (!store.getKeyPair(memberId)) {
            // Unlocked (seed in hand): rehydrate the member's STABLE keypair from
            // the vault, or provision + persist one on first use. This keeps the
            // member the same identity across reloads — no re-admit each session,
            // and the group-key cache round-trips. Best-effort: a personal-space
            // hiccup falls through to an ephemeral keypair (today's behavior).
            const seed = this.deps.session.seed;
            const staging = (() => { try { return typeof location !== "undefined" && /(^|\.)staging\./.test(location.hostname); } catch { return false; } })();
            if (staging) console.info(`[muhkoo:vault] ensureIdentity: unlocked=${!!seed} vault=${!!this.deps.chatKeys}`);
            if (this.deps.chatKeys && seed) {
                try {
                    await this.deps.chatKeys.ensure(memberId, toBase64(seed));
                } catch (e) {
                    if (staging) console.info(`[muhkoo:vault] ensureIdentity: vault.ensure failed — ${e instanceof Error ? e.message : e}`);
                }
            }
            if (!store.getKeyPair(memberId)) {
                if (staging) console.info("[muhkoo:vault] ensureIdentity: EPHEMERAL keypair (locked / no vault) → will re-admit");
                await store.generateOwnKeyPair(memberId);
            }
        }
        const ecdhPub = await exportEcdhPublicKey(store.getKeyPair(memberId)!.publicKey);
        const ecdsaPub = await exportEcdsaPublicKey(store.getAuthKeyPair(memberId)!.publicKey);
        return { ecdhPub, ecdsaPub };
    }

    private async fetchPolicy(spaceId: string): Promise<HistoryPolicy> {
        const meta = await new KeyringClient({
            spaceId,
            httpBaseUrl: this.deps.http.baseUrl,
            fetch: this.deps.http.fetch,
        }).fetchMetadata();
        return meta?.historyPolicy ?? "static";
    }

    private async fetchTicket(): Promise<string | null> {
        try {
            const res = await this.deps.http.post<{ ticket: string }>("/api/ws-ticket", {});
            return res?.ticket ?? null;
        } catch {
            return null;
        }
    }

    private myId(): string {
        const id = this.deps.session.username;
        if (!id) throw new Error("client.space: not signed in — call client.auth.zk.login() first.");
        return id;
    }
}

export default SpaceNamespace;
