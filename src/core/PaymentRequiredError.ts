/**
 * `PaymentRequiredError` — a write the accelerator refused for payment
 * (accelerator spec 2026-10-06-paid-accounts-and-past-due, "Interfaces and
 * contracts").
 *
 * The accelerator answers such a write with a 402 whose body carries one of
 * three codes:
 *   - `user_plan_required`: the app takes paid Muhkoo plans only, and the
 *     signed-in user is on Free;
 *   - `user_payment_past_due`: the user's own Muhkoo payment is past due. Only
 *     first-party apps are told this; every other app is told
 *     `user_plan_required` instead;
 *   - `owner_payment_past_due`: the app owner's payment is past due, so the
 *     app stores nothing new for anyone.
 * Reads, sign-in and deletes still work in all three cases.
 *
 * Every other 402 — the Free-tier refusals that carry `quotaExceeded`,
 * `requiresPaidTier` or `freeTierFull` — has no `code`, and stays a plain
 * `HttpError`, as before.
 */

import { HttpError } from "./HttpError";

/** Why a write was refused for payment. A wire contract: these strings never change. */
export type PaymentRequiredCode = "user_plan_required" | "user_payment_past_due" | "owner_payment_past_due";

const CODES: ReadonlySet<string> = new Set<PaymentRequiredCode>([
    "user_plan_required",
    "user_payment_past_due",
    "owner_payment_past_due",
]);

/** True for one of the three {@link PaymentRequiredCode}s. */
export function isPaymentRequiredCode(value: unknown): value is PaymentRequiredCode {
    return typeof value === "string" && CODES.has(value);
}

/** `url` when it is an absolute http(s) URL, else undefined: an app may put it straight into a link. */
export function absoluteHttpUrl(url: unknown): string | undefined {
    return typeof url === "string" && /^https?:\/\/[^/]/i.test(url) ? url : undefined;
}

/** Thrown for a 402 whose body carries one of the three {@link PaymentRequiredCode}s. */
export class PaymentRequiredError extends HttpError {
    /** Why the write was refused. */
    readonly code: PaymentRequiredCode;
    /**
     * Where to send the user: the portal's upgrade page or its billing page,
     * as an absolute URL. Set only when the server sent an absolute http(s)
     * URL. The relative `upgradeUrl` of the Free-tier refusals is never here:
     * those are not this error.
     */
    readonly upgradeUrl?: string;

    constructor(message: string, code: PaymentRequiredCode, body?: unknown, upgradeUrl?: string) {
        super(message, 402, body);
        this.name = "PaymentRequiredError";
        this.code = code;
        if (upgradeUrl !== undefined) this.upgradeUrl = upgradeUrl;
    }
}

/**
 * The error to throw for a refused response: a {@link PaymentRequiredError}
 * for a 402 whose body carries one of the three codes, and null for anything
 * else, so the caller throws what it threw before. `body` is the parsed JSON,
 * or the raw text of the response, which is parsed here.
 */
export function paymentRequiredFrom(status: number, body: unknown): PaymentRequiredError | null {
    if (status !== 402) return null;
    let parsed = body;
    if (typeof parsed === "string") {
        try {
            parsed = JSON.parse(parsed);
        } catch {
            return null;
        }
    }
    if (!parsed || typeof parsed !== "object") return null;
    const { code, error, upgradeUrl } = parsed as { code?: unknown; error?: unknown; upgradeUrl?: unknown };
    if (!isPaymentRequiredCode(code)) return null;
    const message = typeof error === "string" && error ? error : `Payment required (${code})`;
    return new PaymentRequiredError(message, code, parsed, absoluteHttpUrl(upgradeUrl));
}
