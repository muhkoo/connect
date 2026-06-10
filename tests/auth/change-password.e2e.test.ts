/**
 * changePassword round-trip (M1) END-TO-END against a LIVE deployment.
 *
 * Reproduces the user-reported "I reset my password and now neither the old nor
 * the new password works" bug: register a vault-backed account, change the
 * password, then FRESH-login with the new password and confirm the SAME identity
 * is recovered via the vault (commitment preserved). Also asserts the old
 * password no longer logs in.
 *
 *   MUHKOO_BASE_URL=https://api.staging.muhkoo.dev E2E_STAGING=1 \
 *     npx vitest --run tests/auth/change-password.e2e.test.ts
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

describe.skipIf(!RUN || !circuitsPresent)("changePassword round-trip — staging e2e", () => {
  it("after changePassword, a fresh login with the NEW password recovers the same identity", async () => {
    const username = `chpw_${Date.now()}`;
    const pw1 = "First-Pass-1";
    const pw2 = "Second-Pass-2";

    // 1. Register vault-backed (seed in memory), capture the commitment.
    const a = newAuth();
    const reg = await a.register({ username, password: pw1, email: null, login: true });

    // 2. Change the password (re-wraps the unchanged seed under pw2's OPRF key).
    await a.changePassword(pw2);

    // 3. FRESH client logs in with the NEW password → same commitment.
    const user2 = await newAuth().login(username, pw2);
    expect(user2.commitment).toBe(reg.commitment);

    // 4. The OLD password must NOT log in (its factor was overwritten).
    await expect(newAuth().login(username, pw1)).rejects.toThrow();
  }, 120_000);
});
