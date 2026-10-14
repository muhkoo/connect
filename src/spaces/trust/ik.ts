/**
 * Identity keys (IK): an account's P-256 ECDSA public key, raw uncompressed
 * SEC1 (`0x04 ‖ X ‖ Y`, 65 bytes), registered once with the account.
 *
 * Stored IKs come in two spellings. Newer clients register base64
 * (`exportPublicKeyBase64`); older registrations stored 130-char hex. The
 * decode rule is the accelerator's: 130 hex digits (either case, optional
 * `0x`) first, otherwise base64.
 *
 * Two IKs are compared as decoded bytes, never as strings: a hex-registered
 * account and a base64 log entry name the same key.
 *
 * Verification is P-256 ECDSA with SHA-256 over IEEE P1363 (r ‖ s, 64 bytes)
 * signatures in standard or url base64. It fails closed and never throws: a
 * bad key, a bad signature, or a value with no canonical encoding is simply
 * "not validly signed". Nothing here logs; a refusal is the caller's to report.
 *
 * Ported unchanged from the accelerator's `src/lib/ik.ts` and the primitives of
 * `src/trust/verify.ts`. No npm dependencies (§6.9).
 */
import { fromBase64Url, toBase64 } from "../../utilities";

/** Raw uncompressed P-256 point length. */
const RAW_P256_BYTES = 65;

/** The longest accepted spelling: `0x` + 130 hex. A base64 IK is 88 chars. */
const MAX_IK_CHARS = 132;
const HEX_IK = /^[0-9a-fA-F]{130}$/;
/** Standard or url alphabet, optional trailing padding. No whitespace: `atob` would skip it. */
const B64_CHARS = /^[A-Za-z0-9+/_-]+={0,2}$/;

const P256 = { name: "ECDSA", namedCurve: "P-256" };
const ECDSA_SHA256 = { name: "ECDSA", hash: "SHA-256" };
const P1363_P256_BYTES = 64;
/** 64 bytes is 88 base64 chars; anything much longer is not a signature. */
const MAX_SIG_CHARS = 128;

/**
 * Raw uncompressed P-256 point (0x04‖X‖Y, 65 bytes) from 130-hex (optional 0x,
 * either case) or base64 (standard or url alphabet, padded or not). `null` if
 * malformed, the wrong length, or not 0x04-prefixed. It does not check that
 * the point is on the curve; `importIk` (below) does.
 */
export function decodeRawP256(s: unknown): Uint8Array | null {
  if (typeof s !== "string" || s.length === 0 || s.length > MAX_IK_CHARS) return null;
  const hex = s.startsWith("0x") ? s.slice(2) : s;
  let raw: Uint8Array;
  if (HEX_IK.test(hex)) {
    raw = new Uint8Array(RAW_P256_BYTES);
    for (let i = 0; i < RAW_P256_BYTES; i++) raw[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  } else {
    if (!B64_CHARS.test(s)) return null;
    try {
      raw = fromBase64Url(s);
    } catch {
      // Malformed base64 is not a key; null is the "invalid" answer.
      return null;
    }
  }
  if (raw.length !== RAW_P256_BYTES || raw[0] !== 0x04) return null;
  return raw;
}

/** Canonical IK string: standard padded base64 of the 65 raw bytes (SpecA `b64`). `null` if not decodable. */
export function normalizeIk(s: unknown): string | null {
  const raw = decodeRawP256(s);
  return raw ? toBase64(raw) : null;
}

/** Byte equality of two IK encodings; false if either does not decode. */
export function ikEquals(a: unknown, b: unknown): boolean {
  const x = decodeRawP256(a);
  const y = decodeRawP256(b);
  if (!x || !y) return false;
  let diff = 0;
  for (let i = 0; i < RAW_P256_BYTES; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** `null` if `ik` does not decode, or is not a point on P-256. */
export async function importIk(ik: string): Promise<CryptoKey | null> {
  const raw = decodeRawP256(ik);
  if (!raw) return null;
  try {
    return await crypto.subtle.importKey("raw", raw as BufferSource, P256, false, ["verify"]);
  } catch {
    // Not on the curve: not an identity key.
    return null;
  }
}

/** `sig`: 64-byte P1363, standard or url base64. Never throws. */
export async function verifyP256(ik: string, sigB64: string, data: Uint8Array): Promise<boolean> {
  if (typeof sigB64 !== "string" || sigB64 === "" || sigB64.length > MAX_SIG_CHARS) return false;
  let sig: Uint8Array;
  try {
    sig = fromBase64Url(sigB64);
  } catch {
    return false;
  }
  if (sig.length !== P1363_P256_BYTES) return false;
  const key = await importIk(ik);
  if (!key) return false;
  try {
    return await crypto.subtle.verify(ECDSA_SHA256, key, sig as BufferSource, data as BufferSource);
  } catch {
    return false;
  }
}

/** fp(IK) = b64(SHA-256(raw 65 bytes)) (design §3.2). Throws if `ik` is not a P-256 point. */
export async function fingerprint(ik: string): Promise<string> {
  const raw = decodeRawP256(ik);
  if (!raw) throw new Error("fingerprint: not a P-256 identity key");
  return toBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", raw as BufferSource)));
}
