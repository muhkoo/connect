/**
 * Unit tests for the M1.0 identity-vault crypto: OPRF, seed↔identity split, and
 * the AES-GCM seed wrap/unwrap (the full password-factor flow). All pure/local.
 */
import { describe, it, expect } from "vitest";
import {
  oprfBlind, oprfFinalize, oprfDeriveKey, oprfBlindEvaluate, oprfEvaluate,
} from "../../src/auth/oprf";
import {
  randomSeed, passwordPreHash, wrapKeyFromOprf, wrapKeyFromBytes, wrapSeed, unwrapSeed,
} from "../../src/auth/vault";
import {
  deriveIdentity, deriveIdentityFromSeed, deriveMasterSeedFromPassword,
} from "../../src/auth/identity";
import { seedToMnemonic, mnemonicToSeed, isValidPhrase } from "../../src/auth/recoveryPhrase";

const enc = (s: string) => new TextEncoder().encode(s);
const eq = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

describe("OPRF (ristretto255, RFC 9497)", () => {
  it("blinded path equals direct evaluation (correctness)", () => {
    const key = oprfDeriveKey(new Uint8Array(32).fill(9));
    const input = enc("scrypt-output");
    const { blind, blinded } = oprfBlind(input);
    const evaluated = oprfBlindEvaluate(key, blinded);
    const out = oprfFinalize(input, blind, evaluated);
    expect(eq(out, oprfEvaluate(key, input))).toBe(true);
  });
  it("blinding is randomized (server can't correlate repeated inputs)", () => {
    const input = enc("same-input");
    expect(eq(oprfBlind(input).blinded, oprfBlind(input).blinded)).toBe(false);
  });
  it("different keys or inputs give different outputs", () => {
    const k1 = oprfDeriveKey(new Uint8Array(32).fill(1));
    const k2 = oprfDeriveKey(new Uint8Array(32).fill(2));
    expect(eq(oprfEvaluate(k1, enc("a")), oprfEvaluate(k2, enc("a")))).toBe(false);
    expect(eq(oprfEvaluate(k1, enc("a")), oprfEvaluate(k1, enc("b")))).toBe(false);
  });
  it("server key is deterministic from its seed", () => {
    expect(eq(oprfDeriveKey(new Uint8Array(32).fill(5)), oprfDeriveKey(new Uint8Array(32).fill(5)))).toBe(true);
  });
});

describe("seed ↔ identity split", () => {
  it("deriveIdentity == deriveIdentityFromSeed(legacy seed) — commitment preserved", async () => {
    const u = "alice", p = "correct horse battery staple";
    const viaPassword = await deriveIdentity(u, p);
    const viaSeed = await deriveIdentityFromSeed(await deriveMasterSeedFromPassword(u, p));
    expect(viaSeed.secretHex).toBe(viaPassword.secretHex);
    expect(viaSeed.saltHex).toBe(viaPassword.saltHex);
  });
  it("a random seed yields a valid, well-formed identity", async () => {
    const id = await deriveIdentityFromSeed(randomSeed());
    expect(id.secretHex).toMatch(/^[0-9a-f]{64}$/);
    expect(id.ecdsaKeyPair.privateKey).toBeTruthy();
    expect(id.ecdhKeyPair.privateKey).toBeTruthy();
  });
  it("rejects a wrong-length seed", async () => {
    await expect(deriveIdentityFromSeed(new Uint8Array(16))).rejects.toThrow();
  });
});

describe("seed vault wrap/unwrap", () => {
  it("scrypt pre-hash is deterministic + salted by username", () => {
    expect(eq(passwordPreHash("bob", "pw"), passwordPreHash("bob", "pw"))).toBe(true);
    expect(eq(passwordPreHash("bob", "pw"), passwordPreHash("carol", "pw"))).toBe(false);
  });

  it("full password factor: scrypt → OPRF → wrap; unwrap recovers the seed; wrong password fails", async () => {
    const seed = randomSeed();
    const serverKey = oprfDeriveKey(new Uint8Array(32).fill(7));

    // enroll: client computes the wrap key via the (simulated) server OPRF eval
    const wrapKeyFor = async (username: string, password: string) => {
      const pre = passwordPreHash(username, password);
      const { blind, blinded } = oprfBlind(pre);
      const evaluated = oprfBlindEvaluate(serverKey, blinded); // server side
      return wrapKeyFromOprf(oprfFinalize(pre, blind, evaluated));
    };

    const key = await wrapKeyFor("dave", "hunter2");
    const wrapped = await wrapSeed(seed, key);
    expect(eq(await unwrapSeed(wrapped, key), seed)).toBe(true);

    const wrongKey = await wrapKeyFor("dave", "wrongpw");
    await expect(unwrapSeed(wrapped, wrongKey)).rejects.toThrow();
  });

  it("passkey-style wrap (raw PRF key material) roundtrips", async () => {
    const seed = randomSeed();
    const prf = crypto.getRandomValues(new Uint8Array(32));
    const key = await wrapKeyFromBytes(prf, "muhkoo-passkey-wrap");
    expect(eq(await unwrapSeed(await wrapSeed(seed, key), key), seed)).toBe(true);
  });
});

describe("recovery phrase (BIP39)", () => {
  it("seed → 24-word mnemonic → seed roundtrips", () => {
    const seed = randomSeed();
    const m = seedToMnemonic(seed);
    expect(m.split(" ").length).toBe(24);
    expect(eq(mnemonicToSeed(m), seed)).toBe(true);
  });
  it("tolerates surrounding whitespace + case", () => {
    const seed = randomSeed();
    const m = seedToMnemonic(seed);
    expect(eq(mnemonicToSeed(`   ${m.toUpperCase()}   `), seed)).toBe(true);
  });
  it("rejects an invalid phrase", () => {
    expect(isValidPhrase("not a real recovery phrase at all")).toBe(false);
    expect(() => mnemonicToSeed("not a real recovery phrase")).toThrow();
  });
  it("requires a 32-byte seed", () => {
    expect(() => seedToMnemonic(new Uint8Array(16))).toThrow();
  });
});
