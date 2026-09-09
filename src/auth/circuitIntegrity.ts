/**
 * Integrity pinning for the ZK circuit artifacts.
 *
 * THE PROBLEM. `generateAuthProof` hands the user's `secret` and `salt` — the
 * inputs the whole zero-knowledge design exists to keep on the device — to a
 * witness generator downloaded at runtime from the accelerator. That is the
 * party the proof is meant to convince. With no integrity check, a malicious or
 * compromised server serves a modified `preimagePoK.wasm` that copies `secret`
 * into a public-signal slot (public signals are just `witness[1..nPublic]`), and
 * the client forwards them without ever comparing against what it computed
 * locally. The server then derives the `client.kv` at-rest key through
 * `StorageCipher` and decrypts everything it stores. Controlling the `.zkey` is
 * just as bad by itself: a subverted CRS breaks Groth16's zero-knowledge
 * property outright.
 *
 * THE FIX. Fetch the bytes here, SHA-256 them against digests pinned at build
 * time, and hand snarkjs verified BUFFERS rather than a URL it will fetch for
 * itself. snarkjs accepts `Uint8Array` for both artifacts.
 *
 * THREAT-MODEL BOUNDARY, and why local paths are exempt. The attack is "a
 * SERVER serves you a modified artifact". A filesystem path is not
 * server-controlled — it is the caller's own machine — so non-`http(s)`
 * specifiers pass through untouched (this is also what lets tests point at
 * `circuits/build/` directly, where snarkjs reads them as paths under Node).
 * Anything fetched over the network must be pinned, or explicitly opted out of
 * with {@link CircuitIntegrity.allowUnpinned}.
 *
 * There is deliberately NO silent fallback. An unpinned `https:` URL throws
 * rather than quietly proving with unverified bytes — the failure mode this
 * codebase already has elsewhere (see the SHA-256-for-Poseidon substitution in
 * `crypto/ZeroKnowledge.ts`) is exactly what makes a security control useless.
 */

import { getSubtle } from "../crypto/primitives/subtle";
import { toHex } from "../utilities/bytes";

/**
 * SHA-256 of the `preimagePoK` artifacts this SDK version was built against.
 *
 * Verified identical to what the accelerator serves from
 * `public/circuits/build/` at the time of pinning. **If the circuit is ever
 * recompiled, these must be regenerated in the same commit as
 * `PREIMAGE_POK_VERIFICATION_KEY`, or every login fails closed** — which is the
 * intended direction for a mismatch.
 *
 * Regenerate with:
 *   shasum -a 256 circuits/build/preimagePoK_js/preimagePoK.wasm \
 *                 circuits/build/preimagePoK_0001.zkey
 */
export const PINNED_CIRCUIT_DIGESTS = {
    preimagePoKWasm: "9230ce3a883ca11e618639ac14fe0048b5dc4491c77b1dde3e41eb0896c33e10",
    preimagePoKZkey: "087f4ef09b6afbacad8e47b0029ded408a0ac3b5c9d5a1624e94c06bc258b871",
} as const;

/** Integrity options carried alongside a circuit URL. */
export interface CircuitIntegrity {
    /** Expected SHA-256 of the witness generator, lowercase hex. */
    wasmSha256?: string;
    /** Expected SHA-256 of the proving key, lowercase hex. */
    zkeySha256?: string;
    /**
     * Proceed without verification for network-fetched artifacts.
     *
     * DANGEROUS: it re-opens the attack described in this module's docs. Only
     * for local development against a circuit you compiled yourself and have
     * not yet pinned.
     */
    allowUnpinned?: boolean;
}

/** Thrown when a fetched artifact does not match its pinned digest. */
export class CircuitIntegrityError extends Error {
    constructor(
        readonly url: string,
        readonly expected: string,
        readonly actual: string,
    ) {
        super(
            `Circuit artifact failed integrity check.\n` +
                `  url:      ${url}\n` +
                `  expected: ${expected}\n` +
                `  actual:   ${actual}\n` +
                `The server served bytes this SDK build does not trust. This is either a ` +
                `recompiled circuit that was not re-pinned, or an attempt to substitute the ` +
                `witness generator / proving key. Proving was NOT attempted.`,
        );
        this.name = "CircuitIntegrityError";
    }
}

/** True when the specifier is something a server serves (vs. a local path). */
export function isRemoteArtifact(specifier: string): boolean {
    return /^https?:\/\//i.test(specifier);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = await getSubtle().digest("SHA-256", bytes as unknown as ArrayBuffer);
    return toHex(new Uint8Array(digest));
}

/**
 * Verified artifacts are cached by `url + expected digest`, so a session that
 * proves repeatedly (login, then every `PersonalSpaceClient` challenge) pays the
 * ~2.4MB fetch once. Keyed by the digest too, so re-pinning invalidates it.
 */
const cache = new Map<string, Promise<Uint8Array>>();

/**
 * Resolve one circuit artifact into something snarkjs can consume.
 *
 * Returns a verified `Uint8Array` for remote artifacts, or the specifier
 * unchanged for local paths (snarkjs reads those itself).
 */
export async function resolveArtifact(
    specifier: string,
    expectedSha256: string | undefined,
    opts: { allowUnpinned?: boolean; label: string; fetchFn?: typeof fetch },
): Promise<Uint8Array | string> {
    // Local path or caller-managed specifier — not server-controlled, so out of
    // scope for this control. Pass through to snarkjs untouched.
    if (!isRemoteArtifact(specifier)) return specifier;

    if (!expectedSha256) {
        if (!opts.allowUnpinned) {
            throw new Error(
                `${opts.label}: refusing to fetch a circuit artifact over the network without a ` +
                    `pinned SHA-256.\n  url: ${specifier}\n` +
                    `This artifact receives the user's secret as a private witness, so an ` +
                    `unverified one can exfiltrate it. Supply the digest alongside the URL, use ` +
                    `defaultCircuitUrls() which pins them, or set allowUnpinned: true if you ` +
                    `genuinely accept the risk.`,
            );
        }
        // Explicit, logged opt-out. Never silent.
        globalThis.appLogger?.warn?.(
            `${opts.label}: fetching ${specifier} WITHOUT integrity verification (allowUnpinned).`,
        );
        return specifier;
    }

    const key = `${specifier}#${expectedSha256}`;
    let pending = cache.get(key);
    if (!pending) {
        pending = (async () => {
            const doFetch = opts.fetchFn ?? globalThis.fetch;
            if (typeof doFetch !== "function") {
                throw new Error(`${opts.label}: no fetch available to load ${specifier}`);
            }
            const res = await doFetch(specifier);
            if (!res.ok) {
                throw new Error(`${opts.label}: ${res.status} ${res.statusText} fetching ${specifier}`);
            }
            const bytes = new Uint8Array(await res.arrayBuffer());
            const actual = await sha256Hex(bytes);
            if (actual !== expectedSha256.toLowerCase()) {
                throw new CircuitIntegrityError(specifier, expectedSha256.toLowerCase(), actual);
            }
            return bytes;
        })().catch((err) => {
            cache.delete(key); // never cache a failure — let the next attempt retry
            throw err;
        });
        cache.set(key, pending);
    }
    return pending;
}

/** Drop the verified-artifact cache. Test seam. */
export function clearCircuitCache(): void {
    cache.clear();
}
