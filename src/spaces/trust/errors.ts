/**
 * Trust-layer errors shared by Spaces and, later, DMs (design §3.3, §6.9;
 * SpecA §6.6). Class names are public API and are frozen at their first
 * release (design Q16).
 */

/** The session holds no seed, so it has no stable identity and may not take part (design §3.3, T7). */
export class IdentityLockedError extends Error {
    readonly code = "identity-locked" as const;
    constructor(
        message = "This session is locked. Sign in again (or call client.auth.zk.unlock(password)) to use encrypted spaces. " +
            "Earlier SDK versions silently used a temporary key here, which hid your earlier messages from other members.",
    ) {
        super(message);
        this.name = "IdentityLockedError";
    }
}

/**
 * The stable chat keys could not be loaded (design §3.3). `retryable` says
 * whether the same call can succeed later. It is true when the vault could not
 * be reached or written (a 5xx or a network error on `chat-keys`), which the
 * next open retries (§9.2 I8). It is false when the saved keys were read but do
 * not unwrap under this session's seed, because they are damaged or were saved
 * under another seed, and when the client has no vault: retrying fails the same way.
 */
export class IdentityUnavailableError extends Error {
    readonly code = "identity-unavailable" as const;
    constructor(
        message = "Your chat keys could not be loaded right now. Try again.",
        readonly reason?: unknown,
        readonly retryable = true,
    ) {
        super(message);
        this.name = "IdentityUnavailableError";
    }
}

export type SpaceTrustCode =
    | "integrity"
    | "log-conflict"
    | "log-refused"
    | "lookup-failed"
    | "pins-missing"
    | "pins-rollback"
    | "pins-stale"
    | "pins-invalid"
    | "pins-write-failed";

/** A membership-log or pin failure. `detail` carries server fields (`reason`, `head`, ...). */
export class SpaceTrustError extends Error {
    constructor(readonly code: SpaceTrustCode, message?: string, readonly detail?: Record<string, unknown>) {
        super(message ?? code);
        this.name = "SpaceTrustError";
    }
}

/** This user may not open this Space (design §4.5.12, V25). */
export class AdmissionDeniedError extends Error {
    constructor(readonly code: "not-member" | "identity-mismatch", message?: string) {
        super(message ?? code);
        this.name = "AdmissionDeniedError";
    }
}
