import { describe, it, expect, vi, afterEach } from "vitest";
import { HostedAuth } from "../../src/core/namespaces/HostedAuth";
import { MemorySessionStore, SessionState } from "../../src/core/Session";

afterEach(() => vi.unstubAllGlobals());

describe("hosted.logout", () => {
    it("navigates to the hosted /logout with app_id and redirect_uri", () => {
        const assign = vi.fn();
        vi.stubGlobal("location", { assign, href: "https://app/" });
        const h = new HostedAuth({ auth: {} as never, session: new SessionState(new MemorySessionStore()), authBaseUrl: "https://auth.test" });
        h.logout({ appId: "a1", redirectUri: "https://app/bye?x=1" });
        expect(assign).toHaveBeenCalledWith("https://auth.test/logout?app_id=a1&redirect_uri=https%3A%2F%2Fapp%2Fbye%3Fx%3D1");
    });
});
