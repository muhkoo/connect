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
import type { FileManifest, FileStat } from "../storage/types";
import { Message } from "../messaging/Message";
import { Packet } from "../messaging/Packet";
import { SpacePacketCipher } from "./SpacePacketCipher";
import type { SpaceKeyring } from "./SpaceKeyring";
import { canonicalMessage, signSpaceMessage, verifySpaceMessage } from "./SpaceCipher";
import { KeyStore } from "../crypto/KeyStore";
import type { JoinRequest, HistoryPolicy } from "./types";

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

export interface SpaceDeps {
    /** Transport room id. For fan-out spaces this is the encoded space pubkey. */
    name: string;
    wsBaseUrl: string;
    httpBaseUrl: string;
    /** Header-injecting fetch from the client's HttpClient. */
    fetch: typeof fetch;
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
}

export class Space {
    readonly name: string;
    readonly historyPolicy: HistoryPolicy;
    private channel: SpaceChannelLike | null = null;
    private readonly pending: Array<[string, Listener]> = [];
    private readonly cipher: SpacePacketCipher | null;
    /** Per-instance event bus for fan-out events (isolated across spaces). */
    private readonly events = new EventTarget();
    private rawWired = false;
    private catchUpUnsub: (() => void) | null = null;
    /** Optional P2P swarm for this Space (block exchange among members). */
    private peerNet: AttachedPeerNetwork | null = null;

    constructor(private readonly deps: SpaceDeps) {
        this.name = deps.name;
        this.historyPolicy = deps.historyPolicy ?? "static";
        this.cipher = deps.keyring ? new SpacePacketCipher(deps.keyring) : null;
    }

    /** The encoded space id (same as the transport name for fan-out spaces). */
    get id(): string {
        return this.name;
    }

    /** The keyring backing this space's group keys, if any. */
    get keyring(): SpaceKeyring | undefined {
        return this.deps.keyring;
    }

    // -- transport -------------------------------------------------------------

    /** Open the space websocket (resolves the ticket + identity lazily). */
    async connect(): Promise<void> {
        if (!this.channel) {
            // The WS upgrade ticket is single-use + short-TTL, so a reconnect
            // must mint a FRESH one — otherwise the socket drops (idle timeout,
            // network blip) and never comes back. `buildUrl` is handed to the
            // transport as a `urlProvider` it calls before each reconnect.
            const buildUrl = async () => {
                const ticket = await this.deps.fetchTicket();
                return (
                    `${this.deps.wsBaseUrl}/api/spaces/${encodeURIComponent(this.name)}/websocket` +
                    (ticket ? `?ticket=${encodeURIComponent(ticket)}` : "")
                );
            };
            const url = await buildUrl();
            this.channel = this.deps.createChannel
                ? this.deps.createChannel(url, this.deps.myId())
                : new BroadcastChannel({
                      url,
                      myId: this.deps.myId(),
                      autoAnnounce: false,
                      urlProvider: buildUrl,
                      // Keep recovering across network flaps (each attempt mints a
                      // fresh ticket); teardown calls disconnect() which stops it.
                      maxReconnectAttempts: 0,
                  });
            for (const [event, handler] of this.pending) this.channel.on(event, handler);
            this.pending.length = 0;
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

    /** Subscribe to a raw channel event. Buffered until `connect()` if early. */
    on(event: string, handler: Listener): void {
        if (this.channel) this.channel.on(event, handler);
        else this.pending.push([event, handler]);
    }

    off(event: string, handler: Listener): void {
        if (this.channel) this.channel.off(event, handler);
        else {
            const i = this.pending.findIndex(([e, h]) => e === event && h === handler);
            if (i >= 0) this.pending.splice(i, 1);
        }
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

    /** Creator path: mint the initial group key, then connect. */
    async create(): Promise<void> {
        const keyring = this.requireKeyring();
        await keyring.bootstrapNew();
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
        return this.requireKeyring().rotate(roster);
    }

    // -- room-scoped files (no websocket needed) -------------------------------

    async putFile(
        file: File | Blob | Uint8Array,
        metadata: SpaceFileMetadata,
        opts: { onProgress?: (completed: number, total: number) => void } = {},
    ): Promise<{ manifest: FileManifest; stat: FileStat }> {
        return this.fileStorage().writeFileToShards({ data: file, metadata, onProgress: opts.onProgress });
    }

    async getFile(manifest: FileManifest): Promise<{ data: Uint8Array; stat: FileStat }> {
        return this.fileStorage().readFileFromShards(manifest);
    }

    private fileStorage(): FileStorage {
        // Global, content-addressed shard store — same store `client.storage`
        // uses, so a file shared into a channel resolves from anywhere by
        // manifest. (Shards are encrypted ciphertext; the manifest is the
        // capability.)
        const shards = new ShardClient({
            baseUrl: this.deps.httpBaseUrl,
            pathPrefix: "/api/shards",
            fetch: this.deps.fetch,
            cache: this.deps.shardCache,
            deferUpload: this.deps.deferShardUpload,
            peers: this.peerNet?.exchange,
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
            if (this.deps.autoAdmit !== false && this.deps.keyring?.hasAnyKey() && req.memberId !== this.deps.myId()) {
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
