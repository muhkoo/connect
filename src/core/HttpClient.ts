/**
 * `HttpClient` — the one place the unified {@link Client} talks to the
 * accelerator over HTTP.
 *
 * Every request carries two independent credentials:
 *   - the **app key** (`mk_…`) on `X-Muhkoo-Key` — resolves the app /
 *     developer / env context the accelerator uses for routing + billing;
 *   - the **user session token** on `X-Muhkoo-Session` (when a user is
 *     logged in) — the accelerator validates it and injects a trusted
 *     `X-Muhkoo-User-Context` downstream so per-user spaces can authorize
 *     the request without a fresh Groth16 proof.
 *
 * `X-Muhkoo-Key` is used (rather than `Authorization: Bearer`) because it is
 * a non-forbidden header that skips the CORS preflight in browsers.
 *
 * The class exposes a header-injecting {@link fetch} that can be handed to
 * lower-level building blocks (`AuthClient`, `PersonalSpaceClient`) so they
 * keep owning their own wire shapes while still getting the credentials, plus
 * convenience JSON helpers (`get`/`post`/`del`) for code that talks to the
 * accelerator directly.
 */

import { HttpError } from "./HttpError";
import { paymentRequiredFrom } from "./PaymentRequiredError";

export interface HttpClientOptions {
    /** Absolute URL of the accelerator worker (trailing slash optional). */
    baseUrl: string;
    /**
     * App / publishable key, e.g. `mk_test_pk_…`. Sent on every request as
     * `X-Muhkoo-Key` when present. Transitionally optional (auth + personal
     * storage still function without it), but the product direction is to
     * REQUIRE it — it attributes traffic for billing/metering and authorizes
     * shared-space (messaging) websockets.
     */
    apiKey?: string;
    /**
     * A scoped, expiring **access token** (`mk_<env>_at_…`) — the non-ZK
     * machine-to-machine credential. It resolves through the SAME accelerator
     * path as an app key and rides the same `X-Muhkoo-Key` header; when present
     * it takes precedence over {@link apiKey}. Use it for server-side / CI
     * callers that shouldn't carry the app's publishable key.
     */
    accessToken?: string;
    /** Returns the current user session token, or `null` when logged out. */
    getSessionToken?: () => string | null;
    /** Custom fetch — defaults to `globalThis.fetch`. */
    fetch?: typeof fetch;
    /**
     * Called when a token-gated request comes back `401` (stale/expired
     * session). Should attempt to silently re-establish a session and resolve
     * `true` if it succeeded (the request is then retried once with the fresh
     * token) or `false` if it couldn't (the `401` propagates as an
     * {@link HttpError}). Wired by {@link Client} to `auth.zk.recover()`.
     *
     * Only consulted by the JSON helpers (`get`/`post`/`del`) and
     * {@link HttpClient.fetchWithRecovery}; the raw {@link fetch} passes 401s
     * straight through so the auth wire calls that power recovery itself
     * can't recurse.
     */
    onUnauthorized?: () => Promise<boolean>;
}

/** Per-request timing logs, enabled on staging only (temporary diagnostic). */
const HTTP_DEBUG = (() => {
    try {
        return typeof location !== "undefined" && /(^|\.)staging\./.test(location.hostname);
    } catch {
        return false;
    }
})();

/** Short, readable request path (pathname + search) for the timing log. */
function reqPath(input: RequestInfo | URL): string {
    try {
        const u = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
        if (!/^https?:\/\//i.test(u)) return u;
        const parsed = new URL(u);
        return parsed.pathname + parsed.search;
    } catch {
        return "?";
    }
}

// Moved to its own module so `PaymentRequiredError` can extend it; re-exported
// here so every existing import of it from this module keeps working.
export { HttpError } from "./HttpError";

export class HttpClient {
    readonly baseUrl: string;
    /** Origin of {@link baseUrl} — credentials are only attached same-origin. */
    private readonly baseOrigin: string;
    private readonly apiKey: string | null;
    /** Scoped machine access token — takes precedence over {@link apiKey} on `X-Muhkoo-Key`. */
    private readonly accessToken: string | null;
    private readonly getSessionToken: () => string | null;
    private readonly onUnauthorized: (() => Promise<boolean>) | null;
    private readonly fetchFn: typeof fetch;

    constructor(opts: HttpClientOptions) {
        if (!opts?.baseUrl) throw new Error("HttpClient: `baseUrl` is required");
        this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
        try { this.baseOrigin = new URL(this.baseUrl).origin; } catch { this.baseOrigin = ""; }
        this.apiKey = opts.apiKey ?? null;
        this.accessToken = opts.accessToken ?? null;
        this.getSessionToken = opts.getSessionToken ?? (() => null);
        this.onUnauthorized = opts.onUnauthorized ?? null;

        const f = opts.fetch ?? globalThis.fetch;
        if (typeof f !== "function") {
            throw new Error(
                "HttpClient: `globalThis.fetch` is unavailable; pass an explicit `fetch`.",
            );
        }
        this.fetchFn = f.bind(globalThis);
    }

    /**
     * A `fetch`-compatible function that injects the app key + session token
     * headers. Hand this to `AuthClient` / `PersonalSpaceClient` so they pick
     * up credentials without knowing about them.
     */
    readonly fetch: typeof fetch = (input, init) => {
        const headers = new Headers(init?.headers);
        // Only attach credentials when the request stays on the accelerator's
        // origin. An absolute URL pointing elsewhere (e.g. a caller-supplied or
        // server-reflected path that escapes `baseUrl`) must NOT receive the app
        // key or session token, or it becomes a token-exfiltration vector.
        if (this.isSameOrigin(input)) {
            // Access token and app key resolve through the same accelerator path
            // and ride the same header; the access token takes precedence.
            const key = this.accessToken ?? this.apiKey;
            if (key) headers.set("X-Muhkoo-Key", key);
            const token = this.getSessionToken();
            if (token) headers.set("X-Muhkoo-Session", token);
        }
        const finalInit = { ...init, headers };
        if (!HTTP_DEBUG) return this.fetchFn(input, finalInit);
        // Staging diagnostic: time every accelerator request (this `fetch` is the
        // single chokepoint — JSON helpers + the roster/shard fetches ride it).
        const t = performance.now();
        const tag = `${init?.method ?? "GET"} ${reqPath(input)}`;
        return this.fetchFn(input, finalInit).then(
            (res) => { console.info(`[muhkoo:http] ${tag} → ${res.status} ${Math.round(performance.now() - t)}ms`); return res; },
            (err) => { console.info(`[muhkoo:http] ${tag} → ERROR ${Math.round(performance.now() - t)}ms`); throw err; },
        );
    };

    /**
     * {@link fetch} with the JSON helpers' stale-session recovery: a 401 on a
     * request made while a session token is held runs `onUnauthorized` once
     * and, if that recovered, replays the request once with the fresh token.
     * The final response is returned whatever its status, never thrown. The
     * replay re-sends `init` as given, so its body must be re-sendable (a
     * string or bytes, not a stream).
     */
    readonly fetchWithRecovery: typeof fetch = async (input, init) => {
        const res = await this.fetch(input, init);
        // `onUnauthorized` is consulted at most once per call, so a replay that
        // still 401s (recovery minted a token the endpoint still rejects) can't loop.
        if (res.status !== 401 || !this.onUnauthorized || !this.getSessionToken()) return res;
        if (!(await this.onUnauthorized())) return res;
        return this.fetch(input, init);
    };

    /** True when `input` resolves to {@link baseOrigin} (relative URLs always do). */
    private isSameOrigin(input: RequestInfo | URL): boolean {
        try {
            const urlStr =
                typeof input === "string" ? input
                : input instanceof URL ? input.href
                : (input as Request).url;
            // Relative URLs are resolved against baseUrl downstream → same origin.
            if (!/^https?:\/\//i.test(urlStr)) return true;
            return new URL(urlStr).origin === this.baseOrigin;
        } catch {
            return true;
        }
    }

    // -------------------------------------------------------------------------
    // JSON convenience helpers (path is relative to baseUrl)
    // -------------------------------------------------------------------------

    get<T = unknown>(path: string): Promise<T> {
        return this.request<T>("GET", path);
    }

    post<T = unknown>(path: string, body?: unknown): Promise<T> {
        return this.request<T>("POST", path, body);
    }

    patch<T = unknown>(path: string, body?: unknown): Promise<T> {
        return this.request<T>("PATCH", path, body);
    }

    del<T = unknown>(path: string, body?: unknown): Promise<T> {
        return this.request<T>("DELETE", path, body);
    }

    private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
        const url = path.startsWith("http") ? path : `${this.baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
        const init: RequestInit = { method };
        if (body !== undefined) {
            init.headers = { "Content-Type": "application/json" };
            init.body = JSON.stringify(body);
        }
        // Stale session: silently re-auth and replay the request once.
        const res = await this.fetchWithRecovery(url, init);

        let parsed: unknown = null;
        try {
            parsed = await res.json();
        } catch {
            // Non-JSON body — leave null and fall through to status-only error.
        }
        if (!res.ok) {
            const msg =
                parsed && typeof parsed === "object" && "error" in (parsed as object)
                    ? String((parsed as { error: unknown }).error)
                    : `${res.status} ${res.statusText}`;
            // A refusal for payment is its own class, so an app can tell it from
            // any other 4xx; every other error is the HttpError it always was.
            throw paymentRequiredFrom(res.status, parsed) ?? new HttpError(msg, res.status, parsed);
        }
        return parsed as T;
    }
}

export default HttpClient;
