/**
 * `client.functions` — manage an app's **serverless functions** (developer-
 * authored code that runs on the accelerator).
 *
 *   const { config } = await client.functions.deploy(appId, {
 *     name: 'hello', displayName: 'Hello',
 *     code: `export default { fetch: () => new Response('hi') }`,
 *     triggers: { http: { enabled: true } },
 *   });
 *   // HTTP-reachable at  hello--<slug>.fns.muhkoo.dev
 *   await client.functions.enable(appId, config.functionId, spaceId); // Space-bound
 *
 * These are MANAGEMENT calls — the function itself runs on the accelerator
 * (uploaded just-in-time, decrypted only at invocation). Only an app's owner or
 * an editor of its shared Space may deploy/update/enable (viewers read).
 * Authorization rides the user session token; non-owner editors pass their
 * management Space via `opts.space`.
 *
 * v1 is "compute-only": a function is an untrusted single-module ES worker
 * (`export default { fetch }`) with NO platform bindings — it reaches the
 * platform as an external client (the end-user session is passed through). Two
 * triggers: `http` (its own subdomain) and `space` (invoked on Space messages,
 * like a Programmable Agent).
 */

import type { HttpClient } from "../HttpClient";

export type FunctionTriggerType = "keyword" | "regex" | "always";

export interface FunctionTrigger {
    type: FunctionTriggerType;
    /** Required for `keyword` (case-insensitive substring) and `regex`. */
    pattern?: string;
}

export interface FunctionTriggers {
    /** HTTP-invocable at `<name>--<slug>.fns.<zone>`. */
    http?: { enabled: boolean; methods?: string[] };
    /** Invoked on matching Space messages (per-Space opt-in via enable). */
    space?: { match: FunctionTrigger[] };
}

export interface FunctionCaps {
    /** Per-invocation CPU ceiling (ms). */
    cpuMs: number;
    /** Per-invocation subrequest ceiling. */
    subRequests: number;
    /** Hard daily invocation cap (0 = unlimited). */
    dailyInvocationBudget: number;
}

export interface FunctionConfig {
    functionId: string;
    /** DNS-safe slug — the function's subdomain label + WfP script name part. */
    name: string;
    displayName: string;
    triggers: FunctionTriggers;
    /** Space ids this function is enabled on (per-Space opt-in for `space`). */
    enabledSpaces: string[];
    caps: FunctionCaps;
    scriptName: string;
    /** sha-256 of the last-deployed source. */
    codeHash?: string;
    /** When the source was last (re)deployed. */
    deployedAt?: number;
    createdAt: number;
    updatedAt: number;
}

/** The editor-settable fields when deploying a function. */
export interface FunctionDeployInput {
    name: string;
    displayName: string;
    /** Raw single-module ES worker source (`export default { fetch }`). */
    code: string;
    triggers?: FunctionTriggers;
    caps?: Partial<FunctionCaps>;
}

/** Update input — any subset, including new `code` to redeploy. */
export type FunctionUpdateInput = Partial<FunctionDeployInput>;

export interface FunctionsNamespaceDeps {
    http: HttpClient;
}

/** Common option: a management Space for delegated (non-owner) access. */
export interface FunctionScopeOpts {
    space?: string;
}

export class FunctionsNamespace {
    constructor(private readonly deps: FunctionsNamespaceDeps) {}

    /** List the app's functions. */
    async list(appId: string, opts: FunctionScopeOpts = {}): Promise<FunctionConfig[]> {
        const res = await this.deps.http.get<{ functions: FunctionConfig[] }>(this.path(appId, "", opts));
        return res.functions ?? [];
    }

    /** Read one function's config. */
    async get(appId: string, functionId: string, opts: FunctionScopeOpts = {}): Promise<{ config: FunctionConfig }> {
        return this.deps.http.get<{ config: FunctionConfig }>(this.path(appId, `/${encodeURIComponent(functionId)}`, opts));
    }

    /** Read a function's decrypted source (owner/editor; for the editor UI). */
    async code(appId: string, functionId: string, opts: FunctionScopeOpts = {}): Promise<{ functionId: string; code: string; codeHash: string | null }> {
        return this.deps.http.get<{ functionId: string; code: string; codeHash: string | null }>(
            this.path(appId, `/${encodeURIComponent(functionId)}/code`, opts),
        );
    }

    /** Deploy (create) a function (owner/editor only). */
    async deploy(appId: string, input: FunctionDeployInput, opts: FunctionScopeOpts = {}): Promise<{ config: FunctionConfig }> {
        return this.deps.http.post<{ config: FunctionConfig }>(this.path(appId, "", {}), { ...input, space: opts.space });
    }

    /** Update a function's editor-settable fields and/or redeploy its `code`. */
    async update(appId: string, functionId: string, patch: FunctionUpdateInput, opts: FunctionScopeOpts = {}): Promise<{ config: FunctionConfig }> {
        return this.deps.http.patch<{ config: FunctionConfig }>(
            this.path(appId, `/${encodeURIComponent(functionId)}`, {}),
            { ...patch, space: opts.space },
        );
    }

    /** Delete a function (owner/editor only). */
    async delete(appId: string, functionId: string, opts: FunctionScopeOpts = {}): Promise<{ deleted: boolean }> {
        return this.deps.http.del<{ deleted: boolean }>(
            this.path(appId, `/${encodeURIComponent(functionId)}`, {}),
            { space: opts.space },
        );
    }

    /** Enable the function on a Space (per-Space opt-in for the `space` trigger). */
    async enable(appId: string, functionId: string, spaceId: string, opts: FunctionScopeOpts = {}): Promise<{ config: FunctionConfig }> {
        return this.deps.http.post<{ config: FunctionConfig }>(
            this.path(appId, `/${encodeURIComponent(functionId)}/enable`, {}),
            { targetSpaceId: spaceId, space: opts.space },
        );
    }

    /** Disable the function on a Space. */
    async disable(appId: string, functionId: string, spaceId: string, opts: FunctionScopeOpts = {}): Promise<{ config: FunctionConfig }> {
        return this.deps.http.post<{ config: FunctionConfig }>(
            this.path(appId, `/${encodeURIComponent(functionId)}/disable`, {}),
            { targetSpaceId: spaceId, space: opts.space },
        );
    }

    private path(appId: string, suffix: string, opts: FunctionScopeOpts): string {
        const q = opts.space ? `?space=${encodeURIComponent(opts.space)}` : "";
        return `/api/apps/${encodeURIComponent(appId)}/functions${suffix}${q}`;
    }
}

export default FunctionsNamespace;
