/**
 * `Client` — the single entry point to the Muhkoo SDK.
 *
 * Everything an app does flows through namespaces hanging off one client:
 *
 *   const client = new Client({ apiKey, baseUrl });
 *   const user   = await client.auth.zk.login(username, password);
 *   await client.storage.set('todos', id, { title, completed: false });
 *   client.message.subscribe('todos', e => …);
 *   await client.message.send('user:abc', { text: 'Hello!' });
 *
 * The client owns:
 *   - an {@link HttpClient} that stamps the app key + session token onto every
 *     request to the accelerator;
 *   - a {@link SessionState} shared across namespaces (auth writes it; storage
 *     and message read identity + token from it);
 *   - the three namespaces: {@link AuthNamespace}, {@link StorageNamespace},
 *     {@link MessageNamespace}.
 *
 * The lower-level building blocks (`AuthClient`, `PersonalSpaceClient`,
 * `FileStorage`, `EncryptedSession`, `Network`, …) remain exported and usable
 * directly, but the client is the supported, ergonomic surface.
 */

import { AuthClient } from "../auth";
import { VERSION } from "../version";
import { defaultCircuitUrls, type CircuitUrls } from "../auth/proof";
import { HttpClient } from "./HttpClient";
import { SessionState, defaultSessionStore, type SessionStore } from "./Session";
import { AuthNamespace } from "./namespaces/AuthNamespace";
import { KvNamespace } from "./namespaces/KvNamespace";
import { DbNamespace } from "./namespaces/DbNamespace";
import { StorageNamespace } from "./namespaces/FileNamespace";
import { MessageNamespace } from "./namespaces/MessageNamespace";
import { SpaceNamespace } from "./namespaces/SpaceNamespace";
import { AgentsNamespace } from "./namespaces/AgentsNamespace";
import { FunctionsNamespace } from "./namespaces/FunctionsNamespace";
import type { SpaceKeyCache } from "../spaces/SpaceKeyring";

/** The hosted Muhkoo Accelerator — the default {@link ClientOptions.baseUrl}. */
export const DEFAULT_BASE_URL = "https://api.muhkoo.dev";

/** The hosted auth SPA — the default {@link ClientOptions.authBaseUrl}. */
export const DEFAULT_AUTH_BASE_URL = "https://auth.muhkoo.dev";

export interface ClientOptions {
    /**
     * App / publishable key issued by the accelerator (e.g. `mk_test_pk_…`).
     *
     * TRANSITIONALLY optional: auth + storage currently function without it so
     * the in-tree web app can migrate before a key is provisioned. The product
     * direction is that the app key becomes REQUIRED — it's how every app
     * authenticates to the Accelerator and gets attributed for metering/billing.
     * New integrations should always pass one.
     */
    apiKey?: string;
    /**
     * Absolute URL of the accelerator (trailing slash optional). Defaults to
     * the hosted Muhkoo Accelerator ({@link DEFAULT_BASE_URL}); override to
     * point at staging, a local `wrangler dev`, or a self-hosted deployment.
     */
    baseUrl?: string;
    /**
     * URLs of the `preimagePoK` circuit assets used for ZK login proofs.
     * Defaults to {@link defaultCircuitUrls} anchored at `baseUrl` — i.e.
     * `${baseUrl}/circuits/build/preimagePoK_js/preimagePoK.wasm` and
     * `…/preimagePoK_0001.zkey`, where the accelerator serves them.
     */
    circuits?: CircuitUrls;
    /** Pluggable session-token persistence. Defaults to in-memory. */
    sessionStore?: SessionStore;
    /** Custom fetch — defaults to `globalThis.fetch`. */
    fetch?: typeof fetch;
    /** Optional log level for the SDK logger. */
    logLevel?: string;
    /**
     * Wildcard zone HTTP serverless functions are served from
     * (`<name>--<slug>.<suffix>`), used by `client.functions.invoke(...)`.
     * Defaults to the hosted platform's zone (`fns.muhkoo.dev`); override for
     * staging or a self-hosted deployment.
     */
    functionsHostSuffix?: string;
    /**
     * Base URL of the centralized hosted auth SPA (`client.auth.hosted`).
     * Defaults to {@link DEFAULT_AUTH_BASE_URL} (`auth.muhkoo.dev`); override for
     * staging (`auth.staging.muhkoo.dev`) or a self-hosted deployment.
     */
    authBaseUrl?: string;
}

/**
 * Turn the HTTP base URL into a websocket base (`http(s)://` → `ws(s)://`).
 * The accelerator serves spaces over both on the same origin.
 */
function toWsBase(baseUrl: string): string {
    return baseUrl.replace(/\/+$/, "").replace(/^http/, "ws");
}

export class Client {
    readonly baseUrl: string;

    /** Authentication — `client.auth.zk.login(...)`, etc. */
    readonly auth: AuthNamespace;
    /** Per-user key/value storage — `client.kv.set(...)`, etc. */
    readonly kv: KvNamespace;
    /** App scalable database — `client.db.table('todos').query(...)`, etc. */
    readonly db: DbNamespace;
    /** File storage — `client.storage.writeFile(...)`, etc. */
    readonly storage: StorageNamespace;
    /** Realtime messaging — `client.message.subscribe(...)`, etc. */
    readonly message: MessageNamespace;
    /** Fan-out group spaces — `client.space.createSpace(...)`, etc. */
    readonly space: SpaceNamespace;
    /** Programmable Agents — `client.agents.create(appId, …)`, etc. */
    readonly agents: AgentsNamespace;
    /** Serverless functions — `client.functions.deploy(appId, …)`, etc. */
    readonly functions: FunctionsNamespace;

    private readonly session: SessionState;
    private readonly http: HttpClient;

    /** Subscribers notified when a session expires and can't be recovered. */
    private readonly sessionExpiredHandlers = new Set<() => void>();
    /** Shared in-flight recovery so a burst of 401s triggers one re-auth. */
    private recoverInFlight: Promise<boolean> | null = null;

    constructor(options: ClientOptions = {}) {
        // Build stamp — always logged (independent of logLevel) so the running
        // build is identifiable in the console. Catches stale cached bundles
        // during development; bump `VERSION` (and package.json) each build.
        try {
            console.info(`[@muhkoo/connect] initialized — v${VERSION}`);
        } catch { /* console may be unavailable in some runtimes */ }

        if (options.logLevel && typeof globalThis.appLogger?.setLevel === "function") {
            globalThis.appLogger.setLevel(options.logLevel);
        }

        this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
        this.session = new SessionState(options.sessionStore ?? defaultSessionStore());

        this.http = new HttpClient({
            baseUrl: this.baseUrl,
            apiKey: options.apiKey,
            getSessionToken: () => this.session.token,
            fetch: options.fetch,
            // Self-heal stale sessions: on a 401, try a silent re-auth (only
            // works while unlocked). If it can't, `recoverSession` fires the
            // session-expired event so the app can redirect to login.
            onUnauthorized: () => this.recoverSession(),
        });

        const circuits = options.circuits ?? defaultCircuitUrls(this.baseUrl);
        const authClient = new AuthClient({ baseUrl: this.baseUrl, fetch: this.http.fetch });

        const wsBaseUrl = toWsBase(this.baseUrl);
        const authBaseUrl = (options.authBaseUrl ?? DEFAULT_AUTH_BASE_URL).replace(/\/+$/, "");
        this.auth = new AuthNamespace({ auth: authClient, circuits, session: this.session, authBaseUrl });
        this.kv = new KvNamespace({ http: this.http, session: this.session, wsBaseUrl });
        this.db = new DbNamespace({ http: this.http });
        this.storage = new StorageNamespace({ http: this.http, baseUrl: this.baseUrl, kv: this.kv });
        this.message = new MessageNamespace({ http: this.http, session: this.session, wsBaseUrl });

        // Group keys are cached in the user's PersonalSpace (encrypted at rest
        // by client.kv), so a returning member hydrates without a fresh keyring
        // round-trip. The server only ever sees the ciphertext.
        const spaceKeyCache: SpaceKeyCache = {
            loadKeys: (spaceId) => this.kv.get<Record<string, string>>("space-keys", spaceId),
            saveKeys: (spaceId, keys) => this.kv.set("space-keys", spaceId, keys),
        };
        this.space = new SpaceNamespace({
            http: this.http,
            session: this.session,
            wsBaseUrl,
            cache: spaceKeyCache,
        });
        this.agents = new AgentsNamespace({ http: this.http });
        this.functions = new FunctionsNamespace({ http: this.http, fnHostSuffix: options.functionsHostSuffix });
    }

    /** The currently signed-in user, or `null`. */
    get user() {
        return this.auth.user;
    }

    /** Whether a token-bearing session is active. */
    get isAuthenticated(): boolean {
        return this.session.isAuthenticated;
    }

    /**
     * Subscribe to session expiry that couldn't be silently recovered (the
     * user's identity wasn't in memory to re-prove — typically after a reload
     * where only the token was persisted, and that token has since gone stale).
     * This is the signal to send the user back to the login screen.
     *
     * Returns an unsubscribe function.
     *
     *   const off = client.onSessionExpired(() => router.push('/login'));
     */
    onSessionExpired(handler: () => void): () => void {
        this.sessionExpiredHandlers.add(handler);
        return () => this.sessionExpiredHandlers.delete(handler);
    }

    /**
     * Attempt a silent re-auth of the current user. Concurrent callers share a
     * single in-flight attempt (a stale token usually 401s several requests at
     * once — we re-auth once, not once per request). On failure the
     * session-expired event fires so the app can react. Exposed so apps can
     * also drive recovery proactively (e.g. on `visibilitychange`).
     */
    recoverSession(): Promise<boolean> {
        if (this.recoverInFlight) return this.recoverInFlight;
        this.recoverInFlight = this.auth.zk
            .recover()
            .then((ok) => {
                if (!ok) {
                    for (const handler of this.sessionExpiredHandlers) {
                        try { handler(); } catch { /* a bad listener mustn't break recovery */ }
                    }
                }
                return ok;
            })
            .finally(() => {
                this.recoverInFlight = null;
            });
        return this.recoverInFlight;
    }
}

export default Client;
