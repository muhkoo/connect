/**
 * `client.accessTokens` — manage an app's **access tokens**: scoped, expiring,
 * non-ZK machine-to-machine credentials (`mk_<env>_at_…`).
 *
 *   const { plaintext } = await client.accessTokens.create(appId, {
 *     scopes: ["db:read", "db:write"], env: "live", expiresInDays: 30,
 *     label: "ci-runner",
 *   });
 *   // hand `plaintext` to the machine caller as its ClientOptions.accessToken
 *
 * These are MANAGEMENT calls — creating/listing/revoking tokens is authorized by
 * the developer session (same as the `agents`/`functions` namespaces). The token
 * itself resolves through the SAME accelerator path as an app key (the
 * `X-Muhkoo-Key` header), but is scoped to a fixed vocabulary of permissions and
 * expires. The plaintext is returned ONCE, on create — store it then; it can't
 * be read back.
 */

import type { HttpClient } from "../HttpClient";

/** The fixed vocabulary of permissions an access token can be granted. */
export type Scope =
    | "db:read"
    | "db:write"
    | "kv:read"
    | "kv:write"
    | "storage:read"
    | "storage:write"
    | "messages:read"
    | "messages:write"
    | "functions:invoke"
    | "ai:infer";

/** All valid {@link Scope}s, in canonical order. */
export const ACCESS_TOKEN_SCOPES: Scope[] = [
    "db:read",
    "db:write",
    "kv:read",
    "kv:write",
    "storage:read",
    "storage:write",
    "messages:read",
    "messages:write",
    "functions:invoke",
    "ai:infer",
];

/** A token as returned by {@link AccessTokensNamespace.list} (never the plaintext). */
export interface AccessTokenInfo {
    keyId: string;
    env: "live" | "test";
    scopes: string[];
    /** Epoch ms, or absent if the token never expires. */
    expiresAt?: number;
    label?: string;
    createdAt: number;
    revoked: boolean;
    /** True once past {@link expiresAt}. */
    expired: boolean;
}

/** The editor-settable fields when minting an access token. */
export interface CreateAccessTokenInput {
    scopes: string[];
    /** Defaults to `live` on the accelerator. */
    env?: "live" | "test";
    /** Omit for a non-expiring token. */
    expiresInDays?: number;
    label?: string;
}

/** Create response — includes the one-time {@link plaintext} secret. */
export interface CreatedAccessToken {
    keyId: string;
    env: "live" | "test";
    /** The `mk_<env>_at_…` secret. Returned ONCE — store it now. */
    plaintext: string;
    scopes: string[];
    expiresAt: number;
    label?: string;
    createdAt: number;
}

export interface AccessTokensNamespaceDeps {
    http: HttpClient;
}

export class AccessTokensNamespace {
    constructor(private readonly deps: AccessTokensNamespaceDeps) {}

    /** List the app's access tokens (metadata only — never the plaintext). */
    async list(appId: string): Promise<AccessTokenInfo[]> {
        const res = await this.deps.http.get<{ tokens: AccessTokenInfo[] }>(this.path(appId, ""));
        return res.tokens ?? [];
    }

    /** Mint an access token (owner/editor only). The plaintext is returned once. */
    async create(appId: string, input: CreateAccessTokenInput): Promise<CreatedAccessToken> {
        return this.deps.http.post<CreatedAccessToken>(this.path(appId, ""), input);
    }

    /** Revoke an access token by its `keyId`. */
    async revoke(appId: string, keyId: string): Promise<{ revoked: boolean }> {
        return this.deps.http.del<{ revoked: boolean }>(this.path(appId, `/${encodeURIComponent(keyId)}`));
    }

    private path(appId: string, suffix: string): string {
        return `/api/apps/${encodeURIComponent(appId)}/access-tokens${suffix}`;
    }
}

export default AccessTokensNamespace;
