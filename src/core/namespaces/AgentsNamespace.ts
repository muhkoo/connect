/**
 * `client.agents` — manage an app's **Programmable Agents** (server-side
 * "virtual users" backed by Workers AI).
 *
 *   const { config } = await client.agents.create(appId, {
 *     handle: '@assistant', displayName: 'Assistant',
 *     systemPrompt: 'You are a helpful teammate in this Space.',
 *     triggers: [{ type: 'mention' }],
 *   });
 *   await client.agents.enable(appId, config.agentId, spaceId);  // per-Space opt-in
 *
 * These are MANAGEMENT calls — the agent itself runs on the accelerator. Only an
 * app's owner or an editor of its shared Space may create/update/enable an agent
 * (viewers can read). Authorization rides the user session token; non-owner
 * editors pass their management Space via `opts.space`.
 *
 * v1 is "prompts + persona": a system prompt, a model, named prompt `skills`,
 * and `triggers` that decide when the agent speaks. No tools, no code.
 */

import type { HttpClient } from "../HttpClient";

export type AgentTriggerType = "mention" | "keyword" | "regex" | "always";

export interface AgentTrigger {
    type: AgentTriggerType;
    /** Required for `keyword` (case-insensitive substring) and `regex`. */
    pattern?: string;
    /** Name of a {@link AgentSkill} to run on match. */
    skill?: string;
}

export interface AgentSkill {
    name: string;
    prompt: string;
}

export interface AgentConfig {
    agentId: string;
    /** @-mention target, e.g. "@assistant". */
    handle: string;
    displayName: string;
    model: string;
    systemPrompt: string;
    skills: AgentSkill[];
    triggers: AgentTrigger[];
    /** Space ids this agent is enabled on (per-Space opt-in). */
    enabledSpaces: string[];
    caps: { dailyTokenBudget: number };
    createdAt: number;
    updatedAt: number;
}

/** The editor-settable fields when creating an agent. */
export interface AgentCreateInput {
    handle: string;
    displayName: string;
    systemPrompt: string;
    model?: string;
    skills?: AgentSkill[];
    triggers?: AgentTrigger[];
    caps?: { dailyTokenBudget: number };
}

export type AgentUpdateInput = Partial<AgentCreateInput>;

/** Create/get response — the config plus the agent's published identity keys. */
export interface AgentProvisioned {
    config: AgentConfig;
    /** The agent's Space member id (`__agent__:<agentId>`). */
    memberId: string;
    /** base64url-JWK identity ECDH public key (null until provisioned). */
    ecdhPub: string | null;
    /** base64url-JWK identity ECDSA public key — verifies the agent's messages. */
    ecdsaPub: string | null;
}

export interface AgentsNamespaceDeps {
    http: HttpClient;
}

/** Common option: a management Space for delegated (non-owner) access. */
export interface AgentScopeOpts {
    space?: string;
}

export class AgentsNamespace {
    constructor(private readonly deps: AgentsNamespaceDeps) {}

    /** List the app's agents. */
    async list(appId: string, opts: AgentScopeOpts = {}): Promise<AgentConfig[]> {
        const res = await this.deps.http.get<{ agents: AgentConfig[] }>(this.path(appId, "", opts));
        return res.agents ?? [];
    }

    /** Read one agent (config + identity keys). */
    async get(appId: string, agentId: string, opts: AgentScopeOpts = {}): Promise<AgentProvisioned> {
        return this.deps.http.get<AgentProvisioned>(this.path(appId, `/${encodeURIComponent(agentId)}`, opts));
    }

    /** Create an agent (owner/editor only). */
    async create(appId: string, input: AgentCreateInput, opts: AgentScopeOpts = {}): Promise<AgentProvisioned> {
        return this.deps.http.post<AgentProvisioned>(this.path(appId, "", {}), { ...input, space: opts.space });
    }

    /** Update an agent's editor-settable fields (owner/editor only). */
    async update(appId: string, agentId: string, patch: AgentUpdateInput, opts: AgentScopeOpts = {}): Promise<{ config: AgentConfig }> {
        return this.deps.http.patch<{ config: AgentConfig }>(
            this.path(appId, `/${encodeURIComponent(agentId)}`, {}),
            { ...patch, space: opts.space },
        );
    }

    /** Delete an agent (owner/editor only). */
    async delete(appId: string, agentId: string, opts: AgentScopeOpts = {}): Promise<{ deleted: boolean }> {
        return this.deps.http.del<{ deleted: boolean }>(
            this.path(appId, `/${encodeURIComponent(agentId)}`, {}),
            { space: opts.space },
        );
    }

    /** Enable the agent on a Space (per-Space opt-in). */
    async enable(appId: string, agentId: string, spaceId: string, opts: AgentScopeOpts = {}): Promise<{ config: AgentConfig }> {
        return this.deps.http.post<{ config: AgentConfig }>(
            this.path(appId, `/${encodeURIComponent(agentId)}/enable`, {}),
            { targetSpaceId: spaceId, space: opts.space },
        );
    }

    /** Disable the agent on a Space. */
    async disable(appId: string, agentId: string, spaceId: string, opts: AgentScopeOpts = {}): Promise<{ config: AgentConfig }> {
        return this.deps.http.post<{ config: AgentConfig }>(
            this.path(appId, `/${encodeURIComponent(agentId)}/disable`, {}),
            { targetSpaceId: spaceId, space: opts.space },
        );
    }

    private path(appId: string, suffix: string, opts: AgentScopeOpts): string {
        const q = opts.space ? `?space=${encodeURIComponent(opts.space)}` : "";
        return `/api/apps/${encodeURIComponent(appId)}/agents${suffix}${q}`;
    }
}

export default AgentsNamespace;
