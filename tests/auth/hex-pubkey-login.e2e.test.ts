/**
 * Regression: a login by an account whose ECDSA public key was registered as
 * HEX (the portal's old hand-rolled signup used `exportPublicKeyHex`) must still
 * authenticate now that the server verifies the proof's ECDSA signature.
 *
 * Pre-fix the server decoded the stored pubkey as base64 only, so hex accounts
 * failed with "Invalid proof signature" (Groth16 passed, the sig check didn't).
 *
 *   MUHKOO_BASE_URL=https://api.staging.muhkoo.dev E2E_STAGING=1 \
 *     npx vitest --run tests/auth/hex-pubkey-login.e2e.test.ts
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { ZkAuth } from "../../src/core/namespaces/AuthNamespace";
import { AuthClient } from "../../src/auth/AuthClient";
import { SessionState } from "../../src/core/Session";
import { deriveIdentity } from "../../src/auth/identity";
import { buildCommitment } from "../../src/auth/proof";
import { exportPublicKeyHex } from "../../src/auth/keys";

const BASE_URL = process.env.MUHKOO_BASE_URL || "";
const RUN = process.env.E2E_STAGING === "1" && !!BASE_URL;

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmUrl = path.resolve(here, "../../circuits/build/preimagePoK_js/preimagePoK.wasm");
const zkeyUrl = path.resolve(here, "../../circuits/build/preimagePoK_0001.zkey");
const circuitsPresent = fs.existsSync(wasmUrl) && fs.existsSync(zkeyUrl);

const newAuth = (): ZkAuth =>
  new ZkAuth({ auth: new AuthClient({ baseUrl: BASE_URL }), circuits: { wasmUrl, zkeyUrl }, session: new SessionState() });

describe.skipIf(!RUN || !circuitsPresent)("hex-pubkey account login — staging e2e", () => {
  it("an account registered with a HEX ecdsa pubkey still authenticates", async () => {
    const username = `hexkey_${Date.now()}`;
    const password = "Hex-Key-Pass-1";

    // Register the OLD-PORTAL way: identity from the password, pubkeys as HEX.
    const identity = await deriveIdentity(username, password);
    const ecdsaPubHex = await exportPublicKeyHex(identity.ecdsaKeyPair.publicKey);
    const commitment = await buildCommitment(identity.secretHex, identity.saltHex, ecdsaPubHex);
    await new AuthClient({ baseUrl: BASE_URL }).register({
      username,
      commitment,
      ecdhPublicKey: await exportPublicKeyHex(identity.ecdhKeyPair.publicKey), // HEX
      ecdsaPublicKey: ecdsaPubHex,                                            // HEX
      email: null,
    });

    // Login through the SDK → the server must verify the proof's ECDSA signature
    // against the HEX-stored pubkey (the decode fix).
    const user = await newAuth().login(username, password);
    expect(user.commitment).toBe(commitment);
  }, 120_000);
});
