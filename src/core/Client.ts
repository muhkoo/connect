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
import { defaultCircuitUrls, type CircuitUrls } from "../auth/proof";
import { HttpClient } from "./HttpClient";
import { SessionState, defaultSessionStore, type SessionStore } from "./Session";
import { AuthNamespace } from "./namespaces/AuthNamespace";
import { StorageNamespace } from "./namespaces/StorageNamespace";
import { MessageNamespace } from "./namespaces/MessageNamespace";
import { SpaceNamespace } from "./namespaces/SpaceNamespace";
import type { SpaceKeyCache } from "../spaces/SpaceKeyring";

/** The hosted Muhkoo Accelerator — the default {@link ClientOptions.baseUrl}. */
export const DEFAULT_BASE_URL = "https://api.muhkoo.dev";

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
    /** Per-user persistent storage — `client.storage.set(...)`, etc. */
    readonly storage: StorageNamespace;
    /** Realtime messaging — `client.message.subscribe(...)`, etc. */
    readonly message: MessageNamespace;
    /** Fan-out group spaces — `client.space.createSpace(...)`, etc. */
    readonly space: SpaceNamespace;

    private readonly session: SessionState;
    private readonly http: HttpClient;

    constructor(options: ClientOptions = {}) {
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
        });

        const circuits = options.circuits ?? defaultCircuitUrls(this.baseUrl);
        const authClient = new AuthClient({ baseUrl: this.baseUrl, fetch: this.http.fetch });

        const wsBaseUrl = toWsBase(this.baseUrl);
        this.auth = new AuthNamespace({ auth: authClient, circuits, session: this.session });
        this.storage = new StorageNamespace({ http: this.http, session: this.session, wsBaseUrl });
        this.message = new MessageNamespace({ http: this.http, session: this.session, wsBaseUrl });

        // Group keys are cached in the user's PersonalSpace (encrypted at rest
        // by StorageNamespace), so a returning member hydrates without a fresh
        // keyring round-trip. The server only ever sees the ciphertext.
        const spaceKeyCache: SpaceKeyCache = {
            loadKeys: (spaceId) => this.storage.get<Record<string, string>>("space-keys", spaceId),
            saveKeys: (spaceId, keys) => this.storage.set("space-keys", spaceId, keys),
        };
        this.space = new SpaceNamespace({
            http: this.http,
            session: this.session,
            wsBaseUrl,
            cache: spaceKeyCache,
        });
    }

    /** The currently signed-in user, or `null`. */
    get user() {
        return this.auth.user;
    }

    /** Whether a token-bearing session is active. */
    get isAuthenticated(): boolean {
        return this.session.isAuthenticated;
    }
}

export default Client;
