/**
 * KV namespace tests.
 *
 * Exercises `client.kv` end to end over a mocked personal-space transport (an
 * in-memory KV behind a fake fetch), with REAL at-rest encryption: a derived
 * identity seeds the `StorageCipher`, so set/get round trips through actual
 * AES-GCM. No live server or snarkjs needed.
 */

import { describe, it, expect } from 'vitest';
import { KvNamespace } from '../../src/core/namespaces/KvNamespace';
import { StorageCipher } from '../../src/crypto/StorageCipher';
import { HttpClient } from '../../src/core/HttpClient';
import { SessionState } from '../../src/core/Session';
import { deriveIdentity } from '../../src/auth/identity';

const BASE_URL = 'http://localhost:8787';
const API_KEY = 'mk_test_pk_0123456789abcdef0123456789abcdef';
const COMMITMENT = '98765432109876543210';

/** Fake fetch backing the personal-space endpoints with an in-memory KV. */
function makePersonalSpaceFetch() {
    const store = new Map<string, unknown>();
    const fetchFn = (async (input: any, init: any) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(init.body) : {};
        const parts = url.pathname.split('/').filter(Boolean); // api personal :c ...
        const tail = parts.slice(3); // after /api/personal/:commitment

        const reply = (obj: unknown, status = 200) =>
            new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

        if (tail[0] === 'list') return reply({ keys: Array.from(store.keys()) });
        if (tail[0] === 'kv') {
            const key = decodeURIComponent(tail[1]);
            if (tail[2] === 'get') return reply({ key, value: store.get(key) ?? null });
            if (method === 'POST') { store.set(key, body.value); return reply({ ok: true }); }
            if (method === 'DELETE') { const existed = store.delete(key); return reply({ ok: true, existed }); }
        }
        return reply({ error: 'not found' }, 404);
    }) as unknown as typeof fetch;
    return { fetchFn, store };
}

async function makeKv() {
    const { fetchFn, store } = makePersonalSpaceFetch();
    const session = new SessionState();
    await session.setSession({ token: 't'.repeat(64), username: 'alice', commitment: COMMITMENT });
    session.setIdentity(await deriveIdentity('alice', 'correct horse battery staple'));
    const http = new HttpClient({ baseUrl: BASE_URL, apiKey: API_KEY, getSessionToken: () => session.token, fetch: fetchFn });
    const kv = new KvNamespace({ http, session, wsBaseUrl: 'ws://localhost:8787' });
    return { kv, store, session };
}

describe('StorageCipher', () => {
    it('round-trips a value through AES-GCM', async () => {
        const cipher = new StorageCipher('a'.repeat(64), 'b'.repeat(64));
        const env = await cipher.encrypt({ hello: 'world', n: 42 });
        expect(env._enc).toBe('a256gcm');
        expect(StorageCipher.isEnvelope(env)).toBe(true);
        expect(await cipher.decrypt(env)).toEqual({ hello: 'world', n: 42 });
    });

    it('plaintext objects are not mistaken for envelopes', () => {
        expect(StorageCipher.isEnvelope({ title: 'x' })).toBe(false);
        expect(StorageCipher.isEnvelope(null)).toBe(false);
    });
});

describe('client.kv', () => {
    it('set then get round-trips, storing ciphertext at rest', async () => {
        const { kv, store } = await makeKv();
        await kv.set('todos', 't1', { title: 'Buy groceries', completed: false });

        // What's persisted is an encrypted envelope, not the plaintext.
        const stored = store.get('todos/t1');
        expect(StorageCipher.isEnvelope(stored)).toBe(true);

        const got = await kv.get<{ title: string; completed: boolean }>('todos', 't1');
        expect(got).toEqual({ title: 'Buy groceries', completed: false });
    });

    it('get returns null for a missing key', async () => {
        const { kv } = await makeKv();
        expect(await kv.get('todos', 'nope')).toBeNull();
    });

    it('encrypt:false stores plaintext', async () => {
        const { kv, store } = await makeKv();
        await kv.set('public', 'p1', { open: true }, { encrypt: false });
        expect(store.get('public/p1')).toEqual({ open: true });
        expect(await kv.get('public', 'p1')).toEqual({ open: true });
    });

    it('list returns ids scoped to the collection', async () => {
        const { kv } = await makeKv();
        await kv.set('todos', 't1', { a: 1 });
        await kv.set('todos', 't2', { a: 2 });
        await kv.set('notes', 'n1', { a: 3 });
        const ids = await kv.list('todos');
        expect(ids.sort()).toEqual(['t1', 't2']);
    });

    it('delete removes a key and reports prior existence', async () => {
        const { kv } = await makeKv();
        await kv.set('todos', 't1', { a: 1 });
        expect(await kv.delete('todos', 't1')).toBe(true);
        expect(await kv.get('todos', 't1')).toBeNull();
        expect(await kv.delete('todos', 't1')).toBe(false);
    });

    it('throws when locked (no identity) for encrypted writes', async () => {
        const { fetchFn } = makePersonalSpaceFetch();
        const session = new SessionState();
        await session.setSession({ token: 't'.repeat(64), username: 'bob', commitment: COMMITMENT });
        // No setIdentity → locked.
        const http = new HttpClient({ baseUrl: BASE_URL, apiKey: API_KEY, getSessionToken: () => session.token, fetch: fetchFn });
        const kv = new KvNamespace({ http, session, wsBaseUrl: 'ws://x' });
        await expect(kv.set('todos', 't1', { a: 1 })).rejects.toThrow(/identity/);
    });
});
