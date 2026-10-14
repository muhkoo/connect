import { describe, it, expect } from "vitest";
import { IdentityDirectory } from "../../../src/core/trust/IdentityDirectory";
import { SeedIdentitySigner } from "../../../src/core/trust/IdentitySigner";
import { IdentityLockedError, SpaceTrustError } from "../../../src/core/trust/errors";
import { HttpError } from "../../../src/core/HttpClient";
import { deriveIdentityFromSeed } from "../../../src/auth/identity";
import { exportPublicKeyBase64 } from "../../../src/auth/keys";
import { verifyP256 } from "../../../src/spaces/trust/ik";

function fakeHttp(keys: Record<string, string>, calls: unknown[] = [], status = 200) {
    return {
        async post(path: string, body: { usernames: string[] }) {
            calls.push({ path, body });
            if (status !== 200) throw new HttpError("Too many attempts", status, { error: "Too many attempts" });
            return { keys: Object.fromEntries(body.usernames.map((u) => [u, keys[u] ?? `decoy-${u}`])) };
        },
    };
}

describe("IdentityDirectory (SpecA §4.1 as amended)", () => {
    it("batches at most 64 names per call and lower-cases keys", async () => {
        const calls: unknown[] = [];
        const dir = new IdentityDirectory(fakeHttp({}, calls) as never);
        const names = Array.from({ length: 100 }, (_, i) => `User${i}`);
        const out = await dir.lookupMany(names);
        expect(calls).toHaveLength(2);
        expect(Object.keys(out)).toContain("user99");
    });
    it("caches per Client: a second lookup makes no call", async () => {
        const calls: unknown[] = [];
        const dir = new IdentityDirectory(fakeHttp({ bob: "IKB" }, calls) as never);
        expect(await dir.lookup("Bob")).toBe("IKB");
        expect(await dir.lookup("bob")).toBe("IKB");
        expect(calls).toHaveLength(1);
    });
    it("a 429 is a lookup failure that fails closed", async () => {
        const dir = new IdentityDirectory(fakeHttp({}, [], 429) as never);
        await expect(dir.lookup("bob")).rejects.toMatchObject({ code: "lookup-failed" });
        await expect(dir.lookup("bob")).rejects.toBeInstanceOf(SpaceTrustError);
    });
});

describe("SeedIdentitySigner (SpecA §6.1 KxSigner; slice ruling S12)", () => {
    const seed = new Uint8Array(32).fill(5);
    async function registeredIk() {
        return exportPublicKeyBase64((await deriveIdentityFromSeed(seed)).ecdsaKeyPair.publicKey);
    }
    it("a locked session throws IdentityLockedError", async () => {
        const s = new SeedIdentitySigner({ session: { seed: null, identity: null, username: "alice" } as never, directory: {} as never });
        await expect(s.identityKeyRaw()).rejects.toBeInstanceOf(IdentityLockedError);
    });
    it("signs raw bytes with the registered IK (P1363, verifiable)", async () => {
        const ik = await registeredIk();
        const dir = { lookup: async () => ik };
        const s = new SeedIdentitySigner({ session: { seed, identity: null, username: "alice" } as never, directory: dir as never });
        expect(await s.identityKeyRaw()).toBe(ik);
        const bytes = new Uint8Array([0, 1, 2, 255]);
        const sig = await s.sign(bytes);
        expect(Buffer.from(sig, "base64")).toHaveLength(64);
        expect(await verifyP256(ik, sig, bytes)).toBe(true);
    });
    it("refuses to sign when the derived IK is not the account's registered IK", async () => {
        const other = await exportPublicKeyBase64((await deriveIdentityFromSeed(new Uint8Array(32).fill(6))).ecdsaKeyPair.publicKey);
        const s = new SeedIdentitySigner({ session: { seed, identity: null, username: "alice" } as never, directory: { lookup: async () => other } as never });
        await expect(s.sign(new Uint8Array([1]))).rejects.toBeInstanceOf(IdentityLockedError);
    });
});
