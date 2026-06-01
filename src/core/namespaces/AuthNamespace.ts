/**
 * `client.auth` — user authentication, exposed today through the `zk`
 * sub-namespace (`client.auth.zk.login(...)`). Leaving room under `auth` for
 * other strategies later (e.g. `auth.oauth`) without reshaping the surface.
 *
 * `ZkAuth` absorbs the full ZK register/login dance that used to live in the
 * web app's `AuthContext`:
 *
 *   register:  derive identity → commitment → POST /api/auth/zk-register
 *   login:     derive identity → challenge → Groth16 proof → sign →
 *              POST /api/auth/zk-authenticate → session token
 *
 * The derived {@link ZkIdentity} (secret + ECDSA/ECDH keypairs) is held in
 * {@link SessionState} so the storage + message namespaces can reuse it for
 * at-rest encryption and the messaging ratchet without re-deriving.
 */

import { AuthClient } from "../../auth/AuthClient";
import { deriveIdentity, type ZkIdentity } from "../../auth/identity";
import { generateAuthProof, buildCommitment, type CircuitUrls } from "../../auth/proof";
import { exportPublicKeyHex, exportPublicKeyBase64, signMessage } from "../../auth/keys";
import type { SessionState } from "../Session";

/** What the auth methods resolve to — the stable, non-secret user facts. */
export interface AuthUser {
    username: string;
    /** Decimal-string Poseidon commitment — the user's stable id. */
    commitment: string;
}

export interface RegisterParams {
    username: string;
    password: string;
    email?: string | null;
    /** Sign in immediately after registering (default: true). */
    login?: boolean;
}

export interface LoginOptions {
    /** Ask the accelerator for a long-lived (30d) session (default: false). */
    rememberMe?: boolean;
}

export interface ZkAuthDeps {
    auth: AuthClient;
    circuits: CircuitUrls;
    session: SessionState;
}

/**
 * ZK identity auth. One instance per {@link Client}; reads/writes the shared
 * {@link SessionState}.
 */
export class ZkAuth {
    constructor(private readonly deps: ZkAuthDeps) {}

    /**
     * Register a new user, then (by default) sign them in. The identity is
     * derived deterministically from `(username, password)` — the same inputs
     * reproduce it on any device, so there's no key material to ship around.
     */
    async register(params: RegisterParams): Promise<AuthUser> {
        const { username, password, email = null, login = true } = params;
        const identity = await deriveIdentity(username, password);
        const commitment = await this.commitmentFor(identity);

        await this.deps.auth.register({
            username,
            commitment,
            ecdhPublicKey: await exportPublicKeyBase64(identity.ecdhKeyPair.publicKey),
            ecdsaPublicKey: await exportPublicKeyBase64(identity.ecdsaKeyPair.publicKey),
            email,
        });

        if (login) {
            return this.login(username, password);
        }
        return { username, commitment };
    }

    /**
     * Sign in: re-derive the identity, prove knowledge of it against a fresh
     * server challenge, and trade the proof for a session token. On success
     * both the session and the identity are stored on the client.
     */
    async login(username: string, password: string, opts: LoginOptions = {}): Promise<AuthUser> {
        const identity = await deriveIdentity(username, password);
        return this.proveAndStore(username, identity, opts);
    }

    /**
     * Silently re-authenticate the current user without prompting for a
     * password. Only possible while the client is **unlocked** — i.e. the
     * derived {@link ZkIdentity} (secret + keypairs) is still in memory from a
     * prior `login()`/`unlock()`. Re-runs the full challenge→proof→authenticate
     * dance with that in-memory identity and swaps in the fresh token.
     *
     * Returns `true` if a new session was minted, `false` if recovery isn't
     * possible (no active user, or locked — the identity was never derived or
     * was lost on reload). A `false` result is the app's cue to send the user
     * back to the login screen.
     *
     * Used automatically by the {@link Client} when a token-gated request comes
     * back `401` (stale/expired token), so transient session expiry self-heals
     * instead of surfacing errors mid-session.
     */
    async recover(): Promise<boolean> {
        const username = this.deps.session.username;
        const identity = this.deps.session.identity;
        if (!username || !identity) return false;
        try {
            await this.proveAndStore(username, identity, {});
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Shared sign-in core: prove knowledge of `identity` against a fresh
     * challenge and persist the resulting session + identity. Used by both
     * `login()` (identity derived from a password) and `recover()` (identity
     * already in memory).
     */
    private async proveAndStore(
        username: string,
        identity: ZkIdentity,
        opts: LoginOptions,
    ): Promise<AuthUser> {
        const ecdsaPubHex = await exportPublicKeyHex(identity.ecdsaKeyPair.publicKey);

        const challenge = await this.deps.auth.getChallenge(username);

        const { proof, publicSignals, commitment } = await generateAuthProof({
            secretHex: identity.secretHex,
            saltHex: identity.saltHex,
            ecdsaPubHex,
            nonceHex: challenge.nonce,
            circuits: this.deps.circuits,
        });

        const signature = await signMessage(JSON.stringify(proof), identity.ecdsaKeyPair.privateKey);

        const result = await this.deps.auth.authenticate({
            challengeId: challenge.challengeId,
            proof: {
                commitment,
                // The accelerator expects the original hex nonce here, not the
                // field-reduced version fed into the circuit.
                nonce: challenge.nonce,
                response: { proof, publicSignals },
                signature,
            },
            rememberMe: opts.rememberMe,
        });

        await this.deps.session.setSession({
            token: result.token,
            username: result.username,
            commitment,
        });
        this.deps.session.setIdentity(identity);

        return { username: result.username, commitment };
    }

    /**
     * Restore a persisted session on boot. Validates the stored token with the
     * accelerator; returns the user when valid, or `null` (and clears the
     * stale session) otherwise. Identity stays locked — call {@link unlock}
     * to re-enable encryption/messaging without a full re-login.
     */
    async restore(): Promise<AuthUser | null> {
        const stored = await this.deps.session.loadPersisted();
        if (!stored) return null;
        try {
            await this.deps.auth.verify(stored.token);
            return { username: stored.username, commitment: stored.commitment };
        } catch {
            await this.deps.session.clear();
            return null;
        }
    }

    /**
     * Re-derive identity material for an already-authenticated (restored)
     * session, so the client can decrypt storage and run the ratchet. Verifies
     * the password by checking the derived commitment matches the session's.
     */
    async unlock(password: string): Promise<void> {
        const username = this.deps.session.username;
        const expected = this.deps.session.commitment;
        if (!username || !expected) {
            throw new Error("ZkAuth.unlock: no active session to unlock — sign in first.");
        }
        const identity = await deriveIdentity(username, password);
        const commitment = await this.commitmentFor(identity);
        if (commitment !== expected) {
            throw new Error("ZkAuth.unlock: incorrect password (commitment mismatch).");
        }
        this.deps.session.setIdentity(identity);
    }

    /** Sign out: clears the session, identity, and persisted token. */
    async logout(): Promise<void> {
        await this.deps.session.clear();
    }

    /** The signed-in user, or `null`. Synchronous read of current state. */
    get user(): AuthUser | null {
        const username = this.deps.session.username;
        const commitment = this.deps.session.commitment;
        return username && commitment ? { username, commitment } : null;
    }

    /**
     * The derived identity material for the current session, or `null` when
     * locked. Exposed so apps that still drive lower-level primitives (e.g. a
     * chat ratchet keyed off the same identity) can reuse it without
     * re-deriving from the password.
     */
    get identity(): ZkIdentity | null {
        return this.deps.session.identity;
    }

    /** The current session token, or `null` when signed out. */
    get token(): string | null {
        return this.deps.session.token;
    }

    // -------------------------------------------------------------------------

    /** Poseidon commitment for an identity — the value the server stores. */
    private async commitmentFor(identity: ZkIdentity): Promise<string> {
        // generateAuthProof recomputes this internally, but registration needs
        // it before any challenge exists, so derive it directly here.
        const ecdsaPubHex = await exportPublicKeyHex(identity.ecdsaKeyPair.publicKey);
        return buildCommitment(identity.secretHex, identity.saltHex, ecdsaPubHex);
    }
}

/** `client.auth` — the auth namespace. Strategies hang off here. */
export class AuthNamespace {
    readonly zk: ZkAuth;
    constructor(deps: ZkAuthDeps) {
        this.zk = new ZkAuth(deps);
    }

    /** Convenience pass-through: the currently signed-in user, or `null`. */
    get user(): AuthUser | null {
        return this.zk.user;
    }
}

export default AuthNamespace;
