/**
 * Groth16 proof generation for the `preimagePoK` circuit.
 *
 * The circuit proves knowledge of `(secret, salt, ecdsaPub)` such that
 *   commitment = Poseidon(secret, salt, Poseidon(ecdsaPub))
 * while only revealing `(commitment, nonce, ecdsaPubHash)` as public signals.
 *
 * Circuit assets (wasm + zkey) are served by the accelerator worker. Their
 * URLs are a required argument of {@link generateAuthProof} — there is no
 * default. The web app constructs them relative to its configured worker
 * `baseUrl` so the SPA can target either the local wrangler dev or a deployed
 * worker depending on `VITE_WORKER_URL`.
 */

// snarkjs has no TypeScript types in the npm package — the shared shim in
// `types/snarkjs.d.ts` (already present for ZeroKnowledge.ts) covers the
// `groth16.fullProve` call we need here too.
//
// Imported lazily (dynamic `import`) rather than at module top-level: snarkjs
// is an externalized peer dependency that only the ZK login proof path needs.
// Loading it eagerly would force every consumer of the SDK — and the test
// runner — to have snarkjs resolvable just to construct a `Client`. The lazy
// loader defers that cost until `generateAuthProof` actually runs.
import type { Groth16Proof } from "../types/zk";
import { poseidonHash } from "./poseidon";

type Snarkjs = {
    groth16: {
        fullProve: (
            input: unknown,
            wasm: string,
            zkey: string,
        ) => Promise<{ proof: unknown; publicSignals: string[] }>;
    };
};
let _snarkjs: Snarkjs | null = null;
async function loadSnarkjs(): Promise<Snarkjs> {
    if (_snarkjs) return _snarkjs;
    _snarkjs = (await import("snarkjs")) as unknown as Snarkjs;
    return _snarkjs;
}

export type { Groth16Proof };

export interface CircuitUrls {
    /** preimagePoK.wasm — the circuit's witness generator. */
    wasmUrl: string;
    /** preimagePoK_0001.zkey — the proving key. */
    zkeyUrl: string;
}

/**
 * Canonical {@link CircuitUrls} for the `preimagePoK` login circuit, anchored
 * at a base URL where the accelerator serves the circuit assets out of
 * `circuits/build/`. The filenames here are fixed by the circom build output
 * (the witness generator lands inside a `preimagePoK_js/` directory); callers
 * shouldn't hard-code them. `Client` uses this to default its `circuits`
 * option, and `PersonalSpaceClient` consumers can pass `defaultCircuitUrls(baseUrl)`.
 */
export function defaultCircuitUrls(baseUrl: string): CircuitUrls {
    const base = baseUrl.replace(/\/+$/, "");
    return {
        wasmUrl: `${base}/circuits/build/preimagePoK_js/preimagePoK.wasm`,
        zkeyUrl: `${base}/circuits/build/preimagePoK_0001.zkey`,
    };
}

/** BN254 scalar field modulus — the prime the circuit's signals live in. */
const FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/**
 * Reduce any hex/decimal/byte input to a decimal-string field element in
 * `[0, FIELD_SIZE)`. snarkjs and the `preimagePoK` circuit both want decimal
 * strings; everything else gets normalized here.
 *
 * **Behavior is intentionally byte-for-byte compatible with the legacy
 * `accelerator/public/js/zk-snarkjs-client.js#toField`.** Diverging produces
 * different commitments than accounts registered via the legacy flow,
 * which locks those users out forever — the worker stores whatever
 * commitment the client sent at register time and compares it as a string
 * at login time.
 *
 * In particular: a 32+ char string of hex chars is always treated as hex,
 * even if every character happens to be 0-9 with no a-f letters. An
 * earlier version of this function gated the hex branch on "has at least
 * one letter" — that broke the digit-only-hex edge case (rare in practice,
 * but real). DO NOT add that letter check back.
 */
export function toField(value: string | bigint | number): string {
    let v: bigint;
    if (typeof value === "bigint") v = value;
    else if (typeof value === "number") v = BigInt(value);
    else if (value.startsWith("0x")) v = BigInt(value);
    else if (/^[0-9a-fA-F]+$/.test(value) && value.length >= 32) {
        // Raw hex without prefix — secret, salt, ecdsaPub, nonce all hit this.
        v = BigInt("0x" + value);
    } else if (/^[0-9]+$/.test(value)) v = BigInt(value);
    else {
        // Treat any other string as utf-8 bytes — matches the legacy client.
        const bytes = new TextEncoder().encode(value);
        let hex = "";
        for (const b of bytes) hex += b.toString(16).padStart(2, "0");
        v = BigInt("0x" + hex);
    }
    v = v % FIELD_SIZE;
    if (v < 0n) v += FIELD_SIZE;
    return v.toString();
}

/**
 * Build the user's Poseidon commitment binding `(secret, salt, ecdsaPubHash)`.
 * Same formula the worker verifies against on register and authenticate.
 */
export async function buildCommitment(
    secretHex: string,
    saltHex: string,
    ecdsaPubHex: string,
): Promise<string> {
    const secretField = toField(secretHex);
    const saltField = toField(saltHex);
    const ecdsaPubField = toField(ecdsaPubHex);
    const ecdsaPubHash = await poseidonHash([ecdsaPubField]);
    return await poseidonHash([secretField, saltField, ecdsaPubHash]);
}

/**
 * Generate a Groth16 proof for the `preimagePoK` circuit. Public signals end
 * up `[commitment, nonce, ecdsaPubHash]` — the worker checks the commitment
 * matches the stored one and the nonce matches the issued challenge nonce
 * reduced into the field.
 *
 * Throws if circuit URLs are unreachable or snarkjs decides the inputs are
 * malformed.
 */
export async function generateAuthProof(args: {
    secretHex: string;
    saltHex: string;
    ecdsaPubHex: string;
    nonceHex: string;
    /** Required — caller supplies URLs scoped to the worker they want to talk to. */
    circuits: CircuitUrls;
}): Promise<{
    proof: Groth16Proof;
    publicSignals: string[];
    commitment: string;
    nonceField: string;
    ecdsaPubHash: string;
}> {
    const secretField = toField(args.secretHex);
    const saltField = toField(args.saltHex);
    const ecdsaPubField = toField(args.ecdsaPubHex);
    const nonceField = toField(args.nonceHex);

    const ecdsaPubHash = await poseidonHash([ecdsaPubField]);
    const commitment = await poseidonHash([secretField, saltField, ecdsaPubHash]);

    const circuitInput: Record<string, string> = {
        // Public inputs (must appear in the same order the circuit declares).
        commitment,
        nonce: nonceField,
        ecdsaPubHash,
        // Private witnesses.
        secret: secretField,
        salt: saltField,
        ecdsaPub: ecdsaPubField,
    };

    const snarkjs = await loadSnarkjs();
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
        circuitInput,
        args.circuits.wasmUrl,
        args.circuits.zkeyUrl,
    );

    return {
        proof: proof as Groth16Proof,
        publicSignals,
        commitment,
        nonceField,
        ecdsaPubHash,
    };
}
