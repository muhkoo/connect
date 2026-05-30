/**
 * `PersonalSpaceClient` — the client-side counterpart to the accelerator's
 * `PersonalSpaceDO`. Wraps the `/api/personal/:commitment/*` HTTP protocol so
 * callers can `put` / `get` / `delete` / `list` per-user KV blobs without
 * thinking about challenges, nonces, or Groth16 proof generation.
 *
 * Every gated operation:
 *   1. Requests a one-shot challenge from the DO (`POST /challenge`).
 *   2. Converts the returned hex nonce into a BN254 field element.
 *   3. Generates a fresh Groth16 proof for the `preimagePoK` circuit using
 *      snarkjs, with the user's secret/salt/ecdsaPub as private inputs and
 *      `{commitment, nonce, ecdsaPubHash}` as public signals.
 *   4. POSTs the proof + publicSignals + (optional) value to the gated endpoint.
 *
 * snarkjs is loaded lazily (dynamic `import`) the first time a proof is
 * generated — it's an optional peer dependency that only the ZK-proof path
 * needs, so importing this module (or constructing a `Client`) never requires
 * it. Consumers using the proof path install `snarkjs`, or provide it via an
 * import map in the browser (see the README).
 *
 * Encryption of the stored values is the caller's responsibility — the DO
 * sees only opaque JSON. The companion `wrap.ts` helpers in this folder are
 * a convenient way to passphrase-encrypt a payload before putting it.
 */

import type { Groth16Proof } from "../types/zk";

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

/**
 * BN254 scalar field modulus. The DO's challenge endpoint returns a 32-byte
 * random hex nonce — but the Circom circuit expects a field element, so the
 * nonce is reduced mod this prime before being fed into the witness.
 *
 * Must stay in sync with the `nonce` public-signal width used by both
 * accelerator's `verifyZkAuthProof` and the `preimagePoK` circuit.
 */
const FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/**
 * Constructor options for {@link PersonalSpaceClient}.
 *
 * All of `secret`, `salt`, `ecdsaPub`, and `ecdsaPubHash` are decimal-encoded
 * BigInt strings (snarkjs convention). `commitment` is likewise decimal — it's
 * the Poseidon hash of `(secret, salt, ecdsaPubHash)`.
 */
export interface PersonalSpaceClientOptions {
    /** Base URL of the accelerator, e.g. `http://localhost:8787`. */
    baseUrl: string;
    /** The user's Poseidon commitment as a decimal string (~78 digits). */
    commitment: string;
    /** ZK identity material — private inputs to the proof. Decimal BigInt string. */
    secret: string;
    /** ZK identity salt. Decimal BigInt string. */
    salt: string;
    /** Raw ECDSA public-key field representation. Decimal BigInt string. */
    ecdsaPub: string;
    /** Poseidon hash of `ecdsaPub`, used as a public signal. Decimal BigInt string. */
    ecdsaPubHash: string;
    /** Where the runtime can fetch the compiled circuit assets. */
    circuits: {
        /** URL of the `preimagePoK.wasm` witness generator. */
        wasmUrl: string;
        /** URL of the `preimagePoK_0001.zkey` proving key. */
        zkeyUrl: string;
    };
}

/** Shape of the DO's `/challenge` response. */
interface ChallengeResponse {
    challengeId: string;
    nonce: string;       // hex
    commitment: string;
}

/** Body shape sent to every gated endpoint. `value` is only used by PUT. */
interface GatedBody {
    challengeId: string;
    proof: Groth16Proof;
    publicSignals: string[];
    value?: unknown;
}

/**
 * Reduce a hex nonce into a BN254 field-element decimal string, matching what
 * the Circom circuit expects as the `nonce` public signal.
 */
function nonceHexToFieldString(nonceHex: string): string {
    const hex = nonceHex.startsWith("0x") ? nonceHex : "0x" + nonceHex;
    return (BigInt(hex) % FIELD_SIZE).toString();
}

/**
 * Read the response body as JSON, falling back to text for the error message
 * when the body isn't JSON. Centralized so every method handles failures the
 * same way.
 */
async function parseOrThrow<T>(response: Response, label: string): Promise<T> {
    if (!response.ok) {
        let detail = "";
        try {
            const text = await response.text();
            detail = text ? `: ${text}` : "";
        } catch {
            // ignore — we'll just use the status code
        }
        throw new Error(`PersonalSpaceClient ${label} failed (${response.status})${detail}`);
    }
    return (await response.json()) as T;
}

export class PersonalSpaceClient {
    private readonly baseUrl: string;
    private readonly commitment: string;
    private readonly secret: string;
    private readonly salt: string;
    private readonly ecdsaPub: string;
    private readonly ecdsaPubHash: string;
    private readonly wasmUrl: string;
    private readonly zkeyUrl: string;

    constructor(opts: PersonalSpaceClientOptions) {
        if (!opts.baseUrl) throw new Error("PersonalSpaceClient: `baseUrl` is required");
        if (!opts.commitment) throw new Error("PersonalSpaceClient: `commitment` is required");
        if (!opts.secret) throw new Error("PersonalSpaceClient: `secret` is required");
        if (!opts.salt) throw new Error("PersonalSpaceClient: `salt` is required");
        if (!opts.ecdsaPub) throw new Error("PersonalSpaceClient: `ecdsaPub` is required");
        if (!opts.ecdsaPubHash) throw new Error("PersonalSpaceClient: `ecdsaPubHash` is required");
        if (!opts.circuits?.wasmUrl || !opts.circuits?.zkeyUrl) {
            throw new Error("PersonalSpaceClient: `circuits.wasmUrl` and `circuits.zkeyUrl` are required");
        }

        // Strip trailing slash so concatenation stays clean regardless of how
        // the caller formatted the base URL.
        this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
        this.commitment = opts.commitment;
        this.secret = opts.secret;
        this.salt = opts.salt;
        this.ecdsaPub = opts.ecdsaPub;
        this.ecdsaPubHash = opts.ecdsaPubHash;
        this.wasmUrl = opts.circuits.wasmUrl;
        this.zkeyUrl = opts.circuits.zkeyUrl;
    }

    /** Store `value` under `key`, replacing any prior value. */
    async put(key: string, value: unknown): Promise<void> {
        const { challengeId, proof, publicSignals } = await this.proveFreshChallenge();
        const url = `${this.baseUrl}/api/personal/${encodeURIComponent(this.commitment)}/kv/${encodeURIComponent(key)}`;
        const body: GatedBody = { challengeId, proof, publicSignals, value };
        const response = await this.fetch(url, "POST", body);
        await parseOrThrow<{ ok: true }>(response, `put(${key})`);
    }

    /** Fetch the value stored under `key`. Returns `null` if absent. */
    async get<T = unknown>(key: string): Promise<T | null> {
        const { challengeId, proof, publicSignals } = await this.proveFreshChallenge();
        const url = `${this.baseUrl}/api/personal/${encodeURIComponent(this.commitment)}/kv/${encodeURIComponent(key)}/get`;
        const body: GatedBody = { challengeId, proof, publicSignals };
        const response = await this.fetch(url, "POST", body);
        const data = await parseOrThrow<{ key: string; value: T | null }>(response, `get(${key})`);
        return data.value ?? null;
    }

    /** Remove `key` from the user's space. Returns whether the key existed. */
    async delete(key: string): Promise<boolean> {
        const { challengeId, proof, publicSignals } = await this.proveFreshChallenge();
        const url = `${this.baseUrl}/api/personal/${encodeURIComponent(this.commitment)}/kv/${encodeURIComponent(key)}`;
        const body: GatedBody = { challengeId, proof, publicSignals };
        const response = await this.fetch(url, "DELETE", body);
        const data = await parseOrThrow<{ ok: true; existed: boolean }>(response, `delete(${key})`);
        return data.existed;
    }

    /** List every key currently stored in the user's space. */
    async list(): Promise<string[]> {
        const { challengeId, proof, publicSignals } = await this.proveFreshChallenge();
        const url = `${this.baseUrl}/api/personal/${encodeURIComponent(this.commitment)}/list`;
        const body: GatedBody = { challengeId, proof, publicSignals };
        const response = await this.fetch(url, "POST", body);
        const data = await parseOrThrow<{ keys: string[] }>(response, "list()");
        return Array.isArray(data.keys) ? data.keys : [];
    }

    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------

    /**
     * Run the full pre-flight: ask the DO for a challenge, reduce the nonce to
     * a field element, and generate a fresh Groth16 proof. Returns everything
     * the gated endpoints need in their body.
     */
    private async proveFreshChallenge(): Promise<{
        challengeId: string;
        proof: Groth16Proof;
        publicSignals: string[];
    }> {
        const challenge = await this.requestChallenge();
        const nonceField = nonceHexToFieldString(challenge.nonce);

        // Inputs to the `preimagePoK` circuit. Public signals are
        // `[commitment, nonce, ecdsaPubHash]`; the rest are private witnesses.
        const input = {
            commitment: this.commitment,
            nonce: nonceField,
            ecdsaPubHash: this.ecdsaPubHash,
            secret: this.secret,
            salt: this.salt,
            ecdsaPub: this.ecdsaPub,
        };

        const snarkjs = await loadSnarkjs();
        const { proof, publicSignals } = await snarkjs.groth16.fullProve(
            input,
            this.wasmUrl,
            this.zkeyUrl,
        );

        return {
            challengeId: challenge.challengeId,
            proof: proof as unknown as Groth16Proof,
            publicSignals: publicSignals as string[],
        };
    }

    /** Hit `POST /challenge` and return the issued nonce + ID. */
    private async requestChallenge(): Promise<ChallengeResponse> {
        const url = `${this.baseUrl}/api/personal/${encodeURIComponent(this.commitment)}/challenge`;
        const response = await this.fetch(url, "POST", {});
        return await parseOrThrow<ChallengeResponse>(response, "challenge");
    }

    /**
     * Thin wrapper over `globalThis.fetch` so all methods share a single set of
     * headers and body-encoding behaviour. `globalThis.fetch` is available in
     * modern browsers, Node 18+, Workers, and Bun.
     */
    private async fetch(url: string, method: string, body: unknown): Promise<Response> {
        const fetchFn = globalThis.fetch;
        if (typeof fetchFn !== "function") {
            throw new Error(
                "PersonalSpaceClient: `globalThis.fetch` is not available. " +
                "On older Node versions, install a fetch polyfill (e.g. undici).",
            );
        }
        return await fetchFn(url, {
            method,
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body ?? {}),
        });
    }
}
