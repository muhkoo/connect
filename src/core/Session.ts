/**
 * `SessionState` — the in-memory source of truth for "who is signed in" on a
 * {@link Client}.
 *
 * It separates two concerns that have different lifetimes and security
 * properties:
 *
 *   - **session** (`{ token, username, commitment }`) — proves the user is
 *     authenticated to the accelerator. Cheap to persist (the token is an
 *     opaque server-side handle) and enough to authorize token-gated REST
 *     calls. Restored from a {@link SessionStore} across reloads.
 *
 *   - **identity** ({@link ZkIdentity}) — the derived secret + keypairs. Lets
 *     the client *prove* ownership (ZK), derive at-rest encryption keys, and
 *     run the messaging ratchet. It is derived from `(username, password)` and
 *     is deliberately **never** persisted by default — a restored session has
 *     a valid token but no identity until the user re-derives it
 *     (`client.auth.zk.unlock(password)`).
 *
 * This split is what makes `restore()` (authenticated, can't decrypt) and
 * `unlock()` (now can decrypt) two distinct, intentional states.
 */

import type { ZkIdentity } from "../auth/identity";

/** The persistable part of a session — safe-ish to keep across reloads. */
export interface StoredSession {
    token: string;
    username: string;
    /** Decimal-string Poseidon commitment — the user's stable id. */
    commitment: string;
}

/**
 * Pluggable persistence for the session token. Browser apps typically back
 * this with `localStorage`; the default is in-memory (lost on reload).
 *
 * Identity material is intentionally not part of this interface — see the
 * class docs. Apps that want federated session restore without re-prompting
 * for a password can persist it themselves and call `unlock()` on boot.
 */
export interface SessionStore {
    load(): StoredSession | null | Promise<StoredSession | null>;
    save(session: StoredSession): void | Promise<void>;
    clear(): void | Promise<void>;
}

/** Default in-memory store — holds the session for the process lifetime only. */
export class MemorySessionStore implements SessionStore {
    private current: StoredSession | null = null;
    load(): StoredSession | null {
        return this.current;
    }
    save(session: StoredSession): void {
        this.current = session;
    }
    clear(): void {
        this.current = null;
    }
}

/**
 * A {@link SessionStore} backed by the browser's `localStorage`, so a session
 * survives page reloads. This is the store most browser apps want — pass it to
 * `new Client({ sessionStore: new LocalStorageSessionStore() })`.
 *
 * Browser-only: construction throws if `localStorage` is unavailable (Node,
 * Workers, or SSR before hydration) — use {@link MemorySessionStore} or a
 * custom store there. Keys are namespaced under `keyPrefix` so multiple apps
 * on the same origin don't collide.
 */
export class LocalStorageSessionStore implements SessionStore {
    private readonly tokenKey: string;
    private readonly usernameKey: string;
    private readonly commitmentKey: string;

    constructor(keyPrefix = "muhkoo.session.") {
        if (typeof localStorage === "undefined") {
            throw new Error(
                "LocalStorageSessionStore requires a browser environment with localStorage; " +
                    "use MemorySessionStore (or a custom SessionStore) on the server.",
            );
        }
        this.tokenKey = `${keyPrefix}token`;
        this.usernameKey = `${keyPrefix}username`;
        this.commitmentKey = `${keyPrefix}commitment`;
    }

    load(): StoredSession | null {
        const token = localStorage.getItem(this.tokenKey);
        const username = localStorage.getItem(this.usernameKey);
        const commitment = localStorage.getItem(this.commitmentKey);
        if (!token || !username || !commitment) return null;
        return { token, username, commitment };
    }

    save(session: StoredSession): void {
        localStorage.setItem(this.tokenKey, session.token);
        localStorage.setItem(this.usernameKey, session.username);
        localStorage.setItem(this.commitmentKey, session.commitment);
    }

    clear(): void {
        localStorage.removeItem(this.tokenKey);
        localStorage.removeItem(this.usernameKey);
        localStorage.removeItem(this.commitmentKey);
    }
}

/**
 * The {@link SessionStore} a {@link Client} uses when none is supplied: a
 * {@link LocalStorageSessionStore} in the browser (so sessions survive
 * reloads), falling back to {@link MemorySessionStore} anywhere `localStorage`
 * is unavailable or unusable (Node, Workers, SSR, or private-mode browsers
 * that throw on access). Pass an explicit store to override.
 */
export function defaultSessionStore(keyPrefix?: string): SessionStore {
    try {
        // Touch the API, not just `typeof`: some environments expose
        // `localStorage` but throw on access (Safari private mode, sandboxed
        // iframes). LocalStorageSessionStore's constructor only checks for
        // existence, so probe a real read here and fall back on any throw.
        if (typeof localStorage !== "undefined") {
            localStorage.getItem("muhkoo.__probe__");
            return new LocalStorageSessionStore(keyPrefix);
        }
    } catch {
        // fall through to in-memory
    }
    return new MemorySessionStore();
}

export class SessionState {
    private session: StoredSession | null = null;
    private _identity: ZkIdentity | null = null;
    /** The 32-byte master seed, in-memory only (never persisted). Held after
     *  login/register so additional recovery factors (passkey, phrase) can be
     *  enrolled, and a password can be changed, without re-deriving. */
    private _seed: Uint8Array | null = null;
    private readonly store: SessionStore;

    constructor(store?: SessionStore) {
        this.store = store ?? new MemorySessionStore();
    }

    /** True once a token-bearing session exists (regardless of identity). */
    get isAuthenticated(): boolean {
        return this.session !== null;
    }

    /** True once identity material is available (login or unlock happened). */
    get isUnlocked(): boolean {
        return this._identity !== null;
    }

    get token(): string | null {
        return this.session?.token ?? null;
    }

    get username(): string | null {
        return this.session?.username ?? null;
    }

    get commitment(): string | null {
        return this.session?.commitment ?? null;
    }

    get identity(): ZkIdentity | null {
        return this._identity;
    }

    /** Identity material, throwing a clear error when the client is locked. */
    requireIdentity(): ZkIdentity {
        if (!this._identity) {
            throw new Error(
                "This operation needs the user's identity. Call `client.auth.zk.login()` " +
                "or `client.auth.zk.unlock(password)` first.",
            );
        }
        return this._identity;
    }

    /** Persist + hold a freshly authenticated session. */
    async setSession(session: StoredSession): Promise<void> {
        this.session = session;
        await this.store.save(session);
    }

    /** Attach derived identity material to the current session. */
    setIdentity(identity: ZkIdentity): void {
        this._identity = identity;
    }

    /** The in-memory master seed (or null when locked / not held). */
    get seed(): Uint8Array | null {
        return this._seed;
    }

    /** Hold the master seed in memory (set on login/register when available). */
    setSeed(seed: Uint8Array | null): void {
        this._seed = seed;
    }

    /** Load a persisted session (used by `restore()`); identity stays null. */
    async loadPersisted(): Promise<StoredSession | null> {
        const loaded = await this.store.load();
        if (loaded) this.session = loaded;
        return loaded;
    }

    /** Drop all session + identity state and clear persistence. */
    async clear(): Promise<void> {
        this.session = null;
        this._identity = null;
        if (this._seed) this._seed.fill(0); // wipe the master seed
        this._seed = null;
        await this.store.clear();
    }
}

export default SessionState;
