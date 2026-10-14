/**
 * `client.app` — what the signed-in user may do in this app (accelerator spec
 * 2026-10-06-paid-accounts-and-past-due, B6 and B8).
 *
 * An app's owner can turn on "Paid Muhkoo accounts only" in the portal. The
 * accelerator then refuses a Free user's writes that add data, with a 402 the
 * SDK throws as `PaymentRequiredError`. Reads, sign-in and deletes still work.
 * The same refusal reaches every user of an app whose owner's payment is past
 * due, whether or not the setting is on.
 *
 * `access()` asks up front, so an app can show the right screen before the
 * first refusal.
 */

import type { HttpClient } from "../HttpClient";
import { absoluteHttpUrl, isPaymentRequiredCode, type PaymentRequiredCode } from "../PaymentRequiredError";

/** The answer of `GET /api/app/access`. */
export interface AppAccess {
    /** The owner has turned on "Paid Muhkoo accounts only" for this app. */
    paidAccountsOnly: boolean;
    /** The signed-in user may add data in this app now. */
    allowed: boolean;
    /**
     * Why not: the code a refused write carries. Read only when `allowed` is
     * false, and only when it is one of the three codes.
     */
    reason?: PaymentRequiredCode;
    /**
     * Where to send the user, as an absolute URL: the portal's upgrade page
     * for `user_plan_required`, with a way back to this app when the request
     * came from one of its registered redirect URIs, or its billing page for
     * `user_payment_past_due`. The accelerator sends it only for those two
     * reasons: the user can do nothing about the owner's payment. Read only
     * when `allowed` is false, and only when it is an absolute http(s) URL.
     */
    upgradeUrl?: string;
}

export interface AppNamespaceDeps {
    http: HttpClient;
    /**
     * Called each time `access()` answers `allowed: true`. The Client sends
     * the writes its offline queue kept after a refusal for payment
     * (`OfflineManager.resume`). A throw or a rejection is logged and ignored.
     */
    onAllowed?: () => Promise<void>;
}

export class AppNamespace {
    constructor(private readonly deps: AppNamespaceDeps) {}

    /**
     * Whether the signed-in user may add data in this app and, if not, why
     * and where to send them. Needs the app key and a session; a stale session
     * is re-established once, as for every request. The route is never
     * refused for payment. Throws `HttpError` for anything else, among them a
     * 401 without a session and a 404 from an accelerator older than the
     * route.
     *
     * Each `allowed: true` also sends any writes the offline queue kept after
     * a refusal for payment, without waiting for them. Call it after sign-in,
     * and again when the user comes back from the portal.
     */
    async access(): Promise<AppAccess> {
        const body = await this.deps.http.get<Record<string, unknown> | null>("/api/app/access");
        const access: AppAccess = {
            paidAccountsOnly: body?.paidAccountsOnly === true,
            // Fail open on a malformed answer: the server enforces the gate
            // whatever this says, so a wrong "allowed" costs a refused write,
            // and a wrong "not allowed" would lock the user out for nothing.
            allowed: body?.allowed !== false,
        };
        if (!access.allowed) {
            if (isPaymentRequiredCode(body?.reason)) access.reason = body.reason;
            const upgradeUrl = absoluteHttpUrl(body?.upgradeUrl);
            if (upgradeUrl) access.upgradeUrl = upgradeUrl;
        } else if (this.deps.onAllowed) {
            // A drain that fails, or a callback that throws, must not turn a
            // good answer into an error: the writes stay queued for the next
            // reconnect.
            Promise.resolve()
                .then(() => this.deps.onAllowed!())
                .catch((err: unknown) => {
                    console.warn("[client.app] sending the kept writes failed (they stay queued):", err);
                });
        }
        return access;
    }
}

export default AppNamespace;
