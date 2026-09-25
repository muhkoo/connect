/**
 * A protocol refusal from the vault must be LOUD, and must never reach the
 * legacy fallback.
 *
 * `login`/`unlock` both do:
 *
 *     const vaultSeed = await this.tryUnlockSeed(username, password);
 *     const seed = vaultSeed ?? await deriveMasterSeedFromPassword(username, password);
 *
 * That `??` is correct for a decoy read (an account with no password factor) and
 * must stay. What must NOT flow into it is a server that refused this client's
 * OPRF protocol: the fallback would derive a DIFFERENT seed, and on a
 * legacy-migrated account — where the fallback seed happens to be the right one —
 * `migrateLegacyPasswordFactor` would then rewrite the factor as a side effect of
 * a failure nobody was told about.
 *
 * Today a 409 surfaces as `VaultUnavailableError` ("check your connection"),
 * which is wrong in a way that costs a support ticket rather than a seed: the
 * catch that produces it is over-broad, and it classifies by regex-matching the
 * server's human sentence. These tests pin the typed error instead, and pin that
 * the migration side effect cannot fire.
 *
 * There is no other unit coverage of `login`/`unlock`/`tryUnlockSeed` in the
 * suite, so this file is also their first regression net.
 */
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

import { ristretto255_oprf } from "@noble/curves/ed25519.js";

import { ZkAuth, VaultProtocolMismatchError, VaultUnavailableError } from "../../src/core/namespaces/AuthNamespace";
import { AuthHttpError } from "../../src/auth/AuthClient";
import { SessionState } from "../../src/core/Session";
import { OPRF_PROTOCOL_BASE } from "../../src/auth/oprf";
import { toBase64, fromBase64 } from "../../src/auth/vault";

/** A stand-in accelerator OPRF key, so an evaluation is a real group element. */
const SERVER_KEY = ristretto255_oprf.oprf.deriveKeyPair(
    new Uint8Array(32).fill(7),
    new TextEncoder().encode("test-oprf"),
).secretKey;

/** Evaluate for real — `oprfFinalize` rejects anything that is not a point. */
const honestEval = (blinded: string) => ({
    evaluated: toBase64(ristretto255_oprf.oprf.blindEvaluate(SERVER_KEY, fromBase64(blinded))),
});

const USERNAME = "alice";
const PASSWORD = "correct horse battery staple";

/** A vault holding a password factor whose bytes we never need to open. */
const PASSWORD_FACTOR = { id: "password", type: "password", wrap: "AAAA", iv: "BBBB" };

type OprfBehaviour = (blinded: string) => Promise<{ evaluated: string }>;

function newAuth(oprf: OprfBehaviour, factor: unknown = PASSWORD_FACTOR) {
    const calls = { oprf: 0, putFactor: 0 };
    const session = new SessionState();
    const auth = new ZkAuth({
        session,
        circuits: { wasmUrl: "x", zkeyUrl: "y" },
        auth: {
            vaultRead: async () => ({ factor }),
            oprfEvaluate: async (_u: string, blinded: string) => { calls.oprf++; return oprf(blinded); },
            vaultPutFactor: async () => { calls.putFactor++; },
            getChallenge: async () => ({ challengeId: "c1", nonce: "00ff" }),
            authenticate: async () => ({ token: "t".repeat(64), username: USERNAME }),
        } as never,
    } as never);
    return { auth, session, calls };
}

const refuse409 = () =>
    Promise.reject(
        new AuthHttpError("oprfEvaluate", 409, "oprf_protocol_unsupported", "This client asked for an OPRF protocol…"),
    );

describe("vault protocol mismatch", () => {
    it("surfaces a typed error from login instead of falling back to the legacy seed", async () => {
        const { auth, calls } = newAuth(refuse409);

        await expect(auth.login(USERNAME, PASSWORD)).rejects.toBeInstanceOf(VaultProtocolMismatchError);

        // The whole point: the legacy path must not have run, so nothing was
        // written to the vault as a side effect of a refusal.
        expect(calls.putFactor).toBe(0);
    });

    it("surfaces a typed error from unlock too", async () => {
        const { auth, session, calls } = newAuth(refuse409);
        await session.setSession({ token: "t".repeat(64), username: USERNAME, commitment: "1234" });

        await expect(auth.unlock(PASSWORD)).rejects.toBeInstanceOf(VaultProtocolMismatchError);
        expect(calls.putFactor).toBe(0);
    });

    it("does not dress a protocol refusal up as a connectivity problem", async () => {
        const { auth } = newAuth(refuse409);

        // `VaultUnavailableError` means "retry later", which a version mismatch
        // never resolves into. Retrying forever is the behaviour this replaces.
        await expect(auth.login(USERNAME, PASSWORD)).rejects.not.toBeInstanceOf(VaultUnavailableError);
    });

    it("still reports genuine unavailability as unavailable", async () => {
        const { auth } = newAuth(() => Promise.reject(new Error("AuthClient.oprfEvaluate: network down")));

        // The narrowing must not swallow the case it was carved out of.
        await expect(auth.login(USERNAME, PASSWORD)).rejects.toBeInstanceOf(VaultUnavailableError);
    });

    it("declares the protocol it speaks on every evaluation", async () => {
        const sent: unknown[] = [];
        const session = new SessionState();
        const auth = new ZkAuth({
            session,
            circuits: { wasmUrl: "x", zkeyUrl: "y" },
            auth: {
                vaultRead: async () => ({ factor: PASSWORD_FACTOR }),
                oprfEvaluate: async (_u: string, _b: string, protocol?: unknown) => {
                    sent.push(protocol);
                    throw new Error("stop here — we only care about the argument");
                },
                getChallenge: async () => ({ challengeId: "c1", nonce: "00ff" }),
                authenticate: async () => ({ token: "t".repeat(64), username: USERNAME }),
            } as never,
        } as never);

        await auth.login(USERNAME, PASSWORD).catch(() => {});

        expect(sent).toEqual([OPRF_PROTOCOL_BASE]);
    });

    it("leaves the decoy path alone — no factor still means the legacy fallback", async () => {
        // An account with no password factor reads as `{ factor: undefined }`,
        // which is indistinguishable from a decoy by design. That MUST still take
        // the legacy branch, or every pre-vault account stops being able to sign
        // in and migrate.
        // `null`, NOT `undefined` — passing undefined explicitly would trigger
        // the default parameter and hand back a real factor, which is a
        // different test entirely (and quietly evaluates the OPRF twice).
        const { auth, calls } = newAuth(async (blinded) => honestEval(blinded), null);

        await auth.login(USERNAME, PASSWORD);

        expect(calls.oprf).toBe(1); // only the enrollment eval, not an unlock attempt
        expect(calls.putFactor).toBe(1); // migration ran, as it should
    });
});
