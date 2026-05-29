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
import type { CircuitUrls } from "../auth/proof";
import { HttpClient } from "./HttpClient";
import { SessionState, type SessionStore } from "./Session";
import { AuthNamespace } from "./namespaces/AuthNamespace";
import { StorageNamespace } from "./namespaces/StorageNamespace";
import { MessageNamespace } from "./namespaces/MessageNamespace";

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
    /** Absolute URL of the accelerator worker (trailing slash optional). */
    baseUrl: string;
    /**
     * URLs of the `preimagePoK` circuit assets used for ZK login proofs.
     * Defaults to `${baseUrl}/circuits/build/preimagePoK{.wasm,_0001.zkey}`,
     * which is where the accelerator serves them.
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

function defaultCircuits(baseUrl: string): CircuitUrls {
    const base = baseUrl.replace(/\/+$/, "");
    return {
        wasmUrl: `${base}/circuits/build/preimagePoK.wasm`,
        zkeyUrl: `${base}/circuits/build/preimagePoK_0001.zkey`,
    };
}

export class Client {
    readonly baseUrl: string;

    /** Authentication — `client.auth.zk.login(...)`, etc. */
    readonly auth: AuthNamespace;
    /** Per-user persistent storage — `client.storage.set(...)`, etc. */
    readonly storage: StorageNamespace;
    /** Realtime messaging — `client.message.subscribe(...)`, etc. */
    readonly message: MessageNamespace;

    private readonly session: SessionState;
    private readonly http: HttpClient;

    constructor(options: ClientOptions) {
        if (!options?.baseUrl) throw new Error("Client: `baseUrl` is required");
        if (options.logLevel && typeof globalThis.appLogger?.setLevel === "function") {
            globalThis.appLogger.setLevel(options.logLevel);
        }

        this.baseUrl = options.baseUrl.replace(/\/+$/, "");
        this.session = new SessionState(options.sessionStore);

        this.http = new HttpClient({
            baseUrl: this.baseUrl,
            apiKey: options.apiKey,
            getSessionToken: () => this.session.token,
            fetch: options.fetch,
        });

        const circuits = options.circuits ?? defaultCircuits(this.baseUrl);
        const authClient = new AuthClient({ baseUrl: this.baseUrl, fetch: this.http.fetch });

        const wsBaseUrl = toWsBase(this.baseUrl);
        this.auth = new AuthNamespace({ auth: authClient, circuits, session: this.session });
        this.storage = new StorageNamespace({ http: this.http, session: this.session, wsBaseUrl });
        this.message = new MessageNamespace({ http: this.http, session: this.session, wsBaseUrl });
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
