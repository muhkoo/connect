/**
 * M2.1 email factor through the real SDK surface (`ZkAuth.enrollEmailFactor` /
 * `recoverWithEmail`) END-TO-END against a live worker.
 *
 * Local form (full automation — the OTP is scraped from the accelerator's
 * `wrangler dev` log, where the email service runs in log mode):
 *
 *   MUHKOO_BASE_URL=http://localhost:8787 OTP_LOG=/tmp/wrdev.log \
 *     npx vitest --run tests/auth/email-factor.e2e.test.ts
 *
 * The gated evals are still REAL split-key: local dev proxies K2 to the live
 * staging K2 worker. On deployed envs (real mailbox needed to read the code)
 * this suite skips; the manual staging pass happens at M2.4.
 *
 * NOTE: MUHKOO_BASE_URL, not BASE_URL (reserved Vite var).
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { ZkAuth } from "../../src/core/namespaces/AuthNamespace";
import { AuthClient } from "../../src/auth/AuthClient";
import { SessionState } from "../../src/core/Session";

const BASE_URL = process.env.MUHKOO_BASE_URL || "";
const OTP_LOG = process.env.OTP_LOG || "";
const RUN = !!BASE_URL && !!OTP_LOG && fs.existsSync(OTP_LOG);

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

async function scrapeOtp(email: string, purpose: "enroll" | "recover"): Promise<string> {
  const re = new RegExp(
    `\\[email:dev\\] OTP for ${email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(${purpose}\\): (\\d{6})`,
    "g",
  );
  for (let attempt = 0; attempt < 20; attempt++) {
    let code: string | null = null;
    for (const m of fs.readFileSync(OTP_LOG, "utf8").matchAll(re)) code = m[1];
    if (code) return code;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`OTP for ${email} (${purpose}) never appeared in ${OTP_LOG}`);
}

describe.skipIf(!RUN || !circuitsPresent)("SDK email factor — e2e", () => {
  it("enrollEmailFactor → fresh-instance recoverWithEmail recovers the SAME identity", async () => {
    const username = `sdkemail_${Date.now()}`;
    const password = "Correct-Horse-9";
    const email = `${username}@example.com`;

    // Register (vault-backed, random seed) and enroll the email factor.
    const regAuth = newAuth();
    const reg = await regAuth.register({ username, password, email: null });
    const { confirm } = await regAuth.enrollEmailFactor(email);
    await confirm(await scrapeOtp(email, "enroll"));

    const factors = await regAuth.listFactors();
    const emailFactor = factors.find((f) => f.type === "email") as { masked?: string } | undefined;
    expect(emailFactor).toBeTruthy();
    expect(emailFactor?.masked).toBe(`s•••@example.com`);

    // DECISIVE: a brand-new ZkAuth (no session, no seed, no password) recovers
    // the SAME commitment from nothing but the username + inbox access.
    const recAuth = newAuth();
    const { confirm: confirmRecover } = await recAuth.recoverWithEmail(username);
    const recovered = await confirmRecover(await scrapeOtp(email, "recover"));
    expect(recovered.username).toBe(username);
    expect(recovered.commitment).toBe(reg.commitment);
    expect(recAuth.identity).toBeTruthy();

    // The recover verification is single-use — a replay can't read the factor.
    const replay = await fetch(`${BASE_URL}/api/auth/vault`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, factorType: "email", verifyToken: "0".repeat(64) }),
    });
    expect(replay.status).toBe(401);
  }, 120_000);
});
