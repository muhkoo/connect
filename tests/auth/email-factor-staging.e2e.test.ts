/**
 * M2.1 email factor against a DEPLOYED env with a REAL mailbox — the staging
 * close-out e2e. Same SDK flow as `email-factor.e2e.test.ts`, but the OTP
 * arrives in an actual inbox, so the codes are handed in from outside the
 * process: the test pauses at each confirm step polling `$OTP_DIR/otp-enroll`
 * then `$OTP_DIR/otp-recover` (up to 4 min each) for a 6-digit code written by
 * whoever is reading the mailbox (a human, or an agent with mailbox access).
 *
 *   mkdir -p /tmp/muhkoo-otp && rm -f /tmp/muhkoo-otp/otp-*
 *   MUHKOO_BASE_URL=https://api.staging.muhkoo.dev \
 *     EMAIL_TO=you@example.com OTP_DIR=/tmp/muhkoo-otp \
 *     npx vitest --run tests/auth/email-factor-staging.e2e.test.ts
 *   # …then, as each code arrives:  echo 123456 > /tmp/muhkoo-otp/otp-enroll
 *
 * Exercises for real: CF Email Service delivery, the staging VaultDO OTP gate,
 * and the live split-key eval (staging K1 + the separate-account K2).
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { ZkAuth } from "../../src/core/namespaces/AuthNamespace";
import { AuthClient } from "../../src/auth/AuthClient";
import { SessionState } from "../../src/core/Session";

const BASE_URL = process.env.MUHKOO_BASE_URL || "";
const EMAIL_TO = process.env.EMAIL_TO || "";
const OTP_DIR = process.env.OTP_DIR || "";
const RUN = !!BASE_URL && !!EMAIL_TO && !!OTP_DIR;

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

/** Poll for a 6-digit code dropped at `$OTP_DIR/otp-<purpose>` by the mailbox reader. */
async function waitForOtp(purpose: "enroll" | "recover", timeoutMs = 240_000): Promise<string> {
  const file = path.join(OTP_DIR, `otp-${purpose}`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      const code = fs.readFileSync(file, "utf8").trim();
      if (/^\d{6}$/.test(code)) return code;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`No OTP appeared at ${file} within ${timeoutMs / 1000}s`);
}

describe.skipIf(!RUN || !circuitsPresent)("SDK email factor — staging e2e (real mailbox)", () => {
  it("enroll via real email → fresh-instance recovery via real email", async () => {
    const username = `m21st_${Date.now()}`;
    const password = "Correct-Horse-9";

    const regAuth = newAuth();
    const reg = await regAuth.register({ username, password, email: null });
    console.log(`[staging-e2e] registered ${username}; enrolling ${EMAIL_TO} — waiting for the ENROLL code…`);

    const { confirm } = await regAuth.enrollEmailFactor(EMAIL_TO);
    await confirm(await waitForOtp("enroll"));
    const factors = await regAuth.listFactors();
    expect(factors.some((f) => f.type === "email")).toBe(true);
    console.log(`[staging-e2e] enrolled. Starting recovery — waiting for the RECOVER code…`);

    const recAuth = newAuth();
    const { confirm: confirmRecover } = await recAuth.recoverWithEmail(username);
    const recovered = await confirmRecover(await waitForOtp("recover"));
    expect(recovered.commitment).toBe(reg.commitment);
    console.log(`[staging-e2e] recovered ${username} → same commitment. PASS`);
  }, 600_000);
});
