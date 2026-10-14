# E2E Channels — Early Web Slice (stable identity + signed private membership) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Web chat on staging never uses a temporary key after a reload (the live "reload hides your messages" bug), and new private channels get an owner-signed member list: add by username, remove, and a removed member is cut off at once. All of it runs against the step-I server that is already on staging.

**Architecture:** connect gains the step-S pieces this slice needs, built to the design so they carry forward:
- the locked-session rule (§3.3);
- `IdentitySigner`, `PinStore` and the identity directory client (§3.1, §3.4, SpecA §4);
- the canonical encoders, ported from the accelerator and checked byte-for-byte against the shared fixture (§6.10);
- a `MembershipLog` verifier and `LogSync` (§3.5–§3.7);
- `keyCert` on join-request (§3.2);
- the `refuse=close` / 4403 transport handling (§6.9, D31).

Web chat gains the identity gate (§7.2 CS-5), private channel creation and a member panel. Admission still goes through today's keeper (Slice ruling S2); nothing is released to npm (S1).

**Tech Stack:**
- connect: TypeScript, WebCrypto (P-256 ECDSA with P1363 signatures, HKDF, SHA-256), IndexedDB via `fake-indexeddb` in tests, vitest 4.
- web: React 18, MUI, Vite, Cypress (mocked specs), Playwright driving Brave for the staging run.

**Spec:** `connect/docs/superpowers/specs/2026-09-27-e2e-channels-design.md` (approved by Matt 2026-09-27). SpecA: `connect/docs/superpowers/specs/2026-09-24-dm-protocol-design.md` §4.1–§4.3 and §6.1. The server contract is step I, in the accelerator working tree and on staging as version `fb3cf05a`.

**Repos:**
- `/Users/matt/GitHub/muhkoo/connect` for Tasks 1–13;
- `/Users/matt/GitHub/muhkoo/web` for Tasks 14–17.
- Read-only references are in `/Users/matt/GitHub/muhkoo/accelerator`: `src/trust/*` and `tests/fixtures/mlog-v1.json`.

## Slice rulings (decided by the controller 2026-09-29; each is "what — why — cost if wrong")

- **S1. Staging only; nothing released.**
  - connect is not published. `npm run release` and `npm publish` are forbidden.
  - web depends on `file:../connect` for this slice.
  - Why: §8.1 row S gates the npm release on A0b being live in production. The shared modules are "frozen at their first release" (Q16), and not releasing keeps them changeable.
  - Cost if wrong: none. Before any production web deploy, web's `package.json` must be pointed back at a published version.
- **S2. The keeper stays on.**
  - `createChannel` still seeds `__keeper__` for epoch 0.
  - A log-added member gets its key from the keeper through `join-request` (server brief §3), exactly as today.
  - Why: in step I no client can read another member's `keyCert` or any `EpochCommit` (spec brief §0 points 2, 3 and 6). Under 0.15's no-seed rule (V1), a slice-created Space would have nobody able to admit.
  - Cost if wrong: the server holds these channels' keys, as it does for every channel today, until step K. The UI copy must not claim otherwise.
- **S3. Only NEW private channels get a log.**
  - The genesis is written at creation: `baseEpoch -1` plus `ec(0)`.
  - Existing private Spaces are not migrated (§3.8 migration is out of scope).
  - Public channels stay unlogged: a public genesis is refused `genesis-founder` in step I.
  - Why: step I supports exactly this (server brief §2.10–§2.11).
  - Cost if wrong: migration comes later, with step S proper.
- **S4. Removal is the relay cut-off only.**
  - `remove()` resolves `{seq}` once the entry is appended.
  - Nothing calls `/keyring/rotate` on a log-enabled Space.
  - Why: step I has no v2 rotation. A legacy one-phase rotation produces epochs without an `EpochCommit`, which full 0.15 would reject (§4.2.5, V13).
  - Cost if wrong: a removed member still holds the old key. It can no longer reach the relay: its socket closes with 4403, `/history` answers 403, and its posts are refused. The copy says "cut off", never "re-keyed".
- **S5. On a log-enabled Space a client wraps keys only to current log members, plus `__keeper__`.**
  - That covers `admitPending`, auto-admit on `joinRequest` frames, and `admit`.
  - Why: a remove leaves `member:` and `joinreq:` rows behind, `/keyring/roster` and `/keyring/pending` still list ex-members, and `/keyring/wrap` does not check targets (server brief §4).
  - Cost if wrong: none.
- **S6. A 4403 close is confirmed with `GET /keyring/state`.**
  - 403 → `not-member`;
  - 401 → `locked`;
  - 404, 2xx, 5xx or a network error → `resume()`, at most once per 60 s.
  - Why: this is the design's final code path (§6.9, AV12). In step I the route is not built, so the keyring gate answers 401/403 and an allowed member gets a plain-text 404 (server brief §9).
  - Cost if wrong: none. A0a turns the 404 into a 200 on the same path.
- **S7. Pins follow the frozen formats exactly.**
  - `muhkoo.pins/identity-v1` and `muhkoo.pins/spaces-v1`, per SpecA §4.2 as amended by CP9 and KI6.
  - Pinned: the genesis owner's IK, after the directory agrees; the Space's genesis hash under `s:`; and every IK named in a verified `add`.
  - Why: these modules freeze at their first release (Q16).
  - Cost if wrong: a format fix before step S ships.
- **S8. No in-place resume after unlock.**
  - A locked `Space` stays locked. The app re-opens it after the user signs in again (web re-runs its effect).
  - Why: web gates before opening any Space (§7.2), so the §3.3 in-place resume adds nothing to this slice.
  - Cost if wrong: step S adds `SessionState` change notifications and resume.
- **S9. Admission states in the slice.**
  - Implemented: `locked | requesting | keyed | not-member | identity-mismatch | integrity`, names taken from §4.5.12.
  - Not implemented: `waiting`, `orphaned`, `securing`, `legacy-key`, `legacy-unverified`, `rekey` and the `link-*` details. They need A0a/A0b data.
  - Spaces without a log behave exactly as today, apart from the locked rule.
  - Cost if wrong: none.
- **S10. The log is synced from seq −1 on every open (no KI14 entry cache).**
  - The high-water mark does live in IndexedDB `muhkoo.trust`, which is what integrity detection needs.
  - Why: slice logs are tiny.
  - Cost if wrong: one extra GET per open.
- **S11. No agents or functions in log-enabled channels.**
  - `svc`/`retire` entries are applied as unsupported: the chain advances and member state is unchanged.
  - Web's `#general` agent lives in a public channel.
  - Cost if wrong: none for this slice.
- **S12. The IK comes from the seed, never the seed itself.**
  - `SeedIdentitySigner` derives the P-256 IK from the in-memory seed (`HKDF(seed,"ecdsa-priv")`, non-extractable).
  - Before signing anything it checks the IK equals the account's registered IK from `POST /api/auth/identity`.
  - Why: `unlockWithSeed`/`unlockWithDevice` set only the seed, with no commitment check (connect brief §1.2).
  - Cost if wrong: none.
- **S13. The ephemeral mint in `EncryptedSession.initialize()` stays for DMs (sub-project 4).**
  - A pair that did not come from the vault is never marked vault-backed, so it can never become the Space identity or be persisted as it. `ensureIdentity` swaps in the vault pair atomically once it is loaded; on a vault failure the tab keeps the unmarked pair, which never takes part (final ruling P35/P42).
  - Cost if wrong: DM behaviour is unchanged until sub-project 4, and opening a Space replaces such a pair with the vault pair.

## Global Constraints

- Matt does all commits. No `git commit`, `git add`, `git stash` or branch changes. Leave everything in the working tree. A task's "Checkpoint" step replaces a commit.
- No deploys except Task 17's **staging** deploy of web. Never production. Never `npm run release` or `npm publish` of connect.
- Never run `prettier --write`. Match the surrounding style by hand. connect uses 4-space indentation in `src/core`/`src/spaces` and 2-space in `src/transport`/`src/sessions`; copy what the file does.
- No Cloudflare branding in product copy.
- Canonical byte layouts, labels, key names and error codes are copied **verbatim** from this plan. They must match the accelerator byte-for-byte: `tests/fixtures/mlog-v1.json` is the arbiter.
- Labels: `muhkoo-mlog-v1`, `muhkoo-chatkey-v1`, `muhkoo-epoch-commit-v1`, `muhkoo-pinmap-v1`, `muhkoo-spacepins-v1`.
- Signatures are ECDSA P-256 SHA-256, **IEEE P1363** (64 bytes r‖s), standard padded base64.
- An IK is the raw 65-byte `0x04‖X‖Y` point in standard padded base64, and is signed over **exactly as transmitted**.
- A hash is standard padded base64 of SHA-256, never computed over `sig`.
- A signed chat-key string is the exact base64url JWK string posted as `identityEcdhPub` / `identityEcdsaPub`, never a re-export.
- Membership ids are exact-case session usernames. Only the identity directory lower-cases.
- New public error classes: `IdentityLockedError`, `IdentityUnavailableError`, `SpaceTrustError`, `AdmissionDeniedError` (Task 1). Their names are part of the public API.
- UI copy strings in Tasks 15–16 are verbatim from design §9.1.
- Test commands:
  - connect: `yarn test:unit <paths>` for the task's files, then `yarn test:unit` for the whole suite; `yarn typecheck`; `yarn lint`.
  - web: `yarn build` (typecheck plus build) and `yarn cy:run --spec <spec>`.

## Review Focus

These failure modes are the most likely to bite a person. No task would otherwise test them, so each line names the task that now carries the test:

1. **A key pair minted while locked must never become the Space identity after unlock.** A DM subscription or an old tab mints a P-384 pair under the username. The user then signs in again. Expected: the next Space open uses the vault pair, and the minted pair is never persisted as `chat-keys`. **Test in Task 1.**
2. **A removed member's tab stops quietly.** The socket closes with 4403 and `/keyring/state` answers 403. Expected: `not-member`, no further ticket requests, and no reconnect loop. A plain 1006 network drop still reconnects. **Tests in Task 12.**
3. **Two editors append at the same moment.** One gets `409 Log moved`. Expected: it re-syncs, re-signs against the new head and succeeds, with at most 3 retries and never a duplicate entry. **Test in Task 9.**
4. **Stale roster rows.** A removed member is still in `/keyring/pending` and still posts `joinRequest`. Expected: no client wraps a key to them. **Test in Task 10.**
5. **A reload in the middle of a private channel.** Expected: the "Sign in again to read this channel." banner. No socket, no ticket, and no `join-request` while locked. After the hosted round trip, the user is back on `/chat#<room>` with the same identity, and other members still see their earlier messages. **Tests in Tasks 15 and 17.**

## File map

**connect: new files**

| File | Responsibility |
|---|---|
| `src/core/trust/errors.ts` | `IdentityLockedError`, `IdentityUnavailableError`, `SpaceTrustError`, `AdmissionDeniedError` |
| `src/core/trust/IdentitySigner.ts` | the `IdentitySigner` interface plus `SeedIdentitySigner` |
| `src/core/trust/IdentityDirectory.ts` | `POST /api/auth/identity` client, batched and cached |
| `src/core/trust/trustStore.ts` | IndexedDB `muhkoo.trust`, with an in-memory fallback (KI1) |
| `src/core/trust/PinStore.ts` | the identity-v1 and spaces-v1 pin documents |
| `src/core/trust/TrustContext.ts` | one per Client: directory, signer, pins, store, appId |
| `src/spaces/trust/lp.ts` | `lp`, `lpStr`, `dec`, `epochMap`, `concatBytes` (ported) |
| `src/spaces/trust/types.ts` | entry, cert and epoch-commit types (ported subset) |
| `src/spaces/trust/ik.ts` | `decodeRawP256`, `ikEquals`, `importIk`, `verifyP256`, `fingerprint` |
| `src/spaces/trust/canonical.ts` | `opBytes`, `entryBytes`, `entryHash`, `certBytes`, `ecBytes`, `keyCommit` |
| `src/spaces/trust/chatCert.ts` | `mintKeyCert`, `verifyKeyCert` |
| `src/spaces/trust/MembershipLog.ts` | pure verifier and state machine for private logs |
| `src/spaces/trust/LogSync.ts` | fetch/verify/append, high-water mark, genesis trust, pins |
| `tests/fixtures/mlog-v1.json` | copied byte-for-byte from the accelerator |

**connect: modified files**

| File | Change |
|---|---|
| `src/crypto/KeyStore.ts` | `forget`, `markVaultBacked`, `isVaultBacked` |
| `src/core/ChatKeyVault.ts` | marks vault-backed pairs; never persists a foreign pair |
| `src/core/namespaces/SpaceNamespace.ts` | `ensureIdentity`, locked `build`, private genesis path, `canWrapTo`, keyCert provider |
| `src/core/namespaces/HostedAuth.ts` | `returnTo` |
| `src/spaces/Space.ts` | admission, membership API, `mlog` frame, `refuse=close`/4403, integrity pause |
| `src/spaces/SpaceKeyring.ts` | `keyCert` on `requestKey`, `canWrapTo`, `rawKey(epoch)`, `onKeysChanged` |
| `src/spaces/KeyringClient.ts` | `fetchLog`, `postLogEntry`, `probeState`, `KeyringHttpError` |
| `src/spaces/types.ts` | `JoinRequest.keyCert?` |
| `src/transport/WSTransport.ts` | `terminalCloseCodes`, `resume()`, `DISCONNECTED {code}` |
| `src/sessions/BroadcastChannel.ts` | forwards `DISCONNECTED` detail; `resume()` passthrough |
| `src/core/Client.ts` | builds the `TrustContext`; `client.trust` |
| `src/api.ts` | exports |
| `api-surface.txt` | regenerated |
| `CHANGELOG.md` | `## Unreleased` entries |

**web: modified or new files**

| File | Change |
|---|---|
| `package.json`, `yarn.lock` | `file:../connect` |
| `src/auth/AuthContext.tsx` | `locked`, `signInAgain(returnTo)`, `hasPasswordFactor()`; `completeHostedLogin` returns `returnTo` |
| `src/routes/AuthCallbackPage.tsx` | navigates to `returnTo` |
| `src/hooks/useChatChannel.ts` | `enabled` gate, `admission`, `membership`, `addMember`/`removeMember`, private create |
| `src/routes/ChatPage.tsx` | locked, not-member, identity-mismatch and integrity banners; composer gating |
| `src/components/RoomChooserDialog.tsx` | private toggle |
| `src/components/MembersSidebar.tsx` | signed member list, roles, remove |
| `src/components/AddMemberDialog.tsx` | new |
| `cypress/e2e/chat-locked.cy.ts`, `cypress/e2e/private-members.cy.ts` | new mocked specs |

---
## Part A: stable identity (connect)

### Task 1: The locked rule in `ensureIdentity`: never a throwaway key

**Files:**
- Create: `src/core/trust/errors.ts`
- Modify: `src/crypto/KeyStore.ts` (add three methods), `src/core/ChatKeyVault.ts` (`provision`, `rehydrate`), `src/core/namespaces/SpaceNamespace.ts` (`ensureIdentity`)
- Test: `tests/spaces/identityLocked.test.ts` (new); update `tests/core/ChatKeyVault.test.ts` (`resetKeyStore` uses `forget`)

**Interfaces:**
- Produces:
  - `IdentityLockedError`, `IdentityUnavailableError`, `SpaceTrustError(code, message?, detail?)`, `AdmissionDeniedError(code)` and the `SpaceTrustCode` union, all from `src/core/trust/errors.ts`.
  - `KeyStore.markVaultBacked(id)`, `KeyStore.isVaultBacked(id): boolean`, `KeyStore.forget(id)`.
- Consumes: nothing new.

- [ ] **Step 1: Create the error module**

`src/core/trust/errors.ts`:
```ts
/**
 * Trust-layer errors shared by Spaces and, later, DMs (design §3.3, §6.9;
 * SpecA §6.6). Class names are public API and are frozen at their first
 * release (design Q16).
 */

/** The session holds no seed, so it has no stable identity and may not take part (design §3.3, T7). */
export class IdentityLockedError extends Error {
    readonly code = "identity-locked" as const;
    constructor(
        message = "This session is locked. Sign in again (or call client.auth.zk.unlock(password)) to use encrypted spaces. " +
            "Earlier SDK versions silently used a temporary key here, which hid your earlier messages from other members.",
    ) {
        super(message);
        this.name = "IdentityLockedError";
    }
}

/** The stable chat keys could not be loaded (a vault 5xx, say). Retryable (design §3.3, §9.2 I8). */
export class IdentityUnavailableError extends Error {
    readonly code = "identity-unavailable" as const;
    constructor(message = "Your chat keys could not be loaded right now. Try again.", readonly reason?: unknown) {
        super(message);
        this.name = "IdentityUnavailableError";
    }
}

export type SpaceTrustCode =
    | "integrity"
    | "log-conflict"
    | "log-refused"
    | "lookup-failed"
    | "pins-missing"
    | "pins-rollback"
    | "pins-stale"
    | "pins-invalid"
    | "pins-write-failed";

/** A membership-log or pin failure. `detail` carries server fields (`reason`, `head`, ...). */
export class SpaceTrustError extends Error {
    constructor(readonly code: SpaceTrustCode, message?: string, readonly detail?: Record<string, unknown>) {
        super(message ?? code);
        this.name = "SpaceTrustError";
    }
}

/** This user may not open this Space (design §4.5.12, V25). */
export class AdmissionDeniedError extends Error {
    constructor(readonly code: "not-member" | "identity-mismatch", message?: string) {
        super(message ?? code);
        this.name = "AdmissionDeniedError";
    }
}
```

- [ ] **Step 2: Write the failing tests**

`tests/spaces/identityLocked.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { SpaceNamespace } from "../../src/core/namespaces/SpaceNamespace";
import { ChatKeyVault, type ChatKeyStore } from "../../src/core/ChatKeyVault";
import { KeyStore } from "../../src/crypto/KeyStore";
import { IdentityLockedError, IdentityUnavailableError } from "../../src/core/trust/errors";
import type { WrappedPayload } from "../../src/crypto/PassphraseWrap";
import { toBase64 } from "../../src/utilities";

const ME = "alice";

function memVault(): { vault: ChatKeyVault; blob: () => WrappedPayload | null } {
    let blob: WrappedPayload | null = null;
    const store: ChatKeyStore = {
        async get() { return blob; },
        async put(_k, v) { blob = v; },
    };
    return { vault: new ChatKeyVault(store), blob: () => blob };
}

function nsWith(opts: { seed: Uint8Array | null; chatKeys?: ChatKeyVault }): SpaceNamespace {
    const http = {
        baseUrl: "http://test",
        fetch: (async () => new Response("{}")) as typeof fetch,
        get: async () => ({}),
        post: async () => ({}),
        del: async () => ({}),
    };
    return new SpaceNamespace({
        http: http as never,
        session: { username: ME, seed: opts.seed, commitment: "c-alice" } as never,
        wsBaseUrl: "ws://test",
        chatKeys: opts.chatKeys,
    });
}

const ensure = (ns: SpaceNamespace) =>
    (ns as unknown as { ensureIdentity(m: string): Promise<{ ecdhPub: string; ecdsaPub: string }> }).ensureIdentity(ME);
const same = (a: Uint8Array | null, b: Uint8Array | null) => !!a && !!b && Buffer.from(a).equals(Buffer.from(b));

describe("ensureIdentity never takes part with a throwaway key (design §3.3, G10)", () => {
    beforeEach(() => KeyStore.getInstance().forget(ME));

    it("a locked session throws IdentityLockedError and mints nothing", async () => {
        await expect(ensure(nsWith({ seed: null, chatKeys: memVault().vault }))).rejects.toBeInstanceOf(IdentityLockedError);
        expect(KeyStore.getInstance().getKeyPair(ME)).toBeNull();
    });

    it("a vault failure throws IdentityUnavailableError and mints nothing", async () => {
        const broken: ChatKeyStore = {
            async get() { throw new Error("503"); },
            async put() { throw new Error("503"); },
        };
        await expect(ensure(nsWith({ seed: new Uint8Array(32).fill(7), chatKeys: new ChatKeyVault(broken) })))
            .rejects.toBeInstanceOf(IdentityUnavailableError);
        expect(KeyStore.getInstance().getKeyPair(ME)).toBeNull();
    });

    it("no vault configured throws IdentityUnavailableError", async () => {
        await expect(ensure(nsWith({ seed: new Uint8Array(32).fill(7) }))).rejects.toBeInstanceOf(IdentityUnavailableError);
    });

    it("a pair minted while locked is replaced by the vault pair after unlock, and is never persisted", async () => {
        const ks = KeyStore.getInstance();
        await ks.generateOwnKeyPair(ME); // e.g. a DM subscription opened while locked (EncryptedSession)
        const ephemeral = await ks.getRawEcdsaPublicKey(ME);
        const seed = new Uint8Array(32).fill(9);
        const { vault, blob } = memVault();

        await ensure(nsWith({ seed, chatKeys: vault }));

        const stable = await ks.getRawEcdsaPublicKey(ME);
        expect(same(stable, ephemeral)).toBe(false);
        expect(ks.isVaultBacked(ME)).toBe(true);
        expect(blob()).not.toBeNull();
        // What was persisted is the stable pair, not the ephemeral one.
        ks.forget(ME);
        expect(await vault.rehydrate(ME, toBase64(seed))).toBe(true);
        expect(same(await ks.getRawEcdsaPublicKey(ME), stable)).toBe(true);
    });

    it("provision never persists a foreign in-tab pair", async () => {
        const ks = KeyStore.getInstance();
        await ks.generateOwnKeyPair(ME);
        const foreign = await ks.getRawEcdsaPublicKey(ME);
        const { vault } = memVault();
        await vault.provision(ME, "seed-secret");
        expect(same(await ks.getRawEcdsaPublicKey(ME), foreign)).toBe(false);
        expect(ks.isVaultBacked(ME)).toBe(true);
    });
});
```

In `tests/core/ChatKeyVault.test.ts`, replace the body of `resetKeyStore(id)` with `KeyStore.getInstance().forget(id);`.

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `yarn test:unit tests/spaces/identityLocked.test.ts`
Expected: FAIL. `forget` is not a function, and the locked case resolves instead of rejecting.

- [ ] **Step 4: Add the `KeyStore` methods**

In `src/crypto/KeyStore.ts`:
- add the field `private _vaultBacked: Set<string> = new Set();` next to `_authKeys`;
- add these methods after `getAuthKeyPair`:

```ts
    /** Record that `id`'s own pair came from the seed-wrapped vault (ChatKeyVault). */
    public markVaultBacked(id: string): void {
        this._vaultBacked.add(id);
    }

    /**
     * Whether `id`'s own pair was loaded from, or persisted to, the vault in this
     * tab. A Space identity must be vault-backed (design §3.3): any other pair,
     * such as one minted by a locked DM subscription, never takes part.
     */
    public isVaultBacked(id: string): boolean {
        return this._vaultBacked.has(id) && this._keys.get(id)?.privateKey != null;
    }

    /** Drop every key held for `id` (SpecA §6.4 `KeyStore.forget`). */
    public forget(id: string): void {
        this._keys.delete(id);
        this._authKeys.delete(id);
        this._vaultBacked.delete(id);
    }
```

- [ ] **Step 5: Make `ChatKeyVault` vault-only**

In `src/core/ChatKeyVault.ts`, replace `provision` and `rehydrate` with:

```ts
    /**
     * Register-time: ensure a vault-backed keypair exists for `memberId`,
     * seed-wrap it and persist it. Idempotent for a pair that is already
     * vault-backed. A pair that did not come from the vault is dropped and a
     * fresh one minted, so a throwaway key can never be persisted as the stable one.
     */
    async provision(memberId: string, seedSecret: string): Promise<void> {
        const ks = KeyStore.getInstance();
        if (!ks.isVaultBacked(memberId)) {
            if (ks.getKeyPair(memberId)) ks.forget(memberId);
            await ks.generateOwnKeyPair(memberId);
        }
        const dehydrated = await ks.dehydrateKeyPair(memberId);
        const plaintext = new TextEncoder().encode(JSON.stringify(dehydrated));
        await this.store.put(CHAT_KEYS_KEY, await wrapWithPassphrase(seedSecret, plaintext));
        ks.markVaultBacked(memberId);
        vlog(`provision: minted+persisted keypair fp=${await fingerprint(memberId)}`);
    }

    /**
     * Sign-in / unlock time: fetch the wrapped blob, unwrap it with the seed, and
     * hydrate the `KeyStore`, restoring the SAME keypair the member had before.
     * Returns `true` when a vault-backed keypair is now in hand, and `false` when
     * there is no blob yet (a brand-new member; the caller provisions). Throws only
     * on a genuine unwrap failure. A pair in the tab that did not come from the
     * vault is dropped first.
     */
    async rehydrate(memberId: string, seedSecret: string): Promise<boolean> {
        const ks = KeyStore.getInstance();
        if (ks.isVaultBacked(memberId)) return true;
        if (ks.getKeyPair(memberId)) ks.forget(memberId);
        const wrapped = await this.store.get(CHAT_KEYS_KEY);
        if (!wrapped) {
            vlog("rehydrate: no chat-keys blob (new member → will provision)");
            return false;
        }
        const bytes = await unwrapWithPassphrase(seedSecret, wrapped);
        const dehydrated = JSON.parse(new TextDecoder().decode(bytes));
        await ks.hydrateKeyPair(memberId, dehydrated);
        ks.markVaultBacked(memberId);
        vlog(`rehydrate: HIT — restored stable keypair fp=${await fingerprint(memberId)}`);
        return true;
    }
```

- [ ] **Step 6: Replace `ensureIdentity`**

In `src/core/namespaces/SpaceNamespace.ts`:
- import `IdentityLockedError` and `IdentityUnavailableError` from `../trust/errors`;
- replace the whole `ensureIdentity` method with:

```ts
    /**
     * The member's stable chat identity (design §3.3). A locked session (no
     * seed) throws `IdentityLockedError`. A vault failure throws
     * `IdentityUnavailableError` (retryable). A throwaway pair is never minted:
     * doing so is what hid a reloaded member's earlier messages from everyone else.
     */
    private async ensureIdentity(memberId: string): Promise<{ ecdhPub: string; ecdsaPub: string }> {
        const store = KeyStore.getInstance();
        const seed = this.deps.session.seed;
        if (!seed) throw new IdentityLockedError();
        if (!store.isVaultBacked(memberId)) {
            if (!this.deps.chatKeys) {
                throw new IdentityUnavailableError("This client has no chat-key vault; sign in with a session first.");
            }
            try {
                await this.deps.chatKeys.ensure(memberId, toBase64(seed));
            } catch (e) {
                throw new IdentityUnavailableError(undefined, e);
            }
            if (!store.isVaultBacked(memberId)) throw new IdentityUnavailableError();
        }
        const ecdhPub = await exportEcdhPublicKey(store.getKeyPair(memberId)!.publicKey);
        const ecdsaPub = await exportEcdsaPublicKey(store.getAuthKeyPair(memberId)!.publicKey);
        return { ecdhPub, ecdsaPub };
    }
```

The staging `console.info` diagnostics in the old method go away with it.

- [ ] **Step 7: Run the tests and confirm they pass**

Run: `yarn test:unit tests/spaces/identityLocked.test.ts tests/core/ChatKeyVault.test.ts`
Expected: PASS (5 plus 4).

- [ ] **Step 8: Checkpoint**

Run: `yarn typecheck && yarn test:unit`
Expected: 0 type errors.

Any existing test that builds a Space through `SpaceNamespace` without a seed now fails with `IdentityLockedError` or `IdentityUnavailableError`. Fix each by giving its fake session `seed: new Uint8Array(32).fill(1)` and passing `chatKeys: memVault().vault`, copying the helper above. Do not weaken the rule.

Report every test you changed.

---

### Task 2: A locked Space: admission `locked`, no socket, no join request

**Files:**
- Modify: `src/spaces/Space.ts` (admission state, locked guards), `src/spaces/SpaceKeyring.ts` (`onKeysChanged`), `src/core/namespaces/SpaceNamespace.ts` (`build`, `createSpace`, `joinByInvite`)
- Test: `tests/spaces/Space.locked.test.ts` (new)

**Interfaces:**
- Consumes: the errors from Task 1.
- Produces:
  - `export type AdmissionState = "locked" | "requesting" | "keyed" | "not-member" | "identity-mismatch" | "integrity"` in `src/spaces/Space.ts`;
  - `Space.admission: AdmissionState`;
  - `Space.onAdmission(h: (s: AdmissionState) => void): () => void`;
  - `protected Space.setAdmission(s)`, used by Tasks 11 and 12;
  - `SpaceDeps.locked?: boolean`;
  - `SpaceKeyring.onKeysChanged(h: () => void): () => void`.

- [ ] **Step 1: Write the failing tests**

`tests/spaces/Space.locked.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { SpaceNamespace } from "../../src/core/namespaces/SpaceNamespace";
import { ChatKeyVault, type ChatKeyStore } from "../../src/core/ChatKeyVault";
import { KeyStore } from "../../src/crypto/KeyStore";
import { IdentityLockedError } from "../../src/core/trust/errors";
import type { WrappedPayload } from "../../src/crypto/PassphraseWrap";

const ME = "alice";

function setup(seed: Uint8Array | null) {
    const posted: string[] = [];
    let blob: WrappedPayload | null = null;
    const store: ChatKeyStore = { async get() { return blob; }, async put(_k, v) { blob = v; } };
    const http = {
        baseUrl: "http://test",
        fetch: (async () => new Response("{}")) as typeof fetch,
        get: async () => ({}),
        post: async (path: string) => { posted.push(path); return {}; },
        del: async () => ({}),
    };
    const ns = new SpaceNamespace({
        http: http as never,
        session: { username: ME, seed, commitment: "c-alice" } as never,
        wsBaseUrl: "ws://test",
        chatKeys: new ChatKeyVault(store),
    });
    return { ns, posted };
}

describe("a locked session never opens a Space (design §3.3 table)", () => {
    beforeEach(() => KeyStore.getInstance().forget(ME));

    it("get() returns a Space with admission locked; connect refuses; join resolves false; nothing is sent", async () => {
        const { ns, posted } = setup(null);
        const space = await ns.get("space-1");
        expect(space.admission).toBe("locked");
        await expect(space.connect()).rejects.toBeInstanceOf(IdentityLockedError);
        expect(await space.join()).toBe(false);
        expect(posted).toEqual([]); // no ticket, no join-request
        expect(KeyStore.getInstance().getKeyPair(ME)).toBeNull();
    });

    it("createChannel throws IdentityLockedError before any request", async () => {
        const { ns, posted } = setup(null);
        await expect(ns.createChannel("general")).rejects.toBeInstanceOf(IdentityLockedError);
        expect(posted).toEqual([]);
    });

    it("createSpace({messaging:false}) still works while locked (the VFS content Space)", async () => {
        const { ns, posted } = setup(null);
        const space = await ns.createSpace({ private: true, messaging: false });
        expect(posted).toHaveLength(1);
        expect(posted[0]).toMatch(/^\/api\/spaces\/.+\/metadata$/);
        expect(space.admission).toBe("locked");
    });

    it("an unlocked Space starts requesting and turns keyed once the keyring holds a key", async () => {
        const { ns } = setup(new Uint8Array(32).fill(3));
        const space = await ns.get("space-2");
        expect(space.admission).toBe("requesting");
        const seen: string[] = [];
        space.onAdmission((s) => seen.push(s));
        await space.keyring!.bootstrapNew();
        expect(space.admission).toBe("keyed");
        expect(seen).toEqual(["keyed"]);
    });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `yarn test:unit tests/spaces/Space.locked.test.ts`
Expected: FAIL. `admission` is undefined, and `get()` throws `IdentityLockedError` from `ensureIdentity`.

- [ ] **Step 3: `SpaceKeyring.onKeysChanged`**

In `src/spaces/SpaceKeyring.ts`, add the field `private readonly keyListeners = new Set<() => void>();` and these methods:

```ts
    /** Notified whenever this keyring gains a key (bootstrap, cache hit, pull). Returns an unsubscribe. */
    onKeysChanged(h: () => void): () => void {
        this.keyListeners.add(h);
        return () => this.keyListeners.delete(h);
    }

    private notifyKeys(): void {
        for (const h of this.keyListeners) {
            try { h(); } catch { /* a listener's failure never breaks the keyring */ }
        }
    }
```

Call `this.notifyKeys()` in three places:
- at the end of `bootstrapNew()`;
- in `loadFromCache()` on the path that returns `true`;
- in `pullKeys()` when `added > 0`, after `await this.persist()`.

- [ ] **Step 4: Admission in `Space`**

In `src/spaces/Space.ts`:
1. Add `export type AdmissionState = "locked" | "requesting" | "keyed" | "not-member" | "identity-mismatch" | "integrity";` above `SpaceDeps`.
2. Add to `SpaceDeps`:
   `/** Locked session (design §3.3): no keyring, never connects; the app re-opens after sign-in. */ locked?: boolean;`
3. Add the field `private _admission: AdmissionState;` to the class.
4. In the constructor, after `this.cipher = …`, add:
   ```ts
   this._admission = deps.locked ? "locked" : "requesting";
   deps.keyring?.onKeysChanged(() => {
       if (this._admission === "requesting") this.setAdmission("keyed");
   });
   ```
5. Add, after the `keyring` getter:

```ts
    /** Where this member stands in this Space (design §4.5.12, as the slice ships it). */
    get admission(): AdmissionState {
        return this._admission;
    }

    /** Subscribe to admission changes. Returns an unsubscribe. */
    onAdmission(h: (s: AdmissionState) => void): () => void {
        const l = (e: Event) => h((e as CustomEvent<AdmissionState>).detail);
        this.events.addEventListener("admission", l);
        return () => this.events.removeEventListener("admission", l);
    }

    protected setAdmission(s: AdmissionState): void {
        if (this._admission === s) return;
        this._admission = s;
        this.emitEvent("admission", s);
    }
```

   (`emitEvent(name, detail)` already dispatches a `CustomEvent` on `this.events`. Check its signature and adapt the call if it differs.)
6. Add the locked guards:
   - first line of `connect()`: `if (this.deps.locked) throw new IdentityLockedError();`
   - first line of `join()`: `if (this.deps.locked) return false;`
   - first line of `create()`: `if (this.deps.locked) throw new IdentityLockedError();`

   Import `IdentityLockedError` from `../core/trust/errors`.

- [ ] **Step 5: Build a locked Space in `SpaceNamespace`**

At the top of `build()`, before `ensureIdentity`:

```ts
        if (!this.deps.session.seed) {
            // Locked (design §3.3): no identity, no keyring, no join request. The
            // Space reports admission "locked"; the app re-opens it after sign-in.
            const locked = new Space({
                name: spaceId,
                wsBaseUrl: this.deps.wsBaseUrl,
                httpBaseUrl: this.deps.http.baseUrl,
                fetch: this.deps.http.fetch,
                myId: () => memberId,
                fetchTicket: () => this.fetchTicket(),
                historyPolicy,
                locked: true,
                shardCache: this.deps.offline?.fileCache,
                deferShardUpload: this.deps.offline
                    ? (hash: string) => this.deps.offline!.deferShardUpload(hash)
                    : undefined,
            });
            this.openSpaces.set(spaceId, locked);
            return locked;
        }
```

Then add a guard as the **first** statement of `createSpace()`, before the metadata POST:

```ts
        if (opts.messaging !== false && !this.deps.session.seed) throw new IdentityLockedError();
```

Add the same guard (without the `messaging` condition) as the first statement of `joinByInvite()`.

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `yarn test:unit tests/spaces/Space.locked.test.ts tests/spaces/identityLocked.test.ts`
Expected: PASS.

- [ ] **Step 7: Checkpoint**

Run: `yarn typecheck && yarn test:unit`
Expected: 0 type errors and the full suite green, including `Space.wire.test.ts`.

---

### Task 3: Hosted sign-in `returnTo`

**Files:**
- Modify: `src/core/namespaces/HostedAuth.ts` (`login`, `handleCallback`, `store`, `take`)
- Test: `tests/auth/hosted-returnto.test.ts` (new)

**Interfaces:**
- Produces:
  - `hosted.login({ appId, redirectUri, redirect?, prompt?, returnTo?: string })`;
  - `hosted.handleCallback(): Promise<AuthUser & { returnTo?: string }>`;
  - `export function isSameOriginPath(p: unknown): p is string`.

- [ ] **Step 1: Write the failing tests**

Build the `HostedAuth` instance the way `tests/auth/hosted-handoff.test.ts` does. Reuse its fake `location`, `sessionStorage` and `auth.token` stub, and its `sealSeed` call, so that `handleCallback()` can run end to end. Then:

```ts
import { describe, it, expect } from "vitest";
import { isSameOriginPath } from "../../src/core/namespaces/HostedAuth";

describe("hosted returnTo (design §6.9, CS-5; §4.4.9 same-origin rule)", () => {
    it("accepts same-origin paths only", () => {
        expect(isSameOriginPath("/chat#general")).toBe(true);
        expect(isSameOriginPath("/")).toBe(true);
        for (const bad of ["//evil.com/x", "https://evil.com", "chat", "/\\evil.com", "/a\u0000b", "", 42]) {
            expect(isSameOriginPath(bad)).toBe(false);
        }
    });

    it("login rejects a non-same-origin returnTo before redirecting", async () => {
        const hosted = makeHosted(); // helper copied from hosted-handoff.test.ts
        await expect(hosted.login({ appId: "a", redirectUri: "https://app/cb", redirect: false, returnTo: "//evil.com" }))
            .rejects.toThrow(/same-origin/);
    });

    it("the returnTo stashed at login comes back from handleCallback", async () => {
        const hosted = makeHosted();
        await hosted.login({ appId: "a", redirectUri: "https://app/cb", redirect: false, returnTo: "/chat#room-1" });
        // simulate the hosted page's redirect back, using the helper's code/state/#k fixtures
        const user = await completeCallback(hosted);
        expect(user.returnTo).toBe("/chat#room-1");
    });

    it("a tampered stash with a foreign returnTo is dropped, not followed", async () => {
        const hosted = makeHosted();
        await hosted.login({ appId: "a", redirectUri: "https://app/cb", redirect: false, returnTo: "/ok" });
        const raw = JSON.parse(sessionStorage.getItem("muhkoo.hosted.pkce")!);
        sessionStorage.setItem("muhkoo.hosted.pkce", JSON.stringify({ ...raw, returnTo: "https://evil.com" }));
        const user = await completeCallback(hosted);
        expect(user.returnTo).toBeUndefined();
    });
});
```

`makeHosted()` and `completeCallback()` are test-local helpers built from `hosted-handoff.test.ts`'s existing setup. If that file does not run `handleCallback`, build `completeCallback` like this:
- set `location.search` to `?code=c&state=<stash.state>` and `location.hash` to `#k=<key>`;
- have the fake `auth.token` return `{sessionToken, username, commitment, sealedKeys, appId}`, where `sealedKeys` and the key come from `sealSeed(seed)` in `src/auth/hostedHandoff.ts`.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `yarn test:unit tests/auth/hosted-returnto.test.ts`
Expected: FAIL. `isSameOriginPath` is not exported, and `returnTo` is not stored.

- [ ] **Step 3: Implement**

In `src/core/namespaces/HostedAuth.ts`, add at module level:

```ts
/**
 * A same-origin path the app may be sent back to after sign-in. It starts with
 * "/", not "//", and has no backslash or control characters (design §4.4.9).
 */
export function isSameOriginPath(p: unknown): p is string {
    return typeof p === "string" && p.startsWith("/") && !p.startsWith("//") && !p.includes("\\") && !/[\u0000-\u001f]/.test(p);
}
```

In `login`:
- widen the opts type with `returnTo?: string`;
- first line: `if (opts.returnTo !== undefined && !isSameOriginPath(opts.returnTo)) throw new Error('returnTo must be a same-origin path (start with "/", not "//").');`
- store it: `this.store({ codeVerifier, state, appId: opts.appId, redirectUri: opts.redirectUri, ...(opts.returnTo ? { returnTo: opts.returnTo } : {}) });`

In `store` and `take`, widen the stash type to `{ codeVerifier: string; state: string; appId: string; redirectUri: string; returnTo?: string }`.

In `handleCallback`:
- change the return type to `Promise<AuthUser & { returnTo?: string }>`;
- change the final return to:

```ts
        const returnTo = isSameOriginPath(stash.returnTo) ? stash.returnTo : undefined;
        return { username: res.username, commitment: res.commitment, ...(returnTo ? { returnTo } : {}) };
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `yarn test:unit tests/auth/hosted-returnto.test.ts tests/auth/hosted-handoff.test.ts`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Run: `yarn typecheck && yarn test:unit`
Expected: green.

---
## Part B: trust primitives (connect)

### Task 4: Canonical encoders, ported and checked against the shared fixture

**Files:**
- Create: `src/spaces/trust/lp.ts`, `src/spaces/trust/types.ts`, `src/spaces/trust/ik.ts`, `src/spaces/trust/canonical.ts`
- Create: `tests/fixtures/mlog-v1.json`, copied **byte-for-byte**: `cp /Users/matt/GitHub/muhkoo/accelerator/tests/fixtures/mlog-v1.json tests/fixtures/mlog-v1.json`. Then `shasum -a 256` must start `81584c6a`.
- Test: `tests/spaces/trust/canonical.test.ts` (new)

**Interfaces:**
- Produces:
  - Port these, keeping the accelerator's names and signatures unchanged:
    - `lp`, `lpStr`, `dec`, `concatBytes` (`lp.ts`);
    - `LABEL_CHATKEY`, `LABEL_MLOG`, `LABEL_EPOCH_COMMIT`, `certBytes(memberId, {ik, ecdh, ecdsa})`, `epochMapBytes(map)`, `opBytes(entry)`, `entryBytes(unsigned)`, `entryHash(unsigned): Promise<string>`, `ecBytes(ecWithoutSig)` (`canonical.ts`);
    - `decodeRawP256`, `ikEquals`, `importIk`, `verifyP256(ik, sigB64, data)` (`ik.ts`).
  - New in this port:
    - `keyCommit(epoch: number, key: Uint8Array, spaceId: string): Promise<string>`;
    - `fingerprint(ik: string): Promise<string>`, which is standard padded base64 of SHA-256 over the raw 65 bytes;
    - `sha256(bytes): Promise<Uint8Array>`.
  - Types in `types.ts`: `MembershipEntry`, `UnsignedEntry`, `OpAndBody`, `MlogOp`, the op body interfaces, `ChatKeyCert`, `EpochCommit`, `MlogHead`, `MemberRole`.
- Consumes: `utf8Encode`, `toBase64`, `fromBase64Url` and `toBase64Url` from `src/utilities`.

- [ ] **Step 1: Write the failing tests**

`tests/spaces/trust/canonical.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { lpStr, dec, concatBytes } from "../../../src/spaces/trust/lp";
import { certBytes, ecBytes, entryBytes, entryHash, epochMapBytes, keyCommit, opBytes, LABEL_MLOG } from "../../../src/spaces/trust/canonical";
import { verifyP256 } from "../../../src/spaces/trust/ik";

const fx = JSON.parse(readFileSync(new URL("../../fixtures/mlog-v1.json", import.meta.url), "utf8"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unsign = (e: Record<string, unknown>) => { const { sig: _s, lsig: _l, ...u } = e; return u as never; };

describe("canonical encoders match the accelerator fixture byte-for-byte (design §6.10, D21)", () => {
    it("labels", () => { expect(LABEL_MLOG).toBe(fx.labels.mlog); });
    it("LP primitives", () => {
        for (const v of fx.primitives.lp) expect(hex(lpStr(v.str))).toBe(v.hex);
        for (const v of fx.primitives.dec) expect(dec(v.n)).toBe(v.str);
        for (const v of fx.primitives.epochMap) expect(hex(epochMapBytes(v.map))).toBe(v.hex);
    });
    for (const chain of ["private", "public"] as const) {
        it(`${chain} chain: opBytes, entryBytes and hashes`, async () => {
            for (const rec of fx.chains[chain].entries) {
                expect(hex(opBytes(rec.entry)), rec.name).toBe(rec.opBytesHex);
                expect(hex(entryBytes(unsign(rec.entry))), rec.name).toBe(rec.bytesHex);
                expect(await entryHash(unsign(rec.entry)), rec.name).toBe(rec.hash);
            }
        });
    }
    it("signatures in the fixture verify over entryBytes (P1363, IK as sent)", async () => {
        const g = fx.chains.private.entries[0].entry;
        expect(await verifyP256(g.ik, g.sig, entryBytes(unsign(g)))).toBe(true);
    });
    it("epoch commit bytes", () => {
        const { sig: _s, ...ec } = fx.epochCommit.ec;
        expect(hex(ecBytes(ec))).toBe(fx.epochCommit.bytesHex);
    });
    it("chat-key cert bytes lower-case the member id", () => {
        expect(hex(certBytes(fx.keyCert.memberId, fx.keyCert.cert))).toBe(fx.keyCert.bytesHex);
    });
    it("keyCommit vectors", async () => {
        for (const v of fx.keyCommits) {
            expect(await keyCommit(v.epoch, Buffer.from(v.keyHex, "hex"), v.spaceId)).toBe(v.keyCommit);
        }
    });
    it("LP is injective: (a, bc) differs from (ab, c)", () => {
        expect(hex(concatBytes(lpStr("a"), lpStr("bc")))).not.toBe(hex(concatBytes(lpStr("ab"), lpStr("c"))));
    });
    it("the hash ignores sig", async () => {
        const e = fx.chains.private.entries[0].entry;
        expect(await entryHash(unsign({ ...e, sig: "AAAA" }))).toBe(await entryHash(unsign(e)));
    });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `yarn test:unit tests/spaces/trust/canonical.test.ts`
Expected: FAIL, because the modules are missing.

- [ ] **Step 3: Port the modules**

Copy these accelerator files, keeping every function body **unchanged**:
- `acc/src/trust/lp.ts` → `src/spaces/trust/lp.ts`
- `acc/src/trust/types.ts` → `src/spaces/trust/types.ts`, dropping only `AppRoster`, `AppRosterEditor` and `NeedsSignature`
- `acc/src/trust/canonical.ts` → `src/spaces/trust/canonical.ts`, dropping `LABEL_APPROSTER` and `rosterBytes`

Change only the imports:

| accelerator import | connect replacement |
|---|---|
| `utf8` from `../lib/encoding` | `utf8Encode` from `../../utilities` (rename the call sites) |
| `sha256Bytes` from `../lib/encoding` | local `sha256` in `canonical.ts` (below) |
| `toBase64`, `fromBase64Url` from `../lib/encoding` | the same names from `../../utilities` |

Add to `canonical.ts`:

```ts
/** SHA-256 over bytes (WebCrypto). */
export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

/**
 * keyCommit(e, K) := b64url_nopad(HKDF-SHA256(ikm = K, salt = utf8("epoch:" + e),
 * info = utf8("muhkoo/space/key-commit/v1\n" + spaceId), L = 32)) (design §4.2.4).
 * The same function as accelerator/scripts/gen-mlog-fixture.mjs `keyCommit`.
 */
export async function keyCommit(epoch: number, key: Uint8Array, spaceId: string): Promise<string> {
    const ikm = await crypto.subtle.importKey("raw", key, "HKDF", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: utf8Encode(`epoch:${dec(epoch)}`), info: utf8Encode(`muhkoo/space/key-commit/v1\n${spaceId}`) },
        ikm,
        256,
    );
    return toBase64Url(new Uint8Array(bits));
}
```

Before relying on `keyCommit`, read `acc/scripts/gen-mlog-fixture.mjs` around line 152. If its salt or info strings differ from the ones above in any character, use the generator's, because the fixture vectors are the arbiter.

Create `src/spaces/trust/ik.ts` from two accelerator files:
- `acc/src/lib/ik.ts`: `decodeRawP256`, `ikEquals`; `normalizeIk` is optional;
- `acc/src/trust/verify.ts`: `importIk`, `verifyP256`, but not the entry/cert/roster wrappers.

Add to it:

```ts
/** fp(IK) = b64(SHA-256(raw 65 bytes)) (design §3.2). Throws if `ik` is not a P-256 point. */
export async function fingerprint(ik: string): Promise<string> {
    const raw = decodeRawP256(ik);
    if (!raw) throw new Error("fingerprint: not a P-256 identity key");
    return toBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", raw)));
}
```

Nothing under `src/spaces/trust/` may import `src/core/*`, `src/auth/*` or any npm package (§6.9: "`canonical.ts` has no npm dependencies").

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `yarn test:unit tests/spaces/trust/canonical.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Checkpoint**

Run: `yarn typecheck && yarn lint && yarn test:unit`
Expected: green.

---

### Task 5: `IdentitySigner` and the identity directory

**Files:**
- Create: `src/core/trust/IdentitySigner.ts`, `src/core/trust/IdentityDirectory.ts`
- Test: `tests/core/trust/identity.test.ts` (new)

**Interfaces:**
- Consumes:
  - `SessionState` (`seed`, `identity`, `username`);
  - `deriveIdentityFromSeed` (`src/auth/identity.ts`);
  - `exportPublicKeyBase64` (`src/auth/keys.ts`);
  - `ikEquals` (Task 4);
  - `HttpError` (`src/core/HttpClient.ts`);
  - `SpaceTrustError` and `IdentityLockedError` (Task 1).
- Produces:
  - `interface IdentitySigner { sign(bytes: Uint8Array): Promise<string>; identityKeyRaw(): Promise<string> }`;
  - `class SeedIdentitySigner implements IdentitySigner`, constructed as `({ session, directory })`;
  - `class IdentityDirectory`, constructed as `(http: Pick<HttpClient, "post">)`, with `lookup(username): Promise<string>` and `lookupMany(usernames): Promise<Record<string, string>>`. Results are keyed by lower-cased name.

- [ ] **Step 1: Write the failing tests**

`tests/core/trust/identity.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { IdentityDirectory } from "../../../src/core/trust/IdentityDirectory";
import { SeedIdentitySigner } from "../../../src/core/trust/IdentitySigner";
import { IdentityLockedError, SpaceTrustError } from "../../../src/core/trust/errors";
import { HttpError } from "../../../src/core/HttpClient";
import { deriveIdentityFromSeed } from "../../../src/auth/identity";
import { exportPublicKeyBase64 } from "../../../src/auth/keys";
import { verifyP256 } from "../../../src/spaces/trust/ik";

function fakeHttp(keys: Record<string, string>, calls: unknown[] = [], status = 200) {
    return {
        async post(path: string, body: { usernames: string[] }) {
            calls.push({ path, body });
            if (status !== 200) throw new HttpError("Too many attempts", status, { error: "Too many attempts" });
            return { keys: Object.fromEntries(body.usernames.map((u) => [u, keys[u] ?? `decoy-${u}`])) };
        },
    };
}

describe("IdentityDirectory (SpecA §4.1 as amended)", () => {
    it("batches at most 64 names per call and lower-cases keys", async () => {
        const calls: unknown[] = [];
        const dir = new IdentityDirectory(fakeHttp({}, calls) as never);
        const names = Array.from({ length: 100 }, (_, i) => `User${i}`);
        const out = await dir.lookupMany(names);
        expect(calls).toHaveLength(2);
        expect(Object.keys(out)).toContain("user99");
    });
    it("caches per Client: a second lookup makes no call", async () => {
        const calls: unknown[] = [];
        const dir = new IdentityDirectory(fakeHttp({ bob: "IKB" }, calls) as never);
        expect(await dir.lookup("Bob")).toBe("IKB");
        expect(await dir.lookup("bob")).toBe("IKB");
        expect(calls).toHaveLength(1);
    });
    it("a 429 is a lookup failure that fails closed", async () => {
        const dir = new IdentityDirectory(fakeHttp({}, [], 429) as never);
        await expect(dir.lookup("bob")).rejects.toMatchObject({ code: "lookup-failed" });
        await expect(dir.lookup("bob")).rejects.toBeInstanceOf(SpaceTrustError);
    });
});

describe("SeedIdentitySigner (SpecA §6.1 KxSigner; slice ruling S12)", () => {
    const seed = new Uint8Array(32).fill(5);
    async function registeredIk() {
        return exportPublicKeyBase64((await deriveIdentityFromSeed(seed)).ecdsaKeyPair.publicKey);
    }
    it("a locked session throws IdentityLockedError", async () => {
        const s = new SeedIdentitySigner({ session: { seed: null, identity: null, username: "alice" } as never, directory: {} as never });
        await expect(s.identityKeyRaw()).rejects.toBeInstanceOf(IdentityLockedError);
    });
    it("signs raw bytes with the registered IK (P1363, verifiable)", async () => {
        const ik = await registeredIk();
        const dir = { lookup: async () => ik };
        const s = new SeedIdentitySigner({ session: { seed, identity: null, username: "alice" } as never, directory: dir as never });
        expect(await s.identityKeyRaw()).toBe(ik);
        const bytes = new Uint8Array([0, 1, 2, 255]);
        const sig = await s.sign(bytes);
        expect(Buffer.from(sig, "base64")).toHaveLength(64);
        expect(await verifyP256(ik, sig, bytes)).toBe(true);
    });
    it("refuses to sign when the derived IK is not the account's registered IK", async () => {
        const other = await exportPublicKeyBase64((await deriveIdentityFromSeed(new Uint8Array(32).fill(6))).ecdsaKeyPair.publicKey);
        const s = new SeedIdentitySigner({ session: { seed, identity: null, username: "alice" } as never, directory: { lookup: async () => other } as never });
        await expect(s.sign(new Uint8Array([1]))).rejects.toBeInstanceOf(IdentityLockedError);
    });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `yarn test:unit tests/core/trust/identity.test.ts`
Expected: FAIL, because the modules are missing.

- [ ] **Step 3: Implement**

`src/core/trust/IdentityDirectory.ts`:
```ts
import { HttpError, type HttpClient } from "../HttpClient";
import { SpaceTrustError } from "./errors";

/**
 * POST /api/auth/identity (SpecA §4.1 as amended by CS-7). An unknown name
 * answers a deterministic decoy, so a lookup never says whether an account
 * exists. Responses are cached for the life of the Client. Any failure,
 * including a 429, fails closed (SpecA §4.3).
 */
export class IdentityDirectory {
    private readonly cache = new Map<string, string>();

    constructor(private readonly http: Pick<HttpClient, "post">) {}

    async lookup(username: string): Promise<string> {
        const l = username.toLowerCase();
        return (await this.lookupMany([username]))[l];
    }

    async lookupMany(usernames: string[]): Promise<Record<string, string>> {
        const out: Record<string, string> = {};
        const missing: string[] = [];
        for (const u of usernames) {
            const l = u.toLowerCase();
            const hit = this.cache.get(l);
            if (hit) out[l] = hit;
            else if (!missing.includes(l)) missing.push(l);
        }
        for (let i = 0; i < missing.length; i += 64) {
            const batch = missing.slice(i, i + 64);
            let keys: Record<string, unknown> | undefined;
            try {
                keys = (await this.http.post<{ keys?: Record<string, unknown> }>("/api/auth/identity", { usernames: batch }))?.keys;
            } catch (e) {
                throw new SpaceTrustError("lookup-failed", "Couldn't verify members right now; retrying.", {
                    status: e instanceof HttpError ? e.status : undefined,
                });
            }
            for (const l of batch) {
                const k = keys?.[l];
                if (typeof k !== "string") throw new SpaceTrustError("lookup-failed", "Couldn't verify members right now; retrying.");
                this.cache.set(l, k);
                out[l] = k;
            }
        }
        return out;
    }
}
```

`src/core/trust/IdentitySigner.ts`:
```ts
import type { SessionState } from "../Session";
import { deriveIdentityFromSeed } from "../../auth/identity";
import { exportPublicKeyBase64 } from "../../auth/keys";
import { ikEquals } from "../../spaces/trust/ik";
import { toBase64 } from "../../utilities";
import { IdentityLockedError } from "./errors";
import type { IdentityDirectory } from "./IdentityDirectory";

/** Signs with the account identity key (IK). Never exposes the seed (SpecA §6.1). */
export interface IdentitySigner {
    /** b64 IEEE-P1363 ECDSA-P256-SHA256 over `bytes`. */
    sign(bytes: Uint8Array): Promise<string>;
    /** The IK as standard padded base64 of the raw 65-byte point. */
    identityKeyRaw(): Promise<string>;
}

/**
 * Derives the IK from the in-memory seed (HKDF(seed,"ecdsa-priv"), non-extractable),
 * and checks it against the account's registered IK before its first use, because
 * `unlockWithSeed`/`unlockWithDevice` set a seed without a commitment check
 * (slice ruling S12). Locked or mismatched → IdentityLockedError.
 */
export class SeedIdentitySigner implements IdentitySigner {
    private cached: { seed: Uint8Array; priv: CryptoKey; ik: string } | null = null;

    constructor(private readonly deps: { session: SessionState; directory: Pick<IdentityDirectory, "lookup"> }) {}

    private async key(): Promise<{ priv: CryptoKey; ik: string }> {
        const { session } = this.deps;
        const seed = session.seed;
        const username = session.username;
        if (!seed || !username) throw new IdentityLockedError();
        if (this.cached && this.cached.seed === seed) return this.cached;
        const identity = session.identity ?? (await deriveIdentityFromSeed(seed));
        const ik = await exportPublicKeyBase64(identity.ecdsaKeyPair.publicKey);
        const registered = await this.deps.directory.lookup(username);
        if (!ikEquals(registered, ik)) {
            throw new IdentityLockedError("This session's key is not your account's registered identity. Sign in again.");
        }
        this.cached = { seed, priv: identity.ecdsaKeyPair.privateKey, ik };
        return this.cached;
    }

    async identityKeyRaw(): Promise<string> {
        return (await this.key()).ik;
    }

    async sign(bytes: Uint8Array): Promise<string> {
        const { priv } = await this.key();
        return toBase64(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, bytes)));
    }
}
```

Check two names in the source before relying on them:
- that `SessionState` exposes `seed`, `identity` and `username` under these names (`src/core/Session.ts`);
- that `ZkIdentity.ecdsaKeyPair` is spelled this way (`src/auth/identity.ts`).

If either differs, use the source names.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `yarn test:unit tests/core/trust/identity.test.ts`
Expected: PASS (6).

- [ ] **Step 5: Checkpoint**

Run: `yarn typecheck && yarn lint && yarn test:unit`
Expected: green.

---

### Task 6: `muhkoo.trust` store, `PinStore`, `TrustContext`

**Files:**
- Create: `src/core/trust/trustStore.ts`, `src/core/trust/PinStore.ts`, `src/core/trust/TrustContext.ts`
- Test: `tests/core/trust/fakes.ts` (a fake personal KV plus a real-key test signer), `tests/core/trust/PinStore.test.ts`, `tests/core/trust/trustStore.test.ts`

**Interfaces:**
- Consumes: Task 5's `IdentitySigner`, `IdentityDirectory` and `SeedIdentitySigner`; Task 4's `lp`, `lpStr`, `dec`, `concatBytes` and `verifyP256`; `HttpClient`/`HttpError`; `SessionState`.
- Produces:
  - from `trustStore.ts`:
    - `interface TrustStore { persistent: boolean; get<T>(k): Promise<T|undefined>; put(k, v): Promise<void>; del(k): Promise<void> }`;
    - `memoryTrustStore()`;
    - `openTrustStore({idb?, timeoutMs?})`;
    - `TRUST_OPEN_TIMEOUT_MS = 2000`.
  - from `PinStore.ts`:
    - `type PinDocName = "identity" | "spaces"`;
    - `class PinStore` with `read(doc)`, `get(doc, key)`, `pin(doc, entries): Promise<{conflicts: string[]}>`, `unpin(doc, keys)` and `resetMark(doc)`;
    - `pinDocBytes(label, commitment, counter, entries)`;
    - `pad16(n)`;
    - `spacePinKey(spaceId): Promise<string>`, which returns `"s:" + b64url(SHA-256(utf8(spaceId)))`.
  - from `TrustContext.ts`: `class TrustContext` with `directory`, `signer`, `pins`, `store()`, `appId()`, `resetSpaceTrust(spaceId)` and `unpinUser(username)`.

- [ ] **Step 1: Write the fakes and failing tests**

`tests/core/trust/fakes.ts`:
```ts
import { toBase64 } from "../../../src/utilities";
import type { IdentitySigner } from "../../../src/core/trust/IdentitySigner";

/** A real P-256 key behind the IdentitySigner interface. */
export async function testSigner(): Promise<IdentitySigner & { kp: CryptoKeyPair }> {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const ik = toBase64(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
    return {
        kp,
        identityKeyRaw: async () => ik,
        sign: async (b) => toBase64(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, b))),
    };
}

/**
 * The personal-KV routes the SDK uses for reserved documents (server brief §8;
 * PersonalSpaceDO.hlcLoses is a STRING compare): POST .../kv/<key> {value, hlc}
 * → {ok, applied}; POST .../kv/<key>/get → {key, value, hlc}.
 */
export function fakePersonalKv() {
    const docs = new Map<string, { value: unknown; hlc: string }>();
    const hooks: { beforeGet?: () => Promise<void> | void; beforeSet?: () => Promise<void> | void } = {};
    const http = {
        async post(path: string, body: { value?: unknown; hlc?: string }) {
            const m = /\/kv\/([^/]+)(\/get)?$/.exec(path)!;
            const key = decodeURIComponent(m[1]);
            if (m[2]) {
                await hooks.beforeGet?.();
                const d = docs.get(key);
                return { key, value: d?.value ?? null, hlc: d?.hlc ?? null };
            }
            await hooks.beforeSet?.();
            const cur = docs.get(key);
            if (cur && body.hlc !== undefined && cur.hlc >= body.hlc) return { ok: true, applied: false };
            docs.set(key, { value: body.value, hlc: body.hlc ?? "" });
            return { ok: true, applied: true };
        },
    };
    return { http, docs, hooks };
}
```

`tests/core/trust/PinStore.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { PinStore, pad16 } from "../../../src/core/trust/PinStore";
import { memoryTrustStore, type TrustStore } from "../../../src/core/trust/trustStore";
import { testSigner, fakePersonalKv } from "./fakes";

const C = "12345";
let kv: ReturnType<typeof fakePersonalKv>;
let store: TrustStore;
let pins: PinStore;

beforeEach(async () => {
    kv = fakePersonalKv();
    store = memoryTrustStore();
    pins = new PinStore({ http: kv.http as never, commitment: () => C, signer: await testSigner(), store: async () => store });
});

describe("PinStore (SpecA §4.2 + CP9 + KI6; design §3.4)", () => {
    it("bootstraps empty, then writes counter 1 with a zero-padded hlc", async () => {
        expect(await pins.get("identity", "bob")).toBeUndefined();
        await pins.pin("identity", { bob: "FP1" });
        const d = kv.docs.get("muhkoo.pins/identity-v1")!;
        expect(d.hlc).toBe(pad16(1));
        expect((d.value as { counter: number }).counter).toBe(1);
        expect(await pins.get("identity", "bob")).toBe("FP1");
    });
    it("a different value for a pinned key is a conflict, never an overwrite", async () => {
        await pins.pin("identity", { bob: "FP1" });
        expect((await pins.pin("identity", { bob: "FP2" })).conflicts).toEqual(["bob"]);
        expect(await pins.get("identity", "bob")).toBe("FP1");
    });
    it("a rollback below the high-water mark is a hard fail", async () => {
        await pins.pin("identity", { a: "1" });
        const old = kv.docs.get("muhkoo.pins/identity-v1")!;
        await pins.pin("identity", { b: "2" });
        kv.docs.set("muhkoo.pins/identity-v1", old);
        await expect(pins.get("identity", "a")).rejects.toMatchObject({ code: "pins-rollback" });
    });
    it("a missing document with a mark is a hard fail (deletion)", async () => {
        await pins.pin("identity", { a: "1" });
        kv.docs.delete("muhkoo.pins/identity-v1");
        await expect(pins.get("identity", "a")).rejects.toMatchObject({ code: "pins-missing" });
    });
    it("a document whose signature fails is refused", async () => {
        await pins.pin("identity", { a: "1" });
        const d = kv.docs.get("muhkoo.pins/identity-v1")!;
        kv.docs.set("muhkoo.pins/identity-v1", { ...d, value: { ...(d.value as object), entries: { a: "9" } } });
        await expect(pins.get("identity", "a")).rejects.toMatchObject({ code: "pins-invalid" });
    });
    it("applied:false re-reads, merges and retries", async () => {
        await pins.pin("identity", { a: "1" });
        const other = new PinStore({ http: kv.http as never, commitment: () => C, signer: (pins as never as { deps: { signer: never } }).deps.signer, store: async () => memoryTrustStore() });
        let raced = false;
        kv.hooks.beforeSet = async () => {
            if (raced) return;
            raced = true;
            await other.pin("identity", { z: "26" });
        };
        await pins.pin("identity", { b: "2" });
        expect(await pins.get("identity", "z")).toBe("26");
        expect(await pins.get("identity", "b")).toBe("2");
    });
    it("a read that lands below the current mark is stale: re-read once, then fail closed (KI6)", async () => {
        await pins.pin("identity", { a: "1" }); // mark = 1
        kv.hooks.beforeGet = async () => { await store.put("pinhw:muhkoo.pins/identity-v1:" + C, 99); };
        await expect(pins.get("identity", "a")).rejects.toMatchObject({ code: "pins-stale" });
    });
});
```

The `applied:false` test reaches into `deps.signer` to share the key. If the implementation names that field differently, pass the same `testSigner()` instance to both stores instead.

`tests/core/trust/trustStore.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import "fake-indexeddb/auto";
import { openTrustStore } from "../../../src/core/trust/trustStore";

describe("muhkoo.trust (KI1)", () => {
    it("persists through IndexedDB when available", async () => {
        const s = await openTrustStore();
        expect(s.persistent).toBe(true);
        await s.put("k", { seq: 3 });
        expect(await s.get("k")).toEqual({ seq: 3 });
    });
    it("falls back to memory when indexedDB is absent", async () => {
        const s = await openTrustStore({ idb: null as never });
        expect(s.persistent).toBe(false);
    });
    it("falls back to memory when open never settles within 2 s", async () => {
        vi.useFakeTimers();
        const never = { open: () => ({}) } as unknown as IDBFactory;
        const p = openTrustStore({ idb: never });
        await vi.advanceTimersByTimeAsync(2000);
        expect((await p).persistent).toBe(false);
        vi.useRealTimers();
    });
});
```

In the "absent" case, `openTrustStore` must treat an explicit `idb: null` as "no IndexedDB". Only `undefined` means "use `globalThis.indexedDB`".

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `yarn test:unit tests/core/trust`
Expected: FAIL, because the modules are missing.

- [ ] **Step 3: Implement `trustStore.ts`**

```ts
/**
 * IndexedDB `muhkoo.trust` (design §6.6): pin high-water marks and per-Space log
 * heads. When IndexedDB is absent, throws on open, or has not opened within 2 s,
 * it is an in-memory store for the life of the Client, and `persistent` is
 * false (KI1).
 */
export interface TrustStore {
    readonly persistent: boolean;
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    del(key: string): Promise<void>;
}

export const TRUST_OPEN_TIMEOUT_MS = 2000;
const DB_NAME = "muhkoo.trust";
const STORE = "kv";

export function memoryTrustStore(): TrustStore {
    const m = new Map<string, unknown>();
    return {
        persistent: false,
        async get<T>(k: string) { return m.get(k) as T | undefined; },
        async put(k, v) { m.set(k, structuredClone(v)); },
        async del(k) { m.delete(k); },
    };
}

export async function openTrustStore(opts: { idb?: IDBFactory | null; timeoutMs?: number } = {}): Promise<TrustStore> {
    const idb = opts.idb === undefined ? (globalThis as { indexedDB?: IDBFactory }).indexedDB : opts.idb;
    if (!idb) return memoryTrustStore();
    const db = await new Promise<IDBDatabase | null>((resolve) => {
        let settled = false;
        const done = (v: IDBDatabase | null) => { if (!settled) { settled = true; resolve(v); } };
        const timer = setTimeout(() => done(null), opts.timeoutMs ?? TRUST_OPEN_TIMEOUT_MS);
        try {
            const req = idb.open(DB_NAME, 1);
            req.onupgradeneeded = () => {
                if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
            };
            req.onsuccess = () => { clearTimeout(timer); done(req.result); };
            req.onerror = () => { clearTimeout(timer); done(null); };
        } catch {
            clearTimeout(timer);
            done(null);
        }
    });
    if (!db) return memoryTrustStore();
    const run = <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
        new Promise((resolve, reject) => {
            const r = fn(db.transaction(STORE, mode).objectStore(STORE));
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => reject(r.error);
        });
    return {
        persistent: true,
        get: <T>(k: string) => run("readonly", (s) => s.get(k)) as Promise<T | undefined>,
        put: async (k, v) => { await run("readwrite", (s) => s.put(v, k)); },
        del: async (k) => { await run("readwrite", (s) => s.delete(k)); },
    };
}
```

- [ ] **Step 4: Implement `PinStore.ts`**

```ts
import { HttpError, type HttpClient } from "../HttpClient";
import { concatBytes, dec, lp, lpStr } from "../../spaces/trust/lp";
import { verifyP256 } from "../../spaces/trust/ik";
import { toBase64Url, utf8Encode } from "../../utilities";
import { SpaceTrustError } from "./errors";
import type { IdentitySigner } from "./IdentitySigner";
import type { TrustStore } from "./trustStore";

export type PinDocName = "identity" | "spaces";

/** Reserved personal-KV keys and signing labels (SpecA §4.2; design §3.4, §6.6a). Frozen formats. */
const DOCS: Record<PinDocName, { key: string; label: string }> = {
    identity: { key: "muhkoo.pins/identity-v1", label: "muhkoo-pinmap-v1" },
    spaces: { key: "muhkoo.pins/spaces-v1", label: "muhkoo-spacepins-v1" },
};

export interface PinDoc {
    v: 1;
    ownerCommitment: string;
    counter: number;
    entries: Record<string, string>;
    sig: string;
}

/** `hlc` for a pin write: dec(counter) zero-padded to 16 digits, because the server compares strings (CP9). */
export const pad16 = (n: number): string => dec(n).padStart(16, "0");

/** LP(label) ‖ LP(ownerCommitment) ‖ LP(dec(counter)) ‖ LP(concat over keys sorted (code units) of LP(k) ‖ LP(v)). */
export function pinDocBytes(label: string, ownerCommitment: string, counter: number, entries: Record<string, string>): Uint8Array {
    const keys = Object.keys(entries).sort();
    return concatBytes(
        lpStr(label),
        lpStr(ownerCommitment),
        lpStr(dec(counter)),
        lp(concatBytes(...keys.map((k) => concatBytes(lpStr(k), lpStr(entries[k]))))),
    );
}

/** The `spaces-v1` key for a Space's genesis pin: "s:" + b64url(SHA-256(utf8(spaceId))). */
export async function spacePinKey(spaceId: string): Promise<string> {
    return "s:" + toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8Encode(spaceId))));
}

export interface PinStoreDeps {
    http: Pick<HttpClient, "post">;
    commitment: () => string | null;
    signer: IdentitySigner;
    store: () => Promise<TrustStore>;
}

export class PinStore {
    constructor(private readonly deps: PinStoreDeps) {}

    private commitment(): string {
        const c = this.deps.commitment();
        if (!c) throw new SpaceTrustError("pins-invalid", "Sign in first.");
        return c;
    }

    private markKey(doc: PinDocName): string {
        return `pinhw:${DOCS[doc].key}:${this.commitment()}`;
    }

    private kvPath(doc: PinDocName, suffix = ""): string {
        return `/api/personal/${encodeURIComponent(this.commitment())}/kv/${encodeURIComponent(DOCS[doc].key)}${suffix}`;
    }

    private async fetchDoc(doc: PinDocName): Promise<PinDoc | null> {
        try {
            const res = await this.deps.http.post<{ value?: PinDoc | null }>(this.kvPath(doc, "/get"), {});
            return res?.value ?? null;
        } catch (e) {
            if (e instanceof HttpError && e.status === 404) return null;
            throw new SpaceTrustError("pins-stale", "Couldn't verify members right now; retrying.");
        }
    }

    private async verify(doc: PinDocName, d: PinDoc): Promise<void> {
        const ok =
            d && d.v === 1 && d.ownerCommitment === this.commitment() &&
            Number.isSafeInteger(d.counter) && d.counter >= 1 &&
            d.entries && typeof d.entries === "object" &&
            Object.values(d.entries).every((v) => typeof v === "string") &&
            (await verifyP256(await this.deps.signer.identityKeyRaw(), d.sig, pinDocBytes(DOCS[doc].label, d.ownerCommitment, d.counter, d.entries)));
        if (!ok) throw new SpaceTrustError("pins-invalid", "Your saved trust records could not be verified.");
    }

    /** The current verified document; an empty bootstrap at counter 0 when none exists and no mark does either. */
    async read(doc: PinDocName): Promise<PinDoc> {
        const store = await this.deps.store();
        for (let attempt = 0; attempt < 2; attempt++) {
            const before = await store.get<number>(this.markKey(doc));
            const d = await this.fetchDoc(doc);
            const now = await store.get<number>(this.markKey(doc));
            if (!d) {
                if (before !== undefined) throw new SpaceTrustError("pins-missing", "Your saved trust records are missing.");
                return { v: 1, ownerCommitment: this.commitment(), counter: 0, entries: {}, sig: "" };
            }
            await this.verify(doc, d);
            if (before !== undefined && d.counter < before) throw new SpaceTrustError("pins-rollback", "Your saved trust records were rolled back.");
            if (now !== undefined && d.counter < now) continue; // stale, not a rollback (KI6): re-read once
            await store.put(this.markKey(doc), Math.max(d.counter, now ?? 0));
            return d;
        }
        throw new SpaceTrustError("pins-stale", "Couldn't verify members right now; retrying.");
    }

    async get(doc: PinDocName, key: string): Promise<string | undefined> {
        return (await this.read(doc)).entries[key];
    }

    /** Pin new keys. A key already pinned to a different value is reported, never overwritten (design §3.4). */
    async pin(doc: PinDocName, entries: Record<string, string>): Promise<{ conflicts: string[] }> {
        return this.mutate(doc, (cur) => {
            const next = { ...cur };
            const conflicts: string[] = [];
            for (const [k, v] of Object.entries(entries)) {
                if (next[k] === undefined) next[k] = v;
                else if (next[k] !== v) conflicts.push(k);
            }
            return { next, conflicts };
        });
    }

    async unpin(doc: PinDocName, keys: string[]): Promise<void> {
        await this.mutate(doc, (cur) => {
            const next = { ...cur };
            for (const k of keys) delete next[k];
            return { next, conflicts: [] };
        });
    }

    /** User-confirmed recovery (design §9.1 "Your saved trust records are missing."): forget the high-water mark. */
    async resetMark(doc: PinDocName): Promise<void> {
        await (await this.deps.store()).del(this.markKey(doc));
    }

    private async mutate(
        doc: PinDocName,
        change: (entries: Record<string, string>) => { next: Record<string, string>; conflicts: string[] },
    ): Promise<{ conflicts: string[] }> {
        const store = await this.deps.store();
        for (let attempt = 0; attempt <= 3; attempt++) {
            const cur = await this.read(doc);
            const { next, conflicts } = change(cur.entries);
            const same = Object.keys(next).length === Object.keys(cur.entries).length &&
                Object.entries(next).every(([k, v]) => cur.entries[k] === v);
            if (same) return { conflicts };
            const counter = cur.counter + 1;
            const c = this.commitment();
            const sig = await this.deps.signer.sign(pinDocBytes(DOCS[doc].label, c, counter, next));
            const value: PinDoc = { v: 1, ownerCommitment: c, counter, entries: next, sig };
            const res = await this.deps.http.post<{ applied?: boolean }>(this.kvPath(doc), { value, hlc: pad16(counter) });
            if (res?.applied === false) continue; // a concurrent writer won: re-read, merge, retry
            await store.put(this.markKey(doc), counter);
            return { conflicts };
        }
        throw new SpaceTrustError("pins-write-failed", "Couldn't save trust records right now.");
    }
}
```

- [ ] **Step 5: Implement `TrustContext.ts`**

```ts
import type { HttpClient } from "../HttpClient";
import type { SessionState } from "../Session";
import { IdentityDirectory } from "./IdentityDirectory";
import { SeedIdentitySigner, type IdentitySigner } from "./IdentitySigner";
import { PinStore, spacePinKey } from "./PinStore";
import { openTrustStore, type TrustStore } from "./trustStore";

/** One per Client: shared by every Space (and, in sub-project 4, DMs). */
export class TrustContext {
    readonly directory: IdentityDirectory;
    readonly signer: IdentitySigner;
    readonly pins: PinStore;
    private storeP: Promise<TrustStore> | null = null;
    private appIdP: Promise<string> | null = null;

    constructor(private readonly deps: { http: HttpClient; session: SessionState; openStore?: () => Promise<TrustStore> }) {
        this.directory = new IdentityDirectory(deps.http);
        this.signer = new SeedIdentitySigner({ session: deps.session, directory: this.directory });
        this.pins = new PinStore({
            http: deps.http,
            commitment: () => deps.session.commitment,
            signer: this.signer,
            store: () => this.store(),
        });
    }

    store(): Promise<TrustStore> {
        return (this.storeP ??= (this.deps.openStore ?? openTrustStore)());
    }

    /** This app's id, from GET /api/app/trust (a genesis must name it, D4). Cached; a failure is retried next call. */
    appId(): Promise<string> {
        return (this.appIdP ??= this.deps.http
            .get<{ appId?: string }>("/api/app/trust")
            .then((r) => {
                if (!r?.appId) throw new Error("app trust: no appId");
                return r.appId;
            })
            .catch((e) => {
                this.appIdP = null;
                throw e;
            }));
    }

    /** User-confirmed "Reset trust for this space" (design §9.1): drop its genesis pin and log high-water. */
    async resetSpaceTrust(spaceId: string): Promise<void> {
        await this.pins.unpin("spaces", [await spacePinKey(spaceId)]);
        await (await this.store()).del(`loghw:${this.deps.session.commitment}:${spaceId}`);
    }

    /** `client.trust.unpin(username)`: forget a member's pinned identity after comparing safety numbers (design §3.4). */
    async unpinUser(username: string): Promise<void> {
        await this.pins.unpin("identity", [username.toLowerCase()]);
    }
}
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `yarn test:unit tests/core/trust`
Expected: PASS.

- [ ] **Step 7: Checkpoint**

Run: `yarn typecheck && yarn lint && yarn test:unit`
Expected: green.

---

### Task 7: Chat-key certificate on every join request

**Files:**
- Create: `src/spaces/trust/chatCert.ts`
- Modify: `src/spaces/types.ts` (`JoinRequest.keyCert?`), `src/spaces/SpaceKeyring.ts` (`keyCert` dep; `requestKey`), `src/core/namespaces/SpaceNamespace.ts` (`trust?` dep; memoised cert provider in `build`)
- Test: `tests/spaces/trust/chatCert.test.ts` (new)

**Interfaces:**
- Consumes: Task 4's `certBytes` and `verifyP256`; Task 5's `IdentitySigner`; Task 6's `TrustContext`.
- Produces:
  - `mintKeyCert(signer, memberId, ecdh, ecdsa): Promise<ChatKeyCert>`;
  - `verifyKeyCert(memberId, cert, ecdh, ecdsa): Promise<boolean>`;
  - `SpaceKeyringDeps.keyCert?: () => Promise<ChatKeyCert | undefined>`;
  - `SpaceNamespaceDeps.trust?: TrustContext`.

- [ ] **Step 1: Write the failing tests**

`tests/spaces/trust/chatCert.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { mintKeyCert, verifyKeyCert } from "../../../src/spaces/trust/chatCert";
import { SpaceKeyring } from "../../../src/spaces/SpaceKeyring";
import { testSigner } from "../../core/trust/fakes";

const fx = JSON.parse(readFileSync(new URL("../../fixtures/mlog-v1.json", import.meta.url), "utf8"));

describe("ChatKeyCert (design §3.2, §6.10)", () => {
    it("the fixture certificate verifies for 'Bob' (member id lower-cased in the bytes)", async () => {
        const c = fx.keyCert.cert;
        expect(await verifyKeyCert("Bob", c, c.ecdh, c.ecdsa)).toBe(true);
    });
    it("round trip; wrong username, swapped ecdh string and a different ecdsa string all fail", async () => {
        const s = await testSigner();
        const c = await mintKeyCert(s, "alice", "ECDH-JWK-B64URL", "ECDSA-JWK-B64URL");
        expect(await verifyKeyCert("alice", c, "ECDH-JWK-B64URL", "ECDSA-JWK-B64URL")).toBe(true);
        expect(await verifyKeyCert("bob", c, "ECDH-JWK-B64URL", "ECDSA-JWK-B64URL")).toBe(false);
        expect(await verifyKeyCert("alice", c, "OTHER", "ECDSA-JWK-B64URL")).toBe(false);
        expect(await verifyKeyCert("alice", c, "ECDH-JWK-B64URL", "OTHER")).toBe(false);
    });
    it("requestKey posts the certificate over the exact strings it publishes", async () => {
        const posted: unknown[] = [];
        const s = await testSigner();
        const ecdh = "eyJlY2RoIjoxfQ", ecdsa = "eyJlY2RzYSI6MX0";
        const kr = new SpaceKeyring({
            spaceId: "sp", memberId: "alice", identityEcdhPub: ecdh, identityEcdsaPub: ecdsa,
            ownPrivateKey: () => null,
            transport: { postJoinRequest: async (r: unknown) => { posted.push(r); } } as never,
            keyCert: () => mintKeyCert(s, "alice", ecdh, ecdsa),
        });
        await kr.requestKey();
        const req = posted[0] as { keyCert: { ecdh: string; ecdsa: string } };
        expect(req.keyCert.ecdh).toBe(ecdh);
        expect(req.keyCert.ecdsa).toBe(ecdsa);
    });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `yarn test:unit tests/spaces/trust/chatCert.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/spaces/trust/chatCert.ts`:
```ts
import { certBytes } from "./canonical";
import { verifyP256 } from "./ik";
import type { ChatKeyCert } from "./types";

/** The signer surface a cert needs (satisfied by IdentitySigner); kept local so spaces/ never imports core/. */
export interface CertSigner {
    sign(bytes: Uint8Array): Promise<string>;
    identityKeyRaw(): Promise<string>;
}

/**
 * A certificate by the account IK over the member's P-384 chat keys (design §3.2).
 * `ecdh`/`ecdsa` must be the EXACT strings posted as identityEcdhPub/identityEcdsaPub.
 * Minted in memory, never stored client-side.
 */
export async function mintKeyCert(signer: CertSigner, memberId: string, ecdh: string, ecdsa: string): Promise<ChatKeyCert> {
    const ik = await signer.identityKeyRaw();
    const sig = await signer.sign(certBytes(memberId, { ik, ecdh, ecdsa }));
    return { v: 1, ik, ecdh, ecdsa, sig };
}

export async function verifyKeyCert(memberId: string, cert: ChatKeyCert, ecdh: string, ecdsa: string): Promise<boolean> {
    if (!cert || cert.v !== 1 || cert.ecdh !== ecdh || cert.ecdsa !== ecdsa) return false;
    return verifyP256(cert.ik, cert.sig, certBytes(memberId, cert));
}
```

In `src/spaces/types.ts`, add to `JoinRequest`: `keyCert?: import("./trust/types").ChatKeyCert;`. Use a top-level `import type` if the file's style prefers it.

In `src/spaces/SpaceKeyring.ts`:
- add to `SpaceKeyringDeps`:
  ```ts
  /** Mints the IK certificate for this member's chat keys (design §3.2). Absent, or resolving undefined, means none. */
  keyCert?: () => Promise<ChatKeyCert | undefined>;
  ```
- in `requestKey`:
  ```ts
      async requestKey(desiredEpoch?: number): Promise<void> {
          let keyCert: ChatKeyCert | undefined;
          try {
              keyCert = this.deps.keyCert ? await this.deps.keyCert() : undefined;
          } catch {
              keyCert = undefined; // step I never requires a certificate; the join still goes out (server brief §3)
          }
          await this.deps.transport.postJoinRequest({
              memberId: this.deps.memberId,
              identityEcdhPub: this.deps.identityEcdhPub,
              identityEcdsaPub: this.deps.identityEcdsaPub,
              desiredEpoch,
              ...(keyCert ? { keyCert } : {}),
          });
      }
  ```

In `src/core/namespaces/SpaceNamespace.ts`:
- add `trust?: TrustContext` to the deps interface and a field `private readonly certs = new Map<string, Promise<ChatKeyCert>>();`;
- in `build()` (the unlocked path), pass this to `new SpaceKeyring({...})`:

```ts
            keyCert: this.deps.trust ? () => this.certFor(memberId, ecdhPub, ecdsaPub) : undefined,
```

and add:

```ts
    /** One certificate per (member, chat keys) for the life of the Client (design §3.2: global, not per Space). */
    private certFor(memberId: string, ecdh: string, ecdsa: string): Promise<ChatKeyCert> {
        const k = `${memberId}\n${ecdh}\n${ecdsa}`;
        let p = this.certs.get(k);
        if (!p) {
            p = mintKeyCert(this.deps.trust!.signer, memberId, ecdh, ecdsa);
            p.catch(() => this.certs.delete(k));
            this.certs.set(k, p);
        }
        return p;
    }
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `yarn test:unit tests/spaces/trust/chatCert.test.ts`
Expected: PASS (3).

- [ ] **Step 5: Checkpoint**

Run: `yarn typecheck && yarn lint && yarn test:unit`
Expected: green.

---
## Part C: the membership log in Spaces (connect)

### Task 8: `MembershipLog`, the private-log verifier

**Files:**
- Create: `src/spaces/trust/MembershipLog.ts`
- Test: `tests/spaces/trust/chainHelper.ts` (used by Tasks 8–11), `tests/spaces/trust/MembershipLog.test.ts`

**Interfaces:**
- Consumes: Task 4's `entryBytes`, `entryHash`, `verifyP256`, `ikEquals`, `decodeRawP256` and types.
- Produces:
  - `type Role = "owner" | "editor" | "viewer"`;
  - `interface LogMember { id: string; ik: string; role: Role; since: number }`;
  - `class MembershipLog`, constructed as `({spaceId, appId})`, with:
    - `apply(entries): Promise<{ok: true} | {ok: false; integrity: string}>`;
    - `member(id): LogMember | undefined` and `isMember(id)`;
    - getters `owner`, `head`, `members` (`LogMember[]`), `lastHumanRemovalSeq`, `invalid`, `unsupported`, and `hashAt(seq)`.

**The rules** mirror the server's `authorizeEntry` for private Spaces, using design §3.5 and server brief §2.8:
- An entry that chains but fails its rule, its signature or its signer binding is a **no-op**: the head advances and state is unchanged (SEC4).
- A broken chain (`seq`, `prev` or `spaceId`), a bad genesis, or a genesis for another app is **integrity**, and applying stops.

- [ ] **Step 1: Write the chain helper and failing tests**

`tests/spaces/trust/chainHelper.ts`:
```ts
import { entryBytes, entryHash } from "../../../src/spaces/trust/canonical";
import type { MembershipEntry } from "../../../src/spaces/trust/types";
import { toBase64 } from "../../../src/utilities";

export interface TestUser { name: string; ik: string; kp: CryptoKeyPair }

export async function user(name: string): Promise<TestUser> {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    return { name, kp, ik: toBase64(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey))) };
}

/** Builds a correctly chained, correctly signed log; `signAs` lets a test sign with the wrong key. */
export class Chain {
    readonly entries: MembershipEntry[] = [];
    private lastHash = "";
    constructor(readonly spaceId: string) {}
    async push(u: TestUser, op: MembershipEntry["op"], body: Record<string, unknown>, opts: { signAs?: TestUser; ik?: string } = {}): Promise<MembershipEntry> {
        const unsigned = {
            v: 1 as const, spaceId: this.spaceId, seq: this.entries.length, prev: this.lastHash,
            op, by: u.name, ik: opts.ik ?? u.ik, at: 1_790_000_000_000 + this.entries.length, body,
        };
        const signer = opts.signAs ?? u;
        const sig = toBase64(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signer.kp.privateKey, entryBytes(unsigned as never))));
        const entry = { ...unsigned, sig } as MembershipEntry;
        this.entries.push(entry);
        this.lastHash = await entryHash(unsigned as never);
        return entry;
    }
    genesis(owner: TestUser, appId = "app1") {
        return this.push(owner, "genesis", { visibility: "private", policy: "static", appId, baseEpoch: -1, legacyCommits: {} });
    }
}
```

`tests/spaces/trust/MembershipLog.test.ts`:
```ts
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { MembershipLog } from "../../../src/spaces/trust/MembershipLog";
import { Chain, user, type TestUser } from "./chainHelper";

let alice: TestUser, bob: TestUser, carol: TestUser, dave: TestUser;
beforeAll(async () => { [alice, bob, carol, dave] = await Promise.all(["alice", "bob", "carol", "dave"].map(user)); });

const fresh = () => new MembershipLog({ spaceId: "sp1", appId: "app1" });
const roles = (l: MembershipLog) => Object.fromEntries(l.members.map((m) => [m.id, m.role]));

describe("MembershipLog: private rules (design §3.5; server authorizeEntry)", () => {
    it("owner adds an editor; the editor adds a viewer", async () => {
        const c = new Chain("sp1");
        await c.genesis(alice);
        await c.push(alice, "add", { member: "bob", memberIk: bob.ik, role: "editor" });
        await c.push(bob, "add", { member: "carol", memberIk: carol.ik, role: "viewer" });
        const l = fresh();
        expect(await l.apply(c.entries)).toEqual({ ok: true });
        expect(roles(l)).toEqual({ alice: "owner", bob: "editor", carol: "viewer" });
        expect(l.member("bob")!.ik).toBe(bob.ik);
    });
    it("editors add viewers only; viewers add no one (no-ops, the chain continues)", async () => {
        const c = new Chain("sp1");
        await c.genesis(alice);
        await c.push(alice, "add", { member: "bob", memberIk: bob.ik, role: "editor" });
        await c.push(alice, "add", { member: "carol", memberIk: carol.ik, role: "viewer" });
        await c.push(bob, "add", { member: "dave", memberIk: dave.ik, role: "editor" }); // editor-role
        await c.push(carol, "add", { member: "dave", memberIk: dave.ik, role: "viewer" }); // not-owner
        const l = fresh();
        await l.apply(c.entries);
        expect(l.isMember("dave")).toBe(false);
        expect(l.invalid.map((i) => i.reason)).toEqual(["editor-role", "not-owner"]);
        expect(l.head!.seq).toBe(4);
    });
    it("a demoted editor cannot add", async () => {
        const c = new Chain("sp1");
        await c.genesis(alice);
        await c.push(alice, "add", { member: "bob", memberIk: bob.ik, role: "editor" });
        await c.push(alice, "role", { member: "bob", role: "viewer" });
        await c.push(bob, "add", { member: "carol", memberIk: carol.ik, role: "viewer" });
        const l = fresh();
        await l.apply(c.entries);
        expect(l.isMember("carol")).toBe(false);
    });
    it("remove rules: an editor cannot remove an editor; the owner can; removal is recorded", async () => {
        const c = new Chain("sp1");
        await c.genesis(alice);
        await c.push(alice, "add", { member: "bob", memberIk: bob.ik, role: "editor" });
        await c.push(alice, "add", { member: "carol", memberIk: carol.ik, role: "editor" });
        await c.push(bob, "remove", { member: "carol" }); // target-editor
        await c.push(alice, "remove", { member: "carol" });
        const l = fresh();
        await l.apply(c.entries);
        expect(l.isMember("carol")).toBe(false);
        expect(l.invalid.map((i) => i.reason)).toEqual(["target-editor"]);
        expect(l.lastHumanRemovalSeq).toBe(4);
    });
    it("the owner cannot leave; a member can", async () => {
        const c = new Chain("sp1");
        await c.genesis(alice);
        await c.push(alice, "add", { member: "bob", memberIk: bob.ik, role: "viewer" });
        await c.push(alice, "leave", {});
        await c.push(bob, "leave", {});
        const l = fresh();
        await l.apply(c.entries);
        expect(roles(l)).toEqual({ alice: "owner" });
        expect(l.invalid.map((i) => i.reason)).toEqual(["owner-leave"]);
    });
    it("a member signing with an IK other than the one it was added with is a no-op", async () => {
        const c = new Chain("sp1");
        await c.genesis(alice);
        await c.push(alice, "add", { member: "bob", memberIk: bob.ik, role: "editor" });
        await c.push(bob, "add", { member: "carol", memberIk: carol.ik, role: "viewer" }, { signAs: dave, ik: dave.ik });
        const l = fresh();
        await l.apply(c.entries);
        expect(l.isMember("carol")).toBe(false);
        expect(l.invalid[0].reason).toBe("identity-bound");
    });
    it("a bad signature is a no-op", async () => {
        const c = new Chain("sp1");
        await c.genesis(alice);
        await c.push(alice, "add", { member: "bob", memberIk: bob.ik, role: "viewer" }, { signAs: dave });
        const l = fresh();
        await l.apply(c.entries);
        expect(l.isMember("bob")).toBe(false);
        expect(l.invalid[0].reason).toBe("bad-signature");
    });
    it("a broken chain is integrity", async () => {
        const c = new Chain("sp1");
        await c.genesis(alice);
        const e = await c.push(alice, "add", { member: "bob", memberIk: bob.ik, role: "viewer" });
        const l = fresh();
        expect(await l.apply([c.entries[0], { ...e, prev: "AAAA" }])).toEqual({ ok: false, integrity: "chain" });
    });
    it("a genesis for another app is integrity", async () => {
        const c = new Chain("sp1");
        await c.genesis(alice, "someone-elses-app");
        expect(await fresh().apply(c.entries)).toEqual({ ok: false, integrity: "wrong-app" });
    });
    it("ops outside the slice advance the chain and change nothing (slice ruling S11)", async () => {
        const c = new Chain("sp1");
        await c.genesis(alice);
        await c.push(alice, "svc", { member: "__agent__:x", action: "add", ecdhPub: "e", ecdsaPub: "s", mode: "addressed", rosterSeq: 1 });
        const l = fresh();
        await l.apply(c.entries);
        expect(l.head!.seq).toBe(1);
        expect(l.invalid[0].reason).toBe("unsupported-op");
    });
    it("the accelerator fixture's private chain applies, and its head hash matches", async () => {
        const fx = JSON.parse(readFileSync(new URL("../../fixtures/mlog-v1.json", import.meta.url), "utf8"));
        const l = new MembershipLog({ spaceId: fx.chains.private.spaceId, appId: "app_fixture01" });
        const entries = fx.chains.private.entries.map((r: { entry: unknown }) => r.entry);
        expect(await l.apply(entries)).toEqual({ ok: true });
        expect(l.head!.hash).toBe(fx.chains.private.entries.at(-1).hash);
    });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `yarn test:unit tests/spaces/trust/MembershipLog.test.ts`
Expected: FAIL, because the module is missing.

- [ ] **Step 3: Implement**

`src/spaces/trust/MembershipLog.ts`:
```ts
import { entryBytes, entryHash } from "./canonical";
import { decodeRawP256, ikEquals, verifyP256 } from "./ik";
import type { MembershipEntry } from "./types";

export type Role = "owner" | "editor" | "viewer";
export interface LogMember { id: string; ik: string; role: Role; since: number }
export type ApplyResult = { ok: true } | { ok: false; integrity: string };

/** Ids the platform reserves; never a member (server brief §2.8). */
const RESERVED = /^(__keeper__$|__log__(:|$)|__agent__:|__fn__:|__link__:|__machine__:)/;
/** Ops this slice does not interpret (slice ruling S11; links are A0a). */
const UNSUPPORTED = new Set(["join", "link", "unlink", "redeem", "svc", "retire"]);

/**
 * A verified private membership log (design §3.5–§3.7). Pure: it fetches nothing.
 * An entry that chains correctly but fails its rule, signature or signer
 * binding is a no-op (SEC4). A chain break, a bad genesis, or a genesis for
 * another app is integrity, and nothing after it is applied.
 */
export class MembershipLog {
    private readonly byId = new Map<string, LogMember>();
    private readonly hashes = new Map<number, string>();
    private readonly invalidList: Array<{ seq: number; reason: string }> = [];
    private ownerId: string | null = null;
    private headVal: { seq: number; hash: string } | null = null;
    private humanRemovalSeq = -1;
    private publicLog = false;

    constructor(private readonly opts: { spaceId: string; appId: string }) {}

    get owner(): string | null { return this.ownerId; }
    get head(): { seq: number; hash: string } | null { return this.headVal; }
    get members(): LogMember[] { return [...this.byId.values()]; }
    get lastHumanRemovalSeq(): number { return this.humanRemovalSeq; }
    get invalid(): ReadonlyArray<{ seq: number; reason: string }> { return this.invalidList; }
    /** A public log: this slice treats the Space as unlogged (public genesis is A0a). */
    get unsupported(): boolean { return this.publicLog; }
    member(id: string): LogMember | undefined { return this.byId.get(id); }
    isMember(id: string): boolean { return this.byId.has(id); }
    hashAt(seq: number): string | undefined { return this.hashes.get(seq); }

    async apply(entries: MembershipEntry[]): Promise<ApplyResult> {
        for (const e of entries) {
            const expectSeq = (this.headVal?.seq ?? -1) + 1;
            if (e.seq !== expectSeq || e.prev !== (this.headVal?.hash ?? "") || e.spaceId !== this.opts.spaceId) {
                return { ok: false, integrity: "chain" };
            }
            const { sig, lsig: _lsig, ...unsigned } = e as MembershipEntry & { lsig?: string };
            const hash = await entryHash(unsigned as never);
            if (e.seq === 0) {
                const bad = await this.checkGenesis(e, sig);
                if (bad) return { ok: false, integrity: bad };
            } else {
                const reason = await this.check(e, sig);
                if (reason) this.invalidList.push({ seq: e.seq, reason });
                else this.mutate(e);
            }
            this.headVal = { seq: e.seq, hash };
            this.hashes.set(e.seq, hash);
        }
        return { ok: true };
    }

    private async checkGenesis(e: MembershipEntry, sig: string): Promise<string | null> {
        if (e.op !== "genesis") return "chain";
        const b = e.body as { visibility?: string; appId?: string };
        if (!(await verifyP256(e.ik, sig, entryBytes(e as never)))) return "genesis";
        if (b.appId !== this.opts.appId) return "wrong-app";
        if (b.visibility !== "private") { this.publicLog = true; return null; }
        this.ownerId = e.by;
        this.byId.set(e.by, { id: e.by, ik: e.ik, role: "owner", since: 0 });
        return null;
    }

    private async check(e: MembershipEntry, sig: string): Promise<string | null> {
        if (this.publicLog) return "unsupported-op";
        if (e.op === "genesis") return "genesis-seq";
        if (UNSUPPORTED.has(e.op)) return "unsupported-op";
        const signer = this.byId.get(e.by);
        if (!signer) return "not-member";
        if (!ikEquals(signer.ik, e.ik)) return "identity-bound";
        if (!(await verifyP256(e.ik, sig, entryBytes(e as never)))) return "bad-signature";
        const b = e.body as { member?: string; memberIk?: string; role?: Role };
        switch (e.op) {
            case "add": {
                if (signer.role === "viewer") return "not-owner";
                if (signer.role === "editor" && b.role !== "viewer") return "editor-role";
                if (!b.member || RESERVED.test(b.member)) return "target-reserved";
                if (this.byId.has(b.member)) return "target-member";
                if (!decodeRawP256(b.memberIk)) return "bad-member-ik";
                if (b.role !== "viewer" && b.role !== "editor") return "malformed";
                return null;
            }
            case "role": {
                if (signer.role !== "owner") return "not-owner";
                if (!b.member || RESERVED.test(b.member)) return "target-reserved";
                if (b.member === this.ownerId) return "target-owner";
                if (!this.byId.has(b.member)) return "target-not-member";
                if (b.role !== "viewer" && b.role !== "editor") return "malformed";
                return null;
            }
            case "remove": {
                if (signer.role === "viewer") return "not-owner";
                if (!b.member || RESERVED.test(b.member)) return "target-reserved";
                if (b.member === this.ownerId) return "target-owner";
                const target = this.byId.get(b.member);
                if (!target) return "target-not-member";
                if (signer.role === "editor" && target.role === "editor") return "target-editor";
                return null;
            }
            case "leave":
                return e.by === this.ownerId ? "owner-leave" : null;
            default:
                return "unsupported-op";
        }
    }

    private mutate(e: MembershipEntry): void {
        const b = e.body as { member: string; memberIk: string; role: Role };
        switch (e.op) {
            case "add":
                this.byId.set(b.member, { id: b.member, ik: b.memberIk, role: b.role, since: e.seq });
                return;
            case "role":
                this.byId.get(b.member)!.role = b.role;
                return;
            case "remove":
                this.byId.delete(b.member);
                this.humanRemovalSeq = e.seq;
                return;
            case "leave":
                this.byId.delete(e.by);
                this.humanRemovalSeq = e.seq;
                return;
        }
    }
}
```

`entryBytes(e as never)` passes the signed entry. If the ported `entryBytes` reads only the unsigned fields (it does in the accelerator: it never touches `sig`), that is correct; if its type insists on `UnsignedEntry`, pass `unsigned`.

The fixture's private chain applies with `{ok: true}` because its `link`, `redeem`, `unlink`, `svc` and `retire` entries are unsupported no-ops, and its `remove` of carol is `target-not-member` (carol entered through `redeem`). If the fixture test reports a different result, report what it showed. Do not change the fixture.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `yarn test:unit tests/spaces/trust/MembershipLog.test.ts`
Expected: PASS (11).

- [ ] **Step 5: Checkpoint**

Run: `yarn typecheck && yarn lint && yarn test:unit`
Expected: green.

---

### Task 9: Log transport and `LogSync`: fetch, verify, append, high-water mark, genesis trust, pins

**Files:**
- Modify: `src/spaces/KeyringClient.ts` (`KeyringHttpError`, `fetchLog`, `postLogEntry`, `probeState`), `src/spaces/SpaceKeyring.ts` (`KeyringTransport` optional methods)
- Create: `src/spaces/trust/LogSync.ts`
- Test: `tests/spaces/trust/fakeLogServer.ts`, `tests/spaces/trust/LogSync.test.ts`

**Interfaces:**
- Consumes:
  - Task 8's `MembershipLog`;
  - Task 6's `PinStore` (`spacePinKey`) and `TrustStore`;
  - Task 5's `IdentityDirectory` and `IdentitySigner`;
  - Task 4's `entryBytes`, `entryHash`, `fingerprint` and `ikEquals`.
- Produces:
  - `class KeyringHttpError extends Error { status: number; body: Record<string, unknown> | null }`;
  - `KeyringClient.fetchLog(since?, limit?)`, `postLogEntry(entry, ec?)` and `probeState(): Promise<number | "network">`;
  - optional `KeyringTransport` members with the same signatures;
  - `class LogSync`, constructed as `(deps: LogSyncDeps)`, with:
    - getters `logEnabled`, `integrity`, `signer` and `directory`;
    - `member(id)`, `isMember(id)` and `members(): MemberView[]`;
    - `sync()`, `scheduleSync()`, `append(op, body, ec?)` and `onChange(h)`;
  - `interface MemberView { id: string; role: Role; ik: string; fingerprint: string; identityChanged: boolean }`.

- [ ] **Step 1: Write the fake server and failing tests**

`tests/spaces/trust/fakeLogServer.ts`:
```ts
import { KeyringHttpError } from "../../../src/spaces/KeyringClient";
import { entryHash } from "../../../src/spaces/trust/canonical";
import type { EpochCommit, MembershipEntry } from "../../../src/spaces/trust/types";

/** In-memory /keyring/log: CAS on seq/prev, paging and a scriptable conflict. No authority checks: the client's own rules are under test. */
export class FakeLogServer {
    entries: MembershipEntry[] = [];
    commits: EpochCommit[] = [];
    head: { seq: number; hash: string } | null = null;
    pageLimit = 500;
    gets = 0;
    beforePost: (() => Promise<void>) | null = null;
    status: number | null = null; // force an HTTP status on GET

    async fetchLog(since = -1, limit = 500) {
        this.gets++;
        if (this.status) throw new KeyringHttpError(this.status, { error: "forced" }, "GET /keyring/log");
        const page = this.entries.filter((e) => e.seq > since).slice(0, Math.min(limit, this.pageLimit));
        return { entries: page, head: this.head };
    }

    async postLogEntry(entry: MembershipEntry, ec?: EpochCommit) {
        await this.beforePost?.();
        const expSeq = (this.head?.seq ?? -1) + 1;
        if (entry.seq !== expSeq || entry.prev !== (this.head?.hash ?? "")) {
            throw new KeyringHttpError(409, { error: "Log moved", head: this.head }, "POST /keyring/log");
        }
        const { sig: _s, ...u } = entry;
        this.entries.push(entry);
        if (ec) this.commits.push(ec);
        this.head = { seq: entry.seq, hash: await entryHash(u as never) };
        return { ok: true as const, head: this.head };
    }

    /** Server-side rollback or fork, for integrity tests. */
    truncate(toSeq: number) {
        this.entries = this.entries.filter((e) => e.seq <= toSeq);
        this.head = toSeq < 0 ? null : { seq: toSeq, hash: "" };
    }
}
```

After `truncate`, reset `head.hash` with `entryHash` of the new last entry. The helper is the place to do it, so make `truncate` async and compute the hash there.

`tests/spaces/trust/LogSync.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { LogSync } from "../../../src/spaces/trust/LogSync";
import { PinStore, spacePinKey } from "../../../src/core/trust/PinStore";
import { memoryTrustStore, type TrustStore } from "../../../src/core/trust/trustStore";
import { FakeLogServer } from "./fakeLogServer";
import { Chain, user, type TestUser } from "./chainHelper";
import { fakePersonalKv } from "../../core/trust/fakes";
import { toBase64 } from "../../../src/utilities";

const SPACE = "sp1";
let alice: TestUser, bob: TestUser;
let server: FakeLogServer;
let store: TrustStore;
let directory: Record<string, string>;

function signerFor(u: TestUser) {
    return {
        identityKeyRaw: async () => u.ik,
        sign: async (b: Uint8Array) => toBase64(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, u.kp.privateKey, b))),
    };
}

function syncFor(u: TestUser) {
    const signer = signerFor(u);
    const kv = fakePersonalKv();
    const pins = new PinStore({ http: kv.http as never, commitment: () => `c-${u.name}`, signer, store: async () => store });
    return new LogSync({
        spaceId: SPACE,
        me: () => u.name,
        appId: async () => "app1",
        commitment: () => `c-${u.name}`,
        transport: server,
        signer,
        directory: { lookup: async (n: string) => directory[n.toLowerCase()] } as never,
        pins,
        store: async () => store,
    });
}

beforeEach(async () => {
    [alice, bob] = await Promise.all([user("alice"), user("bob")]);
    server = new FakeLogServer();
    store = memoryTrustStore();
    directory = { alice: alice.ik, bob: bob.ik };
});

describe("LogSync (design §3.6–§3.7; slice rulings S7, S10)", () => {
    it("a Space without a log is unlogged", async () => {
        const s = syncFor(alice);
        await s.sync();
        expect(s.logEnabled).toBe(false);
    });
    it("pages through the log", async () => {
        const c = new Chain(SPACE);
        await c.genesis(alice);
        for (let i = 0; i < 4; i++) await c.push(alice, "add", { member: `m${i}`, memberIk: bob.ik, role: "viewer" });
        for (const e of c.entries) await server.postLogEntry(e);
        server.pageLimit = 2;
        server.gets = 0;
        const s = syncFor(alice);
        await s.sync();
        expect(server.gets).toBe(3);
        expect(s.members().map((m) => m.id).sort()).toEqual(["alice", "m0", "m1", "m2", "m3"]);
    });
    it("appends the genesis, then adds with the right prev", async () => {
        const s = syncFor(alice);
        await s.append("genesis", { visibility: "private", policy: "static", appId: "app1", baseEpoch: -1, legacyCommits: {} });
        await s.append("add", { member: "bob", memberIk: bob.ik, role: "viewer" });
        expect(server.entries.map((e) => [e.seq, e.op])).toEqual([[0, "genesis"], [1, "add"]]);
        expect(s.isMember("bob")).toBe(true);
    });
    it("409 Log moved: re-sync, re-sign against the new head, succeed without duplicates (Review Focus 3)", async () => {
        const s = syncFor(alice);
        await s.append("genesis", { visibility: "private", policy: "static", appId: "app1", baseEpoch: -1, legacyCommits: {} });
        const other = syncFor(alice);
        let raced = false;
        server.beforePost = async () => {
            if (raced) return;
            raced = true;
            server.beforePost = null;
            await other.append("add", { member: "carol", memberIk: bob.ik, role: "viewer" });
        };
        await s.append("add", { member: "bob", memberIk: bob.ik, role: "viewer" });
        expect(server.entries.map((e) => e.body && (e.body as { member?: string }).member)).toEqual([undefined, "carol", "bob"]);
    });
    it("four 409s in a row → log-conflict", async () => {
        const s = syncFor(alice);
        await s.append("genesis", { visibility: "private", policy: "static", appId: "app1", baseEpoch: -1, legacyCommits: {} });
        server.postLogEntry = async () => { throw new (await import("../../../src/spaces/KeyringClient")).KeyringHttpError(409, { error: "Log moved", head: null }, "POST"); };
        await expect(s.append("add", { member: "bob", memberIk: bob.ik, role: "viewer" })).rejects.toMatchObject({ code: "log-conflict" });
    });
    it("a head below the high-water mark is integrity (rollback)", async () => {
        const s = syncFor(alice);
        await s.append("genesis", { visibility: "private", policy: "static", appId: "app1", baseEpoch: -1, legacyCommits: {} });
        await s.append("add", { member: "bob", memberIk: bob.ik, role: "viewer" });
        await server.truncate(0);
        const again = syncFor(alice);
        await again.sync();
        expect(again.integrity).toEqual({ broken: true, reason: "rollback" });
    });
    it("a genesis that differs from the pinned one is integrity", async () => {
        const s = syncFor(alice);
        await s.append("genesis", { visibility: "private", policy: "static", appId: "app1", baseEpoch: -1, legacyCommits: {} });
        await (s as unknown as { deps: { pins: PinStore } }).deps.pins.unpin("spaces", [await spacePinKey(SPACE)]);
        await (s as unknown as { deps: { pins: PinStore } }).deps.pins.pin("spaces", { [await spacePinKey(SPACE)]: "not-this-genesis" });
        await store.del(`loghw:c-alice:${SPACE}`);
        await s.sync();
        expect(s.integrity).toEqual({ broken: true, reason: "genesis-pin" });
    });
    it("TOFU: the genesis owner's IK must match the directory", async () => {
        const c = new Chain(SPACE);
        await c.genesis(alice);
        await server.postLogEntry(c.entries[0]);
        directory.alice = bob.ik; // a server-substituted directory answer
        const s = syncFor(bob);
        await s.sync();
        expect(s.integrity).toEqual({ broken: true, reason: "owner-identity" });
    });
    it("an add naming an IK that differs from an existing pin flags identityChanged", async () => {
        const s = syncFor(alice);
        await s.append("genesis", { visibility: "private", policy: "static", appId: "app1", baseEpoch: -1, legacyCommits: {} });
        await (s as unknown as { deps: { pins: PinStore } }).deps.pins.pin("identity", { bob: "an-older-fingerprint" });
        await s.append("add", { member: "bob", memberIk: bob.ik, role: "viewer" });
        expect(s.members().find((m) => m.id === "bob")!.identityChanged).toBe(true);
    });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `yarn test:unit tests/spaces/trust/LogSync.test.ts`
Expected: FAIL, because the modules are missing.

- [ ] **Step 3: `KeyringClient` additions**

In `src/spaces/KeyringClient.ts`:
```ts
/** A keyring route answered non-2xx; status and JSON body preserved (the existing methods keep their plain Errors). */
export class KeyringHttpError extends Error {
    constructor(readonly status: number, readonly body: Record<string, unknown> | null, route: string) {
        super(`KeyringClient ${route}: ${status}${body && typeof body.error === "string" ? ` ${body.error}` : ""}`);
        this.name = "KeyringHttpError";
    }
}
```

Add to the class:
```ts
    private async request<T>(method: "GET" | "POST", suffix: string, body?: unknown): Promise<T> {
        const res = await this.deps.fetch(
            this.url(suffix),
            method === "POST"
                ? { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
                : undefined,
        );
        const text = await res.text();
        let json: Record<string, unknown> | null = null;
        try { json = text ? (JSON.parse(text) as Record<string, unknown>) : null; } catch { json = null; }
        if (!res.ok) throw new KeyringHttpError(res.status, json, `${method} ${suffix.split("?")[0]}`);
        return json as T;
    }

    /** GET /keyring/log (design §3.6): entries with seq > since, ascending, ≤ limit; head null = no log. */
    async fetchLog(since = -1, limit = 500): Promise<{ entries: MembershipEntry[]; head: MlogHead | null }> {
        return this.request("GET", `/keyring/log?since=${since}&limit=${limit}`);
    }

    /** POST /keyring/log {entry, ec?} → {ok, head}; `409 {error:"Log moved", head}` (no code) on a compare-and-set miss. */
    async postLogEntry(entry: MembershipEntry, ec?: EpochCommit): Promise<{ ok: true; head: MlogHead }> {
        return this.request("POST", "/keyring/log", ec ? { entry, ec } : { entry });
    }

    /** Status of GET /keyring/state, or "network" (slice ruling S6: 403 not-member, 401 locked, else resume). */
    async probeState(): Promise<number | "network"> {
        try {
            const res = await this.deps.fetch(this.url("/keyring/state"));
            try { await res.text(); } catch { /* ignore */ }
            return res.status;
        } catch {
            return "network";
        }
    }
```

In `KeyringTransport` (`src/spaces/SpaceKeyring.ts`), add the three as optional members with the same signatures, so existing test transports still compile.

- [ ] **Step 4: Implement `LogSync.ts`**

```ts
import { KeyringHttpError } from "../KeyringClient";
import { entryBytes, entryHash } from "./canonical";
import { fingerprint, ikEquals } from "./ik";
import { MembershipLog, type LogMember, type Role } from "./MembershipLog";
import type { EpochCommit, MembershipEntry, MlogHead, UnsignedEntry } from "./types";

/** What LogSync needs from core (kept structural so spaces/ never imports core/). */
export interface LogSyncDeps {
    spaceId: string;
    me: () => string;
    appId: () => Promise<string>;
    commitment: () => string | null;
    transport: {
        fetchLog(since?: number, limit?: number): Promise<{ entries: MembershipEntry[]; head: MlogHead | null }>;
        postLogEntry(entry: MembershipEntry, ec?: EpochCommit): Promise<{ head: MlogHead }>;
    };
    signer: { sign(b: Uint8Array): Promise<string>; identityKeyRaw(): Promise<string> };
    directory: { lookup(username: string): Promise<string> };
    pins: {
        get(doc: "identity" | "spaces", key: string): Promise<string | undefined>;
        pin(doc: "identity" | "spaces", entries: Record<string, string>): Promise<{ conflicts: string[] }>;
    };
    store: () => Promise<{ get<T>(k: string): Promise<T | undefined>; put(k: string, v: unknown): Promise<void> }>;
}

export interface MemberView { id: string; role: Role; ik: string; fingerprint: string; identityChanged: boolean }
export type IntegrityState = { broken: false } | { broken: true; reason: string };
interface HighWater { seq: number; hash: string; humanRemovalSeq: number }

const MAX_APPEND_RETRIES = 3;
const SYNC_DEBOUNCE_MS = 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One Space's membership log, as this client has verified it (design §3.6–§3.7).
 * Syncs from −1 on each call (slice ruling S10), checks the head against the
 * high-water mark kept in `muhkoo.trust`, checks the genesis against the pins
 * (TOFU against the directory the first time), and pins every IK a verified
 * `add` names (slice ruling S7).
 */
export class LogSync {
    private log: MembershipLog | null = null;
    private enabled = false;
    private integrityState: IntegrityState = { broken: false };
    private changed = new Set<string>();
    private fps = new Map<string, string>();
    private listeners = new Set<() => void>();
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(private readonly deps: LogSyncDeps) {}

    get logEnabled(): boolean { return this.enabled; }
    get integrity(): IntegrityState { return this.integrityState; }
    get signer(): LogSyncDeps["signer"] { return this.deps.signer; }
    get directory(): LogSyncDeps["directory"] { return this.deps.directory; }
    member(id: string): LogMember | undefined { return this.log?.member(id); }
    isMember(id: string): boolean { return !!this.log?.isMember(id); }

    members(): MemberView[] {
        return (this.log?.members ?? []).map((m) => ({
            id: m.id, role: m.role, ik: m.ik,
            fingerprint: this.fps.get(m.id) ?? "",
            identityChanged: this.changed.has(m.id.toLowerCase()),
        }));
    }

    onChange(h: () => void): () => void {
        this.listeners.add(h);
        return () => this.listeners.delete(h);
    }

    /** An `mlog` frame marks the log stale; sync once the frames settle (slice ruling S10). */
    scheduleSync(): void {
        if (this.timer) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.sync().catch(() => { /* the next frame or open retries */ });
        }, SYNC_DEBOUNCE_MS);
    }

    private hwKey(): string {
        return `loghw:${this.deps.commitment()}:${this.deps.spaceId}`;
    }

    async sync(): Promise<void> {
        const store = await this.deps.store();
        const hw = await store.get<HighWater>(this.hwKey()); // read BEFORE the request (design §3.7 item 3)
        const appId = await this.deps.appId();
        const all: MembershipEntry[] = [];
        let since = -1;
        let head: MlogHead | null = null;
        for (let page = 0; page < 10_000; page++) {
            const r = await this.deps.transport.fetchLog(since, 500);
            head = r.head;
            const fresh = r.entries.filter((e) => e.seq > since);
            all.push(...fresh);
            if (!r.head || fresh.length === 0 || all[all.length - 1].seq >= r.head.seq) break;
            since = all[all.length - 1].seq;
        }
        if (!head) {
            this.log = null;
            this.enabled = false;
            this.integrityState = hw ? { broken: true, reason: "log-missing" } : { broken: false };
            this.emit();
            return;
        }
        const log = new MembershipLog({ spaceId: this.deps.spaceId, appId });
        const res = await log.apply(all);
        if (log.unsupported) {
            this.log = null;
            this.enabled = false;
            this.integrityState = { broken: false };
            this.emit();
            return;
        }
        let integrity: IntegrityState = res.ok ? { broken: false } : { broken: true, reason: res.integrity };
        if (!integrity.broken && hw) {
            if (log.head!.seq < hw.seq) integrity = { broken: true, reason: "rollback" };
            else if (log.hashAt(hw.seq) !== hw.hash) integrity = { broken: true, reason: "fork" };
        }
        if (!integrity.broken) integrity = await this.checkGenesis(log);
        if (!integrity.broken) await this.pinMembers(log);
        if (!integrity.broken) {
            await store.put(this.hwKey(), {
                seq: log.head!.seq,
                hash: log.head!.hash,
                humanRemovalSeq: Math.max(hw?.humanRemovalSeq ?? -1, log.lastHumanRemovalSeq),
            } satisfies HighWater);
        }
        this.log = log;
        this.enabled = true;
        this.integrityState = integrity;
        this.emit();
    }

    /** Genesis trust (design §3.7 item 2): the pinned genesis hash, else TOFU with the owner's IK checked against the directory. */
    private async checkGenesis(log: MembershipLog): Promise<IntegrityState> {
        const owner = log.owner!;
        const ownerIk = log.member(owner)!.ik;
        const genesisHash = log.hashAt(0)!;
        const sKey = "s:" + (await this.spaceKeyHash());
        const pinned = await this.deps.pins.get("spaces", sKey);
        if (pinned !== undefined && pinned !== genesisHash) return { broken: true, reason: "genesis-pin" };
        if (pinned === undefined) {
            if (!ikEquals(await this.deps.directory.lookup(owner), ownerIk)) return { broken: true, reason: "owner-identity" };
            await this.deps.pins.pin("spaces", { [sKey]: genesisHash });
        }
        const { conflicts } = await this.deps.pins.pin("identity", { [owner.toLowerCase()]: await fingerprint(ownerIk) });
        return conflicts.length ? { broken: true, reason: "owner-identity" } : { broken: false };
    }

    /** b64url(SHA-256(utf8(spaceId))), the spaces-v1 key suffix (must equal PinStore.spacePinKey). */
    private async spaceKeyHash(): Promise<string> {
        const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(this.deps.spaceId)));
        return btoa(String.fromCharCode(...d)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }

    /** Pin every IK a verified add names (design §3.4 row 2); a different pinned IK flags the member (identity-changed). */
    private async pinMembers(log: MembershipLog): Promise<void> {
        const entries: Record<string, string> = {};
        for (const m of log.members) {
            const fp = await fingerprint(m.ik);
            this.fps.set(m.id, fp);
            if (m.id !== log.owner) entries[m.id.toLowerCase()] = fp;
        }
        if (!Object.keys(entries).length) return;
        const { conflicts } = await this.deps.pins.pin("identity", entries);
        this.changed = new Set(conflicts);
    }

    /**
     * Sign and append one entry. On `409 Log moved`: re-sync, re-sign against the
     * new head and retry, at most 3 times with jitter (design §9.2 I9). Any other
     * refusal → SpaceTrustError("log-refused") carrying the server's code and reason.
     */
    async append(
        op: MembershipEntry["op"],
        body: Record<string, unknown>,
        ec?: (hash: string, entry: UnsignedEntry) => Promise<EpochCommit>,
    ): Promise<{ seq: number }> {
        const { SpaceTrustError } = await import("../../core/trust/errors");
        if (this.integrityState.broken) throw new SpaceTrustError("integrity", "This space's member list couldn't be verified. You can still read messages you already have; sending is paused.");
        for (let attempt = 0; attempt <= MAX_APPEND_RETRIES; attempt++) {
            if (attempt > 0 || (op !== "genesis" && !this.log)) await this.sync();
            const head = this.log?.head ?? null;
            const unsigned = {
                v: 1 as const,
                spaceId: this.deps.spaceId,
                seq: head ? head.seq + 1 : 0,
                prev: head?.hash ?? "",
                op,
                by: this.deps.me(),
                ik: await this.deps.signer.identityKeyRaw(),
                at: Date.now(),
                body,
            } as UnsignedEntry;
            const sig = await this.deps.signer.sign(entryBytes(unsigned));
            const entry = { ...unsigned, sig } as MembershipEntry;
            const commit = ec ? await ec(await entryHash(unsigned), unsigned) : undefined;
            try {
                const r = await this.deps.transport.postLogEntry(entry, commit);
                await this.sync();
                return { seq: r.head.seq };
            } catch (e) {
                if (e instanceof KeyringHttpError && e.status === 409 && !e.body?.code) {
                    await sleep(50 + Math.floor(Math.random() * 200));
                    continue;
                }
                if (e instanceof KeyringHttpError) {
                    throw new SpaceTrustError("log-refused", String(e.body?.error ?? e.message), { status: e.status, ...(e.body ?? {}) });
                }
                throw e;
            }
        }
        throw new SpaceTrustError("log-conflict", "The member list changed while saving. Try again.");
    }

    private emit(): void {
        for (const h of this.listeners) {
            try { h(); } catch { /* a listener's failure never breaks sync */ }
        }
    }
}
```

`src/spaces/trust` may not import `src/core` statically (Task 4 rule). That is why `append` loads `SpaceTrustError` with a dynamic import. If the rollup or workers build rejects dynamic imports, move the four error classes to `src/spaces/trust/errors.ts` instead, and re-export them from `src/core/trust/errors.ts`, so both paths name the same classes. Record the choice in the report.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `yarn test:unit tests/spaces/trust/LogSync.test.ts`
Expected: PASS (9).

- [ ] **Step 6: Checkpoint**

Run: `yarn typecheck && yarn lint && yarn test:unit`
Expected: green.

---

### Task 10: Private channels: genesis at creation, the member API, wrap only to members

**Files:**
- Modify: `src/spaces/SpaceKeyring.ts` (`rawKey`, `canWrapTo`, filtered `admit`/`admitPending`), `src/spaces/Space.ts` (deps `logSync?`, `visibility?`; `create` private path; `membership`, `onMembership`, `add`, `remove`, `setRole`, `leave`, `logEnabled`; `mlog` frame; `rotate` guard; `joinRequest` auto-admit filter), `src/core/namespaces/SpaceNamespace.ts` (build a `LogSync`; pass visibility; `canWrapTo`)
- Test: `tests/spaces/Space.membership.test.ts`

**Interfaces:**
- Consumes: Tasks 7–9, and Task 6's `TrustContext`.
- Produces:
  - `SpaceKeyring.rawKey(epoch): Uint8Array | undefined`;
  - `SpaceKeyringDeps.canWrapTo?: (memberId) => boolean`;
  - `SpaceKeyring.canWrapTo(memberId): boolean`;
  - on `Space`:
    - `logEnabled: boolean`;
    - `membership(): MemberView[] | null`, where null means unlogged;
    - `onMembership(h: (m: MemberView[] | null) => void): () => void`;
    - `add(username, {role?}): Promise<{seq}>`, `remove(memberId): Promise<{seq}>`, `setRole(memberId, role): Promise<{seq}>` and `leave(): Promise<{seq}>`.

- [ ] **Step 1: Write the failing tests**

`tests/spaces/Space.membership.test.ts` builds a real `Space` with:
- a `SpaceKeyring` over an in-memory `KeyringTransport` (`MemTransport`: records join requests, wraps and pending; copy the shape from `tests/spaces/SpaceKeyring.test.ts`);
- a `LogSync` over `FakeLogServer`, built with Task 9's `syncFor` helper; move that helper into `tests/spaces/trust/chainHelper.ts` and export it;
- the `FakeChannel` pattern from `tests/spaces/Space.wire.test.ts` (lines ~138–178) through `SpaceDeps.createChannel`, so frames can be injected;
- a vault-backed `KeyStore` pair for the member (`generateOwnKeyPair` then `markVaultBacked`).

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { entryHash, ecBytes, keyCommit } from "../../src/spaces/trust/canonical";
import { verifyP256 } from "../../src/spaces/trust/ik";
// + imports for the helpers named above

describe("private channels with a signed member list (design §3.5–§3.8; slice rulings S2–S5)", () => {
    it("create() on a private Space posts genesis + ec(0), then a certified join request", async () => {
        const { space, server, transport, alice } = await makeTrustedSpace({ me: "alice", visibility: "private" });
        await space.create();
        const [g] = server.entries;
        expect(g).toMatchObject({ seq: 0, prev: "", op: "genesis", by: "alice",
            body: { visibility: "private", policy: "static", appId: "app1", baseEpoch: -1, legacyCommits: {} } });
        const [ec] = server.commits;
        const { sig: _s, ...gu } = g;
        expect(ec).toMatchObject({ v: 1, epoch: 0, prevKeyed: -1, headSeq: 0, sole: true, by: "alice", ik: g.ik,
            headHash: await entryHash(gu as never) });
        expect(ec.keyCommit).toBe(await keyCommit(0, space.keyring!.rawKey(0)!, space.id));
        const { sig, ...ecu } = ec;
        expect(await verifyP256(alice.ik, sig, ecBytes(ecu as never))).toBe(true);
        expect(transport.joinRequests[0].keyCert).toBeDefined();
        expect(space.logEnabled).toBe(true);
    });
    it("create() on a public Space writes no log", async () => {
        const { space, server } = await makeTrustedSpace({ me: "alice", visibility: "public" });
        await space.create();
        expect(server.entries).toEqual([]);
        expect(space.logEnabled).toBe(false);
    });
    it("add() looks the IK up and signs add{member (exact case), memberIk, role}", async () => {
        const { space, server, bob } = await makeTrustedSpace({ me: "alice", visibility: "private" });
        await space.create();
        await space.add("Bob"); // exact case is kept (server brief §1)
        expect(server.entries[1]).toMatchObject({ op: "add", body: { member: "Bob", memberIk: bob.ik, role: "viewer" } });
        expect(space.membership()!.map((m) => [m.id, m.role])).toEqual([["alice", "owner"], ["Bob", "viewer"]]);
    });
    it("remove() appends; a rotation is refused on a signed Space (S4)", async () => {
        const { space } = await makeTrustedSpace({ me: "alice", visibility: "private" });
        await space.create();
        await space.add("bob");
        await space.remove("bob");
        expect(space.membership()!.map((m) => m.id)).toEqual(["alice"]);
        await expect(space.rotate()).rejects.toMatchObject({ code: "log-refused" });
    });
    it("keys are wrapped only to log members, even if /pending still lists a removed one (Review Focus 4)", async () => {
        const { space, transport } = await makeTrustedSpace({ me: "alice", visibility: "private" });
        await space.create();
        await space.add("bob");
        await space.add("carol");
        await space.remove("carol");
        transport.pending = [
            { memberId: "carol", identityEcdhPub: await someEcdhPub() },
            { memberId: "bob", identityEcdhPub: await someEcdhPub() },
        ];
        transport.wraps.length = 0;
        await space.keyring!.admitPending();
        expect(transport.wraps.map((w) => w.target)).toEqual(["bob"]);
        channelOf(space).emitFrame({ joinRequest: { memberId: "carol", identityEcdhPub: await someEcdhPub() } });
        await new Promise((r) => setTimeout(r, 10));
        expect(transport.wraps.map((w) => w.target)).toEqual(["bob"]);
    });
    it("an mlog frame re-syncs within a second and notifies onMembership", async () => {
        vi.useFakeTimers();
        const { space, server, bobSync } = await makeTrustedSpace({ me: "alice", visibility: "private" });
        await space.create();
        const seen: unknown[] = [];
        space.onMembership((m) => seen.push(m));
        await bobSync.append("leave", {}); // a peer's append lands on the server
        channelOf(space).emitFrame({ mlog: { seq: 2, hash: server.head!.hash } });
        await vi.advanceTimersByTimeAsync(1000);
        expect(seen.length).toBeGreaterThan(0);
        vi.useRealTimers();
    });
});
```

Keep the helpers the test uses in the test file, or in `tests/spaces/trust/fakeSpace.ts` if Task 11 reuses them (it will):
- `makeTrustedSpace({me, visibility})` returns `{space, server, transport, alice, bob, bobSync}`, where `bobSync` is a `LogSync` for a user who has been added;
- `someEcdhPub()` exports a fresh P-384 ECDH public key the way `exportEcdhPublicKey` does;
- `channelOf(space)` returns the injected `FakeChannel`, with an `emitFrame(f)` that delivers `f` the same way `BroadcastChannelEvents.RAW_FRAME` does.

For the mlog-frame test to make sense, add bob first (`await space.add("bob")`) so that his `leave` is valid.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `yarn test:unit tests/spaces/Space.membership.test.ts`
Expected: FAIL.

- [ ] **Step 3: `SpaceKeyring`**

```ts
    /** The raw 32-byte group key for `epoch`, for its key commitment (design §4.2.4). */
    rawKey(epoch: number): Uint8Array | undefined {
        return this.keys.get(epoch);
    }

    /** Whether a key may be wrapped to `memberId` (slice ruling S5: on a signed Space, log members and the keeper only). */
    canWrapTo(memberId: string): boolean {
        return this.deps.canWrapTo ? this.deps.canWrapTo(memberId) : true;
    }
```

Add `canWrapTo?: (memberId: string) => boolean;` to `SpaceKeyringDeps`. Then:
- make the first line of `admit()`:
  `if (!this.canWrapTo(targetMemberId)) throw new Error(\`SpaceKeyring: ${targetMemberId} is not a member of this space\`);`
- in `admitPending()`, skip any request for which `!this.canWrapTo(req.memberId)`, before calling `admit`.

- [ ] **Step 4: `Space`**

Add to `SpaceDeps`:
```ts
    /** The Space's membership log (a signed private Space), when this client has trust wired. */
    logSync?: LogSync;
    /** Visibility the Space was created with; only a private Space gets a genesis (slice ruling S3). */
    visibility?: "private" | "public";
```

Add to the class:
```ts
    get logEnabled(): boolean {
        return !!this.deps.logSync?.logEnabled;
    }

    /** The verified member list, or null when this Space has no log. */
    membership(): MemberView[] | null {
        return this.deps.logSync?.logEnabled ? this.deps.logSync.members() : null;
    }

    onMembership(h: (m: MemberView[] | null) => void): () => void {
        return this.deps.logSync ? this.deps.logSync.onChange(() => h(this.membership())) : () => {};
    }

    private requireLog(): LogSync {
        const ls = this.deps.logSync;
        if (!ls?.logEnabled) throw new SpaceTrustError("log-refused", "This space has no signed member list.");
        return ls;
    }

    /** Add by exact username (design §3.8; the owner, or an editor for viewers). Looks the IK up in the directory. */
    async add(username: string, opts: { role?: "viewer" | "editor" } = {}): Promise<{ seq: number }> {
        const ls = this.requireLog();
        const memberIk = await ls.directory.lookup(username);
        return ls.append("add", { member: username, memberIk, role: opts.role ?? "viewer" });
    }

    /** Remove a member. In this build it cuts them off at the relay; it does not rotate the key (slice ruling S4). */
    async remove(memberId: string): Promise<{ seq: number }> {
        return this.requireLog().append("remove", { member: memberId });
    }

    async setRole(memberId: string, role: "viewer" | "editor"): Promise<{ seq: number }> {
        return this.requireLog().append("role", { member: memberId, role });
    }

    async leave(): Promise<{ seq: number }> {
        return this.requireLog().append("leave", {});
    }
```

Replace `create()` with:
```ts
    /** Creator path: mint epoch 0; for a private Space, sign the genesis + ec(0) BEFORE connecting (design §4.5.10). */
    async create(): Promise<void> {
        if (this.deps.locked) throw new IdentityLockedError();
        const keyring = this.requireKeyring();
        await keyring.bootstrapNew();
        const ls = this.deps.logSync;
        if (this.deps.visibility === "private" && ls) {
            const k0 = keyring.rawKey(0)!;
            await ls.append(
                "genesis",
                { visibility: "private", policy: this.historyPolicy, appId: await (this.deps.appId?.() ?? Promise.reject(new Error("no appId"))), baseEpoch: -1, legacyCommits: {} },
                async (hash, entry) => {
                    const ec = {
                        v: 1 as const, spaceId: this.name, epoch: 0, prevKeyed: -1,
                        keyCommit: await keyCommit(0, k0, this.name),
                        headSeq: 0, headHash: hash, sole: true, by: entry.by, ik: entry.ik, at: entry.at,
                    };
                    return { ...ec, sig: await ls.signer.sign(ecBytes(ec)) };
                },
            );
        }
        await this.connect();
        await keyring.requestKey().catch(() => {});
        if (this.deps.autoAdmit !== false) await keyring.admitPending().catch(() => {});
    }
```

This needs `appId?: () => Promise<string>` on `SpaceDeps`, which `SpaceNamespace` fills from `trust.appId`.

In `rotate()`, add as the first line:
`if (this.deps.logSync?.logEnabled) throw new SpaceTrustError("log-refused", "Key rotation for signed spaces arrives with a later release.");`

In `onRawFrame`:
- change the `joinRequest` auto-admit condition to also require `this.deps.keyring?.canWrapTo(req.memberId)`;
- add, before the other branches:
  ```ts
  if (f.mlog && typeof f.mlog === "object") { this.deps.logSync?.scheduleSync(); return; }
  if (f.rotateDue) { return; } // step I: nobody can answer it (slice ruling S4)
  ```

Imports: `LogSync` and `MemberView` from `./trust/LogSync`, `keyCommit` and `ecBytes` from `./trust/canonical`, and the error classes, from wherever Task 9 settled them.

- [ ] **Step 5: `SpaceNamespace.build`**

In the unlocked path, when `this.deps.trust` is set, build the `LogSync` before the keyring:

```ts
        const trust = this.deps.trust;
        const logSync = trust
            ? new LogSync({
                  spaceId,
                  me: () => memberId,
                  appId: () => trust.appId(),
                  commitment: () => this.deps.session.commitment,
                  transport: {
                      fetchLog: (s, l) => transport.fetchLog(s, l),
                      postLogEntry: (e, ec) => transport.postLogEntry(e, ec),
                  },
                  signer: trust.signer,
                  directory: trust.directory,
                  pins: trust.pins,
                  store: () => trust.store(),
              })
            : undefined;
```

Pass the following. `KEEPER_MEMBER_ID` is already imported.
- to `SpaceKeyring`: `canWrapTo: (id) => id === KEEPER_MEMBER_ID || !logSync?.logEnabled || logSync.isMember(id)`;
- to `Space`: `logSync`, `visibility` and `appId: trust ? () => trust.appId() : undefined`.

Also:
- change the signature to `build(spaceId, historyPolicy, visibility?: "private" | "public")`;
- have `createSpace` pass `opts.private ? "private" : "public"`.

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `yarn test:unit tests/spaces/Space.membership.test.ts`
Expected: PASS (6).

- [ ] **Step 7: Checkpoint**

Run: `yarn typecheck && yarn lint && yarn test:unit`
Expected: green.

---

### Task 11: Joiners: `not-member`, `identity-mismatch`, `integrity`, and the send pause

**Files:**
- Modify: `src/spaces/Space.ts` (`connect` log check, `evaluateAdmission`, integrity guard in `sealMessage`, reaction to membership changes)
- Test: `tests/spaces/Space.admission.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 9 and 10.
- Produces: `Space.connect()` rejects with `AdmissionDeniedError("not-member" | "identity-mismatch")` and never opens a socket in those cases. `sealMessage` throws `SpaceTrustError("integrity")` while integrity is broken.

- [ ] **Step 1: Write the failing tests** (use `tests/spaces/trust/fakeSpace.ts` from Task 10)

```ts
describe("admission on a signed private Space (design §3.4, §3.7, §4.5.12; slice ruling S9)", () => {
    it("a user the log does not list is not-member; connect rejects before any ticket", async () => {
        const f = await makeTrustedSpace({ me: "alice", visibility: "private" });
        await f.space.create();
        const carolSpace = await f.openAs("carol"); // same server, carol not added
        await expect(carolSpace.connect()).rejects.toMatchObject({ name: "AdmissionDeniedError", code: "not-member" });
        expect(carolSpace.admission).toBe("not-member");
        expect(f.ticketsFor("carol")).toBe(0);
    });
    it("GET /keyring/log answering 403 is not-member", async () => {
        const f = await makeTrustedSpace({ me: "alice", visibility: "private" });
        await f.space.create();
        const bob = await f.openAs("bob");
        f.server.status = 403;
        await expect(bob.connect()).rejects.toMatchObject({ code: "not-member" });
    });
    it("an add naming a different IK for me is identity-mismatch", async () => {
        const f = await makeTrustedSpace({ me: "alice", visibility: "private" });
        await f.space.create();
        f.directory.bob = (await user("impostor")).ik; // the owner was given the wrong key
        await f.space.add("bob");
        const bob = await f.openAs("bob");
        await expect(bob.connect()).rejects.toMatchObject({ code: "identity-mismatch" });
    });
    it("a member connects, requests with a certificate and turns keyed", async () => {
        const f = await makeTrustedSpace({ me: "alice", visibility: "private" });
        await f.space.create();
        await f.space.add("bob");
        const bob = await f.openAs("bob");
        await bob.connect();
        expect(bob.admission).toBe("requesting");
        await bob.keyring!.requestKey();
        expect(f.transport.joinRequests.at(-1)!.keyCert).toBeDefined();
    });
    it("integrity pauses sending but not reading", async () => {
        const f = await makeTrustedSpace({ me: "alice", visibility: "private" });
        await f.space.create();
        await f.space.add("bob");
        await f.server.truncate(0); // server rolls the log back below alice's high-water mark
        const again = await f.openAs("alice");
        await again.connect();
        expect(again.admission).toBe("integrity");
        await expect(again.send("hi")).rejects.toMatchObject({ code: "integrity" });
    });
    it("being removed while connected turns not-member and drops the socket", async () => {
        vi.useFakeTimers();
        const f = await makeTrustedSpace({ me: "alice", visibility: "private" });
        await f.space.create();
        await f.space.add("bob");
        const bob = await f.openAs("bob");
        await bob.connect();
        await f.space.remove("bob");
        channelOf(bob).emitFrame({ mlog: { seq: 2, hash: f.server.head!.hash } });
        await vi.advanceTimersByTimeAsync(1000);
        expect(bob.admission).toBe("not-member");
        expect(channelOf(bob).disconnected).toBe(true);
        vi.useRealTimers();
    });
});
```

The helper additions these tests use:
- `f.openAs(name)` builds a second Space on the same fake server and directory, for a user with their own vault-backed key and signer;
- `f.ticketsFor(name)` counts that user's `fetchTicket` calls;
- `FakeChannel.disconnected` records `disconnect()`;
- `space.send(text)` is whatever the existing public send method is called. Check `Space.ts` (`sendMessage`, `send`, …) and use it.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `yarn test:unit tests/spaces/Space.admission.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement in `Space`**

At the start of `connect()`, after the locked guard:
```ts
        const ls = this.deps.logSync;
        if (ls && !this.channel) {
            try {
                await ls.sync();
            } catch (e) {
                if (e instanceof KeyringHttpError && e.status === 403) {
                    this.setAdmission("not-member");
                    throw new AdmissionDeniedError("not-member", "You're not a member of this private channel. Ask the owner to add you.");
                }
                if (e instanceof KeyringHttpError && e.status === 401) {
                    this.setAdmission("locked");
                    throw new IdentityLockedError();
                }
                throw e;
            }
            await this.evaluateAdmission();
            if (this.admission === "not-member") throw new AdmissionDeniedError("not-member", "You're not a member of this private channel. Ask the owner to add you.");
            if (this.admission === "identity-mismatch") throw new AdmissionDeniedError("identity-mismatch", "The owner added a different identity for you. Ask them to re-add you.");
            ls.onChange(() => { void this.evaluateAdmission(); });
        }
```

Add:
```ts
    /** Re-derive admission from the verified log (design §3.4 rows, §3.7; slice ruling S9). */
    private async evaluateAdmission(): Promise<void> {
        const ls = this.deps.logSync;
        if (!ls?.logEnabled) return;
        if (ls.integrity.broken) { this.setAdmission("integrity"); return; }
        const me = this.deps.myId();
        const m = ls.member(me);
        if (!m) {
            this.setAdmission("not-member");
            this.channel?.disconnect();
            return;
        }
        if (!ikEquals(m.ik, await ls.signer.identityKeyRaw())) {
            this.setAdmission("identity-mismatch");
            this.channel?.disconnect();
            return;
        }
        if (this.admission !== "keyed") this.setAdmission(this.deps.keyring?.hasAnyKey() ? "keyed" : "requesting");
    }
```

Change Task 2's constructor `onKeysChanged` handler so that it flips to `keyed` only from `requesting`; it already does. In `sealMessage` (or the method all send paths share), add as the first line:

```ts
        if (this.deps.logSync?.integrity.broken) {
            throw new SpaceTrustError("integrity", "This space's member list couldn't be verified. You can still read messages you already have; sending is paused.");
        }
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `yarn test:unit tests/spaces/Space.admission.test.ts tests/spaces/Space.membership.test.ts`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Run: `yarn typecheck && yarn lint && yarn test:unit`
Expected: green.

---

### Task 12: `refuse=close`, a terminal 4403, confirmed via `/keyring/state`

**Files:**
- Modify: `src/transport/WSTransport.ts` (`terminalCloseCodes`, close code in `DISCONNECTED`, `resume()`), `src/sessions/BroadcastChannel.ts` (forward the `DISCONNECTED` detail; `resume()`), `src/spaces/Space.ts` (URL, options, 4403 handling; `SpaceChannelLike.resume?`; `SpaceDeps.probeState?`, `hasSession?`), `src/core/namespaces/SpaceNamespace.ts` (pass `probeState` and `hasSession`)
- Test: extend `tests/transport/WSTransport.test.ts`; create `tests/spaces/Space.notMember.test.ts`

**Interfaces:**
- Produces:
  - `WSTransportOptions.terminalCloseCodes?: number[]`;
  - `WSTransport.resume(): void`;
  - `DISCONNECTED` detail `{ code, reason } | undefined`;
  - `BroadcastChannel.resume()`;
  - `export const NOT_MEMBER_CLOSE_CODE = 4403` and `export const NOT_MEMBER_RECHECK_MS = 60_000` in `src/spaces/Space.ts`.

- [ ] **Step 1: Write the failing tests**

In `tests/transport/WSTransport.test.ts`, let the file's `FakeWebSocket.close(code?, reason?)` call `this.onclose?.({ code: code ?? 1006, reason: reason ?? "" } as CloseEvent)`, then add:

```ts
describe("terminal close codes (design §6.9, AV12; Review Focus 2)", () => {
    it("a 4403 with terminalCloseCodes [4403] schedules no reconnect and reports the code", async () => {
        const t = new WSTransport({ url: "ws://x", terminalCloseCodes: [4403], maxReconnectAttempts: 0 });
        const seen: unknown[] = [];
        t.on(EventCoreEvents.DISCONNECTED, (e: CustomEvent) => seen.push(e.detail));
        await openLatest(t); // the file's existing helper that opens the fake socket
        latestSocket().close(4403, "not-member");
        await vi.advanceTimersByTimeAsync(10_000);
        expect(seen).toEqual([{ code: 4403, reason: "not-member" }]);
        expect(socketCount()).toBe(1);
    });
    it("a 1006 still reconnects", async () => {
        const t = new WSTransport({ url: "ws://x", terminalCloseCodes: [4403], maxReconnectAttempts: 0, reconnectDelay: 100 });
        await openLatest(t);
        latestSocket().close(1006);
        await vi.advanceTimersByTimeAsync(150);
        expect(socketCount()).toBe(2);
    });
    it("resume() reconnects through a fresh urlProvider call", async () => {
        let n = 0;
        const t = new WSTransport({ url: "ws://x?t=0", urlProvider: async () => `ws://x?t=${++n}`, terminalCloseCodes: [4403], maxReconnectAttempts: 0, reconnectDelay: 100 });
        await openLatest(t);
        latestSocket().close(4403, "not-member");
        t.resume();
        await vi.advanceTimersByTimeAsync(150);
        expect(latestSocket().url).toBe("ws://x?t=1");
    });
});
```

`openLatest`, `latestSocket` and `socketCount` are whatever the existing test file already uses to drive `FakeWebSocket`. Adapt the names to match it.

`tests/spaces/Space.notMember.test.ts` uses Task 10's `fakeSpace` helpers. Add to them a `probe` stub (`SpaceDeps.probeState`) and a `FakeChannel` that records `resume()` calls and can emit `DISCONNECTED` with a detail.

```ts
describe("4403 handling (slice ruling S6)", () => {
    it("builds the upgrade URL with the ticket and refuse=close", async () => {
        const f = await makeTrustedSpace({ me: "alice", visibility: "public" });
        await f.space.create();
        expect(channelOf(f.space).url).toMatch(/\/websocket\?ticket=[^&]+&refuse=close$/);
    });
    it("4403 + state 403 → not-member, and no resume", async () => {
        const f = await makeTrustedSpace({ me: "alice", visibility: "public", probe: async () => 403 });
        await f.space.create();
        channelOf(f.space).emit("disconnected", { code: 4403, reason: "not-member" });
        await new Promise((r) => setTimeout(r, 0));
        expect(f.space.admission).toBe("not-member");
        expect(channelOf(f.space).resumes).toBe(0);
    });
    it("4403 + state 401 → locked", async () => {
        const f = await makeTrustedSpace({ me: "alice", visibility: "public", probe: async () => 401 });
        await f.space.create();
        channelOf(f.space).emit("disconnected", { code: 4403, reason: "not-member" });
        await new Promise((r) => setTimeout(r, 0));
        expect(f.space.admission).toBe("locked");
    });
    it("4403 + state 404 (step I) → one resume; a second 4403 within 60 s waits", async () => {
        vi.useFakeTimers();
        const f = await makeTrustedSpace({ me: "alice", visibility: "public", probe: async () => 404 });
        await f.space.create();
        const ch = channelOf(f.space);
        ch.emit("disconnected", { code: 4403, reason: "not-member" });
        await vi.advanceTimersByTimeAsync(1);
        expect(ch.resumes).toBe(1);
        ch.emit("disconnected", { code: 4403, reason: "not-member" });
        await vi.advanceTimersByTimeAsync(30_000);
        expect(ch.resumes).toBe(1);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(ch.resumes).toBe(2);
        vi.useRealTimers();
    });
});
```

The `BroadcastChannelEvents.DISCONNECTED` string may not be `"disconnected"`. Use the enum.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `yarn test:unit tests/transport/WSTransport.test.ts tests/spaces/Space.notMember.test.ts`
Expected: FAIL.

- [ ] **Step 3: `WSTransport`**

- Add `terminalCloseCodes?: number[];` to `WSTransportOptions`, with the doc comment "A close with one of these codes is terminal: no reconnect, `DISCONNECTED` carries `{code, reason}`; `resume()` restarts."
- Add the field `private readonly terminalCloseCodes: number[];`, set in the constructor to `opts.terminalCloseCodes ?? []`.
- Replace `socket.onclose`:

```ts
        socket.onclose = (ev?: CloseEvent) => {
          const code = typeof ev?.code === "number" ? ev.code : undefined;
          const wasConnected = this._isConnected;
          this._isConnected = false;
          this._isConnecting = false;
          this.stopHeartbeat();
          this.emit(EventCoreEvents.DISCONNECTED, code !== undefined ? { code, reason: ev?.reason ?? "" } : undefined);
          if (code !== undefined && this.terminalCloseCodes.includes(code)) {
            this.autoReconnect = false;
            return;
          }
          if (this.autoReconnect && wasConnected) {
            this.scheduleReconnect();
          }
        };
```

- Add:

```ts
  /** Restart reconnecting after a terminal close or `disconnect()`; the next URL comes from `urlProvider`. */
  resume(): void {
    if (this._isConnected || this._isConnecting) return;
    this.autoReconnect = true;
    this.scheduleReconnect();
  }
```

- [ ] **Step 4: `BroadcastChannel`**

Change the `DISCONNECTED` forwarder to `(e: CustomEvent) => this.emit(BroadcastChannelEvents.DISCONNECTED, e.detail)`, and add `resume(): void { this.transport.resume(); }`.

- [ ] **Step 5: `Space`**

- Add `resume?(): void;` to `SpaceChannelLike`.
- Add to `SpaceDeps`:
  - `probeState?: () => Promise<number | "network">`;
  - `hasSession?: () => boolean` ("true while the session holds a token, so a reconnect must never go ticketless").
- Add the constants:

```ts
/** WebSocket close code for a refused private-Space socket (design §3.6; accelerator NOT_MEMBER_CLOSE_CODE). */
export const NOT_MEMBER_CLOSE_CODE = 4403;
/** At most one resume after a 4403 per Space per this interval (design §6.7). */
export const NOT_MEMBER_RECHECK_MS = 60_000;
```

- In `connect()`, replace `buildUrl` and the `BroadcastChannel` options:

```ts
            const buildUrl = async (reconnect = false) => {
                const ticket = await this.deps.fetchTicket();
                if (!ticket && reconnect && this.deps.keyring && this.deps.hasSession?.()) {
                    // A reconnect with a live session never goes ticketless (anonymous): let the transport retry.
                    throw new Error("Space: no WebSocket ticket yet; retrying");
                }
                const q = new URLSearchParams();
                if (ticket) q.set("ticket", ticket);
                q.set("refuse", "close"); // D31: be refused with the 4403 close, which this SDK treats as terminal
                return `${this.deps.wsBaseUrl}/api/spaces/${encodeURIComponent(this.name)}/websocket?${q.toString()}`;
            };
```

  and pass `urlProvider: () => buildUrl(true)` and `terminalCloseCodes: [NOT_MEMBER_CLOSE_CODE]` to `new BroadcastChannel({...})`. `maxReconnectAttempts: 0` stays.
- After the `CONNECTED` handler, wire:

```ts
                this.channel.on(BroadcastChannelEvents.DISCONNECTED, (e: CustomEvent) => {
                    const detail = e.detail as { code?: number } | undefined;
                    if (detail?.code === NOT_MEMBER_CLOSE_CODE) void this.onNotMemberClose();
                });
```

- Add:

```ts
    private lastResumeAt = -Infinity;
    private resumeTimer: ReturnType<typeof setTimeout> | null = null;

    /** A 4403 alone never shows not-member: ask /keyring/state first (design §6.9 AV12; slice ruling S6). */
    private async onNotMemberClose(): Promise<void> {
        const status = this.deps.probeState ? await this.deps.probeState() : "network";
        if (status === 403) { this.setAdmission("not-member"); return; }
        if (status === 401) { this.setAdmission("locked"); return; }
        if (this.resumeTimer) return;
        const wait = Math.max(0, this.lastResumeAt + NOT_MEMBER_RECHECK_MS - Date.now());
        this.resumeTimer = setTimeout(() => {
            this.resumeTimer = null;
            this.lastResumeAt = Date.now();
            this.channel?.resume?.();
        }, wait);
    }
```

Clear `resumeTimer` in `disconnect()`.

- [ ] **Step 6: `SpaceNamespace`**

Pass `probeState: () => transport.probeState()` and `hasSession: () => !!this.deps.session.token` to `new Space({...})` in the unlocked `build` path.

- [ ] **Step 7: Run the tests and confirm they pass**

Run: `yarn test:unit tests/transport/WSTransport.test.ts tests/spaces/Space.notMember.test.ts`
Expected: PASS.

- [ ] **Step 8: Checkpoint**

Run: `yarn typecheck && yarn lint && yarn test:unit`
Expected: green.

---

### Task 13: Wire the Client, export the surface, record the changes, build

**Files:**
- Modify: `src/core/Client.ts` (build the `TrustContext` and pass it to `SpaceNamespace`; `client.trust`), `src/api.ts` (exports), `api-surface.txt` (regenerated), `CHANGELOG.md` (`## Unreleased`), `package.json` (`version` → `0.15.0-alpha.0`; **not published**, S1)
- Test: `tests/core/trust/client-trust.test.ts`

**Interfaces:**
- Produces:
  - `client.trust: { persistent(): Promise<boolean>; unpin(username: string): Promise<void>; resetSpaceTrust(spaceId: string): Promise<void> }`;
  - exported: `IdentityLockedError`, `IdentityUnavailableError`, `SpaceTrustError`, `AdmissionDeniedError`, `type AdmissionState`, `type MemberView`, `type ChatKeyCert`, `type MembershipEntry`, `NOT_MEMBER_CLOSE_CODE`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { Client, IdentityLockedError, AdmissionDeniedError, SpaceTrustError } from "../../../src/api";

describe("Client wires trust (design §6.9)", () => {
    it("exposes client.trust and the error classes", async () => {
        const c = new Client({ baseUrl: "http://test", apiKey: "mk_test_pk_x" } as never);
        expect(typeof c.trust.resetSpaceTrust).toBe("function");
        expect(typeof c.trust.unpin).toBe("function");
        expect(await c.trust.persistent()).toBeTypeOf("boolean");
        expect(new IdentityLockedError()).toBeInstanceOf(Error);
        expect(new AdmissionDeniedError("not-member").code).toBe("not-member");
        expect(new SpaceTrustError("integrity").code).toBe("integrity");
    });
});
```

Adapt the `Client` constructor arguments to what `tests/client/client.test.ts` uses.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `yarn test:unit tests/core/trust/client-trust.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `Client.ts`, before `this.space = new SpaceNamespace({...})`:

```ts
        const trustContext = new TrustContext({ http: this.http, session: this.session });
```

Pass `trust: trustContext` into the `SpaceNamespace` deps. Then add a public field:

```ts
    /** Trust records shared by every Space: pins and per-Space log heads (design §3.4, §6.9). */
    readonly trust: { persistent(): Promise<boolean>; unpin(username: string): Promise<void>; resetSpaceTrust(spaceId: string): Promise<void> };
```

and set it in the constructor:

```ts
        this.trust = {
            persistent: async () => (await trustContext.store()).persistent,
            unpin: (u) => trustContext.unpinUser(u),
            resetSpaceTrust: (id) => trustContext.resetSpaceTrust(id),
        };
```

In `src/api.ts`, export the errors, the `NOT_MEMBER_CLOSE_CODE` constant and the four types listed above.

Regenerate the surface snapshot:
`UPDATE_API_SURFACE=1 npx vitest --run tests/api/export-surface.test.ts`

Then diff `api-surface.txt`. It must gain only the new names.

In `package.json`, set `"version": "0.15.0-alpha.0"`. `yarn build` stamps `src/version.ts`.

Add to `CHANGELOG.md` under `## Unreleased`, keeping the file's bold-lead style:
- **Fixed:** "**A reloaded page no longer hides your earlier messages from everyone else.**" A locked session (signed in, but the account secret not in memory) used to take part with a temporary key. Other members' SDKs then dropped every message you had signed before. A locked session now never takes part:
  - `client.space.get()` returns a Space with `admission: "locked"`;
  - `connect()` throws `IdentityLockedError`;
  - `createChannel` and `createSpace` with messaging throw it too.
- **Added:** "**Signed membership for new private channels.**" Covers:
  - the genesis and `ec(0)` at creation;
  - `space.add`, `remove`, `setRole`, `leave`, `membership()` and `onMembership`;
  - the pinned owner and member identities;
  - `admission` and `onAdmission`;
  - `client.trust`.

  Removal cuts a member off at the relay. The key is not rotated in this release.
- **Added:** "**Chat-key certificates on join requests**", "**`refuse=close` and a terminal 4403**" and "**Hosted sign-in `returnTo`**", each with a one-paragraph why.
- **Changed (breaking, typed seams):** `ensureIdentity` no longer falls back to a temporary key. A vault failure throws `IdentityUnavailableError`.

- [ ] **Step 4: Run and build**

Run: `yarn test:unit tests/core/trust/client-trust.test.ts && yarn typecheck && yarn lint && yarn test:unit && yarn build`
Expected: green, and `grep -c 0.15.0-alpha.0 src/version.ts` prints 1.

- [ ] **Step 5: Checkpoint**

Run: `git status --short` and `git diff --stat`.
**Do not** run `npm run release` or `npm publish` (S1).

---
## Part D: web chat (web repo)

### Task 14: web on the local SDK; auth knows "locked"; the callback returns to `returnTo`

**Files:**
- Modify: `package.json` and `yarn.lock`: `"@muhkoo/connect": "file:../connect"`
- Modify: `src/lib/connect.ts` (re-export the new errors and types), `src/auth/AuthContext.tsx`, `src/routes/AuthCallbackPage.tsx`

**Interfaces:**
- Consumes: connect Tasks 1–13, built with `cd ../connect && yarn build`.
- Produces, on `AuthContextValue`:
  - `locked: boolean`;
  - `signInAgain(returnTo: string): Promise<void>`;
  - `hasPasswordFactor(): Promise<boolean>`;
  - `completeHostedLogin(): Promise<string | undefined>`, which resolves the `returnTo`.

- [ ] **Step 1: Point web at the local SDK**

Run: `cd /Users/matt/GitHub/muhkoo/web && yarn add file:../connect`
Then: `grep '"version"' node_modules/@muhkoo/connect/package.json`
Expected: `0.15.0-alpha.0`.

A `file:` dependency **copies** `dist`. After any later connect rebuild, run `yarn install --force` in web before building (memory: "connect file: dep is copied").

- [ ] **Step 2: Re-export**

In `src/lib/connect.ts`, next to the existing `ChannelExistsError` re-export, add:
`export { IdentityLockedError, AdmissionDeniedError, SpaceTrustError } from "@muhkoo/connect";`
`export type { AdmissionState, MemberView } from "@muhkoo/connect";`

- [ ] **Step 3: `AuthContext`**

1. Add to `AuthContextValue`:
```ts
    /** Signed in, but the account key isn't in memory (after a reload). Chat opens no channel until the user signs in again (design §3.3, §7.2). */
    locked: boolean;
    /** Hosted sign-in round trip that comes back to `returnTo` (a same-origin path). */
    signInAgain(returnTo: string): Promise<void>;
    /** Whether the account has a password factor: the inline unlock field is shown only then (CS-5). */
    hasPasswordFactor(): Promise<boolean>;
```
   Change `completeHostedLogin(): Promise<void>` to `completeHostedLogin(): Promise<string | undefined>`.

2. State: `const [locked, setLocked] = useState(false);`

3. In the mount effect that calls `client.auth.zk.resume()` (≈ lines 121–144), after the session state is set from the restored session, add:
```ts
            setLocked(!!getClient().auth.zk.token && getClient().auth.zk.identity === null);
```
   Place it where the restored session is known. If `resume()` unlocked through a passkey, `identity` is non-null and `locked` stays false.

4. `completeHostedLogin`:
   - capture `const { username, commitment, returnTo } = await client.auth.hosted.handleCallback();`
   - after `setSession({ username, token });`, add `setLocked(false); return returnTo;`

5. `unlock(password)`: after the chat-key rehydrate, add `setLocked(false);`.

6. `logout()`: add `setLocked(false);`.

7. Add:
```ts
    const signInAgain = useCallback(async (returnTo: string) => {
        await getClient().auth.hosted.login({
            appId: "muhkoo-web",
            redirectUri: `${window.location.origin}/auth/callback`,
            returnTo,
        });
    }, []);

    const hasPasswordFactor = useCallback(async () => {
        try {
            return (await getClient().auth.zk.listFactors()).some((f) => f.type === "password");
        } catch {
            return false;
        }
    }, []);
```
   Add `locked`, `signInAgain` and `hasPasswordFactor` to the context value object and to its `useMemo` dependency list, if there is one.

- [ ] **Step 4: `AuthCallbackPage`**

- Replace `.then(() => navigate("/chat", { replace: true }))` with `.then((returnTo) => navigate(returnTo ?? "/chat", { replace: true }))`.
- Replace `if (session) return <Navigate to="/chat" replace />;` with:
```tsx
    // A signed-in-but-locked user comes back through here to re-unlock: only skip when this isn't a real callback.
    if (session && !getClient().auth.hosted.isCallback()) return <Navigate to="/chat" replace />;
```
- Import `getClient` from `../lib/client`, or wherever the other pages import it from.

- [ ] **Step 5: Checkpoint**

Run: `yarn build`
Expected: 0 type errors, and the build succeeds.

---

### Task 15: The identity gate: no channel opens while locked

**Files:**
- Create: `src/components/LockedBanner.tsx`, `cypress/e2e/chat-locked.cy.ts`
- Modify: `src/hooks/useChatChannel.ts` (the `enabled` arg), `src/routes/ChatPage.tsx` (banner, composer gating)

- [ ] **Step 1: Write the failing mocked spec**

`cypress/e2e/chat-locked.cy.ts`. Copy `chat-shell.cy.ts`'s `loginAndVisitChat()` recipe: seed the three `muhkoo.session.*` keys, and intercept `/api/auth/verify` to return `{ username }`. **Nothing** may make `identity` non-null.

Before writing the intercept, find the factors route: `grep -n "vaultFactors" ../connect/src/auth/AuthClient.ts`.

```ts
describe("locked session (design §3.3, §7.2; Review Focus 5)", () => {
    beforeEach(() => {
        cy.intercept("POST", /\/api\/auth\/verify(\?|$)/, { statusCode: 200, body: { username: "alice" } });
        cy.intercept("GET", "**/api/app/channels/**", { statusCode: 200, body: { name: "general", spaceId: "sp-general", visibility: "public" } }).as("resolve");
        cy.intercept("POST", "**/api/ws-ticket**", cy.spy().as("ticket"));
        cy.intercept("POST", "**/keyring/join-request", cy.spy().as("joinRequest"));
        cy.intercept("**/authorize*", { statusCode: 200, body: "<html>hosted sign-in</html>" }).as("authorize");
    });

    it("shows 'Sign in again' and opens no socket and sends no join request", () => {
        visitChatLocked("alice", "#general"); // helper: seeds the session keys, visits /chat#general
        cy.get('[data-cy="chat-locked"]').should("contain", "Sign in again to read this channel.");
        cy.wait(1500);
        cy.get("@ticket").should("not.have.been.called");
        cy.get("@joinRequest").should("not.have.been.called");
        cy.get('textarea[placeholder^="Message"]').should("be.disabled");
    });

    it("'Sign in again' goes to the hosted page and stashes returnTo", () => {
        visitChatLocked("alice", "#general");
        cy.get('[data-cy="sign-in-again-btn"]').click();
        cy.wait("@authorize").its("request.url").should("include", "app_id=muhkoo-web");
        cy.window().then((w) => {
            const stash = JSON.parse(w.sessionStorage.getItem("muhkoo.hosted.pkce") || "{}");
            expect(stash.returnTo).to.eq("/chat#general");
        });
    });

    it("shows the inline password field only when the account has a password factor", () => {
        stubFactors([{ id: "f1", type: "password" }]); // cy.intercept on the vaultFactors route
        visitChatLocked("alice", "#general");
        cy.get('[data-cy="unlock-password"]').should("exist");
        stubFactors([{ id: "g1", type: "google" }]);
        cy.reload();
        cy.get('[data-cy="chat-locked"]').should("exist");
        cy.get('[data-cy="unlock-password"]').should("not.exist");
    });
});
```

Run: `yarn cy:run --spec cypress/e2e/chat-locked.cy.ts`
Expected: FAIL (no `chat-locked` banner).

- [ ] **Step 2: `LockedBanner`**

`src/components/LockedBanner.tsx`:
```tsx
import { useEffect, useState } from "react";
import { Alert, Button, CircularProgress, Stack, TextField, Typography } from "@mui/material";

interface Props {
    onSignIn: () => void;
    hasPasswordFactor: () => Promise<boolean>;
    unlock: (password: string) => Promise<void>;
}

/** Design §9.1 `locked` copy; a password field only for accounts with a password factor (CS-5). */
export default function LockedBanner({ onSignIn, hasPasswordFactor, unlock }: Props) {
    const [showPassword, setShowPassword] = useState(false);
    const [password, setPassword] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let live = true;
        hasPasswordFactor().then((v) => { if (live) setShowPassword(v); }).catch(() => {});
        return () => { live = false; };
    }, [hasPasswordFactor]);

    return (
        <Alert
            severity="warning"
            sx={{ borderRadius: 0 }}
            data-cy="chat-locked"
            action={
                <Button color="inherit" size="small" onClick={onSignIn} data-cy="sign-in-again-btn">
                    Sign in again
                </Button>
            }
        >
            Sign in again to read this channel.
            {showPassword && (
                <Stack
                    direction="row"
                    spacing={1}
                    sx={{ mt: 1 }}
                    component="form"
                    onSubmit={async (e) => {
                        e.preventDefault();
                        setBusy(true);
                        setError(null);
                        try { await unlock(password); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
                    }}
                >
                    <TextField
                        size="small"
                        type="password"
                        label="Password"
                        autoComplete="current-password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        inputProps={{ "data-cy": "unlock-password" }}
                    />
                    <Button type="submit" size="small" variant="outlined" disabled={busy || !password} data-cy="unlock-btn">
                        {busy ? <CircularProgress size={18} color="inherit" /> : "Unlock"}
                    </Button>
                </Stack>
            )}
            {error && <Typography variant="body2" color="error">{error}</Typography>}
        </Alert>
    );
}
```

- [ ] **Step 3: Gate the hook**

In `src/hooks/useChatChannel.ts`:
- add `enabled?: boolean` to `UseChatChannelArgs`;
- destructure it as `{ roomName, myId, enabled = true }`;
- in the main effect, after the per-channel state resets and before the async IIFE, add `if (!enabled) return;`;
- add `enabled` to the effect's dependency array: `[roomName, myId, attempt, enabled]`.

- [ ] **Step 4: `ChatPage`**

- Destructure `locked`, `signInAgain`, `hasPasswordFactor` and `unlock` from `useAuth()`.
- Pass `enabled: !locked` to `useChatChannel`.
- Render, first in the banner block:
```tsx
                {locked && (
                    <LockedBanner
                        onSignIn={() => void signInAgain(window.location.pathname + window.location.search + window.location.hash)}
                        hasPasswordFactor={hasPasswordFactor}
                        unlock={unlock}
                    />
                )}
```
- Add `|| locked` to the `Composer` `disabled` expression (≈ line 242).

- [ ] **Step 5: Run the spec and confirm it passes**

Run: `yarn cy:run --spec cypress/e2e/chat-locked.cy.ts`
Expected: PASS (3). Also run `yarn cy:run --spec cypress/e2e/chat-shell.cy.ts`, which must still pass. If it relied on an unlocked hook, give it the `enabled` path it needs, and report the change.

- [ ] **Step 6: Checkpoint**

Run: `yarn build`
Expected: green.

---

### Task 16: Private channels, the signed member panel, admission banners

**Files:**
- Create: `src/components/AddMemberDialog.tsx`
- Modify: `src/components/RoomChooserDialog.tsx` (private toggle), `src/hooks/useChatChannel.ts` (admission, membership, add/remove, reset, private create), `src/routes/ChatPage.tsx` (banners, member wiring), `src/components/MembersSidebar.tsx` (signed list, roles, remove, add)

**Ruling for this task:** the mocked Cypress tier cannot open sockets or sign entries, so this UI is verified end to end on staging in Task 17. The task's gate is `yarn build` plus a manual render check (`yarn dev` against staging is fine).

- [ ] **Step 1: The private toggle**

In `RoomChooserDialog.tsx`:
- add `const [isPrivate, setIsPrivate] = useState(false);`;
- above the create button, add:
```tsx
                    <FormControlLabel
                        control={<Switch checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} data-cy="create-private-toggle" />}
                        label="Private channel"
                    />
                    {isPrivate && (
                        <DialogContentText variant="body2">
                            Only people you add can read it. Invite links aren't available for private channels yet.
                        </DialogContentText>
                    )}
```
- make `create()` call `getClient().space.createChannel(trimmed, { private: isPrivate })`;
- import `FormControlLabel` and `Switch` from `@mui/material`.

- [ ] **Step 2: The hook**

In `src/hooks/useChatChannel.ts`:
- Add to the result interface:
```ts
    /** Where I stand in this channel (null until opened). */
    admission: AdmissionState | null;
    /** The verified member list of a signed private channel, or null when the channel has none. */
    membership: MemberView[] | null;
    addMember(username: string, role: "viewer" | "editor"): Promise<void>;
    removeMember(memberId: string): Promise<void>;
    resetSpaceTrust(): Promise<void>;
```
- Change `createChannel` to `createChannel(opts?: { private?: boolean }): Promise<void>`, calling `getClient().space.createChannel(roomName, { private: !!opts?.private })`.
- State: `const [admission, setAdmission] = useState<AdmissionState | null>(null);` and `const [membership, setMembership] = useState<MemberView[] | null>(null);`. Reset both in the per-channel reset block.
- After `wire(space);`:
```ts
            setAdmission(space.admission);
            offAdmission = space.onAdmission((a) => { if (!disposed) setAdmission(a); });
            offMembership = space.onMembership((m) => { if (!disposed) setMembership(m); });
```
  Declare `let offAdmission: (() => void) | null = null; let offMembership: (() => void) | null = null;` next to `offTyping`, and call both in the cleanup.
- Replace the `space.connect()` catch with:
```ts
            } catch (err) {
                if (err instanceof AdmissionDeniedError) {
                    if (!disposed) { setAdmission(err.code); setPending(false); }
                    return; // not a member: no cached backlog, no retry
                }
                if (err instanceof IdentityLockedError) {
                    if (!disposed) setAdmission("locked");
                    return;
                }
                await hydrateFromCache(space);
                if (!disposed) setError(toError(err));
                return;
            }
            if (disposed) return;
            setMembership(space.membership());
```
- Add the callbacks:
```ts
    const addMember = useCallback(async (username: string, role: "viewer" | "editor") => {
        const space = spaceRef.current;
        if (!space) return;
        await space.add(username, { role });
        setMembership(space.membership());
    }, []);

    const removeMember = useCallback(async (memberId: string) => {
        const space = spaceRef.current;
        if (!space) return;
        await space.remove(memberId);
        setMembership(space.membership());
    }, []);

    const resetSpaceTrust = useCallback(async () => {
        const space = spaceRef.current;
        if (!space) return;
        await getClient().trust.resetSpaceTrust(space.id);
        setAttempt((n) => n + 1);
    }, []);
```
- Return the five new fields.

- [ ] **Step 3: `AddMemberDialog`**

`src/components/AddMemberDialog.tsx`:
```tsx
import { useState } from "react";
import {
    Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle,
    MenuItem, Stack, TextField,
} from "@mui/material";
import { SpaceTrustError } from "../lib/connect";

interface Props {
    open: boolean;
    canAddEditors: boolean;
    onClose: () => void;
    onAdd: (username: string, role: "viewer" | "editor") => Promise<void>;
}

/** Map a refused `add` (server reasons, server brief §2.8) to plain words. */
function explain(err: unknown): string {
    if (err instanceof SpaceTrustError) {
        const reason = (err.detail as { reason?: string } | undefined)?.reason;
        if (reason === "target-member") return "They're already a member.";
        if (reason === "editor-role") return "Editors can add viewers only.";
        if (reason === "not-owner" || reason === "not-member") return "Only the owner or an editor can add members.";
        if (err.code === "lookup-failed") return "Couldn't verify members right now; retrying.";
    }
    return err instanceof Error ? err.message : String(err);
}

export default function AddMemberDialog({ open, canAddEditors, onClose, onAdd }: Props) {
    const [username, setUsername] = useState("");
    const [role, setRole] = useState<"viewer" | "editor">("viewer");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function submit() {
        setBusy(true);
        setError(null);
        try {
            await onAdd(username.trim(), role);
            setUsername("");
            onClose();
        } catch (err) {
            setError(explain(err));
        } finally {
            setBusy(false);
        }
    }

    return (
        <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
            <DialogTitle>Add a member</DialogTitle>
            <DialogContent>
                <DialogContentText sx={{ mb: 2 }}>
                    They'll be able to read this private channel. Enter their username exactly: usernames are case-sensitive.
                </DialogContentText>
                <Stack spacing={2}>
                    <TextField
                        autoFocus
                        fullWidth
                        label="Username"
                        value={username}
                        onChange={(e) => setUsername(e.target.value.slice(0, 64))}
                        inputProps={{ "data-cy": "add-member-username" }}
                    />
                    <TextField select label="Role" value={role} onChange={(e) => setRole(e.target.value as "viewer" | "editor")} data-cy="add-member-role">
                        <MenuItem value="viewer">Viewer</MenuItem>
                        {canAddEditors && <MenuItem value="editor">Editor (can add and remove viewers)</MenuItem>}
                    </TextField>
                    {error && <DialogContentText color="error" data-cy="add-member-error">{error}</DialogContentText>}
                </Stack>
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose}>Cancel</Button>
                <Button variant="contained" onClick={submit} disabled={busy || !username.trim()} data-cy="add-member-submit">
                    {busy ? <CircularProgress size={18} color="inherit" /> : "Add"}
                </Button>
            </DialogActions>
        </Dialog>
    );
}
```

- [ ] **Step 4: `MembersSidebar`**

Add these props:
- `membership?: MemberView[] | null`;
- `myId?: string`;
- `onAddMember?: () => void`;
- `onRemoveMember?: (id: string) => void`.

When `membership` is non-null, render the signed list instead of the live-roster-only list:
- one row per `membership` entry, keeping `data-cy="member-row"` and `data-member-id`;
- presence from the existing live `members` prop, matched by id; otherwise offline;
- a role chip reading `Owner` / `Editor` / `Viewer` (`data-cy="member-role"`);
- when `identityChanged`, a `WarningAmberIcon` with the tooltip "<name>'s identity key changed. Compare safety numbers before trusting them again." (design §9.1);
- a remove `IconButton` (`data-cy="remove-member-btn"`), shown when `myRole === "owner" && m.role !== "owner"`, or `myRole === "editor" && m.role === "viewer"`. `myRole` is the `role` of the entry whose `id === myId`. The click handler:
```ts
if (window.confirm(`Remove ${m.id}? They lose access to this channel right away. Messages they already received stay with them.`)) onRemoveMember?.(m.id);
```
- in the header, when `myRole` is `owner` or `editor`: `<Button size="small" data-cy="add-member-btn" onClick={onAddMember}>Add member</Button>`.

- [ ] **Step 5: `ChatPage`**

- Hold `const [addOpen, setAddOpen] = useState(false);`.
- Pass `membership={chat.membership}`, `myId={myId}`, `onAddMember={() => setAddOpen(true)}` and `onRemoveMember={(id) => void chat.removeMember(id).catch((e) => alert(e.message))}` to `MembersSidebar`.
- Render `<AddMemberDialog open={addOpen} canAddEditors={myRole === "owner"} onClose={() => setAddOpen(false)} onAdd={chat.addMember} />`, with `myRole` computed from `chat.membership` and `myId`.
- Add the banners after the locked banner. Copy is verbatim from design §9.1:
```tsx
                {chat.admission === "not-member" && (
                    <Alert severity="info" sx={{ borderRadius: 0 }} data-cy="not-a-member">
                        You're not a member of this private channel. Ask the owner to add you.
                    </Alert>
                )}
                {chat.admission === "identity-mismatch" && (
                    <Alert severity="warning" sx={{ borderRadius: 0 }} data-cy="identity-mismatch">
                        The owner added a different identity for you. Ask them to re-add you.
                    </Alert>
                )}
                {chat.admission === "integrity" && (
                    <Alert
                        severity="error"
                        sx={{ borderRadius: 0 }}
                        data-cy="integrity-banner"
                        action={
                            <Button
                                color="inherit"
                                size="small"
                                data-cy="reset-trust-btn"
                                onClick={() => {
                                    if (window.confirm("Only do this if you were told this space was restored from a backup. Your app will trust the member list it is shown now.")) void chat.resetSpaceTrust();
                                }}
                            >
                                Reset trust for this space
                            </Button>
                        }
                    >
                        This space's member list couldn't be verified. You can still read messages you already have; sending is paused.
                    </Alert>
                )}
```
- Extend the `Composer` `disabled` expression with `|| (chat.admission !== null && ["locked", "not-member", "identity-mismatch", "integrity"].includes(chat.admission))`.
- Hide the `channel-pending` banner when `chat.admission` is `not-member` or `identity-mismatch`.

- [ ] **Step 6: Checkpoint**

Run: `yarn build && yarn cy:run --spec "cypress/e2e/*.cy.ts"`
Expected: build green, and the mocked specs green (including Task 15's).

---

### Task 17: Staging deploy and the end-to-end check in Brave (run by the controller)

A staging deploy is a side effect outside the working tree, so the **controller** runs this task, not a subagent. It stays **staging only**.

**Files:**
- Create, in the plan's SDD workspace (gitignored): `e2e-slice.mjs`. This is a Playwright script driving Brave headless, built from the harness already proven on 2026-09-29:
  - the Brave executable at `/Applications/Brave Browser.app/Contents/MacOS/Brave Browser`;
  - Playwright imported from `/Users/matt/GitHub/muhkoo/ide/node_modules/playwright/index.mjs`;
  - sign-up through `web.staging.muhkoo.dev/login` → "Continue with Muhkoo" → "Create an account" → Username / Password / checkbox → "Create account";
  - an intermediate-screen loop for "Agree and continue" / "Continue".

- [ ] **Step 1: Build and deploy web to staging**

```bash
cd /Users/matt/GitHub/muhkoo/connect && yarn build
cd /Users/matt/GitHub/muhkoo/web && yarn install --force && set -a && . ../accelerator/.env.cli && set +a && yarn deploy:staging
for a in $(curl -s https://web.staging.muhkoo.dev/ | grep -o 'assets/[^"]*\.js'); do curl -s https://web.staging.muhkoo.dev/$a | grep -o '0\.15\.0-alpha\.0' | sort -u; done
```

Expected: the live bundle prints `0.15.0-alpha.0`.

- [ ] **Step 2: Scenario R, the reload bug (public channel)**

1. A signs up and creates public `#r<ts>`, then posts `m1`.
2. A reloads. Expect `[data-cy="chat-locked"]`, and no `/api/ws-ticket` or `join-request` request for 5 s (count with `page.on("request")`).
3. A clicks `sign-in-again-btn`, signs in on the hosted page and lands on `/chat#r<ts>`. Expect no banner, and `m1` visible.
4. A posts `m2`.
5. B signs up and opens `#r<ts>`. **Both `m1` and `m2` are visible to B.** Before this slice, `m1` was hidden.

- [ ] **Step 3: Scenario P, a private channel with a signed member list**

1. A creates `#p<ts>` with `create-private-toggle` on, and posts `pa`.
2. A clicks `add-member-btn`, enters B's exact username with role Viewer, and clicks `add-member-submit`. Expect B listed with the chip `Viewer`.
3. B opens `#p<ts>`. Expect `pa` visible. B posts `pb`, and A sees it live.
4. C (signed up, never added) opens `#p<ts>`. Expect `[data-cy="not-a-member"]`, with no messages and a disabled composer.
5. A removes B. Expect B's page to show `[data-cy="not-a-member"]` within 15 s, and to open **at most one** new WebSocket in the next 60 s (count with `page.on("websocket")`). A's list shows A only.
6. Separately, `curl` the Space's `/history` with B's session and the app pk. Expect 403.

- [ ] **Step 4: Record**

Report every step as PASS/FAIL with timings. Keep screenshots in the workspace.

On any FAIL, diagnose it before calling it a bug. The 2026-09-29 run found two harness issues:
- typing into a channel while it is still being created;
- `window.confirm` dismissed by default.

Update:
- the roadmap's "Carried forward" section: the slice is on staging, with each rule it relied on;
- the memory entries `project-e2e-program` and `project-reload-hides-messages-bug`: the reload bug is fixed on staging, not in production.

Production for web and connect needs Matt's explicit ask. Before any production web deploy, web's `package.json` must point back at a published connect (S1).

---

## Self-review (writer's checklist, done)

- **Spec coverage.** Every slice-scope row in design §3.1–§3.8, §6.9 and §7.2 maps to a task: locked (1–2), `returnTo` (3), encoders (4), signer and directory (5), pins (6), `keyCert` (7), log rules (8), sync/append/integrity/genesis trust (9), create/add/remove/role/leave and the wrap filter (10), joiner admission (11), transport (12), wiring (13), the web gate (14–15), web membership (16), staging proof (17). Everything the spec needs from A0a/A0b is cut by rulings S2–S11, each with a stated cost.
- **Placeholders.** Where a step says "adapt to the existing helper name", it points at a named file and a named helper, because the plan cannot know every private test-helper spelling. No step leaves behaviour unspecified.
- **Type consistency.** `AdmissionState`, `MemberView`, `LogSync`, `KeyringHttpError`, `TrustContext`, `SeedIdentitySigner` and `mintKeyCert` are spelled the same in every task that consumes them.
- **Review Focus.** Each of the five lines names the task that carries its test.

## Appendix: deferred minors from the subagent run (2026-09-30)

The per-task and final reviews logged these as Minor. The final review sorted them as can-wait; the two that had to be fixed before staging were fixed. Fix them when the code is next touched (step S at the latest):

- Task 1: minor (deferred): A cross-path race can still mark a non-vault pair as vault-backed. rehydrate calls forget and then awaits store.get and the importKey calls; a concurrent EncryptedSession.initialize() mint (EncryptedSession.ts:131-133, kept by S13) fills the empty slot, hydrateKeyPair leaves it, and markVaultBacked marks it. A mixed pair is also possible, because generateOwnKeyPair sets its two maps on either side of an await and isVaultBacked checks only _keys; loadIdentity then reaches getAuthKeyPair(memberId)! (SpaceNamespace.ts:359) with an ECDSA key the vault does not hold. A vault 5xx after the early forget also leaves a live DM session with no pair. This breaks S13's guarantee, but it is not a regression and is not reachable in the web slice (web no longer uses client.message). Fix: import first, then swap in the pair synchronously (forget, set both maps, mark), or have isVaultBacked compare the marked KeyPair by reference. [src/core/ChatKeyVault.ts:65-72, 87-96; src/crypto/KeyStore.ts:145]
- Task 1: minor (deferred): Plan-mandated: every ensure failure, including a permanent unwrap failure (wrong seed or tampered blob), becomes IdentityUnavailableError with the message 'Try again', so the UI may loop on a retry. Data is safe, because ensure never provisions after a rehydrate throw. The brief's Step 6 catch-all mandates this mapping; the controller should rule on it before Tasks 15/16 map errors to copy. [src/core/namespaces/SpaceNamespace.ts:353-354]
- Task 1: minor (deferred): IdentityUnavailableError now has a public `retryable` field (a third constructor parameter, default true), which departs from brief Step 1's verbatim class. Design §3.3 still says every `chatKeys.ensure` failure throws IdentityUnavailableError "(retryable)" with no condition, and the fix did not amend it. The change is additive and breaks nothing: Task 13 exports the class by name, api-surface.txt lists names only, and Task 16 reads only .message. The controller should either ratify the field and amend §3.3 and the brief, or fall back to keeping only the distinct message and `reason`. [src/spaces/trust/errors.ts:29-33; docs/superpowers/specs/2026-09-27-e2e-channels-design.md:412]
- Task 2: minor (deferred): A locked Space registered in openSpaces is reused by the offline 'space' replayer after unlock. Its connect() throws IdentityLockedError, which is not an HttpError, so OutboundQueue treats it as transient and stops the whole drain until the app calls get() for that exact Space id. Before this task, build() threw without registering anything. Reachability: the sync engine must run with identity set and seed null. Fix in the replayer: if (!space || space.admission === 'locked') space = await this.get(spaceId). [src/core/namespaces/SpaceNamespace.ts:92-93 and :294; src/offline/OutboundQueue.ts:78-94]
- Task 2: minor (deferred): Test 1 asserts 'no ticket, no join-request', but only http.post is recorded. KeyringClient posts /keyring/join-request through http.fetch, which the test stubs without recording, so a regression that gave locked Spaces a keyring would still pass. The test is plan-mandated verbatim. Fix: record http.fetch calls, or also assert that space.keyring is undefined. [tests/spaces/Space.locked.test.ts:17-18,39; src/spaces/KeyringClient.ts:33,49]
- Task 2: minor (deferred): The joinByInvite locked guard has no test. Only the createSpace guard is exercised, through createChannel and messaging:false. [src/core/namespaces/SpaceNamespace.ts:251]
- Task 2: minor (deferred): On a locked Space, history(), sendMessage(), admit(), invite() and rotate() throw the generic 'requires a keyring (open via client.space)' Error instead of IdentityLockedError. That message is misleading for a Space that was opened via client.space. Fix (additive): throw IdentityLockedError at the top of requireKeyring when deps.locked is set. [src/spaces/Space.ts:970-972]
- Task 2: minor (deferred): Space.ts imports IdentityLockedError from ../core/trust/errors. This is the first and only import from src/spaces into src/core, although carry P10 put the classes in src/spaces/trust/errors.ts. Importing from ./trust/errors gives the same class; the brief names the core path. [src/spaces/Space.ts:34]
- Task 3: minor (deferred): Tamper test uses a raw string literal for the sessionStorage key instead of the file's own PKCE_STORE_KEY constant [tests/auth/hosted-returnto.test.ts:312-313]
- Task 4: minor (deferred): Negative/failure-path coverage for ik.ts (decodeRawP256 garbage, verifyP256 tampered/bad sig, fingerprint throw) exists only in an uncommitted scratch script per the implementer's self-review, not in the committed test suite. [tests/spaces/trust/canonical.test.ts (whole file); task-4-report.md:94-101]
- Task 4: minor (deferred): Header/doc-comment prose in the ported files was edited beyond the brief's 'change only the imports' instruction (disclosed deviation). [src/spaces/trust/lp.ts:1-10; src/spaces/trust/canonical.ts:1-12; src/spaces/trust/ik.ts:1-22,246]
- Task 4: minor (deferred): keyCommit's deriveBits parameter object is wrapped across multiple lines instead of the brief's single-line form (cosmetic only, values identical). [src/spaces/trust/canonical.ts:186-191]
- Task 5: minor (deferred): SeedIdentitySigner's doc comment claims the IK is derived from the in-memory seed, but the code prefers a cached session.identity when set and only falls back to deriving from the seed when it is not. [src/core/trust/IdentitySigner.ts:88-91,104 (diff hunk ~87-91,104)]
- Task 5: minor (deferred): The literal error message text is duplicated across the two SpaceTrustError('lookup-failed', ...) throw sites in IdentityDirectory.lookupMany. [src/core/trust/IdentityDirectory.ts:51,57]
- Task 5: minor (deferred): The test describe title still cites slice ruling S12, which the implementer's own report flags as an open question for the controller. [tests/core/trust/identity.test.ts:171]
- Task 6: minor (deferred): A client.kv write or delete on the reserved key `muhkoo.pins/*` stores a CRDT HLC ("001727…:00000:node"). That string is always greater than pad16(counter), so every later pin write gets applied:false. mutate then re-signs and re-POSTs a losing write 3 more times before it throws pins-write-failed, and resetMark cannot recover. This hits the user in every app, because the personal KV is shared across apps. The root cause is CP9's frozen hlc format. The guard (KvNamespace refusing reserved keys) belongs outside this task's files. Escalate to the whole-branch review. [src/core/trust/PinStore.ts:153-158 (with src/core/namespaces/KvNamespace.ts:326)]
- Task 6: minor (deferred): The globalThis.indexedDB accessor is outside the try. Chrome throws SecurityError from the getter in opaque-origin contexts, such as sandboxed iframes, so openTrustStore rejects instead of falling back to memory, which breaks the KI1 contract in its own doc comment. TrustContext.storeP then caches that rejection for the life of the Client, and every pin operation fails with a raw DOMException. [src/core/trust/trustStore.ts:29; src/core/trust/TrustContext.ts:37]
- Task 6: minor (deferred): A cross-tab race can lower the high-water mark. read puts max(counter, now) and mutate puts counter, both computed from values read earlier with no read-modify-write. If a sibling tab raised the shared IndexedDB mark in between, the put lowers it, which weakens rollback detection. The mutate half can be fixed additively. The read half is frozen by P5. [src/core/trust/PinStore.ts:102, :155]
- Task 6: minor (deferred): If indexedDB.open succeeds after the 2 s timeout, the late IDBDatabase connection is never closed, and onblocked is not handled. P15's eager open at page load makes the slow path more likely. [src/core/trust/trustStore.ts:34-40]
- Task 6: minor (deferred): fetchDoc maps every non-404 failure, including 401 and 403, to pins-stale with the message "retrying" and no detail or status. An expired session and a network failure look the same to callers and in logs. Passing the HTTP status in the error's detail field would fix it without contradicting the brief. [src/core/trust/PinStore.ts:73-74]
- Task 6: minor (deferred): A signed-out caller (no commitment) gets code pins-invalid, the same code as a document whose signature fails. A UI that picks its §9.1 copy by code would show "could not be verified". The risk is low in this slice (S8/P17 gate earlier), but the code is the brief's. [src/core/trust/PinStore.ts:56]
- Task 6: minor (deferred): Pin entries are looked up through the prototype chain (next[k] === undefined, entries[key]). For a lower-cased username of "constructor" or "__proto__", pin() always reports a conflict and get() returns Object. Task 9 treats a conflict as a changed identity, so that user fails closed permanently. Use Object.hasOwn or a null-prototype object; the format does not change. [src/core/trust/PinStore.ts:109, :118-119]
- Task 6: minor (deferred): memoryTrustStore.get returns the stored object itself without cloning, while put clones. A caller that mutates a returned value changes the stored mark in memory mode only, which differs from IndexedDB's copy semantics. [src/core/trust/trustStore.ts:22]
- Task 6: minor (deferred): Test gaps. No literal golden vector pins pinDocBytes, and it is a frozen format with no fixture vector. resetMark and pins-write-failed (retries exhausted) have no tests. The pad16 assertion compares against the function under test instead of "0000000000000001". The fake-timer test resets timers only when it passes. The persistence test never reopens the store. [tests/core/trust/PinStore.test.ts:22; tests/core/trust/trustStore.test.ts:5,22]
- Task 7: minor (deferred): Join-liveness gap: once trust is wired (Task 13), requestKey will await an unbounded directory.lookup HTTP call (via certFor/mintKeyCert/SeedIdentitySigner.key) before the join goes out, and Space.join()'s timeoutMs deadline only starts after requestKey() resolves, so a stalled identity lookup can stall the first join indefinitely. [src/spaces/SpaceKeyring.ts:203-217 (requestKey); src/core/trust/IdentitySigner.ts:33 (directory.lookup)]
- Task 7: minor (deferred): Doc-comment grammar: 'Present, every join request carries the IK certificate...' reads as a sentence fragment; should read 'When present, every join request carries...'. [src/core/namespaces/SpaceNamespace.ts:53 (SpaceNamespaceDeps.trust doc comment)]
- Task 8: minor (deferred): Several guards are never exercised by any test. No test adds an existing member (target-member), targets a reserved id, puts a genesis at seq > 0 (genesis-seq), or has a correctly signed non-member reach check (not-member). bad-member-ik, malformed and target-owner are never reached. The broken-chain test covers only prev, not seq or spaceId. The target-member line stops an add that would overwrite an existing member's IK, or demote the owner inside byId while ownerId stays. Deleting it passes all 16 tests. Fix: add a table test per reason code, plus seq and spaceId chain breaks. [src/spaces/trust/MembershipLog.ts:81,84,92-95,100,103,108; tests/spaces/trust/MembershipLog.test.ts:89-95]
- Task 8: minor (deferred): A malformed entry makes apply throw a TypeError instead of returning integrity. It throws when body is null, the op is unknown, or seq/at is not an integer, via entryHash→opBytes and checkGenesis reading b.appId. The impact is bounded by carry P3 (Task 11), and the brief is silent on this case. Fix: a try/catch returning {ok:false, integrity:'malformed'}. [src/spaces/trust/MembershipLog.ts:53,70-72]
- Task 8: minor (deferred): bad-member-ik checks the key's shape only (decodeRawP256). The server refuses an add whose memberIk fails importIk, an on-curve check (accelerator/src/durable-objects/space/mlog.ts:470). An honest server never appends such an entry, so the two cannot diverge in practice. The brief's code mandates decodeRawP256. [src/spaces/trust/MembershipLog.ts:94]
- Task 8: minor (deferred): A test title keeps the ruling id 'slice ruling S11'. IMPLEMENTER.md lets titles cite spec sections, not ruling ids. The brief mandates this test verbatim, so the controller can rename it or accept it. [tests/spaces/trust/MembershipLog.test.ts:101]
- Task 8: minor (deferred): LogMember is declared with mutable fields while its records are frozen at run time. A future write compiles and then throws at run time. Declaring the fields readonly, or returning Readonly<LogMember>, would catch it at compile time. No current or planned caller writes to these records (task-9 to task-16 briefs grepped). [src/spaces/trust/MembershipLog.ts:6,75,131,134]
- Task 8: minor (deferred): The checkpoint's lint output has 9 warnings. All are in files this task does not touch, and the report says they were there before. They are noise, not a T8 regression. [task-8-report.md:80-86 (eslint output)]
- Task 8: minor (deferred): The new doc comment promises that after an ok result 'a private log also has its owner', but that is false. A relay can sign its own private genesis with `by: null`; lpStr/TextEncoder encodes null as the string "null", so the signature verifies. apply then returns {ok:true} with unsupported === false and owner === null, and byId is keyed by null (ownerId = e.by at :87). In practice this is reachable only when the client holds no loghw mark, where P3 degrades the Space to unlogged, so no raw TypeError escapes. But Task 9 writes `log.owner!` on the strength of this comment. Fix: in checkGenesis, return "malformed" when `typeof e.by !== "string" || e.by === ""`. [connect/src/spaces/trust/MembershipLog.ts:24-25 (doc comment); :87-88 (ownerId = e.by)]
- Task 9: minor (deferred): A failed confirming sync rejects an append whose entry the server already stored. It rejects with a raw KeyringHttpError, which contradicts S4 ('remove() resolves {seq} once the entry is appended'); the UI reports failure, and a user retry becomes log-refused. Suggest catching the error, calling scheduleSync(), and resolving {seq: r.head.seq}. [/Users/matt/GitHub/muhkoo/connect/src/spaces/trust/LogSync.ts:219-221]
- Task 9: minor (deferred): append('genesis') retries a 409 by re-signing a genesis at head.seq+1. The real server refuses that (genesis-seq), and it surfaces as log-refused after a wasted sleep and sign. A 409 on a genesis should throw log-conflict without retrying. [/Users/matt/GitHub/muhkoo/connect/src/spaces/trust/LogSync.ts:188-212]
- Task 9: minor (deferred): The 'four 409s in a row' test never counts POSTs, so it would still pass with MAX_APPEND_RETRIES raised, and Review Focus 3's 'at most 3 retries' is unasserted. It also spends about 0.8 s in real jitter sleeps. Assert exactly 4 POSTs, and consider an injectable sleep. [/Users/matt/GitHub/muhkoo/connect/tests/spaces/trust/LogSync.test.ts:63-67]
- Task 9: minor (deferred): After the final (fourth) 409, append sleeps 50-250 ms before throwing log-conflict. Skip the sleep on the last attempt. [/Users/matt/GitHub/muhkoo/connect/src/spaces/trust/LogSync.ts:210-212]
- Task 9: minor (deferred): The mark re-read before the put is compared by seq only. A mark another tab wrote at the same or a lower seq, whose hash differs from this view's hashAt(cur.seq) (a split view shown to two tabs), is overwritten, and the fork evidence is lost. Checking cur && log.hashAt(cur.seq) !== cur.hash and treating it as a fork would close this. Not a regression: the pre-fix write was unconditional. [src/spaces/trust/LogSync.ts:179-180]
- Task 10: minor (deferred): Space.rotate() refuses only when logEnabled. After a log-missing sync (logEnabled false, integrity broken), a signed Space still calls /keyring/rotate, which advances the server epoch, and mints and persists a new key. That is an epoch with no EpochCommit, which S4 was meant to prevent. Deviation 2's wrap filter only suppresses the member wraps. The test 'a rotation on a broken, unlogged view re-wraps to no member' never asserts transport.rotations (it would be [1]), so it blesses the rotation. Fix (needs a controller ruling, implementer Concern 2): extend the guard to `ls?.logEnabled || ls?.integrity.broken`, keep the D2 filter, and assert rotations equals []. [src/spaces/Space.ts:658; src/spaces/SpaceKeyring.ts:383-392; tests/spaces/Space.membership.test.ts:128]
- Task 10: minor (deferred): SpaceKeyring.rawKey(epoch) repeats keyForEpoch(epoch)'s body verbatim (both return this.keys.get(epoch)). The brief requires the name, not a second copy: have it delegate to keyForEpoch, or document it as an alias, so the public class does not grow two independent raw-key accessors. [src/spaces/SpaceKeyring.ts:193-195 (vs 184)]
- Task 11: minor (deferred): Deviation 2 (`this.disconnect()` in place of `channel?.disconnect()`) clears catchUpUnsub and closes and nulls peerNet. Neither is restored when the same Space object reconnects after re-admission: catch-up is registered only in the `!this.channel` first-open branch, and P2P is attached only in build(). A re-admitted Space silently loses offline catch-up and its P2P mesh. [connect/src/spaces/Space.ts:319,324 (registration only at :343-384)]
- Task 11: minor (deferred): The P3 tolerance also applies to failures after the server has served a log head. PinStore pins-missing, pins-rollback and pins-invalid, IdentityDirectory lookup-failed, and MembershipLog TypeErrors each become a single warn, and a Space the server affirmatively reported as logged opens unlogged: the wrap filter is permissive and there is no integrity banner. This adds nothing beyond what a 500 already allows, but the P3 rationale ('a log-route outage') is narrower than the code. Rethrowing pins-* without a mark would contradict P3's literal 'only if a mark', so this needs a controller call. [connect/src/spaces/Space.ts:281-287]
- Task 11: minor (deferred): evaluateAdmission reads `m = ls.member(me)` before `await identityKeyRaw()`. A stale evaluation can finish after a newer one set not-member and then set 'requesting' (a state flicker; the socket stays down). Fix: re-read the member after the await, or use a generation counter. [connect/src/spaces/Space.ts:316-327]
- Task 11: minor (deferred): A 401 from GET /keyring/log on an UNLOGGED Space sets admission 'locked', and nothing clears it, because evaluateAdmission returns early at !logEnabled. A retried connect() on the same object after the session refreshes succeeds, but admission stays 'locked', so web's P24 LockedBanner would render over a working channel. This is not S8's seed-lock (deps.locked is false). Fix: after a successful sync, reset 'locked' when !deps.locked. [connect/src/spaces/Space.ts:278-280,315]
- Task 11: minor (deferred): The brief-verbatim test 'a member connects, requests with a certificate and turns keyed' never asserts keyed, and it passes before the change (report RED run). Add an admit, pullKeys and `expect(bob.admission).toBe('keyed')`. [connect/tests/spaces/Space.admission.test.ts:33-42]
- Task 11: minor (deferred): failureCode duplicates the code expression in LogSync.scheduleSync, and the {spaceId, code, message} warn payload is built three times. One shared helper would keep the log shape consistent. [connect/src/spaces/Space.ts:283-287,296-300,1159-1161; connect/src/spaces/trust/LogSync.ts:98-103]
- Task 11: minor (deferred): Two overlapping connect() calls both pass `!this.channel`, both await a network log sync and then both build a channel. The race already existed across `await buildUrl()`; the new log round trip widens it. [connect/src/spaces/Space.ts:342-356]
- Task 11: minor (deferred): The replayer rebuilds any Space whose admission is 'locked'. It is meant for Spaces built without a seed, but it also catches a seeded Space that went 'locked' because GET /keyring/log returned 401. For that Space, get() builds a whole new Space (keyring, LogSync, and a PeerNetwork that spawns a Worker) and overwrites openSpaces, orphaning the app's handle. While the server session stays expired, every reconnect-drain leaks another Space. Once the session heals, the replayer's copy stays connected next to the app's own Space, which also heals in place: two sockets and two P2P meshes under the same deviceId. Review M4 (a healed unlogged Space stays 'locked') means a healthy connected Space gets duplicated. Before this fix, the replayer reused the Space. Fix: rebuild only Spaces built without a seed, e.g. `space.admission === "locked" && !space.keyring`. [/Users/matt/GitHub/muhkoo/connect/src/core/namespaces/SpaceNamespace.ts:103]
- Task 11: minor (deferred): Every channel build now resets rawWired and attaches every entry in the lasting listeners registry, which widens the known connect() race (review M7). If two concurrent connect() calls (app plus offline replayer, after a re-add or at boot with queued frames) both pass the build check while admitByLog/buildUrl is still pending, both channels get wireFanout and the app's raw listeners. The first channel is never disconnected. Every decoded message and raw event then fires twice, and a later log drop closes only the second channel. Before this fix, the losing call skipped wireFanout and pending had already been emptied, so each event arrived once. Fix: keep the in-flight connect() promise in a field and have concurrent calls await it. [/Users/matt/GitHub/muhkoo/connect/src/spaces/Space.ts:383-388]
- Task 12: minor (deferred): In socket.onclose, DISCONNECTED is emitted before the terminal branch sets autoReconnect=false. A consumer's DISCONNECTED listener that calls the new public resume() synchronously has autoReconnect turned back off by onclose. The reconnect still dials, but the transport then runs with auto-reconnect off, so the next network drop is never recovered. Space is unaffected: it resumes from a setTimeout after an awaited probe. Fix: set autoReconnect=false before emitting for a terminal code. The brief gives this onclose body verbatim. [/Users/matt/GitHub/muhkoo/connect/src/transport/WSTransport.ts:209-213]
- Task 12: minor (deferred): After a terminal 4403 whose probe answers 404/2xx/5xx/network, an explicit connect(), join() or create() goes straight to this.channel.connect(), because the channel is neither spent nor denied. reconnectAttempts is 0 after a terminal close (WSTransport.ts:157), so the transport skips urlProvider and redials its last URL, whose ticket is already spent. The server refuses it as anonymous with a 4403, which costs one probe and one socket per explicit app call, outside the one-resume-per-60 s cap. No state is corrupted. Fix: defer to the pending resume, route a stopped transport through resume(), or have WSTransport.connect() use urlProvider whenever a socket has existed. [/Users/matt/GitHub/muhkoo/connect/src/spaces/Space.ts:397-464]
- Task 12: minor (deferred): terminalCloseCodes is set on every Space, but the onNotMemberClose handler is wired only inside the if (this.deps.keyring) block. A keyring-less Space constructed directly would treat a 4403 as terminal, and nothing would probe or resume it. This is unreachable today: both new Space() sites are in SpaceNamespace, the unlocked one always passes a keyring, and the server refuses only log-enabled private Spaces. The brief mandates both placements. [/Users/matt/GitHub/muhkoo/connect/src/spaces/Space.ts:434,452-455]
- Task 12: minor (deferred): WSTransport.resume() after disconnect() has no test, though both doc comments advertise it (WSTransport.ts:241, BroadcastChannel.ts:161). Every resume() test starts from a terminal close. [/Users/matt/GitHub/muhkoo/connect/tests/transport/WSTransport.test.ts:936-1020]
- Task 12: minor (deferred): The fix adds unplanned public API. HttpClient and KeyringClient are both exported, so HttpClient.fetchWithRecovery and KeyringClientDeps.fetchWithRecovery? are new public members. api-surface.txt lists names only and cannot show them. Both are additive and nothing is released (S1). Task 13's '`refuse=close` and a terminal 4403' CHANGELOG paragraph should mention them in one sentence, or they should be marked @internal. [src/core/HttpClient.ts:162-168; src/spaces/KeyringClient.ts:35-40 (api-surface.txt:273, :278, :109)]
- Task 13: minor (deferred): Delegation arrow functions in client.trust use terse single-letter params (u, id) instead of the descriptive names (username, spaceId) used in the declared type and in neighboring chatKeyStore delegations [src/core/Client.ts:321-322]
- Task 14: minor (deferred): Mount effect calls getClient() twice more instead of reusing the already-bound `client` local variable for the new setLocked(...) line [src/auth/AuthContext.tsx (mount effect, ~diff line 104, the `setLocked(!!getClient().auth.zk.token && getClient().auth.zk.seedBase64 === null)` line)]
- Task 14: minor (deferred): yarn add file:../connect left the old @muhkoo/connect@0.14.0-alpha.9 lockfile entry in place alongside the new file:../connect entry, unpruned [yarn.lock:1922 (stale) and yarn.lock:1938 (new entry added by this task)]
- Task 15: minor (deferred): LockedBanner's hasPasswordFactor() failure is silently swallowed (.catch(() => {})) [src/components/LockedBanner.tsx:125]
- Task 15: minor (deferred): Test 3 uses a fixed cy.wait(500) settle delay before its negative assertion, a small flake surface the report itself already flags [cypress/e2e/chat-locked.cy.ts:97]
- Task 16: minor (deferred): The row's sx px:2 overrides the paddingRight:48 that MUI 6.5 ListItem reserves for secondaryAction. With usernames of roughly 12 or more characters in the 260 px rail, the role chip and warning icon slide under the absolutely positioned remove button. Fix: use pl:2 only, or add pr:6 when the button is shown. [web/src/components/MembersSidebar.tsx:127-142]
- Task 16: minor (deferred): 'void resetSpaceTrust()' has no catch. resetSpacePins writes the personal-KV pin map and IndexedDB and can reject, which leaves an unhandled rejection and no user feedback. Add .catch(alert) as onRemoveMember does. [web/src/routes/ChatPage.tsx:222]
- Task 16: minor (deferred): The LockedBanner shown for admission==='locked' while the session is unlocked (a 401 on log sync, or an IK mismatch) does not recover through an in-place password unlock. 'enabled' does not change and nothing bumps attempt, so the Space is never re-opened and the banner persists until reload. [web/src/routes/ChatPage.tsx:189]
- Task 16: minor (deferred): AddMemberDialog stays open across a channel switch (back/forward), and addMember reads spaceRef.current at submit, so the add can land in a different channel. The dialog also keeps a stale error and username after Cancel. Fix: close it on a roomName change and reset the error on open. [web/src/routes/ChatPage.tsx:61,368]
- Task 16: minor (deferred): Plan-mandated copy: 'Couldn't verify members right now; retrying.' is shown for lookup-failed, but nothing in the dialog retries; the user must press Add again. [web/src/components/AddMemberDialog.tsx:22]
- Task 16: minor (deferred): The header member count uses the live roster (renderedMembers.length) while the sidebar counts the signed list. The owner screenshot shows 2 against 3. [web/src/routes/ChatPage.tsx:181]
- Task 16: minor (deferred): The comment cites 'design §3.8' for the add/remove role rules. §3.8 is Genesis; the rules are in §3.5's entry table. [web/src/components/MembersSidebar.tsx:11]
- Task 16: minor (deferred): isPrivate is not reset after a create, so the next channel created in the same session defaults to private. [web/src/components/RoomChooserDialog.tsx:39]
- Task 16: minor (deferred): The checkpoint is not green, though not because of T16. There are 11 pre-existing Cypress failures (landing/login-form/register-form, identical to Task 15's), pre-existing build warnings (chunk size, crypto/os externalized) and the pre-existing set-state-in-effect lint error in the reset block. The controller should retire them or record them as accepted. [web/cypress/e2e/{landing,login-form,register-form}.cy.ts]
- Task 16: minor (deferred): The new private-exists message 'A channel with that name already exists.' can go stale. The dialog stays mounted, and `error` is cleared only when Create is pressed again. The message therefore persists after the user turns Private off (where Create would now join), edits the name, or cancels and reopens. The stale-error mechanism predates the fix; the fix only adds a common path into it. Non-blocking: clearing `error` when the name or toggle changes would fix it. [web/src/components/RoomChooserDialog.tsx:67 (error cleared only at :58; dialog kept mounted at ChatPage.tsx:360)]
- FINAL: AddMemberDialog keeps typed name/role/error across a channel switch (web AddMemberDialog.tsx:46-49).
- FINAL: CHANGELOG omits KeyStore public members (forget/markVaultBacked/isVaultBacked/replaceOwnKeyPair/...); markVaultBacked has no src caller.
- FINAL: CHANGELOG calls files-only Spaces "unaffected" but an unlocked messaging:false Space is now keyring-less (join/create throw).
- FINAL: genesis confirming-sync failure + connect sync failure opens a new private channel as unlogged for that open (no leak: allowlist = creator).
- FINAL: SpaceNamespace.loadIdentity exports ECDH/ECDSA publics across two awaits; a concurrent DM mint could split them (sub-project 4).
