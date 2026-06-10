/**
 * Legacy → vault MIGRATION (M1.3) END-TO-END against a LIVE deployment.
 *
 * Creates a *legacy* account (raw zk-register with the password-derived identity,
 * NO vault factor — the pre-vault shape), then logs in through the vault-aware
 * SDK and confirms it's transparently migrated: a password factor is enrolled,
 * the commitment is preserved, and a subsequent login works through the vault.
 *
 *   MUHKOO_BASE_URL=https://api.staging.muhkoo.dev E2E_STAGING=1 \
 *     npx vitest --run tests/auth/vault-migration.e2e.test.ts
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
import { exportPublicKeyHex, exportPublicKeyBase64 } from "../../src/auth/keys";

const BASE_URL = process.env.MUHKOO_BASE_URL || "";
const RUN = process.env.E2E_STAGING === "1" && !!BASE_URL;

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmUrl = path.resolve(here, "../../circuits/build/preimagePoK_js/preimagePoK.wasm");
const zkeyUrl = path.resolve(here, "../../circuits/build/preimagePoK_0001.zkey");
const circuitsPresent = fs.existsSync(wasmUrl) && fs.existsSync(zkeyUrl);

const newAuth = (): ZkAuth =>
  new ZkAuth({ auth: new AuthClient({ baseUrl: BASE_URL }), circuits: { wasmUrl, zkeyUrl }, session: new SessionState() });

describe.skipIf(!RUN || !circuitsPresent)("legacy → vault migration — staging e2e", () => {
  it("a legacy account is migrated into the vault on first vault-aware login", async () => {
    const username = `legacy_${Date.now()}`;
    const password = "Legacy-Pass-1";

    // 1. Create a LEGACY account: identity derived FROM the password, registered
    //    raw with NO vault factor (the pre-vault shape).
    const identity = await deriveIdentity(username, password);
    const ecdsaPubHex = await exportPublicKeyHex(identity.ecdsaKeyPair.publicKey);
    const commitment = await buildCommitment(identity.secretHex, identity.saltHex, ecdsaPubHex);
    await new AuthClient({ baseUrl: BASE_URL }).register({
      username,
      commitment,
      ecdhPublicKey: await exportPublicKeyBase64(identity.ecdhKeyPair.publicKey),
      ecdsaPublicKey: await exportPublicKeyBase64(identity.ecdsaKeyPair.publicKey),
      email: null,
    });

    // 2. Log in through the vault-aware SDK → legacy fallback + transparent migrate.
    const auth = newAuth();
    const user = await auth.login(username, password);
    expect(user.commitment).toBe(commitment); // identity preserved

    // 3. The vault now has a password factor (migration happened).
    const factors = await auth.listFactors();
    expect(factors.some((f) => f.type === "password")).toBe(true);

    // 4. A fresh client logs in again → now via the VAULT path → same commitment.
    const user2 = await newAuth().login(username, password);
    expect(user2.commitment).toBe(commitment);
  }, 120_000);
});
