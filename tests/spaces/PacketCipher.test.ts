/**
 * PacketCipher tests — verify the two cipher strategies Network can plug in:
 *   - DoubleRatchetCipher preserves the historical header contract.
 *   - SpacePacketCipher seals/opens with a group key, never exposing the
 *     plaintext (server-blind invariant) and returning null for epochs we lack.
 */

import { describe, it, expect } from "vitest";
import { DoubleRatchetCipher } from "../../src/network/PacketCipher";
import { SpacePacketCipher, type EpochKeyProvider } from "../../src/spaces/SpacePacketCipher";
import { generateSpaceKey } from "../../src/spaces/SpaceCipher";
import { Message } from "../../src/messaging/Message";

describe("DoubleRatchetCipher — contract (regression)", () => {
    it("seals into { encrypted, cipherMessage } headers and recognizes them", async () => {
        // Duck-typed ratchet manager: we only assert the header shape, not DR crypto.
        const fakeManager = {
            encrypt: async () => ({ ciphertext: "ct", header: { sessionId: "s" } }),
            decrypt: async () => "the-plaintext",
        };
        const cipher = new DoubleRatchetCipher({
            ratchetManager: fakeManager as any,
            clientId: "alice",
            serverId: "server",
            sessionType: "specific",
            getSessionId: () => "session-1",
        });

        const headers = await cipher.seal("serialized-msg", undefined as any);
        expect(headers.encrypted).toBe(true);
        expect(typeof headers.cipherMessage).toBe("string");

        expect(cipher.handles({ encrypted: true, cipherMessage: "{}" })).toBe(true);
        expect(cipher.handles({ spaceSealed: true, iv: "x", ciphertext: "y" })).toBe(false);
        expect(cipher.handles(undefined)).toBe(false);

        expect(await cipher.open({ encrypted: true, cipherMessage: "{}" })).toBe("the-plaintext");
        // Not its frame → returns null, doesn't throw.
        expect(await cipher.open({ spaceSealed: true })).toBeNull();
    });

    it("throws when sealing without an active session", async () => {
        const cipher = new DoubleRatchetCipher({
            ratchetManager: { encrypt: async () => ({}), decrypt: async () => "" } as any,
            clientId: "a",
            serverId: "s",
            sessionType: "specific",
            getSessionId: () => null,
        });
        await expect(cipher.seal("m", undefined as any)).rejects.toThrow(/no active session/);
    });
});

describe("SpacePacketCipher — group-key seal/open", () => {
    function provider(keys: Record<number, Uint8Array>, current: number): EpochKeyProvider {
        return {
            currentEpoch: () => current,
            keyForEpoch: (e) => keys[e],
        };
    }

    it("seals the payload into headers (server-blind) and round-trips it", async () => {
        const k0 = generateSpaceKey();
        const cipher = new SpacePacketCipher(provider({ 0: k0 }, 0), "application/json");

        const msg = new Message({ body: { hi: "there" } });
        const serialized = msg.serialize();

        const headers = await cipher.seal(serialized, undefined as any);
        expect(headers.spaceSealed).toBe(true);
        expect(headers.epoch).toBe(0);
        expect(headers.contentType).toBe("application/json");
        expect(typeof headers.iv).toBe("string");
        expect(typeof headers.ciphertext).toBe("string");
        // The plaintext must not leak into the headers.
        const headerBlob = JSON.stringify(headers);
        expect(headerBlob).not.toContain("there");

        expect(cipher.handles(headers as any)).toBe(true);

        const opened = await cipher.open(headers as any);
        expect(opened).toBe(serialized);
        expect(Message.deserialize(opened!).body).toEqual({ hi: "there" });
    });

    it("returns null for an epoch whose key we don't hold", async () => {
        const k1 = generateSpaceKey();
        // We hold epoch 1; an inbound packet sealed under epoch 0 is undecryptable.
        const cipher = new SpacePacketCipher(provider({ 1: k1 }, 1));
        const sealedUnderUnknownEpoch = await new SpacePacketCipher(
            provider({ 0: generateSpaceKey() }, 0),
        ).seal(new Message({ body: "x" }).serialize(), undefined as any);

        expect(await cipher.open(sealedUnderUnknownEpoch as any)).toBeNull();
    });

    it("throws when sealing under an epoch we have no key for", async () => {
        const cipher = new SpacePacketCipher(provider({}, 5));
        await expect(cipher.seal("m", undefined as any)).rejects.toThrow(/no group key for epoch 5/);
    });
});
