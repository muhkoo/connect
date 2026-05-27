/**
 * HTTP client for the accelerator's `/api/auth/*` endpoints.
 *
 * Owns the wire shapes for register / challenge / authenticate / verify so
 * the React SPA (and any future consumers) don't reimplement them. The ZK
 * identity derivation + Groth16 proof generation stay on the application
 * side — this client handles only the round-trips.
 *
 * Mirrors `PersonalSpaceClient` / `ShardClient` / `SharedSpaceClient`: takes
 * a `baseUrl`, optional custom `fetch`, throws typed `Error`s on failure
 * (with the worker's message inlined where available).
 */

import type { Groth16Proof } from "../types/zk";

// ---------------------------------------------------------------------------
// Wire types — must stay in sync with `accelerator/src/durable-objects/UserAuth.ts`.
// ---------------------------------------------------------------------------

export interface ZkRegisterRequest {
    username: string;
    /** Decimal-string Poseidon commitment. */
    commitment: string;
    /** Base64-encoded raw uncompressed ECDH public key (SEC1 0x04‖X‖Y). */
    ecdhPublicKey: string;
    /** Base64-encoded raw uncompressed ECDSA public key. */
    ecdsaPublicKey: string;
    email?: string | null;
}

export interface ZkRegisterResponse {
    success: boolean;
}

export interface ZkChallengeResponse {
    challengeId: string;
    /** Hex-encoded random nonce — caller reduces into a BN254 field element for the proof. */
    nonce: string;
    /** Decimal-string Poseidon commitment the server has on file for this user. */
    commitment: string;
}

export interface ZkAuthenticateRequest {
    challengeId: string;
    proof: {
        commitment: string;
        /** Original hex nonce from the challenge (NOT the field-reduced version). */
        nonce: string;
        response: {
            proof: Groth16Proof;
            publicSignals: string[];
        };
        /** Base64 ECDSA-SHA256 signature over `JSON.stringify(response.proof)`. */
        signature: string;
    };
    rememberMe?: boolean;
}

export interface AuthSuccess {
    token: string;
    username: string;
}

// ---------------------------------------------------------------------------
// AuthClient
// ---------------------------------------------------------------------------

export interface AuthClientOptions {
    /** Absolute URL of the accelerator worker (no trailing slash required). */
    baseUrl: string;
    /** Optional custom fetch — defaults to `globalThis.fetch`. */
    fetch?: typeof fetch;
}

export class AuthClient {
    private readonly baseUrl: string;
    private readonly fetchFn: typeof fetch;

    constructor(opts: AuthClientOptions) {
        if (!opts?.baseUrl) throw new Error("AuthClient: `baseUrl` is required");
        this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
        const f = opts.fetch ?? globalThis.fetch;
        if (typeof f !== "function") {
            throw new Error("AuthClient: `globalThis.fetch` is unavailable; pass an explicit fetch.");
        }
        this.fetchFn = f.bind(globalThis);
    }

    /** Submit ZK registration. Caller has already derived the identity + commitment. */
    async register(req: ZkRegisterRequest): Promise<ZkRegisterResponse> {
        const res = await this.fetchFn(`${this.baseUrl}/api/auth/zk-register`, this.json("POST", req));
        return await this.parse<ZkRegisterResponse>("register", res);
    }

    /** Request an auth challenge for `username` (server issues a fresh nonce). */
    async getChallenge(username: string): Promise<ZkChallengeResponse> {
        const res = await this.fetchFn(`${this.baseUrl}/api/auth/challenge`, this.json("POST", { username }));
        return await this.parse<ZkChallengeResponse>("getChallenge", res);
    }

    /** Trade a challenge + proof for a session token. */
    async authenticate(req: ZkAuthenticateRequest): Promise<AuthSuccess> {
        const res = await this.fetchFn(`${this.baseUrl}/api/auth/zk-authenticate`, this.json("POST", req));
        return await this.parse<AuthSuccess>("authenticate", res);
    }

    /**
     * Validate a previously stored session token. Returns `{ username }` on
     * success; throws on 401/404 — caller uses that to drop a stale token
     * when restoring a session after a reload.
     */
    async verify(token: string): Promise<{ username: string }> {
        const res = await this.fetchFn(`${this.baseUrl}/api/auth/verify`, this.json("POST", { token }));
        return await this.parse<{ username: string }>("verify", res);
    }

    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------

    private json(method: string, body: unknown): RequestInit {
        return {
            method,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        };
    }

    private async parse<T>(label: string, res: Response): Promise<T> {
        let body: unknown = null;
        try {
            body = await res.json();
        } catch {
            // Leave body null; we'll fall through to the status-only message.
        }
        if (!res.ok) {
            const msg =
                body && typeof body === "object" && "error" in (body as object)
                    ? String((body as { error: unknown }).error)
                    : `${res.status} ${res.statusText}`;
            throw new Error(`AuthClient.${label}: ${msg}`);
        }
        return body as T;
    }
}

export default AuthClient;
