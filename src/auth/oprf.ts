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
 * {@link oprfBlind} + {@link oprfFinalize}; SERVER uses {@link oprfDeriveKey} +
 * {@link oprfBlindEvaluate} (imported by the accelerator's VaultDO).
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
