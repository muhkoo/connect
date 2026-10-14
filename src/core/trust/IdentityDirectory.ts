import { HttpError, type HttpClient } from "../HttpClient";
import { SpaceTrustError } from "./errors";

/**
 * POST /api/auth/identity (SpecA §4.1 as amended by CS-7). An unknown name
 * answers a deterministic decoy, so a lookup never says whether an account
 * exists. Responses are cached for the life of the Client. Any failure,
 * including a 429, fails closed (SpecA §4.3).
 */
export class IdentityDirectory {
    private readonly cache = new Map<string, string>();

    constructor(private readonly http: Pick<HttpClient, "post">) {}

    async lookup(username: string): Promise<string> {
        const l = username.toLowerCase();
        return (await this.lookupMany([username]))[l];
    }

    async lookupMany(usernames: string[]): Promise<Record<string, string>> {
        const out: Record<string, string> = {};
        const missing: string[] = [];
        for (const u of usernames) {
            const l = u.toLowerCase();
            const hit = this.cache.get(l);
            if (hit) out[l] = hit;
            else if (!missing.includes(l)) missing.push(l);
        }
        for (let i = 0; i < missing.length; i += 64) {
            const batch = missing.slice(i, i + 64);
            let keys: Record<string, unknown> | undefined;
            try {
                keys = (await this.http.post<{ keys?: Record<string, unknown> }>("/api/auth/identity", { usernames: batch }))?.keys;
            } catch (e) {
                throw new SpaceTrustError("lookup-failed", "Couldn't verify members right now; retrying.", {
                    status: e instanceof HttpError ? e.status : undefined,
                });
            }
            for (const l of batch) {
                const k = keys?.[l];
                if (typeof k !== "string") throw new SpaceTrustError("lookup-failed", "Couldn't verify members right now; retrying.");
                this.cache.set(l, k);
                out[l] = k;
            }
        }
        return out;
    }
}
