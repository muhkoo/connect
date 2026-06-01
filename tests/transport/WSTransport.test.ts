/**
 * WSTransport heartbeat / liveness tests.
 *
 * These cover the keep-alive added to keep long-lived Accelerator WebSockets
 * from going stale (CF / intermediaries drop idle sockets) and to detect a
 * silently-dropped connection that never fires `onclose`. A fake WebSocket +
 * fake timers let us drive the interval/deadline deterministically.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WSTransport } from '../../src/transport/WSTransport';
import { EventCoreEvents } from '../../src/events';

/** Minimal WebSocket double — records sent frames, lets the test fire events. */
class FakeWebSocket {
    static instances: FakeWebSocket[] = [];
    url: string;
    onopen: ((ev?: unknown) => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onerror: ((ev?: unknown) => void) | null = null;
    onclose: ((ev?: unknown) => void) | null = null;
    sent: string[] = [];
    closed = false;

    constructor(url: string) {
        this.url = url;
        FakeWebSocket.instances.push(this);
    }
    send(data: string): void { this.sent.push(data); }
    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.onclose?.();
    }
    // -- test drivers --
    fireOpen(): void { this.onopen?.(); }
    fireMessage(data: unknown): void { this.onmessage?.({ data }); }
    static last(): FakeWebSocket { return FakeWebSocket.instances.at(-1)!; }
    static reset(): void { FakeWebSocket.instances = []; }
}

/** Open a transport + its socket, returning both once CONNECTED resolves. */
async function connected(opts: Partial<ConstructorParameters<typeof WSTransport>[0]> = {}) {
    const transport = new WSTransport({ url: 'ws://localhost:8787/test', ...opts });
    const p = transport.connect();
    FakeWebSocket.last().fireOpen();
    await p;
    return { transport, socket: FakeWebSocket.last() };
}

describe('WSTransport — heartbeat', () => {
    const cleanups: Array<() => void> = [];

    beforeEach(() => {
        FakeWebSocket.reset();
        (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
        vi.useFakeTimers();
    });

    afterEach(() => {
        cleanups.splice(0).forEach((fn) => fn());
        vi.useRealTimers();
    });

    it('sends a ping frame once per interval while connected', async () => {
        const { socket } = await connected({ heartbeatInterval: 1000, heartbeatTimeout: 500 });
        expect(socket.sent).toEqual([]);

        vi.advanceTimersByTime(1000);
        expect(socket.sent).toEqual(['ping']);

        // A pong keeps the connection alive; the next interval pings again.
        socket.fireMessage('pong');
        vi.advanceTimersByTime(1000);
        expect(socket.sent).toEqual(['ping', 'ping']);
    });

    it('swallows pong frames — they never surface as MESSAGE', async () => {
        const { transport, socket } = await connected({ heartbeatInterval: 1000 });
        const messages: unknown[] = [];
        const handler = (e: CustomEvent) => messages.push(e.detail);
        transport.on(EventCoreEvents.MESSAGE, handler);
        cleanups.push(() => transport.off(EventCoreEvents.MESSAGE, handler));

        socket.fireMessage('pong');
        socket.fireMessage('{"real":"frame"}');

        expect(messages).toEqual(['{"real":"frame"}']);
    });

    it('forces a reconnect when no pong arrives within the timeout', async () => {
        const events: string[] = [];
        const onDisc = () => events.push('disconnected');
        const onReconn = () => events.push('reconnecting');
        const onErr = () => events.push('error');
        const { transport, socket } = await connected({
            heartbeatInterval: 1000,
            heartbeatTimeout: 500,
            reconnectDelay: 2000,
        });
        transport.on(EventCoreEvents.DISCONNECTED, onDisc);
        transport.on(EventCoreEvents.RECONNECTING, onReconn);
        transport.on(EventCoreEvents.ERROR, onErr);
        cleanups.push(() => {
            transport.off(EventCoreEvents.DISCONNECTED, onDisc);
            transport.off(EventCoreEvents.RECONNECTING, onReconn);
            transport.off(EventCoreEvents.ERROR, onErr);
        });

        vi.advanceTimersByTime(1000); // ping sent, liveness deadline armed
        expect(socket.sent).toEqual(['ping']);
        expect(transport.isConnected()).toBe(true);

        vi.advanceTimersByTime(500); // no pong → dead connection
        expect(socket.closed).toBe(true);
        expect(transport.isConnected()).toBe(false);
        expect(events).toContain('disconnected');
        expect(events).toContain('reconnecting');

        // Reconnect fires after the backoff delay → a fresh socket is opened.
        const before = FakeWebSocket.instances.length;
        vi.advanceTimersByTime(2000);
        expect(FakeWebSocket.instances.length).toBe(before + 1);
    });

    it('a received pong clears the deadline so no reconnect happens', async () => {
        const events: string[] = [];
        const onDisc = () => events.push('disconnected');
        const { transport, socket } = await connected({
            heartbeatInterval: 1000,
            heartbeatTimeout: 500,
        });
        transport.on(EventCoreEvents.DISCONNECTED, onDisc);
        cleanups.push(() => transport.off(EventCoreEvents.DISCONNECTED, onDisc));

        vi.advanceTimersByTime(1000); // ping
        socket.fireMessage('pong'); // ack before the deadline
        vi.advanceTimersByTime(500); // deadline would have fired

        expect(transport.isConnected()).toBe(true);
        expect(socket.closed).toBe(false);
        expect(events).not.toContain('disconnected');
    });

    it('stops the heartbeat on disconnect', async () => {
        const { transport, socket } = await connected({ heartbeatInterval: 1000 });
        transport.disconnect();
        vi.advanceTimersByTime(5000);
        expect(socket.sent).toEqual([]); // no pings after an explicit disconnect
    });
});

describe('WSTransport — event scoping', () => {
    beforeEach(() => {
        FakeWebSocket.reset();
        (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
        vi.useFakeTimers();
    });
    afterEach(() => vi.useRealTimers());

    it('does not cross-talk: each transport only hears its own frames', async () => {
        // Two independent connections sharing the global EventCore bus.
        const { transport: a, socket: sockA } = await connected({ id: 'room-a', heartbeatInterval: 0 });
        const { transport: b, socket: sockB } = await connected({ id: 'room-b', heartbeatInterval: 0 });

        const aMsgs: unknown[] = [];
        const bMsgs: unknown[] = [];
        const ha = (e: CustomEvent) => aMsgs.push(e.detail);
        const hb = (e: CustomEvent) => bMsgs.push(e.detail);
        a.on(EventCoreEvents.MESSAGE, ha);
        b.on(EventCoreEvents.MESSAGE, hb);

        sockA.fireMessage('for-a');
        sockB.fireMessage('for-b');

        expect(aMsgs).toEqual(['for-a']); // not 'for-b'
        expect(bMsgs).toEqual(['for-b']); // not 'for-a'

        a.off(EventCoreEvents.MESSAGE, ha);
        b.off(EventCoreEvents.MESSAGE, hb);
    });

    it('auto-generates a unique id when none is provided', async () => {
        const { transport: a, socket: sockA } = await connected({ heartbeatInterval: 0 });
        const { transport: b, socket: sockB } = await connected({ heartbeatInterval: 0 });
        expect(a.id).not.toBe(b.id);

        const aMsgs: unknown[] = [];
        const ha = (e: CustomEvent) => aMsgs.push(e.detail);
        a.on(EventCoreEvents.MESSAGE, ha);

        sockB.fireMessage('only-b'); // must not reach a's handler
        sockA.fireMessage('only-a');
        expect(aMsgs).toEqual(['only-a']);

        a.off(EventCoreEvents.MESSAGE, ha);
    });
});
