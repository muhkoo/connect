/**
 * Poseidon hash wrapper used by the ZK auth flow.
 *
 * Backed by `circomlibjs`'s `buildPoseidon`. Builder is lazy and cached
 * because the JS-side Babyjubjub field reps take ~100ms to construct, and
 * we'd rather not pay that on every page load.
 *
 * Returns hashes as decimal-string BigInts — same format snarkjs and the
 * `preimagePoK` circuit expect for inputs.
 *
 * Note: circomlibjs is `optionalDependencies` in connect's package.json.
 * Consumers that use the ZK auth flow (browser/server, not workers) need
 * it installed. The workers build does not import this module.
 */

import { buildPoseidon } from "circomlibjs";

type PoseidonF = { toString(val: unknown): string };
type PoseidonFn = ((inputs: Array<bigint | string | number>) => unknown) & { F: PoseidonF };

let _poseidon: PoseidonFn | null = null;
let _loadPromise: Promise<PoseidonFn> | null = null;

async function loadPoseidon(): Promise<PoseidonFn> {
    if (_poseidon) return _poseidon;
    if (_loadPromise) return _loadPromise;
    _loadPromise = (async () => {
        const fn = (await buildPoseidon()) as unknown as PoseidonFn;
        _poseidon = fn;
        return fn;
    })();
    return _loadPromise;
}

/**
 * Poseidon-hash `inputs` and return the result as a decimal-string BigInt.
 * Inputs are converted to BigInt — pass either bigints, numbers, or numeric
 * strings.
 */
export async function poseidonHash(
    inputs: Array<bigint | string | number>,
): Promise<string> {
    const p = await loadPoseidon();
    const bigInputs = inputs.map((i) => {
        if (typeof i === "bigint") return i;
        if (typeof i === "string") return BigInt(i);
        return BigInt(i);
    });
    const hash = p(bigInputs);
    return p.F.toString(hash);
}
