/**
 * Hosted-auth handoff crypto (auth.muhkoo.dev — AUTH_HOSTED_PLAN.md §3).
 *
 * The hosted page authenticates the user and ends up holding the master seed.
 * To pass it to the developer's app without it ever sitting server-readable or
 * landing in browser history:
 *
 *   1. {@link sealSeed} generates a one-time key K_t, AES-256-GCM-seals the seed
 *      under it, and returns the ciphertext envelope (`sealedKeys`, stored in
 *      the grant the server relays but can't read) plus K_t (`fragmentKey`,
 *      placed ONLY in the redirect URL fragment — fragments never hit a server).
 *   2. The app exchanges the code for `sealedKeys`, reads K_t from the fragment,
 *      and {@link unsealSeed} recovers the seed, then strips the fragment.
 *
 * Trust-equivalent to today's embedded SDK (the app still ends up with the
 * seed) while moving credential entry onto the Muhkoo origin. The envelope is
 * versioned so a future per-app-key handoff (v2) can swap in without a protocol
 * change.
 */

import { toBase64, fromBase64 } from "./vault";

const TE = new TextEncoder();
const TD = new TextDecoder();

interface SealedEnvelope {
    v: 1;
    iv: string; // base64
    ct: string; // base64
}

export interface SealedHandoff {
    /** base64 JSON envelope — relayed by the server in the grant; server-opaque. */
    sealedKeys: string;
    /** base64url one-time key — rides ONLY in the redirect URL fragment. */
    fragmentKey: string;
}

/** Seal the master seed under a fresh one-time key for the redirect handoff. */
export async function sealSeed(seed: Uint8Array): Promise<SealedHandoff> {
    const ktRaw = crypto.getRandomValues(new Uint8Array(32));
    const key = await crypto.subtle.importKey("raw", ktRaw as BufferSource, { name: "AES-GCM" }, false, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, seed as BufferSource));
    const envelope: SealedEnvelope = { v: 1, iv: toBase64(iv), ct: toBase64(ct) };
    return {
        sealedKeys: toBase64(TE.encode(JSON.stringify(envelope))),
        fragmentKey: base64UrlEncode(ktRaw),
    };
}

/** Recover the master seed from the sealed envelope + the fragment key. */
export async function unsealSeed(sealedKeys: string, fragmentKey: string): Promise<Uint8Array> {
    const envelope = JSON.parse(TD.decode(fromBase64(sealedKeys))) as SealedEnvelope;
    if (envelope.v !== 1) throw new Error(`Unsupported handoff envelope version ${envelope.v}`);
    const ktRaw = base64UrlDecode(fragmentKey);
    const key = await crypto.subtle.importKey("raw", ktRaw as BufferSource, { name: "AES-GCM" }, false, ["decrypt"]);
    const seed = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromBase64(envelope.iv) as BufferSource },
        key,
        fromBase64(envelope.ct) as BufferSource,
    );
    return new Uint8Array(seed);
}

// ---- PKCE (RFC 7636, S256) -------------------------------------------------

export interface Pkce {
    codeVerifier: string;
    codeChallenge: string;
}

/** Generate a PKCE verifier + S256 challenge for the authorize→token exchange. */
export async function generatePkce(): Promise<Pkce> {
    const codeVerifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", TE.encode(codeVerifier)));
    return { codeVerifier, codeChallenge: base64UrlEncode(digest) };
}

/** A random URL-safe value for the OAuth `state` (CSRF binding on the callback). */
export function randomState(): string {
    return base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
}

function base64UrlEncode(bytes: Uint8Array): string {
    return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64UrlDecode(s: string): Uint8Array {
    return fromBase64(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
}
