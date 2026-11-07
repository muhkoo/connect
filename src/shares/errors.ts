/**
 * Typed refusals from the shares API. Each extends {@link HttpError}, so code that only knows `HttpError` still
 * sees the status and body. Codes are the accelerator's wire contract.
 */

import { HttpError } from "../core/HttpError";

/** 402 `share_full`: the share is at its storage cap. */
export class ShareFullError extends HttpError {
    constructor(
        message: string,
        readonly limitBytes: number,
        readonly usedBytes: number,
        /**
         * How many items of a `Share.writeMany` were not written (the refused one and every one after it). The
         * server's body has no such field, so it is 0 on an error straight from the wire.
         */
        readonly refused: number,
        body?: unknown,
    ) {
        super(message, 402, body);
        this.name = "ShareFullError";
    }
}

/** 409 `share_closed`: the share was rotated; use `successor` instead. */
export class ShareClosedError extends HttpError {
    constructor(message: string, readonly successor: string, body?: unknown) {
        super(message, 409, body);
        this.name = "ShareClosedError";
    }
}

/** 403 `share_password`: wrong password. */
export class SharePasswordError extends HttpError {
    constructor(message: string, body?: unknown) {
        super(message, 403, body);
        this.name = "SharePasswordError";
    }
}

/** 429 `share_password_rate`: too many wrong passwords. */
export class SharePasswordRateError extends HttpError {
    constructor(message: string, readonly retryAfterSeconds: number, body?: unknown) {
        super(message, 429, body);
        this.name = "SharePasswordRateError";
    }
}

/** 403 `share_member_limit`: the share holds as many members as it allows. */
export class ShareMemberLimitError extends HttpError {
    constructor(message: string, body?: unknown) {
        super(message, 403, body);
        this.name = "ShareMemberLimitError";
    }
}

/** 409 `share_space_not_empty`: only an empty Space can become a share. */
export class ShareSpaceNotEmptyError extends HttpError {
    constructor(message: string, body?: unknown) {
        super(message, 409, body);
        this.name = "ShareSpaceNotEmptyError";
    }
}

/** 409 `share_space_not_ready`: the Space has no `/metadata` yet; create the Space before making it a share. */
export class ShareSpaceNotReadyError extends HttpError {
    constructor(message: string, body?: unknown) {
        super(message, 409, body);
        this.name = "ShareSpaceNotReadyError";
    }
}

/** 409 `rotation_mismatch`: a retried rotation asked for other settings than the one in progress. */
export class RotationMismatchError extends HttpError {
    constructor(message: string, body?: unknown) {
        super(message, 409, body);
        this.name = "RotationMismatchError";
    }
}

/** 409 `rotation_in_progress`: another rotation of this share won; `successor` is its new Space. */
export class RotationInProgressError extends HttpError {
    constructor(message: string, readonly successor: string, body?: unknown) {
        super(message, 409, body);
        this.name = "RotationInProgressError";
    }
}

/**
 * A rotation (`changePassword` / `removeMember`) claimed `newSpaceId` but its adopt did not finish (network failure
 * or server error, retried). It is kept on this device: call the same rotation again, or `shares.resumeRotation`,
 * to finish it into the SAME Space. No other rotation of this share starts until it does.
 */
export class RotationIncompleteError extends Error {
    constructor(readonly from: string, readonly newSpaceId: string, readonly cause?: unknown) {
        super(`Moving the share ${from} to ${newSpaceId} did not finish; try again to finish it.`);
        this.name = "RotationIncompleteError";
    }
}

/** A guest recovery code that does not parse (expected `<username>:<words>`). */
export class InvalidRecoveryCodeError extends Error {
    constructor(message = "That is not a recovery code: expected <username>:<words>.") {
        super(message);
        this.name = "InvalidRecoveryCodeError";
    }
}

/** `restoreGuest` would replace another guest's login kept on this device; pass `{ replace: true }` to do so. */
export class GuestLoginConflictError extends Error {
    constructor(readonly existing: string) {
        super(`This device is signed in as the guest ${existing}; replace it to restore another guest.`);
        this.name = "GuestLoginConflictError";
    }
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * The typed error for a refused response, or null when it is not a share refusal (the caller then throws what it
 * threw before). `body` is the parsed JSON or the raw response text. `retryAfterSeconds` is the `Retry-After`
 * header, used for a 429.
 */
export function shareErrorFrom(status: number, body: unknown, retryAfterSeconds?: number): Error | null {
    let parsed = body;
    if (typeof parsed === "string") {
        try {
            parsed = JSON.parse(parsed);
        } catch {
            return null;
        }
    }
    if (!parsed || typeof parsed !== "object") return null;
    const b = parsed as Record<string, unknown>;
    const code = b.code;
    const msg = (fallback: string) => (typeof b.error === "string" && b.error ? b.error : fallback);

    if (status === 402 && code === "share_full") {
        return new ShareFullError(msg("Share is full"), num(b.limitBytes), num(b.usedBytes), num(b.refused), parsed);
    }
    if (status === 403) {
        if (code === "share_password") return new SharePasswordError(msg("Wrong password"), parsed);
        if (code === "share_member_limit") return new ShareMemberLimitError(msg("Share member limit reached"), parsed);
    }
    if (status === 429 && code === "share_password_rate") {
        const wait = retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : 1;
        return new SharePasswordRateError(msg("Too many wrong passwords"), wait, parsed);
    }
    if (status === 409) {
        if (code === "share_closed") return new ShareClosedError(msg("Share is closed"), str(b.successor), parsed);
        if (code === "share_space_not_ready") return new ShareSpaceNotReadyError(msg("Space is not ready"), parsed);
        if (code === "share_space_not_empty") return new ShareSpaceNotEmptyError(msg("Space is not empty"), parsed);
        if (code === "rotation_mismatch") return new RotationMismatchError(msg("Rotation settings differ"), parsed);
        if (code === "rotation_in_progress") {
            return new RotationInProgressError(msg("Share is being rotated"), str(b.successor), parsed);
        }
    }
    return null;
}
