/**
 * SDK-level identity-vault auth (M1.0 Increment 3) END-TO-END against a LIVE
 * deployment, through the real `ZkAuth` namespace.
 *
 * The decisive check: register a user (identity now descends from a RANDOM seed,
 * enrolled as an OPRF password factor), then log in from a BRAND-NEW `ZkAuth`
 * instance — with only username+password and no in-memory seed — and recover the
 * SAME commitment. That only works if the vault unlocked the random seed.
 *
 *   MUHKOO_BASE_URL=https://api.staging.muhkoo.dev E2E_STAGING=1 \
 *     npx vitest --run tests/auth/vault-sdk.e2e.test.ts
 *
 * NOTE: use MUHKOO_BASE_URL, not BASE_URL — BASE_URL is a reserved Vite var
 * (`import.meta.env.BASE_URL`, default "/") and gets overridden in this project.
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

function newAuth(): ZkAuth {
  return new ZkAuth({
    auth: new AuthClient({ baseUrl: BASE_URL }),
    circuits: { wasmUrl, zkeyUrl },
    session: new SessionState(),
  });
}

describe.skipIf(!RUN || !circuitsPresent)("SDK vault auth — staging e2e", () => {
  it("register (vault-backed) → fresh login recovers the SAME identity via the vault", async () => {
    const username = `sdkvault_${Date.now()}`;
    const password = "Correct-Horse-9";

    const regAuth = newAuth();
    const reg = await regAuth.register({ username, password, email: null }); // login:true (default)
    expect(reg.username).toBe(username);
    expect(reg.commitment).toMatch(/^\d+$/);

    // The web's register flow provisions the personal space using the SDK's REAL
    // identity (not a password-re-derived one), so these must be populated + match
    // the registered commitment after register(login:true).
    expect(regAuth.identity).toBeTruthy();
    expect(regAuth.user?.commitment).toBe(reg.commitment);

    // DECISIVE: the personal space the web provisions must be initialized for the
    // SDK's commitment (this is what 404'd as "Space not initialized" in the web).
    const ch = await fetch(`${BASE_URL}/api/personal/${reg.commitment}/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(ch.status).toBe(200); // NOT 404 "Space not initialized"

    // Brand-new ZkAuth, only username+password — must recover the random-seed
    // identity through the vault, i.e. the same commitment.
    const user = await newAuth().login(username, password);
    expect(user.commitment).toBe(reg.commitment);

    // Wrong password fails (vault unwrap fails → legacy fallback derives the wrong
    // identity → the proof is rejected).
    await expect(newAuth().login(username, "wrong-password")).rejects.toThrow();
  }, 90_000);
});
