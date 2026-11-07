import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/auth/proof", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../src/auth/proof")>();
    return {
        ...actual,
        generateAuthProof: vi.fn(async (args: { secretHex: string; saltHex: string; ecdsaPubHex: string }) => ({
            proof: { pi_a: ["1"], pi_b: [["1"]], pi_c: ["1"], protocol: "groth16", curve: "bn128" },
            publicSignals: ["1", "2", "3"],
            commitment: await actual.buildCommitment(args.secretHex, args.saltHex, args.ecdsaPubHex),
            nonceField: "1",
            ecdsaPubHash: "2",
        })),
    };
});

import { ZkAuth, GoogleNotLinkedError as FromNs } from "../../src/core/namespaces/AuthNamespace";
import { GoogleNotLinkedError } from "../../src/api";
import { AuthHttpError, AuthClient } from "../../src/auth/AuthClient";
import { SessionState } from "../../src/core/Session";

function make(googleVerify: (o: unknown) => Promise<unknown>) {
    const vaultRead = vi.fn(async () => ({ factor: null }));
    const auth = new ZkAuth({
        session: new SessionState(),
        circuits: { wasmUrl: "x", zkeyUrl: "y" },
        auth: { googleVerify, vaultRead } as never,
    } as never);
    return { auth, vaultRead };
}

describe("signInWithGoogle", () => {
    it("several accounts -> chooseAccount", async () => {
        const gv = vi.fn(async () => ({ usernames: ["a", "b"] }));
        const { auth } = make(gv);
        expect(await auth.signInWithGoogle("tok")).toEqual({ chooseAccount: ["a", "b"] });
        expect(gv).toHaveBeenCalledWith({ idToken: "tok" });
    });

    it("404 google_not_linked -> GoogleNotLinkedError (same class across entry points)", async () => {
        const { auth } = make(async () => { throw new AuthHttpError("googleVerify", 404, undefined, "google_not_linked"); });
        const err = await auth.signInWithGoogle("tok").catch((e) => e);
        expect(err).toBeInstanceOf(GoogleNotLinkedError);
        expect(err).toBeInstanceOf(FromNs);
        expect(err.name).toBe("GoogleNotLinkedError");
    });

    it("other errors pass through", async () => {
        const { auth } = make(async () => { throw new AuthHttpError("googleVerify", 429, undefined, "slow down"); });
        await expect(auth.signInWithGoogle("tok")).rejects.toBeInstanceOf(AuthHttpError);
    });

    it("one account continues with the returned username from the vault read", async () => {
        const { auth, vaultRead } = make(async () => ({ verifyToken: "vt", sub: "s", emailHint: null, username: "solo" }));
        await expect(auth.signInWithGoogle("tok")).rejects.toThrow(/No Google account is linked/);
        expect(vaultRead).toHaveBeenCalledWith("solo", "google", "vt");
    });

    it("with username behaves as loginWithGoogle", async () => {
        const gv = vi.fn(async () => ({ verifyToken: "vt", sub: "s", emailHint: null }));
        const { auth, vaultRead } = make(gv);
        await expect(auth.signInWithGoogle("tok", { username: "named" })).rejects.toThrow();
        expect(gv).toHaveBeenCalledWith({ idToken: "tok", username: "named" });
        expect(vaultRead).toHaveBeenCalledWith("named", "google", "vt");
    });
});

describe("AuthClient google/redirect wire", () => {
    it("redirectCheck builds the query and googleVerify omits username", async () => {
        const urls: string[] = [];
        const fetchFn = vi.fn(async (u: string) => { urls.push(u); return new Response(JSON.stringify({ allowed: true }), { status: 200 }); });
        const c = new AuthClient({ baseUrl: "https://api.test", fetch: fetchFn } as never);
        expect(await c.redirectCheck("app1", "https://x.test/a?b=1")).toEqual({ allowed: true });
        expect(urls[0]).toBe("https://api.test/api/auth/redirect-check?app_id=app1&redirect_uri=https%3A%2F%2Fx.test%2Fa%3Fb%3D1");
    });
});
