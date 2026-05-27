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
import * as snarkjs from "snarkjs";

import type { Groth16Proof } from "../types/zk";
import { poseidonHash } from "./poseidon";

export type { Groth16Proof };

export interface CircuitUrls {
    /** preimagePoK.wasm — the circuit's witness generator. */
    wasmUrl: string;
    /** preimagePoK_0001.zkey — the proving key. */
    zkeyUrl: string;
}

/** BN254 scalar field modulus — the prime the circuit's signals live in. */
const FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/**
 * Reduce any hex/decimal/byte input to a decimal-string field element in
 * `[0, FIELD_SIZE)`. snarkjs and the `preimagePoK` circuit both want decimal
 * strings; everything else gets normalized here.
 */
export function toField(value: string | bigint | number): string {
    let v: bigint;
    if (typeof value === "bigint") v = value;
    else if (typeof value === "number") v = BigInt(value);
    else if (value.startsWith("0x")) v = BigInt(value);
    else if (/^[0-9a-fA-F]+$/.test(value) && value.length >= 32 && /[a-fA-F]/.test(value)) {
        // Looks like raw hex without prefix — most common case for our inputs.
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
