# Changelog

All notable changes to `@muhkoo/connect` are documented here. This project
follows semantic versioning (pre-1.0: new backward-compatible features bump the
minor, fixes bump the patch/alpha).

## 0.11.0-alpha.0 — `client.vfs`, a real filesystem (2026-08-22)

### Added

- **`client.vfs` — directories, paths, versions, and binary files over the primitives you already have.** File bytes still go through `client.storage.writeFile` into a real Space, unchanged; what is new is the *metadata*. Instead of the flat `{spaceId, manifest}` mirror keyed by file id that `writeFile` already keeps in your personal space, the VFS arranges the same information as a tree you can navigate: one AES-256-GCM-sealed record per directory, so the server never sees a filename, a directory shape, or a file size.
  - **A working directory, POSIX-style.** `vfs.cd(path)` and `vfs.cwd`; every method resolves relative paths against it, `..` climbs and stops at the root, and absolute paths pass through untouched. `cd` verifies the target is a real directory, so a typo fails where the message can name it rather than turning every later relative path into "does not exist". It lives in the SDK rather than the CLI so that a CLI, a script and an app all agree on what "here" means.
  - Reads: `stat`, `list`, `walk`, `exists`, `readFile`, `readText`, `glob`.
  - Writes: `writeFile`, `mkdir`, `delete`, `rename` (which is also move), `copy`.
  - Versions: `history`, `restore`. Every write keeps the previous manifest, so there is cross-session undo; unchanged chunks dedupe in the content-addressed shard store, so keeping versions costs almost nothing. Capped per file (default 20).
  - **`vfs.watch(handler)` — live changes.** Fires when this filesystem is written somewhere else: another tab, another machine, a CLI. It rides the personal space's existing websocket, shared with `client.kv` via the new `kv.onRaw()` rather than opening a second socket to the same Durable Object. Deliberately a notification, not a diff — the frame names a record id, and a record id is not a path, so the cache is dropped and the caller re-reads what it is actually showing. A runtime with no `WebSocket` gets a harmless no-op, because watching is an optimisation and never required for correctness.
  - Maintenance: `sweep()` reclaims records orphaned by a lost write race.
  - **Directories have stable random ids, not content hashes.** A git-style tree rewrites every ancestor to the root on each write; here a file write touches exactly one record — its parent — and moving a directory is O(1) no matter how large the subtree, because nothing inside it records its own path.
  - **A directory's key lives in its parent.** Only the root key derives from the master seed (`muhkoo-vfs-v1`), so capabilities chain downward: handing over `{id, key}` for a subtree grants that subtree and nothing above it. That is the seam sharing will hang off without re-encrypting the filesystem.
  - `copy` of a file moves no bytes — content is immutable and content-addressed, so the new entry points at the same manifest. It does get a fresh file id, so the two do not share version history.
  - Binary files round-trip. Anything holding files as `Record<string, string>` will corrupt a PNG; this does not.
  - **Machine access without storing the seed.** `auth.zk.enrollDevice(label)` wraps the master seed under a fresh random key, stores only the ciphertext as a vault `device` factor, and hands back the key for the caller to keep. `unlockWithDevice(username, factorId, deviceKey)` opens it again; `listDevices()` / `revokeDevice(id)` manage them. Revoking a factor makes that machine's stored key inert immediately — which a stored seed can never be, since nothing can reach out and un-store it. Device factors are read by **id**, not type: you have one password but may pair many machines.
  - `auth.zk.unlockWithSeed(seedBase64)` — the inverse of `seedBase64`, for hosts that hold the seed themselves (a CLI, a server-side tool, a test). Without it, anything outside a browser runs a full ZK login on every invocation.
  - `space.createSpace({ messaging: false })` registers a space without bootstrapping a group keyring or opening a WebSocket. For a space that only holds FILES — chunks carry their own keys — the keyring buys nothing, and the socket makes writes depend on a live connection. The VFS uses this.
  - Locked (no master seed in memory) throws `VfsLockedError`, and a wrong key throws, rather than presenting an empty filesystem — the dangerous outcome is a "successful" write over a tree you could not decrypt.

## 0.10.14-alpha.0 — don't prompt for a passkey that can't work here (2026-08-12)

### Fixed

- **`auth.zk.resume()` no longer attempts a passkey unlock when the account has no passkey usable from the current origin.** Passkeys are per-origin, and enrolling through hosted auth records `auth.muhkoo.dev` — so a user who added a passkey there is mismatched on every app host. `resume()` previously attempted anyway; the attempt failed harmlessly only because the server returns a shapeless decoy that trips an internal guard before WebAuthn is reached. That silence was incidental, not designed: once the decoy is made indistinguishable (needed to close an account-enumeration oracle), the same call would fire a modal `navigator.credentials.get()` at page load — on the splash screen, since `resume()` is awaited inside every app's readiness gate. This ships first so that server-side change is safe to make.
  - New `passkeyUsableFromOrigin(rpId, host)`, exported from the auth surface. Use it — not `rpIdUsableForOrigin` — when deciding whether to *offer or attempt* a passkey. It mirrors `loginWithPasskey`'s own resolution, so a factor with **no recorded rpId** (enrolled before per-origin support) counts as usable; the raw predicate reports `false` for those and excluding them has locked real users out of production before.

## 0.10.13-alpha.0 — TV device pairing, client surface (2026-08-07)

### Added

- **`client.auth.hosted` device pairing** — sign a keyboard-less device in without typing on it. The device shows a short code; the user approves from a browser that is already signed in, and the master seed is delivered sealed to that device alone. Built for an Android TV WebView, which has neither a keyboard nor WebAuthn.
  - Device: `startDevicePairing()`, `pollDevicePairing()`, `waitForDevicePairing()` (handles the interval/backoff and `slow_down` for you), `cancelDevicePairing()`, plus `resumeDeviceSession()` / `hasDeviceSession()` / `forgetDeviceSession()` across restarts.
  - Approver: `lookupDevicePairing()`, `approveDevicePairing()`, `denyDevicePairing()`, `listPairedDevices()`, `revokePairedDevice()`.
  - `DevicePairingError` / `ReauthRequiredError` carry the machine-readable reason, so a UI can tell "expired" from "denied" from "confirm it's you first".
- **`deviceStore`** — at-rest persistence for a paired device: the identity blob is encrypted in `localStorage` under a **non-extractable** IndexedDB key. Read the module docs before relying on it: against an attacker with device, ADB, or root access this is **obfuscation, not protection**. A native-Keystore bridge (`MuhkooKeystoreBridge`) is supported for hosts that can provide one.

Requires an accelerator with the `/api/auth/device/*` endpoints (shipped 2026-08-06). Protocol spec: `muhkoo/auth/docs/tv-device-pairing-spec.md`.

## 0.10.12-alpha.0 — TV device-pairing seal (2026-08-06)

### Added

- **v2 device-pairing handoff** — `generateDevicePairingKeypair()`, `sealSeedToDevice()`, `unsealSeedFromDevice()` and `pairingVerificationCode()`. Lets a keyboard-less device (an Android TV WebView, which has no WebAuthn) receive the master seed without the server ever reading it. Same sealed envelope the hosted-auth handoff already uses, so it rides the existing `sealedKeys` field — but the key is ECDH-derived to the device's ephemeral P-256 key instead of arriving in a redirect fragment, because a TV has no redirect to receive one. P-256 ECDH → HKDF-SHA256 → AES-256-GCM, fresh ephemeral key and IV per seal.
- Both public keys are bound into the KDF. This is load-bearing, not belt-and-braces: P-256 ECDH returns only the shared x-coordinate, so a seal addressed to the *negation* of a device key (on-curve, derivable by anyone from the published key, and showing a different verification code) would otherwise still decrypt under the honest private key.
- `pairingVerificationCode()` is shown on both screens so a human can confirm the keys match — PBKDF2-SHA256 (200k iterations, to blunt precomputation) rendered in a 30-symbol alphabet with every confusable pair removed (`0/O`, `1/I/L`, `U`).

The v1 fragment-key handoff (`sealSeed`/`unsealSeed`) is unchanged and still rejects non-v1 envelopes.

Protocol spec: `muhkoo/auth/docs/tv-device-pairing-spec.md`. The server endpoints it describes are not built yet — these are the client primitives to code against.

## 0.10.11-alpha.0 — Access tokens + per-origin passkeys (2026-07-29)

### Fixed

- **Passkey unlock on apps served from more than one host.** A passkey is bound to the origin it was enrolled on, but the vault handed back whichever passkey was enrolled *first* regardless of origin — so an app reachable at both a custom domain and the platform host (e.g. `theater.muhkoo.com` and `muhkoo-theater.apps.muhkoo.dev`) failed to unlock on one of them with a raw *"The requested RPID did not match the origin or related origins"*. The vault read is now origin-aware (the platform also infers the origin from the request, so already-deployed clients are fixed), and `loginWithPasskey` refuses a foreign RP id **before** prompting instead of triggering a biometric prompt that cannot succeed. Enroll one passkey per origin; each unlocks its own.

### Added

- **`client.auth.zk.hasPasskeyForThisOrigin()`** — whether a passkey enrolled for the CURRENT origin can unlock here, so an app can offer "Unlock with passkey" only when it will work. `listFactors()` now also returns each passkey's `rpId`, and a wrong-origin unlock throws the typed `PasskeyOriginError` (`code: "passkey_wrong_origin"`).

- **`new Client({ accessToken })`** — authenticate as a machine with a scoped, expiring [access token](https://docs.muhkoo.dev/concepts/access-tokens/) (`mk_<env>_at_…`) instead of a ZK identity. Rides the same `X-Muhkoo-Key` header as an app key and takes precedence over `apiKey` when both are set — for headless/server/CI clients.
- **`client.accessTokens`** namespace — `create(appId, { scopes, env, expiresInDays, label })` (returns the plaintext once), `list(appId)`, and `revoke(appId, keyId)`. Scopes are resource-level (`db:read`/`db:write`, `kv:*`, `storage:*`, `messages:*`, `functions:invoke`, `ai:infer`); see the exported `ACCESS_TOKEN_SCOPES`.
- **`@MuhkooDB({ backend: true })`** — mark a table backend-only in an agent app descriptor. Backend tables are omitted from `ejectAgentPrompt` output, matching the platform gate that rejects publishable keys from backend-only tables.

## 0.10.10-alpha.0 — Streaming large-file storage (2026-07-06)

### Fixed

- **`writeFileToShards` now truly streams.** It previously read the ENTIRE source into one `Uint8Array` before chunking (despite a comment claiming per-chunk memory), so multi-GB files (e.g. a 4K movie) threw "the file could not be read" — a `Blob`/`File` overflows the browser's ~2GB `ArrayBuffer` cap. It now slices the source per chunk; peak memory stays at ~`chunkSize`.

### Added

- **`Space.getFileStream(manifest)`** / **`FileStorage.readChunksFromShards(manifest)`** — async-iterate a stored file's decrypted chunks in order without holding the whole file in memory. For multi-GB reads (a single `Uint8Array` can't hold them) — e.g. a transcoder piping the raw straight to a temp file. Same peer/origin shard sourcing and per-chunk auth as `getFile`.

## 0.10.9-alpha.0 — Passkey platform-authenticator fix (2026-07-06)

### Fixed

- **Passkey enrollment now pins the platform authenticator** (`authenticatorAttachment: "platform"`). Previously the browser could route WebAuthn to a third-party password-manager extension that doesn't implement the PRF extension our seed-wrapping factor requires, causing "didn't return a PRF result" failures. Enrollment now goes to the OS authenticator (Touch ID / Windows Hello / iCloud Keychain), which supports PRF.

## 0.10.1-alpha.0 — CLI cross-origin isolation support (2026-07-01)

### Added

- **Per-app cross-origin isolation** is now a self-serve hosting setting. Apps
  that need `SharedArrayBuffer` (multi-threaded WebAssembly — e.g. `ffmpeg.wasm`)
  can opt in without any platform changes: set `crossOriginIsolation: true` in
  the provision spec (`muhkoo provision`) or toggle it in the portal Hosting
  card. The platform then serves the app's document with `Cross-Origin-Opener-Policy:
  same-origin` + `Cross-Origin-Embedder-Policy: credentialless`, so the runtime's
  `crossOriginIsolated` check passes and threaded wasm cores load automatically.
  No SDK API change — this is a version-lockstep bump carrying the CLI feature.

## 0.10.0-alpha.0 — Stable member keypair across reloads + `resume()` (2026-07-01)

### Added

- **`client.auth.zk.resume()`** — one boot call that restores the session and,
  when a passkey is enrolled, silently unlocks the identity via WebAuthn (the
  master seed is recovered, never persisted). Returns `{ user, unlocked }` so the
  app prompts for a password only when there's no passkey. Replaces the manual
  `restore()` + key-hydration scaffolding apps used to hand-roll.
- **SDK-owned ratchet-keypair vault.** The member's long-lived ratchet/space
  keypair is now provisioned + seed-wrapped + rehydrated by the SDK itself
  (`SpaceNamespace` rehydrates it from the personal-space `chat-keys` blob before
  opening a Space). Every app gets a **stable member keypair across page
  reloads** with no per-app code — so members stop re-admitting to Spaces on
  every load and the server-blind group-key cache round-trips.

### Fixed

- A reloaded, unlocked client no longer regenerates a fresh keypair each session
  (which forced a full keyring re-admit and defeated the group-key cache).

## 0.9.0-alpha.0 — P2P file transfer (`client` `p2p` option) (2026-06-26)

### Added

- **Peer-to-peer file-shard exchange among Space members (opt-in).** With
  `new Client({ p2p: { enabled: true } })`, a Space's file reads/writes try the
  other members first over **WebRTC data channels** before spending origin
  bandwidth — a private, Space-scoped swarm. Best-effort: a miss or unreachable
  peer falls back to origin (R2), so it never blocks a read.
  - **Private + authenticated**: signaling rides the Space's existing ephemeral
    relay (no new server channel); the sender is server-stamped, so peers can't
    spoof identity. Blocks are AES-GCM ciphertext addressed by SHA-256 — a peer
    can serve them but can't read them, and an inbound block is hash-verified
    before use (a tampered block is dropped and origin is used instead).
  - **Bitswap-lite protocol** (`WANT`/`HAVE`/`BLOCK`/`CANCEL`) with a
    pluggable `PeerTransport` so a libp2p/Helia transport can slot in later
    without touching the engine.
  - **Off-thread by default**: the block engine (hashing, blockstore, protocol)
    runs in a **Web Worker** — shipped as a separate chunk and exposed via the
    `@muhkoo/connect/p2p-worker` export (keys never enter the worker; only
    encrypted blocks cross, as transferables). `PeerNetwork` builds it
    automatically (or accepts `p2p.workerFactory`), falling back to an
    in-process engine where a worker can't be constructed.
  - New exports: `PeerNetwork`, `PeerExchange`, `WebRtcTransport`,
    `SpaceSignaler`, `BlockEngine`, `isP2pCapable`, and the `protocol` codec.
- **Peer data channel (`space.gossipToPeers` / `space.onPeerGossip`).** A direct,
  **server-bypassing** broadcast to connected Space peers over the same mesh
  (multiplexed alongside block exchange) — for CRDT ops and high-frequency state
  (live cursors, presence, collaborative edits) you don't want to push through
  the relay. Fragments large payloads; single-hop (no re-forwarding).
- **Directed ephemerals**: `space.sendEphemeral(subject, data, to?)` — with a
  `to` member id the accelerator unicasts to that member instead of
  broadcasting (used for WebRTC signaling; backward-compatible).

## 0.8.0-alpha.0 — Offline support (`client.offline`) (2026-06-24)

### Added

- **Transparent offline support, on by default in browsers.** A new layer caches every data domain locally, lets the app keep reading and writing with no connection, and reconciles automatically on reconnect — all behind the scenes. It's a no-op in Node/Workers/SSR (a `NoopStore`), so existing non-browser consumers are unaffected. Disable or customize via `new Client({ offline: { enabled, store, cacheShards, maxQueueBytes } })`.
  - **`client.offline.status`** (`online | offline | syncing`) and **`client.offline.onStatusChange(cb)`** — connectivity fused from `navigator.onLine`, real fetch outcomes, and the websocket lifecycle. Also emitted on `EventCore` (`ONLINE`/`OFFLINE`/`SYNCING`/`SYNC_PROGRESS`/`SYNC_COMPLETE`/`SYNC_ERROR`).
  - **`client.offline.snapshot`** — encrypted, local app-state cache (`save`/`load`/`delete`/`list`) for repainting instantly on a cold offline boot (last route, open space, drafts). Encrypted at rest with the identity-derived key; `load` returns `null` while locked.
- **Spaces messages offline.** Inbound + `history()` messages are cached (sealed ciphertext at rest); **`space.cachedMessages()`** decodes them for instant offline hydrate. Sends made while disconnected are applied optimistically and durably queued, then replayed on reconnect; a forward catch-up pulls anything missed while away. Messages converge with no server change (server-assigned monotonic handle).
- **File storage offline.** Shard bytes are cached in the Cache API (content-addressed → self-validating); reads serve cache-first and Reed–Solomon recovers from cached shards, and uploads made offline are queued and replayed. Convergent by construction (content addressing + idempotent PUT).
- **`client.kv` offline.** Cache-first reads, optimistic writes, a durable replay queue, and a realtime-feed merge. Conflicts resolve as a **CRDT LWW-Register** keyed by a Hybrid Logical Clock; deletes are causal tombstones. Cross-device convergence is honored server-side (the accelerator selects by HLC and tombstones deletes, server-blind to the encrypted value).
- **`client.db` offline.** `get`/`query` are cached (offline reads), writes are optimistic + queued + replayed, and each write carries per-column HLC stamps (`_hlc`). The accelerator now merges **per-column LWW** (a private `_muhkoo_crdt` sidecar): two devices editing different columns of the same row both keep their edits, same-column conflicts resolve by HLC, and deletes are causal tombstones (a stale write can't resurrect a removed row). Legacy clients (no `_hlc`) keep last-writer-by-arrival.
- **Faster reconnect catch-up.** Spaces pull a forward delta (`GET …/history?since=<handle>`) from the last-seen handle to the head, instead of re-reading the tail backwards.
- Conflict-resolution primitives are exported for advanced use: `HLC`, `compareHlc`, `mergeRegister`, `mergeMap`, `materializeRow`, `IndexedDbStore`, `NoopStore`, `OfflineManager`, and friends.

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
