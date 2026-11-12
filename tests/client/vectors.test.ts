/**
 * VectorsNamespace tests — `client.vectors.collection(name)` is a thin HTTP
 * wrapper over the accelerator's `/api/vectors/:collection/*` data API. We mock
 * the transport and assert method, path and body (no live server needed).
 */

import { describe, it, expect } from 'vitest';
import { VectorsNamespace } from '../../src/core/namespaces/VectorsNamespace';
import { HttpClient } from '../../src/core/HttpClient';
import { HttpError } from '../../src/core/HttpError';
import { PaymentRequiredError } from '../../src/core/PaymentRequiredError';

const BASE_URL = 'http://localhost:8787';

interface Captured { method: string; path: string; body: unknown }

function makeVectors(respond?: (path: string) => { status: number; body: unknown }) {
    const calls: Captured[] = [];
    const fetchFn = (async (input: any, init: any) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        const path = url.pathname + url.search;
        calls.push({
            method: init?.method ?? 'GET',
            path,
            body: init?.body ? JSON.parse(init.body) : undefined,
        });
        const r = respond?.(url.pathname) ?? defaultReply(url.pathname);
        return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
    const http = new HttpClient({ baseUrl: BASE_URL, getSessionToken: () => 't'.repeat(64), fetch: fetchFn });
    return { vectors: new VectorsNamespace({ http }), calls };
}

function defaultReply(pathname: string): { status: number; body: unknown } {
    if (pathname.endsWith('/upsert')) return { status: 200, body: { mutationId: 'm1', count: 2 } };
    if (pathname.endsWith('/delete')) return { status: 200, body: { mutationId: 'm2', count: 1 } };
    if (pathname.endsWith('/query')) return { status: 200, body: { matches: [{ id: 'a', score: 0.9 }] } };
    if (pathname.endsWith('/get')) return { status: 200, body: { entries: [{ id: 'a', data: { k: 1 } }] } };
    if (pathname.endsWith('/status')) return { status: 200, body: { mutationId: 'm/1', state: 'done' } };
    return { status: 404, body: { error: 'nope', code: 'x' } };
}

describe('VectorsNamespace', () => {
    it('upsert posts entries and notify to /api/vectors/docs/upsert and returns {mutationId,count}', async () => {
        const { vectors, calls } = makeVectors();
        const entries = [{ id: 'a', text: 'hi' }, { id: 'b', vector: [1, 2], data: { c: 'x' } }];
        const out = await vectors.collection('docs').upsert(entries, { notify: { space: 's1', audience: 'writer' } });
        expect(out).toEqual({ mutationId: 'm1', count: 2 });
        expect(calls[0]).toEqual({ method: 'POST', path: '/api/vectors/docs/upsert', body: { entries, notify: { space: 's1', audience: 'writer' } } });
    });

    it('upsert omits notify when not given and sends false when false', async () => {
        const { vectors, calls } = makeVectors();
        const docs = vectors.collection('docs');
        await docs.upsert([{ id: 'a', text: 'x' }]);
        await docs.upsert([{ id: 'a', text: 'x' }], { notify: false });
        expect(calls[0].body).toEqual({ entries: [{ id: 'a', text: 'x' }] });
        expect('notify' in (calls[0].body as object)).toBe(false);
        expect(calls[1].body).toEqual({ entries: [{ id: 'a', text: 'x' }], notify: false });
    });

    it('query returns matches', async () => {
        const { vectors, calls } = makeVectors();
        const input = { text: 'reset', topK: 3, filter: { category: 'faq' }, includeData: true };
        const out = await vectors.collection('docs').query(input);
        expect(out).toEqual([{ id: 'a', score: 0.9 }]);
        expect(calls[0]).toEqual({ method: 'POST', path: '/api/vectors/docs/query', body: input });
    });

    it('get sends includeVector only when set and returns entries', async () => {
        const { vectors, calls } = makeVectors();
        const docs = vectors.collection('docs');
        const out = await docs.get(['a']);
        await docs.get(['a'], { includeVector: true });
        expect(out).toEqual([{ id: 'a', data: { k: 1 } }]);
        expect(calls[0]).toEqual({ method: 'POST', path: '/api/vectors/docs/get', body: { ids: ['a'] } });
        expect(calls[1].body).toEqual({ ids: ['a'], includeVector: true });
    });

    it('delete posts ids', async () => {
        const { vectors, calls } = makeVectors();
        const out = await vectors.collection('docs').delete(['a']);
        expect(out).toEqual({ mutationId: 'm2', count: 1 });
        expect(calls[0]).toEqual({ method: 'POST', path: '/api/vectors/docs/delete', body: { ids: ['a'] } });
    });

    it('status hits ?mutation= with the id encoded and returns state', async () => {
        const { vectors, calls } = makeVectors();
        const out = await vectors.collection('docs').status('m/1&x');
        expect(out).toBe('done');
        expect(calls[0]).toMatchObject({ method: 'GET', path: '/api/vectors/docs/status?mutation=m%2F1%26x' });
    });

    it('a collection name with a slash is encoded', async () => {
        const { vectors, calls } = makeVectors();
        const c = vectors.collection('a/b');
        expect(c.name).toBe('a/b');
        await c.delete(['x']);
        expect(calls[0].path).toBe('/api/vectors/a%2Fb/delete');
    });

    it('a 402 with requiresPaidTier is an HttpError, not a PaymentRequiredError', async () => {
        const body = {
            error: 'Vector search requires a paid plan. Upgrade to create or use collections.',
            requiresPaidTier: true, tier: 'free', upgradeUrl: '/api/developer/billing/checkout',
        };
        const { vectors } = makeVectors(() => ({ status: 402, body }));
        const err = await vectors.collection('docs').query({ text: 'x' }).catch((e) => e);
        expect(err).toBeInstanceOf(HttpError);
        expect(err).not.toBeInstanceOf(PaymentRequiredError);
        expect(err.status).toBe(402);
        expect(err.body.requiresPaidTier).toBe(true);
    });
});

describe('Client wiring', () => {
    it('new Client({ baseUrl, apiKey }).vectors is a VectorsNamespace', async () => {
        const { Client } = await import('../../src/core/Client');
        const client = new Client({ baseUrl: BASE_URL, apiKey: 'mk_test_pub_x' });
        expect(client.vectors).toBeInstanceOf(VectorsNamespace);
    });
});
