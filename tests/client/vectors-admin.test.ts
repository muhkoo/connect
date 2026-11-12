/**
 * VectorsNamespace owner management — list/get/create/drop/setNotices/
 * waitForCollection over `/api/apps/:appId/vectors/collections`. The transport
 * is mocked; we assert method, path and body.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { VectorsNamespace, VectorCollectionFailedError } from '../../src/core/namespaces/VectorsNamespace';
import type { VectorCollectionInfo } from '../../src/core/namespaces/VectorsNamespace';
import { HttpClient } from '../../src/core/HttpClient';
import { HttpError } from '../../src/core/HttpError';

const BASE_URL = 'http://localhost:8787';
const BASE = '/api/apps/app1/vectors/collections';

interface Captured { method: string; path: string; body: unknown; session: string | null }
type Reply = { status: number; body: unknown };

function info(status: VectorCollectionInfo['status'], error: string | null = null): VectorCollectionInfo {
    const env = { status, entries: null, notices: { spaces: [], defaultSpace: null }, error };
    return {
        name: 'docs', mode: 'text', model: 'bge-base-en-v1.5', dimensions: 768, metric: 'cosine',
        fields: [], access: 'app', createdAt: 1, status, envs: { live: env, test: env },
    };
}

function make(respond: (method: string, path: string) => Reply) {
    const calls: Captured[] = [];
    const fetchFn = (async (input: any, init: any) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        const path = url.pathname + url.search;
        const method = init?.method ?? 'GET';
        const headers = new Headers(init?.headers);
        calls.push({ method, path, body: init?.body ? JSON.parse(init.body) : undefined, session: headers.get('X-Muhkoo-Session') });
        const r = respond(method, path);
        return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
    const http = new HttpClient({ baseUrl: BASE_URL, getSessionToken: () => 't'.repeat(64), fetch: fetchFn });
    return { vectors: new VectorsNamespace({ http }), calls };
}

afterEach(() => { vi.useRealTimers(); });

describe('VectorsNamespace owner API', () => {
    it('each method hits its path, method and body', async () => {
        const { vectors, calls } = make((method, path) => {
            if (method === 'GET' && path === BASE) return { status: 200, body: { collections: [info('ready')] } };
            if (method === 'DELETE') return { status: 202, body: { name: 'docs', status: 'dropping' } };
            if (method === 'PUT') return { status: 202, body: info('creating') };
            return { status: 200, body: info('ready') };
        });
        const def = { mode: 'text' as const, fields: [{ name: 'category', type: 'string' as const }] };
        expect(await vectors.listCollections('app1')).toEqual([info('ready')]);
        expect(await vectors.getCollection('app1', 'docs')).toEqual(info('ready'));
        expect(await vectors.createCollection('app1', 'docs', def)).toEqual(info('creating'));
        expect(await vectors.dropCollection('app1', 'docs')).toBeUndefined();
        expect(calls.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
            { method: 'GET', path: BASE, body: undefined },
            { method: 'GET', path: `${BASE}/docs`, body: undefined },
            { method: 'PUT', path: `${BASE}/docs`, body: def },
            { method: 'DELETE', path: `${BASE}/docs`, body: undefined },
        ]);
        expect(calls.every((c) => c.session === 't'.repeat(64))).toBe(true);
    });

    it('setNotices puts env in the query string', async () => {
        const { vectors, calls } = make(() => ({ status: 200, body: { env: 'test', spaces: ['s1'], defaultSpace: 's1' } }));
        const out = await vectors.setNotices('app1', 'docs', 'test', { spaces: ['s1'], defaultSpace: 's1' });
        expect(out).toEqual({ env: 'test', spaces: ['s1'], defaultSpace: 's1' });
        expect(calls[0]).toMatchObject({ method: 'PATCH', path: `${BASE}/docs/notices?env=test`, body: { spaces: ['s1'], defaultSpace: 's1' } });
    });

    it('waitForCollection polls through creating to ready', async () => {
        vi.useFakeTimers();
        const seq = ['creating', 'creating', 'ready'] as const;
        let i = 0;
        const { vectors, calls } = make(() => ({ status: 200, body: info(seq[Math.min(i++, 2)]) }));
        const p = vectors.waitForCollection('app1', 'docs');
        await vi.advanceTimersByTimeAsync(0);
        expect(calls).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1_999);
        expect(calls).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(calls).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(2_000);
        expect((await p).status).toBe('ready');
        expect(calls).toHaveLength(3);
    });

    it('waitForCollection times out after 600,000 ms by default', async () => {
        vi.useFakeTimers();
        const { vectors } = make(() => ({ status: 200, body: info('creating') }));
        const p = vectors.waitForCollection('app1', 'docs');
        const caught = p.catch((e) => e);
        await vi.advanceTimersByTimeAsync(599_000);
        let settled = false;
        void p.then(() => { settled = true; }, () => { settled = true; });
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(2_000);
        const err = await caught;
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toBe('Timed out waiting for collection docs');
    });

    it('failed throws VectorCollectionFailedError carrying info', async () => {
        const failed = info('failed', 'boom');
        const { vectors } = make(() => ({ status: 200, body: failed }));
        const err = await vectors.waitForCollection('app1', 'docs').catch((e) => e);
        expect(err).toBeInstanceOf(VectorCollectionFailedError);
        expect(err.name).toBe('VectorCollectionFailedError');
        expect(err.info).toEqual(failed);
    });

    it('a 409 collection_exists surfaces as an HttpError with body.code', async () => {
        const { vectors } = make(() => ({ status: 409, body: { error: 'exists', code: 'collection_exists' } }));
        const err = await vectors.createCollection('app1', 'docs', { mode: 'vectors', dimensions: 384 }).catch((e) => e);
        expect(err).toBeInstanceOf(HttpError);
        expect(err.status).toBe(409);
        expect(err.body.code).toBe('collection_exists');
    });
});
