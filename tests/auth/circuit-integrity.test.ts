/**
 * Circuit-artifact integrity pinning.
 *
 * `generateAuthProof` hands the user's `secret` and `salt` to a witness
 * generator fetched at runtime from the accelerator — the party the proof is
 * meant to convince. Unverified, a modified `.wasm` can copy `secret` into a
 * public-signal slot and the client forwards it. These tests pin that shut.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
    PINNED_CIRCUIT_DIGESTS,
    CircuitIntegrityError,
    resolveArtifact,
    isRemoteArtifact,
    clearCircuitCache,
} from '../../src/auth/circuitIntegrity';
import { defaultCircuitUrls } from '../../src/auth/proof';

const REAL = (p: string) => fileURLToPath(new URL(`../../circuits/build/${p}`, import.meta.url));
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

const BYTES = new Uint8Array([1, 2, 3, 4]);
const BYTES_SHA = sha256(BYTES);

function fakeFetch(body: Uint8Array, ok = true) {
    let calls = 0;
    const fn = async () => {
        calls += 1;
        return {
            ok,
            status: ok ? 200 : 500,
            statusText: ok ? 'OK' : 'Server Error',
            arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
        } as unknown as Response;
    };
    return { fn: fn as unknown as typeof fetch, calls: () => calls };
}

beforeEach(() => clearCircuitCache());

describe('pinned digests', () => {
    // The regression guard that matters: if someone recompiles the circuit and
    // forgets to re-pin, this fails HERE rather than every login failing in
    // production (or worse, the pin being loosened to make it pass).
    it('match the checked-in circuit artifacts byte-for-byte', () => {
        expect(sha256(new Uint8Array(readFileSync(REAL('preimagePoK_js/preimagePoK.wasm')))))
            .toBe(PINNED_CIRCUIT_DIGESTS.preimagePoKWasm);
        expect(sha256(new Uint8Array(readFileSync(REAL('preimagePoK_0001.zkey')))))
            .toBe(PINNED_CIRCUIT_DIGESTS.preimagePoKZkey);
    });

    it('are carried by defaultCircuitUrls', () => {
        const c = defaultCircuitUrls('https://api.muhkoo.dev');
        expect(c.wasmSha256).toBe(PINNED_CIRCUIT_DIGESTS.preimagePoKWasm);
        expect(c.zkeySha256).toBe(PINNED_CIRCUIT_DIGESTS.preimagePoKZkey);
    });
});

describe('resolveArtifact', () => {
    it('passes local paths through untouched', async () => {
        // A filesystem path is not server-controlled, so it is outside this
        // control's threat model — and snarkjs reads it itself under Node.
        expect(isRemoteArtifact('/tmp/preimagePoK.wasm')).toBe(false);
        await expect(
            resolveArtifact('/tmp/preimagePoK.wasm', undefined, { label: 't' }),
        ).resolves.toBe('/tmp/preimagePoK.wasm');
    });

    it('returns verified bytes when the digest matches', async () => {
        const f = fakeFetch(BYTES);
        const out = await resolveArtifact('https://x.test/a.wasm', BYTES_SHA, { label: 't', fetchFn: f.fn });
        expect(out).toBeInstanceOf(Uint8Array);
        expect(Array.from(out as Uint8Array)).toEqual([1, 2, 3, 4]);
    });

    it('THROWS when the served bytes do not match the pin', async () => {
        // The attack: the server substitutes a modified witness generator.
        const f = fakeFetch(new Uint8Array([9, 9, 9, 9]));
        await expect(
            resolveArtifact('https://x.test/a.wasm', BYTES_SHA, { label: 't', fetchFn: f.fn }),
        ).rejects.toBeInstanceOf(CircuitIntegrityError);
    });

    it('REFUSES an unpinned remote artifact rather than proving with it', async () => {
        // No silent fallback: an unverifiable artifact must fail closed.
        const f = fakeFetch(BYTES);
        await expect(
            resolveArtifact('https://x.test/a.wasm', undefined, { label: 't', fetchFn: f.fn }),
        ).rejects.toThrow(/without a pinned SHA-256/);
        expect(f.calls()).toBe(0); // refused before touching the network
    });

    it('allows an explicit, logged opt-out', async () => {
        const f = fakeFetch(BYTES);
        await expect(
            resolveArtifact('https://x.test/a.wasm', undefined, {
                label: 't',
                allowUnpinned: true,
                fetchFn: f.fn,
            }),
        ).resolves.toBe('https://x.test/a.wasm');
    });

    it('fetches once across repeated proofs', async () => {
        const f = fakeFetch(BYTES);
        const args = { label: 't', fetchFn: f.fn } as const;
        await resolveArtifact('https://x.test/a.wasm', BYTES_SHA, args);
        await resolveArtifact('https://x.test/a.wasm', BYTES_SHA, args);
        expect(f.calls()).toBe(1);
    });

    it('does not cache a failure', async () => {
        // A transient network error must not poison the cache for the session.
        const bad = fakeFetch(BYTES, false);
        await expect(
            resolveArtifact('https://x.test/a.wasm', BYTES_SHA, { label: 't', fetchFn: bad.fn }),
        ).rejects.toThrow();
        const good = fakeFetch(BYTES);
        await expect(
            resolveArtifact('https://x.test/a.wasm', BYTES_SHA, { label: 't', fetchFn: good.fn }),
        ).resolves.toBeInstanceOf(Uint8Array);
        expect(good.calls()).toBe(1);
    });

    it('re-fetches when the pin changes', async () => {
        const f = fakeFetch(BYTES);
        await resolveArtifact('https://x.test/a.wasm', BYTES_SHA, { label: 't', fetchFn: f.fn });
        await expect(
            resolveArtifact('https://x.test/a.wasm', 'deadbeef', { label: 't', fetchFn: f.fn }),
        ).rejects.toBeInstanceOf(CircuitIntegrityError);
        expect(f.calls()).toBe(2);
    });
});
