/**
 * Byte conversion helpers usable in both Node and the browser.
 *
 * Replaces Node's `Buffer` API for the small set of operations we actually
 * need in the crypto layer: hex/base64/base64url encode + decode, and array
 * concatenation. Lets `DoubleRatchet`, `KeyStore`, etc. compile against
 * platforms without `Buffer` (browsers, CF Workers).
 */

const HEX_CHARS = "0123456789abcdef";

/** Encode a byte array as a lowercase hex string. */
export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out += HEX_CHARS[b >> 4] + HEX_CHARS[b & 0x0f];
  }
  return out;
}

/** Decode a hex string into a byte array. Accepts upper/lowercase; rejects odd-length input. */
export function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length % 2 !== 0) {
    throw new Error(`fromHex: input length must be even (got ${hex.length})`);
  }
  const ab = new ArrayBuffer(hex.length / 2);
  const out = new Uint8Array(ab);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error(`fromHex: invalid hex character at offset ${i * 2}`);
    }
    out[i] = byte;
  }
  return out;
}

/** Encode a byte array as a standard base64 string. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Decode a standard base64 string to bytes. */
export function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const ab = new ArrayBuffer(binary.length);
  const out = new Uint8Array(ab);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Encode a byte array as a base64url string (no padding). */
export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode a base64url string (with or without padding) to bytes. */
export function fromBase64Url(b64url: string): Uint8Array<ArrayBuffer> {
  const padded = b64url.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (b64url.length % 4)) % 4);
  return fromBase64(padded);
}

/** Concatenate any number of byte arrays into a single Uint8Array. */
export function concatBytes(...arrays: (Uint8Array | ArrayBuffer)[]): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const a of arrays) total += a.byteLength;
  const ab = new ArrayBuffer(total);
  const out = new Uint8Array(ab);
  let offset = 0;
  for (const a of arrays) {
    const view = a instanceof Uint8Array ? a : new Uint8Array(a);
    out.set(view, offset);
    offset += view.length;
  }
  return out;
}

/** Encode a UTF-8 string as bytes. Thin wrapper around TextEncoder for symmetry. */
export function utf8Encode(s: string): Uint8Array<ArrayBuffer> {
  // TextEncoder.encode returns Uint8Array<ArrayBufferLike>; widen to the
  // ArrayBuffer variant explicitly so WebCrypto's BufferSource type accepts it.
  const u8 = new TextEncoder().encode(s);
  const ab = new ArrayBuffer(u8.byteLength);
  const out = new Uint8Array(ab);
  out.set(u8);
  return out;
}

/** Decode UTF-8 bytes to a string. */
export function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
