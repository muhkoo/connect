# Changelog

All notable changes to `@muhkoo/connect` are documented here. This project
follows semantic versioning (pre-1.0: new backward-compatible features bump the
minor, fixes bump the patch/alpha).

## 0.7.0-alpha.5 — Security hardening (2026-06-18)

### Security

- **`HttpClient` attaches credentials same-origin only.** The app key (`X-Muhkoo-Key`) and user session token (`X-Muhkoo-Session`) are no longer sent when a request URL escapes the configured `baseUrl` origin — closing a token-exfiltration vector through absolute / `http`-prefixed request paths.
- **Stopped logging identity material.** Removed `console.log` of the ZK salt and commitment in `DoubleRatchetManager` (the salt is a private circuit witness; the commitment is the user's stable id).

## 0.7.0-alpha.4 — Hosted auth, recovery factors & function invoke (2026-06-17)

### Added

- **Email recovery factor (M2 — verification-gated split-key):**
  - `client.auth.zk.enrollEmailFactor(email)` — add an email as a recovery + login factor. Sends a 6-digit code to the address and returns `{ confirm(code) }`; confirming wraps the master seed under a wrap key released only after the address is verified. Requires being signed in.
  - `client.auth.zk.recoverWithEmail(username)` — account recovery from nothing but the username + inbox access. Sends a code to the *enrolled* address (the response never reveals whether one exists) and returns `{ confirm(code) }`, which completes the recovery and signs in (→ `AuthUser`). Call `changePassword` afterwards.
  - How it works: the wrap key is `HKDF( OPRF(K1, input) ‖ OPRF(K2, input) )` — two evaluations in **separate trust domains**, each only released after a fresh proof of inbox control. No single server-side compromise can derive it offline. The ZK identity layer is unchanged.
  - `listFactors()` entries for gated factors carry a `masked` display hint (`m•••@gmail.com`); the full address is never exposed in list responses.
- **Google factor (M2.3 — "Sign in with Google", verification-gated split-key):**
  - `client.auth.zk.enrollGoogleFactor(idToken)` — link a Google account as a recovery + login factor (signed-in). The app obtains `idToken` via Google Identity Services and passes it in; the SDK never renders Google UI.
  - `client.auth.zk.loginWithGoogle(username, idToken)` — sign in with Google (the account must have linked it). Unlocks the seed via the Google-gated split-key eval; the ZK identity layer is unchanged.
  - `client.auth.zk.registerWithGoogle(username, idToken)` — create a brand-new **passwordless** account whose only factor is Google.
  - Google is pure authentication UX — the verified ID token only gates the wrap-key release. The `google` factor is keyed on the stable Google `sub`.
- **Hosted auth — `client.auth.hosted` (auth.muhkoo.dev):** centralize sign-in so apps drop the embedded login UI (and ~6 MiB of snarkjs), and provider config (Google OAuth origins, WebAuthn, DKIM) lives in one place instead of per-app.
  - `client.auth.hosted.login({ appId, redirectUri })` — redirect to the hosted page (PKCE + `state` stashed automatically). `redirectUri` must be registered for the app in the portal (App Detail → Hosted sign-in).
  - `client.auth.hosted.handleCallback()` — on the callback route, exchange the returned code, unseal the master seed from the URL fragment, establish the session, and scrub the URL (→ `{ username, commitment }`). `client.auth.hosted.isCallback()` guards it.
  - `client.auth.hosted.manageAccount({ returnUri? })` — redirect to **centralized account & security management** (`auth.muhkoo.dev/security`): manage passkeys, recovery email, Google, recovery phrase, and password in one place across every app, with a "Back to app" return. Replaces the per-app security UI.
  - Sealed-seed handoff: the hosted page AES-GCM-seals the seed under a one-time key carried only in the URL fragment (never sent to a server); the app unseals it after the code exchange. Authorization-code + PKCE (S256); single-use, 60s codes. `authBaseUrl` client option overrides the hosted origin (default `auth.muhkoo.dev`).
- **`client.functions.invoke(target, opts?)`** — invoke an HTTP-triggered serverless function with the SDK's credentials attached (`X-Muhkoo-Key` + `X-Muhkoo-Session` when signed in), JSON in/out (non-2xx → `HttpError`). `target` is `{ name, slug }`, a `name--slug` host label, or a full URL; `opts` takes `method`, `body`, `headers`, `path`. `client.functions.invokeRaw(...)` returns the raw `Response` for non-JSON functions, and `client.functions.invokeUrl(...)` resolves a target to its URL.
- **`functionsHostSuffix`** client option — override the HTTP-function zone (`fns.muhkoo.dev` by default) for staging/self-hosted deployments. Exported `DEFAULT_FN_HOST_SUFFIX`.

## 0.6.0-alpha.11 — Account recovery (M1)

Recoverable zero-knowledge identity: the password is now a **factor**, not the
source of the keys. A random master seed yields the same secret/keys/commitment
as before (the ZK circuit and all existing commitments are **unchanged** — fully
backward-compatible), and is AES-256-GCM-wrapped per recovery factor and stored
server-blind in a per-user vault. So a forgotten password no longer means a lost
account, and the password can be changed without moving the identity. (alpha.2–
alpha.10 were dev iterations folded into this entry.)

### Added

- **Passkey factor (WebAuthn PRF):**
  - `client.auth.zk.enrollPasskey({ rpId?, rpName?, label? })` — add a passkey that wraps the seed under its PRF output.
  - `client.auth.zk.loginWithPasskey(username)` — passwordless sign-in (→ `AuthUser`).
  - `client.auth.zk.passkeyAvailable()` — `boolean`; whether WebAuthn is usable here.
  - `client.auth.zk.passkeyPrfAvailable()` — `Promise<boolean | null>`; whether the authenticator supports the PRF extension we need (`null` = undeterminable). Use it to hide the passkey option on incapable browsers.
- **Recovery phrase factor (BIP39):**
  - `client.auth.zk.enrollRecoveryPhrase()` — returns the 24-word phrase to show **once** (it *is* the seed; nothing is stored server-side).
  - `client.auth.zk.recoverWithPhrase(username, mnemonic)` — the "forgot password" path (→ `AuthUser`).
- **Password management:** `client.auth.zk.changePassword(newPassword)` — re-wraps the (unchanged) seed; identity/commitment never move.
- **Factor management:** `client.auth.zk.listFactors()` (enrolled methods, metadata only) and `client.auth.zk.removeFactor(id)` (can't remove the last one).
- **`client.auth.zk.seedBase64`** — the master seed as base64 (or `null` when locked). Wrap app-level data (e.g. chat keys) to the **seed** instead of the password, so it survives password changes and unlocks under a passwordless passkey login.
- **`VaultUnavailableError`** (exported) — thrown by `login`/`unlock` when the vault is unreachable (network / 5xx / rate-limit), distinct from a wrong password.

### Changed

- **`register` / `login` / `unlock` are now vault-backed** — the surface is identical, but `register` derives a random-seed identity and enrolls the OPRF-gated password factor, and `login`/`unlock` unlock the seed from the vault.
- **Legacy (pre-vault) accounts migrate transparently** on first vault-aware login/unlock: a password factor wrapping the exact legacy-derived seed is enrolled, commitment preserved.

### Fixed

- **A vault outage no longer masquerades as a wrong password.** A transient vault failure (e.g. rate-limit) used to silently fall back to the legacy derivation and surface a misleading "commitment mismatch"; it now throws `VaultUnavailableError`.

### Security

- The password factor's wrap key is **OPRF-gated** — `HKDF(OPRF(serverKey, scrypt(password)))` via ristretto255 — so a stolen vault blob is **not** offline-crackable; each guess needs an online, rate-limited evaluation.
- The accelerator now **verifies the auth proof's ECDSA signature** server-side (proof of key possession), on top of the Groth16 proof.

## 0.6.0-alpha.1

### Changed

- **`ejectAgentPrompt` now emits a "How to respond" section** that compels the
  agent to finish its turn with a short, plain-language reply after using tools —
  and never to end with only tool calls, an empty message, or a recitation of its
  tool list. This fixes agents (notably on `gpt-oss-*` models) that ran their tool
  loop but never posted a user-facing answer ("you can see the work, but no reply").
  Toolless agents get the "always reply" rule without the tool-specific lines.

## 0.6.0-alpha.0

### Added

- **App-describing decorators + `ejectAgentPrompt`** — declare your app's
  agent-facing surface in code and generate a system prompt for a Programmable
  Agent. Annotate a plain class with `@MuhkooAgent` (the app's identity, purpose,
  and behavioral guidance) plus per-surface member decorators — `@MuhkooSpace`
  (a channel the agent can resolve/post to), `@MuhkooDB` (an app table, with
  `access: "read" | "write"`), and `@MuhkooFunction` (a callable function) — then
  call `ejectAgentPrompt(AppClass)` to compose the `systemPrompt` string. The
  prompt carries the **semantic** layer (what the app is, how to act, what each
  surface means); the Muhkoo runtime still appends the authoritative roster
  (exact columns, function params, the closed tool list) at invocation time, so
  the prompt never restates schema or drifts from it. Also exports
  `ejectAgentTools` (derive a tools allowlist matching the described surface),
  `getMuhkooAppDescriptor`, and the `MuhkooAgentMeta` / `MuhkooSpaceMeta` /
  `MuhkooDBMeta` / `MuhkooFunctionMeta` / `MuhkooDBAccess` /
  `MuhkooAppDescriptor` / `MuhkooAgentToolsConfig` types. Requires
  `experimentalDecorators` (no `reflect-metadata` dependency). Available in the
  browser and server builds.
- **Agent tool-use via the SDK** — `client.agents.create`/`update` now accept a
  `tools` field (`AgentToolsConfig`: db read/write + table allowlist, function
  allowlist, channels, `maxIterations`), and `AgentConfig` returns it. This lets
  you grant an agent the same function-calling tool-use the portal exposes —
  e.g. `client.agents.create(appId, { handle, displayName, model, systemPrompt:
  ejectAgentPrompt(App), tools: ejectAgentTools(App) })`. Enabling tools
  requires a function-calling `model` in the same call (server-enforced). Adds
  the `AgentToolsConfig` and `AgentDbToolMode` exports.

## 0.4.0-alpha.1

### Added

- **Serverless Functions (`client.functions`)** — deploy and manage an app's
  developer-authored serverless functions from the SDK: `deploy`, `get`,
  `list`, `code` (read decrypted source), `update`, `delete`, and per-Space
  `enable`/`disable`. A function is an untrusted single-module ES worker
  (`export default { fetch }`) that runs on the accelerator with two triggers —
  **HTTP** (its own `<name>--<slug>.fns.<zone>` subdomain) and **Space-bound**
  (invoked on Space messages, like a Programmable Agent). Source is encrypted at
  rest and uploaded just-in-time on invocation. Exports `FunctionConfig`,
  `FunctionDeployInput`, `FunctionUpdateInput`, `FunctionTriggers`,
  `FunctionTrigger`, `FunctionTriggerType`, `FunctionCaps`, and
  `FunctionScopeOpts`. Management is session-authed (owner / Space editor) and
  **paid-tier-only**.

## 0.4.0-alpha.0

### Added

- **Programmable Agents (`client.agents`)** — manage an app's server-side,
  Workers-AI-backed agents from the SDK: `create`, `get`, `list`, `update`,
  `delete`, and per-Space `enable`/`disable`. Exports `AgentConfig`,
  `AgentCreateInput`, `AgentUpdateInput`, `AgentProvisioned`, `AgentSkill`,
  `AgentTrigger`, `AgentTriggerType`, and `AgentScopeOpts`.
- **Space invitations & roles** — `client.space.createInviteLink` /
  `listInviteLinks` / `revokeInviteLink` / `joinByInvite`, plus
  `setMemberRole`, `members` (roster with roles), and `roster`. `InviteLink`
  now carries an optional `role` granted to redeemers.
- **File-upload progress** — `Space.putFile` / `FileStorage.writeFileToShards`
  accept an `onProgress(completed, total)` callback (per chunk) so UIs can show
  an upload progress bar.
- **`HttpClient.patch`** — JSON `PATCH` helper alongside `get`/`post`/`del`.
- **`WSTransport.urlProvider`** — optional async provider for a fresh connection
  URL on each reconnect (used for one-time/expiring WS upgrade tickets).

### Fixed

- **WebSocket reconnect with single-use tickets** — Spaces now mint a fresh
  upgrade ticket on every reconnect (via `urlProvider`) instead of reusing the
  spent one, so a dropped socket (idle timeout, network flap) reliably recovers
  instead of stalling on a channel error. Reconnect also re-schedules when an
  attempt fails before the socket opens, and Space sockets keep retrying across
  network flaps.
- **Own messages dropped on receive** — `Space` now trusts messages whose
  `source` is the local user, so a returning member (who loaded a cached key and
  never re-published their identity to the roster) no longer has the echo of
  their own messages silently dropped by signature verification.
