/**
 * `client.auth.hosted` — centralized hosted auth (auth.muhkoo.dev).
 * AUTH_HOSTED_PLAN.md.
 *
 * Two sides share this class:
 *   - **Developer apps** call {@link login} (redirect to the hosted page) and
 *     {@link handleCallback} (exchange the returned code → session + seed). The
 *     app carries no snarkjs and never sees the user's credentials.
 *   - **The hosted page** (the muhkoo/auth SPA), once it has authenticated the
 *     user via the normal `client.auth.zk.*` flow, calls
 *     {@link completeAuthorize} to seal the seed, mint the grant, and build the
 *     redirect-back URL.
 *
 * Flow (authorization-code + PKCE + sealed-seed handoff):
 *   app  →  GET  auth.muhkoo.dev/authorize?app_id&redirect_uri&state&code_challenge
 *   page →  (user authenticates) → POST /api/auth/grant → redirect_uri?code&state#k=<K_t>
 *   app  →  POST /api/auth/token {code, code_verifier} → {sessionToken, sealedKeys}
 *        →  unseal sealedKeys with K_t → master seed → session ready
 */

import type { AuthClient } from "../../auth/AuthClient";
import type { SessionState } from "../Session";
import { deriveIdentityFromSeed } from "../../auth/identity";
import { sealSeed, unsealSeed, generatePkce, randomState } from "../../auth/hostedHandoff";

export interface HostedAuthDeps {
    auth: AuthClient;
    session: SessionState;
    /** Base URL of the hosted auth SPA (e.g. https://auth.muhkoo.dev). */
    authBaseUrl: string;
}

export interface AuthUser {
    username: string;
    commitment: string;
}

const PKCE_STORE_KEY = "muhkoo.hosted.pkce";

export class HostedAuth {
    constructor(private readonly deps: HostedAuthDeps) {}

    /**
     * (App side) Begin hosted login: stash a PKCE verifier + state, then send
     * the browser to the hosted authorize page. Returns the URL it redirects to
     * (also useful for popup mode / tests). `redirectUri` must be registered for
     * the app in the portal.
     */
    async login(opts: { appId: string; redirectUri: string; redirect?: boolean }): Promise<string> {
        const { codeVerifier, codeChallenge } = await generatePkce();
        const state = randomState();
        this.store({ codeVerifier, state, appId: opts.appId, redirectUri: opts.redirectUri });
        const url = `${this.deps.authBaseUrl}/authorize?` + new URLSearchParams({
            app_id: opts.appId,
            redirect_uri: opts.redirectUri,
            state,
            code_challenge: codeChallenge,
            code_challenge_method: "S256",
        }).toString();
        if (opts.redirect !== false) this.location().assign(url);
        return url;
    }

    /**
     * (App side) Send the user to centralized account & security management on
     * the hosted page (auth.muhkoo.dev/security) — manage passkeys, recovery
     * phrase, email, Google, change password, and remove login methods, all in
     * one place. `returnUri` (default: the current URL) gives the hosted page a
     * "Back to app" target. Redirects the browser; resolves to the URL.
     */
    async manageAccount(opts: { returnUri?: string } = {}): Promise<string> {
        const ret = opts.returnUri ?? this.location().href;
        const url = `${this.deps.authBaseUrl}/security?` + new URLSearchParams({ return: ret }).toString();
        this.location().assign(url);
        return url;
    }

    /** Whether the current URL looks like a hosted-auth callback (has code + state). */
    isCallback(): boolean {
        try {
            const q = new URLSearchParams(this.location().search);
            return q.has("code") && q.has("state");
        } catch { return false; }
    }

    /**
     * (App side) Complete login on the callback URL: verify state, exchange the
     * code (+ PKCE verifier) for the session, unseal the seed from the fragment,
     * establish the session, and scrub the URL. Returns the signed-in user.
     */
    async handleCallback(): Promise<AuthUser> {
        const loc = this.location();
        const query = new URLSearchParams(loc.search);
        const code = query.get("code");
        const state = query.get("state");
        const fragmentKey = new URLSearchParams(loc.hash.replace(/^#/, "")).get("k");
        if (!code || !state) throw new Error("Not a hosted-auth callback.");
        if (!fragmentKey) throw new Error("Missing handoff key — the login link was altered.");

        const stash = this.take();
        if (!stash || stash.state !== state) throw new Error("State mismatch — possible CSRF; start login again.");

        const res = await this.deps.auth.token({ code, codeVerifier: stash.codeVerifier, appId: stash.appId });
        const seed = await unsealSeed(res.sealedKeys, fragmentKey);
        const identity = await deriveIdentityFromSeed(seed);
        await this.deps.session.setSession({ token: res.sessionToken, username: res.username, commitment: res.commitment });
        this.deps.session.setIdentity(identity);
        this.deps.session.setSeed(seed);

        this.scrubUrl();
        return { username: res.username, commitment: res.commitment };
    }

    /**
     * (Hosted-page side) Finish an /authorize request after the user has
     * authenticated here: seal the in-memory seed, mint the grant, and return
     * the URL to redirect the browser back to. The seed must be held (the user
     * just signed in via `client.auth.zk.*`).
     */
    async completeAuthorize(opts: { appId: string; redirectUri: string; codeChallenge: string; state: string }): Promise<string> {
        const token = this.deps.session.token;
        const seed = this.deps.session.seed;
        if (!token || !seed) throw new Error("Authenticate the user before completing authorization.");
        const { sealedKeys, fragmentKey } = await sealSeed(seed);
        const { code } = await this.deps.auth.grant(token, {
            appId: opts.appId, redirectUri: opts.redirectUri, codeChallenge: opts.codeChallenge, sealedKeys,
        });
        const url = new URL(opts.redirectUri);
        url.searchParams.set("code", code);
        url.searchParams.set("state", opts.state);
        url.hash = `k=${fragmentKey}`;
        return url.toString();
    }

    // ---- internals ----------------------------------------------------------

    private location(): Location {
        const loc = (globalThis as { location?: Location }).location;
        if (!loc) throw new Error("Hosted auth requires a browser environment.");
        return loc;
    }

    private store(v: { codeVerifier: string; state: string; appId: string; redirectUri: string }): void {
        const ss = (globalThis as { sessionStorage?: Storage }).sessionStorage;
        if (!ss) throw new Error("Hosted auth requires sessionStorage.");
        ss.setItem(PKCE_STORE_KEY, JSON.stringify(v));
    }

    private take(): { codeVerifier: string; state: string; appId: string; redirectUri: string } | null {
        const ss = (globalThis as { sessionStorage?: Storage }).sessionStorage;
        if (!ss) return null;
        const raw = ss.getItem(PKCE_STORE_KEY);
        if (!raw) return null;
        ss.removeItem(PKCE_STORE_KEY);
        try { return JSON.parse(raw); } catch { return null; }
    }

    /** Drop `code`, `state`, and the `#k` fragment from the address bar. */
    private scrubUrl(): void {
        const h = (globalThis as { history?: History }).history;
        const loc = this.location();
        if (h?.replaceState) h.replaceState(null, "", loc.pathname);
    }
}
