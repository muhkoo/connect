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
import { generateSpaceIdentity, exportEcdhPublicKey } from "../../spaces/SpaceCipher";
import type { HistoryPolicy } from "../../spaces/types";

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
}

export class SpaceNamespace {
    constructor(private readonly deps: SpaceNamespaceDeps) {}

    /**
     * Create a new space: generate its keypair (public key = id), register
     * metadata, mint the initial group key, and connect. Returns the open Space.
     */
    async createSpace(opts: { historyPolicy?: HistoryPolicy } = {}): Promise<Space> {
        const historyPolicy = opts.historyPolicy ?? "static";
        const identity = await generateSpaceIdentity();
        // Register the space (server records pubkey + policy; the DO is lazy).
        await this.deps.http.post(
            `/api/spaces/${encodeURIComponent(identity.id)}/metadata`,
            { spacePubKey: identity.id, historyPolicy },
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
    async createChannel(name: string, opts: { historyPolicy?: HistoryPolicy } = {}): Promise<Space> {
        const space = await this.createSpace(opts);
        // Register name → id first so a name clash doesn't leave an admitted keeper.
        try {
            await this.deps.http.post("/api/app/channels", { name, spaceId: space.id });
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
    // Internals
    // -------------------------------------------------------------------------

    private async build(spaceId: string, historyPolicy: HistoryPolicy): Promise<Space> {
        const memberId = this.myId();
        const identityEcdhPub = await this.ensureIdentity(memberId);
        const transport = new KeyringClient({
            spaceId,
            httpBaseUrl: this.deps.http.baseUrl,
            fetch: this.deps.http.fetch,
        });
        const keyring = new SpaceKeyring({
            spaceId,
            memberId,
            identityEcdhPub,
            ownPrivateKey: () => KeyStore.getInstance().getKeyPair(memberId)?.privateKey ?? null,
            transport,
            cache: this.deps.cache,
            historyPolicy,
        });
        return new Space({
            name: spaceId,
            wsBaseUrl: this.deps.wsBaseUrl,
            httpBaseUrl: this.deps.http.baseUrl,
            fetch: this.deps.http.fetch,
            myId: () => memberId,
            fetchTicket: () => this.fetchTicket(),
            keyring,
            historyPolicy,
        });
    }

    /** Ensure the member has an identity ECDH keypair; return its public key. */
    private async ensureIdentity(memberId: string): Promise<string> {
        const store = KeyStore.getInstance();
        if (!store.getKeyPair(memberId)) {
            await store.generateOwnKeyPair(memberId);
        }
        const pub = store.getKeyPair(memberId)!.publicKey;
        return exportEcdhPublicKey(pub);
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
