/**
 * `passkeyUsableFromOrigin` — the predicate that decides whether `resume()`
 * silently attempts a passkey unlock on boot.
 *
 * Two failures this guards against, both of which have actually happened:
 *
 * 1. TOO NARROW → production lockout. Using `rpIdUsableForOrigin` directly here
 *    excludes every factor with no recorded rpId. Those predate per-origin
 *    enrolment and ARE usable — `loginWithPasskey` resolves them as
 *    `params.rpId ?? host`. Treating them as unusable locked legacy passkey
 *    holders out of production twice.
 *
 * 2. TOO WIDE → a modal WebAuthn dialog on every page load. If the account's
 *    only passkey belongs to a different origin, attempting anyway makes
 *    `loginWithPasskey` do an unauthenticated vault read that this origin can't
 *    satisfy. Today that returns a decoy with no `prfSalt` and fails before
 *    touching WebAuthn — but only incidentally. Once the decoy is reshaped to be
 *    indistinguishable (it must carry `prfSalt` to stop being an
 *    account-enumeration oracle), the same call would fire
 *    `navigator.credentials.get()` at boot for a credential that doesn't exist.
 *    `resume()` is awaited inside every app's readiness gate, so that lands on
 *    the splash screen.
 */

import { describe, it, expect } from "vitest";
import { passkeyUsableFromOrigin, rpIdUsableForOrigin } from "../../src/auth/passkey";

const HOST = "muhkoo-theater.apps.muhkoo.dev";

describe("passkeyUsableFromOrigin", () => {
    it("ACCEPTS a legacy factor with no recorded rpId — the lockout regression", () => {
        // `loginWithPasskey` resolves this as `params.rpId ?? host`, so it works.
        expect(passkeyUsableFromOrigin(undefined, HOST)).toBe(true);
        expect(passkeyUsableFromOrigin(null, HOST)).toBe(true);
    });

    it("differs from rpIdUsableForOrigin on exactly that case", () => {
        // The whole reason this helper exists. If these ever agree for `undefined`,
        // one of them has changed and the legacy population is at risk again.
        expect(rpIdUsableForOrigin(undefined, HOST)).toBe(false);
        expect(passkeyUsableFromOrigin(undefined, HOST)).toBe(true);
    });

    it("accepts an exact host and a registrable parent", () => {
        expect(passkeyUsableFromOrigin(HOST, HOST)).toBe(true);
        expect(passkeyUsableFromOrigin("muhkoo.dev", HOST)).toBe(true);
        expect(passkeyUsableFromOrigin("apps.muhkoo.dev", HOST)).toBe(true);
    });

    it("REJECTS a foreign origin — this is what stops the boot-time dialog", () => {
        // The common real case: the user enrolled their passkey through hosted
        // auth, so it is recorded against auth.muhkoo.dev and is unusable on
        // every app host.
        expect(passkeyUsableFromOrigin("auth.muhkoo.dev", HOST)).toBe(false);
        expect(passkeyUsableFromOrigin("theater.muhkoo.com", HOST)).toBe(false);
    });

    it("rejects a sibling host and a non-boundary suffix", () => {
        expect(passkeyUsableFromOrigin("a.muhkoo.dev", "b.muhkoo.dev")).toBe(false);
        expect(passkeyUsableFromOrigin("muhkoo.com", "notmuhkoo.com")).toBe(false);
    });

    it("treats an EMPTY-STRING rpId as unusable, matching loginWithPasskey", () => {
        // `params.rpId ?? host` only falls back on nullish — "" stays "" and
        // then fails the origin check. Mirroring that exactly matters, because a
        // mismatch here would let resume() attempt a login that then throws.
        expect(passkeyUsableFromOrigin("", HOST)).toBe(false);
    });

    it("is false when there is no host to compare against (non-browser)", () => {
        expect(passkeyUsableFromOrigin("muhkoo.dev", "")).toBe(false);
        expect(passkeyUsableFromOrigin(undefined, "")).toBe(false);
    });
});
