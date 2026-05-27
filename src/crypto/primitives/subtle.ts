/**
 * WebCrypto subtle-interface resolver.
 *
 * Available natively in every runtime this SDK targets (modern browsers,
 * Node 16+, CF Workers). Centralized here so the runtime check + error
 * message are consistent across every primitive — and so a future polyfill
 * shim has one place to plug in.
 */

export function getSubtle(): SubtleCrypto {
    const s = (globalThis.crypto as Crypto | undefined)?.subtle;
    if (!s) {
        throw new Error(
            "@muhkoo/connect crypto: `globalThis.crypto.subtle` is unavailable. " +
            "Modern browsers, Node 16+, and CF Workers expose it natively.",
        );
    }
    return s;
}
