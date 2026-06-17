# Unified-Client migration plan — web chat & portal

**Goal.** Get `muhkoo/web` and `muhkoo/portal` off the low-level `@muhkoo/connect`
exports so the SDK can drop them from its public surface — the deferred half of the
"remove old versions from the SDK" work. Targets for removal once consumers are clean:

- Standalone clients: `PersonalSpaceClient`, `AuthClient`, `FileStorage`, `ShardClient`,
  `SharedSpaceClient`, `KeyringClient`.
- Raw identity/proof helpers: `deriveIdentity`, `deriveMasterSeedFromPassword`,
  `buildCommitment`, `generateAuthProof`, `exportPublicKeyHex`, `signMessage`,
  `wrapWithPassphrase`/`unwrapWithPassphrase`, `KeyStore` (kept internal).
- Legacy auth fallback: `deriveMasterSeedFromPassword` + the `?? legacy` branch in
  `AuthNamespace.login()/unlock()` + `migrateLegacyPasswordFactor` (independent track — see D2).

## Current state (verified 2026-06-17)

**Portal — already migrated.** `portal/src/auth/AuthContext.tsx` uses `client.auth.zk.*`
(register/login/restore/unlock/logout/changePassword/recovery factors),
`client.auth.hosted.*` (the actual sign-in entry), and `client.space.*` (team invites).
The `AuthClient` + ZK helpers re-exported from `portal/src/lib/connect.ts` are **never
called** — dead code. Management API calls use `client.auth.zk.token` as the Bearer.
→ Portal work is cosmetic: delete the dead re-exports. No auth-flow change, no risk.

**Web — auth done, chat-keys remain.** `web/src/auth/AuthContext.tsx` already drives all
auth through `client.auth.zk.*`. The only low-level coupling is the **chat-key /
ratchet-keypair persistence** in `web/src/personal/spaceLoader.ts`:

- `PersonalSpaceClient` → put/get the wrapped ratchet keypair at
  `/api/personal/:commitment/kv/chat-keys`.
- `KeyStore` → `generateOwnKeyPair` / `dehydrateKeyPair` (register) and `hydrateKeyPair`
  (login) for the Double-Ratchet keypair.
- `wrapWithPassphrase` / `unwrapWithPassphrase` → seal the keypair under the **master
  seed** (`client.auth.zk.seedBase64`), with a legacy password-wrap → seed-wrap migration.
- `exportPublicKeyHex` / `poseidonHash` / `toField` (in AuthContext) → build the
  `StoredZkIdentity` that `PersonalSpaceClient` needs.

Everything else web imports from connect is already consumer-level (`client.space`,
`Space`, `FileManifest`, `ChannelExistsError`) and stays.

## The enabling SDK gap

Web can't drop `PersonalSpaceClient` + `KeyStore` + the wrap helpers until the unified
Client owns **chat-key persistence**. Today the app hand-rolls generate → wrap → store →
fetch → unwrap → hydrate. The Client must expose that as a facade that internally uses
`KeyStore` + the passphrase wrap + personal-space KV (all kept internal), keyed off the
master seed it already holds.

**Hard backward-compat constraint:** existing users have a blob at the flat key
`chat-keys` in `/api/personal/:commitment/kv/`, value = a `WrappedPayload` JSON, **no**
server-side encryption envelope, sealed under the seed (older ones under the password).
The facade MUST read that exact key + format, and keep the password→seed re-wrap
migration, or users lose chat identity + history continuity.

## Phases (todos)

### A — SDK: add a chat-key persistence facade (additive, non-breaking)
- [ ] **A1** Design `client.chat.keys` (or extend `client.space`): `ensureKeys()` (register:
      generate + seed-wrap + store if absent) and `restoreKeys()` (login: fetch + unwrap +
      hydrate `KeyStore`). Authenticate via the session token (not per-op Groth16 proofs),
      so the `StoredZkIdentity`/proof-helper conversion goes away.
- [ ] **A2** Preserve wire compat: same `/api/personal/:commitment/kv/chat-keys` key, same
      `WrappedPayload` format, same seed-wrap, and the legacy password-wrap fallback +
      one-time re-wrap-to-seed migration. Preserve the passkey-login behavior (clear error
      when only a password-wrapped blob exists and no password is available).
- [ ] **A3** Unit-test the facade against a captured pre-existing blob; ship in a connect alpha.

### B — Web: migrate chat-keys onto the facade  *(gated on A)*
- [ ] **B1** Rewrite `web/src/personal/spaceLoader.ts` + `AuthContext.hydrateChatKeys`/
      `persistRatchetKeysOnRegister` to call `client.chat.keys.*`. Remove imports of
      `PersonalSpaceClient`, `KeyStore`, `wrap/unwrapWithPassphrase`, `exportPublicKeyHex`,
      `poseidonHash`, `toField`, and the `StoredZkIdentity` localStorage plumbing if the
      facade no longer needs it.
- [ ] **B2** Keep the legacy password→seed re-wrap path working through the facade.
- [ ] **B3** Verify with the chat E2E: register → reload → password login (history + same
      member-id continuity), password change continuity, passkey login behavior, and a
      **real pre-existing account** (data-compat is the top risk).

### C — Portal: prune dead shim  *(independent; can land anytime)*
- [ ] **C1** Delete the `AuthClient` + `deriveIdentity`/`buildCommitment`/`generateAuthProof`/
      `exportPublicKeyHex`/`signMessage` re-exports (and their interfaces) from
      `portal/src/lib/connect.ts`. Keep `Client`, `VaultFactorMeta`, `InviteLink`, space types.
- [ ] **C2** `npm run build` + smoke test: hosted login → dashboard → an app-detail space op.

### D — SDK: remove the now-unused public exports  *(gated on B + C landing & reinstalled)*
- [ ] **D1** Drop `PersonalSpaceClient`, `AuthClient`, `FileStorage`, `ShardClient`,
      `SharedSpaceClient`, `KeyringClient`, and the raw proof/identity helpers from
      `src/server/index.ts` + `src/browser/index.ts` + `src/core/index.ts`. Keep the classes
      in-tree (the unified Client uses them internally); only the exports go.
- [ ] **D2** *(independent sub-track)* Remove the legacy auth fallback
      (`deriveMasterSeedFromPassword` + the `?? legacy` branch in `login()/unlock()` +
      `migrateLegacyPasswordFactor`) **only after** auditing prod vaults for pre-vault
      accounts that never logged in since the vault shipped (~2026-06-15). Not blocked by
      web/portal; breaks only that dormant cohort.
- [ ] **D3** Bump connect to `0.8.0-alpha.0` (breaking removals), rebuild, publish; bump
      `@muhkoo/cli` in lockstep.

### E — Verify & ship
- [ ] **E1** Refresh the `file:../connect` copies in web + portal (rebuild + reinstall/rsync).
- [ ] **E2** Web chat E2E green; portal smoke green. Deploy web + portal.

## Sequencing

```
A ──► B ─┐
         ├─► D ──► E
   C ────┘
```
- **C (portal)** is independent and trivial — do it first to shrink the surface.
- **B (web)** is gated on **A (facade)**.
- **D (SDK export removal)** waits until B + C are merged and reinstalled in both consumers.
- **D2 (legacy auth)** is independent of all the above — gate it on a prod vault audit, not on web/portal.

## Risks

1. **Web chat-key data compatibility (highest).** Wrong key/format/wrap → users silently
   lose chat identity + history. Mitigate: facade is byte-compatible with the existing
   blob; test against a real pre-existing account before shipping.
2. **Passkey-login chat-keys.** Today web errors if only a password-wrapped blob exists on
   a passkey login. Preserve that UX (or finish universal seed-wrap-on-register first).
3. **Legacy SDK-auth removal (D2).** Breaks pre-vault accounts dormant since the vault
   shipped. Independent; gate on the vault audit.
4. **Other consumers.** standup / discord-clone / app-builder scaffolds — confirm none
   import the removed symbols before D1 (earlier sweep found only web + portal).
