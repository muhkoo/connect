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
import { deriveIdentity, deriveIdentityFromSeed, deriveMasterSeedFromPassword, type ZkIdentity } from "../../auth/identity";
import { seedToMnemonic, mnemonicToSeed } from "../../auth/recoveryPhrase";
import { generateAuthProof, buildCommitment, type CircuitUrls } from "../../auth/proof";
import { exportPublicKeyHex, exportPublicKeyBase64, signMessage } from "../../auth/keys";
import {
    randomSeed, passwordPreHash, wrapKeyFromOprf, wrapKeyFromBytes, wrapSeed, unwrapSeed, toBase64, fromBase64,
} from "../../auth/vault";
import { oprfBlind, oprfFinalize } from "../../auth/oprf";
import { emailFactorInput, googleFactorInput, gatedBlind, gatedWrapKey } from "../../auth/gatedFactor";
import { passkeySupported, passkeyPrfCapable, createPasskeyWithPrf, evaluatePasskeyPrf, defaultRpId } from "../../auth/passkey";
import type { SessionState } from "../Session";
import { HostedAuth } from "./HostedAuth";

/**
 * Thrown when the identity vault can't be reached to unlock the seed — a network
 * failure, a 5xx, or the per-user rate limit (429). This is distinct from a wrong
 * password, and is surfaced so `login`/`unlock` do NOT silently fall back to the
 * legacy password derivation (which, for a vault account, yields a misleading
 * "commitment mismatch"). Callers should ask the user to retry, not re-enter a
 * password.
 */
export class VaultUnavailableError extends Error {
    constructor(cause?: unknown) {
        const detail = cause instanceof Error ? cause.message : String(cause ?? "");
        super(
            /too many|rate.?limit|\b429\b/i.test(detail)
                ? "Too many attempts — please wait a moment and try again."
                : "Couldn't reach the secure vault. Check your connection and try again.",
        );
        this.name = "VaultUnavailableError";
        (this as Error & { cause?: unknown }).cause = cause;
    }
}

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
     * Register a new user, then (by default) sign them in.
     *
     * M1.0: the identity now descends from a **random master seed** (not the
     * password), so it's recoverable + the password can be changed. We register
     * the commitment, sign in with the in-memory identity to get a token, then
     * enroll the OPRF-gated **password factor** (the seed wrapped under a key the
     * server can't derive offline). Future logins unlock the seed via that factor.
     */
    async register(params: RegisterParams): Promise<AuthUser> {
        const { username, password, email = null, login = true } = params;
        const seed = randomSeed();
        const identity = await deriveIdentityFromSeed(seed);
        const commitment = await this.commitmentFor(identity);

        await this.deps.auth.register({
            username,
            commitment,
            ecdhPublicKey: await exportPublicKeyBase64(identity.ecdhKeyPair.publicKey),
            ecdsaPublicKey: await exportPublicKeyBase64(identity.ecdsaKeyPair.publicKey),
            email,
        });

        // Sign in with the in-memory (random-seed) identity to obtain a session
        // token, then enroll the password factor so the next login can recover
        // the seed. (A token is required to write the factor.)
        const user = await this.proveAndStore(username, identity, {});
        await this.enrollPasswordFactor(username, password, seed, this.deps.session.token!);
        this.deps.session.setSeed(seed); // held so a passkey/phrase can be enrolled next

        if (!login) await this.logout();
        return user;
    }

    /**
     * Sign in. M1.0 is **vault-first**: read the password factor and OPRF-unwrap
     * the master seed → identity. If that fails (a pre-vault account, whose factor
     * is absent so the server returns a decoy, or a wrong password), fall back to
     * the legacy password-derived identity. Either way we then prove knowledge of
     * the identity and trade it for a session token.
     */
    async login(username: string, password: string, opts: LoginOptions = {}): Promise<AuthUser> {
        // Vault-first; fall back to the legacy password-derived seed (pre-vault
        // accounts). Either way we end up with the master seed, which we hold so
        // recovery factors can be enrolled.
        const vaultSeed = await this.tryUnlockSeed(username, password);
        const seed = vaultSeed ?? await deriveMasterSeedFromPassword(username, password);
        const identity = await deriveIdentityFromSeed(seed);
        const user = await this.proveAndStore(username, identity, opts);
        this.deps.session.setSeed(seed);
        // Migrate a legacy account into the vault on first vault-aware login: it has
        // no password factor (`vaultSeed` is null), so enroll one now — wrapping the
        // exact legacy-derived seed the proof just validated, so the commitment is
        // preserved. Best-effort; the legacy path still works if this fails.
        if (!vaultSeed) await this.migrateLegacyPasswordFactor(username, password, seed);
        return user;
    }

    /** Enroll the password factor for a legacy (pre-vault) account. Idempotent +
     *  best-effort; failure just means we retry on the next login. */
    private async migrateLegacyPasswordFactor(username: string, password: string, seed: Uint8Array): Promise<void> {
        const token = this.deps.session.token;
        if (!token) return;
        try {
            await this.enrollPasswordFactor(username, password, seed, token);
        } catch {
            /* migrate next time */
        }
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
     * Boot helper — call this once on app start. Restores the session AND, when a
     * passkey is enrolled, silently unlocks the identity via WebAuthn (recovering
     * the master seed so the ratchet keypair rehydrates and `client.kv` works).
     * The seed is never persisted, so a passkey (or password) is the only way to
     * unlock after a reload — this keeps that off the app's plate.
     *
     * Returns `{ user, unlocked }`. When `unlocked` is false (no passkey, the
     * user cancelled, or the browser required a gesture), prompt for a password
     * and call {@link unlock}. Apps need no key-management scaffolding beyond this.
     */
    async resume(): Promise<{ user: AuthUser | null; unlocked: boolean }> {
        const user = await this.restore();
        if (!user) return { user: null, unlocked: false };
        if (this.deps.session.isUnlocked) return { user, unlocked: true };
        try {
            const factors = await this.listFactors();
            if (factors.some((f) => f.type === "passkey")) {
                await this.loginWithPasskey(user.username);
            }
        } catch {
            /* no passkey / cancelled / no user gesture — leave locked for a prompt */
        }
        return { user, unlocked: this.deps.session.isUnlocked };
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
        const vaultSeed = await this.tryUnlockSeed(username, password);
        const seed = vaultSeed ?? await deriveMasterSeedFromPassword(username, password);
        const identity = await deriveIdentityFromSeed(seed);
        const commitment = await this.commitmentFor(identity);
        if (commitment !== expected) {
            throw new Error("ZkAuth.unlock: incorrect password (commitment mismatch).");
        }
        this.deps.session.setIdentity(identity);
        this.deps.session.setSeed(seed);
        // Migrate a legacy account into the vault if it has no password factor.
        if (!vaultSeed) await this.migrateLegacyPasswordFactor(username, password, seed);
    }

    /**
     * Generate a 24-word **recovery phrase** that encodes the master seed, and
     * record a marker in the vault so the UI knows one exists. Show the returned
     * phrase to the user ONCE — it's never stored server-side (the phrase *is* the
     * seed). Requires being signed in (the seed must be held in memory).
     */
    async enrollRecoveryPhrase(): Promise<string> {
        const seed = this.deps.session.seed;
        const token = this.deps.session.token;
        if (!seed || !token) {
            throw new Error("Sign in first to set up a recovery phrase.");
        }
        const mnemonic = seedToMnemonic(seed);
        await this.deps.auth.vaultPutFactor(token, { id: "phrase", type: "phrase-marker", createdAt: Date.now() });
        return mnemonic;
    }

    /**
     * Recover an account with its recovery phrase (the "forgot password" path).
     * Decodes the phrase to the master seed → identity → session. After this,
     * call {@link changePassword} to set a new password. No server lookup needed.
     */
    async recoverWithPhrase(username: string, mnemonic: string, opts: LoginOptions = {}): Promise<AuthUser> {
        const seed = mnemonicToSeed(mnemonic);
        const identity = await deriveIdentityFromSeed(seed);
        const user = await this.proveAndStore(username, identity, opts);
        this.deps.session.setSeed(seed);
        return user;
    }

    /**
     * Add an **email** as a recovery + login factor (M2 verification-gated:
     * the server only releases the split-key OPRF eval after the address is
     * OTP-verified). Sends the code, then returns a `confirm` continuation:
     *
     *   const { confirm } = await client.auth.zk.enrollEmailFactor("me@x.com");
     *   await confirm(codeFromInbox);
     *
     * Requires being signed in with the seed held (like the other enrolls).
     * Custody note: gated factors trade some custody for recoverability — the
     * trade-off should be disclosed in the enroll UI.
     */
    async enrollEmailFactor(email: string): Promise<{ email: string; confirm: (code: string) => Promise<void> }> {
        const seed = this.deps.session.seed;
        const token = this.deps.session.token;
        const username = this.deps.session.username;
        if (!seed || !token || !username) {
            throw new Error("Sign in first to add a recovery email.");
        }
        await this.deps.auth.emailOtpStart({ token, email });
        return {
            email,
            confirm: async (code: string) => {
                const { verifyToken, email: verified } = await this.deps.auth.emailOtpVerify({ token, code });
                const input = await emailFactorInput(username, verified);
                const { blind, blinded } = gatedBlind(input);
                const evals = await this.deps.auth.oprfEvaluateGated(username, toBase64(blinded), "email", "enroll", verifyToken);
                const key = await gatedWrapKey(input, blind, evals.evaluated, evals.evaluated2);
                const wrapped = await wrapSeed(seed, key);
                await this.deps.auth.vaultPutFactor(
                    token,
                    { id: "email", type: "email", wrap: wrapped.ct, iv: wrapped.iv, params: { email: verified }, createdAt: Date.now() },
                    verifyToken,
                );
            },
        };
    }

    /**
     * Recover an account via its enrolled **email** factor. Sends a code to the
     * enrolled address (the response never reveals whether one exists), then
     * `confirm(code)` completes: gated read + split-key eval → unwrap seed →
     * normal ZK login. After this, call {@link changePassword} to set a new
     * password.
     *
     *   const { confirm } = await client.auth.zk.recoverWithEmail("alice");
     *   const user = await confirm(codeFromInbox);
     */
    async recoverWithEmail(username: string, opts: LoginOptions = {}): Promise<{ confirm: (code: string) => Promise<AuthUser> }> {
        await this.deps.auth.emailOtpStart({ username });
        return {
            confirm: async (code: string) => {
                const { verifyToken, email } = await this.deps.auth.emailOtpVerify({ username, code });
                const { factor } = await this.deps.auth.vaultRead(username, "email", verifyToken);
                if (!factor?.wrap || !factor?.iv) {
                    throw new Error("This account has no email recovery set up.");
                }
                const input = await emailFactorInput(username, email);
                const { blind, blinded } = gatedBlind(input);
                const evals = await this.deps.auth.oprfEvaluateGated(username, toBase64(blinded), "email", "recover", verifyToken);
                const key = await gatedWrapKey(input, blind, evals.evaluated, evals.evaluated2);
                const seed = await unwrapSeed({ iv: factor.iv, ct: factor.wrap }, key);
                const identity = await deriveIdentityFromSeed(seed);
                const user = await this.proveAndStore(username, identity, opts);
                this.deps.session.setSeed(seed);
                return user;
            },
        };
    }

    // --- Google factor (M2.3) ------------------------------------------------
    // Google is pure authentication UX: its verified ID token gates the
    // split-key OPRF eval that releases the master seed. The ZK identity layer
    // is unchanged. The app obtains `idToken` via Google Identity Services and
    // passes it in; the SDK never renders Google UI.

    /**
     * Link a Google account as a recovery + login factor. Requires being signed
     * in with the seed held. `idToken` is a fresh Google ID token (GIS).
     */
    async enrollGoogleFactor(idToken: string): Promise<void> {
        const seed = this.deps.session.seed;
        const token = this.deps.session.token;
        const username = this.deps.session.username;
        if (!seed || !token || !username) throw new Error("Sign in first to link a Google account.");
        const { verifyToken, sub, emailHint } = await this.deps.auth.googleVerify({ idToken, token });
        const input = await googleFactorInput(username, sub);
        const { blind, blinded } = gatedBlind(input);
        const evals = await this.deps.auth.oprfEvaluateGated(username, toBase64(blinded), "google", "enroll", verifyToken);
        const key = await gatedWrapKey(input, blind, evals.evaluated, evals.evaluated2);
        const wrapped = await wrapSeed(seed, key);
        await this.deps.auth.vaultPutFactor(
            token,
            { id: "google", type: "google", wrap: wrapped.ct, iv: wrapped.iv, params: { sub, emailHint: emailHint ?? undefined }, createdAt: Date.now() },
            verifyToken,
        );
    }

    /**
     * Sign in with Google — verify the ID token, unlock the seed via the gated
     * split-key eval, and establish a session. Same machinery serves "Sign in
     * with Google" and "recover with Google"; the account must have linked the
     * factor first.
     */
    async loginWithGoogle(username: string, idToken: string, opts: LoginOptions = {}): Promise<AuthUser> {
        const { verifyToken, sub } = await this.deps.auth.googleVerify({ idToken, username });
        const { factor } = await this.deps.auth.vaultRead(username, "google", verifyToken);
        if (!factor?.wrap || !factor?.iv) throw new Error("No Google account is linked to this username.");
        const input = await googleFactorInput(username, sub);
        const { blind, blinded } = gatedBlind(input);
        const evals = await this.deps.auth.oprfEvaluateGated(username, toBase64(blinded), "google", "recover", verifyToken);
        const key = await gatedWrapKey(input, blind, evals.evaluated, evals.evaluated2);
        const seed = await unwrapSeed({ iv: factor.iv, ct: factor.wrap }, key);
        const identity = await deriveIdentityFromSeed(seed);
        const user = await this.proveAndStore(username, identity, opts);
        this.deps.session.setSeed(seed);
        return user;
    }

    /**
     * Register a brand-new, **passwordless** account whose only factor is Google.
     * A random master seed is generated and wrapped under the Google-gated key;
     * the user can add a password / passkey / phrase later. The ZK registration
     * is identical to a password signup.
     */
    async registerWithGoogle(username: string, idToken: string): Promise<AuthUser> {
        const seed = randomSeed();
        const identity = await deriveIdentityFromSeed(seed);
        const commitment = await this.commitmentFor(identity);
        await this.deps.auth.register({
            username,
            commitment,
            ecdhPublicKey: await exportPublicKeyBase64(identity.ecdhKeyPair.publicKey),
            ecdsaPublicKey: await exportPublicKeyBase64(identity.ecdsaKeyPair.publicKey),
            email: null,
        });
        const user = await this.proveAndStore(username, identity, {});
        this.deps.session.setSeed(seed);
        // Enroll Google as the sole factor (session + seed are now in hand).
        await this.enrollGoogleFactor(idToken);
        return user;
    }

    /**
     * Change the password — re-wraps the (unchanged) master seed under the new
     * password's OPRF-gated key. The identity/commitment never moves. Requires
     * being signed in (or freshly recovered) so the seed is held.
     */
    async changePassword(newPassword: string): Promise<void> {
        const seed = this.deps.session.seed;
        const username = this.deps.session.username;
        const token = this.deps.session.token;
        if (!seed || !username || !token) {
            throw new Error("Sign in first to change your password.");
        }
        await this.enrollPasswordFactor(username, newPassword, seed, token);
    }

    /** Whether this browser can use passkeys (WebAuthn) at all. */
    passkeyAvailable(): boolean {
        return passkeySupported();
    }

    /**
     * Whether this browser's authenticator can do the **PRF extension** our
     * passkey factor requires. A browser may support passkeys generally but not
     * PRF — in which case enrolling one would fail. Resolves `true`/`false`, or
     * `null` when it can't be determined (no capabilities API). Use this to gate
     * the passkey UI so users don't hit a dead-end error.
     */
    async passkeyPrfAvailable(): Promise<boolean | null> {
        return passkeyPrfCapable();
    }

    /**
     * Add a **passkey** recovery factor. Creates a WebAuthn passkey with PRF,
     * wraps the master seed under its PRF output, and stores the factor. The
     * passkey (synced via the platform's keychain) then unlocks the account on
     * any device — no password. Requires being signed in (seed held in memory).
     */
    async enrollPasskey(opts?: { rpId?: string; rpName?: string; label?: string }): Promise<void> {
        const seed = this.deps.session.seed;
        const token = this.deps.session.token;
        const username = this.deps.session.username;
        if (!seed || !token || !username) {
            throw new Error("Sign in first to add a passkey.");
        }
        const rpId = opts?.rpId ?? defaultRpId();
        const { credentialId, prfSalt, prfOutput } = await createPasskeyWithPrf({
            rpId,
            rpName: opts?.rpName ?? "Muhkoo",
            username,
        });
        const key = await wrapKeyFromBytes(prfOutput, "muhkoo-passkey-wrap");
        const wrapped = await wrapSeed(seed, key);
        await this.deps.auth.vaultPutFactor(token, {
            id: `passkey:${toBase64(credentialId).slice(0, 16)}`,
            type: "passkey",
            wrap: wrapped.ct,
            iv: wrapped.iv,
            params: { credentialId: toBase64(credentialId), prfSalt: toBase64(prfSalt), rpId },
            label: opts?.label ?? "Passkey",
            createdAt: Date.now(),
        });
    }

    /**
     * Sign in with a passkey (no password). Reads the passkey factor, evaluates
     * its PRF, unwraps the master seed → identity → session.
     */
    async loginWithPasskey(username: string, opts: LoginOptions = {}): Promise<AuthUser> {
        const { factor } = await this.deps.auth.vaultRead(username, "passkey");
        const params = factor?.params as { credentialId?: string; prfSalt?: string; rpId?: string } | undefined;
        if (!factor?.wrap || !factor?.iv || !params?.credentialId || !params?.prfSalt) {
            throw new Error("No passkey is set up for this account.");
        }
        const prfOutput = await evaluatePasskeyPrf(
            params.rpId ?? defaultRpId(),
            fromBase64(params.credentialId),
            fromBase64(params.prfSalt),
        );
        const key = await wrapKeyFromBytes(prfOutput, "muhkoo-passkey-wrap");
        const seed = await unwrapSeed({ iv: factor.iv, ct: factor.wrap }, key);
        const identity = await deriveIdentityFromSeed(seed);
        const user = await this.proveAndStore(username, identity, opts);
        this.deps.session.setSeed(seed);
        return user;
    }

    /**
     * List the user's enrolled login methods (metadata only). Session-authed.
     * Gated factors (email/google) carry a `masked` display hint
     * ("m•••@gmail.com"); the full value is never returned.
     */
    async listFactors(): Promise<Array<{ id: string; type: string; label?: string; createdAt?: number; masked?: string }>> {
        const token = this.deps.session.token;
        if (!token) throw new Error("Sign in first to view your login methods.");
        const { factors } = await this.deps.auth.vaultFactors(token);
        return factors;
    }

    /** Remove a login method by id (can't remove your only one). Session-authed. */
    async removeFactor(id: string): Promise<void> {
        const token = this.deps.session.token;
        if (!token) throw new Error("Sign in first to manage your login methods.");
        await this.deps.auth.vaultDeleteFactor(token, id);
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

    /**
     * The master seed as base64, or `null` when locked. The host app uses this to
     * wrap app-level data (e.g. chat ratchet keys) to the **seed** instead of the
     * password — so that data survives password changes and can be unlocked by a
     * passwordless (passkey) login, both of which recover the same seed.
     */
    get seedBase64(): string | null {
        const seed = this.deps.session.seed;
        return seed ? toBase64(seed) : null;
    }

    // -------------------------------------------------------------------------

    /** Poseidon commitment for an identity — the value the server stores. */
    private async commitmentFor(identity: ZkIdentity): Promise<string> {
        // generateAuthProof recomputes this internally, but registration needs
        // it before any challenge exists, so derive it directly here.
        const ecdsaPubHex = await exportPublicKeyHex(identity.ecdsaKeyPair.publicKey);
        return buildCommitment(identity.secretHex, identity.saltHex, ecdsaPubHex);
    }

    // ---- Identity vault (M1.0) ----------------------------------------------

    /**
     * Derive the OPRF-gated wrap key for the password factor: `scrypt(password)`
     * is blinded, evaluated by the server's secret OPRF key (so it can't be
     * derived offline), unblinded, then HKDF'd into an AES-GCM key.
     */
    private async passwordWrapKey(username: string, password: string): Promise<CryptoKey> {
        const pre = passwordPreHash(username, password);
        const { blind, blinded } = oprfBlind(pre);
        const { evaluated } = await this.deps.auth.oprfEvaluate(username, toBase64(blinded));
        return wrapKeyFromOprf(oprfFinalize(pre, blind, fromBase64(evaluated)));
    }

    /**
     * Try to recover the master seed from the password factor.
     *
     * Returns `null` only when the vault read SUCCEEDS but the seed can't be
     * unwrapped — i.e. there's no real factor (a pre-vault/legacy account, whose
     * read returns a decoy that won't unwrap) or the password is wrong. The caller
     * then legitimately falls back to the legacy password-derived identity.
     *
     * Throws {@link VaultUnavailableError} when the vault itself can't be reached
     * (network / 5xx / rate-limit) — so a *transient* failure is NOT silently
     * turned into a legacy fallback (which would surface as "commitment mismatch").
     */
    private async tryUnlockSeed(username: string, password: string): Promise<Uint8Array | null> {
        const read = await this.deps.auth
            .vaultRead(username, "password")
            .catch((e) => { throw new VaultUnavailableError(e); });
        const factor = read.factor;
        if (!factor?.wrap || !factor?.iv) return null; // genuinely no factor → legacy account

        const key = await this
            .passwordWrapKey(username, password)
            .catch((e) => { throw new VaultUnavailableError(e); }); // OPRF eval unreachable / rate-limited

        try {
            return await unwrapSeed({ iv: factor.iv, ct: factor.wrap }, key);
        } catch {
            return null; // factor present but won't unwrap → wrong password, or a decoy
        }
    }

    /**
     * Enroll/replace the password factor for `username` — wraps `seed` under the
     * OPRF-gated key and stores it (needs a session `token`).
     *
     * Retries: this is the step that persists the (otherwise in-memory-only)
     * master seed. If it fails after a fresh registration the account would be
     * unrecoverable, so we retry a few times before surfacing the error.
     */
    private async enrollPasswordFactor(username: string, password: string, seed: Uint8Array, token: string): Promise<void> {
        const key = await this.passwordWrapKey(username, password);
        const wrapped = await wrapSeed(seed, key);
        const factor = { id: "password", type: "password" as const, wrap: wrapped.ct, iv: wrapped.iv, createdAt: Date.now() };

        let lastErr: unknown;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                await this.deps.auth.vaultPutFactor(token, factor);
                return;
            } catch (err) {
                lastErr = err;
                await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
            }
        }
        throw new Error(
            "Registration could not finish securing your account (vault enrollment failed). " +
            "Please try again. " + (lastErr instanceof Error ? lastErr.message : ""),
        );
    }
}

/** `client.auth` — the auth namespace. Strategies hang off here. */
export class AuthNamespace {
    readonly zk: ZkAuth;
    /** Centralized hosted auth (auth.muhkoo.dev) — `client.auth.hosted.login(...)`. */
    readonly hosted: HostedAuth;
    constructor(deps: ZkAuthDeps & { authBaseUrl: string }) {
        this.zk = new ZkAuth(deps);
        this.hosted = new HostedAuth({ auth: deps.auth, session: deps.session, authBaseUrl: deps.authBaseUrl });
    }

    /** Convenience pass-through: the currently signed-in user, or `null`. */
    get user(): AuthUser | null {
        return this.zk.user;
    }
}

export default AuthNamespace;
