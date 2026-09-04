/**
 * `client.auth.hosted` — centralized hosted auth (auth.muhkoo.dev).
 * AUTH_HOSTED_PLAN.md; TV device pairing per `muhkoo/auth/docs/tv-device-pairing-spec.md`.
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
 *
 * ## Device pairing (v2 — TVs and other keyboard-less devices)
 *
 * The redirect flow above is unchanged and remains the fallback for anything
 * with a browser and a keyboard. A device with no redirect to receive instead
 * displays a code and **polls**:
 *
 *   TV   →  {@link startDevicePairing} → shows `userCode` + `verificationCode`
 *   user →  opens auth.muhkoo.dev/link, signs in, {@link lookupDevicePairing}
 *   user →  compares the verification code on both screens,
 *           {@link approveDevicePairing} seals the seed TO the TV's public key
 *   TV   →  {@link waitForDevicePairing} → unseal → own ZK session → persisted
 *
 * Same invariant as v1: the accelerator relays a sealed envelope it cannot read.
 * Only the key agreement changes (ECDH to a key the TV generated, instead of a
 * one-time key delivered in a URL fragment a TV can't receive).
 */

import type { AuthClient } from "../../auth/AuthClient";
import type { SessionState } from "../Session";
import type { AuthUser, LoginOptions } from "./AuthNamespace";
import { deriveIdentityFromSeed, type ZkIdentity } from "../../auth/identity";
import { exportPublicKeyHex, exportPublicKeyBase64, signMessage } from "../../auth/keys";
import { buildCommitment, generateAuthProof, defaultCircuitUrls, type CircuitUrls } from "../../auth/proof";
import {
    sealSeed, unsealSeed, generatePkce, randomState,
    generateDevicePairingKeypair, sealSeedToDevice, unsealSeedFromDevice, pairingVerificationCode,
    PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH,
} from "../../auth/hostedHandoff";
import {
    deviceIdentityKey, deviceFingerprint, persistDeviceIdentity, loadDeviceIdentity,
    clearDeviceIdentity, hasDeviceIdentity,
} from "../../auth/deviceStore";

export interface HostedAuthDeps {
    auth: AuthClient;
    session: SessionState;
    /** Base URL of the hosted auth SPA (e.g. https://auth.muhkoo.dev). */
    authBaseUrl: string;
    /**
     * Absolute URL of the accelerator (e.g. https://api.muhkoo.dev) — the origin
     * the `/api/auth/device*` endpoints live on.
     *
     * Optional for backwards compatibility: `AuthNamespace` does not pass it
     * today, so it is resolved from the {@link AuthClient} at call time (see
     * `apiBase`). Pass it explicitly whenever you construct `HostedAuth` yourself.
     */
    apiBaseUrl?: string;
    /**
     * `preimagePoK` circuit assets, used when a paired device mints its OWN ZK
     * session. Defaults to {@link defaultCircuitUrls} anchored at `apiBaseUrl` —
     * which matches `Client`'s own default. Supply it if the app overrode
     * `ClientOptions.circuits`.
     */
    circuits?: CircuitUrls;
    /** Custom fetch — defaults to `globalThis.fetch`. */
    fetch?: typeof fetch;
    /** Sleep used by the poll loop. Injectable so tests don't burn wall-clock. */
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const PKCE_STORE_KEY = "muhkoo.hosted.pkce";

// ---- device pairing: constants (tv-device-pairing-spec.md §4.5, §9) --------

/** RFC-8628-style backoff step applied on every `slow_down` (spec §9.1). */
const SLOW_DOWN_STEP_S = 5;
/** Ceiling for the transport-failure backoff, so a flaky TV Wi-Fi still recovers. */
const MAX_BACKOFF_INTERVAL_S = 30;
/** Consecutive transport failures tolerated before giving up on a pairing. */
const MAX_CONSECUTIVE_NETWORK_ERRORS = 5;
/** Server-sanitized anyway; clipped here so the request is never rejected for it. */
const DEVICE_LABEL_MAX = 64;
/** §4.4 signing-input prefixes. Changing either breaks server verification. */
const DEVICE_PAIR_SIG_PREFIX = "muhkoo-device-pair-v1";
const DEVICE_TOUCH_SIG_PREFIX = "muhkoo-device-touch-v1";

// ---- device pairing: types (tv-device-pairing-spec.md §7) ------------------

/** One in-flight pairing attempt. Hold it; pass it back into poll/wait/cancel. */
export interface DevicePairingSession {
    /** Opaque; carry it back into poll/wait/cancel. Never render it. */
    deviceCode: string;
    /** Show this, large. Formatted `"XXXX-XXXX"`. */
    userCode: string;
    /**
     * Show this too, and tell the user it must match the browser. Computed
     * LOCALLY from this device's own public key — the server's copy is never
     * trusted (that binding is the only MITM defence in the flow).
     */
    verificationCode: string;
    verificationUri: string;
    /** Same URI with the code pre-filled — render as a QR code. */
    verificationUriComplete: string;
    /** Absolute epoch-ms. */
    expiresAt: number;
    /** Server-recommended seconds between polls; may grow via `slow_down`. */
    interval: number;
    /** Ephemeral private key for this attempt. In memory only, never persisted. */
    privateKey: CryptoKey;
    /**
     * This attempt's own public half, base64 raw SEC1.
     *
     * NOT in the spec's §7 listing, but REQUIRED: `unsealSeedFromDevice` takes
     * the recipient key as a third argument because it is mixed into the KDF to
     * defeat a point-negation substitution. The shipped crypto is authoritative;
     * carrying the public half here costs nothing (a device always holds both).
     */
    devicePublicKeyB64: string;
}

/** The result of one poll. Discriminated on `status`. */
export type DevicePairingPoll =
    | { status: "pending"; interval: number; expiresIn: number }
    | { status: "slow_down"; interval: number; retryAfter: number }
    | { status: "approved"; user: AuthUser }
    | { status: "denied" }
    | { status: "expired" };

export interface StartDevicePairingOptions {
    appId: string;
    /** Human label shown to the approver. Default: a UA-derived guess. */
    label?: string;
}

export interface WaitForDevicePairingOptions {
    signal?: AbortSignal;
    /** Called before each sleep — drive a countdown / "waiting…" UI. */
    onTick?: (remainingMs: number, interval: number) => void;
}

/** A pending pairing, resolved by the approver from the typed `user_code`. */
export interface DevicePairingRequest {
    userCode: string;
    devicePublicKeyB64: string;
    /** Recomputed locally by the SDK; compare with what the TV shows. */
    verificationCode: string;
    deviceFingerprint: string;
    deviceLabel: string;
    appId: string;
    appLabel: string;
    isKnownDevice: boolean;
    requiresReauth: boolean;
    expiresAt: number;
}

/** A device the account has paired, as listed on the security page. */
export interface PairedDevice {
    id: string;
    label: string;
    appId: string;
    pairedAt: number;
    lastSeenAt: number;
    activeSession: boolean;
}

/**
 * Why a pairing ended.
 *
 * `denied` / `expired` / `aborted` / `rate_limited` are the four the spec names
 * for {@link HostedAuth.waitForDevicePairing}. The rest are additive and exist
 * because the flow genuinely produces them:
 *   - `network` — the reference loop in spec §9.2 throws it after 5 consecutive
 *     transport failures;
 *   - `commitment_mismatch` — spec §10.8's MANDATORY client check failed (the
 *     seed does not derive the commitment the server sent). This is what turns
 *     §10.2's substitution attack from silent into loud;
 *   - `account_mismatch` — spec §10.2 detection 2: this device was previously
 *     paired to a DIFFERENT account. Refuse rather than silently adopt;
 *   - `reauth_required` — see {@link ReauthRequiredError};
 *   - `invalid_user_code` — client-side canonicalization rejected the input;
 *   - `error` — anything else; read `.code` for the server's machine code.
 */
export type DevicePairingErrorReason =
    | "denied" | "expired" | "aborted" | "rate_limited" | "network"
    | "commitment_mismatch" | "account_mismatch" | "reauth_required"
    | "invalid_user_code" | "error";

/**
 * Any terminal failure of the pairing flow.
 *
 * `.reason` drives the device's UI state machine; `.code` carries the server's
 * machine error code verbatim (spec §6.7) for the cases the reason collapses —
 * e.g. `consent_required`, `too_many_devices`, `key_mismatch` all arrive as
 * `reason: "error"` with a distinct `.code`.
 */
export class DevicePairingError extends Error {
    readonly reason: DevicePairingErrorReason;
    /** Machine code from the error envelope (`{error, message}`), when there was one. */
    readonly code?: string;
    readonly status?: number;
    /** Seconds, from `Retry-After`, when the server sent one. */
    readonly retryAfter?: number;
    /** Any extra fields the error envelope carried (e.g. `version`). */
    readonly details?: Record<string, unknown>;

    constructor(
        reason: DevicePairingErrorReason,
        opts: {
            message?: string;
            code?: string;
            status?: number;
            retryAfter?: number;
            details?: Record<string, unknown>;
            cause?: unknown;
        } = {},
    ) {
        super(opts.message ?? DEFAULT_PAIRING_MESSAGES[reason]);
        this.name = "DevicePairingError";
        this.reason = reason;
        this.code = opts.code;
        this.status = opts.status;
        this.retryAfter = opts.retryAfter;
        this.details = opts.details;
        if (opts.cause !== undefined) (this as Error & { cause?: unknown }).cause = opts.cause;
    }
}

const DEFAULT_PAIRING_MESSAGES: Record<DevicePairingErrorReason, string> = {
    denied: "Sign-in was declined on the other device.",
    expired: "That code expired. Get a new code and try again.",
    aborted: "Pairing was cancelled.",
    rate_limited: "Too many attempts — wait a moment and start again.",
    network: "Couldn't reach Muhkoo. Check the connection and try again.",
    commitment_mismatch:
        "The account handed back doesn't match the key material — pairing aborted. " +
        "Do not sign in on this device; report it.",
    account_mismatch: "This device was previously signed in as a different account.",
    reauth_required: "Confirm it's you before approving a new device.",
    invalid_user_code: `Codes are ${PAIRING_CODE_LENGTH} characters from ${PAIRING_CODE_ALPHABET} — no O, I, L, U, 0 or 1.`,
    error: "Device pairing failed.",
};

/**
 * Approving a **new** device needs a recently authenticated approver (spec
 * §10.7, `FRESH_AUTH_MAX_AGE_MS`). The hosted page catches this, prompts for a
 * password / passkey / Google factor, and retries the approval.
 *
 * Server-enforced, not a UI convention — `requiresReauth` on
 * {@link DevicePairingRequest} is only the hint.
 */
export class ReauthRequiredError extends DevicePairingError {
    /** How long ago the approver's session authenticated, in seconds. */
    readonly authAgeSeconds?: number;
    /** The freshness window the server enforces, in seconds. */
    readonly maxAgeSeconds?: number;

    constructor(opts: { message?: string; authAgeSeconds?: number; maxAgeSeconds?: number; status?: number } = {}) {
        super("reauth_required", { message: opts.message, code: "reauth_required", status: opts.status ?? 401 });
        this.name = "ReauthRequiredError";
        this.authAgeSeconds = opts.authAgeSeconds;
        this.maxAgeSeconds = opts.maxAgeSeconds;
    }
}

export class HostedAuth {
    constructor(private readonly deps: HostedAuthDeps) {}

    /**
     * (App side) Begin hosted login: stash a PKCE verifier + state, then send
     * the browser to the hosted authorize page. Returns the URL it redirects to
     * (also useful for popup mode / tests). `redirectUri` must be registered for
     * the app in the portal.
     */
    async login(opts: { appId: string; redirectUri: string; redirect?: boolean; prompt?: "login" }): Promise<string> {
        const { codeVerifier, codeChallenge } = await generatePkce();
        const state = randomState();
        this.store({ codeVerifier, state, appId: opts.appId, redirectUri: opts.redirectUri });
        const params: Record<string, string> = {
            app_id: opts.appId,
            redirect_uri: opts.redirectUri,
            state,
            code_challenge: codeChallenge,
            code_challenge_method: "S256",
        };
        // `prompt=login` forces the credential screen even when the browser is
        // remembered. Without it, an app's own "sign out" would be undone on the
        // very next sign-in click: single sign-on means the hosted page still
        // knows you, so the app must be able to say "ask anyway". Named after the
        // OIDC parameter that solves the same problem.
        if (opts.prompt) params.prompt = opts.prompt;
        const url = `${this.deps.authBaseUrl}/authorize?` + new URLSearchParams(params).toString();
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

    // =========================================================================
    // Device pairing — device (TV) side
    // =========================================================================

    /**
     * (Device side) Begin pairing. Generates the ephemeral ECDH keypair, ensures
     * a persistent device identity key exists, signs a possession proof over it,
     * and calls `POST /api/auth/device/code`.
     *
     * Display `userCode` (large, monospace) **and** `verificationCode`, then call
     * {@link waitForDevicePairing}. The verification code returned here is
     * computed locally from this device's own public key — the server also
     * returns a copy, which is ignored on purpose: trusting it would forfeit the
     * entire MITM binding (spec §6.1, §10.1).
     */
    async startDevicePairing(opts: StartDevicePairingOptions): Promise<DevicePairingSession> {
        if (!opts?.appId) throw new DevicePairingError("error", { message: "startDevicePairing: `appId` is required." });

        const pairing = await generateDevicePairingKeypair();
        const identityKey = await deviceIdentityKey();
        const deviceIdentityKeyB64 = await exportPublicKeyBase64(identityKey.publicKey);
        const issuedAt = Date.now();
        const signature = await signMessage(
            [DEVICE_PAIR_SIG_PREFIX, opts.appId, pairing.publicKeyB64, String(issuedAt)].join("|"),
            identityKey.privateKey,
        );

        const res = await this.deviceApi("POST", "/api/auth/device/code", {
            app_id: opts.appId,
            device_public_key: pairing.publicKeyB64,
            device_identity_key: deviceIdentityKeyB64,
            device_signature: signature,
            issued_at: issuedAt,
            device_label: (opts.label ?? defaultDeviceLabel()).slice(0, DEVICE_LABEL_MAX),
        });
        this.throwForStatus(res);

        const body = res.body as {
            device_code: string; user_code: string;
            verification_uri?: string; verification_uri_complete?: string;
            expires_in?: number; interval?: number;
        };
        if (!body?.device_code || !body?.user_code) {
            throw new DevicePairingError("error", { message: "Device pairing start returned no code." });
        }

        const expiresIn = numberOr(body.expires_in, 600);
        const verificationUri = body.verification_uri || `${this.deps.authBaseUrl}/link`;
        return {
            deviceCode: body.device_code,
            userCode: body.user_code,
            // LOCAL derivation — never `body.verification_code`.
            verificationCode: await pairingVerificationCode(pairing.publicKeyB64),
            verificationUri,
            verificationUriComplete: body.verification_uri_complete
                || `${verificationUri}?code=${encodeURIComponent(body.user_code)}`,
            expiresAt: Date.now() + expiresIn * 1000,
            interval: numberOr(body.interval, 5),
            privateKey: pairing.privateKey,
            devicePublicKeyB64: pairing.publicKeyB64,
        };
    }

    /**
     * (Device side) One poll of `POST /api/auth/device/token`.
     *
     * On `"approved"` this does the whole tail of the flow before returning: it
     * unseals the envelope with the ephemeral private key, derives the identity,
     * **verifies the commitment matches** (spec §10.8 — mandatory, and the check
     * that makes a substituted seed loud rather than silent), mints the device's
     * OWN long-lived ZK session, registers the device via `PUT /api/auth/devices`,
     * and persists the identity for cold starts.
     *
     * Prefer {@link waitForDevicePairing}; use this only for a custom loop. A
     * transport failure REJECTS (the caller decides whether to retry); protocol
     * outcomes resolve as a status.
     */
    async pollDevicePairing(session: DevicePairingSession): Promise<DevicePairingPoll> {
        this.assertLive(session);
        const res = await this.deviceApi("POST", "/api/auth/device/token", { device_code: session.deviceCode });

        if (res.status === 429 && res.code === "slow_down") {
            const interval = numberOr((res.body as { interval?: number })?.interval, session.interval + SLOW_DOWN_STEP_S);
            return { status: "slow_down", interval, retryAfter: res.retryAfter ?? interval };
        }
        // `expired_token` is deliberately uniform server-side for unknown /
        // expired / already-redeemed codes, so all three land here.
        if (res.status === 401 && res.code === "expired_token") return { status: "expired" };
        if (res.status === 403 && res.code === "access_denied") return { status: "denied" };
        this.throwForStatus(res);

        const body = res.body as {
            status?: string; interval?: number; expires_in?: number;
            sealed_keys?: string; username?: string; commitment?: string; device_fingerprint?: string;
        };
        if (body?.status === "pending") {
            return {
                status: "pending",
                interval: numberOr(body.interval, session.interval),
                expiresIn: numberOr(body.expires_in, Math.max(0, Math.round((session.expiresAt - Date.now()) / 1000))),
            };
        }
        if (body?.status === "denied") return { status: "denied" };
        if (body?.status === "expired") return { status: "expired" };
        if (body?.status !== "approved") {
            throw new DevicePairingError("error", { message: `Unexpected pairing status "${body?.status}".` });
        }
        if (!body.sealed_keys || !body.username || !body.commitment) {
            throw new DevicePairingError("error", { message: "Approved pairing was missing its sealed payload." });
        }

        const user = await this.adoptSealedSeed(session, {
            sealedKeys: body.sealed_keys,
            username: body.username,
            commitment: body.commitment,
        });
        return { status: "approved", user };
    }

    /**
     * (Device side) Poll to completion with the interval + `slow_down` backoff of
     * spec §9.
     *
     * The server's `interval` is authoritative: on `slow_down` the client moves to
     * `max(serverInterval, own + 5, retryAfter)` so the two can't drift into a
     * permanent slow_down loop. Sleeps carry ±10 % jitter so a rack of devices
     * restarted together doesn't synchronise, and the loop stops at `expiresAt`
     * without waiting for the server to say so.
     *
     * Resolves with the signed-in user, or rejects with {@link DevicePairingError}.
     */
    async waitForDevicePairing(
        session: DevicePairingSession,
        opts: WaitForDevicePairingOptions = {},
    ): Promise<AuthUser> {
        let interval = session.interval;
        let consecutiveNetworkErrors = 0;

        for (;;) {
            if (opts.signal?.aborted) throw new DevicePairingError("aborted");
            this.assertLive(session);

            const remaining = session.expiresAt - Date.now();
            if (remaining <= 0) throw new DevicePairingError("expired");
            opts.onTick?.(remaining, interval);

            const jitter = 1 + (Math.random() * 0.2 - 0.1);
            await this.sleep(Math.min(interval * 1000 * jitter, remaining), opts.signal);

            let result: DevicePairingPoll;
            try {
                result = await this.pollDevicePairing(session);
                consecutiveNetworkErrors = 0;
            } catch (e) {
                // A protocol verdict (denied, budget exhausted, a failed
                // commitment check) is terminal — it must NOT be swallowed by the
                // transport-retry arm the way the spec's reference loop would.
                if (e instanceof DevicePairingError) throw e;
                // Transport failure: a TV's Wi-Fi drops constantly, and the
                // pairing stays valid server-side until it expires. Back off.
                if (++consecutiveNetworkErrors > MAX_CONSECUTIVE_NETWORK_ERRORS) {
                    throw new DevicePairingError("network", { cause: e });
                }
                interval = Math.min(interval * 2, MAX_BACKOFF_INTERVAL_S);
                continue;
            }

            switch (result.status) {
                case "pending":
                    interval = result.interval; // server-authoritative
                    break;
                case "slow_down":
                    interval = Math.max(result.interval, interval + SLOW_DOWN_STEP_S, result.retryAfter);
                    break;
                case "approved":
                    return result.user;
                case "denied":
                    throw new DevicePairingError("denied");
                case "expired":
                    throw new DevicePairingError("expired");
            }
        }
    }

    /**
     * (Device side) Abandon an attempt. Marks the session dead so an in-flight
     * {@link waitForDevicePairing} rejects with `aborted` on its next tick, and
     * clears the device code.
     *
     * The ephemeral `CryptoKey` cannot be zeroed from JS — dropping the last
     * reference to `session` is what makes it unrecoverable, so don't keep the
     * object around. Deliberately does NOT notify the server: the pairing is
     * single-use and expires on its own, and an unauthenticated "cancel" endpoint
     * would just be another way to grief someone else's pending code.
     */
    cancelDevicePairing(session: DevicePairingSession): void {
        if (!session) return;
        cancelledPairings.add(session);
        session.deviceCode = "";
    }

    /**
     * (Device side) Cold-start path. Reads the persisted device identity,
     * re-derives the ZK identity from the stored seed, mints a fresh session, and
     * touches `PUT /api/auth/devices`.
     *
     * Returns `null` when nothing is persisted, when the blob doesn't derive its
     * own pinned commitment (corrupt/tampered storage), or when the account no
     * longer accepts the identity — call {@link startDevicePairing} then.
     */
    async resumeDeviceSession(): Promise<AuthUser | null> {
        const persisted = await loadDeviceIdentity();
        if (!persisted) return null;
        try {
            const identity = await deriveIdentityFromSeed(persisted.seed);
            const commitment = await commitmentFor(identity);
            // Storage integrity: the seed must still derive the commitment it was
            // stored with. A mismatch means the blob was swapped, not that the
            // account changed — refuse it rather than authenticate as someone else.
            if (commitment !== persisted.commitment) return null;
            const user = await this.mintSession(persisted.username, identity, persisted.seed, { rememberMe: true });
            await this.touchPairedDevice();
            return user;
        } catch {
            return null;
        }
    }

    /** (Device side) Wipe the persisted seed, the device identity key, and the session. */
    async forgetDeviceSession(): Promise<void> {
        await clearDeviceIdentity();
        await this.deps.session.clear();
    }

    /** (Device side) Whether a persisted device identity exists. Cheap: no crypto, no network. */
    async hasDeviceSession(): Promise<boolean> {
        return hasDeviceIdentity();
    }

    // =========================================================================
    // Device pairing — approver (hosted page) side
    // =========================================================================

    /**
     * (Hosted page) Resolve a typed `user_code` into the pending request.
     * Session-authed.
     *
     * `verificationCode` is recomputed here from the returned device key — the
     * server's copy is discarded. Both screens must show independently derived
     * values or the comparison proves nothing.
     */
    async lookupDevicePairing(userCode: string): Promise<DevicePairingRequest> {
        const code = formatUserCode(canonicalUserCode(userCode));
        const res = await this.deviceApi("POST", "/api/auth/device/lookup", { user_code: code }, true);
        this.throwForStatus(res);

        const body = res.body as {
            user_code?: string; device_public_key?: string; device_fingerprint?: string;
            device_label?: string; app_id?: string; app_label?: string;
            is_known_device?: boolean; requires_reauth?: boolean; expires_in?: number;
        };
        if (!body?.device_public_key) {
            throw new DevicePairingError("error", { message: "Pairing lookup returned no device key." });
        }
        const isKnown = body.is_known_device === true;
        return {
            userCode: body.user_code || code,
            devicePublicKeyB64: body.device_public_key,
            verificationCode: await pairingVerificationCode(body.device_public_key),
            deviceFingerprint: body.device_fingerprint ?? "",
            deviceLabel: body.device_label ?? "TV",
            appId: body.app_id ?? "",
            appLabel: body.app_label ?? "",
            isKnownDevice: isKnown,
            requiresReauth: body.requires_reauth ?? !isKnown,
            expiresAt: Date.now() + numberOr(body.expires_in, 0) * 1000,
        };
    }

    /**
     * (Hosted page) Seal the in-memory seed to the device's public key and post
     * the ciphertext. Requires an unlocked seed — the user just authenticated
     * here — exactly like {@link completeAuthorize}. The server stores and relays
     * the envelope verbatim and can't read it.
     *
     * Show the user the verification code and the device label FIRST, and only
     * call this on an explicit tap. Throws {@link ReauthRequiredError} when the
     * account's last authentication is too old for a new device; the page should
     * prompt for a factor and retry. A stale legal agreement arrives as
     * `DevicePairingError` with `.code === "consent_required"` and
     * `.details.version`.
     */
    async approveDevicePairing(req: DevicePairingRequest, opts: { label?: string } = {}): Promise<{ deviceId: string }> {
        const seed = this.deps.session.seed;
        if (!this.deps.session.token || !seed) {
            throw new DevicePairingError("error", { message: "Authenticate the user before approving a device." });
        }
        if (!req?.devicePublicKeyB64) {
            throw new DevicePairingError("error", { message: "approveDevicePairing: the request has no device key." });
        }
        const code = formatUserCode(canonicalUserCode(req.userCode));
        const sealedKeys = await sealSeedToDevice(seed, req.devicePublicKeyB64);

        const res = await this.deviceApi("POST", "/api/auth/device/approve", {
            user_code: code,
            device_public_key: req.devicePublicKeyB64,
            sealed_keys: sealedKeys,
            device_label: (opts.label ?? req.deviceLabel ?? "").slice(0, DEVICE_LABEL_MAX) || undefined,
        }, true);
        this.throwForStatus(res);

        return { deviceId: String((res.body as { device_id?: string })?.device_id ?? req.deviceFingerprint ?? "") };
    }

    /**
     * (Hosted page) Refuse a pairing. No re-auth and no consent gate — declining
     * must never be harder than accepting. Leaves a tombstone so the device is
     * told "declined" rather than an indistinguishable "expired".
     */
    async denyDevicePairing(userCode: string): Promise<void> {
        const code = formatUserCode(canonicalUserCode(userCode));
        const res = await this.deviceApi("POST", "/api/auth/device/deny", { user_code: code }, true);
        this.throwForStatus(res);
    }

    // =========================================================================
    // Device pairing — paired-device management
    // =========================================================================

    /**
     * The account's paired devices. Session-authed.
     *
     * UI copy note (spec §10.6): removing a device forces a full re-approval next
     * time, but be careful what you promise. It does NOT sign the device out —
     * the server returns `session_revoked: false`, and that session runs until it
     * expires — and it cannot take back the master seed the device already holds.
     * Users assume "remove" means "locked out immediately"; it does not.
     */
    async listPairedDevices(): Promise<PairedDevice[]> {
        const res = await this.deviceApi("GET", "/api/auth/devices", undefined, true);
        this.throwForStatus(res);
        const rows = (res.body as { devices?: unknown[] })?.devices ?? [];
        return rows.map((raw) => {
            const d = raw as {
                id?: string; label?: string; app_id?: string;
                paired_at?: number; last_seen_at?: number; active_session?: boolean;
            };
            return {
                id: d.id ?? "",
                label: d.label ?? "",
                appId: d.app_id ?? "",
                pairedAt: numberOr(d.paired_at, 0),
                lastSeenAt: numberOr(d.last_seen_at, 0),
                activeSession: d.active_session === true,
            };
        });
    }

    /**
     * Un-pair a device. Session-authed.
     *
     * It stops being a "known" device, so pairing it again needs full approval
     * with a fresh factor. It does NOT end that device's current session — the
     * server reports `session_revoked: false` — and it cannot take back the
     * master seed the device already holds. Do not write UI copy promising an
     * immediate sign-out; users will assume it and be wrong.
     */
    async revokePairedDevice(id: string): Promise<void> {
        if (!id) throw new DevicePairingError("error", { message: "revokePairedDevice: `id` is required." });
        const res = await this.deviceApi("DELETE", "/api/auth/devices", { id }, true);
        this.throwForStatus(res);
    }

    // ---- device pairing internals -------------------------------------------

    /**
     * The whole tail of an approved pairing: unseal → derive → **verify** →
     * authenticate → register → persist. Split out of `pollDevicePairing` so the
     * ordering (and the two refusals) stay readable.
     */
    private async adoptSealedSeed(
        session: DevicePairingSession,
        payload: { sealedKeys: string; username: string; commitment: string },
    ): Promise<AuthUser> {
        let seed: Uint8Array;
        try {
            seed = await unsealSeedFromDevice(payload.sealedKeys, session.privateKey, session.devicePublicKeyB64);
        } catch (e) {
            throw new DevicePairingError("commitment_mismatch", {
                message: "The sealed key material couldn't be opened on this device — pairing aborted.",
                cause: e,
            });
        }

        const identity = await deriveIdentityFromSeed(seed);
        const commitment = await commitmentFor(identity);
        // §10.8, mandatory: the seed we were handed must derive the commitment the
        // server claims. A compromised API can seal an attacker-controlled seed to
        // this device (§10.2) — this is the check that makes that loud.
        if (commitment !== payload.commitment) {
            throw new DevicePairingError("commitment_mismatch", {
                details: { expected: payload.commitment, derived: commitment },
            });
        }
        // §10.2 detection 2 — commitment pinning across re-pairs. A device that
        // was signed in as someone else must fail closed, not silently switch.
        const pinned = await loadDeviceIdentity();
        if (pinned && pinned.commitment !== commitment) {
            throw new DevicePairingError("account_mismatch", {
                details: { pinnedUsername: pinned.username, offeredUsername: payload.username },
            });
        }

        // The device mints its OWN session rather than sharing the approver's, so
        // revoking the TV doesn't sign out the phone that approved it.
        const user = await this.mintSession(payload.username, identity, seed, { rememberMe: true });

        // Both are best-effort: the user IS signed in at this point, and failing
        // the whole pairing over a bookkeeping call would be worse than degrading.
        await this.touchPairedDevice();
        try {
            await persistDeviceIdentity({ username: user.username, commitment, seed, pairedAt: Date.now() });
        } catch (e) {
            appLoggerWarn("device identity could not be persisted; this device will pair again after a restart", e);
        }
        return user;
    }

    /**
     * Run the standard ZK challenge → Groth16 proof → authenticate round-trip for
     * an identity derived from a seed the caller already holds, and store the
     * resulting session.
     *
     * Identical to `ZkAuth.login()`'s tail (`proveAndStore`) — same challenge,
     * same circuit, same signature — so the commitment is byte-identical to
     * `zk.login(username, password)` by construction. No new endpoint, no circuit
     * change, no alternative derivation.
     *
     * (Spec §7 puts this on `AuthNamespace` as `loginWithSeed`; see the report —
     * it lives here because `AuthNamespace.ts` was out of scope for this change,
     * and `proveAndStore` is private.)
     */
    private async mintSession(
        username: string,
        identity: ZkIdentity,
        seed: Uint8Array,
        opts: LoginOptions = {},
    ): Promise<AuthUser> {
        const ecdsaPubHex = await exportPublicKeyHex(identity.ecdsaKeyPair.publicKey);
        const challenge = await this.deps.auth.getChallenge(username);
        const { proof, publicSignals, commitment } = await generateAuthProof({
            secretHex: identity.secretHex,
            saltHex: identity.saltHex,
            ecdsaPubHex,
            nonceHex: challenge.nonce,
            circuits: this.circuits(),
        });
        const signature = await signMessage(JSON.stringify(proof), identity.ecdsaKeyPair.privateKey);
        const result = await this.deps.auth.authenticate({
            challengeId: challenge.challengeId,
            proof: {
                commitment,
                // The accelerator expects the original hex nonce, not the
                // field-reduced version fed into the circuit.
                nonce: challenge.nonce,
                response: { proof, publicSignals },
                signature,
            },
            rememberMe: opts.rememberMe,
        });
        await this.deps.session.setSession({ token: result.token, username: result.username, commitment });
        this.deps.session.setIdentity(identity);
        this.deps.session.setSeed(seed);
        return { username: result.username, commitment };
    }

    /**
     * `PUT /api/auth/devices` — the device checks in after each self-login so the
     * security page can show "last seen" and revoke the right session. Never
     * creates a record (only approve does), so a 404 here is expected on a device
     * whose pairing was revoked. Best-effort by design.
     */
    private async touchPairedDevice(): Promise<void> {
        try {
            const identityKey = await deviceIdentityKey();
            const fingerprint = await deviceFingerprint();
            const issuedAt = Date.now();
            const signature = await signMessage(
                [DEVICE_TOUCH_SIG_PREFIX, fingerprint, String(issuedAt)].join("|"),
                identityKey.privateKey,
            );
            await this.deviceApi("PUT", "/api/auth/devices", {
                fingerprint,
                issued_at: issuedAt,
                device_signature: signature,
            }, true);
        } catch (e) {
            appLoggerWarn("device check-in failed", e);
        }
    }

    /** Reject a session that {@link cancelDevicePairing} has retired. */
    private assertLive(session: DevicePairingSession): void {
        if (!session || cancelledPairings.has(session) || !session.deviceCode) {
            throw new DevicePairingError("aborted");
        }
    }

    private sleep(ms: number, signal?: AbortSignal): Promise<void> {
        if (this.deps.sleep) return this.deps.sleep(ms, signal);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                signal?.removeEventListener("abort", onAbort);
                resolve();
            }, ms);
            const onAbort = () => {
                clearTimeout(timer);
                reject(new DevicePairingError("aborted"));
            };
            if (signal?.aborted) return onAbort();
            signal?.addEventListener("abort", onAbort, { once: true });
        });
    }

    /**
     * One round-trip to a `/api/auth/device*` endpoint. Never throws on a non-2xx
     * — the poll path has to inspect 401/403/429 itself — so callers that don't
     * want that follow up with {@link throwForStatus}.
     */
    private async deviceApi(
        method: string,
        path: string,
        body?: unknown,
        withSession = false,
    ): Promise<DeviceApiResponse> {
        const headers: Record<string, string> = {};
        if (body !== undefined) headers["Content-Type"] = "application/json";
        if (withSession) {
            const token = this.deps.session.token;
            if (!token) throw new DevicePairingError("error", { code: "unauthorized", status: 401, message: "Sign in first." });
            // X-Muhkoo-Session, not `Authorization: Bearer` — the accelerator's
            // session resolver prefers it and raw SPA fetches must use it.
            headers["X-Muhkoo-Session"] = token;
        }
        const fetchFn = this.deps.fetch ?? globalThis.fetch?.bind(globalThis);
        if (typeof fetchFn !== "function") throw new Error("HostedAuth: no fetch available.");

        const res = await fetchFn(`${this.apiBase()}${path}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
        });

        let parsed: unknown = null;
        try { parsed = await res.json(); } catch { /* empty or non-JSON body */ }
        const envelope = (parsed ?? {}) as { error?: unknown; message?: unknown };
        const retryAfterHeader = Number(res.headers?.get?.("Retry-After"));

        return {
            status: res.status,
            ok: res.ok,
            body: parsed,
            code: res.ok || typeof envelope.error !== "string" ? undefined : envelope.error,
            message: typeof envelope.message === "string"
                ? envelope.message
                : typeof envelope.error === "string" ? envelope.error : undefined,
            retryAfter: Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader : null,
        };
    }

    /** Turn a non-2xx device-endpoint response into the right typed error. */
    private throwForStatus(res: DeviceApiResponse): void {
        if (res.ok) return;
        const details = (res.body ?? undefined) as Record<string, unknown> | undefined;
        if (res.code === "reauth_required") {
            throw new ReauthRequiredError({
                message: res.message,
                status: res.status,
                authAgeSeconds: numberOrUndefined(details?.auth_age_seconds),
                maxAgeSeconds: numberOrUndefined(details?.max_age_seconds),
            });
        }
        throw new DevicePairingError(reasonForCode(res.code, res.status), {
            message: res.message,
            code: res.code,
            status: res.status,
            retryAfter: res.retryAfter ?? undefined,
            details,
        });
    }

    /**
     * Accelerator origin for the device endpoints.
     *
     * Prefers the explicit dep. Falls back to the {@link AuthClient}'s own base
     * URL, because `AuthNamespace` builds `HostedAuth` without one today and a
     * hard-coded default would silently point a staging or local build at
     * production. Last resort: map the auth SPA host (`auth.…` → `api.…`).
     */
    private apiBase(): string {
        const explicit = this.deps.apiBaseUrl;
        if (explicit) return explicit.replace(/\/+$/, "");
        const fromAuthClient = (this.deps.auth as unknown as { baseUrl?: string })?.baseUrl;
        if (typeof fromAuthClient === "string" && fromAuthClient) return fromAuthClient.replace(/\/+$/, "");
        try {
            const url = new URL(this.deps.authBaseUrl);
            url.hostname = url.hostname.replace(/^auth\./, "api.");
            url.pathname = "";
            return url.toString().replace(/\/+$/, "");
        } catch {
            throw new Error("HostedAuth: can't resolve the accelerator base URL — pass `apiBaseUrl`.");
        }
    }

    private circuits(): CircuitUrls {
        return this.deps.circuits ?? defaultCircuitUrls(this.apiBase());
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

// ---- device pairing: module helpers ----------------------------------------

/** Sessions retired by {@link HostedAuth.cancelDevicePairing}. Weak so a dropped
 *  session is collectable — this must not become a leak on a device that runs
 *  for months. */
const cancelledPairings = new WeakSet<DevicePairingSession>();

interface DeviceApiResponse {
    status: number;
    ok: boolean;
    body: unknown;
    /** Machine code from `{error, message}`. Undefined on 2xx. */
    code?: string;
    /** Human sentence — `message`, falling back to `error` for the older shape. */
    message?: string;
    retryAfter: number | null;
}

/**
 * Map a server error code to the reason the device's state machine branches on.
 * Codes with no dedicated reason land on `"error"` and stay readable through
 * {@link DevicePairingError.code}.
 */
function reasonForCode(code: string | undefined, status: number): DevicePairingErrorReason {
    switch (code) {
        case "expired_token":
        case "pairing_not_found":
            return "expired";
        case "access_denied":
            return "denied";
        case "slow_down":
        case "rate_limited":
        case "too_many_requests":
            return "rate_limited";
        case "reauth_required":
            return "reauth_required";
        case "invalid_user_code":
            return "invalid_user_code";
        default:
            return status === 429 ? "rate_limited" : "error";
    }
}

/**
 * Canonicalize a typed `user_code`: uppercase, drop whitespace and `-`.
 *
 * We deliberately do NOT guess (`O → 0`, `I → 1`, …). Both members of every
 * confusable pair are excluded from the alphabet, so a typed `O` is a genuine
 * misread — telling the user is more useful than silently resolving it.
 */
export function canonicalUserCode(input: string): string {
    const code = String(input ?? "").toUpperCase().replace(/[\s-]/g, "");
    if (code.length !== PAIRING_CODE_LENGTH) throw new DevicePairingError("invalid_user_code");
    for (const ch of code) {
        if (!PAIRING_CODE_ALPHABET.includes(ch)) throw new DevicePairingError("invalid_user_code");
    }
    return code;
}

/** Group a canonical code for display and for the wire: `"K7QD3MXR"` → `"K7QD-3MXR"`. */
export function formatUserCode(canonical: string): string {
    const half = Math.ceil(canonical.length / 2);
    return `${canonical.slice(0, half)}-${canonical.slice(half)}`;
}

/** Poseidon commitment for an identity — the value the server stores. */
async function commitmentFor(identity: ZkIdentity): Promise<string> {
    const ecdsaPubHex = await exportPublicKeyHex(identity.ecdsaKeyPair.publicKey);
    return buildCommitment(identity.secretHex, identity.saltHex, ecdsaPubHex);
}

/**
 * A label the approver can recognise, guessed from the user agent. Android TV
 * user agents are famously uninformative, so this is a coarse family name —
 * §6.4 lets the approver rename the device at approval time.
 */
function defaultDeviceLabel(): string {
    const ua = (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent ?? "";
    if (/AFT[A-Z]/i.test(ua)) return "Fire TV";
    if (/Android.*TV|GoogleTV|Chromecast/i.test(ua)) return "Android TV";
    if (/AppleTV|tvOS/i.test(ua)) return "Apple TV";
    if (/Tizen|Web0S|WebOS|SMART-TV|BRAVIA|HbbTV|NetCast/i.test(ua)) return "Smart TV";
    return "TV";
}

function numberOr(v: unknown, fallback: number): number {
    return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function numberOrUndefined(v: unknown): number | undefined {
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Non-fatal diagnostics. The SDK logger is optional, so never let it throw. */
function appLoggerWarn(message: string, err: unknown): void {
    try {
        (globalThis as { appLogger?: { warn?: (...a: unknown[]) => void } }).appLogger?.warn?.(
            `[hosted-auth] ${message}:`, err instanceof Error ? err.message : err,
        );
    } catch { /* diagnostics must never break the flow */ }
}
