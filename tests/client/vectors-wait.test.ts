/**
 * Waiting for vector writes to become searchable: `onReady`, `waitFor` and
 * `upsertAndWait`. Fake timers, a fake Space and a scripted status sequence.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VectorsNamespace, VectorWaitTimeoutError } from '../../src/core/namespaces/VectorsNamespace';
import { HttpClient } from '../../src/core/HttpClient';
import { HttpError } from '../../src/core/HttpError';

const BASE_URL = 'http://localhost:8787';
const SENDER = '__muhkoo__';
const SUBJECT = 'muhkoo.vectors.ready';

type Reply = { status: number; body: unknown };

function setup(opts: { statuses?: Array<string | 'fail'>; upsert?: Reply | (() => Reply) } = {}) {
    const statuses = [...(opts.statuses ?? [])];
    const statusTimes: number[] = [];
    let upsertCalls = 0;
    let onUpsert: (() => void) | null = null;
    const fetchFn = (async (input: any) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        let r: Reply;
        if (url.pathname.endsWith('/upsert')) {
            upsertCalls++;
            onUpsert?.();
            const u = opts.upsert;
            r = typeof u === 'function' ? u() : u ?? { status: 200, body: { mutationId: 'm1', count: 1 } };
        } else if (url.pathname.endsWith('/status')) {
            statusTimes.push(Date.now());
            const s = statuses.length > 1 ? statuses.shift()! : statuses[0] ?? 'pending';
            r = s === 'fail' ? { status: 500, body: { error: 'boom', code: 'x' } } : { status: 200, body: { mutationId: 'm1', state: s } };
        } else {
            r = { status: 404, body: { error: 'nope', code: 'x' } };
        }
        return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
    const http = new HttpClient({ baseUrl: BASE_URL, getSessionToken: () => 't'.repeat(64), fetch: fetchFn });
    const docs = new VectorsNamespace({ http }).collection('docs');
    return {
        docs,
        statusTimes,
        get upsertCalls() { return upsertCalls; },
        setOnUpsert(f: () => void) { onUpsert = f; },
    };
}

function fakeSpace(connected = true) {
    const handlers = new Set<(e: { from: string; subject: string; data: unknown }) => void>();
    const space = {
        connected,
        onEphemeral(h: (e: { from: string; subject: string; data: unknown }) => void) {
            handlers.add(h);
            return () => { handlers.delete(h); };
        },
        isConnected() { return space.connected; },
        emit(e: { from: string; subject: string; data: unknown }) { for (const h of [...handlers]) h(e); },
        get listeners() { return handlers.size; },
    };
    return space;
}

const ready = (mutationId: string, collection = 'docs') =>
    ({ from: SENDER, subject: SUBJECT, data: { collection, ids: ['a'], mutationId } });

/** Let pending promise callbacks (fetch, json) run. */
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

describe('vector waits', () => {
    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
    afterEach(() => { vi.useRealTimers(); });

    it('onReady ignores other senders, other subjects and other collections', () => {
        const { docs } = setup();
        const space = fakeSpace();
        const seen: unknown[] = [];
        const off = docs.onReady(space as any, (e) => seen.push(e));
        space.emit({ ...ready('m1'), from: 'mallory' });
        space.emit({ ...ready('m1'), subject: 'other' });
        space.emit(ready('m1', 'notes'));
        space.emit({ from: SENDER, subject: SUBJECT, data: { collection: 'docs' } });
        space.emit({ from: SENDER, subject: SUBJECT, data: null });
        expect(seen).toEqual([]);
        space.emit(ready('m1'));
        expect(seen).toEqual([{ collection: 'docs', ids: ['a'], mutationId: 'm1' }]);
        off();
        expect(space.listeners).toBe(0);
    });

    it('waitFor resolves on the notice', async () => {
        const { docs } = setup({ statuses: ['pending'] });
        const space = fakeSpace();
        let done = false;
        const p = docs.waitFor('m1', { space: space as any }).then(() => { done = true; });
        space.emit({ ...ready('m1'), from: 'mallory' });
        space.emit(ready('other'));
        await flush();
        expect(done).toBe(false);
        space.emit(ready('m1'));
        await p;
        expect(space.listeners).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('waitFor without a space polls 250, 500, 1000… capped at 4000 until done', async () => {
        const s = setup({ statuses: ['pending', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending', 'done'] });
        const p = s.docs.waitFor('m1');
        await vi.advanceTimersByTimeAsync(30_000);
        await p;
        expect(s.statusTimes).toEqual([250, 750, 1750, 3750, 7750, 11750, 15750, 19750]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('waitFor with a connected space still polls every 5 s and resolves on done', async () => {
        const s = setup({ statuses: ['pending', 'pending', 'done'] });
        const space = fakeSpace(true);
        const p = s.docs.waitFor('m1', { space: space as any });
        await vi.advanceTimersByTimeAsync(20_000);
        await p;
        expect(s.statusTimes).toEqual([5000, 10000, 15000]);
        expect(space.listeners).toBe(0);
    });

    it('a failed status call is retried at the same cadence', async () => {
        const s = setup({ statuses: ['fail', 'fail', 'done'] });
        const p = s.docs.waitFor('m1');
        await vi.advanceTimersByTimeAsync(5_000);
        await p;
        expect(s.statusTimes).toEqual([250, 750, 1750]);
    });

    it('a notice that arrives before the upsert response resolves upsertAndWait', async () => {
        const s = setup({ statuses: ['pending'] });
        const space = fakeSpace(true);
        s.setOnUpsert(() => space.emit(ready('m1')));
        const out = await s.docs.upsertAndWait([{ id: 'a', text: 'x' }], { space: space as any });
        expect(out).toEqual({ mutationId: 'm1', count: 1 });
        expect(s.statusTimes).toEqual([]);
        expect(space.listeners).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('the space disconnecting mid-wait falls back to polling and resolves', async () => {
        const s = setup({ statuses: ['pending', 'pending', 'pending', 'done'] });
        const space = fakeSpace(true);
        const p = s.docs.waitFor('m1', { space: space as any });
        await vi.advanceTimersByTimeAsync(5_000);
        expect(s.statusTimes).toEqual([5000]);
        space.connected = false;
        // The 5 s backstop already scheduled still fires; backoff starts after it.
        await vi.advanceTimersByTimeAsync(10_000);
        await p;
        expect(s.statusTimes).toEqual([5000, 10000, 10250, 10750]);
        expect(space.listeners).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('the timeout rejects with VectorWaitTimeoutError carrying the mutationId, and unsubscribes', async () => {
        const s = setup({ statuses: ['pending'] });
        const space = fakeSpace(true);
        const p = s.docs.waitFor('m1', { space: space as any, timeoutMs: 12_000 });
        const caught = p.catch((e) => e);
        await vi.advanceTimersByTimeAsync(12_000);
        const err = await caught;
        expect(err).toBeInstanceOf(VectorWaitTimeoutError);
        expect(err.name).toBe('VectorWaitTimeoutError');
        expect(err.mutationId).toBe('m1');
        expect(space.listeners).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('the default timeout is 300,000 ms', async () => {
        const s = setup({ statuses: ['pending'] });
        const caught = s.docs.waitFor('m1').catch((e) => e);
        await vi.advanceTimersByTimeAsync(299_999);
        let settled = false;
        caught.then(() => { settled = true; });
        await flush();
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(await caught).toBeInstanceOf(VectorWaitTimeoutError);
    });

    it('unknown rejects', async () => {
        const s = setup({ statuses: ['unknown'] });
        const space = fakeSpace(false);
        const caught = s.docs.waitFor('m1', { space: space as any }).catch((e) => e);
        await vi.advanceTimersByTimeAsync(250);
        const err = await caught;
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toBe('Unknown mutation m1');
        expect(space.listeners).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('an upsert 402 rejects at once without polling', async () => {
        const body = { error: 'Vector search requires a paid plan.', requiresPaidTier: true, tier: 'free' };
        const s = setup({ upsert: { status: 402, body } });
        const space = fakeSpace(true);
        const err = await s.docs.upsertAndWait([{ id: 'a', text: 'x' }], { space: space as any }).catch((e) => e);
        expect(err).toBeInstanceOf(HttpError);
        expect(err.status).toBe(402);
        expect(err.body.requiresPaidTier).toBe(true);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(s.statusTimes).toEqual([]);
        expect(space.listeners).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });
});
