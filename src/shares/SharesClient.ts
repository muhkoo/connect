/**
 * `SharesClient` — the thin HTTP layer over the accelerator's `/api/shares` routes. It owns paths, verbs and error
 * mapping and nothing else; the `Share` object and `client.shares` build on it.
 *
 * Every call but `publicInfo` carries the app key and the signed-in session (with the usual stale-session recovery),
 * including `admit`: a public share's guest is an ordinary account. `publicInfo` needs only the app key and never
 * sends a session.
 */

import type { HttpClient } from "../core/HttpClient";
import { HttpError } from "../core/HttpError";
import { paymentRequiredFrom } from "../core/PaymentRequiredError";
import { shareErrorFrom } from "./errors";
import type {
    CreateShareBody,
    EditPolicy,
    PasswordVerifier,
    ShareAdmitBody,
    ShareInfo,
    SharePublicInfo,
    ShareSummary,
} from "./types";

export class SharesClient {
    private readonly keyOnlyHttp: HttpClient;

    constructor(private readonly http: HttpClient) {
        this.keyOnlyHttp = http.withoutSession();
    }

    create(body: CreateShareBody): Promise<ShareInfo> {
        return this.send(this.http, "POST", "/api/shares", body);
    }

    async list(): Promise<ShareSummary[]> {
        const res = await this.send<{ shares?: ShareSummary[] }>(this.http, "GET", "/api/shares");
        return res.shares ?? [];
    }

    info(spaceId: string): Promise<ShareInfo> {
        return this.send(this.http, "GET", `/api/shares/${enc(spaceId)}`);
    }

    update(spaceId: string, patch: { limitBytes?: number | null; editPolicy?: EditPolicy }): Promise<ShareInfo> {
        return this.send(this.http, "PATCH", `/api/shares/${enc(spaceId)}`, patch);
    }

    /** A public share's name, owner and password salt, read before admission. Publishable key only; never the verifier. */
    publicInfo(spaceId: string): Promise<SharePublicInfo> {
        return this.send(this.keyOnlyHttp, "GET", `/api/shares/${enc(spaceId)}/public`);
    }

    /**
     * Admit the signed-in account to a public share by proving its password. Afterwards the account is a member:
     * it sends its own `/keyring/join-request`. Re-admitting the same account only updates its name.
     */
    async admit(spaceId: string, body: ShareAdmitBody): Promise<void> {
        await this.send(this.http, "POST", `/api/shares/${enc(spaceId)}/admit`, body);
    }

    async removeMember(spaceId: string, username: string): Promise<void> {
        await this.send(this.http, "DELETE", `/api/shares/${enc(spaceId)}/members/${enc(username)}`);
    }

    /** Rotate: `from` is the old share, `newSpaceId` the Space the client made and seeded. */
    adopt(newSpaceId: string, body: { from: string; password?: PasswordVerifier; remove?: string[] }): Promise<ShareInfo> {
        return this.send(this.http, "POST", `/api/shares/${enc(newSpaceId)}/adopt`, body);
    }

    private async send<T>(http: HttpClient, method: string, path: string, body?: unknown): Promise<T> {
        const init: RequestInit = { method };
        if (body !== undefined) {
            init.headers = { "Content-Type": "application/json" };
            init.body = JSON.stringify(body);
        }
        const res = await http.fetchWithRecovery(`${http.baseUrl}${path}`, init);
        let parsed: unknown = null;
        try {
            parsed = await res.json();
        } catch {
            // Non-JSON body: fall through with null.
        }
        if (res.ok) return parsed as T;

        const retry = Number(res.headers.get("Retry-After"));
        const typed = shareErrorFrom(res.status, parsed, Number.isFinite(retry) && retry > 0 ? retry : undefined);
        if (typed) throw typed;
        const msg =
            parsed && typeof parsed === "object" && "error" in parsed
                ? String((parsed as { error: unknown }).error)
                : `${res.status} ${res.statusText}`;
        throw paymentRequiredFrom(res.status, parsed) ?? new HttpError(msg, res.status, parsed);
    }
}

/** A path segment. Space ids are `[A-Za-z0-9_-]` so this is a no-op for them; usernames may need it. */
function enc(segment: string): string {
    return encodeURIComponent(segment);
}
