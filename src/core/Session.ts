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

export class SessionState {
    private session: StoredSession | null = null;
    private _identity: ZkIdentity | null = null;
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
        await this.store.clear();
    }
}

export default SessionState;
