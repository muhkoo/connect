/**
 * Hosted-auth handoff crypto (AUTH_HOSTED_PLAN.md §3) — pure unit tests, no
 * network. Proves the sealed-seed envelope round-trips and is useless without
 * the exact one-time fragment key.
 */

import { describe, it, expect } from "vitest";
import { sealSeed, unsealSeed, generatePkce, randomState } from "../../src/auth/hostedHandoff";

describe("hosted-auth handoff crypto", () => {
    it("seals and unseals the master seed", async () => {
        const seed = crypto.getRandomValues(new Uint8Array(32));
        const { sealedKeys, fragmentKey } = await sealSeed(seed);
        const out = await unsealSeed(sealedKeys, fragmentKey);
        expect(Buffer.from(out).equals(Buffer.from(seed))).toBe(true);
    });

    it("the sealed envelope is opaque (no seed bytes leak in it)", async () => {
        const seed = new Uint8Array(32).fill(0xab);
        const { sealedKeys, fragmentKey } = await sealSeed(seed);
        // The fragment key never appears in the server-relayed envelope.
        expect(sealedKeys.includes(fragmentKey)).toBe(false);
        // A run with the same seed yields a different envelope (fresh K_t + iv).
        const again = await sealSeed(seed);
        expect(again.sealedKeys).not.toBe(sealedKeys);
        expect(again.fragmentKey).not.toBe(fragmentKey);
    });

    it("fails to unseal with the wrong fragment key", async () => {
        const seed = crypto.getRandomValues(new Uint8Array(32));
        const { sealedKeys } = await sealSeed(seed);
        const wrong = (await sealSeed(seed)).fragmentKey;
        await expect(unsealSeed(sealedKeys, wrong)).rejects.toThrow();
    });

    it("fails to unseal a tampered envelope (AES-GCM auth)", async () => {
        const seed = crypto.getRandomValues(new Uint8Array(32));
        const { sealedKeys, fragmentKey } = await sealSeed(seed);
        const env = JSON.parse(Buffer.from(sealedKeys, "base64").toString());
        const ct = Buffer.from(env.ct, "base64");
        ct[0] ^= 0xff; // flip a ciphertext bit
        env.ct = ct.toString("base64");
        const tampered = Buffer.from(JSON.stringify(env)).toString("base64");
        await expect(unsealSeed(tampered, fragmentKey)).rejects.toThrow();
    });

    it("PKCE challenge is the S256 of the verifier; state is random", async () => {
        const { codeVerifier, codeChallenge } = await generatePkce();
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier)));
        const expected = Buffer.from(digest).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
        expect(codeChallenge).toBe(expected);
        expect(randomState()).not.toBe(randomState());
    });
});
