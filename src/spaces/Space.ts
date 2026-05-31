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
    message: Message;
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
            const ticket = await this.deps.fetchTicket();
            const url =
                `${this.deps.wsBaseUrl}/api/spaces/${encodeURIComponent(this.name)}/websocket` +
                (ticket ? `?ticket=${encodeURIComponent(ticket)}` : "");
            this.channel = this.deps.createChannel
                ? this.deps.createChannel(url, this.deps.myId())
                : new BroadcastChannel({ url, myId: this.deps.myId(), autoAnnounce: false });
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
        const cipher = this.requireCipher(opts.contentType);
        const message = new Message(payload);
        const headers = await cipher.seal(message.serialize());
        const source = this.deps.myId();
        const subject = opts.channel ?? "default";
        // Sign the message with our identity ECDSA key so receivers can verify
        // authorship end-to-end (independent of the relay's `source` stamp).
        const authPriv = KeyStore.getInstance().getAuthKeyPair(source)?.privateKey;
        if (authPriv) {
            const canonical = canonicalMessage({
                source, target: this.name, subject,
                epoch: Number(headers.epoch), iv: String(headers.iv), ciphertext: String(headers.ciphertext),
            });
            headers.sig = await signSpaceMessage(canonical, authPriv);
        }
        const packet = new Packet({ subject, source, target: this.name, headers });
        this.sendRaw({ spaceMessage: packet.serialize() });
    }

    /** Subscribe to decrypted fan-out messages. Returns an unsubscribe fn. */
    onMessage(handler: (e: SpaceMessageEvent) => void): () => void {
        const listener = (e: Event) => handler((e as CustomEvent<SpaceMessageEvent>).detail);
        this.events.addEventListener("message", listener);
        return () => this.events.removeEventListener("message", listener);
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
    ): Promise<{ manifest: FileManifest; stat: FileStat }> {
        return this.fileStorage().writeFileToShards({ data: file, metadata });
    }

    async getFile(manifest: FileManifest): Promise<{ data: Uint8Array; stat: FileStat }> {
        return this.fileStorage().readFileFromShards(manifest);
    }

    private fileStorage(): FileStorage {
        const shards = new ShardClient({
            baseUrl: this.deps.httpBaseUrl,
            pathPrefix: `/api/spaces/${encodeURIComponent(this.name)}/shards`,
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
            const decoded = await this.decodeFrame(f.spaceMessage as string, this.cipher, /*raw*/ true);
            if (decoded) this.emitEvent("message", decoded);
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
     * Decode one persisted/broadcast frame into a SpaceMessageEvent.
     * `isRawFrame` true means `input` is the already-extracted `spaceMessage`
     * packet string; false means it's the full `{spaceMessage, name, ...}` frame.
     */
    private async decodeFrame(
        input: string,
        cipher: SpacePacketCipher,
        isRawFrame = false,
    ): Promise<SpaceMessageEvent | null> {
        try {
            let packetJson = input;
            if (!isRawFrame) {
                const outer = JSON.parse(input) as { spaceMessage?: string };
                if (typeof outer.spaceMessage !== "string") return null;
                packetJson = outer.spaceMessage;
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
