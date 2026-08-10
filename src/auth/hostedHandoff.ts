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
 *
 * ## v2 — device pairing (TV / no-redirect handoff)
 *
 * v1's K_t rides in the redirect URL *fragment*, which works only because the
 * receiving app is a browser page that can read `location.hash`. A TV app has
 * no redirect to receive: it polls. So v2 keeps the *entire* v1 shape — the
 * server relays a sealed envelope it cannot read — and replaces only the key
 * agreement:
 *
 *   - the TV generates an ephemeral P-256 ECDH keypair in memory and publishes
 *     the public half ({@link generateDevicePairingKeypair});
 *   - the hosted page (the component that already holds the unlocked seed and
 *     already owns sealing) seals *to that public key* with a fresh ephemeral
 *     keypair of its own ({@link sealSeedToDevice}) — ECDH → HKDF-SHA256 →
 *     AES-256-GCM;
 *   - the TV recovers the seed with its private key
 *     ({@link unsealSeedFromDevice}).
 *
 * The server stores and relays the v2 envelope byte-for-byte, exactly as it
 * does for v1, and can read neither. The one thing ECDH cannot supply is proof
 * that the public key the hosted page sealed to is *the TV's* rather than an
 * attacker's — that is what {@link pairingVerificationCode} is for, and it is
 * the only MITM defence in the flow (see the entropy note on that function).
 */

import { toBase64, fromBase64 } from "./vault";

const TE = new TextEncoder();
const TD = new TextDecoder();

interface SealedEnvelope {
    v: 1;
    iv: string; // base64
    ct: string; // base64
}

interface SealedEnvelopeV2 {
    v: 2;
    /** base64 raw (SEC1 uncompressed) P-256 public key of the SEALER's ephemeral keypair. */
    epk: string;
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

// ---- v2: ECDH device pairing ----------------------------------------------
//
// Deliberately a SEPARATE unseal entry point rather than one `unsealSeed` that
// dispatches on `envelope.v`. The two versions do not just differ in envelope
// shape — their *second argument* is a different kind of thing entirely (v1: a
// base64url string plucked out of a URL fragment; v2: a non-extractable
// `CryptoKey`). Overloading one function on a `string | CryptoKey` union would
// buy nothing at the call sites (each caller statically knows which flow it is
// in) while adding a narrowing branch to the v1 path, which is live in
// production hosted auth. Each function still validates `v` and rejects the
// other version's envelope, so a mis-routed envelope fails loudly rather than
// being interpreted under the wrong scheme.

/** P-256 curve parameters for the pairing ECDH. */
const PAIRING_CURVE: EcKeyGenParams & EcKeyImportParams = { name: "ECDH", namedCurve: "P-256" };

/**
 * HKDF `info` for the v2 seal. Versioned and domain-separated: v1 derives no
 * key at all (K_t is raw random), so no v1 key can ever collide with this, and
 * a future v3 must pick a new label rather than reuse this one.
 */
const HKDF_INFO_V2 = "muhkoo/hosted-handoff/v2/device-seal";

/** Domain separator for {@link pairingVerificationCode} — distinct from the seal KDF. */
const PAIRING_CODE_DOMAIN = "muhkoo/hosted-handoff/v2/pairing-code";

/**
 * Alphabet for the pairing verification code: 30 symbols, every confusable pair
 * removed in BOTH directions — no `0`/`O`, no `1`/`I`/`L`, and no `U` (which is
 * read as `V` on the low-resolution, far-viewed type a TV renders). Because the
 * user compares this string across two screens by eye, unambiguity beats the
 * convenience of a power-of-two alphabet; the derivation below rejection-samples
 * to avoid the modulo bias that costs us.
 */
export const PAIRING_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

/** Length of the pairing verification code, in characters. 30^8 ≈ 39.3 bits. */
export const PAIRING_CODE_LENGTH = 8;

/**
 * PBKDF2 iterations for the verification code. This is NOT protecting a
 * password — it is a deliberate work factor on an attacker precomputing codes.
 * See {@link pairingVerificationCode}.
 */
const PAIRING_CODE_ITERATIONS = 200_000;

/** An ephemeral ECDH keypair generated by the pairing device (the TV). */
export interface DevicePairingKeypair {
    /** base64 raw (SEC1 uncompressed, 65 bytes) public key — safe to publish. */
    publicKeyB64: string;
    /**
     * Non-extractable private half. In-memory only, one per pairing attempt:
     * it is never persisted and never leaves the device, so a captured pairing
     * transcript is undecryptable once the attempt ends.
     */
    privateKey: CryptoKey;
}

/**
 * (Device side) Generate the ephemeral P-256 ECDH keypair for one pairing
 * attempt. Call this once per attempt and throw it away when the attempt ends —
 * reusing a keypair across attempts would let an old, observed ciphertext be
 * decrypted by whoever later obtains the key.
 */
export async function generateDevicePairingKeypair(): Promise<DevicePairingKeypair> {
    const pair = (await crypto.subtle.generateKey(PAIRING_CURVE, false, ["deriveBits"])) as CryptoKeyPair;
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    return { publicKeyB64: toBase64(raw), privateKey: pair.privateKey };
}

/**
 * (Hosted-page side) Seal the master seed *to a device's* pairing public key.
 *
 * A fresh ephemeral keypair is generated per call and its public half is
 * carried in the envelope (`epk`), so sealing the same seed to the same device
 * twice yields unrelated ciphertext — and the sealer retains nothing that could
 * later reopen the envelope.
 *
 * Returns the v2 `sealedKeys` string, which slots into exactly the same server
 * field as v1: relayed verbatim, never read.
 */
export async function sealSeedToDevice(seed: Uint8Array, devicePublicKeyB64: string): Promise<string> {
    const devicePubRaw = decodePairingPublicKey(devicePublicKeyB64);
    const devicePub = await importPairingPublicKey(devicePubRaw);

    const ephemeral = (await crypto.subtle.generateKey(PAIRING_CURVE, false, ["deriveBits"])) as CryptoKeyPair;
    const epkRaw = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));

    const key = await deriveDeviceSealKey(ephemeral.privateKey, devicePub, epkRaw, devicePubRaw, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(
        await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, seed as BufferSource),
    );

    const envelope: SealedEnvelopeV2 = { v: 2, epk: toBase64(epkRaw), iv: toBase64(iv), ct: toBase64(ct) };
    return toBase64(TE.encode(JSON.stringify(envelope)));
}

/**
 * (Device side) Recover the master seed from a v2 envelope using the ephemeral
 * private key from {@link generateDevicePairingKeypair}.
 *
 * Throws on any tamper: a substituted `epk` yields a different shared secret
 * (or fails point validation outright), and any edit to `iv`/`ct` fails the
 * AES-GCM tag. There is no path that returns partially-authenticated bytes.
 *
 * `devicePublicKeyB64` is the caller's OWN public half (from
 * {@link generateDevicePairingKeypair}). It is required, not optional, because
 * it is mixed into the KDF — see {@link deriveDeviceSealKey} for why binding the
 * recipient matters. A device always holds both halves, so this costs nothing.
 */
export async function unsealSeedFromDevice(
    sealedKeys: string,
    privateKey: CryptoKey,
    devicePublicKeyB64: string,
): Promise<Uint8Array> {
    const envelope = JSON.parse(TD.decode(fromBase64Loose(sealedKeys))) as SealedEnvelopeV2;
    if (envelope.v !== 2) throw new Error(`Unsupported device-handoff envelope version ${envelope.v}`);

    const devicePubRaw = decodePairingPublicKey(devicePublicKeyB64);
    const epkRaw = decodePairingPublicKey(envelope.epk);
    const epk = await importPairingPublicKey(epkRaw);

    const key = await deriveDeviceSealKey(privateKey, epk, epkRaw, devicePubRaw, ["decrypt"]);
    const seed = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromBase64Loose(envelope.iv) as BufferSource },
        key,
        fromBase64Loose(envelope.ct) as BufferSource,
    );
    return new Uint8Array(seed);
}

/**
 * Short code derived deterministically from the device's pairing public key,
 * displayed on BOTH the TV and the approving browser so the human can confirm
 * they match before approving.
 *
 * ## What this is worth (be honest about it)
 *
 * ~39.3 bits (30^8), rendered in an unambiguous 30-symbol alphabet and grouped
 * as `XXXX-XXXX` for comparison. Alongside the recipient-key binding in
 * {@link deriveDeviceSealKey}, this is what stops a substituted device key: the
 * KDF rejects a *negated* key, and this code is what a human uses to reject a
 * wholly *attacker-generated* one, which the crypto cannot detect on its own —
 * ECDH proves nothing about WHOSE public key it is.
 *
 * Two attacks, and what each actually costs:
 *
 *   1. **Online grind.** Generate keypairs until one's code equals the honest
 *      TV's. ~2^39 trials. Naively that reads as "keygen + hash", but a real
 *      attacker never generates keys: walking `P_{i+1} = P_i + G` while tracking
 *      `d_i = d_0 + i` makes each trial one point-add plus one derivation. With
 *      a plain hash that is well under a core-day — which is why this uses
 *      PBKDF2-SHA256 at {@link PAIRING_CODE_ITERATIONS} iterations instead. The
 *      work factor applies per trial, pushing the same grind to the order of
 *      10^5 core-days. The target is also only learned when pairing starts, so
 *      the grind is online against the pairing TTL (keep it minutes).
 *   2. **Precomputed table.** The reason this is not a plain hash. A table over
 *      candidate keys is computed once and reused forever; with SHA-256 that is
 *      cheap enough to be the preferred attack. The iteration count multiplies
 *      the table's build cost by the same 2 * 10^5.
 *
 * Neither is a proof of security, and an adversary with ASIC-scale hardware
 * changes these numbers. If the margin is ever judged insufficient, raise
 * {@link PAIRING_CODE_LENGTH} — 10 characters buys ~49 bits for two more
 * characters of human comparison, and is display-only: it does not touch the
 * envelope or the wire format.
 *
 * The cost is paid once per pairing, on two idle devices, so ~200k iterations
 * is imperceptible here in a way it would not be on a hot path.
 */
export async function pairingVerificationCode(devicePublicKeyB64: string): Promise<string> {
    const pubRaw = decodePairingPublicKey(devicePublicKeyB64);
    const material = await crypto.subtle.importKey("raw", pubRaw as BufferSource, { name: "PBKDF2" }, false, [
        "deriveBits",
    ]);
    // Enough bytes that rejection sampling (below) effectively never runs dry:
    // each byte is rejected with p = 16/256, so 32 bytes yields 8 symbols with
    // overwhelming probability.
    const bits = new Uint8Array(
        await crypto.subtle.deriveBits(
            {
                name: "PBKDF2",
                hash: "SHA-256",
                salt: TE.encode(PAIRING_CODE_DOMAIN) as BufferSource,
                iterations: PAIRING_CODE_ITERATIONS,
            },
            material,
            256,
        ),
    );

    // Rejection-sample so all 30 symbols are equally likely. 256 is not a
    // multiple of 30, so a plain modulo would over-weight the first 16 symbols.
    const n = PAIRING_CODE_ALPHABET.length;
    const limit = Math.floor(256 / n) * n; // 240
    let out = "";
    for (let i = 0; i < bits.length && out.length < PAIRING_CODE_LENGTH; i++) {
        if (bits[i] >= limit) continue;
        out += PAIRING_CODE_ALPHABET[bits[i] % n];
    }
    if (out.length < PAIRING_CODE_LENGTH) {
        // Astronomically unlikely (p < 2^-40); fail loudly rather than return a
        // short code that two screens would still "agree" on.
        throw new Error("Pairing code derivation ran out of entropy.");
    }
    // Grouped for human comparison — the format the spec and both UIs display.
    return out.slice(0, 4) + "-" + out.slice(4);
}

// ---- v2 internals ----------------------------------------------------------

/**
 * ECDH → HKDF-SHA256 → AES-256-GCM key.
 *
 * The raw ECDH output is never used as a key directly; it is extracted+expanded
 * with BOTH public keys mixed in:
 *
 *   - the sender's ephemeral key as HKDF **salt**, and
 *   - the recipient's device key appended to the HKDF **info**.
 *
 * Binding the recipient is not decoration. P-256 ECDH returns only the shared
 * point's x-coordinate, and negating a public key — `(x, y)` → `(x, p−y)`, which
 * is still on the curve and which ANYONE can compute from the published key —
 * yields the SAME x. So without the recipient in the KDF, a seal addressed to
 * the negated key still decrypts under the honest private key, even though that
 * negated key displays a DIFFERENT {@link pairingVerificationCode}. That would
 * leave the human code as the only thing rejecting a substituted recipient.
 * Mixing `devicePubRaw` in makes the substitution fail in the crypto layer,
 * where it belongs.
 *
 * (The salt is load-bearing for the same reason — it is what makes a swapped
 * `epk` derive a different key. Do not "simplify" either input away.)
 */
async function deriveDeviceSealKey(
    priv: CryptoKey,
    pub: CryptoKey,
    epkRaw: Uint8Array,
    devicePubRaw: Uint8Array,
    usages: KeyUsage[],
): Promise<CryptoKey> {
    const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: pub }, priv, 256));
    const prk = await crypto.subtle.importKey("raw", shared as BufferSource, { name: "HKDF" }, false, ["deriveBits"]);
    const label = TE.encode(HKDF_INFO_V2);
    const info = new Uint8Array(label.length + devicePubRaw.length);
    info.set(label, 0);
    info.set(devicePubRaw, label.length);
    const okm = await crypto.subtle.deriveBits(
        {
            name: "HKDF",
            hash: "SHA-256",
            salt: epkRaw as BufferSource,
            info: info as BufferSource,
        },
        prk,
        256,
    );
    return crypto.subtle.importKey("raw", okm, { name: "AES-GCM" }, false, usages);
}

/** Decode + shape-check a raw SEC1 uncompressed P-256 public key. */
function decodePairingPublicKey(b64: string): Uint8Array {
    if (typeof b64 !== "string" || b64.length === 0) {
        throw new Error("Pairing public key must be a non-empty base64 string.");
    }
    const raw = fromBase64Loose(b64);
    if (raw.length !== 65 || raw[0] !== 0x04) {
        throw new Error("Pairing public key must be a 65-byte uncompressed P-256 point.");
    }
    return raw;
}

/** Import a raw P-256 point for ECDH. Rejects points that are not on the curve. */
function importPairingPublicKey(raw: Uint8Array): Promise<CryptoKey> {
    return crypto.subtle.importKey("raw", raw as BufferSource, PAIRING_CURVE, false, []);
}

/**
 * Base64 decode that also accepts the URL-safe alphabet and missing padding —
 * pairing public keys may travel through query strings, QR payloads, or JSON
 * depending on the client, and rejecting a key over `-` vs `+` would be a
 * miserable failure mode to debug.
 */
function fromBase64Loose(s: string): Uint8Array {
    const norm = s.replace(/-/g, "+").replace(/_/g, "/");
    return fromBase64(norm.padEnd(Math.ceil(norm.length / 4) * 4, "="));
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
