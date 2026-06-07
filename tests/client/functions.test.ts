/**
 * FunctionsNamespace tests — `client.functions.*` is a thin authenticated HTTP
 * wrapper over the accelerator's `/api/apps/:appId/functions` surface. We mock
 * the transport and assert the method, path, query (`?space=`), and body of each
 * call (no live server needed).
 */

import { describe, it, expect } from 'vitest';
import { FunctionsNamespace } from '../../src/core/namespaces/FunctionsNamespace';
import { HttpClient } from '../../src/core/HttpClient';
import { SessionState } from '../../src/core/Session';

const BASE_URL = 'http://localhost:8787';
const APP = 'app123';

interface Captured { method: string; path: string; body: unknown }

function makeFunctions() {
    const calls: Captured[] = [];
    const fetchFn = (async (input: any, init: any) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        calls.push({
            method: init?.method ?? 'GET',
            path: url.pathname + url.search,
            body: init?.body ? JSON.parse(init.body) : undefined,
        });
        // Echo a minimal config so callers don't choke on the shape.
        const reply = (obj: unknown) => new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } });
        if (url.pathname.endsWith('/functions') && (init?.method ?? 'GET') === 'GET') return reply({ functions: [{ functionId: 'fn1' }] });
        if (url.pathname.endsWith('/code')) return reply({ functionId: 'fn1', code: 'export default {}', codeHash: 'abc' });
        return reply({ config: { functionId: 'fn1' }, deleted: true });
    }) as unknown as typeof fetch;

    const session = new SessionState();
    const http = new HttpClient({ baseUrl: BASE_URL, getSessionToken: () => 't'.repeat(64), fetch: fetchFn });
    return { fns: new FunctionsNamespace({ http }), calls };
}

describe('FunctionsNamespace', () => {
    it('list → GET /functions, unwraps the array', async () => {
        const { fns, calls } = makeFunctions();
        const out = await fns.list(APP);
        expect(out).toEqual([{ functionId: 'fn1' }]);
        expect(calls[0]).toMatchObject({ method: 'GET', path: `/api/apps/${APP}/functions` });
    });

    it('passes the management Space as ?space= on reads', async () => {
        const { fns, calls } = makeFunctions();
        await fns.list(APP, { space: 'space9' });
        expect(calls[0].path).toBe(`/api/apps/${APP}/functions?space=space9`);
    });

    it('deploy → POST /functions with the input + space in the body', async () => {
        const { fns, calls } = makeFunctions();
        await fns.deploy(APP, { name: 'hello', displayName: 'Hi', code: 'export default {}' }, { space: 'space9' });
        expect(calls[0]).toMatchObject({
            method: 'POST',
            path: `/api/apps/${APP}/functions`,
            body: { name: 'hello', displayName: 'Hi', code: 'export default {}', space: 'space9' },
        });
    });

    it('update → PATCH /functions/:id (code rides in the body for redeploy)', async () => {
        const { fns, calls } = makeFunctions();
        await fns.update(APP, 'fn1', { code: 'export default { fetch(){} }' });
        expect(calls[0]).toMatchObject({
            method: 'PATCH',
            path: `/api/apps/${APP}/functions/fn1`,
            body: { code: 'export default { fetch(){} }' },
        });
    });

    it('code → GET /functions/:id/code returns decrypted source', async () => {
        const { fns, calls } = makeFunctions();
        const res = await fns.code(APP, 'fn1');
        expect(res.code).toBe('export default {}');
        expect(calls[0]).toMatchObject({ method: 'GET', path: `/api/apps/${APP}/functions/fn1/code` });
    });

    it('enable/disable → POST with targetSpaceId', async () => {
        const { fns, calls } = makeFunctions();
        await fns.enable(APP, 'fn1', 'spaceX');
        await fns.disable(APP, 'fn1', 'spaceX');
        expect(calls[0]).toMatchObject({ method: 'POST', path: `/api/apps/${APP}/functions/fn1/enable`, body: { targetSpaceId: 'spaceX' } });
        expect(calls[1]).toMatchObject({ method: 'POST', path: `/api/apps/${APP}/functions/fn1/disable`, body: { targetSpaceId: 'spaceX' } });
    });

    it('delete → DELETE /functions/:id', async () => {
        const { fns, calls } = makeFunctions();
        await fns.delete(APP, 'fn1');
        expect(calls[0]).toMatchObject({ method: 'DELETE', path: `/api/apps/${APP}/functions/fn1` });
    });
});
