/**
 * `auth.zk.loginWithDevice` — the primitive single sign-on rests on.
 *
 * A paired browser holds a key that opens a server-held blob; the seed itself is
 * never at rest. `unlockWithDevice` recovers the seed but no session, which suits
 * a CLI holding a token on disk and fails a browser whose session has expired
 * while the pairing is still valid. These pin that the login variant recovers
 * BOTH, and that a revoked pairing is refused in a way the caller can act on.
 */
import { describe, it, expect, vi } from "vitest";

// The only stub: a real Groth16 prove would need snarkjs plus a wasm/zkey fetch.
// `buildCommitment` stays real, so the identity actually derives from the seed.
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

import { ZkAuth, DeviceRevokedError } from "../../src/core/namespaces/AuthNamespace";
import { SessionState } from "../../src/core/Session";
import { wrapKeyFromBytes, wrapSeed, randomSeed, toBase64 } from "../../src/auth/vault";

const USERNAME = "paired-user";
const DEVICE_WRAP_INFO = "muhkoo-device-key-v1";

/** A vault holding one `device` factor, wrapped exactly as `enrollDevice` does. */
async function pairedVault() {
    const seed = randomSeed();
    const keyBytes = randomSeed();
    const wrapped = await wrapSeed(seed, await wrapKeyFromBytes(keyBytes, DEVICE_WRAP_INFO));
    return {
        seed,
        deviceKey: toBase64(keyBytes),
        factorId: "device:abc123",
        factor: { id: "device:abc123", type: "device", wrap: wrapped.ct, iv: wrapped.iv },
    };
}

function newAuth(vaultFactor: unknown, onAuthenticate?: () => void) {
    const calls = { challenges: 0, authenticates: 0 };
    const session = new SessionState();
    const auth = new ZkAuth({
        session,
        circuits: { wasmUrl: "x", zkeyUrl: "y" },
        auth: {
            vaultRead: async () => ({ factor: vaultFactor }),
            getChallenge: async () => { calls.challenges++; return { challengeId: "c1", nonce: "00ff" }; },
            authenticate: async () => {
                calls.authenticates++;
                onAuthenticate?.();
                return { token: "session-token-xyz", username: USERNAME };
            },
        } as never,
    } as never);
    return { auth, session, calls };
}

describe("loginWithDevice", () => {
    it("recovers the seed AND a session, so an expired session needs no password", async () => {
        const v = await pairedVault();
        const { auth, session, calls } = newAuth(v.factor);

        const user = await auth.loginWithDevice(USERNAME, v.factorId, v.deviceKey);

        expect(user.username).toBe(USERNAME);
        expect(session.token).toBe("session-token-xyz");           // authenticated
        expect(auth.seedBase64).toBe(toBase64(v.seed));            // and decryption-capable
        expect(calls.authenticates).toBe(1);
    });

    it("derives the same identity the password path would", async () => {
        // The seed IS the identity's source, which is why proving from it is
        // sound rather than a shortcut. Two logins from the same factor must
        // land on the same account.
        const v = await pairedVault();
        const a = newAuth(v.factor);
        const b = newAuth(v.factor);
        const first = await a.auth.loginWithDevice(USERNAME, v.factorId, v.deviceKey);
        const second = await b.auth.loginWithDevice(USERNAME, v.factorId, v.deviceKey);
        expect(first.commitment).toBeTruthy();          // else this compares two undefineds
        expect(first.commitment).toBe(second.commitment);
    });

    it("throws DeviceRevokedError when the pairing is gone, without authenticating", async () => {
        // Typed, because the correct response is specific: discard the stored key
        // and fall back to a password. Retrying cannot succeed, and re-pairing
        // silently would undo a revocation the user performed on purpose.
        const v = await pairedVault();
        const { auth, calls } = newAuth(null);
        await expect(auth.loginWithDevice(USERNAME, v.factorId, v.deviceKey))
            .rejects.toBeInstanceOf(DeviceRevokedError);
        expect(calls.authenticates).toBe(0);
    });

    it("fails to decrypt — not to resolve — when the key is wrong", async () => {
        // Distinguishable from revocation on purpose: a wrong key is a local
        // problem, a missing factor is an account decision.
        const v = await pairedVault();
        const { auth } = newAuth(v.factor);
        const wrongKey = toBase64(randomSeed());
        await expect(auth.loginWithDevice(USERNAME, v.factorId, wrongKey)).rejects.toThrow();
        await expect(auth.loginWithDevice(USERNAME, v.factorId, wrongKey))
            .rejects.not.toBeInstanceOf(DeviceRevokedError);
    });

    it("leaves no session behind when the pairing is revoked", async () => {
        const v = await pairedVault();
        const { auth, session } = newAuth(null);
        await auth.loginWithDevice(USERNAME, v.factorId, v.deviceKey).catch(() => {});
        expect(session.token).toBeFalsy();
        expect(auth.seedBase64).toBeNull();
    });
});

describe("unlockWithDevice keeps its narrower contract", () => {
    it("recovers the seed but does NOT authenticate", async () => {
        const v = await pairedVault();
        const { auth, session, calls } = newAuth(v.factor);
        await auth.unlockWithDevice(USERNAME, v.factorId, v.deviceKey);
        expect(auth.seedBase64).toBe(toBase64(v.seed));
        expect(session.token).toBeFalsy();
        expect(calls.authenticates).toBe(0);
    });
});
