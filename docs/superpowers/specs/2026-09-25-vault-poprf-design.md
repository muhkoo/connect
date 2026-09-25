# Spec B — Vault: verifiable OPRF, key custody, and password stretching

**Date:** 2026-09-25
**Finding:** C4 (OPRF runs in RFC 9497 base mode 0x00)
**Repos:** `connect`, `accelerator`; `k2` is **retired** by this work
**Baseline:** `connect` `0.14.0-alpha.8`; `accelerator` with `OPRF_KEY_VERSION_PER_USER = 2` live

Companion: **Spec A** (`2026-09-24-dm-protocol-design.md`) — the DM protocol. A and B share no code,
no file and no test. They are coupled only by release lockstep.

---

## 1. The finding, and what actually closes it

`src/auth/oprf.ts` uses `ristretto255_oprf.oprf` — RFC 9497 **base mode 0x00**, which carries no
proof — and `oprfFinalize` verifies nothing. A server that answers `evaluated = blinded` (i.e. k=1)
collapses the wrap key to a deterministic function of the OPRF input. For the gated factors that
input is `SHA-256("muhkoo/factor:email:v1:<username>:<email>")`, so the wrap key becomes a function
of two public strings.

`src/auth/oprf.ts:12-13` states the guarantee this destroys: *"a stolen vault blob is NOT
offline-crackable; every guess costs a round-trip to a rate-limited server endpoint."*

### 1.1 Why the obvious fixes don't work

**VOPRF (mode 0x01) alone does not close it.** A DLEQ proof only binds an evaluation to a public key
the client already trusts. The accelerator derives a **distinct secret per account**
(`oprfDeriveKeyForUser`, version 2), so there is no single public key to pin — and if the server
hands over `pk_user` at enrollment, it simply picks a matching keypair and produces an honest proof
for a chosen evaluation.

**Certifying `pk_user` with a deployment signing key does not close it either.** That key would be
provisioned into the same `env` as `OPRF_KEY`, by the same `scripts/push-secrets.mjs` loop, into the
same Worker. On workerd there is no separation between running code and reading bindings, so whoever
can read the seed can also mint a certificate over `pk = g^1`. It defends a TLS/DNS attacker and
nothing else. This was the previously-approved design and it is **rejected**.

### 1.2 What does close it: POPRF with one pinned deployment key

Verified empirically against the installed `@noble/curves` 2.2.0:

```
honest        -> 64-byte output
k=1 downgrade -> REJECTED  (proof verification failed)
rogue keypair -> REJECTED  (proof verification failed)
alice != bob output (per-account separation): true
```

`ristretto255_oprf.poprf` is a **factory**. `poprf(info)` returns
`{generateKeyPair, deriveKeyPair, blind, blindEvaluate, blindEvaluateBatch, finalize, finalizeBatch, evaluate}`.

```
client:  const { blind, blinded, tweakedKey } = P.blind(input, PINNED_PK)
server:  const { evaluated, proof }           = P.blindEvaluate(secretKey, blinded)
client:  const out = P.finalize(input, blind, evaluated, blinded, proof, tweakedKey)
```

The property: **the client derives `tweakedKey` itself** from a build-time pinned deployment public
key, so the server never names the key its own proof is checked against. A server with a different
secret fails verification.

Per-account separation is preserved, from the POPRF `info` tweak rather than from a per-account
secret — so the property `oprfDeriveKeyForUser` was built for (an evaluation under username A is
useless against B) survives with **one** deployment secret.

**Two distinct `info` slots exist and must not be conflated:**

| Slot | Value | Who uses it |
|---|---|---|
| `deriveKeyPair(seed, keyInfo)` | fixed label `"muhkoo-poprf-v1"` | server only, to derive the deployment keypair from `OPRF_KEY` |
| `poprf(info)` factory | per-request tweak, see §2.2 | **both** sides; must match exactly or the proof fails |

---

## 2. Client changes (`connect`)

### 2.1 Blast radius

OPRF is on the **primary password-login path**, not a recovery corner:

```
login(username, password)   AuthNamespace.ts:154
unlock(password)            AuthNamespace.ts:331
  └─ tryUnlockSeed()        :337 / :867
       └─ passwordWrapKey() :875 / :894
            └─ oprfEvaluate()  :851
```

Nine call sites: `login`, `unlock`, `register` → `enrollPasswordFactor`, `changePassword`,
`migrateLegacyPasswordFactor`, and four gated email/Google enroll+recover paths
(`AuthNamespace.ts:405-407, :438-440, :467-469, :489-491`).

Unlike Spec A's findings, this area **does** have coverage (`tests/auth/vault*`, and
`tests/client/client.test.ts` stubs `/api/auth/oprf`), so existing tests will go red — §6.

### 2.2 The `info` tweak

```
password factor:  info = "muhkoo/poprf:password:v1:" + username.toLowerCase()
email factor:     info = "muhkoo/poprf:email:v1:"    + username.toLowerCase()
google factor:    info = "muhkoo/poprf:google:v1:"   + username.toLowerCase()
```

The client lowercases. The server lowercases independently and MUST NOT take the tweak from the
request body — a client-chosen tweak would let a caller request an evaluation under another
account's tweak.

### 2.3 Pinning without a bypass flag

Pin a **map** of origin → deployment public key, resolved from the configured `baseUrl`
(`Client.ts:89`, `:205`). An unknown origin is a hard error.

**Do not copy `CircuitIntegrity.allowUnpinned`** (`circuitIntegrity.ts:62-70`). That escape hatch is
defensible for circuit digests; here it becomes the attack — an app that sets `baseUrl` also sets
`allowUnpinned`, and the OPRF silently degrades to unverified. Self-hosting is supported instead by
an explicit injected key:

```ts
interface ClientOptions {
  // …
  /** Deployment POPRF public key for a self-hosted accelerator, base64.
   *  Supplying this is an explicit trust decision: it replaces the pinned key
   *  for the configured baseUrl. There is no flag that disables verification. */
  vaultPoprfPublicKey?: string;
}
```

Never a boolean named `allow*`. `tests/client/client.test.ts` uses this field rather than a bypass.

### 2.4 The two-domain fold is no longer a trust split

`gatedFactor.ts:56-60` folds `out1` (accelerator) and `out2` (K2) on the stated grounds that *"no
single server-side compromise can derive the wrap key offline."* That claim is **already false**: the
accelerator relays `evaluated2` verbatim (`VaultDO.ts:577`) and the client folds it with no
verification, so the accelerator alone can forge K2's half today.

After the fold-in (§3.2) both halves come from one deployment key, so the two-evaluation shape buys
**domain separation, not trust separation**. Keep the shape — it preserves the wire format and makes
re-splitting later a key-provisioning change rather than a protocol change — but derive the halves
from two distinct tweaks on the same key:

```
out1: info = "<factor tweak>:d1"
out2: info = "<factor tweak>:d2"
```

**Rewrite `gatedFactor.ts:6-9`.** Replacement claim: *a compromised accelerator can attempt offline
password recovery from a stolen vault blob, at scrypt cost. The evaluator-Worker boundary (§3.2)
protects the key from app-level compromise of the accelerator only.*

### 2.5 Password stretching

`vault.ts:25` is `{ N: 1 << 15, r: 8, p: 1, dkLen: 32 }`. Measured on an M-series laptop, node 22,
median of 7 warmed runs:

| Params | Time | Memory |
|---|---|---|
| `N = 2^15` (current) | 47 ms | 32 MiB |
| **`N = 2^16` (chosen)** | **91 ms** | **64 MiB** |
| `N = 2^17` | 186 ms | 128 MiB |

**Chosen: `N = 2^16`.** The binding constraint is memory, not time: this runs in a browser on every
login, and 128 MiB of transient allocation is a plausible OOM on low-end mobile — which would
present as unexplained login failures on exactly the devices least able to report them. 2^16 doubles
the work factor at 64 MiB.

This matters because once one party holds the OPRF key, password security is **scrypt-bound**. A key
holder can grind offline; verified:

```
offline evaluate() == interactive result: true
```

POPRF prevents the server *forcing* the wrap key to a public function. It cannot prevent a key holder
evaluating candidates.

### 2.6 `kdfParams` must be recorded per factor

`passwordPreHash` (`vault.ts:33-35`) is computed **client-side, before** the OPRF and independently
of it. So changing `N` breaks every existing wrap on its own, regardless of the OPRF mode. This is a
second straddle, not a detail of the first.

Add to `FactorRecord` (§3.3):

```ts
kdfParams?: { N: number; r: number; p: number; dkLen: number };
// ABSENT ≡ { N: 2**15, r: 8, p: 1, dkLen: 32 }
```

- **On read**, `tryUnlockSeed` already calls `vaultRead` before `passwordWrapKey`, so the params ride
  that existing response — no extra round trip. The client stretches with the params the factor
  records, not with its current constant.
- **On write**, the client sends its chosen params and the server stores them verbatim.

That last point deliberately departs from the convention `oprfKeyVersion` establishes
("SERVER-STAMPED at write time and never accepted from the client"), so the reasoning must be
explicit: `oprfKeyVersion` is a **key selector** — a client able to claim version 1 could mint itself
a source of global-key evaluations, which is the attack per-user keys close. `kdfParams` selects no
key and grants no oracle; weak params weaken only the account of the caller who already holds the
seed at enrollment time. Conversely, letting the *server* choose would let a hostile accelerator
advertise weak params to every new account. So the client chooses and **ignores any server-advertised
value.**

---

## 3. Server changes (`accelerator`)

### 3.1 Key version 3

Add beside the existing constants (`services/oprf.ts:100-102`):

```ts
export const OPRF_KEY_VERSION_GLOBAL  = 1;   // deployment-wide key, mode 0x00
export const OPRF_KEY_VERSION_PER_USER = 2;  // per-account key,      mode 0x00
export const OPRF_KEY_VERSION_POPRF   = 3;   // deployment key + POPRF tweak, mode 0x02
export type OprfKeyVersion = 1 | 2 | 3;
```

`oprfKeyVersionFor` (`VaultDO.ts:418-424`) returns `3` only when **no factor of that type exists**.
Versions 1 and 2 keep evaluating in mode 0x00 **forever** — the existing branch structure already
expresses exactly this and extends unchanged.

`oprfDeriveKeyForUser` survives to serve version-2 factors. Its anti-cross-account property is
provided at version 3 by the POPRF tweak instead.

**Teach the repair validator** at `VaultDO.ts:940-941` the new number, or accounts touched by this
rollout cannot be re-stamped via `POST /factor/keyversion`.

### 3.2 Key custody: fold K2 into an evaluator Worker

`k2` is retired as a separate Cloudflare account. The OPRF secret moves to a **dedicated evaluator
Worker** in the accelerator's account, reached by service binding, with `OPRF_KEY` bound **only** to
that Worker and removed from the main accelerator's bindings.

What this buys, and what it does not:

| Boundary | Stops | Does not stop |
|---|---|---|
| Separate evaluator Worker, same account | app-level compromise of the accelerator (RCE, injection, a bad dependency, a bug that dumps `env`) cannot read the key | deploy credentials for the account; the operator |
| (former) separate `k2` account | leak of one account's deploy credentials | an operator holding both — which was always the case |

The former split is abandoned **deliberately**. It was never true against an operator holding both
accounts, and §2.4 shows it is currently false outright.

Evaluator contract:

```
service binding: VAULT_OPRF
POST /evaluate   { blinded: string, info: string, version: 1 | 2 | 3 }
                 → { evaluated: string, proof?: string }   // proof present iff version 3
```

- Caller authentication is the service binding itself; the evaluator is not internet-routable.
- The evaluator holds `OPRF_KEY` and derives: version 1 → `oprfDeriveKey`, version 2 →
  `oprfDeriveKeyForUser`, version 3 → `deriveKeyPair(seed, "muhkoo-poprf-v1")` + `poprf(info)`.
- `info` is passed **from the DO, derived server-side from the authenticated username** — never from
  the client request body.
- Rate limiting stays where it is, on the per-user `VaultDO`. The evaluator is a key boundary, not a
  throttle.

Note `k2/src/index.ts:19-21` records that rotating `K2_OPRF_KEY` bricks every enrolled gated factor.
A mode change *is* a rotation, which is why gated factors also go through version 3 via §3.1 rather
than being re-keyed in place.

### 3.3 `FactorRecord`

```ts
oprfKeyVersion?: OprfKeyVersion;                                    // existing; ABSENT ≡ 1
kdfParams?: { N: number; r: number; p: number; dkLen: number };     // new; ABSENT ≡ N=2^15,r=8,p=1,dkLen=32
```

`kdfParams` is returned by `vaultRead` alongside `wrap`/`iv`. The existing `mintVersionToken`
eval→write binding (`VaultDO.ts:434`, used at `:524`, `:593`, `:729`) MUST cover `kdfParams` as well
as the version, for the reason §5 gives.

---

## 4. Making the failure loud — ships first, alone

This is the highest-risk part of C4 and it ships as its own release, **before** any mode change.

`AuthNamespace.ts:154-157` is:

```ts
const vaultSeed = await this.tryUnlockSeed(username, password);
const seed = vaultSeed ?? await deriveMasterSeedFromPassword(username, password);
```

and `tryUnlockSeed` returns `null` on an unwrap failure (`:881`, *"factor present but won't unwrap →
wrong password, or a decoy"*). So any protocol mismatch silently becomes the legacy PBKDF2-200k
derivation. Traced:

- **Vault-native account** (seed from `randomSeed()`, `AuthNamespace.ts:120-121`): the legacy
  derivation yields a different seed, hence a different commitment, and ZK auth fails. The user is
  locked out with a "wrong password" error.
- **Legacy-migrated account** (vault seed == legacy seed): login *succeeds*, and
  `migrateLegacyPasswordFactor` (`:163` → `:173` → `enrollPasswordFactor:894`) **overwrites** the
  vault factor — re-wrapping under the new protocol while the account continues to depend on the
  password-derived seed. The account keeps working but has silently lost the vault's independence
  from the password, which is the property H5 exists to remove.

`unlock` (`:331`) differs in one useful way and is worth understanding separately: it compares the
derived commitment against the session's before adopting the identity (`:341-343`), so a vault-native
account gets a clean *"incorrect password (commitment mismatch)"* rather than a confusing ZK auth
failure. But the legacy-migrated case is identical — the commitment matches, so `:347` reaches
`migrateLegacyPasswordFactor` and the same silent overwrite happens. The commitment check limits the
damage; it does not prevent it. Both entry points need step 4 below.

Required, in this order:

1. **Protocol field on the request.** `AuthClient.oprfEvaluate` / `oprfEvaluateGated`
   (`AuthClient.ts:137`, `:147`) carry `oprfProtocol: 0 | 2`.
2. **`VaultDO.handleOprf` compatibility rule.** An **absent** field means legacy and is answered in
   mode 0x00, normally. A **present but unsupported** value is `409`. This distinction matters: every
   already-published client — `0.14.0-alpha.8` and earlier, cached browser bundles, version-pinned
   apps — sends no field, and 409-ing those is a login outage. Absent stays accepted until the last
   supported client that omits it is retired; that window is a release decision, not a code one.
3. **A typed error that is not swallowed.** `VaultProtocolMismatchError` is thrown by
   `passwordWrapKey`/`tryUnlockSeed` on a 409 or a proof-verification failure, and is **not** caught
   into the `?? deriveMasterSeedFromPassword` branch. `login` and `unlock` surface it.
4. **Gate the overwrite.** `migrateLegacyPasswordFactor` must not run when the unwrap failed for a
   protocol reason — only when the account genuinely has no password factor. Today it cannot tell
   those apart.

---

## 5. Release procedure

`services/oprf.ts:68-98` documents the procedure for the version-2 rollout and labels it
**REQUIRED, NOT ADVISORY**. It applies unchanged to version 3, and the reason is worth restating
because it is the failure that bricks accounts:

> An evaluation and the write that stores its wrap are two separate requests and can land on
> different code. Eval on old code uses the old key; write on new code stamps version 3. The wrap is
> then sealed under one key and recorded as another, so it never opens again — and the write returned
> 200 with nothing logged. On an account with no other factor that is an **unrecoverable account**.

Therefore:

1. Deploy in a low-traffic window. The exposed gap per user is their own eval→write interval,
   normally sub-second, extended by `enrollPasswordFactor`'s three retries over ~1.2 s.
2. **One atomic version flip.** No staged or canary rollout that leaves old and new code both serving
   registrations.
3. Watch new registrations for "cannot sign in right after registering" for the following hour.
4. `POST /factor/keyversion` on the user's `VaultDO` (operator credential, `ADMIN_API_KEY`) re-stamps
   a slipped record. It rewrites one integer and never touches `wrap`/`iv`, so it cannot itself
   destroy a seed.

**`kdfParams` has the same eval→write hazard** and is why §3.3 requires the version token to cover
it: a wrap stretched at 2^15 but recorded as 2^16 never opens again. Same window, same atomicity,
same repair path.

Order of releases:

| # | Release | Repos | Note |
|---|---|---|---|
| 1 | §4 loud failure — protocol field, typed error, gated overwrite | connect + accelerator | Absent field still answered normally. No behaviour change for existing users. |
| 2 | §3.2 evaluator Worker; `OPRF_KEY` removed from the main Worker | accelerator | Pure custody move, no protocol change, independently revertable. |
| 3 | §3.1 version 3 + §2 client POPRF + `N = 2^16` | connect + accelerator | The atomic flip. Follow §5 exactly. |
| 4 | Docs: rewrite `gatedFactor.ts:6-9` and the vault section of `crypto-architecture.md` | docs | Must not lag release 3 — the old claim is false the moment K2 folds in. |

### 5.1 The CLI is affected, by the scrypt change

The CLI has no OPRF or scrypt code of its own (`grep -rniE 'oprf|scrypt' cli/src` is empty), so
nothing there needs editing for the protocol change. But it **drives vault unlock through the SDK**,
and it is already rate-limit sensitive:

- `cli/src/lib/mount.js:2023` — *"One process means ONE vault unlock, which is the practical reason
  this exists"*
- `cli/src/commands/vfs.js:121-123` — *"Unlocking the vault … is a vault read, and a loop over a
  dozen projects trips the auth rate [limit]"*

So `N = 2^16` doubles the CLI's unlock cost on a path whose author already found the rate limit. Two
consequences: measure `mount` and a multi-project `vfs` loop on the release-3 branch before shipping,
and if the single-unlock-per-process assumption at `mount.js:2023` is ever relaxed, the scrypt cost
lands per invocation.

Beyond that, the coupling is the `@muhkoo/connect` version pin and the standing lockstep rule applies
to the version number.

> **Baseline note.** Committed `main` is `0.14.0-alpha.8`. The working tree carries an uncommitted
> bump to `0.14.0-alpha.9` belonging to in-flight VFS work, and `cli/package.json` already pins
> `0.14.0-alpha.9`. Release numbering for this spec starts from whatever has landed by then.

---

## 6. Tests

Existing tests that go red, and what to do:

- **`tests/client/client.test.ts`** — `:138-146` pins the exact register call sequence, so any new
  auth leg fires it; `:108-114` stubs `/api/auth/oprf` with mode-0x00 `oprfBlindEvaluate` and no
  proof; `:37`'s `OPRF_SERVER_KEY` changes derivation under the new mode. **Rewrite, do not patch** —
  the stub must become a POPRF evaluator keyed to the pinned test key injected via
  `vaultPoprfPublicKey` (§2.3).
- **`tests/auth/vault*`** — audit the scrypt params in every fixture; any hard-coded wrap produced at
  `N = 2^15` needs a `kdfParams` stamp or it stops opening.

New:

- **Downgrade rejection.** `evaluated = blinded` with a valid-looking proof is rejected under the
  pinned key. This is the C4 regression test and it must fail before the change.
- **Rogue keypair.** A server evaluating with its own keypair and proving honestly against it is
  rejected.
- **Per-account separation.** An evaluation obtained under `info` for `bob` does not produce `alice`'s
  output.
- **Straddle.** A version-1 and a version-2 factor both still open after the flip; a version-3 factor
  opens only via POPRF.
- **`kdfParams` straddle.** A factor stamped `N = 2^15` opens with the new client; a new factor is
  stamped `2^16`; a factor whose recorded params disagree with the wrap fails loudly rather than
  falling through to legacy.
- **Loud failure.** A 409 raises `VaultProtocolMismatchError`; `login` does **not** fall through to
  `deriveMasterSeedFromPassword`; `migrateLegacyPasswordFactor` does not run.
- **Absent protocol field** is answered in mode 0x00 (the back-compat rule in §4.2).
- **Self-hosting.** An unknown `baseUrl` origin with no `vaultPoprfPublicKey` is a hard error; with
  one supplied, verification uses it.

Before declaring done: `yarn build && REQUIRE_BUILD_ARTIFACTS=1 yarn test:unit`. Any new exported
name (`VaultProtocolMismatchError`) lands in both `api-surface.txt` and `api-surface.workers.txt` at
the repo root and must be regenerated with `UPDATE_API_SURFACE=1` and reviewed.

---

## 7. Residual risk

1. **A key holder can still grind offline.** POPRF stops forced downgrade, not evaluation. With one
   holder, password security is scrypt at `N = 2^16`. Mitigated, not eliminated.
2. **A malicious operator is out of scope.** We hold the infrastructure; no arrangement of keys
   inside our own accounts changes that. The achievable goal, and what §3.2 delivers, is that an
   app-level compromise of the accelerator cannot read the OPRF key.
3. **Deploy-credential compromise gets both halves.** This is the property the `k2` account nominally
   provided and this design gives up. Recovering it means a holder outside the account's deploy path;
   recorded here as a known, accepted gap.
4. **The absent-protocol-field window is a downgrade surface.** While absent is answered in mode
   0x00, an attacker who can strip the field from a request downgrades that evaluation. It is closed
   only when absent becomes a 409, which requires retiring the last client that omits it. Track the
   date.

---

## 8. Decision log

| Decision | Chosen | Rejected |
|---|---|---|
| Mechanism | POPRF mode 0x02, one pinned deployment key | VOPRF 0x01 (no single key to pin); deployment signing key certifying `pk_user` (sits inside the adversary) |
| Per-account separation | POPRF `info` tweak | `oprfDeriveKeyForUser` at v3 (incompatible with a pinned key) |
| K2 | Fold into a dedicated evaluator Worker, same account | Keep the separate account (never a boundary against an operator holding both); leave as-is (claim is already false) |
| scrypt | `N = 2^16` — 64 MiB, 91 ms | `2^17` (128 MiB — mobile OOM risk); `2^15` (no improvement) |
| `kdfParams` authority | Client chooses, server stores verbatim | Server-stamped (lets a hostile server advertise weak params) |
| Migration | Version 3 straddle; 1 and 2 in mode 0x00 forever | Forced re-enrollment (locks out vault-native accounts) |
| Absent protocol field | Answered as legacy | 409 (immediate login outage for every published client) |
| Two-domain fold | Retained as domain separation, honestly labelled | Removed (loses the wire format and the option to re-split) |
