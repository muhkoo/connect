/**
 * Client facade tests.
 *
 * Exercises the unified `Client` surface (`client.auth` / `client.storage` /
 * `client.message`) and the shared HTTP credential plumbing. The full ZK
 * `login()` proof path needs snarkjs (an externalized peer dep, not installed
 * here), so these tests cover everything around it: construction, header
 * injection, the register round-trip, session restore, and logout. Real
 * identity derivation + Poseidon commitment run (circomlibjs is installed).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Client } from '../../src/core/Client';
import { MemorySessionStore } from '../../src/core/Session';

const BASE_URL = 'http://localhost:8787';
const API_KEY = 'mk_test_pk_0123456789abcdef0123456789abcdef';

/** Records every request and returns canned JSON responses keyed by path. */
function makeFetch(routes: Record<string, (body: any) => { status?: number; json: any }>) {
    const calls: Array<{ url: string; method: string; headers: Headers; body: any }> = [];
    const fetchFn = (async (input: any, init: any) => {
        const url = typeof input === 'string' ? input : input.url;
        const headers = new Headers(init?.headers);
        const body = init?.body ? JSON.parse(init.body) : undefined;
        calls.push({ url, method: init?.method ?? 'GET', headers, body });

        const match = Object.keys(routes).find((p) => url.endsWith(p));
        if (!match) return new Response('not found', { status: 404 });
        const { status = 200, json } = routes[match](body);
        return new Response(JSON.stringify(json), {
            status,
            headers: { 'Content-Type': 'application/json' },
        });
    }) as unknown as typeof fetch;

    return { fetchFn, calls };
}

describe('Client — construction', () => {
    it('requires baseUrl; apiKey is optional', () => {
        // @ts-expect-error intentionally missing baseUrl
        expect(() => new Client({ apiKey: API_KEY })).toThrow(/baseUrl/);
        // No apiKey is fine — auth + storage work without one.
        expect(() => new Client({ baseUrl: BASE_URL })).not.toThrow();
    });

    it('exposes auth / storage / message namespaces', () => {
        const client = new Client({ apiKey: API_KEY, baseUrl: BASE_URL });
        expect(client.auth).toBeDefined();
        expect(client.auth.zk).toBeDefined();
        expect(client.storage).toBeDefined();
        expect(client.message).toBeDefined();
        expect(client.isAuthenticated).toBe(false);
        expect(client.user).toBeNull();
    });

    it('strips a trailing slash from baseUrl', () => {
        const client = new Client({ apiKey: API_KEY, baseUrl: BASE_URL + '/' });
        expect(client.baseUrl).toBe(BASE_URL);
    });
});

describe('Client — credential injection', () => {
    it('stamps the app key on auth requests', async () => {
        const { fetchFn, calls } = makeFetch({
            '/api/auth/zk-register': () => ({ json: { success: true } }),
        });
        const client = new Client({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: fetchFn });

        await client.auth.zk.register({ username: 'alice', password: 'hunter2-correct', login: false });

        const reg = calls.find((c) => c.url.endsWith('/api/auth/zk-register'))!;
        expect(reg).toBeDefined();
        expect(reg.method).toBe('POST');
        expect(reg.headers.get('X-Muhkoo-Key')).toBe(API_KEY);
        // No session yet → no session header.
        expect(reg.headers.get('X-Muhkoo-Session')).toBeNull();
        // Real derivation produced a decimal-string commitment + base64 keys.
        expect(reg.body.username).toBe('alice');
        expect(reg.body.commitment).toMatch(/^[0-9]+$/);
        expect(typeof reg.body.ecdhPublicKey).toBe('string');
        expect(typeof reg.body.ecdsaPublicKey).toBe('string');
    });

    it('stamps the session token on requests once a session exists', async () => {
        const store = new MemorySessionStore();
        store.save({ token: 'sess-tok-123', username: 'bob', commitment: '42' });

        const { fetchFn, calls } = makeFetch({
            '/api/auth/verify': () => ({ json: { username: 'bob' } }),
        });
        const client = new Client({
            apiKey: API_KEY,
            baseUrl: BASE_URL,
            fetch: fetchFn,
            sessionStore: store,
        });

        const user = await client.auth.zk.restore();
        expect(user).toEqual({ username: 'bob', commitment: '42' });
        expect(client.isAuthenticated).toBe(true);

        const verify = calls.find((c) => c.url.endsWith('/api/auth/verify'))!;
        expect(verify.headers.get('X-Muhkoo-Key')).toBe(API_KEY);
        expect(verify.headers.get('X-Muhkoo-Session')).toBe('sess-tok-123');
    });
});

describe('Client — session lifecycle', () => {
    it('restore() drops a stale token when verify fails', async () => {
        const store = new MemorySessionStore();
        store.save({ token: 'stale', username: 'carol', commitment: '7' });

        const { fetchFn } = makeFetch({
            '/api/auth/verify': () => ({ status: 401, json: { error: 'expired' } }),
        });
        const client = new Client({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: fetchFn, sessionStore: store });

        const user = await client.auth.zk.restore();
        expect(user).toBeNull();
        expect(client.isAuthenticated).toBe(false);
        expect(store.load()).toBeNull();
    });

    it('logout() clears session state', async () => {
        const store = new MemorySessionStore();
        store.save({ token: 't', username: 'dave', commitment: '9' });
        const { fetchFn } = makeFetch({ '/api/auth/verify': () => ({ json: { username: 'dave' } }) });
        const client = new Client({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: fetchFn, sessionStore: store });

        await client.auth.zk.restore();
        expect(client.isAuthenticated).toBe(true);
        await client.auth.zk.logout();
        expect(client.isAuthenticated).toBe(false);
        expect(store.load()).toBeNull();
    });
});

describe('Client — namespaces pending implementation', () => {
    let client: Client;
    beforeEach(() => {
        client = new Client({ apiKey: API_KEY, baseUrl: BASE_URL });
    });

    it('storage methods refuse to run unauthenticated', async () => {
        // Encrypted write needs identity; read needs at least a session.
        await expect(client.storage.set('todos', '1', {})).rejects.toThrow(/identity/);
        await expect(client.storage.get('todos', '1')).rejects.toThrow(/not signed in/);
    });

    it('message send refuses to run unauthenticated', async () => {
        await expect(client.message.send('user:abc', { text: 'hi' })).rejects.toThrow(/not signed in/);
    });

    it('message send rejects a non-user target', async () => {
        // Even before auth, the target-shape guard for send() is meaningful.
        await expect(client.message.send('todos', { text: 'hi' })).rejects.toThrow(/user:/);
    });
});
