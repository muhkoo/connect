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
import { ShardClient } from "../storage/transport/ShardClient";
import type { FileManifest, FileStat } from "../storage/types";
import { Message } from "../messaging/Message";
import { Packet } from "../messaging/Packet";
import { SpacePacketCipher } from "./SpacePacketCipher";
import type { SpaceKeyring } from "./SpaceKeyring";
import { canonicalMessage, signSpaceMessage, verifySpaceMessage } from "./SpaceCipher";
import { KeyStore } from "../crypto/KeyStore";
import type { JoinRequest, HistoryPolicy } from "./types";

type Listener = (e: CustomEvent) => void;

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
                });
                this.wireFanout();
            }
        }
        await this.channel.connect();
    }

    disconnect(): void {
        this.channel?.disconnect();
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
        this.sendRaw({ spaceMessage: await this.sealMessage(payload, opts.channel, opts.contentType) });
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
        this.sendRaw({ editSpaceMessage: { ts: handle, spaceMessage } });
    }

    /**
     * Hard-delete a persisted message by its server {@link SpaceMessageEvent.handle}
     * — the ciphertext is removed from storage. Server authorizes against the
     * original author. Receivers get an {@link onMessageDeleted} event.
     */
    async deleteMessage(handle: number): Promise<void> {
        this.sendRaw({ deleteSpaceMessage: { ts: handle } });
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
    sendEphemeral(subject: string, data: unknown): void {
        if (!this.isConnected()) return;
        this.sendRaw({ pub: { subject, data } });
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
        const res = await this.deps.fetch(url);
        if (!res.ok) throw new Error(`Space.history: ${res.status} ${res.statusText}`);
        const body = (await res.json()) as { messages: string[]; nextCursor: string | null };
        // Warm the member directory once so historical senders' signatures verify.
        // (refreshDirectory swallows its own transport errors.)
        await this.deps.keyring?.refreshDirectory();
        const messages: SpaceMessageEvent[] = [];
        for (const raw of body.messages ?? []) {
            const decoded = await this.decodeFrame(raw, cipher);
            if (decoded) messages.push(decoded);
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
            const decoded = await this.decodeFrame(f.spaceMessage as string, this.cipher, /*raw*/ true, Number(f.timestamp ?? 0));
            if (decoded) this.emitEvent("message", decoded);
            return;
        }
        if (f.editSpaceMessage && typeof f.editSpaceMessage === "object" && this.cipher) {
            // Server-authoritative in-place edit: new sealed content at the same
            // handle. Decode and surface it; the app replaces by `handle`.
            const e = f.editSpaceMessage as { ts?: number; spaceMessage?: string };
            if (typeof e.spaceMessage === "string") {
                const decoded = await this.decodeFrame(e.spaceMessage, this.cipher, /*raw*/ true, Number(e.ts ?? 0));
                if (decoded) this.emitEvent("message-edited", decoded);
            }
            return;
        }
        if (f.deleteSpaceMessage && typeof f.deleteSpaceMessage === "object") {
            const d = f.deleteSpaceMessage as { ts?: number };
            this.emitEvent("message-deleted", { handle: Number(d.ts ?? 0) });
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
            void this.deps.keyring?.refreshDirectory();
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
    private async sealMessage(payload: unknown, channel?: string, contentType?: string): Promise<string> {
        const cipher = this.requireCipher(contentType);
        const message = new Message(payload);
        const headers = await cipher.seal(message.serialize());
        const source = this.deps.myId();
        const subject = channel ?? "default";
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
            // impersonation and a relay rewriting `source`.
            if (!(await this.verifySender(packet))) return null;

            const serialized = await cipher.open(packet.headers);
            if (serialized === null) return null; // epoch key we don't hold
            const message = Message.deserialize(serialized);
            return {
                from: packet.source,
                channel: packet.subject,
                epoch: Number(packet.headers?.epoch ?? 0),
                contentType: packet.headers?.contentType as string | undefined,
                handle,
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

export default Space;
