/**
 * Public-share password proof. The password never leaves the device: the guest sends
 * `proof = base64(PBKDF2-SHA256(password, salt, iterations, 32 bytes))` and the server stores
 * `verifier = base64(SHA-256(proof bytes))`. The salt is an opaque string chosen at creation time;
 * both sides use its UTF-8 bytes.
 */
import type { PasswordVerifier } from "./types";

export const SHARE_PASSWORD_ITERATIONS = 310_000;

const enc = new TextEncoder();

function b64(bytes: Uint8Array): string {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
}

function unb64(s: string): Uint8Array {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

const MIN_ITERATIONS = 100_000;
const MAX_ITERATIONS = 2_000_000;

async function proofBytes(password: string, salt: string, iterations: number): Promise<Uint8Array> {
    if (!Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
        throw new Error(`Share password iterations must be between ${MIN_ITERATIONS} and ${MAX_ITERATIONS}`);
    }
    const key = await crypto.subtle.importKey("raw", enc.encode(password.normalize("NFC")) as BufferSource, { name: "PBKDF2" }, false, [
        "deriveBits",
    ]);
    const bits = await crypto.subtle.deriveBits(
        { name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt) as BufferSource, iterations },
        key,
        256,
    );
    return new Uint8Array(bits);
}

/** What a guest sends to prove it knows the password. */
export async function passwordProof(password: string, salt: string, iterations: number): Promise<string> {
    return b64(await proofBytes(password, salt, iterations));
}

/** What the share owner registers at creation: a fresh salt and the verifier for `password`. */
export async function newPasswordVerifier(password: string): Promise<PasswordVerifier> {
    const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
    const iterations = SHARE_PASSWORD_ITERATIONS;
    const proof = await passwordProof(password, salt, iterations);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", unb64(proof) as BufferSource));
    return { salt, iterations, verifier: b64(digest) };
}
