/**
 * SpaceCipher — pure crypto for the fan-out group-encryption layer.
 *
 * Everything here routes through the canonical primitives in
 * `src/crypto/primitives` (AES-256-GCM, HKDF-SHA256, randomBytes) and the
 * P-384 ECDH `deriveBits` call the Double Ratchet already uses. No new
 * algorithms, no `crypto.subtle` reach-arounds beyond key gen / derive /
 * import-export (which the primitive layer intentionally doesn't cover).
 *
 * Three concerns:
 *   1. Space identity — a P-384 ECDH keypair; the encoded public key is the
 *      space's id.
 *   2. Group key distribution — ECIES wrap/unwrap of `K_space` to a member's
 *      identity ECDH public key (ephemeral-static ECDH → HKDF → AES-GCM).
 *   3. Message sealing — encrypt the serialized `Message` once under the
 *      epoch's group key.
 *
 * Public keys are transported as base64url-encoded JWK, matching the JWK
 * transport convention already used in `EncryptedSession`.
 */

import { Message } from "../messaging/Message";
import {
    encryptAesGcm,
    decryptAesGcm,
    deriveBitsHkdf,
    randomBytes,
    getSubtle,
    AES_GCM_KEY_BYTES,
    AES_GCM_IV_BYTES,
} from "../crypto/primitives";
import {
    toBase64,
    fromBase64,
    toBase64Url,
    fromBase64Url,
    utf8Encode,
    utf8Decode,
} from "../utilities";
import type { WrappedKey } from "./types";

/** HKDF label binding the wrap key to this protocol + version. */
const WRAP_INFO = "muhkoo/space/keywrap/v1";
/** Algorithm tag stamped into every WrappedKey. */
const WRAP_ALG = "ECDH-P384/HKDF-SHA256/AES-256-GCM";
/** Bits in a P-384 ECDH shared secret. */
const P384_BITS = 384;

const ECDH_PARAMS: EcKeyGenParams = { name: "ECDH", namedCurve: "P-384" };

// ---------------------------------------------------------------------------
// Public-key transport (base64url JWK)
// ---------------------------------------------------------------------------

/** Encode an ECDH public `CryptoKey` as a base64url JWK string. */
export async function exportEcdhPublicKey(key: CryptoKey): Promise<string> {
    const jwk = await getSubtle().exportKey("jwk", key);
    return toBase64Url(utf8Encode(JSON.stringify(jwk)));
}

/** Decode a base64url JWK string back into an ECDH public `CryptoKey`. */
export async function importEcdhPublicKey(encoded: string): Promise<CryptoKey> {
    const jwk = JSON.parse(utf8Decode(fromBase64Url(encoded)));
    // Public keys carry no usages.
    return getSubtle().importKey("jwk", jwk, ECDH_PARAMS, true, []);
}

/** The space's id is just its encoded ECDH public key. */
export const encodeSpaceId = exportEcdhPublicKey;

// ---------------------------------------------------------------------------
// Sender authentication (ECDSA P-384, matching the Double Ratchet path).
// A fan-out message is signed by its sender's identity ECDSA key so receivers
// can verify authorship end-to-end — independent of the relay, which only
// stamps `source` server-side. SHA-256 hash to match `DoubleRatchet`.
// ---------------------------------------------------------------------------

const ECDSA_PARAMS: EcKeyImportParams = { name: "ECDSA", namedCurve: "P-384" };
const ECDSA_SIGN: EcdsaParams = { name: "ECDSA", hash: "SHA-256" };

/** Encode an ECDSA public `CryptoKey` as a base64url JWK string. */
export async function exportEcdsaPublicKey(key: CryptoKey): Promise<string> {
    const jwk = await getSubtle().exportKey("jwk", key);
    return toBase64Url(utf8Encode(JSON.stringify(jwk)));
}

/** Decode a base64url JWK string back into an ECDSA verify-only public key. */
export async function importEcdsaPublicKey(encoded: string): Promise<CryptoKey> {
    const jwk = JSON.parse(utf8Decode(fromBase64Url(encoded)));
    return getSubtle().importKey("jwk", jwk, ECDSA_PARAMS, true, ["verify"]);
}

/**
 * Canonical bytes a sender signs (and a receiver re-derives). Binds the claimed
 * sender + routing + the sealed ciphertext, so a relay can't relabel `source`
 * and a member can't reuse another's ciphertext under a new envelope.
 */
export function canonicalMessage(fields: {
    source: string;
    target: string;
    subject: string;
    epoch: number;
    iv: string;
    ciphertext: string;
}): string {
    return [fields.source, fields.target, fields.subject, fields.epoch, fields.iv, fields.ciphertext].join("\n");
}

/** Sign the canonical bytes with the sender's ECDSA identity private key. */
export async function signSpaceMessage(canonical: string, ecdsaPriv: CryptoKey): Promise<string> {
    const sig = await getSubtle().sign(ECDSA_SIGN, ecdsaPriv, utf8Encode(canonical));
    return toBase64(new Uint8Array(sig));
}

/** Verify a signature over the canonical bytes against the sender's ECDSA key. */
export async function verifySpaceMessage(canonical: string, sigB64: string, ecdsaPub: CryptoKey): Promise<boolean> {
    try {
        return await getSubtle().verify(ECDSA_SIGN, ecdsaPub, fromBase64(sigB64), utf8Encode(canonical));
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Space identity
// ---------------------------------------------------------------------------

export interface SpaceIdentity {
    /** Encoded public key — the space's logical id. */
    id: string;
    publicKey: CryptoKey;
    privateKey: CryptoKey;
}

/** Generate a fresh space identity keypair (P-384 ECDH). */
export async function generateSpaceIdentity(): Promise<SpaceIdentity> {
    const kp = await getSubtle().generateKey(ECDH_PARAMS, true, ["deriveBits"]);
    const id = await encodeSpaceId(kp.publicKey);
    return { id, publicKey: kp.publicKey, privateKey: kp.privateKey };
}

// ---------------------------------------------------------------------------
// Group key
// ---------------------------------------------------------------------------

/** Mint a fresh 256-bit group key for an epoch. */
export function generateSpaceKey(): Uint8Array {
    return randomBytes(AES_GCM_KEY_BYTES);
}

// ---------------------------------------------------------------------------
// ECIES wrap / unwrap of the group key
// ---------------------------------------------------------------------------

/**
 * Wrap `kSpace` for `recipientEcdhPub` using an ephemeral ECDH keypair.
 * The HKDF salt binds the wrap key to `epoch`, so a wrap minted for one epoch
 * cannot be replayed to unwrap a different epoch's blob.
 */
export async function wrapSpaceKey(
    kSpace: Uint8Array,
    epoch: number,
    recipientEcdhPub: CryptoKey,
): Promise<WrappedKey> {
    const eph = await getSubtle().generateKey(ECDH_PARAMS, true, ["deriveBits"]);
    const shared = new Uint8Array(
        await getSubtle().deriveBits(
            { name: "ECDH", public: recipientEcdhPub },
            eph.privateKey,
            P384_BITS,
        ),
    );
    const wrapKey = await deriveBitsHkdf(
        shared,
        WRAP_INFO,
        AES_GCM_KEY_BYTES,
        utf8Encode(`epoch:${epoch}`),
    );
    const iv = randomBytes(AES_GCM_IV_BYTES);
    const ciphertext = await encryptAesGcm(wrapKey, iv, kSpace);
    return {
        epoch,
        ephemeralPub: await exportEcdhPublicKey(eph.publicKey),
        iv: toBase64(iv),
        ciphertext: toBase64(ciphertext),
        alg: WRAP_ALG,
    };
}

/**
 * Unwrap a {@link WrappedKey} using the recipient's identity ECDH private key.
 * Throws (GCM tag failure) on the wrong private key or a tampered blob.
 */
export async function unwrapSpaceKey(
    wrapped: WrappedKey,
    ownEcdhPriv: CryptoKey,
): Promise<Uint8Array> {
    const ephPub = await importEcdhPublicKey(wrapped.ephemeralPub);
    const shared = new Uint8Array(
        await getSubtle().deriveBits(
            { name: "ECDH", public: ephPub },
            ownEcdhPriv,
            P384_BITS,
        ),
    );
    const wrapKey = await deriveBitsHkdf(
        shared,
        WRAP_INFO,
        AES_GCM_KEY_BYTES,
        utf8Encode(`epoch:${wrapped.epoch}`),
    );
    return decryptAesGcm(wrapKey, fromBase64(wrapped.iv), fromBase64(wrapped.ciphertext));
}

// ---------------------------------------------------------------------------
// Message sealing
// ---------------------------------------------------------------------------

/** Seal an already-serialized message string under the group key. */
export async function sealSerialized(
    kSpace: Uint8Array,
    serialized: string,
): Promise<{ iv: string; ciphertext: string }> {
    const iv = randomBytes(AES_GCM_IV_BYTES);
    const ciphertext = await encryptAesGcm(kSpace, iv, utf8Encode(serialized));
    return { iv: toBase64(iv), ciphertext: toBase64(ciphertext) };
}

/**
 * Open a sealed payload back into its serialized message string. Throws (GCM
 * tag failure) on the wrong group key or a tampered ciphertext.
 */
export async function openSerialized(
    kSpace: Uint8Array,
    iv: string,
    ciphertext: string,
): Promise<string> {
    const plaintext = await decryptAesGcm(kSpace, fromBase64(iv), fromBase64(ciphertext));
    return utf8Decode(plaintext);
}

/** Seal a `Message` once under the group key. Returns base64 iv + ciphertext. */
export async function sealMessage(
    kSpace: Uint8Array,
    msg: Message,
): Promise<{ iv: string; ciphertext: string }> {
    return sealSerialized(kSpace, msg.serialize());
}

/**
 * Open a sealed message back into a `Message`. Throws (GCM tag failure) on the
 * wrong group key or a tampered ciphertext.
 */
export async function openMessage(
    kSpace: Uint8Array,
    iv: string,
    ciphertext: string,
): Promise<Message> {
    return Message.deserialize(await openSerialized(kSpace, iv, ciphertext));
}
