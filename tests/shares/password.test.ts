import { describe, it, expect } from "vitest";
import { passwordProof, newPasswordVerifier } from "../../src/shares/password";

const sha256b64 = async (b64: string) => {
    const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", raw))));
};

describe("share password", () => {
    it("proof of the right password hashes to the verifier, a wrong one does not", async () => {
        const v = await newPasswordVerifier("correct horse");
        expect(v.iterations).toBe(310_000);
        const good = await passwordProof("correct horse", v.salt, v.iterations);
        expect(atob(good)).toHaveLength(32);
        expect(await sha256b64(good)).toBe(v.verifier);
        expect(await sha256b64(await passwordProof("wrong", v.salt, v.iterations))).not.toBe(v.verifier);
    });

    it("uses a fresh salt each time", async () => {
        expect((await newPasswordVerifier("x")).salt).not.toBe((await newPasswordVerifier("x")).salt);
    });

    it("normalizes NFC/NFD passwords to the same proof", async () => {
        const nfc = "caf\u00e9";
        const nfd = "cafe\u0301";
        expect(nfc).not.toBe(nfd);
        expect(await passwordProof(nfc, "salt", 100_000)).toBe(await passwordProof(nfd, "salt", 100_000));
    });

    it("rejects iteration counts outside [100_000, 2_000_000]", { timeout: 30_000 }, async () => {
        await expect(passwordProof("p", "s", 99_999)).rejects.toThrow(/iterations/);
        await expect(passwordProof("p", "s", 2_000_001)).rejects.toThrow(/iterations/);
        await expect(passwordProof("p", "s", 100_000)).resolves.toBeTruthy();
        await expect(passwordProof("p", "s", 2_000_000)).resolves.toBeTruthy();
    });
});
