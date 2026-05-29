/**
 * `client.message` — realtime messaging over the shared-space primitive.
 *
 *   const sub = client.message.subscribe('todos', e => …)   // pub/sub feed
 *   await client.message.publish('todos', data)
 *   await client.message.send('user:abc', { text: 'Hello!' }) // E2E DM
 *
 * Two distinct modes, one transport (a shared-space room websocket via
 * {@link BroadcastChannel}):
 *
 *   - **pub/sub** — `publish`/`subscribe(subject)` ride plaintext `pub` frames
 *     the accelerator blind-relays to everyone in the room `pub:<subject>`.
 *   - **direct messages** — `send('user:x', …)` is end-to-end encrypted via the
 *     Double Ratchet, fanned out in the recipient's inbox room `inbox:x`;
 *     the recipient receives them by `subscribe('user:x', …)` (their own id).
 *
 * Every room websocket is opened with a short-lived signed ticket fetched from
 * `POST /api/ws-ticket` (browsers can't set the app-key header on
 * `new WebSocket()`), then completes the room's `{name}` → `{ready}` handshake
 * before any frame is sent.
 */

import type { HttpClient } from "../HttpClient";
import type { SessionState } from "../Session";
import { BroadcastChannel, BroadcastChannelEvents } from "../../sessions/BroadcastChannel";
import { Room } from "../Room";

/** The subset of {@link BroadcastChannel} this namespace drives (test seam). */
export interface ChannelLike {
    on(event: string, handler: (e: CustomEvent) => void): void;
    off(event: string, handler: (e: CustomEvent) => void): void;
    connect(): Promise<void>;
    disconnect(): void;
    announce(): Promise<void>;
    send(plaintext: string): Promise<number>;
    sendRaw(frame: unknown): void;
}

export interface MessageNamespaceDeps {
    http: HttpClient;
    session: SessionState;
    /** WebSocket base (ws/wss); derived from the accelerator baseUrl. */
    wsBaseUrl: string;
    /** Test seam — defaults to constructing a real {@link BroadcastChannel}. */
    createChannel?: (url: string, myId: string) => ChannelLike;
}

export interface MuhkooMessageEvent<T = unknown> {
    subject: string;
    from: string;
    data: T;
}

/** Handle returned by `subscribe`; call `.unsubscribe()` to detach. */
export interface MessageSubscription {
    subject: string;
    unsubscribe(): void;
}

interface RoomConn {
    channel: ChannelLike;
    /** Resolves once the room handshake (`{name}` → `{ready}`) completes. */
    ready: Promise<void>;
}

export class MessageNamespace {
    /** One connection per room, memoized. */
    private readonly rooms = new Map<string, Promise<RoomConn>>();

    constructor(private readonly deps: MessageNamespaceDeps) {}

    /**
     * Subscribe to a subject (pub/sub) or to this user's own id (`user:<me>`)
     * to receive direct messages. Returns an unsubscribe handle.
     */
    subscribe<T = unknown>(subject: string, handler: (e: MuhkooMessageEvent<T>) => void): MessageSubscription {
        const isDM = subject.startsWith("user:");
        const room = isDM ? `inbox:${subject.slice("user:".length)}` : `pub:${subject}`;
        const connP = this.getRoom(room, isDM);

        let detach = () => {};
        void connP.then(({ channel }) => {
            if (isDM) {
                const onMsg = (e: CustomEvent) => {
                    const { from, text } = (e.detail ?? {}) as { from: string; text: string };
                    handler({ subject, from, data: parseMaybeJson<T>(text) });
                };
                channel.on(BroadcastChannelEvents.MESSAGE, onMsg);
                detach = () => channel.off(BroadcastChannelEvents.MESSAGE, onMsg);
            } else {
                const onRaw = (e: CustomEvent) => {
                    const f = e.detail as { pub?: { subject: string; from?: string; data: T }; name?: string };
                    if (f?.pub && f.pub.subject === subject) {
                        handler({ subject, from: f.pub.from ?? f.name ?? "", data: f.pub.data });
                    }
                };
                channel.on(BroadcastChannelEvents.RAW_FRAME, onRaw);
                detach = () => channel.off(BroadcastChannelEvents.RAW_FRAME, onRaw);
            }
        });

        return { subject, unsubscribe: () => detach() };
    }

    /** Publish `data` to every subscriber of `subject` (plaintext fan-out). */
    async publish<T = unknown>(subject: string, data: T): Promise<void> {
        const { channel, ready } = await this.getRoom(`pub:${subject}`, false);
        await ready;
        channel.sendRaw({ pub: { subject, from: this.myId(), data } });
    }

    /**
     * Send an end-to-end-encrypted direct message to `user:<id>`. Delivered in
     * the recipient's inbox room; the recipient must be subscribed
     * (`subscribe('user:<id>')`) and online to receive it (E2E requires a live
     * ratchet between both parties).
     */
    async send<T = unknown>(target: string, payload: T): Promise<void> {
        if (!target.startsWith("user:")) {
            throw new Error("client.message.send: target must be 'user:<id>' (use publish() for pub/sub).");
        }
        const { channel, ready } = await this.getRoom(`inbox:${target.slice("user:".length)}`, true);
        await ready;
        await channel.announce();
        await channel.send(JSON.stringify(payload));
    }

    /**
     * Open a handle to a shared-space room — group E2E messaging plus
     * room-scoped file storage. The websocket isn't opened until
     * `room.connect()`; `room.putFile`/`getFile` work without it. This is the
     * primitive group chat is built on (`publish`/`subscribe`/`send` are the
     * higher-level conveniences layered over the same space transport).
     */
    room(roomName: string): Room {
        return new Room({
            name: roomName,
            wsBaseUrl: this.deps.wsBaseUrl,
            httpBaseUrl: this.deps.http.baseUrl,
            fetch: this.deps.http.fetch,
            myId: () => this.myId(),
            fetchTicket: () => this.fetchTicket(),
        });
    }

    /** Close every open room connection (e.g. on logout). */
    disconnect(): void {
        for (const p of this.rooms.values()) {
            void p.then(({ channel }) => channel.disconnect()).catch(() => {});
        }
        this.rooms.clear();
    }

    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------

    private getRoom(room: string, e2e: boolean): Promise<RoomConn> {
        let p = this.rooms.get(room);
        if (!p) {
            p = this.openRoom(room, e2e);
            this.rooms.set(room, p);
        }
        return p;
    }

    private async openRoom(room: string, _e2e: boolean): Promise<RoomConn> {
        const myId = this.myId();
        const ticket = await this.fetchTicket();
        const url =
            `${this.deps.wsBaseUrl}/api/spaces/${encodeURIComponent(room)}/websocket` +
            (ticket ? `?ticket=${encodeURIComponent(ticket)}` : "");

        const channel = (this.deps.createChannel ?? defaultCreateChannel)(url, myId);

        let resolveReady!: () => void;
        const ready = new Promise<void>((r) => { resolveReady = r; });

        // Room handshake: identify with `{name}` on every (re)connect, and
        // mark ready once the server echoes `{ready:true}`.
        channel.on(BroadcastChannelEvents.CONNECTED, () => channel.sendRaw({ name: myId }));
        channel.on(BroadcastChannelEvents.RAW_FRAME, (e: CustomEvent) => {
            if ((e.detail as { ready?: boolean })?.ready) resolveReady();
        });

        await channel.connect();
        return { channel, ready };
    }

    /** Fetch a short-lived WS upgrade ticket scoped to this app key. */
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
        if (!id) throw new Error("client.message: not signed in — call client.auth.zk.login() first.");
        return id;
    }
}

/** Default channel factory — a real `BroadcastChannel` over the room socket. */
function defaultCreateChannel(url: string, myId: string): ChannelLike {
    return new BroadcastChannel({ url, myId, autoAnnounce: false });
}

/** Parse a DM payload back from its JSON string, tolerating plain strings. */
function parseMaybeJson<T>(text: string): T {
    try {
        return JSON.parse(text) as T;
    } catch {
        return text as unknown as T;
    }
}

export default MessageNamespace;
