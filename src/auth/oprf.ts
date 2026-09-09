/**
 * OPRF (Oblivious PRF) — RFC 9497, ristretto255-SHA512, mode 0x00.
 *
 * Used to gate the password/recovery factors of the identity vault
 * ({@link ./vault}). The wrap key for a password factor is
 * `HKDF(OPRF(serverKey, scrypt(password)))`, so:
 *   - the client cannot derive the wrap key offline (it needs the server's
 *     secret-keyed evaluation), and
 *   - the server learns nothing — it only ever sees a *blinded* group element,
 *     never the password or the resulting key.
 *
 * Net effect: a stolen vault blob is NOT offline-crackable; every guess costs a
 * round-trip to a rate-limited server endpoint. The same OPRF backs the M2
 * Google/email factors.
 *
 * Thin wrapper over `@noble/curves`' vetted `ristretto255_oprf` so the protocol
 * (blind / blindEvaluate / finalize) lives in one named place. CLIENT uses
 * {@link oprfBlind} + {@link oprfFinalize}.
 *
 * The `oprfDeriveKey` / `oprfBlindEvaluate` helpers here are the SERVER half,
 * but note they are used only by this repo's tests. The accelerator does NOT
 * import them: it has an independent implementation in its own
 * `src/services/oprf.ts`, also built directly on `@noble/curves`. (An earlier
 * version of this comment claimed the accelerator's VaultDO imported them; it
 * does not — it imports `@muhkoo/connect` in exactly two files, both for
 * Groth16 verification.) Any protocol change therefore has to land in BOTH
 * repos in lockstep.
 *
 * KNOWN WEAKNESS — mode 0x00, tracked as audit finding C4 and NOT fixed here.
 * This uses RFC 9497 base mode: the server returns a bare evaluation with no
 * DLEQ proof, and {@link oprfFinalize} verifies nothing. A hostile server can
 * answer `{evaluated: blinded}` (i.e. k=1); the unblinded point is then just
 * `H(input)` and the wrap key collapses to a pure function of public strings,
 * destroying the offline-uncrackability guarantee stated above.
 *
 * The fix is `ristretto255_oprf.voprf` (mode 0x01) with the server's public key
 * pinned as a build-time constant and the proof verified on every finalize.
 * noble's `voprf` variant is already present and unused. It cannot be done
 * client-side alone: the wire response (`{evaluated}` / `{evaluated, evaluated2}`)
 * carries no proof field, and the pinned public keys must correspond to the
 * accelerator's actual K1/K2 secrets. Changing only this file would break login
 * against the live server.
 */

import { ristretto255_oprf } from "@noble/curves/ed25519.js";

const OPRF = ristretto255_oprf.oprf;
// Domain separation for the server key derivation (RFC 9497 `info`).
const KEY_INFO = new TextEncoder().encode("muhkoo-oprf-v1");

export interface OprfBlind {
  /** Secret blind scalar — stays on the client; needed to finalize. */
  blind: Uint8Array;
  /** Blinded group element — sent to the server for evaluation. */
  blinded: Uint8Array;
}

/** CLIENT: blind `input` (e.g. `scrypt(password)`) before the server eval. */
export function oprfBlind(input: Uint8Array): OprfBlind {
  const { blind, blinded } = OPRF.blind(input);
  return { blind, blinded };
}

/** CLIENT: fold the server's blinded evaluation into the final 64-byte OPRF output. */
export function oprfFinalize(input: Uint8Array, blind: Uint8Array, evaluated: Uint8Array): Uint8Array {
  return OPRF.finalize(input, blind, evaluated);
}

/** SERVER: derive the stable OPRF secret key from a seed (a Worker secret). */
export function oprfDeriveKey(seed: Uint8Array): Uint8Array {
  return OPRF.deriveKeyPair(seed, KEY_INFO).secretKey;
}

/** SERVER: evaluate a blinded element with the secret key (learns nothing about input). */
export function oprfBlindEvaluate(secretKey: Uint8Array, blinded: Uint8Array): Uint8Array {
  return OPRF.blindEvaluate(secretKey, blinded);
}

/** Direct (unblinded) OPRF evaluation — for tests / equivalence checks only.
 *  (`evaluate` exists at runtime in `ristretto255_oprf.oprf` but isn't in the
 *  published type, so we reach it through a narrow cast.) */
export function oprfEvaluate(secretKey: Uint8Array, input: Uint8Array): Uint8Array {
  return (OPRF as unknown as { evaluate(sk: Uint8Array, input: Uint8Array): Uint8Array }).evaluate(secretKey, input);
}
