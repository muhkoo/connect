/**
 * Conversions between SubtleCrypto `CryptoKey`s and the wire formats the
 * accelerator's auth endpoints + `preimagePoK` circuit expect.
 *
 * Two outputs we need from an ECDSA `CryptoKey`:
 *   - **base64 raw**  — passed to `/api/auth/zk-register` as
 *                       `ecdsaPublicKey` / `ecdhPublicKey`. (Name is historical;
 *                       the legacy client called it `exportPublicKeyToBase58`
 *                       but actually used base64 — kept as base64.)
 *   - **hex raw**     — fed to the proof as `ecdsaPub` input; the circuit
 *                       reduces it into a field element.
 *
 * Both go through `crypto.subtle.exportKey("raw", ...)` which yields the
 * uncompressed SEC1 form (`0x04 || X || Y`).
 */

import { toHex } from "../utilities/bytes";

function bytesToBase64(bytes: Uint8Array): string {
    let str = "";
    for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
    return btoa(str);
}

/** Raw uncompressed (`0x04 || X || Y`) public key bytes, as lowercase hex. */
export async function exportPublicKeyHex(publicKey: CryptoKey): Promise<string> {
    const buf = await crypto.subtle.exportKey("raw", publicKey);
    return toHex(new Uint8Array(buf));
}

/** Raw uncompressed public key as base64 — wire format for the auth endpoints. */
export async function exportPublicKeyBase64(publicKey: CryptoKey): Promise<string> {
    const buf = await crypto.subtle.exportKey("raw", publicKey);
    return bytesToBase64(new Uint8Array(buf));
}

/** Sign a UTF-8 `message` with an ECDSA private key. Returns base64. */
export async function signMessage(message: string, privateKey: CryptoKey): Promise<string> {
    const data = new TextEncoder().encode(message);
    const sig = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        privateKey,
        data,
    );
    return bytesToBase64(new Uint8Array(sig));
}
