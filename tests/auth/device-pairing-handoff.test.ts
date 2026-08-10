/**
 * v2 device-pairing handoff crypto (TV pairing for hosted auth) — pure unit
 * tests, no network.
 *
 * What these prove:
 *   - the ECDH seal round-trips a master seed byte-for-byte;
 *   - only the holder of the matching private key can open it;
 *   - the seal is non-deterministic (fresh ephemeral key + IV per call);
 *   - every field of the envelope is authenticated (ct / iv / epk);
 *   - the LIVE v1 fragment-key handoff is untouched;
 *   - the human-comparable verification code is deterministic and separating.
 */

import { describe, it, expect } from "vitest";
import {
    sealSeed,
    unsealSeed,
    generateDevicePairingKeypair,
    sealSeedToDevice,
    unsealSeedFromDevice,
    pairingVerificationCode,
    PAIRING_CODE_ALPHABET,
    PAIRING_CODE_LENGTH,
} from "../../src/auth/hostedHandoff";

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

/** Decode a `sealedKeys` string back into its JSON envelope. */
function openEnvelope(sealedKeys: string): any {
    return JSON.parse(Buffer.from(sealedKeys, "base64").toString());
}

/** Re-encode a (possibly mutated) envelope back into a `sealedKeys` string. */
function closeEnvelope(env: any): string {
    return Buffer.from(JSON.stringify(env)).toString("base64");
}

/** Flip one bit in a base64 field of an envelope and return the new sealedKeys. */
function tamper(sealedKeys: string, field: "ct" | "iv" | "epk", index = 0): string {
    const env = openEnvelope(sealedKeys);
    const bytes = unb64(env[field]);
    bytes[index] ^= 0xff;
    env[field] = b64(bytes);
    return closeEnvelope(env);
}

describe("v2 device-pairing handoff (ECDH seal)", () => {
    it("round-trips the master seed byte-for-byte", async () => {
        const seed = crypto.getRandomValues(new Uint8Array(32));
        const device = await generateDevicePairingKeypair();

        const sealedKeys = await sealSeedToDevice(seed, device.publicKeyB64);
        const out = await unsealSeedFromDevice(sealedKeys, device.privateKey, device.publicKeyB64);

        expect(out).toBeInstanceOf(Uint8Array);
        expect(out.length).toBe(32);
        expect(Buffer.from(out).equals(Buffer.from(seed))).toBe(true);
    });

    it("round-trips a non-32-byte payload too (no length assumption baked in)", async () => {
        const seed = crypto.getRandomValues(new Uint8Array(64));
        const device = await generateDevicePairingKeypair();
        const out = await unsealSeedFromDevice(await sealSeedToDevice(seed, device.publicKeyB64), device.privateKey, device.publicKeyB64);
        expect(Buffer.from(out).equals(Buffer.from(seed))).toBe(true);
    });

    it("emits a well-formed v2 envelope carrying an ephemeral public key", async () => {
        const seed = crypto.getRandomValues(new Uint8Array(32));
        const device = await generateDevicePairingKeypair();
        const env = openEnvelope(await sealSeedToDevice(seed, device.publicKeyB64));

        expect(env.v).toBe(2);
        expect(typeof env.epk).toBe("string");
        expect(unb64(env.epk).length).toBe(65); // SEC1 uncompressed P-256
        expect(unb64(env.epk)[0]).toBe(0x04);
        expect(unb64(env.iv).length).toBe(12);
        // AES-GCM: 32-byte plaintext + 16-byte tag.
        expect(unb64(env.ct).length).toBe(48);

        // The sealer's ephemeral key is NOT the device key — this is a fresh
        // keypair per seal, not an echo of the recipient.
        expect(env.epk).not.toBe(device.publicKeyB64);
    });

    it("the envelope leaks no seed bytes", async () => {
        const seed = new Uint8Array(32).fill(0xab);
        const device = await generateDevicePairingKeypair();
        const sealedKeys = await sealSeedToDevice(seed, device.publicKeyB64);
        const env = openEnvelope(sealedKeys);
        // A 32-byte run of 0xab must not appear anywhere in the ciphertext.
        expect(Buffer.from(unb64(env.ct)).includes(Buffer.from(seed))).toBe(false);
    });

    it("a DIFFERENT keypair cannot unseal (throws, does not return garbage)", async () => {
        const seed = crypto.getRandomValues(new Uint8Array(32));
        const device = await generateDevicePairingKeypair();
        const attacker = await generateDevicePairingKeypair();

        const sealedKeys = await sealSeedToDevice(seed, device.publicKeyB64);
        await expect(unsealSeedFromDevice(sealedKeys, attacker.privateKey, attacker.publicKeyB64)).rejects.toThrow();
    });

    it("two seals of the same seed to the same public key differ, yet both unseal", async () => {
        const seed = crypto.getRandomValues(new Uint8Array(32));
        const device = await generateDevicePairingKeypair();

        const a = await sealSeedToDevice(seed, device.publicKeyB64);
        const b = await sealSeedToDevice(seed, device.publicKeyB64);
        expect(a).not.toBe(b);

        const envA = openEnvelope(a);
        const envB = openEnvelope(b);
        expect(envA.ct).not.toBe(envB.ct);
        expect(envA.iv).not.toBe(envB.iv);
        expect(envA.epk).not.toBe(envB.epk); // fresh ephemeral keypair per seal

        expect(Buffer.from(await unsealSeedFromDevice(a, device.privateKey, device.publicKeyB64)).equals(Buffer.from(seed))).toBe(true);
        expect(Buffer.from(await unsealSeedFromDevice(b, device.privateKey, device.publicKeyB64)).equals(Buffer.from(seed))).toBe(true);
    });

    it("tampering with ct fails the AES-GCM tag", async () => {
        const seed = crypto.getRandomValues(new Uint8Array(32));
        const device = await generateDevicePairingKeypair();
        const sealedKeys = await sealSeedToDevice(seed, device.publicKeyB64);
        await expect(unsealSeedFromDevice(tamper(sealedKeys, "ct"), device.privateKey, device.publicKeyB64)).rejects.toThrow();
    });

    it("tampering with the GCM tag (last ct byte) fails", async () => {
        const seed = crypto.getRandomValues(new Uint8Array(32));
        const device = await generateDevicePairingKeypair();
        const sealedKeys = await sealSeedToDevice(seed, device.publicKeyB64);
        const ctLen = unb64(openEnvelope(sealedKeys).ct).length;
        await expect(
            unsealSeedFromDevice(tamper(sealedKeys, "ct", ctLen - 1), device.privateKey, device.publicKeyB64),
        ).rejects.toThrow();
    });

    it("tampering with iv fails", async () => {
        const seed = crypto.getRandomValues(new Uint8Array(32));
        const device = await generateDevicePairingKeypair();
        const sealedKeys = await sealSeedToDevice(seed, device.publicKeyB64);
        await expect(unsealSeedFromDevice(tamper(sealedKeys, "iv"), device.privateKey, device.publicKeyB64)).rejects.toThrow();
    });

    it("tampering with epk fails (bit-flipped: off-curve point rejected)", async () => {
        const seed = crypto.getRandomValues(new Uint8Array(32));
        const device = await generateDevicePairingKeypair();
        const sealedKeys = await sealSeedToDevice(seed, device.publicKeyB64);
        // Flip inside X (byte 1), leaving the 0x04 prefix intact so it is a
        // shape-valid but almost certainly off-curve point.
        await expect(unsealSeedFromDevice(tamper(sealedKeys, "epk", 1), device.privateKey, device.publicKeyB64)).rejects.toThrow();
    });

    it("substituting a VALID foreign epk fails (key agreement is bound to the envelope)", async () => {
        const seed = crypto.getRandomValues(new Uint8Array(32));
        const device = await generateDevicePairingKeypair();

        const sealedKeys = await sealSeedToDevice(seed, device.publicKeyB64);
        const other = await sealSeedToDevice(seed, device.publicKeyB64);

        const env = openEnvelope(sealedKeys);
        env.epk = openEnvelope(other).epk; // a real, on-curve P-256 point
        await expect(unsealSeedFromDevice(closeEnvelope(env), device.privateKey, device.publicKeyB64)).rejects.toThrow();
    });

    it("splicing ct+iv from another seal fails", async () => {
        const device = await generateDevicePairingKeypair();
        const a = await sealSeedToDevice(crypto.getRandomValues(new Uint8Array(32)), device.publicKeyB64);
        const b = await sealSeedToDevice(crypto.getRandomValues(new Uint8Array(32)), device.publicKeyB64);

        const env = openEnvelope(a);
        const src = openEnvelope(b);
        env.ct = src.ct;
        env.iv = src.iv; // keeps a's epk → wrong key
        await expect(unsealSeedFromDevice(closeEnvelope(env), device.privateKey, device.publicKeyB64)).rejects.toThrow();
    });

    it("rejects malformed / mis-versioned envelopes rather than guessing", async () => {
        const seed = crypto.getRandomValues(new Uint8Array(32));
        const device = await generateDevicePairingKeypair();

        // A v1 envelope must not be opened by the v2 path.
        const { sealedKeys: v1 } = await sealSeed(seed);
        await expect(unsealSeedFromDevice(v1, device.privateKey, device.publicKeyB64)).rejects.toThrow(/version 1/);

        // And a v2 envelope must not be opened by the v1 path.
        const v2 = await sealSeedToDevice(seed, device.publicKeyB64);
        await expect(unsealSeed(v2, "AAAA")).rejects.toThrow(/version 2/);

        // A truncated / non-point public key is rejected at seal time.
        await expect(sealSeedToDevice(seed, b64(new Uint8Array(32)))).rejects.toThrow(/65-byte/);
        await expect(sealSeedToDevice(seed, "")).rejects.toThrow(/non-empty/);
    });

    it("accepts a base64url-encoded device public key (lenient decode)", async () => {
        const seed = crypto.getRandomValues(new Uint8Array(32));
        const device = await generateDevicePairingKeypair();
        const urlSafe = device.publicKeyB64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

        const sealedKeys = await sealSeedToDevice(seed, urlSafe);
        const out = await unsealSeedFromDevice(sealedKeys, device.privateKey, device.publicKeyB64);
        expect(Buffer.from(out).equals(Buffer.from(seed))).toBe(true);
    });

    it("generates a fresh, non-extractable keypair per pairing attempt", async () => {
        const a = await generateDevicePairingKeypair();
        const b = await generateDevicePairingKeypair();

        expect(a.publicKeyB64).not.toBe(b.publicKeyB64);
        expect(unb64(a.publicKeyB64).length).toBe(65);
        expect(unb64(a.publicKeyB64)[0]).toBe(0x04);
        expect(a.privateKey.extractable).toBe(false);
        expect(a.privateKey.type).toBe("private");
        expect((a.privateKey.algorithm as EcKeyAlgorithm).namedCurve).toBe("P-256");
        await expect(crypto.subtle.exportKey("jwk", a.privateKey)).rejects.toThrow();
    });
});

describe("pairing verification code", () => {
    it("is deterministic for a given public key", async () => {
        const device = await generateDevicePairingKeypair();
        const a = await pairingVerificationCode(device.publicKeyB64);
        const b = await pairingVerificationCode(device.publicKeyB64);
        expect(a).toBe(b);
    });

    it("agrees across encodings of the same key (both screens compute the same code)", async () => {
        const device = await generateDevicePairingKeypair();
        const urlSafe = device.publicKeyB64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
        expect(await pairingVerificationCode(urlSafe)).toBe(await pairingVerificationCode(device.publicKeyB64));
    });

    it("differs for different public keys", async () => {
        const codes = new Set<string>();
        for (let i = 0; i < 25; i++) {
            const d = await generateDevicePairingKeypair();
            codes.add(await pairingVerificationCode(d.publicKeyB64));
        }
        expect(codes.size).toBe(25);
    });

    it("uses only the unambiguous alphabet and the declared length", async () => {
        expect(PAIRING_CODE_ALPHABET.length).toBe(30); // rejection-sampled, so no modulo bias
        expect(new Set(PAIRING_CODE_ALPHABET).size).toBe(30); // no duplicate symbols
        for (const bad of ["0", "1", "I", "L", "O", "U"]) expect(PAIRING_CODE_ALPHABET).not.toContain(bad);

        for (let i = 0; i < 10; i++) {
            const d = await generateDevicePairingKeypair();
            const code = await pairingVerificationCode(d.publicKeyB64);
            expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
            const bare = code.replace("-", "");
            expect(bare).toHaveLength(PAIRING_CODE_LENGTH);
            for (const ch of bare) expect(PAIRING_CODE_ALPHABET).toContain(ch);
        }
    });

    it("is a known-answer function of the key bytes (locks the derivation)", async () => {
        // A fixed, valid P-256 point: the generator G, as SEC1 uncompressed.
        const G = "BGsX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT+NC4v4af5uO5+tKfA+eFivOM1drMV7Oy7ZAaDe/UfU=";
        // Pinning the output makes any accidental change to the domain string,
        // the digest, or the bit-packing a loud test failure rather than a
        // silent break of the "compare the code on both screens" guarantee
        // (the two screens run different builds of this function).
        expect(await pairingVerificationCode(G)).toBe("WQ7V-FDWJ");
    });

    // The reason deriveDeviceSealKey mixes the RECIPIENT key into HKDF.
    //
    // P-256 ECDH returns only the shared point's x-coordinate, and negating a
    // public key — (x, y) -> (x, p-y) — is on-curve and computable by anyone
    // from the published key, yet yields the SAME x. So a seal addressed to the
    // negated key would decrypt under the honest private key unless the KDF
    // binds the recipient. Note the negated key shows a DIFFERENT verification
    // code, so without this the human check would be the only thing objecting.
    it("rejects a seal addressed to the NEGATED device key (recipient is bound into the KDF)", async () => {
        const device = await generateDevicePairingKeypair();
        const raw = Buffer.from(device.publicKeyB64, "base64");
        expect(raw.length).toBe(65);
        expect(raw[0]).toBe(0x04);

        // y' = p - y over the P-256 prime.
        const P = 2n ** 256n - 2n ** 224n + 2n ** 192n + 2n ** 96n - 1n;
        const y = BigInt("0x" + raw.subarray(33).toString("hex"));
        const negY = P - y;
        const negated = Buffer.from(raw);
        Buffer.from(negY.toString(16).padStart(64, "0"), "hex").copy(negated, 33);
        const negatedB64 = negated.toString("base64");

        // Same x, different point: the codes must differ (so a human COULD catch it)...
        expect(await pairingVerificationCode(negatedB64)).not.toBe(
            await pairingVerificationCode(device.publicKeyB64),
        );

        // ...and the crypto must catch it without relying on the human.
        const sealedToNegated = await sealSeedToDevice(new Uint8Array(32).fill(9), negatedB64);
        await expect(
            unsealSeedFromDevice(sealedToNegated, device.privateKey, device.publicKeyB64),
        ).rejects.toThrow();
    });

    it("rejects a malformed public key", async () => {
        await expect(pairingVerificationCode("not-base64-at-all!!")).rejects.toThrow();
        await expect(pairingVerificationCode(b64(new Uint8Array(64)))).rejects.toThrow(/65-byte/);
    });
});

describe("v1 fragment-key handoff (regression — LIVE in production)", () => {
    it("still seals and unseals", async () => {
        const seed = crypto.getRandomValues(new Uint8Array(32));
        const { sealedKeys, fragmentKey } = await sealSeed(seed);
        const out = await unsealSeed(sealedKeys, fragmentKey);
        expect(Buffer.from(out).equals(Buffer.from(seed))).toBe(true);
    });

    it("still emits a v1 envelope with exactly the original field set", async () => {
        const { sealedKeys } = await sealSeed(crypto.getRandomValues(new Uint8Array(32)));
        const env = openEnvelope(sealedKeys);
        expect(env.v).toBe(1);
        expect(Object.keys(env).sort()).toEqual(["ct", "iv", "v"]); // no epk crept in
        expect(unb64(env.iv).length).toBe(12);
    });

    it("still refuses the wrong fragment key and tampered ciphertext", async () => {
        const seed = crypto.getRandomValues(new Uint8Array(32));
        const { sealedKeys, fragmentKey } = await sealSeed(seed);
        const wrong = (await sealSeed(seed)).fragmentKey;
        await expect(unsealSeed(sealedKeys, wrong)).rejects.toThrow();
        await expect(unsealSeed(tamper(sealedKeys, "ct"), fragmentKey)).rejects.toThrow();
    });

    it("v1 and v2 keying are independent (a v1 fragment key opens nothing in v2)", async () => {
        const seed = crypto.getRandomValues(new Uint8Array(32));
        const device = await generateDevicePairingKeypair();
        const v2 = await sealSeedToDevice(seed, device.publicKeyB64);
        const { fragmentKey } = await sealSeed(seed);
        await expect(unsealSeed(v2, fragmentKey)).rejects.toThrow();
    });
});
