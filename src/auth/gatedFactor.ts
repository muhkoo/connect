/**
 * Verification-gated vault factors (M2 — email, later Google).
 *
 * These factors have NO client-side secret: the user proves *channel control*
 * (an email OTP) and the server releases a split-key OPRF evaluation —
 * `wrapKey = HKDF( OPRF(K1, input) ‖ OPRF(K2, input) )` where K1 lives on the
 * accelerator and K2 in a separate trust domain, so no single server-side
 * compromise can derive the wrap key offline. See accelerator
 * `AUTH_M2_PLAN.md` §1; the canonical reference implementation is
 * accelerator `tests/gated-oprf.test.ts` — keep these derivations in
 * byte-exact lockstep with it.
 */

import { oprfBlind, oprfFinalize, type OprfBlind } from "./oprf";
import { wrapKeyFromBytes, fromBase64 } from "./vault";

export type GatedPurpose = "enroll" | "recover";

/**
 * Deterministic OPRF input for an email factor. Public-ish by design (the
 * verification gate, not the input, is what protects the eval) — but it must
 * be stable forever: username + address are lowercased, the tag is versioned.
 */
export async function emailFactorInput(username: string, email: string): Promise<Uint8Array> {
    const tag = `muhkoo/factor:email:v1:${username.toLowerCase()}:${email.toLowerCase()}`;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tag));
    return new Uint8Array(digest);
}

/**
 * Deterministic OPRF input for a google factor — keyed on the stable Google
 * account id (`sub`), not the email (which can change). Same versioning rules
 * as {@link emailFactorInput}.
 */
export async function googleFactorInput(username: string, sub: string): Promise<Uint8Array> {
    const tag = `muhkoo/factor:google:v1:${username.toLowerCase()}:${sub}`;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tag));
    return new Uint8Array(digest);
}

/** Blind a gated input for the split eval (same blind serves both domains). */
export function gatedBlind(input: Uint8Array): OprfBlind {
    return oprfBlind(input);
}

/**
 * Fold the two domains' evaluations into the AES-256-GCM wrap key:
 * unblind each, concatenate, HKDF with the gated-factor domain separation.
 */
export async function gatedWrapKey(
    input: Uint8Array,
    blind: Uint8Array,
    evaluatedB64: string,
    evaluated2B64: string,
): Promise<CryptoKey> {
    const out1 = oprfFinalize(input, blind, fromBase64(evaluatedB64));
    const out2 = oprfFinalize(input, blind, fromBase64(evaluated2B64));
    const ikm = new Uint8Array(out1.length + out2.length);
    ikm.set(out1);
    ikm.set(out2, out1.length);
    return wrapKeyFromBytes(ikm, "muhkoo-gated-wrap-v1");
}
