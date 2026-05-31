/**
 * SpaceCipher tests — group key wrap/unwrap, message seal/open, and epoch
 * isolation for the fan-out encryption layer.
 */

import { describe, it, expect } from "vitest";
import {
    generateSpaceKey,
    generateSpaceIdentity,
    encodeSpaceId,
    importEcdhPublicKey,
    exportEcdhPublicKey,
    wrapSpaceKey,
    unwrapSpaceKey,
    sealMessage,
    openMessage,
} from "../../src/spaces/SpaceCipher";
import { Message } from "../../src/messaging/Message";

/** Generate a P-384 ECDH identity keypair the way a member would hold one. */
async function memberIdentity(): Promise<CryptoKeyPair> {
    return (await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-384" },
        true,
        ["deriveBits"],
    )) as CryptoKeyPair;
}

describe("SpaceCipher — identity", () => {
    it("derives a stable, decodable space id from the keypair", async () => {
        const identity = await generateSpaceIdentity();
        expect(typeof identity.id).toBe("string");
        expect(identity.id.length).toBeGreaterThan(32);
        // base64url charset only
        expect(identity.id).toMatch(/^[A-Za-z0-9_-]+$/);

        // id round-trips back to an importable ECDH public key
        const reimported = await importEcdhPublicKey(identity.id);
        expect(await exportEcdhPublicKey(reimported)).toBe(identity.id);
    });
});

describe("SpaceCipher — wrap / unwrap", () => {
    it("round-trips the group key to the intended recipient", async () => {
        const kSpace = generateSpaceKey();
        const bob = await memberIdentity();

        const wrapped = await wrapSpaceKey(kSpace, 0, bob.publicKey);
        expect(wrapped.alg).toContain("AES-256-GCM");
        expect(wrapped.epoch).toBe(0);

        const unwrapped = await unwrapSpaceKey(wrapped, bob.privateKey);
        expect(Array.from(unwrapped)).toEqual(Array.from(kSpace));
    });

    it("fails to unwrap with the wrong private key", async () => {
        const kSpace = generateSpaceKey();
        const bob = await memberIdentity();
        const mallory = await memberIdentity();

        const wrapped = await wrapSpaceKey(kSpace, 0, bob.publicKey);
        await expect(unwrapSpaceKey(wrapped, mallory.privateKey)).rejects.toThrow();
    });

    it("binds the wrap to its epoch — a wrap for epoch 1 won't unwrap as epoch 2", async () => {
        const kSpace = generateSpaceKey();
        const bob = await memberIdentity();

        const wrapped = await wrapSpaceKey(kSpace, 1, bob.publicKey);
        // Tamper only the declared epoch; the HKDF salt no longer matches.
        const forged = { ...wrapped, epoch: 2 };
        await expect(unwrapSpaceKey(forged, bob.privateKey)).rejects.toThrow();
    });
});

describe("SpaceCipher — seal / open", () => {
    it("round-trips a Message and preserves its checksum", async () => {
        const kSpace = generateSpaceKey();
        const msg = new Message({ body: { hello: "world", n: 42 } });

        const { iv, ciphertext } = await sealMessage(kSpace, msg);
        const opened = await openMessage(kSpace, iv, ciphertext);

        expect(opened.body).toEqual({ hello: "world", n: 42 });
        expect(opened.id).toBe(msg.id);
        expect(opened.checksum).toBe(msg.checksum);
        expect(() => opened.verifyChecksum()).not.toThrow();
    });

    it("fails to open with the wrong group key", async () => {
        const kSpace = generateSpaceKey();
        const wrongKey = generateSpaceKey();
        const msg = new Message({ body: "secret" });

        const { iv, ciphertext } = await sealMessage(kSpace, msg);
        await expect(openMessage(wrongKey, iv, ciphertext)).rejects.toThrow();
    });
});

describe("SpaceCipher — epoch isolation (rotate mode)", () => {
    it("a member only opens messages from epochs whose key they hold", async () => {
        // Two epochs, distinct group keys.
        const k0 = generateSpaceKey();
        const k1 = generateSpaceKey();

        // Bob is wrapped into epoch 0 only (e.g. left before epoch 1).
        const bob = await memberIdentity();
        const bobK0 = await unwrapSpaceKey(await wrapSpaceKey(k0, 0, bob.publicKey), bob.privateKey);

        // Carol joins at epoch 1, wrapped into epoch 1 only.
        const carol = await memberIdentity();
        const carolK1 = await unwrapSpaceKey(await wrapSpaceKey(k1, 1, carol.publicKey), carol.privateKey);

        const m0 = await sealMessage(k0, new Message({ body: "epoch0" }));
        const m1 = await sealMessage(k1, new Message({ body: "epoch1" }));

        // Bob reads epoch 0, not epoch 1.
        expect((await openMessage(bobK0, m0.iv, m0.ciphertext)).body).toBe("epoch0");
        await expect(openMessage(bobK0, m1.iv, m1.ciphertext)).rejects.toThrow();

        // Carol reads epoch 1, not epoch 0.
        expect((await openMessage(carolK1, m1.iv, m1.ciphertext)).body).toBe("epoch1");
        await expect(openMessage(carolK1, m0.iv, m0.ciphertext)).rejects.toThrow();
    });
});
