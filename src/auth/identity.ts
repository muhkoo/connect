/**
 * Deterministic ZK identity derivation from `(username, password)`.
 *
 * Same inputs on ANY device produce the same secret, salt, and P-256
 * ECDSA + ECDH keypairs — which is what makes federated login from a
 * fresh browser possible. There is no localStorage involvement: every
 * register and login call re-derives the identity on demand.
 *
 * Pipeline:
 *   master_seed = PBKDF2-SHA256(password, "muhkoo-zk-v1:" || username, 200k iters)
 *   secret      = HKDF-Expand-SHA256(master_seed, "zk-secret",  32 bytes) → hex
 *   salt        = HKDF-Expand-SHA256(master_seed, "zk-salt",    32 bytes) → hex
 *   ecdsa_priv  = HKDF-Expand-SHA256(master_seed, "ecdsa-priv", 32 bytes)
 *   ecdh_priv   = HKDF-Expand-SHA256(master_seed, "ecdh-priv",  32 bytes)
 *
 * P-256 public points are computed via `@noble/curves` (WebCrypto has no
 * derive-public-from-private-scalar API), then both keypairs are imported
 * into SubtleCrypto in JWK form so the rest of the crypto stack can keep
 * using `crypto.subtle.sign` / `crypto.subtle.deriveBits`.
 *
 * Originally lived in `accelerator/public/js/zk-identity.js` and was ported
 * to `muhkoo/web/src/zk/identity.ts`; consolidated here so the SDK owns
 * identity derivation end-to-end.
 */

// @noble/curves v2 consolidated all NIST curves under `nist`; v1 had a
// `/p256` subpath. Update if the dep changes again.
import { p256 } from "@noble/curves/nist.js";
import { toHex } from "../utilities/bytes";

const TEXT_ENCODER = new TextEncoder();
const PBKDF2_ITERATIONS = 200_000;
const SCALAR_BYTES = 32;

export interface ZkIdentity {
    /** 32-byte secret, hex-encoded. Private witness for the ZK circuit. */
    secretHex: string;
    /** 32-byte salt, hex-encoded. Private witness for the ZK circuit. */
    saltHex: string;
    /** P-256 ECDSA keypair, used to sign auth proofs. */
    ecdsaKeyPair: CryptoKeyPair;
    /** P-256 ECDH keypair, used by the chat ratchet. */
    ecdhKeyPair: CryptoKeyPair;
}

async function pbkdf2Bytes(password: string, info: string, byteLength: number): Promise<Uint8Array> {
    const baseKey = await crypto.subtle.importKey(
        "raw",
        TEXT_ENCODER.encode(password),
        { name: "PBKDF2" },
        false,
        ["deriveBits"],
    );
    const bits = await crypto.subtle.deriveBits(
        {
            name: "PBKDF2",
            salt: TEXT_ENCODER.encode(info),
            iterations: PBKDF2_ITERATIONS,
            hash: "SHA-256",
        },
        baseKey,
        byteLength * 8,
    );
    return new Uint8Array(bits);
}

async function hkdfExpand(prk: Uint8Array, info: string, byteLength: number): Promise<Uint8Array> {
    const baseKey = await crypto.subtle.importKey(
        "raw",
        prk as BufferSource,
        { name: "HKDF" },
        false,
        ["deriveBits"],
    );
    const bits = await crypto.subtle.deriveBits(
        {
            name: "HKDF",
            hash: "SHA-256",
            salt: new Uint8Array() as BufferSource,
            info: TEXT_ENCODER.encode(info) as BufferSource,
        },
        baseKey,
        byteLength * 8,
    );
    return new Uint8Array(bits);
}

function bytesToBase64url(bytes: Uint8Array): string {
    let str = "";
    for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
    return btoa(str).replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

// Convert a 32-byte scalar into a valid P-256 keypair. Probability of drawing
// 0 or a value >= curve order from HKDF output is negligible (~2^-128); noble
// will throw if it ever happens.
async function importP256KeyPair(
    privBytes: Uint8Array,
    algo: EcKeyAlgorithm,
    privKeyUses: KeyUsage[],
    pubKeyUses: KeyUsage[],
): Promise<CryptoKeyPair> {
    const pubBytes = p256.getPublicKey(privBytes, false); // 65-byte 0x04||X||Y
    const x = pubBytes.slice(1, 33);
    const y = pubBytes.slice(33, 65);
    const xB = bytesToBase64url(x);
    const yB = bytesToBase64url(y);
    const dB = bytesToBase64url(privBytes);

    const privateKey = await crypto.subtle.importKey(
        "jwk",
        { kty: "EC", crv: "P-256", d: dB, x: xB, y: yB, ext: true },
        algo,
        false,
        privKeyUses,
    );
    const publicKey = await crypto.subtle.importKey(
        "jwk",
        { kty: "EC", crv: "P-256", x: xB, y: yB, ext: true },
        algo,
        true,
        pubKeyUses,
    );
    return { privateKey, publicKey };
}

async function importEcdsaKeyPair(privBytes: Uint8Array): Promise<CryptoKeyPair> {
    return importP256KeyPair(
        privBytes,
        { name: "ECDSA", namedCurve: "P-256" },
        ["sign"],
        ["verify"],
    );
}

async function importEcdhKeyPair(privBytes: Uint8Array): Promise<CryptoKeyPair> {
    return importP256KeyPair(
        privBytes,
        { name: "ECDH", namedCurve: "P-256" },
        ["deriveKey", "deriveBits"],
        [],
    );
}

/**
 * Derive a deterministic ZK identity from `(username, password)`.
 *
 * Same inputs always produce the same identity, on any device — that's
 * what makes federated login work without dragging encrypted state across
 * devices.
 */
export async function deriveIdentity(username: string, password: string): Promise<ZkIdentity> {
    if (typeof username !== "string" || username.length === 0) {
        throw new Error("deriveIdentity: `username` is required");
    }
    if (typeof password !== "string" || password.length === 0) {
        throw new Error("deriveIdentity: `password` is required");
    }
    const seed = await deriveMasterSeedFromPassword(username, password);
    return deriveIdentityFromSeed(seed);
}

/**
 * Legacy master-seed derivation: `PBKDF2(password, "muhkoo-zk-v1:"||username)`.
 *
 * This was the *only* path pre-vault, where the identity descended directly from
 * the password. It's kept so existing accounts still re-derive their seed (and
 * the vault can adopt that exact seed on migration, preserving the commitment).
 * New accounts use a random seed (`vault.randomSeed`) instead, so their identity
 * is no longer a function of the password.
 */
export async function deriveMasterSeedFromPassword(username: string, password: string): Promise<Uint8Array> {
    return pbkdf2Bytes(password, "muhkoo-zk-v1:" + username, SCALAR_BYTES);
}

/**
 * Derive the (unchanged) ZK identity from a 32-byte **master seed**. The seed is
 * HKDF-expanded into secret/salt + the P-256 ECDSA & ECDH keypairs exactly as
 * before — so the resulting commitment is byte-identical for a given seed. The
 * vault wraps THIS seed under each recovery factor.
 */
export async function deriveIdentityFromSeed(seed: Uint8Array): Promise<ZkIdentity> {
    if (!(seed instanceof Uint8Array) || seed.length !== SCALAR_BYTES) {
        throw new Error(`deriveIdentityFromSeed: expected a ${SCALAR_BYTES}-byte seed`);
    }

    const secretBytes = await hkdfExpand(seed, "zk-secret", SCALAR_BYTES);
    const saltBytes = await hkdfExpand(seed, "zk-salt", SCALAR_BYTES);
    const ecdsaPriv = await hkdfExpand(seed, "ecdsa-priv", SCALAR_BYTES);
    const ecdhPriv = await hkdfExpand(seed, "ecdh-priv", SCALAR_BYTES);

    const ecdsaKeyPair = await importEcdsaKeyPair(ecdsaPriv);
    const ecdhKeyPair = await importEcdhKeyPair(ecdhPriv);

    return {
        secretHex: toHex(secretBytes),
        saltHex: toHex(saltBytes),
        ecdsaKeyPair,
        ecdhKeyPair,
    };
}
