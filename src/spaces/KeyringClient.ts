/**
 * KeyringClient — HTTP implementation of {@link KeyringTransport} against the
 * accelerator's per-space keyring endpoints. All blobs are opaque to the
 * server; this client just moves them.
 *
 *   POST /api/spaces/:id/keyring/join-request   { ...JoinRequest }
 *   GET  /api/spaces/:id/keyring/blobs/:member  -> WrappedKey[]
 *   POST /api/spaces/:id/keyring/wrap           { targetMemberId, fromMemberId, wrapped }
 *   GET  /api/spaces/:id/keyring/pending        -> JoinRequest[]
 *   GET  /api/spaces/:id/keyring/roster         -> { memberId, identityEcdhPub }[]
 *   POST /api/spaces/:id/keyring/rotate         { nextEpoch } -> { epoch }
 *   GET  /api/spaces/:id/metadata               -> SpaceMetadata
 */

import type { KeyringTransport } from "./SpaceKeyring";
import type { WrappedKey, JoinRequest, SpaceMetadata, RosterMember, InviteLink } from "./types";

export interface KeyringClientDeps {
    spaceId: string;
    httpBaseUrl: string;
    /** Header-injecting fetch from the client's HttpClient. */
    fetch: typeof fetch;
}

export class KeyringClient implements KeyringTransport {
    constructor(private readonly deps: KeyringClientDeps) {}

    private url(suffix: string): string {
        return `${this.deps.httpBaseUrl}/api/spaces/${encodeURIComponent(this.deps.spaceId)}${suffix}`;
    }

    private async post<T>(suffix: string, body: unknown): Promise<T> {
        const res = await this.deps.fetch(this.url(suffix), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`KeyringClient POST ${suffix}: ${res.status} ${res.statusText}`);
        return (await res.json().catch(() => ({}))) as T;
    }

    private async get<T>(suffix: string): Promise<T> {
        const res = await this.deps.fetch(this.url(suffix));
        if (!res.ok) throw new Error(`KeyringClient GET ${suffix}: ${res.status} ${res.statusText}`);
        return (await res.json()) as T;
    }

    async postJoinRequest(req: JoinRequest): Promise<void> {
        await this.post("/keyring/join-request", req);
    }

    async fetchBlobs(memberId: string): Promise<WrappedKey[]> {
        const body = await this.get<{ blobs?: WrappedKey[] }>(
            `/keyring/blobs/${encodeURIComponent(memberId)}`,
        );
        return body.blobs ?? [];
    }

    async postWrappedKey(targetMemberId: string, wrapped: WrappedKey, fromMemberId: string): Promise<void> {
        await this.post("/keyring/wrap", { targetMemberId, fromMemberId, wrapped });
    }

    async fetchPending(): Promise<JoinRequest[]> {
        const body = await this.get<{ pending?: JoinRequest[] }>("/keyring/pending");
        return body.pending ?? [];
    }

    async fetchRoster(): Promise<RosterMember[]> {
        const body = await this.get<{ roster?: RosterMember[] }>("/keyring/roster");
        return body.roster ?? [];
    }

    async rotate(nextEpoch: number): Promise<{ epoch: number }> {
        return this.post<{ epoch: number }>("/keyring/rotate", { nextEpoch });
    }

    async invite(username: string): Promise<void> {
        await this.post("/keyring/invite", { username });
    }

    // -- Shareable invite links ----------------------------------------------
    // A capability token tied to this space. Redeeming it allowlists the holder
    // so the keeper admits them — the link IS the invitation. Mint/list/revoke
    // require the caller to be the creator or an existing member.

    async createInviteLink(opts: { expiresInSec?: number; maxUses?: number; role?: string } = {}): Promise<InviteLink> {
        return this.post<InviteLink>("/keyring/link", opts);
    }

    async listInviteLinks(): Promise<InviteLink[]> {
        const body = await this.get<{ links?: InviteLink[] }>("/keyring/links");
        return body.links ?? [];
    }

    /** Set a member's role ("viewer" | "editor"). Owner-only on the server. */
    async setMemberRole(username: string, role: string): Promise<void> {
        await this.post("/keyring/role", { username, role });
    }

    /** Roster with roles (owner/members only). */
    async members(): Promise<Array<{ memberId: string; role: string }>> {
        const body = await this.get<{ members?: Array<{ memberId: string; role: string }> }>("/keyring/members");
        return body.members ?? [];
    }

    async revokeInviteLink(token: string): Promise<void> {
        await this.post("/keyring/link-revoke", { token });
    }

    /** Redeem a link: the server allowlists this member and asks the keeper to
     *  wrap the group key for their identity. Caller must be authenticated. */
    async redeemInvite(req: { token: string; identityEcdhPub: string; identityEcdsaPub?: string; desiredEpoch?: number }): Promise<void> {
        await this.post("/keyring/redeem", req);
    }

    async fetchMetadata(): Promise<SpaceMetadata | null> {
        try {
            return await this.get<SpaceMetadata>("/metadata");
        } catch {
            return null;
        }
    }
}
