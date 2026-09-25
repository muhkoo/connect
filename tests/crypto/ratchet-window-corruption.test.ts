/**
 * Regression test for the DH-rotation window corrupting process-global state.
 *
 * `DoubleRatchet` used to flip `newDhKey` on by itself once `sendCount` reached
 * `windowSize` (100) in any `'specific'` session — which is every DM — and then
 * wrote the freshly generated pair into the PROCESS-GLOBAL `KeyStore` under the
 * local user's own id. Because `KeyStore` is a singleton keyed by id, that
 * clobbered the long-term ECDH key every other ratchet and the Space
 * key-unwrap path read back from the same entry.
 *
 * Two independent things were wrong and both are asserted here:
 *
 *   1. the global `KeyStore` entry for the sender must never change as a
 *      side effect of sending;
 *   2. the conversation must survive past the old window boundary — the
 *      rotation advanced the sender's chain without telling the peer, so
 *      message 101 stopped decrypting.
 *
 * See docs/superpowers/specs/2026-09-24-dm-protocol-design.md §0.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import { DoubleRatchet } from '../../src/crypto/DoubleRatchet';
import { KeyStore } from '../../src/crypto/KeyStore';

// DoubleRatchet logs through a global appLogger; tests must install one.
(global as any).appLogger = {
    debug: () => {},
    error: () => {},
    info: () => {},
};

// `KeyStore` is a process-wide singleton that is never cleared (audit: it has
// no `clear()` at all), and `generateOwnKeyPair` throws on a duplicate id — so
// every test needs its own pair of ids.
let seq = 0;

/** Both halves of a live 1:1 session, already key-agreed. */
async function makePair() {
    const n = seq++;
    const aliceId = `alice-window-${n}`;
    const bobId = `bob-window-${n}`;
    const sessionId = `${aliceId}:${bobId}`;

    const keyStore = KeyStore.getInstance();
    await keyStore.generateOwnKeyPair(aliceId);
    await keyStore.generateOwnKeyPair(bobId);

    // `isClient` is the role, and it must be consistent on both sides:
    // Alice drives the client half, Bob the server half.
    const alice = new DoubleRatchet(aliceId, bobId, 'specific', true);
    await alice.initializeSession(true);

    const bob = new DoubleRatchet(bobId, aliceId, 'specific', false);
    await bob.initializeSession(false);

    const send = (text: string, newDhKey = false) =>
        alice.encrypt(text, newDhKey, aliceId, bobId, sessionId, 'specific');

    return { keyStore, alice, bob, aliceId, send };
}

describe('DoubleRatchet — the DH window must not touch global state', () => {
    it('leaves the sender KeyStore entry untouched across the old window boundary', async () => {
        const { keyStore, aliceId, send } = await makePair();

        const before = await keyStore.dehydrateKeyPair(aliceId);

        // One more than the old windowSize, so the trigger would have fired.
        for (let i = 0; i < 101; i++) {
            await send(`msg ${i}`);
        }

        const after = await keyStore.dehydrateKeyPair(aliceId);
        expect(after.ecdhPub).toBe(before.ecdhPub);
    });

    it('still decrypts past the old window boundary', async () => {
        const { bob, send } = await makePair();

        // Walk right up to the boundary; every message must arrive.
        for (let i = 0; i < 100; i++) {
            const msg = await send(`msg ${i}`);
            expect(await bob.decrypt(msg, false)).toBe(`msg ${i}`);
        }

        // Message 101 is the one the self-firing rotation used to break: Alice
        // re-keyed and stepped her chain without telling Bob.
        const past = await send('past the boundary');
        expect(await bob.decrypt(past, false)).toBe('past the boundary');
    });

    it('rejects an explicit rotation request rather than corrupting state', async () => {
        const { send } = await makePair();

        // The DH-ratchet path is known-broken (it hardcodes the client role and
        // the header still reports the KeyStore key). It is unreachable from
        // any caller in the SDK — every one passes `false` — so it fails loudly
        // until H1 rebuilds it, instead of silently desynchronising a session.
        await expect(send('rotate me', /* newDhKey */ true)).rejects.toThrow(/rotation/i);
    });
});
