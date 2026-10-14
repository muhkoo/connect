/**
 * `Space` — a client handle for one shared space.
 *
 * A space is the unit everything is built on. It carries:
 *   - **realtime transport** over a {@link BroadcastChannel} (group handshake,
 *     roster frames, raw-frame passthrough);
 *   - **fan-out group messaging** — `Message`s sealed once with the space's
 *     group key (via {@link SpacePacketCipher}), wrapped in a cleartext
 *     {@link Packet} envelope, broadcast AND persisted by the server as
 *     history (the `spaceMessage` frame);
 *   - **room-scoped file storage** via {@link FileStorage} over the shard
 *     endpoint;
 *   - **legacy per-peer Double Ratchet messaging** (`send`/`announce`) for the
 *     ephemeral, no-history path — unchanged so existing callers (the chat hook
 *     reached via `client.message.room(name)`) keep working.
 *
 * `Space` was formerly `Room`; `Room` remains exported as an alias. The
 * fan-out methods (`sendMessage`/`onMessage`/`history`/`join`/`admit`/`rotate`)
 * require a {@link SpaceKeyring} dep; without one only the transport + DR +
 * file surface is available.
 */

import { BroadcastChannel, BroadcastChannelEvents } from "../sessions/BroadcastChannel";
import { FileStorage } from "../storage/FileStorage";
import { ShardClient, type ShardByteCache, type PeerBlockSource } from "../storage/transport/ShardClient";
import { commitManifest } from "../storage/transport/storageCommit";
import type { FileManifest, FileStat } from "../storage/types";
import { Message } from "../messaging/Message";
import { Packet } from "../messaging/Packet";
import { SpacePacketCipher } from "./SpacePacketCipher";
import type { SpaceKeyring } from "./SpaceKeyring";
import { canonicalMessage, signSpaceMessage, verifySpaceMessage } from "./SpaceCipher";
import { KeyStore } from "../crypto/KeyStore";
import type { JoinRequest, HistoryPolicy } from "./types";
import { AdmissionDeniedError, IdentityLockedError, SpaceTrustError } from "../core/trust/errors";
import type { LogSync, MemberView } from "./trust/LogSync";
import { ecBytes, keyCommit } from "./trust/canonical";
import { ikEquals } from "./trust/ik";
import { KeyringHttpError } from "./KeyringClient";
import { log as logger } from "../utilities";

type Listener = (e: CustomEvent) => void;

/**
 * A P2P swarm attached to a Space (the p2p layer's `PeerNetwork` satisfies this
 * structurally — Space never imports the p2p module). `exchange` is consulted by
 * the Space's file `ShardClient`; `start` runs peer discovery on connect; `close`
 * tears the mesh down.
 */
export interface AttachedPeerNetwork {
    readonly exchange: PeerBlockSource;
    start(): void;
    close(): void;
    gossip(data: Uint8Array): void;
    onGossip(cb: (from: string, data: Uint8Array) => void): () => void;
}

export interface SpaceFileMetadata {
    name: string;
    type: string;
    path?: string;
    lastModified?: number;
}

/** A decrypted inbound fan-out message. */
export interface SpaceMessageEvent {
    from: string;
    channel: string;
    epoch: number;
    contentType?: string;
    /**
     * Server storage handle — the monotonic server timestamp this message is
     * persisted under (`msg:<handle>`). Stable across history replay; pass it to
     * {@link Space.editMessage} / {@link Space.deleteMessage} to mutate the
     * persisted entry. Carried on edit events too (same handle as the original).
     */
    handle: number;
    message: Message;
    /**
     * Sender-generated id, present on locally-originated messages (carried in the
     * cleartext `cid` header). Lets the UI dedupe an optimistic send against its
     * server echo, and the offline cache replace a pending entry with the real one.
     */
    clientId?: string;
    /** True for an optimistic local send not yet acknowledged by the server. */
    pending?: boolean;
}

/**
 * One sealed message frame as cached for offline use. The `packet` is the
 * ciphertext-bearing serialized {@link Packet} (decrypted lazily on read), so
 * nothing readable is persisted. Structurally matches the offline layer's
 * `MessageEntry`; declared here so the spaces module doesn't import `../offline`.
 */
export interface CachedSpaceMessage {
    handle: string;
    packet: string | null;
    op: "msg" | "edit" | "delete";
    clientId?: string;
    hlc?: string;
    pending?: boolean;
    deleted?: boolean;
}

/** The offline adapter a {@link Space} drives. Implemented by `SpaceCache`. */
export interface SpaceOfflineAdapter {
    readonly enabled: boolean;
    newClientId(): string;
    nextHlc(): Promise<string>;
    putMessage(spaceId: string, entry: CachedSpaceMessage): Promise<void>;
    putDeleted(spaceId: string, handle: number): Promise<void>;
    dropPending(spaceId: string, clientId: string): Promise<void>;
    loadMessages(spaceId: string): Promise<CachedSpaceMessage[]>;
    getCursor(spaceId: string): Promise<{ lastSeenHandle: number; oldestHandle: number } | null>;
    observeHandle(spaceId: string, handle: number): Promise<void>;
    enqueueFrame(spaceId: string, frame: unknown, clientId: string, hlc: string): Promise<void>;
    registerCatchUp(task: () => Promise<void>): () => void;
}

/**
 * An inbound ephemeral signal — an application broadcast the server relays to
 * the room but never persists (no history). Rides the generic `pub` relay:
 * `subject` is an app-defined routing key, `data` is opaque app JSON, and
 * `from` is the server-authenticated sender. Typing indicators, presence pings,
 * live cursors, etc. are built on top of this in the app layer — the SDK and
 * server stay domain-agnostic.
 */
export interface EphemeralEvent {
    /** Server-stamped authenticated sender. */
    from: string;
    /** Application-defined routing key (e.g. "typing"). */
    subject: string;
    /** Opaque application payload. */
    data: unknown;
}

/** A server-authoritative deletion of the persisted message at `handle`. */
export interface MessageDeletedEvent {
    handle: number;
}

export type AdmissionState = "locked" | "requesting" | "keyed" | "not-member" | "identity-mismatch" | "integrity";

/** WebSocket close code for a refused private-Space socket (design §3.6; accelerator NOT_MEMBER_CLOSE_CODE). */
export const NOT_MEMBER_CLOSE_CODE = 4403;
/** At most one resume after a 4403 per Space per this interval (design §6.7). */
export const NOT_MEMBER_RECHECK_MS = 60_000;

const NOT_MEMBER_MESSAGE = "You're not a member of this private channel. Ask the owner to add you.";
const IDENTITY_MISMATCH_MESSAGE = "The owner added a different identity for you. Ask them to re-add you.";

export interface SpaceDeps {
    /** Transport room id. For fan-out spaces this is the encoded space pubkey. */
    name: string;
    wsBaseUrl: string;
    httpBaseUrl: string;
    /** Header-injecting fetch from the client's HttpClient. */
    fetch: typeof fetch;
    /**
     * The same fetch with the client's silent 401 recovery (`HttpClient.fetchWithRecovery`). File uploads
     * use it, so a PUT made with a dead session re-establishes the session once instead of failing.
     * Defaults to {@link fetch}.
     */
    fetchWithRecovery?: typeof fetch;
    /** Resolves the user id used for the ratchet / member id (signed-in username). */
    myId: () => string;
    /** Resolves a short-lived WS upgrade ticket (or null when keyless). */
    fetchTicket: () => Promise<string | null>;
    /** Optional group-key keyring — required for the fan-out methods. */
    keyring?: SpaceKeyring;
    /** History policy for this space (advisory; defaults to static). */
    historyPolicy?: HistoryPolicy;
    /**
     * When true (default), a connected member that holds the group key
     * automatically wraps it for any newcomer that posts a join request —
     * the "any online key-holder admits" model. Set false to gate membership
     * yourself via `onJoinRequest` + `admit`.
     */
    autoAdmit?: boolean;
    /**
     * Test seam — defaults to constructing a real {@link BroadcastChannel}.
     * A test can inject an in-memory channel to exercise the fan-out wire
     * without a live websocket.
     */
    createChannel?: (url: string, myId: string) => SpaceChannelLike;
    /** Offline shard-byte cache for room files (browser). */
    shardCache?: ShardByteCache;
    /** Queue a room-file shard PUT that couldn't reach the network. */
    deferShardUpload?: (hash: string) => Promise<void>;
    /** Offline message cache + send queue. Undefined ⇒ no offline behavior. */
    offline?: SpaceOfflineAdapter;
    /** Locked session (design §3.3): no keyring, never connects; the app re-opens after sign-in. */
    locked?: boolean;
    /** The Space's membership log (a signed private Space), when this client has trust wired. */
    logSync?: LogSync;
    /** Visibility the Space was created with; only a private Space gets a genesis (design §3.8). */
    visibility?: "private" | "public";
    /** This app's id, which a genesis names (design §3.5). */
    appId?: () => Promise<string>;
    /**
     * Status of GET /keyring/state after the client's silent 401 recovery, or "network": asked after a
     * 4403 close before believing it (design §6.9).
     */
    probeState?: () => Promise<number | "network">;
    /** True while the session holds a token, so a reconnect must never go ticketless. */
    hasSession?: () => boolean;
}

/** The subset of {@link BroadcastChannel} a {@link Space} drives. */
export interface SpaceChannelLike {
    on(event: string, handler: (e: CustomEvent) => void): void;
    off(event: string, handler: (e: CustomEvent) => void): void;
    connect(): Promise<void>;
    disconnect(): void;
    announce(): Promise<void>;
    send(plaintext: string): Promise<number>;
    sendRaw(frame: unknown): void;
    peers?(): string[];
    isConnected?(): boolean;
    /** Reconnect after a terminal close, on a fresh URL. */
    resume?(): void;
}

export class Space {
    readonly name: string;
    readonly historyPolicy: HistoryPolicy;
    private channel: SpaceChannelLike | null = null;
    /**
     * The log turned this user away and closed `channel` (design §3.7). Its
     * single-use ticket is spent, so it is never dialled again: the next
     * `connect()` checks the log and opens a new channel on a fresh ticket.
     */
    private channelSpent = false;
    /** Every raw channel listener (`on`), attached to each channel this Space opens. */
    private readonly listeners: Array<[string, Listener]> = [];
    private readonly cipher: SpacePacketCipher | null;
    /** Per-instance event bus for fan-out events (isolated across spaces). */
    private readonly events = new EventTarget();
    private rawWired = false;
    private catchUpUnsub: (() => void) | null = null;
    /** Optional P2P swarm for this Space (block exchange among members). */
    private peerNet: AttachedPeerNetwork | null = null;
    private _admission: AdmissionState;
    /** Whether admission follows the log's changes yet (subscribed once, on the first open the log admits). */
    private admissionWired = false;
    /** When the last resume after a 4403 ran (design §6.7: at most one per {@link NOT_MEMBER_RECHECK_MS}). */
    private lastResumeAt = -Infinity;
    private resumeTimer: ReturnType<typeof setTimeout> | null = null;
    /** Bumped by `disconnect()`: a /keyring/state answer that arrives after it is dropped. */
    private teardowns = 0;

    constructor(private readonly deps: SpaceDeps) {
        this.name = deps.name;
        this.historyPolicy = deps.historyPolicy ?? "static";
        this.cipher = deps.keyring ? new SpacePacketCipher(deps.keyring) : null;
        this._admission = deps.locked ? "locked" : "requesting";
        deps.keyring?.onKeysChanged(() => {
            if (this._admission === "requesting") this.setAdmission("keyed");
        });
    }

    /** The encoded space id (same as the transport name for fan-out spaces). */
    get id(): string {
        return this.name;
    }

    /** The keyring backing this space's group keys, if any. */
    get keyring(): SpaceKeyring | undefined {
        return this.deps.keyring;
    }

    /** Where this member stands in this Space (design §4.5.12, as the slice ships it). */
    get admission(): AdmissionState {
        return this._admission;
    }

    /** Subscribe to admission changes. Returns an unsubscribe. */
    onAdmission(h: (s: AdmissionState) => void): () => void {
        const l = (e: Event) => h((e as CustomEvent<AdmissionState>).detail);
        this.events.addEventListener("admission", l);
        return () => this.events.removeEventListener("admission", l);
    }

    protected setAdmission(s: AdmissionState): void {
        if (this._admission === s) return;
        this._admission = s;
        this.emitEvent("admission", s);
    }

    /** The log turned this user away; nothing reconnects until it admits them again. */
    private denied(): boolean {
        return this._admission === "not-member" || this._admission === "identity-mismatch";
    }

    /**
     * Sync the membership log and derive admission from it, before any ticket
     * (design §3.4, §3.7, §4.5.12). A 403 from the log route is not-member and a
     * 401 is locked. Any other failure is fatal only where this client has
     * verified the log before (it holds a high-water mark). Otherwise the Space
     * opens as unlogged this time, and the next open or `mlog` frame syncs again.
     */
    private async admitByLog(ls: LogSync): Promise<void> {
        try {
            await ls.sync();
        } catch (e) {
            if (e instanceof KeyringHttpError && e.status === 403) {
                this.setAdmission("not-member");
                throw new AdmissionDeniedError("not-member", NOT_MEMBER_MESSAGE);
            }
            if (e instanceof KeyringHttpError && e.status === 401) {
                this.setAdmission("locked");
                throw new IdentityLockedError();
            }
            // A mark that cannot be read counts as held: the failure is not waved through.
            if (await ls.hasHighWater().catch(() => true)) throw e;
            logger.warn("Space: the member list could not be read; opening without it", {
                spaceId: this.name,
                code: failureCode(e),
                message: e instanceof Error ? e.message : String(e),
            });
        }
        await this.evaluateAdmission();
        if (this._admission === "not-member") throw new AdmissionDeniedError("not-member", NOT_MEMBER_MESSAGE);
        if (this._admission === "identity-mismatch") throw new AdmissionDeniedError("identity-mismatch", IDENTITY_MISMATCH_MESSAGE);
        if (!this.admissionWired) {
            this.admissionWired = true;
            ls.onChange(() => {
                void this.evaluateAdmission().catch((e: unknown) => {
                    logger.warn("Space: admission could not be re-derived from the member list", {
                        spaceId: this.name,
                        code: failureCode(e),
                        message: e instanceof Error ? e.message : String(e),
                    });
                });
            });
        }
    }

    /** Re-derive admission from the verified log (design §3.4 rows, §3.7, §4.5.12). */
    private async evaluateAdmission(): Promise<void> {
        const ls = this.deps.logSync;
        if (!ls) return;
        // Before the logEnabled check: a log that went missing leaves the Space unlogged, and broken.
        if (ls.integrity.broken) {
            this.setAdmission("integrity");
            return;
        }
        if (!ls.logEnabled) return;
        const m = ls.member(this.deps.myId());
        if (!m) {
            this.setAdmission("not-member");
            this.dropChannel();
            return;
        }
        if (!ikEquals(m.ik, await ls.signer.identityKeyRaw())) {
            this.setAdmission("identity-mismatch");
            this.dropChannel();
            return;
        }
        if (this._admission !== "keyed") this.setAdmission(this.deps.keyring?.hasAnyKey() ? "keyed" : "requesting");
    }

    /**
     * A 4403 alone never shows not-member: ask /keyring/state first (design §6.9, AV12).
     * 403 is not-member and 401, which `probeState` returns only once a silent re-auth has failed, is
     * locked; either closes the channel for good, like a log refusal. Any
     * other answer (404 while step I has no state route, 2xx, 5xx, a network error) resumes, at most
     * once per {@link NOT_MEMBER_RECHECK_MS}.
     */
    private async onNotMemberClose(): Promise<void> {
        const teardowns = this.teardowns;
        const status = this.deps.probeState
            ? await this.deps.probeState().catch((): "network" => "network")
            : "network";
        if (teardowns !== this.teardowns) return; // disconnected while asking: nothing to resume
        if (status === 403) {
            this.setAdmission("not-member");
            this.dropChannel();
            return;
        }
        if (status === 401) {
            this.setAdmission("locked");
            this.dropChannel();
            return;
        }
        if (this.resumeTimer) return;
        const wait = Math.max(0, this.lastResumeAt + NOT_MEMBER_RECHECK_MS - Date.now());
        this.resumeTimer = setTimeout(() => {
            this.resumeTimer = null;
            this.lastResumeAt = Date.now();
            this.channel?.resume?.();
        }, wait);
    }

    /** Close the socket of a user the log turned away, and never dial that channel again (design §3.7). */
    private dropChannel(): void {
        if (!this.channel || this.channelSpent) return;
        this.channelSpent = true;
        this.disconnect();
    }

    // -- transport -------------------------------------------------------------

    /**
     * Open the space websocket (resolves the ticket + identity lazily). On a
     * Space with a membership log, the log is checked first: a user it does not
     * list, or lists under another identity key, is refused with
     * {@link AdmissionDeniedError} before any ticket is fetched (design §4.5.12).
     */
    async connect(): Promise<void> {
        if (this.deps.locked) throw new IdentityLockedError();
        const ls = this.deps.logSync;
        // Checked on the first open, and again on a Space the log turned away, so a later call never reopens its socket unchecked.
        // A channel the log closed is replaced, not redialled: its ticket was single-use.
        if (ls && (!this.channel || this.channelSpent || this.denied())) await this.admitByLog(ls);
        if (!this.channel || this.channelSpent) {
            const spent = this.channel;
            // The WS upgrade ticket is single-use + short-TTL, so a reconnect
            // must mint a FRESH one — otherwise the socket drops (idle timeout,
            // network blip) and never comes back. `buildUrl` is handed to the
            // transport as a `urlProvider` it calls before each reconnect.
            const buildUrl = async (reconnect = false) => {
                const ticket = await this.deps.fetchTicket();
                if (!ticket && reconnect && this.deps.keyring && this.deps.hasSession?.()) {
                    // A reconnect with a live session never goes ticketless (anonymous): let the transport retry.
                    throw new Error("Space: no WebSocket ticket yet; retrying");
                }
                const q = new URLSearchParams();
                if (ticket) q.set("ticket", ticket);
                q.set("refuse", "close"); // be refused with the 4403 close, which this SDK treats as terminal (design §3.6)
                return `${this.deps.wsBaseUrl}/api/spaces/${encodeURIComponent(this.name)}/websocket?${q.toString()}`;
            };
            const url = await buildUrl();
            this.channel = this.deps.createChannel
                ? this.deps.createChannel(url, this.deps.myId())
                : new BroadcastChannel({
                      url,
                      myId: this.deps.myId(),
                      autoAnnounce: false,
                      urlProvider: () => buildUrl(true),
                      // Keep recovering across network flaps (each attempt mints a
                      // fresh ticket); teardown calls disconnect() which stops it.
                      maxReconnectAttempts: 0,
                      // A 4403 stops the transport; the Space decides whether to resume.
                      terminalCloseCodes: [NOT_MEMBER_CLOSE_CODE],
                  });
            this.channelSpent = false;
            this.rawWired = false;
            for (const [event, handler] of this.listeners) {
                spent?.off(event, handler);
                this.channel.on(event, handler);
            }
            // Fan-out spaces drive their own `{name}` handshake + frame routing.
            // Legacy (keyring-less) callers wire these themselves, so leave that
            // path byte-for-byte unchanged.
            if (this.deps.keyring) {
                this.channel.on(BroadcastChannelEvents.CONNECTED, () => {
                    this.channel?.sendRaw({ name: this.deps.myId() });
                    // Kick P2P peer discovery now the signaling channel is live
                    // (re-runs on each reconnect to re-form the mesh).
                    this.peerNet?.start();
                });
                this.channel.on(BroadcastChannelEvents.DISCONNECTED, (e: CustomEvent) => {
                    const detail = e.detail as { code?: number } | undefined;
                    if (detail?.code === NOT_MEMBER_CLOSE_CODE) void this.onNotMemberClose();
                });
                this.wireFanout();
                // Register offline catch-up once: on each reconnect the sync
                // engine pages history forward to fill any gap we missed.
                if (this.deps.offline?.enabled && !this.catchUpUnsub) {
                    this.catchUpUnsub = this.deps.offline.registerCatchUp(() => this.catchUp());
                }
            }
        }
        await this.channel.connect();
    }

    disconnect(): void {
        this.teardowns++;
        if (this.resumeTimer) {
            clearTimeout(this.resumeTimer);
            this.resumeTimer = null;
        }
        this.channel?.disconnect();
        this.catchUpUnsub?.();
        this.catchUpUnsub = null;
        this.peerNet?.close();
        this.peerNet = null;
    }

    /** Attach a P2P swarm so this Space's file reads/writes can use peers. */
    attachPeerNetwork(net: AttachedPeerNetwork): void {
        this.peerNet = net;
    }

    /**
     * Broadcast an app payload directly to connected Space peers over P2P,
     * **bypassing the server** — for CRDT ops / high-frequency state (live
     * cursors, presence, collaborative edits) you don't want to push through the
     * relay. No-op when no P2P mesh is active (requires `client` `p2p`).
     * Unlike {@link sendEphemeral} (server-relayed, metered, size-limited), this
     * is peer-direct and fragments large payloads.
     */
    gossipToPeers(data: Uint8Array): void {
        this.peerNet?.gossip(data);
    }

    /** Subscribe to peer gossip ({@link gossipToPeers}). Returns an unsubscribe fn. */
    onPeerGossip(handler: (from: string, data: Uint8Array) => void): () => void {
        return this.peerNet?.onGossip(handler) ?? (() => {});
    }

    /** Subscribe to a raw channel event. Buffered until `connect()` if early, and kept across a new channel. */
    on(event: string, handler: Listener): void {
        this.listeners.push([event, handler]);
        this.channel?.on(event, handler);
    }

    off(event: string, handler: Listener): void {
        const i = this.listeners.findIndex(([e, h]) => e === event && h === handler);
        if (i >= 0) this.listeners.splice(i, 1);
        this.channel?.off(event, handler);
    }

    // -- legacy Double Ratchet path (unchanged) --------------------------------

    /** Advertise our keyExchange to the room (idempotent per connection). */
    announce(): Promise<void> {
        return this.channel ? this.channel.announce() : Promise.resolve();
    }

    /** E2E-encrypt `text` to every peer via the Double Ratchet (no history). */
    send(text: string): Promise<number> {
        return this.channel ? this.channel.send(text) : Promise.resolve(0);
    }

    /** Send an arbitrary JSON frame (e.g. the `{name}` handshake). */
    sendRaw(frame: unknown): void {
        this.channel?.sendRaw(frame);
    }

    peers(): string[] {
        return this.channel?.peers ? this.channel.peers() : [];
    }

    isConnected(): boolean {
        return this.channel?.isConnected ? this.channel.isConnected() : false;
    }

    /** The underlying channel, for advanced use. `null` before `connect()`. */
    get raw(): SpaceChannelLike | null {
        return this.channel;
    }

    // -- fan-out group messaging -----------------------------------------------

    /**
     * Seal `payload` once with the current group key and broadcast it as a
     * persisted `spaceMessage`. Requires a keyring.
     */
    async sendMessage(
        payload: unknown,
        opts: { channel?: string; contentType?: string } = {},
    ): Promise<void> {
        const offline = this.deps.offline;
        if (!offline?.enabled) {
            this.sendRaw({ spaceMessage: await this.sealMessage(payload, opts.channel, opts.contentType) });
            return;
        }
        // Offline-aware path: stamp the message, cache it optimistically (so the
        // UI can show it instantly via cachedMessages), then send if connected
        // or durably queue it for replay on reconnect.
        const clientId = offline.newClientId();
        const hlc = await offline.nextHlc();
        const packet = await this.sealMessage(payload, opts.channel, opts.contentType, clientId);
        const frame = { spaceMessage: packet };
        const entry = {
            handle: provisionalSpaceKey(clientId),
            packet,
            op: "msg" as const,
            clientId,
            hlc,
            pending: true,
        };
        if (this.isConnected()) {
            this.sendRaw(frame); // send first — don't block the wire on IndexedDB
            void offline.putMessage(this.id, entry); // optimistic cache off the hot path
        } else {
            // Offline: persist the optimistic entry + durable replay queue.
            void offline.putMessage(this.id, entry);
            await offline.enqueueFrame(this.id, frame, clientId, hlc);
        }
    }

    /** Subscribe to decrypted fan-out messages. Returns an unsubscribe fn. */
    onMessage(handler: (e: SpaceMessageEvent) => void): () => void {
        const listener = (e: Event) => handler((e as CustomEvent<SpaceMessageEvent>).detail);
        this.events.addEventListener("message", listener);
        return () => this.events.removeEventListener("message", listener);
    }

    /**
     * Edit a persisted message IN PLACE, addressed by its server
     * {@link SpaceMessageEvent.handle}. Re-seals `payload` and asks the server
     * to replace the stored entry; the server authorizes against the original
     * author. Receivers get an {@link onMessageEdited} event carrying the new
     * content at the same handle. This is a generic persisted-item edit — the
     * server has no notion of what the payload means.
     */
    async editMessage(handle: number, payload: unknown, opts: { channel?: string; contentType?: string } = {}): Promise<void> {
        const spaceMessage = await this.sealMessage(payload, opts.channel, opts.contentType);
        const frame = { editSpaceMessage: { ts: handle, spaceMessage } };
        const offline = this.deps.offline;
        if (offline?.enabled) {
            await offline.putMessage(this.id, {
                handle: padSpaceHandle(handle),
                packet: spaceMessage,
                op: "edit",
                hlc: await offline.nextHlc(),
            });
            if (this.isConnected()) this.sendRaw(frame);
            else await offline.enqueueFrame(this.id, frame, offline.newClientId(), await offline.nextHlc());
            return;
        }
        this.sendRaw(frame);
    }

    /**
     * Hard-delete a persisted message by its server {@link SpaceMessageEvent.handle}
     * — the ciphertext is removed from storage. Server authorizes against the
     * original author. Receivers get an {@link onMessageDeleted} event.
     */
    async deleteMessage(handle: number): Promise<void> {
        const frame = { deleteSpaceMessage: { ts: handle } };
        const offline = this.deps.offline;
        if (offline?.enabled) {
            await offline.putDeleted(this.id, handle);
            if (this.isConnected()) this.sendRaw(frame);
            else await offline.enqueueFrame(this.id, frame, offline.newClientId(), await offline.nextHlc());
            return;
        }
        this.sendRaw(frame);
    }

    /**
     * Decrypt and return the locally-cached message log for this space, in
     * handle order (pending sends last). Works offline — the source is the
     * IndexedDB cache populated by live frames + {@link history}. Apps call this
     * on boot to paint instantly, then subscribe to {@link onMessage} for live
     * updates. Returns `[]` when offline support is off.
     */
    async cachedMessages(): Promise<SpaceMessageEvent[]> {
        const offline = this.deps.offline;
        if (!offline?.enabled || !this.cipher) return [];
        const entries = (await offline.loadMessages(this.id)).filter((e) => !e.deleted && e.packet);
        // Decode in parallel (already verified when cached → skipVerify).
        const decodedAll = await Promise.all(
            entries.map((e) =>
                this.decodeFrame(e.packet!, this.cipher!, /*isRawFrame*/ true, e.pending ? 0 : Number(e.handle), /*skipVerify*/ true),
            ),
        );
        const out: SpaceMessageEvent[] = [];
        for (let i = 0; i < decodedAll.length; i++) {
            const decoded = decodedAll[i];
            if (decoded) {
                decoded.pending = entries[i].pending;
                out.push(decoded);
            }
        }
        return out;
    }

    /** Subscribe to in-place edits of persisted messages (new content at the same handle). */
    onMessageEdited(handler: (e: SpaceMessageEvent) => void): () => void {
        const listener = (e: Event) => handler((e as CustomEvent<SpaceMessageEvent>).detail);
        this.events.addEventListener("message-edited", listener);
        return () => this.events.removeEventListener("message-edited", listener);
    }

    /** Subscribe to deletions of persisted messages. */
    onMessageDeleted(handler: (e: MessageDeletedEvent) => void): () => void {
        const listener = (e: Event) => handler((e as CustomEvent<MessageDeletedEvent>).detail);
        this.events.addEventListener("message-deleted", listener);
        return () => this.events.removeEventListener("message-deleted", listener);
    }

    /**
     * Broadcast an ephemeral, never-persisted signal to the room over the
     * generic `pub` relay. `subject` is an app-defined routing key; `data` is
     * opaque. The transport stays domain-agnostic — app concepts like typing
     * indicators, presence, or live cursors are built on top of this. No-op if
     * the space isn't connected (ephemeral signals aren't worth queuing).
     */
    sendEphemeral(subject: string, data: unknown, to?: string): void {
        if (!this.isConnected()) return;
        // `to` (a member id) lets the server unicast a *directed* ephemeral
        // instead of broadcasting; omitted ⇒ broadcast to the room (unchanged).
        this.sendRaw({ pub: to ? { subject, data, to } : { subject, data } });
    }

    /** Subscribe to inbound ephemeral signals. `from` is the authenticated sender. */
    onEphemeral(handler: (e: EphemeralEvent) => void): () => void {
        const listener = (e: Event) => handler((e as CustomEvent<EphemeralEvent>).detail);
        this.events.addEventListener("ephemeral", listener);
        return () => this.events.removeEventListener("ephemeral", listener);
    }

    /** Subscribe to inbound join requests (for a key-holder to admit). */
    onJoinRequest(handler: (req: JoinRequest) => void): () => void {
        const listener = (e: Event) => handler((e as CustomEvent<JoinRequest>).detail);
        this.events.addEventListener("join-request", listener);
        return () => this.events.removeEventListener("join-request", listener);
    }

    /**
     * Fetch + decrypt persisted history beyond the live backlog.
     * `before` is an opaque cursor returned as `nextCursor`.
     */
    async history(
        opts: { before?: string; limit?: number } = {},
    ): Promise<{ messages: SpaceMessageEvent[]; nextCursor: string | null }> {
        const cipher = this.requireCipher();
        const params = new URLSearchParams();
        if (opts.before) params.set("before", opts.before);
        if (opts.limit) params.set("limit", String(opts.limit));
        const url =
            `${this.deps.httpBaseUrl}/api/spaces/${encodeURIComponent(this.name)}/history` +
            (params.toString() ? `?${params}` : "");
        // Temporary staging diagnostic: split fetch / directory / decode time.
        const dbg = (() => { try { return globalThis.location?.hostname?.includes("staging"); } catch { return false; } })();
        const mark = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
        const t0 = mark();
        const res = await this.deps.fetch(url);
        if (!res.ok) throw new Error(`Space.history: ${res.status} ${res.statusText}`);
        const body = (await res.json()) as { messages: string[]; nextCursor: string | null };
        const tFetch = mark();
        // Warm the member directory once so historical senders' signatures verify.
        // Force past the cooldown — a history load is an explicit "get fresh".
        await this.deps.keyring?.refreshDirectory({ force: true });
        const tDir = mark();
        // Decode the whole page in PARALLEL — each frame is an AES-GCM decrypt +
        // ECDSA verify on the WebCrypto thread; doing them sequentially (await
        // per message) serializes ~100 main↔crypto round-trips and dominates
        // load time. Promise.all preserves input order.
        const raws = body.messages ?? [];
        const decodedAll = await Promise.all(raws.map((raw) => this.decodeFrame(raw, cipher)));
        if (dbg) {
            console.info(
                `[muhkoo:space] history n=${raws.length} | fetch ${Math.round(tFetch - t0)}ms | dir ${Math.round(tDir - tFetch)}ms | decode ${Math.round(mark() - tDir)}ms`,
            );
        }
        const messages: SpaceMessageEvent[] = [];
        for (let i = 0; i < decodedAll.length; i++) {
            const decoded = decodedAll[i];
            if (!decoded) continue;
            messages.push(decoded);
            // Warm the offline cache off the hot path (best-effort, non-blocking).
            if (this.deps.offline?.enabled) {
                try {
                    const outer = JSON.parse(raws[i]) as { spaceMessage?: string };
                    if (typeof outer.spaceMessage === "string") {
                        void this.cacheFrame(outer.spaceMessage, decoded, "msg");
                    }
                } catch {
                    /* unparseable history row — skip caching, still surfaced above */
                }
            }
        }
        return { messages, nextCursor: body.nextCursor ?? null };
    }

    /**
     * Bring this member's group keys up to date: load from cache, and if we
     * hold nothing, request a key and poll until one arrives (or timeout).
     */
    async join(opts: { timeoutMs?: number; pollMs?: number } = {}): Promise<boolean> {
        if (this.deps.locked) return false;
        const keyring = this.requireKeyring();
        await this.connect();
        if (await keyring.loadFromCache()) return true;
        if (keyring.hasAnyKey()) return true;
        await keyring.requestKey();
        const deadline = Date.now() + (opts.timeoutMs ?? 15000);
        const pollMs = opts.pollMs ?? 500;
        // eslint-disable-next-line no-constant-condition
        while (Date.now() < deadline) {
            if ((await keyring.pullKeys()) > 0) return true;
            await delay(pollMs);
        }
        return false;
    }

    /** Creator path: mint epoch 0; for a private Space, sign the genesis + ec(0) BEFORE connecting (design §4.5.10). */
    async create(): Promise<void> {
        if (this.deps.locked) throw new IdentityLockedError();
        const keyring = this.requireKeyring();
        await keyring.bootstrapNew();
        const ls = this.deps.logSync;
        if (this.deps.visibility === "private" && ls) {
            if (!this.deps.appId) throw new Error("Space: a private Space's genesis needs the app id.");
            const appId = await this.deps.appId();
            const k0 = keyring.rawKey(0)!;
            await ls.append(
                "genesis",
                { visibility: "private", policy: this.historyPolicy, appId, baseEpoch: -1, legacyCommits: {} },
                async (hash, entry) => {
                    const ec = {
                        v: 1 as const, spaceId: this.name, epoch: 0, prevKeyed: -1,
                        keyCommit: await keyCommit(0, k0, this.name),
                        headSeq: 0, headHash: hash, sole: true, by: entry.by, ik: entry.ik, at: entry.at,
                    };
                    return { ...ec, sig: await ls.signer.sign(ecBytes(ec)) };
                },
            );
        }
        await this.connect();
        // Publish our identity in the member directory so peers can verify our
        // message signatures (the creator never "joins", so register here).
        await keyring.requestKey().catch(() => {});
        // Admit anyone who requested a key before we were listening.
        if (this.deps.autoAdmit !== false) {
            await keyring.admitPending().catch(() => {});
        }
    }

    /** Wrap the group key for a newcomer and post it (key-holder action). */
    async admit(memberId: string, identityEcdhPub: string): Promise<void> {
        await this.requireKeyring().admit(memberId, identityEcdhPub);
    }

    /** Invite a user to this (private) channel's membership allowlist. */
    async invite(username: string): Promise<void> {
        await this.requireKeyring().invite(username);
    }

    /** Rotate to a fresh epoch and re-wrap to the roster (rotate spaces). */
    async rotate(roster?: Array<{ memberId: string; identityEcdhPub: string }>): Promise<number> {
        if (this.deps.logSync?.logEnabled) throw new SpaceTrustError("log-refused", "Key rotation for signed spaces arrives with a later release.");
        return this.requireKeyring().rotate(roster);
    }

    // -- signed member list (design §3.5–§3.8) ---------------------------------

    /** Whether this Space has a verified membership log. */
    get logEnabled(): boolean {
        return !!this.deps.logSync?.logEnabled;
    }

    /** The verified member list, or null when this Space has no log. */
    membership(): MemberView[] | null {
        return this.deps.logSync?.logEnabled ? this.deps.logSync.members() : null;
    }

    /** Called with the member list (null when unlogged) each time the log is re-synced. Returns an unsubscribe. */
    onMembership(h: (m: MemberView[] | null) => void): () => void {
        return this.deps.logSync ? this.deps.logSync.onChange(() => h(this.membership())) : () => {};
    }

    private requireLog(): LogSync {
        const ls = this.deps.logSync;
        if (!ls?.logEnabled) throw new SpaceTrustError("log-refused", "This space has no signed member list.");
        return ls;
    }

    /** Add by exact username (design §3.8; the owner, or an editor for viewers). Looks the IK up in the directory. */
    async add(username: string, opts: { role?: "viewer" | "editor" } = {}): Promise<{ seq: number }> {
        const ls = this.requireLog();
        const memberIk = await ls.directory.lookup(username);
        return ls.append("add", { member: username, memberIk, role: opts.role ?? "viewer" });
    }

    /** Remove a member. In this build it cuts them off at the relay; it does not rotate the key. */
    async remove(memberId: string): Promise<{ seq: number }> {
        return this.requireLog().append("remove", { member: memberId });
    }

    async setRole(memberId: string, role: "viewer" | "editor"): Promise<{ seq: number }> {
        return this.requireLog().append("role", { member: memberId, role });
    }

    async leave(): Promise<{ seq: number }> {
        return this.requireLog().append("leave", {});
    }

    // -- room-scoped files (no websocket needed) -------------------------------

    async putFile(
        file: File | Blob | Uint8Array,
        metadata: SpaceFileMetadata,
        opts: {
            onProgress?: (completed: number, total: number) => void;
            /**
             * Return the manifest as soon as shards are cached + announced to the
             * mesh, uploading to origin in the background. Lets a peer/worker start
             * pulling the file over P2P immediately instead of waiting out the full
             * origin upload. Requires an offline cache (browser); ignored without.
             */
            backgroundUpload?: boolean;
        } = {},
    ): Promise<{ manifest: FileManifest; stat: FileStat }> {
        const result = await this.fileStorage(opts.backgroundUpload)
            .writeFileToShards({ data: file, metadata, onProgress: opts.onProgress });
        // Declare this manifest's shards to the accelerator: attributes the stored
        // bytes to the owning app (so storage is never unmetered) and reference-
        // counts the shards for GC. Public shard hashes only — the per-chunk keys
        // stay inside the manifest, which the caller keeps in a vault/Space.
        await this.commitShards(result.manifest, "commit");
        return result;
    }

    async getFile(manifest: FileManifest): Promise<{ data: Uint8Array; stat: FileStat }> {
        return this.fileStorage().readFileFromShards(manifest);
    }

    /** Streaming read: async-iterate a stored file's decrypted chunks in order,
     *  never holding the whole file in memory. Use for multi-GB files (a single
     *  `Uint8Array` can't hold them) — e.g. a transcoder piping the raw to a temp
     *  file. Same peer/origin shard sourcing as {@link getFile}. */
    getFileStream(manifest: FileManifest): AsyncGenerator<Uint8Array> {
        return this.fileStorage().readChunksFromShards(manifest);
    }

    /** Declare a file's shards (ref++ + meter) for a manifest already stored —
     *  used to back-fill accounting for files written before commit existed, or to
     *  register a manifest received via sharing. `putFile` already commits new
     *  writes automatically; this is the explicit form. */
    async commitFile(manifest: FileManifest): Promise<void> {
        await this.commitShards(manifest, "commit");
    }

    /** Release a file's shards (ref--) when the owner deletes or unshares it. At
     *  zero references a shard enters a retention window, then is GC'd. Idempotent-
     *  ish: safe to call once per manifest the owner drops. */
    async releaseFile(manifest: FileManifest): Promise<void> {
        await this.commitShards(manifest, "release");
    }

    /** Commit/release a manifest's shards with the accelerator (metering + refcount). */
    private async commitShards(manifest: FileManifest, action: "commit" | "release"): Promise<void> {
        // Through the client's 401 recovery when there is one: the commit refuses
        // a dead session with 401, and three tries with the same token only
        // delayed the warning.
        await commitManifest(this.deps.fetchWithRecovery ?? this.deps.fetch, this.deps.httpBaseUrl, manifest, action);
    }

    private fileStorage(backgroundUpload = false): FileStorage {
        // Global, content-addressed shard store — same store `client.storage`
        // uses, so a file shared into a channel resolves from anywhere by
        // manifest. (Shards are encrypted ciphertext; the manifest is the
        // capability.)
        const shards = new ShardClient({
            baseUrl: this.deps.httpBaseUrl,
            pathPrefix: "/api/shards",
            fetch: this.deps.fetch,
            fetchWithRecovery: this.deps.fetchWithRecovery,
            cache: this.deps.shardCache,
            deferUpload: this.deps.deferShardUpload,
            peers: this.peerNet?.exchange,
            backgroundUpload,
        });
        return new FileStorage({ shards });
    }

    // -- internals -------------------------------------------------------------

    /** Wire the RAW_FRAME handler that drives fan-out events. */
    private wireFanout(): void {
        if (this.rawWired || !this.channel) return;
        this.rawWired = true;
        this.channel.on(BroadcastChannelEvents.RAW_FRAME, (e: CustomEvent) => {
            void this.onRawFrame(e.detail);
        });
    }

    private async onRawFrame(frame: unknown): Promise<void> {
        const f = frame as Record<string, unknown>;
        if (!f || typeof f !== "object") return;
        if (f.mlog && typeof f.mlog === "object") { this.deps.logSync?.scheduleSync(); return; }
        if (f.rotateDue) { return; } // no client can answer a rotation request yet: key rotation for signed spaces comes later
        if (typeof f.spaceMessage === "string" && this.cipher) {
            const handle = Number(f.timestamp ?? 0);
            const decoded = await this.decodeFrame(f.spaceMessage as string, this.cipher, /*raw*/ true, handle);
            if (decoded) {
                this.emitEvent("message", decoded); // UI first
                void this.cacheFrame(f.spaceMessage as string, decoded, "msg"); // cache off the hot path
            }
            return;
        }
        if (f.editSpaceMessage && typeof f.editSpaceMessage === "object" && this.cipher) {
            // Server-authoritative in-place edit: new sealed content at the same
            // handle. Decode and surface it; the app replaces by `handle`.
            const e = f.editSpaceMessage as { ts?: number; spaceMessage?: string };
            if (typeof e.spaceMessage === "string") {
                const decoded = await this.decodeFrame(e.spaceMessage, this.cipher, /*raw*/ true, Number(e.ts ?? 0));
                if (decoded) {
                    this.emitEvent("message-edited", decoded);
                    void this.cacheFrame(e.spaceMessage, decoded, "edit");
                }
            }
            return;
        }
        if (f.deleteSpaceMessage && typeof f.deleteSpaceMessage === "object") {
            const d = f.deleteSpaceMessage as { ts?: number };
            const handle = Number(d.ts ?? 0);
            this.emitEvent("message-deleted", { handle });
            if (this.deps.offline?.enabled) {
                // Cache the tombstone off the hot path.
                void this.deps.offline.putDeleted(this.id, handle).then(() =>
                    this.deps.offline?.observeHandle(this.id, handle),
                );
            }
            return;
        }
        if (f.pub && typeof f.pub === "object") {
            // Generic ephemeral relay frame. The server stamps the authenticated
            // sender as `name`; `pub` carries the app's {subject, data}. We
            // surface the authenticated `name` as `from` (not any client-set
            // value inside `pub`), so app signals can't spoof their sender.
            const p = f.pub as { subject?: unknown; data?: unknown };
            const from = typeof f.name === "string" ? f.name : "";
            if (from && typeof p.subject === "string") {
                this.emitEvent("ephemeral", { from, subject: p.subject, data: p.data });
            }
            return;
        }
        if (f.joinRequest && typeof f.joinRequest === "object") {
            const req = f.joinRequest as JoinRequest;
            this.emitEvent("join-request", req);
            // A new member appeared — refresh the directory so their future
            // messages verify, and (if we hold the key) auto-admit them.
            void this.deps.keyring?.refreshDirectory({ force: true });
            if (
                this.deps.autoAdmit !== false &&
                this.deps.keyring?.hasAnyKey() &&
                req.memberId !== this.deps.myId() &&
                this.deps.keyring.canWrapTo(req.memberId)
            ) {
                void this.deps.keyring.admit(req.memberId, req.identityEcdhPub).catch(() => {});
            }
            return;
        }
        if (f.keyringReady && this.deps.keyring) {
            // A key was wrapped for us — pull it.
            void this.deps.keyring.pullKeys().catch(() => {});
        }
    }

    /**
     * Seal `payload` once with the current group key + sign it, returning the
     * serialized `Packet` string. Shared by send (a new message) and edit
     * (replacement content for an existing handle). Requires a keyring.
     */
    private async sealMessage(payload: unknown, channel?: string, contentType?: string, clientId?: string): Promise<string> {
        if (this.deps.logSync?.integrity.broken) {
            throw new SpaceTrustError("integrity", "This space's member list couldn't be verified. You can still read messages you already have; sending is paused.");
        }
        const cipher = this.requireCipher(contentType);
        const message = new Message(payload);
        const headers = await cipher.seal(message.serialize());
        const source = this.deps.myId();
        const subject = channel ?? "default";
        // Cleartext dedupe hint — lets the sender match its optimistic entry to
        // the server echo. Not part of the signed canonical form (it carries no
        // authority); worst case a stale hint just shows a transient duplicate.
        if (clientId) headers.cid = clientId;
        // Sign with our identity ECDSA key so receivers can verify authorship
        // end-to-end (independent of the relay's `source` stamp).
        const authPriv = KeyStore.getInstance().getAuthKeyPair(source)?.privateKey;
        if (authPriv) {
            const canonical = canonicalMessage({
                source, target: this.name, subject,
                epoch: Number(headers.epoch), iv: String(headers.iv), ciphertext: String(headers.ciphertext),
            });
            headers.sig = await signSpaceMessage(canonical, authPriv);
        }
        return new Packet({ subject, source, target: this.name, headers }).serialize();
    }

    /**
     * Decode one persisted/broadcast frame into a SpaceMessageEvent.
     * `isRawFrame` true means `input` is the already-extracted `spaceMessage`
     * packet string (and `serverTs` carries the message's storage handle from
     * the enclosing frame); false means `input` is the full
     * `{spaceMessage, name, timestamp}` frame and the handle is read from it.
     */
    private async decodeFrame(
        input: string,
        cipher: SpacePacketCipher,
        isRawFrame = false,
        serverTs = 0,
        skipVerify = false,
    ): Promise<SpaceMessageEvent | null> {
        try {
            let packetJson = input;
            let handle = serverTs;
            if (!isRawFrame) {
                const outer = JSON.parse(input) as { spaceMessage?: string; timestamp?: number };
                if (typeof outer.spaceMessage !== "string") return null;
                packetJson = outer.spaceMessage;
                handle = Number(outer.timestamp ?? 0);
            }
            const packet = Packet.deserialize(packetJson);
            if (!cipher.handles(packet.headers)) return null;

            // Verify sender authenticity end-to-end: the message must be signed
            // by `source`'s identity ECDSA key (looked up in the member
            // directory). Drop anything unsigned, signed by an unknown member,
            // or whose signature doesn't match — this defeats both member
            // impersonation and a relay rewriting `source`. Skipped only when
            // re-reading from the local cache (already verified before caching).
            if (!skipVerify && !(await this.verifySender(packet))) return null;

            const serialized = await cipher.open(packet.headers);
            if (serialized === null) return null; // epoch key we don't hold
            const message = Message.deserialize(serialized);
            return {
                from: packet.source,
                channel: packet.subject,
                epoch: Number(packet.headers?.epoch ?? 0),
                contentType: packet.headers?.contentType as string | undefined,
                handle,
                clientId: packet.headers?.cid as string | undefined,
                message,
            };
        } catch (err) {
            this.emitEvent("error", err);
            return null;
        }
    }

    /**
     * True if `packet` carries a valid signature by `source`'s identity key.
     * On a directory cache miss, refresh once (a new member may have just
     * joined) before giving up. Without a keyring (legacy handle) there's
     * nothing to verify against → reject.
     */
    private async verifySender(packet: Packet): Promise<boolean> {
        // Trust our OWN messages — we sent them, so there's nothing to prove
        // against the roster. This also keeps a returning member (who loaded a
        // cached key and never re-published a join-request) from dropping the
        // echo of their own messages when their `ecdsaPub` isn't in the roster.
        if (packet.source === this.deps.myId()) return true;
        const keyring = this.deps.keyring;
        const sig = packet.headers?.sig;
        if (!keyring || typeof sig !== "string") return false;
        let key = keyring.ecdsaKeyFor(packet.source);
        if (!key) {
            await keyring.refreshDirectory();
            key = keyring.ecdsaKeyFor(packet.source);
            if (!key) return false;
        }
        const canonical = canonicalMessage({
            source: packet.source,
            target: packet.target,
            subject: packet.subject,
            epoch: Number(packet.headers?.epoch ?? 0),
            iv: String(packet.headers?.iv ?? ""),
            ciphertext: String(packet.headers?.ciphertext ?? ""),
        });
        return verifySpaceMessage(canonical, sig, key);
    }

    /** Persist a decoded live/history/edit frame to the offline cache. */
    private async cacheFrame(packet: string, decoded: SpaceMessageEvent, op: "msg" | "edit"): Promise<void> {
        const offline = this.deps.offline;
        if (!offline?.enabled) return;
        // An incoming real message supersedes any optimistic pending entry.
        if (decoded.clientId) await offline.dropPending(this.id, decoded.clientId);
        await offline.putMessage(this.id, {
            handle: padSpaceHandle(decoded.handle),
            packet,
            op,
            clientId: decoded.clientId,
        });
        await offline.observeHandle(this.id, decoded.handle);
    }

    /**
     * Inbound reconciliation run on reconnect: page the server's forward delta
     * (`?since=<lastSeenHandle>`) to the head, pulling exactly the messages that
     * landed while we were offline into the cache. Bounded so a long absence
     * can't page forever. Falls back gracefully if the endpoint is unavailable.
     */
    private async catchUp(): Promise<void> {
        const offline = this.deps.offline;
        if (!offline?.enabled || !this.cipher) return;
        const cursor = await offline.getCursor(this.id);
        let since = String(cursor?.lastSeenHandle ?? 0);
        // Warm the member directory once so historical senders' signatures verify.
        await this.deps.keyring?.refreshDirectory({ force: true });
        for (let page = 0; page < 50; page++) {
            const url =
                `${this.deps.httpBaseUrl}/api/spaces/${encodeURIComponent(this.name)}/history` +
                `?since=${encodeURIComponent(since)}&limit=100`;
            const res = await this.deps.fetch(url);
            if (!res.ok) break;
            const body = (await res.json()) as { messages: string[]; nextCursor: string | null };
            for (const raw of body.messages ?? []) {
                const decoded = await this.decodeFrame(raw, this.cipher);
                if (!decoded) continue;
                try {
                    const outer = JSON.parse(raw) as { spaceMessage?: string };
                    if (typeof outer.spaceMessage === "string") {
                        await this.cacheFrame(outer.spaceMessage, decoded, "msg");
                    }
                } catch {
                    /* unparseable row — skip */
                }
            }
            if (!body.nextCursor) break;
            since = body.nextCursor;
        }
    }

    private emitEvent(type: string, detail: unknown): void {
        this.events.dispatchEvent(new CustomEvent(type, { detail }));
    }

    private requireKeyring(): SpaceKeyring {
        if (!this.deps.keyring) {
            throw new Error("Space: this operation requires a keyring (open via client.space).");
        }
        return this.deps.keyring;
    }

    private requireCipher(contentType?: string): SpacePacketCipher {
        if (!this.deps.keyring) {
            throw new Error("Space: fan-out messaging requires a keyring (open via client.space).");
        }
        return contentType ? new SpacePacketCipher(this.deps.keyring, contentType) : this.cipher!;
    }
}

function delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

/** A failure's HTTP status or error code, for a log line. */
function failureCode(e: unknown): unknown {
    return (e instanceof KeyringHttpError ? e.status : (e as { code?: unknown } | null)?.code) ?? "unknown";
}

/**
 * Zero-pad a numeric server handle for use as a cache key, so string-ordered
 * keys sort in handle order. Must match the offline layer's `padHandle`.
 */
function padSpaceHandle(handle: number): string {
    return String(Math.max(0, Math.floor(handle))).padStart(16, "0");
}

/** Cache key for an un-acked optimistic send. Must match the offline layer's
 *  `provisionalHandle` (sorts after every real, zero-padded handle). */
function provisionalSpaceKey(clientId: string): string {
    return `~local:${clientId}`;
}

export default Space;
