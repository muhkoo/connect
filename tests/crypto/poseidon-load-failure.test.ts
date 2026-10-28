import { describe, it, expect, vi, beforeEach } from 'vitest';

// loadPoseidon() caches module state, so each test gets a fresh module graph.
describe('Poseidon when circomlibjs fails to load', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.doUnmock('circomlibjs');
    });

    it('rejects instead of substituting a non-Poseidon hash', async () => {
        const original = new Error('boom');
        vi.doMock('circomlibjs', () => {
            throw original;
        });
        const { Poseidon, Field } = await import('../../src/crypto/ZeroKnowledge');
        const err = await Poseidon.hash([new Field(1n), new Field(2n)]).catch(e => e);
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toMatch(/Poseidon unavailable/);
        expect(err.name).toBe('PoseidonUnavailableError');
        expect(err.cause).toBeDefined();
    });

    it('does not cache the failure: a later call retries and succeeds', async () => {
        let fail = true;
        const real = await vi.importActual<any>('circomlibjs');
        vi.doMock('circomlibjs', () => {
            if (fail) throw new Error('transient');
            return real;
        });
        const { Poseidon, Field } = await import('../../src/crypto/ZeroKnowledge');
        await expect(Poseidon.hash([new Field(1n)])).rejects.toThrow(/Poseidon unavailable/);
        fail = false;
        const h = await Poseidon.hash([new Field(1n), new Field(2n)]);
        // Known circom Poseidon([1,2]) vector
        expect(h.toBigInt()).toBe(
            7853200120776062878684798364095072458815029376092732009249414926327459813530n,
        );
    });
});
