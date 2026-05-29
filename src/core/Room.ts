/**
 * `Room` — a client handle for one shared space (a chat-style room).
 *
 * A shared space carries two things, and `Room` exposes both:
 *   - **realtime E2E messaging** over a {@link BroadcastChannel} (group
 *     handshake, ratchet send/receive, roster frames);
 *   - **room-scoped file storage** via {@link FileStorage} over the room's
 *     shard endpoint.
 *
 * Obtained from `client.message.room(name)`. The websocket isn't opened until
 * `connect()` — and `putFile`/`getFile` don't need it at all (they're plain
 * shard HTTP), so reading a shared file never opens a socket. The upgrade
 * ticket + identity are resolved lazily inside `connect()`.
 *
 * `Room` intentionally mirrors the `BroadcastChannel` surface the chat hook
 * already uses (`on`/`off`/`send`/`sendRaw`/`announce`/`peers`/`isConnected`)
 * so adopting it is a drop-in swap for `new BroadcastChannel(...)`.
 */

import { BroadcastChannel } from "../sessions/BroadcastChannel";
import { FileStorage } from "../storage/FileStorage";
import { ShardClient } from "../storage/transport/ShardClient";
import type { FileManifest, FileStat } from "../storage/types";

type Listener = (e: CustomEvent) => void;

export interface RoomFileMetadata {
    name: string;
    type: string;
    path?: string;
    lastModified?: number;
}

export interface RoomDeps {
    name: string;
    wsBaseUrl: string;
    httpBaseUrl: string;
    /** Header-injecting fetch from the client's HttpClient. */
    fetch: typeof fetch;
    /** Resolves the user id used for the ratchet (the signed-in username). */
    myId: () => string;
    /** Resolves a short-lived WS upgrade ticket (or null when keyless). */
    fetchTicket: () => Promise<string | null>;
}

export class Room {
    readonly name: string;
    private channel: BroadcastChannel | null = null;
    private readonly pending: Array<[string, Listener]> = [];

    constructor(private readonly deps: RoomDeps) {
        this.name = deps.name;
    }

    // -- messaging -------------------------------------------------------------

    /** Open the room websocket (resolves the ticket + identity lazily). */
    async connect(): Promise<void> {
        if (!this.channel) {
            const ticket = await this.deps.fetchTicket();
            const url =
                `${this.deps.wsBaseUrl}/api/spaces/${encodeURIComponent(this.name)}/websocket` +
                (ticket ? `?ticket=${encodeURIComponent(ticket)}` : "");
            this.channel = new BroadcastChannel({ url, myId: this.deps.myId(), autoAnnounce: false });
            for (const [event, handler] of this.pending) this.channel.on(event, handler);
            this.pending.length = 0;
        }
        await this.channel.connect();
    }

    disconnect(): void {
        this.channel?.disconnect();
    }

    /** Subscribe to a channel event. Buffered until `connect()` if early. */
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

    /** Advertise our keyExchange to the room (idempotent per connection). */
    announce(): Promise<void> {
        return this.channel ? this.channel.announce() : Promise.resolve();
    }

    /** E2E-encrypt `text` to every peer; returns the recipient count. */
    send(text: string): Promise<number> {
        return this.channel ? this.channel.send(text) : Promise.resolve(0);
    }

    /** Send an arbitrary JSON frame (e.g. the `{name}` handshake). */
    sendRaw(frame: unknown): void {
        this.channel?.sendRaw(frame);
    }

    peers(): string[] {
        return this.channel ? this.channel.peers() : [];
    }

    isConnected(): boolean {
        return this.channel ? this.channel.isConnected() : false;
    }

    /** The underlying channel, for advanced use. `null` before `connect()`. */
    get raw(): BroadcastChannel | null {
        return this.channel;
    }

    // -- room-scoped files (no websocket needed) -------------------------------

    /** Encrypt + erasure-code + upload `file` to this room's shards. */
    async putFile(
        file: File | Blob | Uint8Array,
        metadata: RoomFileMetadata,
    ): Promise<{ manifest: FileManifest; stat: FileStat }> {
        return this.fileStorage().writeFileToShards({ data: file, metadata });
    }

    /** Fetch + decode a file previously shared in this room. */
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
}

export default Room;
