/**
 * H1/H2 — the full hosted-auth flow through the real SDK, end-to-end against a
 * live backend (no browser: `completeAuthorize`, the token exchange, and
 * `unsealSeed` all run in Node). Proves the sealed-seed handoff round-trips the
 * EXACT master seed from the hosted page to the app.
 *
 *   MUHKOO_BASE_URL=https://api.staging.muhkoo.dev E2E_STAGING=1 \
 *     npx vitest --run tests/auth/hosted-flow.e2e.test.ts
 *
 * Needs app creation (WfP → staging) + the ZK circuits.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { Client } from "../../src/core/Client";
import { AuthClient } from "../../src/auth/AuthClient";
import { unsealSeed, generatePkce, randomState } from "../../src/auth/hostedHandoff";

const BASE_URL = process.env.MUHKOO_BASE_URL || "";
const RUN = process.env.E2E_STAGING === "1" && !!BASE_URL;
const here = path.dirname(fileURLToPath(import.meta.url));
const wasmUrl = path.resolve(here, "../../circuits/build/preimagePoK_js/preimagePoK.wasm");
const zkeyUrl = path.resolve(here, "../../circuits/build/preimagePoK_0001.zkey");
const circuits = fs.existsSync(wasmUrl) && fs.existsSync(zkeyUrl);

const REDIRECT = "https://app.example.com/auth/callback";
const raw = (p: string, m: string, b: unknown, token?: string) =>
    fetch(`${BASE_URL}${p}`, {
        method: m,
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: b === undefined ? undefined : JSON.stringify(b),
    });

describe.skipIf(!RUN || !circuits)("Hosted-auth full flow — e2e", () => {
    it("first-party surface (portal) authorizes against the redirect allowlist — no app record", async () => {
        const hosted = new Client({ baseUrl: BASE_URL, circuits: { wasmUrl, zkeyUrl } });
        const username = `hfp_${Date.now()}`;
        await hosted.auth.zk.register({ username, password: "Correct-Horse-9" });
        const originalSeed = hosted.auth.zk.seedBase64!;

        const { codeVerifier, codeChallenge } = await generatePkce();
        const state = randomState();
        // A FIRST_PARTY_REDIRECT_URIS entry for this env (api.* → portal.*); appId is a label.
        const portalHost = new URL(BASE_URL).host.replace(/^api\./, "portal.");
        const redirectUri = `https://${portalHost}/auth/callback`;
        const redirectUrl = await hosted.auth.hosted.completeAuthorize({ appId: "muhkoo-portal", redirectUri, codeChallenge, state });

        const code = new URL(redirectUrl).searchParams.get("code")!;
        const fragmentKey = new URLSearchParams(new URL(redirectUrl).hash.replace(/^#/, "")).get("k")!;
        const appAuth = new AuthClient({ baseUrl: BASE_URL });
        const exchanged = await appAuth.token({ code, codeVerifier });
        expect(exchanged.username).toBe(username);
        const recovered = await unsealSeed(exchanged.sealedKeys, fragmentKey);
        expect(Buffer.from(recovered).toString("base64")).toBe(originalSeed);
    }, 120_000);


    it("hosted page seals the seed → app unseals the SAME seed + a working session", async () => {
        // --- The hosted page's client (auth.muhkoo.dev) ---
        const hosted = new Client({ baseUrl: BASE_URL, circuits: { wasmUrl, zkeyUrl } });
        const username = `hf_${Date.now()}`;
        const user = await hosted.auth.zk.register({ username, password: "Correct-Horse-9" });
        const token = hosted.auth.zk.token!;
        const originalSeed = hosted.auth.zk.seedBase64!;

        // Developer registers an app + its redirect URI (raw API).
        await raw("/api/developer/bootstrap", "POST", { email: `hf_${Date.now()}@example.com` }, token);
        const created = await (await raw("/api/apps", "POST", { slug: `hf${Date.now().toString(36)}` }, token)).json() as { appId: string };
        const appId = created.appId;
        expect((await raw(`/api/apps/${appId}`, "PATCH", { redirectUris: REDIRECT }, token)).ok).toBe(true);

        try {
            // --- App side generates PKCE (keeps the verifier) ---
            const { codeVerifier, codeChallenge } = await generatePkce();
            const state = randomState();

            // --- Hosted page completes authorization: seal seed + mint grant + build redirect ---
            const redirectUrl = await hosted.auth.hosted.completeAuthorize({ appId, redirectUri: REDIRECT, codeChallenge, state });
            const url = new URL(redirectUrl);
            expect(url.origin + url.pathname).toBe(REDIRECT);
            expect(url.searchParams.get("state")).toBe(state);
            const code = url.searchParams.get("code")!;
            const fragmentKey = new URLSearchParams(url.hash.replace(/^#/, "")).get("k")!;
            expect(code && fragmentKey).toBeTruthy();

            // --- App side exchanges the code + unseals the seed ---
            const appAuth = new AuthClient({ baseUrl: BASE_URL });
            const exchanged = await appAuth.token({ code, codeVerifier });
            expect(exchanged.username).toBe(username);
            const recoveredSeed = await unsealSeed(exchanged.sealedKeys, fragmentKey);
            // DECISIVE: the app recovered the hosted page's exact master seed.
            expect(Buffer.from(recoveredSeed).toString("base64")).toBe(originalSeed);

            // The handed-back session token actually works.
            const verify = await appAuth.verify(exchanged.sessionToken);
            expect(verify.username).toBe(username);
            expect(exchanged.commitment).toBe(user.commitment);

            // Wrong PKCE verifier is rejected (fresh code, since the good one is spent).
            const url2 = new URL(await hosted.auth.hosted.completeAuthorize({ appId, redirectUri: REDIRECT, codeChallenge, state }));
            const code2 = url2.searchParams.get("code")!;
            await expect(appAuth.token({ code: code2, codeVerifier: "wrong" })).rejects.toThrow();
        } finally {
            await raw(`/api/apps/${appId}`, "DELETE", undefined, token);
        }
    }, 120_000);
});
