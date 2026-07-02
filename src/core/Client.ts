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
import { ChatKeyVault, type ChatKeyStore } from "./ChatKeyVault";
import type { WrappedPayload } from "../crypto/PassphraseWrap";
import { OfflineManager } from "../offline/OfflineManager";
import { isOfflineCapable } from "../offline/detect";
import { IndexedDbStore } from "../offline/store/IndexedDbStore";
import { NoopStore } from "../offline/store/NoopStore";
import type { OfflineStore } from "../offline/store/OfflineStore";
import { KvCache } from "../offline/KvCache";
import { DbCache } from "../offline/DbCache";
import { ShardClient } from "../storage/transport/ShardClient";

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
    /**
     * Offline support (`client.offline`) — transparent local caching + a durable
     * write queue + CRDT sync. **On by default in browsers** (IndexedDB + Cache
     * API present), a no-op everywhere else. Override to force it on/off or to
     * supply a custom {@link OfflineStore}.
     */
    offline?: {
        /** Force enable/disable. Default: auto-detect (browser on, Node off). */
        enabled?: boolean;
        /** Pluggable persistence. Default: IndexedDB in the browser. */
        store?: OfflineStore;
        /** Cache file-shard bytes in the Cache API. Default: true in the browser. */
        cacheShards?: boolean;
        /** Soft cap on durable-queue bytes before degrading to online-only. */
        maxQueueBytes?: number;
    };
    /**
     * Peer-to-peer block exchange (`client.space` files) among Space members,
     * over WebRTC signaled on the Space relay. Best-effort — falls back to
     * origin. **Opt-in** (browser only). Pass `workerFactory` to run the block
     * engine off the main thread.
     */
    p2p?: {
        enabled?: boolean;
        workerFactory?: () => Worker;
        iceServers?: RTCIceServer[];
        maxPeers?: number;
        /** Log P2P mesh + block-exchange activity to the console (staging/dev). */
        debug?: boolean;
    };
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
    /** Offline cache + sync — `client.offline.status`, `client.offline.snapshot`, etc. */
    readonly offline: OfflineManager;

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

        // Offline layer. On by default in browsers, a no-op (NoopStore) in Node,
        // Workers, and SSR — so existing consumers are unaffected unless they're
        // in a browser that can actually cache.
        const offlineEnabled = options.offline?.enabled ?? isOfflineCapable();
        const offlineStore: OfflineStore = offlineEnabled
            ? (options.offline?.store ?? new IndexedDbStore())
            : new NoopStore();
        this.offline = new OfflineManager({
            store: offlineStore,
            session: this.session,
            enabled: offlineEnabled,
        });

        // Wrap fetch so every accelerator round-trip feeds the connectivity
        // detector: a thrown fetch is the strongest "offline" signal, a 2xx the
        // strongest "online" one. Only when offline support is active.
        const baseFetch = options.fetch ?? globalThis.fetch?.bind(globalThis);
        const reportingFetch: typeof fetch | undefined =
            offlineEnabled && baseFetch
                ? async (input, init) => {
                      try {
                          const res = await baseFetch(input, init);
                          this.offline.reportFetchSuccess();
                          return res;
                      } catch (err) {
                          this.offline.reportFetchFailure();
                          throw err;
                      }
                  }
                : options.fetch;

        this.http = new HttpClient({
            baseUrl: this.baseUrl,
            apiKey: options.apiKey,
            getSessionToken: () => this.session.token,
            fetch: reportingFetch,
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
        const deferShardUpload = offlineEnabled
            ? (hash: string) => this.offline.deferShardUpload(hash)
            : undefined;

        const kvCache = offlineEnabled ? new KvCache(this.offline) : undefined;
        this.kv = new KvNamespace({ http: this.http, session: this.session, wsBaseUrl, offline: kvCache });
        if (offlineEnabled) this.offline.registerReplayer("kv", (e) => this.kv.replay(e));
        const dbCache = offlineEnabled ? new DbCache(this.offline) : undefined;
        this.db = new DbNamespace({ http: this.http, offline: dbCache });
        if (offlineEnabled) this.offline.registerReplayer("db", (e) => this.db.replay(e));
        this.storage = new StorageNamespace({
            http: this.http,
            baseUrl: this.baseUrl,
            kv: this.kv,
            shardCache: this.offline.fileCache,
            deferShardUpload,
        });
        this.message = new MessageNamespace({ http: this.http, session: this.session, wsBaseUrl });

        // Group keys are cached in the user's PersonalSpace (encrypted at rest
        // by client.kv), so a returning member hydrates without a fresh keyring
        // round-trip. The server only ever sees ciphertext.
        //
        // `encrypt: false` is deliberate: the keyring already ECIES-wraps each
        // key to the member's identity (server-blind), and StorageCipher would
        // additionally require the FULL unlocked identity (`requireIdentity()`),
        // which is locked after a page reload — that coupling is exactly why the
        // cache previously never read or persisted. The wrapped blobs are opaque.
        const spaceKeyCache: SpaceKeyCache = {
            loadKeys: (spaceId) => this.kv.get<Record<string, string>>("space-keys", spaceId),
            saveKeys: (spaceId, keys) => this.kv.set("space-keys", spaceId, keys, { encrypt: false }),
        };
        // SDK-owned vault for the member's long-lived ratchet/space keypair.
        // Stored at the personal-space `chat-keys` key (same key the app used to
        // manage by hand), seed-wrapped, session-token authed (no snarkjs). This
        // gives every app a STABLE keypair across reloads — no per-app scaffolding
        // — so members don't re-admit each load and the group-key cache works.
        const chatKeyStore: ChatKeyStore = {
            get: async (key) => {
                const c = this.session.commitment;
                if (!c) return null;
                const res = await this.http.post<{ value: unknown }>(
                    `/api/personal/${encodeURIComponent(c)}/kv/${encodeURIComponent(key)}/get`,
                    {},
                );
                return (res?.value ?? null) as WrappedPayload | null;
            },
            put: async (key, value) => {
                const c = this.session.commitment;
                if (!c) throw new Error("ChatKeyVault: no session — sign in first.");
                await this.http.post(`/api/personal/${encodeURIComponent(c)}/kv/${encodeURIComponent(key)}`, { value });
            },
        };
        const chatKeys = new ChatKeyVault(chatKeyStore);

        this.space = new SpaceNamespace({
            http: this.http,
            session: this.session,
            wsBaseUrl,
            cache: spaceKeyCache,
            offline: this.offline,
            p2p: options.p2p,
            chatKeys,
        });
        this.agents = new AgentsNamespace({ http: this.http });
        this.functions = new FunctionsNamespace({ http: this.http, fnHostSuffix: options.functionsHostSuffix });

        // Replay deferred shard uploads on reconnect. The bytes live in the
        // Cache API keyed by hash; re-PUT them through a (defer-free) shard
        // client so a failure surfaces as transient and the entry stays queued.
        if (offlineEnabled && this.offline.fileCache) {
            const replayShards = new ShardClient({
                baseUrl: this.baseUrl,
                pathPrefix: "/api/shards",
                fetch: this.http.fetch,
                cache: this.offline.fileCache,
            });
            this.offline.registerReplayer("file", async (entry) => {
                const { hash } = entry.args as { hash: string };
                const bytes = await this.offline.fileCache!.get(hash);
                if (!bytes) return; // evicted from cache — nothing to replay
                await replayShards.putShard(hash, bytes);
            });
        }
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
