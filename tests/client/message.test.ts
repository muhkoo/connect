/**
 * Message namespace tests.
 *
 * Drives `client.message` over a fake room channel (injected via
 * `createChannel`) and a mocked ws-ticket fetch, so the pub/sub framing, the
 * room-name mapping, the `{name}` handshake, and the DM path are all exercised
 * without a live websocket. (True E2E delivery between two peers is validated
 * once the web app is on the client.)
 */

import { describe, it, expect } from 'vitest';
import { MessageNamespace, type ChannelLike } from '../../src/core/namespaces/MessageNamespace';
import { BroadcastChannelEvents } from '../../src/sessions/BroadcastChannel';
import { HttpClient } from '../../src/core/HttpClient';
import { SessionState } from '../../src/core/Session';

const tick = () => new Promise((r) => setTimeout(r, 5));

class FakeChannel implements ChannelLike {
    private et = new EventTarget();
    sentRaw: any[] = [];
    sent: string[] = [];
    announced = 0;
    on(ev: string, h: (e: CustomEvent) => void) { this.et.addEventListener(ev, h as EventListener); }
    off(ev: string, h: (e: CustomEvent) => void) { this.et.removeEventListener(ev, h as EventListener); }
    emit(ev: string, detail?: unknown) { this.et.dispatchEvent(new CustomEvent(ev, { detail })); }
    async connect() {
        // Mimic the room handshake: connected → server echoes ready.
        this.emit(BroadcastChannelEvents.CONNECTED);
        this.emit(BroadcastChannelEvents.RAW_FRAME, { ready: true });
    }
    disconnect() {}
    async announce() { this.announced++; }
    async send(plaintext: string) { this.sent.push(plaintext); return 1; }
    sendRaw(frame: unknown) { this.sentRaw.push(frame); }
}

function makeMessage(username = 'alice') {
    const session = new SessionState();
    void session.setSession({ token: 't'.repeat(64), username, commitment: '1' });
    const fetchFn = (async () =>
        new Response(JSON.stringify({ ticket: 'tkt', ttlSeconds: 30 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        })) as unknown as typeof fetch;
    const http = new HttpClient({ baseUrl: 'http://x', apiKey: 'mk_test_pk_' + 'a'.repeat(32), getSessionToken: () => session.token, fetch: fetchFn });

    const created: Array<{ url: string; channel: FakeChannel }> = [];
    const createChannel = (url: string) => {
        const channel = new FakeChannel();
        created.push({ url, channel });
        return channel;
    };
    const message = new MessageNamespace({ http, session, wsBaseUrl: 'ws://x', createChannel });
    const channelFor = (roomFragment: string) =>
        created.find((c) => c.url.includes(encodeURIComponent(roomFragment)))?.channel;
    return { message, channelFor };
}

describe('client.message — pub/sub', () => {
    it('publish sends a pub frame after the room handshake', async () => {
        const { message, channelFor } = makeMessage();
        await message.publish('todos', { x: 1 });

        const ch = channelFor('pub:todos')!;
        expect(ch).toBeDefined();
        // First frame is the {name} handshake, then the pub frame.
        expect(ch.sentRaw[0]).toEqual({ name: 'alice' });
        expect(ch.sentRaw).toContainEqual({ pub: { subject: 'todos', from: 'alice', data: { x: 1 } } });
    });

    it('subscribe delivers matching pub frames and filters others', async () => {
        const { message, channelFor } = makeMessage();
        const got: any[] = [];
        message.subscribe('todos', (e) => got.push(e));
        await tick(); // let the room open + listener attach

        const ch = channelFor('pub:todos')!;
        ch.emit(BroadcastChannelEvents.RAW_FRAME, { pub: { subject: 'todos', from: 'bob', data: { y: 2 } } });
        ch.emit(BroadcastChannelEvents.RAW_FRAME, { pub: { subject: 'other', from: 'bob', data: { z: 3 } } });

        expect(got).toEqual([{ subject: 'todos', from: 'bob', data: { y: 2 } }]);
    });

    it('unsubscribe detaches the handler', async () => {
        const { message, channelFor } = makeMessage();
        const got: any[] = [];
        const sub = message.subscribe('todos', (e) => got.push(e));
        await tick();
        sub.unsubscribe();
        await tick();

        const ch = channelFor('pub:todos')!;
        ch.emit(BroadcastChannelEvents.RAW_FRAME, { pub: { subject: 'todos', from: 'bob', data: { y: 2 } } });
        expect(got).toEqual([]);
    });
});

describe('client.message — createRoom', () => {
    function makeWithSpacesFetch(json: unknown, status = 200) {
        const session = new SessionState();
        void session.setSession({ token: 't'.repeat(64), username: 'alice', commitment: '1' });
        const calls: Array<{ url: string; method: string }> = [];
        const fetchFn = (async (input: any, init: any) => {
            const url = typeof input === 'string' ? input : input.url;
            calls.push({ url, method: init?.method ?? 'GET' });
            return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } });
        }) as unknown as typeof fetch;
        const http = new HttpClient({ baseUrl: 'http://x', getSessionToken: () => session.token, fetch: fetchFn });
        const message = new MessageNamespace({ http, session, wsBaseUrl: 'ws://x' });
        return { message, calls };
    }

    it('POSTs /api/spaces and returns the minted spaceId', async () => {
        const spaceId = 'a'.repeat(64);
        const { message, calls } = makeWithSpacesFetch({ spaceId });
        await expect(message.createRoom()).resolves.toBe(spaceId);
        expect(calls).toContainEqual({ url: 'http://x/api/spaces', method: 'POST' });
    });

    it('rejects a malformed (non 64-hex) spaceId', async () => {
        const { message } = makeWithSpacesFetch({ spaceId: 'nope' });
        await expect(message.createRoom()).rejects.toThrow(/64-hex/);
    });
});

describe('client.message — direct messages', () => {
    it('send E2E-encrypts to the recipient inbox room', async () => {
        const { message, channelFor } = makeMessage('alice');
        await message.send('user:bob', { text: 'hi' });

        const ch = channelFor('inbox:bob')!;
        expect(ch).toBeDefined();
        expect(ch.announced).toBeGreaterThan(0);
        expect(ch.sent).toContain(JSON.stringify({ text: 'hi' }));
    });

    it('subscribe to own id receives decrypted DMs', async () => {
        const { message, channelFor } = makeMessage('alice');
        const got: any[] = [];
        message.subscribe('user:alice', (e) => got.push(e));
        await tick();

        const ch = channelFor('inbox:alice')!;
        ch.emit(BroadcastChannelEvents.MESSAGE, { from: 'bob', text: JSON.stringify({ text: 'yo' }) });

        expect(got).toEqual([{ subject: 'user:alice', from: 'bob', data: { text: 'yo' } }]);
    });

    it('send rejects a non-user target', async () => {
        const { message } = makeMessage();
        await expect(message.send('todos', { x: 1 })).rejects.toThrow(/user:/);
    });
});
