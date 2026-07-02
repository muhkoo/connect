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
     * Only consulted by the JSON helpers (`get`/`post`/`del`); the raw
     * {@link fetch} passes 401s straight through so the auth wire calls that
     * power recovery itself can't recurse.
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

/** Thrown for any non-2xx accelerator response. Carries the HTTP status. */
export class HttpError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly body?: unknown,
    ) {
        super(message);
        this.name = "HttpError";
    }
}

export class HttpClient {
    readonly baseUrl: string;
    /** Origin of {@link baseUrl} — credentials are only attached same-origin. */
    private readonly baseOrigin: string;
    private readonly apiKey: string | null;
    private readonly getSessionToken: () => string | null;
    private readonly onUnauthorized: (() => Promise<boolean>) | null;
    private readonly fetchFn: typeof fetch;

    constructor(opts: HttpClientOptions) {
        if (!opts?.baseUrl) throw new Error("HttpClient: `baseUrl` is required");
        this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
        try { this.baseOrigin = new URL(this.baseUrl).origin; } catch { this.baseOrigin = ""; }
        this.apiKey = opts.apiKey ?? null;
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
            if (this.apiKey) headers.set("X-Muhkoo-Key", this.apiKey);
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

    private async request<T>(method: string, path: string, body?: unknown, allowRecovery = true): Promise<T> {
        const url = path.startsWith("http") ? path : `${this.baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
        const init: RequestInit = { method };
        if (body !== undefined) {
            init.headers = { "Content-Type": "application/json" };
            init.body = JSON.stringify(body);
        }
        const res = await this.fetch(url, init);

        // Stale session: try to silently re-auth and replay the request once.
        // `allowRecovery` is cleared on the retry so a still-401 response (e.g.
        // recovery minted a token the endpoint still rejects) can't loop.
        if (res.status === 401 && allowRecovery && this.onUnauthorized && this.getSessionToken()) {
            const recovered = await this.onUnauthorized();
            if (recovered) {
                return this.request<T>(method, path, body, false);
            }
        }

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
            throw new HttpError(msg, res.status, parsed);
        }
        return parsed as T;
    }
}

export default HttpClient;
