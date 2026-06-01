/**
 * File namespace (`client.storage`) tests.
 *
 * Exercises the unified file API over mocked transports — the global shard
 * store, the space `/files` manifest store, and the personal-KV discovery
 * mirror — all in-memory behind a fake fetch. Chunking, AES-256-GCM, and
 * Reed–Solomon are REAL (the bundled RS WASM), so write→read round-trips the
 * actual bytes. No live server or snarkjs needed.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { StorageNamespace } from '../../src/core/namespaces/FileNamespace';
import { KvNamespace } from '../../src/core/namespaces/KvNamespace';
import { manifestToStat } from '../../src/storage/types';
import { HttpClient } from '../../src/core/HttpClient';
import { SessionState } from '../../src/core/Session';
import { deriveIdentity } from '../../src/auth/identity';

// Vitest's Vite can't ESM-import the RS `.wasm` via the bundled loader, so
// compile it from disk once and hand it to the namespace (same approach as
// tests/storage/FileStorage.test.ts).
let rsWasmModule: WebAssembly.Module;
beforeAll(async () => {
    const wasmPath = join(__dirname, '..', '..', 'src', 'storage', 'encoding', 'ReedSolomon', 'wasm', 'wasm_reed_solomon_erasure_bg.wasm');
    rsWasmModule = await WebAssembly.compile(readFileSync(wasmPath));
});

const BASE_URL = 'http://localhost:8787';
const API_KEY = 'mk_test_pk_0123456789abcdef0123456789abcdef';
const COMMITMENT = '98765432109876543210';
const SPACE_ID = 'space-abc';

/** Mock fetch backing the shard store, the space /files store, and personal KV. */
function makeMockFetch() {
    const shards = new Map<string, Uint8Array>();
    const files = new Map<string, any>(); // `${spaceId}:${fileId}` → manifest
    const kvStore = new Map<string, unknown>();

    const json = (o: unknown, s = 200) =>
        new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });

    const fetchFn = (async (input: any, init: any) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        const method = init?.method ?? 'GET';
        const p = url.pathname;

        // --- global shard store ---
        let m = p.match(/^\/api\/shards\/([0-9a-f]{64})$/);
        if (m) {
            const hash = m[1];
            if (method === 'PUT') {
                const buf = new Uint8Array(await new Response(init.body).arrayBuffer());
                shards.set(hash, buf);
                return json({ ok: true, hash, size: buf.byteLength, dedup: false });
            }
            if (method === 'GET') {
                const b = shards.get(hash);
                return b ? new Response(b, { status: 200 }) : new Response('nf', { status: 404 });
            }
            if (method === 'HEAD') return new Response(null, { status: shards.has(hash) ? 200 : 404 });
        }

        // --- space /files manifest store ---
        m = p.match(/^\/api\/spaces\/([^/]+)\/files(?:\/([^/]+))?$/);
        if (m) {
            const spaceId = decodeURIComponent(m[1]);
            const fileId = m[2] ? decodeURIComponent(m[2]) : undefined;
            const body = init?.body ? JSON.parse(init.body) : {};
            if (!fileId) {
                if (method === 'POST') {
                    files.set(`${spaceId}:${body.manifest.id}`, body.manifest);
                    return json({ ok: true, fileId: body.manifest.id });
                }
                if (method === 'GET') {
                    const list = [...files.entries()]
                        .filter(([k]) => k.startsWith(`${spaceId}:`))
                        .map(([, man]) => manifestToStat(man));
                    return json({ files: list });
                }
            } else {
                if (method === 'GET') {
                    const man = files.get(`${spaceId}:${fileId}`);
                    return man ? json({ manifest: man }) : json({ error: 'not found' }, 404);
                }
                if (method === 'DELETE') {
                    const existed = files.delete(`${spaceId}:${fileId}`);
                    return json({ ok: true, existed });
                }
            }
        }

        // --- personal KV (the discovery mirror) ---
        const parts = p.split('/').filter(Boolean); // api personal :c ...
        if (parts[1] === 'personal') {
            const tail = parts.slice(3);
            const body = init?.body ? JSON.parse(init.body) : {};
            if (tail[0] === 'list') return json({ keys: [...kvStore.keys()] });
            if (tail[0] === 'kv') {
                const key = decodeURIComponent(tail[1]);
                if (tail[2] === 'get') return json({ value: kvStore.get(key) ?? null });
                if (method === 'POST') { kvStore.set(key, body.value); return json({ ok: true }); }
                if (method === 'DELETE') { const existed = kvStore.delete(key); return json({ ok: true, existed }); }
            }
        }

        return json({ error: `unhandled ${method} ${p}` }, 404);
    }) as unknown as typeof fetch;

    return { fetchFn, shards, files, kvStore };
}

async function makeStorage() {
    const { fetchFn, shards, files, kvStore } = makeMockFetch();
    const session = new SessionState();
    await session.setSession({ token: 't'.repeat(64), username: 'alice', commitment: COMMITMENT });
    session.setIdentity(await deriveIdentity('alice', 'correct horse battery staple'));
    const http = new HttpClient({ baseUrl: BASE_URL, apiKey: API_KEY, getSessionToken: () => session.token, fetch: fetchFn });
    const kv = new KvNamespace({ http, session, wsBaseUrl: 'ws://localhost:8787' });
    const storage = new StorageNamespace({ http, baseUrl: BASE_URL, kv, rsWasmModule });
    return { storage, shards, files, kvStore };
}

const bytes = (s: string) => new TextEncoder().encode(s);

describe('client.storage (files)', () => {
    it('writeFile requires a spaceId', async () => {
        const { storage } = await makeStorage();
        // @ts-expect-error — intentionally omitting spaceId
        await expect(storage.writeFile({ data: bytes('x'), metadata: { name: 'x', type: 'text/plain' } }))
            .rejects.toThrow(/spaceId/);
    });

    it('writes shards + space manifest + personal mirror, and reads back', async () => {
        const { storage, shards, files, kvStore } = await makeStorage();
        const payload = bytes('hello, muhkoo files — round trip me!');

        const { stat, manifest } = await storage.writeFile({
            spaceId: SPACE_ID,
            data: payload,
            metadata: { name: 'note.txt', type: 'text/plain' },
        });

        expect(stat.name).toBe('note.txt');
        expect(shards.size).toBeGreaterThan(0);                       // shards uploaded
        expect(files.has(`${SPACE_ID}:${manifest.id}`)).toBe(true);   // manifest in space store
        expect(kvStore.size).toBe(1);                                 // mirror written

        // Capability read straight from the manifest (no space lookup).
        const byManifest = await storage.readByManifest(manifest);
        expect(new TextDecoder().decode(byManifest.data)).toBe('hello, muhkoo files — round trip me!');

        // Read via the space (manifest fetched from /files, then shards).
        const viaSpace = await storage.readFile(SPACE_ID, manifest.id);
        expect(new TextDecoder().decode(viaSpace.data)).toBe('hello, muhkoo files — round trip me!');
    });

    it('listFiles() reads the personal mirror; listFiles({spaceId}) reads the space', async () => {
        const { storage } = await makeStorage();
        const { manifest } = await storage.writeFile({
            spaceId: SPACE_ID,
            data: bytes('a'),
            metadata: { name: 'a.txt', type: 'text/plain' },
        });

        const mine = await storage.listFiles();
        expect(mine.map((f) => f.id)).toContain(manifest.id);

        const inSpace = await storage.listFiles({ spaceId: SPACE_ID });
        expect(inSpace.map((f) => f.id)).toContain(manifest.id);
    });

    it('deleteFile removes the space manifest and the mirror entry', async () => {
        const { storage, files, kvStore } = await makeStorage();
        const { manifest } = await storage.writeFile({
            spaceId: SPACE_ID,
            data: bytes('bye'),
            metadata: { name: 'b.txt', type: 'text/plain' },
        });

        expect(await storage.deleteFile(SPACE_ID, manifest.id)).toBe(true);
        expect(files.has(`${SPACE_ID}:${manifest.id}`)).toBe(false);
        expect(kvStore.size).toBe(0);
        expect(await storage.listFiles()).toEqual([]);
    });
});
