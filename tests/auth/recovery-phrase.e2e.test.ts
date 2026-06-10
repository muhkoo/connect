/**
 * Recovery-phrase (M1.2) END-TO-END against a LIVE deployment, through the real
 * `ZkAuth`. The full "forgot password" journey:
 *
 *   register → enroll a recovery phrase → (fresh client) recover with the phrase
 *   → change the password → the OLD password fails, the NEW one logs in and
 *   recovers the SAME identity.
 *
 *   MUHKOO_BASE_URL=https://api.staging.muhkoo.dev E2E_STAGING=1 \
 *     npx vitest --run tests/auth/recovery-phrase.e2e.test.ts
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { ZkAuth } from "../../src/core/namespaces/AuthNamespace";
import { AuthClient } from "../../src/auth/AuthClient";
import { SessionState } from "../../src/core/Session";

const BASE_URL = process.env.MUHKOO_BASE_URL || "";
const RUN = process.env.E2E_STAGING === "1" && !!BASE_URL;

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmUrl = path.resolve(here, "../../circuits/build/preimagePoK_js/preimagePoK.wasm");
const zkeyUrl = path.resolve(here, "../../circuits/build/preimagePoK_0001.zkey");
const circuitsPresent = fs.existsSync(wasmUrl) && fs.existsSync(zkeyUrl);

const newAuth = (): ZkAuth =>
  new ZkAuth({ auth: new AuthClient({ baseUrl: BASE_URL }), circuits: { wasmUrl, zkeyUrl }, session: new SessionState() });

describe.skipIf(!RUN || !circuitsPresent)("recovery phrase — staging e2e", () => {
  it("register → enroll phrase → recover → change password → old fails / new works", async () => {
    const username = `recover_${Date.now()}`;
    const password = "Original-Pass-1";
    const newPassword = "Brand-New-Pass-2";

    // Register, then enroll a recovery phrase (seed is held in memory post-register).
    const a1 = newAuth();
    const reg = await a1.register({ username, password, email: null });
    const phrase = await a1.enrollRecoveryPhrase();
    expect(phrase.split(" ").length).toBe(24);

    // Forgot password: a brand-new client recovers from the phrase alone.
    const recovered = await newAuth().recoverWithPhrase(username, phrase);
    expect(recovered.commitment).toBe(reg.commitment); // same identity

    // Recover + set a new password in one session.
    const a2 = newAuth();
    await a2.recoverWithPhrase(username, phrase);
    await a2.changePassword(newPassword);

    // The OLD password no longer unlocks the seed → login fails.
    await expect(newAuth().login(username, password)).rejects.toThrow();

    // The NEW password recovers the SAME identity.
    const relogin = await newAuth().login(username, newPassword);
    expect(relogin.commitment).toBe(reg.commitment);
  }, 120_000);
});
