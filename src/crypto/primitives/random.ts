/**
 * Cryptographically secure random bytes.
 *
 * Wraps `crypto.getRandomValues` with two small affordances every caller
 * needs:
 *   - Allocates over a fresh, non-shared `ArrayBuffer` so the returned
 *     `Uint8Array` satisfies WebCrypto's `BufferSource` type under strict
 *     TS lib settings (where `Uint8Array<ArrayBufferLike>` isn't directly
 *     assignable).
 *   - Chunks requests larger than 65 KiB, the per-call cap browsers enforce
 *     on `getRandomValues`.
 */

const MAX_PER_CALL = 65536;

export function randomBytes(n: number): Uint8Array {
    if (!Number.isInteger(n) || n < 0) {
        throw new Error(`randomBytes: n must be a non-negative integer (got ${n})`);
    }
    const buf = new Uint8Array(new ArrayBuffer(n));
    for (let offset = 0; offset < n; offset += MAX_PER_CALL) {
        const slice = buf.subarray(offset, Math.min(offset + MAX_PER_CALL, n));
        (globalThis.crypto as Crypto).getRandomValues(slice);
    }
    return buf;
}
