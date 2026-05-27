/**
 * HTTP client for the multi-user `SharedSpaceDO` (Phase B).
 *
 * Mirrors the proven shape of `PersonalSpaceClient` — every gated call:
 *   1. POSTs `/challenge` to get a fresh nonce keyed to the caller's commitment
 *   2. Generates a Groth16 proof for the `preimagePoK` circuit with the nonce
 *      reduced into a BN254 field element as the public signal
 *   3. POSTs the operation with `{ challengeId, proof, publicSignals, ... }`
 *
 * What's different from `PersonalSpaceClient`:
 *   - Addressed by space ID, not user commitment. Multiple users can be
 *     members of the same space.
 *   - The space carries a participants list + ACL (shared types from
 *     `src/types/permissions.ts`). The server checks that the proving
 *     commitment is a participant with the requested permission before each
 *     mutation.
 *   - Stores file manifests (not generic KV blobs). The shape is constrained
 *     by `FileManifest` from `../types`.
 *
 * Wire protocol (this client implements the client side; the server side is
 * the next slice of work in accelerator):
 *
 *   POST /api/spaces                                 create a new space (gated by caller proof)
 *     body: { challengeId, proof, publicSignals, initialAcl? }
 *     returns: { spaceId }
 *
 *   POST /api/spaces/:spaceId/challenge              issue a nonce for the caller
 *     body: { commitment }
 *     returns: { challengeId, nonce }
 *
 *   POST /api/spaces/:spaceId/files                  write a file manifest
 *     body: { challengeId, proof, publicSignals, manifest }
 *     returns: { ok: true, fileId }
 *
 *   POST /api/spaces/:spaceId/files/:fileId/get      read a file manifest
 *     body: { challengeId, proof, publicSignals }
 *     returns: { manifest }
 *
 *   DELETE /api/spaces/:spaceId/files/:fileId        delete a file manifest
 *     body: { challengeId, proof, publicSignals }
 *     returns: { ok: true, existed: boolean }
 *
 *   POST /api/spaces/:spaceId/files/list             list manifests in space
 *     body: { challengeId, proof, publicSignals }
 *     returns: { files: FileStat[] }
 *
 *   POST /api/spaces/:spaceId/participants           add a participant
 *     body: { challengeId, proof, publicSignals, participant: Participant }
 *     returns: { ok: true }
 *
 *   DELETE /api/spaces/:spaceId/participants/:commitment   remove a participant
 *     body: { challengeId, proof, publicSignals }
 *     returns: { ok: true, existed: boolean }
 *
 *   POST /api/spaces/:spaceId/acl                    set / replace an ACL entry
 *     body: { challengeId, proof, publicSignals, entry: ACLEntry }
 *     returns: { ok: true }
 */

import type { Groth16Proof } from "../../types/zk";
import type { ACLEntry, Participant } from "../../types/permissions";
import type { FileManifest, FileStat } from "../types";

// snarkjs is dynamically imported the first time a proof is needed. This keeps
// `SharedSpaceClient` cheap to import in environments that may not have it
// resolvable (e.g. unit tests that mock the space transport, or codepaths
// that only need read operations once those become snarkjs-free).
type SnarkjsModule = {
    groth16: {
        fullProve: (
            input: Record<string, string>,
            wasmUrl: string,
            zkeyUrl: string,
        ) => Promise<{ proof: unknown; publicSignals: string[] }>;
    };
};
let snarkjsModule: SnarkjsModule | null = null;
async function loadSnarkjs(): Promise<SnarkjsModule> {
    if (snarkjsModule) return snarkjsModule;
    snarkjsModule = (await import("snarkjs")) as unknown as SnarkjsModule;
    return snarkjsModule;
}

// BN254 scalar field modulus — same value used everywhere else in the ZK path.
const FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export interface SharedSpaceClientOptions {
    /** Base URL of the accelerator. */
    baseUrl: string;
    /** This caller's Poseidon commitment (decimal string). */
    commitment: string;
    /** Private witnesses for the `preimagePoK` circuit. */
    secret: string;
    salt: string;
    ecdsaPub: string;
    /** Public signal: Poseidon hash of `ecdsaPub`. */
    ecdsaPubHash: string;
    /** Compiled circuit assets — same files PersonalSpaceClient uses. */
    circuits: {
        wasmUrl: string;
        zkeyUrl: string;
    };
    /** Optional custom fetch (defaults to `globalThis.fetch`). */
    fetch?: typeof fetch;
}

interface ChallengeResponse {
    challengeId: string;
    nonce: string; // hex
}

interface GatedBody {
    challengeId: string;
    proof: Groth16Proof;
    publicSignals: string[];
    [k: string]: unknown;
}

export class SharedSpaceClient {
    private readonly baseUrl: string;
    private readonly commitment: string;
    private readonly secret: string;
    private readonly salt: string;
    private readonly ecdsaPub: string;
    private readonly ecdsaPubHash: string;
    private readonly wasmUrl: string;
    private readonly zkeyUrl: string;
    private readonly fetchFn: typeof fetch;

    constructor(opts: SharedSpaceClientOptions) {
        if (!opts?.baseUrl) throw new Error("SharedSpaceClient: `baseUrl` is required");
        if (!opts.commitment) throw new Error("SharedSpaceClient: `commitment` is required");
        if (!opts.secret) throw new Error("SharedSpaceClient: `secret` is required");
        if (!opts.salt) throw new Error("SharedSpaceClient: `salt` is required");
        if (!opts.ecdsaPub) throw new Error("SharedSpaceClient: `ecdsaPub` is required");
        if (!opts.ecdsaPubHash) throw new Error("SharedSpaceClient: `ecdsaPubHash` is required");
        if (!opts.circuits?.wasmUrl || !opts.circuits?.zkeyUrl) {
            throw new Error("SharedSpaceClient: `circuits.wasmUrl` and `circuits.zkeyUrl` are required");
        }
        this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
        this.commitment = opts.commitment;
        this.secret = opts.secret;
        this.salt = opts.salt;
        this.ecdsaPub = opts.ecdsaPub;
        this.ecdsaPubHash = opts.ecdsaPubHash;
        this.wasmUrl = opts.circuits.wasmUrl;
        this.zkeyUrl = opts.circuits.zkeyUrl;
        const f = opts.fetch ?? globalThis.fetch;
        if (typeof f !== "function") {
            throw new Error("SharedSpaceClient: `globalThis.fetch` is unavailable; pass an explicit fetch.");
        }
        this.fetchFn = f.bind(globalThis);
    }

    /**
     * Create a brand new space. The caller becomes the owner; `initialAcl`
     * adds any additional ACL entries up front (e.g. inviting a co-owner at
     * creation time).
     */
    async createSpace(initialAcl?: ACLEntry[]): Promise<{ spaceId: string }> {
        // Creating a space still requires the caller to prove they hold the
        // commitment they're claiming to own — that's what the proof
        // accomplishes here. The server issues a challenge against a global
        // "newspace" pseudo-id for the bootstrap step.
        const proof = await this.proveFreshChallenge("__new__");
        const body: GatedBody = { ...proof };
        if (initialAcl) body.initialAcl = initialAcl;
        const url = `${this.baseUrl}/api/spaces`;
        const response = await this.fetchFn(url, this.jsonRequest("POST", body));
        const data = await parseOrThrow<{ spaceId: string }>(response, "createSpace");
        return { spaceId: data.spaceId };
    }

    /** Write a file manifest into the space. Requires `write` permission. */
    async writeFileManifest(spaceId: string, manifest: FileManifest): Promise<void> {
        const proof = await this.proveFreshChallenge(spaceId);
        const body: GatedBody = { ...proof, manifest };
        const url = `${this.baseUrl}/api/spaces/${encodeURIComponent(spaceId)}/files`;
        const response = await this.fetchFn(url, this.jsonRequest("POST", body));
        await parseOrThrow<{ ok: true; fileId: string }>(response, `writeFileManifest(${manifest.id})`);
    }

    /** Read a file manifest by id. Requires `read` permission. */
    async readFileManifest(spaceId: string, fileId: string): Promise<FileManifest> {
        const proof = await this.proveFreshChallenge(spaceId);
        const body: GatedBody = { ...proof };
        const url = `${this.baseUrl}/api/spaces/${encodeURIComponent(spaceId)}/files/${encodeURIComponent(fileId)}/get`;
        const response = await this.fetchFn(url, this.jsonRequest("POST", body));
        const data = await parseOrThrow<{ manifest: FileManifest }>(response, `readFileManifest(${fileId})`);
        return data.manifest;
    }

    /** Delete a file manifest by id. Requires `delete` permission. */
    async deleteFileManifest(spaceId: string, fileId: string): Promise<boolean> {
        const proof = await this.proveFreshChallenge(spaceId);
        const body: GatedBody = { ...proof };
        const url = `${this.baseUrl}/api/spaces/${encodeURIComponent(spaceId)}/files/${encodeURIComponent(fileId)}`;
        const response = await this.fetchFn(url, this.jsonRequest("DELETE", body));
        const data = await parseOrThrow<{ ok: true; existed: boolean }>(response, `deleteFileManifest(${fileId})`);
        return data.existed;
    }

    /** List file summaries in the space. Requires `read` permission. */
    async listFiles(spaceId: string): Promise<FileStat[]> {
        const proof = await this.proveFreshChallenge(spaceId);
        const body: GatedBody = { ...proof };
        const url = `${this.baseUrl}/api/spaces/${encodeURIComponent(spaceId)}/files/list`;
        const response = await this.fetchFn(url, this.jsonRequest("POST", body));
        const data = await parseOrThrow<{ files: FileStat[] }>(response, "listFiles");
        return Array.isArray(data.files) ? data.files : [];
    }

    /** Add a participant. Requires `invite` or `admin`. */
    async addParticipant(spaceId: string, participant: Participant): Promise<void> {
        const proof = await this.proveFreshChallenge(spaceId);
        const body: GatedBody = { ...proof, participant };
        const url = `${this.baseUrl}/api/spaces/${encodeURIComponent(spaceId)}/participants`;
        const response = await this.fetchFn(url, this.jsonRequest("POST", body));
        await parseOrThrow<{ ok: true }>(response, "addParticipant");
    }

    /** Remove a participant by their public-key identity. Requires `admin`. */
    async removeParticipant(spaceId: string, participantCommitment: string): Promise<boolean> {
        const proof = await this.proveFreshChallenge(spaceId);
        const body: GatedBody = { ...proof };
        const url = `${this.baseUrl}/api/spaces/${encodeURIComponent(spaceId)}/participants/${encodeURIComponent(participantCommitment)}`;
        const response = await this.fetchFn(url, this.jsonRequest("DELETE", body));
        const data = await parseOrThrow<{ ok: true; existed: boolean }>(response, "removeParticipant");
        return data.existed;
    }

    /** Set / replace an ACL entry. Requires `admin`. */
    async setACLEntry(spaceId: string, entry: ACLEntry): Promise<void> {
        const proof = await this.proveFreshChallenge(spaceId);
        const body: GatedBody = { ...proof, entry };
        const url = `${this.baseUrl}/api/spaces/${encodeURIComponent(spaceId)}/acl`;
        const response = await this.fetchFn(url, this.jsonRequest("POST", body));
        await parseOrThrow<{ ok: true }>(response, "setACLEntry");
    }

    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------

    /** Request a challenge for `spaceId` and generate the matching proof. */
    private async proveFreshChallenge(spaceId: string): Promise<GatedBody> {
        const challenge = await this.requestChallenge(spaceId);
        const nonceField = nonceHexToFieldString(challenge.nonce);

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

    /**
     * Hit `/challenge`. The body includes the caller's commitment so the
     * server can scope the issued nonce to this principal.
     */
    private async requestChallenge(spaceId: string): Promise<ChallengeResponse> {
        const url = `${this.baseUrl}/api/spaces/${encodeURIComponent(spaceId)}/challenge`;
        const response = await this.fetchFn(url, this.jsonRequest("POST", { commitment: this.commitment }));
        return await parseOrThrow<ChallengeResponse>(response, "challenge");
    }

    private jsonRequest(method: string, body: unknown): RequestInit {
        return {
            method,
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body ?? {}),
        };
    }
}

function nonceHexToFieldString(nonceHex: string): string {
    const hex = nonceHex.startsWith("0x") ? nonceHex : "0x" + nonceHex;
    return (BigInt(hex) % FIELD_SIZE).toString();
}

async function parseOrThrow<T>(response: Response, label: string): Promise<T> {
    if (!response.ok) {
        let detail = "";
        try {
            const text = await response.text();
            detail = text ? `: ${text}` : "";
        } catch {
            // ignore — we still throw with the status
        }
        throw new Error(`SharedSpaceClient ${label} failed (${response.status})${detail}`);
    }
    return (await response.json()) as T;
}
