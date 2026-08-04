/**
 * Passkey origin binding (`rpIdUsableForOrigin`).
 *
 * Passkeys are bound to the origin they were enrolled on, so an app reachable at
 * BOTH a custom domain and the platform host needs one per origin. Prompting
 * with a foreign rpId throws a raw "The requested RPID did not match the origin
 * or related origins" — a dead end for the user — so callers check first.
 */

import { describe, it, expect } from "vitest";
import { rpIdUsableForOrigin, PasskeyOriginError } from "../../src/auth/passkey";

describe("rpIdUsableForOrigin", () => {
    it("accepts an exact host match", () => {
        expect(rpIdUsableForOrigin("theater.muhkoo.com", "theater.muhkoo.com")).toBe(true);
    });

    it("accepts a registrable PARENT of the current host", () => {
        // A passkey enrolled for "muhkoo.dev" works on any subdomain of it.
        expect(rpIdUsableForOrigin("muhkoo.dev", "muhkoo-theater.apps.muhkoo.dev")).toBe(true);
        expect(rpIdUsableForOrigin("apps.muhkoo.dev", "muhkoo-theater.apps.muhkoo.dev")).toBe(true);
    });

    it("rejects a different registrable domain — the reported Theater bug", () => {
        // Enrolled on the platform host, opened on the custom domain (or vice
        // versa): WebAuthn refuses, so we must not prompt.
        expect(rpIdUsableForOrigin("muhkoo-theater.apps.muhkoo.dev", "theater.muhkoo.com")).toBe(false);
        expect(rpIdUsableForOrigin("theater.muhkoo.com", "muhkoo-theater.apps.muhkoo.dev")).toBe(false);
    });

    it("rejects a SIBLING host and a child-as-rpId", () => {
        expect(rpIdUsableForOrigin("a.muhkoo.dev", "b.muhkoo.dev")).toBe(false);
        // rpId may be a parent of the host, never the other way around.
        expect(rpIdUsableForOrigin("deep.app.muhkoo.dev", "app.muhkoo.dev")).toBe(false);
    });

    it("rejects a suffix that isn't a domain boundary", () => {
        // "notmuhkoo.com" must not match rpId "muhkoo.com".
        expect(rpIdUsableForOrigin("muhkoo.com", "notmuhkoo.com")).toBe(false);
    });

    it("is false for missing rpId or host rather than throwing", () => {
        expect(rpIdUsableForOrigin(undefined, "theater.muhkoo.com")).toBe(false);
        expect(rpIdUsableForOrigin(null, "theater.muhkoo.com")).toBe(false);
        expect(rpIdUsableForOrigin("", "theater.muhkoo.com")).toBe(false);
        expect(rpIdUsableForOrigin("theater.muhkoo.com", "")).toBe(false);
    });

    it("PasskeyOriginError carries a stable code for callers to branch on", () => {
        const e = new PasskeyOriginError();
        expect(e.code).toBe("passkey_wrong_origin");
        expect(e).toBeInstanceOf(Error);
        expect(e.message).toMatch(/passkey/i);
    });
});
