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

/** A vault factor record (M1.0 + M2 gated types). Wrap/iv are base64 AES-GCM; absent for phrase. */
export interface VaultFactor {
    id: string;
    type: "password" | "passkey" | "phrase-marker" | "email" | "google";
    wrap?: string;
    iv?: string;
    params?: Record<string, unknown>;
    label?: string;
    createdAt?: number;
    /** Display hint for gated factors ("m•••@gmail.com") — list responses only. */
    masked?: string;
    /** Passkey's origin (RP id) — list responses only. A passkey only unlocks
     *  from this host or a subdomain of it, so apps on several hosts enroll one
     *  per origin. */
    rpId?: string;
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

    // ---- Identity vault (M1.0) ----------------------------------------------

    /** Blinded OPRF evaluation — the server-gated half of a password/recovery wrap key. */
    async oprfEvaluate(username: string, blinded: string): Promise<{ evaluated: string }> {
        const res = await this.fetchFn(`${this.baseUrl}/api/auth/oprf`, this.json("POST", { username, blinded }));
        return await this.parse<{ evaluated: string }>("oprfEvaluate", res);
    }

    /**
     * Gated split-key OPRF evaluation (M2 — email/google factors). Requires a
     * live `verifyToken` from {@link emailOtpVerify}; returns BOTH trust
     * domains' evaluations. The recover token is consumed by this call.
     */
    async oprfEvaluateGated(
        username: string,
        blinded: string,
        factorType: "email" | "google",
        purpose: "enroll" | "recover",
        verifyToken: string,
    ): Promise<{ evaluated: string; evaluated2: string }> {
        const res = await this.fetchFn(
            `${this.baseUrl}/api/auth/oprf`,
            this.json("POST", { username, blinded, factorType, purpose, verifyToken }),
        );
        return await this.parse<{ evaluated: string; evaluated2: string }>("oprfEvaluateGated", res);
    }

    /**
     * Request an email OTP. With a session `token` this is the ENROLL flow
     * (code sent to `email`); without one it's RECOVER (code sent to the
     * account's enrolled address — the response is uniform either way).
     */
    async emailOtpStart(opts: { token?: string; email?: string; username?: string }): Promise<void> {
        const init = this.json("POST", { email: opts.email, username: opts.username });
        if (opts.token) (init.headers as Record<string, string>)["X-Muhkoo-Session"] = opts.token;
        const res = await this.fetchFn(`${this.baseUrl}/api/auth/email/start`, init);
        await this.parse<{ sent: boolean }>("emailOtpStart", res);
    }

    /** Trade an emailed code for a single-use verifyToken (+ the proven address). */
    async emailOtpVerify(opts: { code: string; token?: string; username?: string }): Promise<{ verifyToken: string; email: string }> {
        const init = this.json("POST", { code: opts.code, username: opts.username });
        if (opts.token) (init.headers as Record<string, string>)["X-Muhkoo-Session"] = opts.token;
        const res = await this.fetchFn(`${this.baseUrl}/api/auth/email/verify`, init);
        return await this.parse<{ verifyToken: string; email: string }>("emailOtpVerify", res);
    }

    /**
     * Verify a Google ID token (M2.3). With a session `token` it's the ENROLL
     * gate; without, it's RECOVER/LOGIN (the Google account must already be
     * linked). Returns a single-use verifyToken bound to the account's `sub`.
     */
    async googleVerify(opts: { idToken: string; token?: string; username?: string }): Promise<{ verifyToken: string; sub: string; emailHint: string | null }> {
        const init = this.json("POST", { idToken: opts.idToken, username: opts.username });
        if (opts.token) (init.headers as Record<string, string>)["X-Muhkoo-Session"] = opts.token;
        const res = await this.fetchFn(`${this.baseUrl}/api/auth/google/verify`, init);
        return await this.parse<{ verifyToken: string; sub: string; emailHint: string | null }>("googleVerify", res);
    }

    // ---- Hosted-auth authorization-code flow (H0) ---------------------------

    /** Mint a single-use authorization code for an app (called by the hosted page; session-authed). */
    async grant(token: string, body: { appId: string; redirectUri: string; codeChallenge: string; sealedKeys: string }): Promise<{ code: string }> {
        const init = this.json("POST", body);
        (init.headers as Record<string, string>)["X-Muhkoo-Session"] = token;
        const res = await this.fetchFn(`${this.baseUrl}/api/auth/grant`, init);
        return await this.parse<{ code: string }>("grant", res);
    }

    /** Exchange an authorization code + PKCE verifier for the session + sealed key material. */
    async token(body: { code: string; codeVerifier: string; appId?: string }): Promise<{ sessionToken: string; username: string; commitment: string; sealedKeys: string; appId: string }> {
        const res = await this.fetchFn(`${this.baseUrl}/api/auth/token`, this.json("POST", body));
        return await this.parse<{ sessionToken: string; username: string; commitment: string; sealedKeys: string; appId: string }>("token", res);
    }

    /**
     * Read a factor record for `username` (returns an indistinguishable decoy if
     * absent). Gated types (email) require the recover `verifyToken`.
     */
    async vaultRead(
        username: string,
        factorType: VaultFactor["type"],
        verifyToken?: string,
        /** Passkeys are per-origin: naming the caller's host returns THAT origin's
         *  passkey instead of whichever was enrolled first (which WebAuthn would
         *  refuse). Ignored for other factor types. */
        rpId?: string,
    ): Promise<{ factor: VaultFactor | null }> {
        const res = await this.fetchFn(`${this.baseUrl}/api/auth/vault`, this.json("POST", { username, factorType, verifyToken, rpId }));
        return await this.parse<{ factor: VaultFactor | null }>("vaultRead", res);
    }

    /**
     * Add/replace a factor (session-authed; the seed is already wrapped
     * client-side). Email factors additionally require (and consume) the
     * enroll `verifyToken`; the stored address must be the verified one.
     */
    async vaultPutFactor(token: string, factor: VaultFactor, verifyToken?: string): Promise<{ ok: boolean; id: string }> {
        const init = this.json("PUT", { factor, verifyToken });
        (init.headers as Record<string, string>)["Authorization"] = `Bearer ${token}`;
        const res = await this.fetchFn(`${this.baseUrl}/api/auth/vault/factor`, init);
        return await this.parse<{ ok: boolean; id: string }>("vaultPutFactor", res);
    }

    /** List the user's factor metadata (no ciphertext). Session-authed. */
    async vaultFactors(token: string): Promise<{ factors: VaultFactor[]; migrated: boolean }> {
        const init: RequestInit = { method: "GET", headers: { Authorization: `Bearer ${token}` } };
        const res = await this.fetchFn(`${this.baseUrl}/api/auth/vault/factors`, init);
        return await this.parse<{ factors: VaultFactor[]; migrated: boolean }>("vaultFactors", res);
    }

    /** Remove a factor by id (can't remove the last one). Session-authed. */
    async vaultDeleteFactor(token: string, id: string): Promise<{ deleted: boolean }> {
        const res = await this.fetchFn(`${this.baseUrl}/api/auth/vault/factor`, {
            method: "DELETE",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ id }),
        });
        return await this.parse<{ deleted: boolean }>("vaultDeleteFactor", res);
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
