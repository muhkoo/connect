/**
 * Public-signal ARITY for the edge Groth16 verifier.
 *
 * `verifyGroth16` computes `vk_x = IC[0] + Σ IC[i+1]·signals[i]`. The number of
 * signals is therefore not free — it must be exactly `IC.length - 1`. Without a
 * check, a caller passing FEWER signals than the circuit declares gets `vk_x`
 * computed from fewer terms, which is a proof of a DIFFERENT statement, and it
 * can verify as true.
 *
 * This is the accelerator's login verification path, so a truncated
 * `publicSignals` array reaching it is an authentication bypass. Three
 * independent finders raised it against `src/workers/groth16-verifier.ts:136`.
 *
 * The proof here is REAL — generated from the checked-in circuit artifacts — so
 * the negative cases fail for the arity reason rather than because the proof was
 * junk to begin with.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
    PreimagePoK,
    AuthPublicInput,
    Field,
    Poseidon,
} from '../../src/crypto/ZeroKnowledge';
import {
    verifyGroth16,
    initBn128Wasm,
    PREIMAGE_POK_VERIFICATION_KEY,
    type Bn128WasmInstance,
} from '../../src/workers/groth16-verifier';
import { loadPreimagePoKCircuit } from '../helpers/circuits';

describe('groth16 verifier — public-signal arity', () => {
    let wasm: Bn128WasmInstance;
    let proof: unknown;
    let publicSignals: string[];

    beforeAll(async () => {
        await loadPreimagePoKCircuit();
        wasm = await initBn128Wasm();

        const secret = new Field(BigInt('987654321'));
        const salt = new Field(BigInt('555555'));
        const ecdsaPub = new Field(BigInt('777777'));
        const nonce = new Field(BigInt('111111'));

        const ecdsaPubHash = await Poseidon.hash([ecdsaPub]);
        const commitment = await Poseidon.hash([secret, salt, ecdsaPubHash]);

        const publicInput = new AuthPublicInput(
            commitment.toString(),
            nonce.toString(),
            ecdsaPubHash.toString(),
        );
        const out = await PreimagePoK.prove(publicInput, secret, salt, ecdsaPub);
        proof = out.proof;
        publicSignals = out.publicSignals;
    }, 60000);

    const verify = (signals: string[]) =>
        verifyGroth16(
            wasm.instance,
            wasm.memory,
            wasm.initialPFree,
            PREIMAGE_POK_VERIFICATION_KEY,
            proof as never,
            signals,
        );

    it('accepts the proof with exactly the declared number of signals', async () => {
        expect(publicSignals).toHaveLength(PREIMAGE_POK_VERIFICATION_KEY.IC.length - 1);
        await expect(verify(publicSignals)).resolves.toBe(true);
    });

    // A real proof truncated at random ALSO fails the pairing, so that case
    // cannot tell the arity check apart from ordinary rejection. The bypass is
    // sharp only when the dropped signals are ZERO: IC[i+1]·0 is the identity,
    // so vk_x is byte-identical with or without them, the pairing still
    // succeeds, and only the arity check can reject it.
    //
    // Construct exactly that: extend the vk's IC by one point and pad the
    // signals with a trailing "0". The padded form is a genuinely valid proof
    // of a 4-signal statement; the truncated form is the same proof presented
    // as a 3-signal statement. A verifier without the check accepts BOTH,
    // which is the authentication bypass — the caller indexes publicSignals[i]
    // by position, so a short array silently shifts what each slot means.
    const extendedVk = () => ({
        ...PREIMAGE_POK_VERIFICATION_KEY,
        nPublic: PREIMAGE_POK_VERIFICATION_KEY.IC.length,
        IC: [...PREIMAGE_POK_VERIFICATION_KEY.IC, PREIMAGE_POK_VERIFICATION_KEY.IC[0]],
    });

    const verifyWith = (vk: typeof PREIMAGE_POK_VERIFICATION_KEY, signals: string[]) =>
        verifyGroth16(wasm.instance, wasm.memory, wasm.initialPFree, vk, proof as never, signals);

    it('accepts the zero-padded proof at the extended arity (control)', async () => {
        // Establishes that the pairing genuinely succeeds here, so the next
        // test's rejection can only be the arity check.
        await expect(verifyWith(extendedVk(), [...publicSignals, '0'])).resolves.toBe(true);
    });

    it('REJECTS the same proof with the zero signal dropped', async () => {
        // vk_x is identical to the control above. Without the arity check this
        // returns true — verified by mutation.
        await expect(verifyWith(extendedVk(), publicSignals)).resolves.toBe(false);
    });

    it('rejects an arbitrarily truncated signal array', async () => {
        for (let n = 0; n < publicSignals.length; n++) {
            await expect(
                verify(publicSignals.slice(0, n)),
                `${n} of ${publicSignals.length} signals must not verify`,
            ).resolves.toBe(false);
        }
    });

    it('still rejects a tampered signal at full arity', async () => {
        // Guards against "fixed" by making the verifier reject everything.
        const tampered = [...publicSignals];
        tampered[0] = (BigInt(tampered[0]) + 1n).toString();
        await expect(verify(tampered)).resolves.toBe(false);
    });
});
