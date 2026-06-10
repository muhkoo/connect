/**
 * Server-side ECDSA signature verification (M1 hardening) — END-TO-END.
 *
 * The accelerator now verifies the auth-proof's ECDSA signature (proof of
 * private-key possession) on top of the ZK proof. This asserts the gate is LIVE:
 * a VALID Groth16 proof with a WRONG signature is rejected, while the same proof
 * with the correct signature authenticates.
 *
 *   MUHKOO_BASE_URL=https://api.staging.muhkoo.dev E2E_STAGING=1 \
 *     npx vitest --run tests/auth/ecdsa-signature.e2e.test.ts
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { ZkAuth } from "../../src/core/namespaces/AuthNamespace";
import { AuthClient } from "../../src/auth/AuthClient";
import { SessionState } from "../../src/core/Session";
import { generateAuthProof } from "../../src/auth/proof";
import { signMessage, exportPublicKeyHex } from "../../src/auth/keys";

const BASE_URL = process.env.MUHKOO_BASE_URL || "";
const RUN = process.env.E2E_STAGING === "1" && !!BASE_URL;

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmUrl = path.resolve(here, "../../circuits/build/preimagePoK_js/preimagePoK.wasm");
const zkeyUrl = path.resolve(here, "../../circuits/build/preimagePoK_0001.zkey");
const circuits = { wasmUrl, zkeyUrl };
const circuitsPresent = fs.existsSync(wasmUrl) && fs.existsSync(zkeyUrl);

const newAuth = (): ZkAuth =>
  new ZkAuth({ auth: new AuthClient({ baseUrl: BASE_URL }), circuits, session: new SessionState() });

describe.skipIf(!RUN || !circuitsPresent)("ECDSA auth-signature verification — staging e2e", () => {
  it("rejects a valid proof carrying a WRONG signature, accepts the correct one", async () => {
    const username = `sig_${Date.now()}`;
    const password = "Sig-Test-1";

    // Register (vault-backed) and grab the in-memory identity.
    const auth = newAuth();
    await auth.register({ username, password, login: true });
    const identity = auth.identity!;
    expect(identity).toBeTruthy();

    const ac = new AuthClient({ baseUrl: BASE_URL });
    const ecdsaPubHex = await exportPublicKeyHex(identity.ecdsaKeyPair.publicKey);

    // Build a VALID Groth16 proof against a fresh challenge.
    const ch1 = await ac.getChallenge(username);
    const built = await generateAuthProof({
      secretHex: identity.secretHex,
      saltHex: identity.saltHex,
      ecdsaPubHex,
      nonceHex: ch1.nonce,
      circuits,
    });

    // WRONG signature: well-formed (signs a different message), so it must be
    // rejected by the crypto check, not by a shape/length error.
    const badSig = await signMessage("not-the-proof", identity.ecdsaKeyPair.privateKey);
    await expect(
      ac.authenticate({
        challengeId: ch1.challengeId,
        proof: { commitment: built.commitment, nonce: ch1.nonce, response: { proof: built.proof, publicSignals: built.publicSignals }, signature: badSig },
      }),
    ).rejects.toThrow();

    // CORRECT signature over the same proof on a fresh challenge → authenticates.
    const ch2 = await ac.getChallenge(username);
    const built2 = await generateAuthProof({
      secretHex: identity.secretHex,
      saltHex: identity.saltHex,
      ecdsaPubHex,
      nonceHex: ch2.nonce,
      circuits,
    });
    const goodSig = await signMessage(JSON.stringify(built2.proof), identity.ecdsaKeyPair.privateKey);
    const result = await ac.authenticate({
      challengeId: ch2.challengeId,
      proof: { commitment: built2.commitment, nonce: ch2.nonce, response: { proof: built2.proof, publicSignals: built2.publicSignals }, signature: goodSig },
    });
    expect(result.token).toBeTruthy();
  }, 120_000);
});
