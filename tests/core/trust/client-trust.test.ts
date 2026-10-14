import { describe, it, expect } from "vitest";
import { Client, IdentityLockedError, AdmissionDeniedError, SpaceTrustError } from "../../../src/api";

describe("Client wires trust (design §6.9)", () => {
    it("exposes client.trust and the error classes", () => {
        const c = new Client({ baseUrl: "http://test", apiKey: "mk_test_pk_x" } as never);
        expect(typeof c.trust.resetSpacePins).toBe("function");
        expect(typeof c.trust.unpin).toBe("function");
        expect(c.trust.persistent).toBeTypeOf("boolean");
        expect(new IdentityLockedError()).toBeInstanceOf(Error);
        expect(new AdmissionDeniedError("not-member").code).toBe("not-member");
        expect(new SpaceTrustError("integrity").code).toBe("integrity");
    });
});
