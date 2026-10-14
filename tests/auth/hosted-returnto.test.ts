/**
 * Hosted sign-in `returnTo` (design §6.9, §4.4.9). The app hands `login()` the
 * same-origin path to come back to; it rides the PKCE stash in sessionStorage
 * across the round trip and `handleCallback()` returns it, re-checked, so a
 * tampered stash cannot turn the callback into an open redirect.
 *
 * `handleCallback()` runs end to end here: a Map-backed sessionStorage, a
 * mutable `location`, a no-op `history`, and a fake `auth.token` that answers
 * with a real `sealSeed` envelope whose fragment key sits in `#k`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { HostedAuth, isSameOriginPath } from "../../src/core/namespaces/HostedAuth";
import { sealSeed } from "../../src/auth/hostedHandoff";
import { MemorySessionStore, SessionState } from "../../src/core/Session";

const AUTH = "https://auth.test";
const PKCE_STORE_KEY = "muhkoo.hosted.pkce";

interface FakeLocation {
    search: string;
    hash: string;
    pathname: string;
    href: string;
    assign: ReturnType<typeof vi.fn>;
}

/** sessionStorage stand-in. */
function memSessionStorage(): Storage {
    const map = new Map<string, string>();
    return {
        getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
        setItem: (k: string, v: string) => void map.set(k, String(v)),
        removeItem: (k: string) => void map.delete(k),
        clear: () => map.clear(),
        key: (i: number) => [...map.keys()][i] ?? null,
        get length() { return map.size; },
    };
}

let loc: FakeLocation;
const fakeAuth = new WeakMap<HostedAuth, { token: ReturnType<typeof vi.fn> }>();

beforeEach(() => {
    loc = {
        search: "",
        hash: "",
        pathname: "/auth/callback",
        href: "https://app/auth/callback",
        assign: vi.fn(),
    };
    vi.stubGlobal("sessionStorage", memSessionStorage());
    vi.stubGlobal("location", loc);
    vi.stubGlobal("history", { replaceState() {} });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

function makeHosted(): HostedAuth {
    const auth = { token: vi.fn() };
    const hosted = new HostedAuth({
        auth: auth as never,
        session: new SessionState(new MemorySessionStore()),
        authBaseUrl: AUTH,
    });
    fakeAuth.set(hosted, auth);
    return hosted;
}

/**
 * The hosted page's redirect back: `?code&state` in the query, the one-time
 * handoff key in `#k`, and a token exchange that returns the sealed seed.
 */
async function completeCallback(hosted: HostedAuth) {
    const stash = JSON.parse(sessionStorage.getItem(PKCE_STORE_KEY)!);
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const { sealedKeys, fragmentKey } = await sealSeed(seed);
    fakeAuth.get(hosted)!.token.mockResolvedValue({
        sessionToken: "sess-1",
        username: "matt",
        commitment: "12345",
        sealedKeys,
        appId: stash.appId,
    });
    loc.search = `?code=c&state=${encodeURIComponent(stash.state)}`;
    loc.hash = `#k=${fragmentKey}`;
    return hosted.handleCallback();
}

describe("hosted returnTo (design §6.9, CS-5; §4.4.9 same-origin rule)", () => {
    it("accepts same-origin paths only", () => {
        expect(isSameOriginPath("/chat#general")).toBe(true);
        expect(isSameOriginPath("/")).toBe(true);
        for (const bad of ["//evil.com/x", "https://evil.com", "chat", "/\\evil.com", "/a\u0000b", "", 42]) {
            expect(isSameOriginPath(bad)).toBe(false);
        }
    });

    it("login rejects a non-same-origin returnTo before redirecting", async () => {
        const hosted = makeHosted();
        await expect(hosted.login({ appId: "a", redirectUri: "https://app/cb", redirect: false, returnTo: "//evil.com" }))
            .rejects.toThrow(/same-origin/);
        // With the default redirect too: nothing is stashed and the browser never leaves.
        await expect(hosted.login({ appId: "a", redirectUri: "https://app/cb", returnTo: "https://evil.com" }))
            .rejects.toThrow(/same-origin/);
        expect(loc.assign).not.toHaveBeenCalled();
        expect(sessionStorage.getItem(PKCE_STORE_KEY)).toBeNull();
    });

    it("the returnTo stashed at login comes back from handleCallback", async () => {
        const hosted = makeHosted();
        await hosted.login({ appId: "a", redirectUri: "https://app/cb", redirect: false, returnTo: "/chat#room-1" });
        // simulate the hosted page's redirect back, using the helper's code/state/#k fixtures
        const user = await completeCallback(hosted);
        expect(user.returnTo).toBe("/chat#room-1");
        expect(user.username).toBe("matt");
        expect(user.commitment).toBe("12345");
    });

    it("a tampered stash with a foreign returnTo is dropped, not followed", async () => {
        const hosted = makeHosted();
        await hosted.login({ appId: "a", redirectUri: "https://app/cb", redirect: false, returnTo: "/ok" });
        const raw = JSON.parse(sessionStorage.getItem("muhkoo.hosted.pkce")!);
        sessionStorage.setItem("muhkoo.hosted.pkce", JSON.stringify({ ...raw, returnTo: "https://evil.com" }));
        const user = await completeCallback(hosted);
        expect(user.returnTo).toBeUndefined();
    });

    it("a login without returnTo stashes none and the callback returns none", async () => {
        const hosted = makeHosted();
        await hosted.login({ appId: "a", redirectUri: "https://app/cb", redirect: false });
        expect("returnTo" in JSON.parse(sessionStorage.getItem(PKCE_STORE_KEY)!)).toBe(false);
        const user = await completeCallback(hosted);
        expect("returnTo" in user).toBe(false);
        expect(user.username).toBe("matt");
    });
});
