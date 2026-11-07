import { describe, it, expect, vi, afterEach } from "vitest";
import { ZkAuth } from "../../src/core/namespaces/AuthNamespace";
import { SessionState } from "../../src/core/Session";

afterEach(() => vi.unstubAllGlobals());

function make(factor: unknown) {
    vi.stubGlobal("location", { hostname: "app.apps.muhkoo.dev" });
    return new ZkAuth({
        session: new SessionState(),
        circuits: { wasmUrl: "x", zkeyUrl: "y" },
        auth: { vaultRead: async () => ({ factor }) } as never,
    } as never);
}
const pk = (rpId?: string) => ({ wrap: "w", iv: "i", params: { credentialId: "c", prfSalt: "p", ...(rpId ? { rpId } : {}) } });

describe("passkeyStatus", () => {
    it("usable for this origin", async () => expect(await make(pk("apps.muhkoo.dev")).passkeyStatus("u")).toBe("usable"));
    it("usable for a legacy factor with no rpId", async () => expect(await make(pk()).passkeyStatus("u")).toBe("usable"));
    it("other-origin", async () => expect(await make(pk("example.com")).passkeyStatus("u")).toBe("other-origin"));
    it("none", async () => expect(await make(null).passkeyStatus("u")).toBe("none"));
});
