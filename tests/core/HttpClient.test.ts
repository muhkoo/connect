/**
 * HttpClient + Client session-recovery tests.
 *
 * Covers the stale-session self-heal: a token-gated request that comes back
 * 401 triggers `onUnauthorized` (wired to `auth.zk.recover()` on the Client),
 * and the request is replayed once if recovery succeeds. When it can't, the
 * Client surfaces a `session-expired` event so the app can redirect to login.
 *
 * The full ZK proof path needs snarkjs (an externalized peer dep), so the
 * Client tests stub `auth.zk.recover` directly — we're verifying the
 * orchestration (dedupe + event), not the proof.
 */

import { describe, it, expect, vi } from 'vitest';
import { HttpClient, HttpError } from '../../src/core/HttpClient';
import { Client } from '../../src/core/Client';

const BASE_URL = 'http://localhost:8787';

/** Fetch double yielding canned statuses in sequence, recording call count. */
function sequencedFetch(responses: Array<{ status: number; json: unknown }>) {
    let i = 0;
    const calls: Array<{ url: string; headers: Headers }> = [];
    const fetchFn = (async (input: any, init: any) => {
        calls.push({ url: typeof input === 'string' ? input : input.url, headers: new Headers(init?.headers) });
        const r = responses[Math.min(i, responses.length - 1)];
        i++;
        return new Response(JSON.stringify(r.json), {
            status: r.status,
            headers: { 'Content-Type': 'application/json' },
        });
    }) as unknown as typeof fetch;
    return { fetchFn, calls };
}

describe('HttpClient — 401 recovery', () => {
    it('replays the request once after a successful recovery', async () => {
        const { fetchFn, calls } = sequencedFetch([
            { status: 401, json: { error: 'stale session' } },
            { status: 200, json: { ok: true } },
        ]);
        const onUnauthorized = vi.fn(async () => true);
        const http = new HttpClient({
            baseUrl: BASE_URL,
            getSessionToken: () => 'stale-token',
            fetch: fetchFn,
            onUnauthorized,
        });

        const result = await http.get('/api/personal/x/get');
        expect(result).toEqual({ ok: true });
        expect(onUnauthorized).toHaveBeenCalledTimes(1);
        expect(calls).toHaveLength(2); // original + one retry
    });

    it('propagates the 401 as an HttpError when recovery fails', async () => {
        const { fetchFn, calls } = sequencedFetch([{ status: 401, json: { error: 'stale' } }]);
        const onUnauthorized = vi.fn(async () => false);
        const http = new HttpClient({
            baseUrl: BASE_URL,
            getSessionToken: () => 'stale-token',
            fetch: fetchFn,
            onUnauthorized,
        });

        await expect(http.post('/api/personal/x/set', {})).rejects.toMatchObject({ status: 401 });
        expect(onUnauthorized).toHaveBeenCalledTimes(1);
        expect(calls).toHaveLength(1); // no retry when recovery couldn't help
    });

    it('does not attempt recovery when no session token is present', async () => {
        const { fetchFn } = sequencedFetch([{ status: 401, json: { error: 'no auth' } }]);
        const onUnauthorized = vi.fn(async () => true);
        const http = new HttpClient({
            baseUrl: BASE_URL,
            getSessionToken: () => null,
            fetch: fetchFn,
            onUnauthorized,
        });

        await expect(http.get('/api/something')).rejects.toBeInstanceOf(HttpError);
        expect(onUnauthorized).not.toHaveBeenCalled();
    });

    it('does not loop when the retried request still 401s', async () => {
        const { fetchFn, calls } = sequencedFetch([{ status: 401, json: { error: 'stale' } }]);
        const onUnauthorized = vi.fn(async () => true);
        const http = new HttpClient({
            baseUrl: BASE_URL,
            getSessionToken: () => 'stale-token',
            fetch: fetchFn,
            onUnauthorized,
        });

        await expect(http.get('/api/x')).rejects.toMatchObject({ status: 401 });
        expect(onUnauthorized).toHaveBeenCalledTimes(1); // recovery attempted once
        expect(calls).toHaveLength(2); // original + single retry, then give up
    });
});

describe('Client — session recovery orchestration', () => {
    it('fires session-expired when recovery is not possible', async () => {
        const client = new Client({ baseUrl: BASE_URL });
        vi.spyOn(client.auth.zk, 'recover').mockResolvedValue(false);
        const onExpired = vi.fn();
        client.onSessionExpired(onExpired);

        const recovered = await client.recoverSession();
        expect(recovered).toBe(false);
        expect(onExpired).toHaveBeenCalledTimes(1);
    });

    it('does not fire session-expired when recovery succeeds', async () => {
        const client = new Client({ baseUrl: BASE_URL });
        vi.spyOn(client.auth.zk, 'recover').mockResolvedValue(true);
        const onExpired = vi.fn();
        client.onSessionExpired(onExpired);

        const recovered = await client.recoverSession();
        expect(recovered).toBe(true);
        expect(onExpired).not.toHaveBeenCalled();
    });

    it('dedupes concurrent recovery into a single re-auth', async () => {
        const client = new Client({ baseUrl: BASE_URL });
        const recover = vi.spyOn(client.auth.zk, 'recover').mockResolvedValue(true);

        const [a, b, c] = await Promise.all([
            client.recoverSession(),
            client.recoverSession(),
            client.recoverSession(),
        ]);

        expect([a, b, c]).toEqual([true, true, true]);
        expect(recover).toHaveBeenCalledTimes(1);
    });

    it('unsubscribe stops further session-expired notifications', async () => {
        const client = new Client({ baseUrl: BASE_URL });
        vi.spyOn(client.auth.zk, 'recover').mockResolvedValue(false);
        const onExpired = vi.fn();
        const off = client.onSessionExpired(onExpired);

        await client.recoverSession();
        off();
        await client.recoverSession();

        expect(onExpired).toHaveBeenCalledTimes(1);
    });
});
