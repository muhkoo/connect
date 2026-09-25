# Spec A — DM protocol: authenticated handshake, key schedule, recipient scoping

**Date:** 2026-09-24
**Findings:** C2 (unauthenticated handshake), C3 (DM fan-out), H1 (ratchet key schedule)
**Repos:** `connect`, `accelerator`
**Baseline:** `connect` `0.14.0-alpha.8` @ `15f89f8`; suite green (54 files, 550 tests)

One spec, because the three findings share a single wire frame. Splitting them was tried and
produced a circular dependency: H1's key schedule consumes an ephemeral and a nonce that only C2's
frame introduces.

Companion specs: **Spec B** — POPRF + vault key custody (no shared code; release lockstep only).
**Spec C** — `StorageCipher` key-binding (independent hardening; see §9.3 for why it is *not* a
prerequisite here, correcting an earlier plan).

---

## 0. Pre-work: the outage hotfix

Ships before this spec, on its own, as a patch release. Not part of the protocol change.

`DoubleRatchet.ts:132` flips `newDhKey` on by itself once `sendCount >= windowSize` (`:33`,
`windowSize = 100`) in any `'specific'` session — which is every DM. `:144` then does
`keyStore.keys.set(senderId, …)`, writing the fresh pair into the **process-global** `KeyStore`
under the local user's own id. `:158` reads `header.dhPub` back out of that same global store via
`dehydrateKeyPair(senderId)`, which is *why* the write exists — so the two must move together.

Effect on shipped `0.14.0-alpha.8`: past 100 sent messages, a DM rotates the local identity's
long-term ECDH key process-wide, corrupting every other ratchet and the Space key-unwrap path that
reads the same entry.

Hotfix, three edits in `src/crypto/DoubleRatchet.ts`:

1. Delete the auto-trigger at `:132-134`. Rotation is reinstated properly in §3.6 on the standard
   Signal trigger (receipt of a new peer `dhPub`), not on a send counter.
2. Delete the `keyStore.keys.set(...)` write at `:144`.
3. Source `header.dhPub` from `this.state.clientDhPub` instead of
   `await keyStore.dehydrateKeyPair(senderId)` at `:158`.

Regression test: a two-instance, bidirectional exchange of >100 messages that asserts both
directions still decrypt **and** that `KeyStore.getInstance().getKeyPair(localId)` is unchanged
across the run. No such test exists today.

This is deliberately narrower than H1: it stops the corruption without touching the key schedule.

---

## 1. What each finding is, accurately

| | Finding | Severity | Status after this spec |
|---|---|---|---|
| **C2** | `EncryptedSession.receive` takes `kx.userId` verbatim (`:207`) and installs the accompanying keys under it; `storeRemotePublicKeys` runs on *every* frame, outside the `isNew` guard | Critical | **Partially closed** — see §7.1. C2 becomes TOFU + tamper-evident pin + out-of-band safety number. |
| **C3** | `EncryptedSession.encrypt` loops `this.ratchets.keys()` (`:174`); `MessageNamespace.send`, a 1:1 API, calls it | Critical | **Closed at the client.** Delivery and metadata unchanged — §7.2. |
| **H1** | One chain for both directions, no forward secrecy, signature does not cover ciphertext, DH step miswired | High (belongs in Critical) | **Closed.** |

Two corrections to earlier planning, recorded so they are not re-derived:

- **There is no finding "C5."** `SECURITY_AUDIT.md` numbers C1–C4 and H1–H6. The ratchet defect is
  H1. Earlier planning invented the C5 label.
- **The fan-out has two live callers**, not one: `MessageNamespace.send` (`MessageNamespace.ts:125`)
  and the public `Space.send` (`Space.ts:316-317`, reachable via `client.space.*`), both through
  `BroadcastChannel.send` (`BroadcastChannel.ts:178`). Retaining `encrypt()` is **required** by the
  second caller, not a stylistic choice.

---

## 2. Threat model

- **A1 — malicious or compromised accelerator.** Speaks the protocol, may lie in any response. The
  adversary all three findings are about.
- **A3 — any registered user of the app.** Note the relay already refuses a `keyExchange` or
  `cipherMessage` whose claimed sender is not the socket's authenticated user
  (`accelerator/src/durable-objects/space/wsProtocol.ts`, `dmSenderMatches`), so peer-level
  *impersonation* is closed server-side today. A3 still reaches C3: Mallory announces honestly as
  herself in `inbox:bob` and collects a decryptable copy of every DM.
- **A7 — next user of a shared browser profile.**

Out of scope, declared so a reviewer can tell they were considered: **A2** (offline vault cracking —
Spec B), **A4** (network attacker — TLS is assumed and unchanged here), **A5** (hostile origin /
XSS — the host app's responsibility), **A6** (malicious WebRTC peer — the p2p layer is untouched).

---

## 3. Wire protocol

Everything in §3 lands together, in one release. The DM wire breaks once; all clients must upgrade.

### 3.1 Encoding primitives

```
LP(x)      := uint32be(len(x)) ‖ x            // length-prefix, mandatory on every variable field
b64(x)     := standard base64 with padding
rawP256(k) := crypto.subtle.exportKey("raw", k)   // 65-byte uncompressed SEC1
jwkB64(k)  := btoa(JSON.stringify(await crypto.subtle.exportKey("jwk", k)))
```

Length-prefixing is not optional. Usernames have no charset validation anywhere (the accelerator
checks length only; the SDK checks nothing) and `deriveBitsHkdf` TextEncodes `info` raw
(`kdf.ts:95`), so bare concatenation is non-injective and forgeable.

**`jwkB64` output is engine-dependent** — JSON key order is not specified. Therefore every signature
and every AAD is computed over **the exact strings transmitted in the frame**, never over a
re-serialization. Implementations MUST retain the received strings verbatim for verification.

### 3.2 `KeyExchangeFrame` v2

```ts
interface KeyExchangeFrame {
  v: 2;
  type: "init" | "reply";
  userId: string;          // claimed sender; the relay already enforces == socket auth user
  roomId: string;          // the room this frame is valid in; binds the cert to a context
  nonce: string;           // b64, 16 bytes from crypto.getRandomValues
  identityKey: string;     // b64 rawP256 — the claimed long-term identity ECDSA key (P-256)
  ecdhPublicKey: string;   // b64 JWK, P-384 static chat ECDH  (unchanged field name)
  ecdsaPublicKey: string;  // b64 JWK, P-384 static chat ECDSA (retained for KeyStore/Space reuse)
  ephPublicKey: string;    // b64 JWK, P-384 per-connection ephemeral ECDH
  cert: string;            // b64 P1363 ECDSA-SHA256 by the identity P-256 key
  replyTo?: string;        // reply leg only: b64 SHA-256 of the init frame's canonicalKx bytes
  confirm?: string;        // reply leg only: b64 key-agreement MAC (§3.7)
}
```

`ecdsaPublicKey` becomes vestigial for DMs once the per-message signature is dropped (§3.5). It is
retained because `KeyStore.storeRemotePublicKeys` takes both keys and `Space` uses the same frame.

**Relay constraint:** keep `userId` as the only top-level identity claim and do not introduce a
`header` sub-object or a second top-level `senderId` in this frame. `claimedDmSenders` scans
top-level `senderId`, top-level `userId`, and `header.senderId`, and `dmSenderMatches` requires
every claim it finds to equal the socket's authenticated user — extra claims make the relay reject
honest frames.

`isKeyExchangeFrame` MUST require `v === 2` and every non-optional field above, and a frame failing
that check returns a typed rejection (§3.9), never a silent fall-through.

### 3.3 The certificate

```
canonicalKx(f) := LP("muhkoo-kx-v2") ‖ LP(f.type) ‖ LP(f.roomId) ‖ LP(f.userId)
                  ‖ LP(f.nonce) ‖ LP(f.identityKey)
                  ‖ LP(f.ecdhPublicKey) ‖ LP(f.ecdsaPublicKey) ‖ LP(f.ephPublicKey)
                  ‖ LP(f.replyTo ?? "")

f.cert := b64( ECDSA-SHA256-sign( identityPrivP256, canonicalKx(f) ) )
```

This is a **cross-curve** construction: a P-256 signature over P-384 JWK strings. The verifier
imports `identityKey` as `raw`/P-256 and the frame's key fields as `jwk`/P-384. Implemented as one
curve, it fails silently.

`roomId` and `nonce` are what stop replay. Without them a captured handshake is a bearer credential
valid in every room for the life of the ephemeral.

The reply leg's `replyTo` binds the responder's cert to the specific init frame it answers, which is
what makes this an interactive handshake rather than a replayable prekey bundle, and is the only
thing giving the initiator liveness.

**Do not** key any cache or replay-seen-set on `cert` bytes: ECDSA is malleable under WebCrypto, so
a relay can produce unlimited distinct valid signatures for one statement. Key on `th` (§3.4).

Do not copy the shape of `Space.ts:786-794`, which comments "Sign with our identity ECDSA key" and
then signs with the random P-384 chat key, silently no-opping when the key is absent. Fix that
comment in this change. A certificate is never conditional on key presence: absence is a hard error.

### 3.4 Role, transcript, and root derivation

**Role.** The sender of `type: "init"` is the initiator. Under glare — both peers announce on
connect, which `BroadcastChannel` does — both hold an init frame from the other. Tie-break on the
raw SEC1 ephemeral bytes:

```
initiator := rawSec1(ephSelf) <  rawSec1(ephPeer)    // unsigned lexicographic,
                                                      // shorter-is-less on a prefix
```

Equal bytes ⇒ abort the handshake (`rejected/ephemeral-collision`). Record the resolved role in
`RatchetState` at handshake time; never recompute it at decrypt time. The old
`isClient = this.myId < peerId` (`EncryptedSession.ts:221`, recomputed at `:259`) is deleted: it
compares relay-supplied strings, and the two sides can disagree and land in the same role, which
silently collapses the chain separation this spec installs.

**Transcript.** With `I` = initiator, `R` = responder, using the exact transmitted strings:

```
th := SHA-256( LP("muhkoo-dr-v2")
             ‖ LP(userId_I)      ‖ LP(userId_R)
             ‖ LP(identityKey_I) ‖ LP(identityKey_R)
             ‖ LP(ecdhPublicKey_I) ‖ LP(ecdhPublicKey_R)
             ‖ LP(ephPublicKey_I)  ‖ LP(ephPublicKey_R)
             ‖ LP(nonce_I)       ‖ LP(nonce_R)
             ‖ LP(roomId) )
```

**Root.** Three ECDH operations, all P-384, ordered by role (not by self/peer) so both sides
concatenate identically:

```
DH1 := ECDH( eph_I,    eph_R    )      // ephemeral × ephemeral
DH2 := ECDH( eph_I,    static_R )      // initiator ephemeral × responder static chat ECDH
DH3 := ECDH( static_I, eph_R    )      // initiator static chat ECDH × responder ephemeral

root ‖ chainA ‖ chainB := HKDF( ikm  = DH1 ‖ DH2 ‖ DH3,
                                salt = th,
                                info = "muhkoo-dr-init-v2",
                                len  = 96 )
```

Static × static is deliberately **excluded**: it is the term that made the old root a pure function
of two long-term keys, and it adds nothing once the ephemeral terms are present. This is X3DH's
three-DH form without a prekey server, which is sound here because the handshake is interactive.

Variable material lives in `salt` and `ikm`; `info` is a fixed label. `deriveBitsHkdf` already takes
`salt` as its fourth argument (`kdf.ts:77`).

**Chains, separated by role:**

```
sendChainKey := initiator ? chainA : chainB
recvChainKey := initiator ? chainB : chainA
```

so the initiator's send chain is the responder's receive chain. This replaces
`DoubleRatchet.ts:84-85`, which assigns the same 32 bytes to `rootKey`, `sendChainKey` and
`recvChainKey`.

**Session tag:** `sessionTag := b64(th[0..16])`, carried in every message header. It replaces
`sessionId`, which was `[myId, peerId].sort().join(":")` (`EncryptedSession.ts:309-311`) — a *pair*
id, byte-identical for every session the two parties ever run, contributing zero session separation.

### 3.5 `CipherMessageHeader` v2 and AAD

```ts
interface CipherMessageHeader {
  v: 2;
  sessionTag: string;      // b64, 16 bytes
  messageNumber: number;
  prevChainLength: number;
  dhPub: string;           // b64 JWK P-384, read from RatchetState — never from KeyStore
  senderId: string;
  recipientId: string;
}
```

**Removed:** `sessionId`, `sessionType`, `timestamp`, `signature`. `CipherMessageHeader` is a
shipped public type (it appears in `api-surface.txt`), so this is a breaking type change and is
listed as such in §8.

```
canonicalHeader(h) := LP("muhkoo-dr-hdr-v2") ‖ LP(h.sessionTag)
                      ‖ LP(uint32be(h.messageNumber)) ‖ LP(uint32be(h.prevChainLength))
                      ‖ LP(h.dhPub) ‖ LP(h.senderId) ‖ LP(h.recipientId)
```

Exactly one exported `canonicalHeader()` is used by the AEAD on both encrypt and decrypt. Today
sign and verify are two separate object literals that happen to share key order.

**The per-message ECDSA signature is removed.** `header.signature` no longer exists. Authenticity
comes from the authenticated handshake plus the chain key plus AAD binding `senderId`/`recipientId`/
`sessionTag`: only the peer holding the chain key can produce a valid frame. Retaining it would cost
three things — it makes every message a transferable, non-repudiable proof of authorship (Signal
uses a MAC for exactly this reason), it keeps alive the
`keyStore.getAuthKeyPair(header.senderId)!.publicKey` lookup at `DoubleRatchet.ts:218-220` (a
process-global read, by name, of a key installed by the handshake), and it maintains two divergent
canonicalisations.

This requires an **optional trailing** `aad?: Uint8Array` on `encryptAesGcm`/`decryptAesGcm`. The
file header at `aes-gcm.ts:19-20` already sanctions the parameter; it does not exist today
(`grep -rn additionalData src` returns nothing). Optional keeps both surface snapshots green. This
one-line primitive change is **part of this spec**, not a dependency on Spec C.

### 3.6 DH ratchet

`windowSize` is **deleted**. There is no count-based or time-based self-rotation. The ratchet steps
on the standard Signal trigger: receipt of a header whose `dhPub` differs from the stored peer
`dhPub`.

```
// on receiving a new peer dhPub — derive the RECEIVE chain
root, recvChainKey := HKDF( ikm = ECDH(ownDhPriv, peerDhPub),
                            salt = root, info = "muhkoo-dr-dh-v2", len = 64 )

// then generate our own new pair — derive the SEND chain
root, sendChainKey := HKDF( ikm = ECDH(newOwnDhPriv, peerDhPub),
                            salt = root, info = "muhkoo-dr-dh-v2", len = 64 )
```

Using the old root as HKDF **salt** is Signal's `KDF_RK` and replaces `DoubleRatchet.ts:100`, which
concatenates it into the IKM instead.

The send step touches only `root`, `sendChainKey`, `sendCount`, `prevChainLength`. Today `:103` and
`:107` also overwrite `recvChainKey` and zero `recvCount`, destroying the ability to read in-flight
messages.

**Invariant: all DH material lives in `RatchetState`.** `DoubleRatchet` never writes `KeyStore.keys`
and never reads it to populate `header.dhPub`.

### 3.7 Key-agreement confirmation

```
confirmKey := HKDF( ikm = root, salt = th, info = "muhkoo-dr-confirm-v2", len = 32 )
f.confirm  := b64( HMAC-SHA256( confirmKey, th ) )
```

Carried on the **reply leg only**. The initiator verifies it on receipt; a mismatch rejects the
handshake with `rejected/key-agreement-failed` and tears down the half-built ratchet. The responder
needs no reciprocal confirm: the initiator's first message authenticating under the AEAD proves
agreement.

Without this, a mis-derived root (role collision, ephemeral mix-up) surfaces only as messages that
never decrypt, with no diagnosis.

### 3.8 Skipped keys and decrypt ordering

`decrypt` currently advances the chain and fills the skip map **before** `decryptAesGcm` runs
(`:377`), gated only by a per-message `maxSkip = 3000` (`:31`, `:281`) with no ceiling on total
retained keys. A replayed or misrouted frame buys up to 3000 HKDF derivations and 3000 stored keys,
per frame.

Required order: **check, derive, trial-decrypt, then commit.**

1. Reject unless `header.sessionTag` equals the ratchet's tag and `header.recipientId` equals
   `myId`. Both before spending any derivation.
2. Derive the candidate message key.
3. Run the AEAD with `canonicalHeader(header)` as AAD.
4. Only on success: advance the chain, write skip-map entries, delete the used skipped key.

Bounds: `maxSkip = 1000` per message (down from 3000) **and** `maxRetainedSkipped = 2000` total per
ratchet, evicted FIFO by insertion order. Exceeding either is `rejected/skip-limit`.

Note for the implementer: `symmetricRatchet`'s output does **not** alias — `deriveBitsHkdf` returns
a fresh `Uint8Array` per call (`kdf.ts:100`). An earlier draft claimed otherwise and required a
defensive copy; it is unnecessary. `getState()` (`:387`) is still a shallow spread and should
deep-copy.

### 3.9 Rejection surfacing

`ReceiveResult` gains a fourth kind:

```ts
| { kind: "rejected"; peerId: string; reason: RejectReason }

type RejectReason =
  | "bad-certificate" | "unknown-peer" | "pinned-key-changed" | "stale-nonce"
  | "wrong-room" | "ephemeral-collision" | "key-agreement-failed"
  | "skip-limit" | "lookup-failed" | "locked";
```

`BroadcastChannel` emits a `PEER_REJECTED` event for it — `:246` explicitly swallows `ignored`
today, so a rejection would otherwise produce no event, no error and no log the app can see.
`MessageNamespace` wires it to `client.message.on('peer_rejected')`.

**Nonce freshness:** a per-`EncryptedSession` seen-set of `(peerId, nonce)` bounded to 256 entries,
FIFO. A repeat is `rejected/stale-nonce`. The set is process-lifetime only; it exists to stop
in-session replay, not cross-session replay, which `roomId` + the ephemeral binding already cover.

---

## 4. Identity lookup and pinning

### 4.1 Accelerator endpoint

Deployed **before** the connect release: additive and backward-compatible. The reverse order bricks
every DM.

```
POST /api/auth/identity      body: { username: string }
                             200:  { identityKey: string }   // b64 rawP256
```

- **POST with a body**, not a path segment — matching `/api/auth/oprf` and `/api/auth/vault`.
- **Unknown usernames get a deterministic decoy**, derived HKDF-style from a server secret and the
  username and mapped to a valid P-256 point, answered 200. A 404 would reopen the enumeration
  oracle that `zk.ts` deliberately closes elsewhere. See §4.3 for the client-side consequence.
- **Rate limited** on the same bucket and window as `/api/auth/challenge`.
- Responses are cached in-process per username for the lifetime of the `Client`.

Recommended in the same window, though not required by this spec: **start enforcing the
`ecdsaPubHash` binding.** `accelerator/src/durable-objects/userAuth/zk.ts` currently destructures
the third public signal and discards it, and `tests/helpers/zkAuth.ts` documents that as intended —
so the stored key is not bound to the account's commitment. Checking `proofEcdsaHash` against
`Poseidon(storedEcdsaPub)` at `zk-authenticate`, and validating the key at `handleZKRegister`, is
the only path by which C2 ever becomes more than TOFU. It does not retroactively attest existing
accounts.

### 4.2 The pin map

One kv document, not one entry per peer, because a per-entry design cannot detect deletion.

```
collection: "muhkoo.pins"
id:         "identity-v1"

{
  v: 1,
  ownerCommitment: string,
  counter: number,                       // monotonic, incremented on every write
  entries: { [peerIdLowercased: string]: string },   // b64 SHA-256 of rawP256 identity key
  sig: string                            // b64 P1363 ECDSA-SHA256 by the owner's identity P-256 key
}

signed bytes := LP("muhkoo-pinmap-v1") ‖ LP(ownerCommitment) ‖ LP(decimal(counter))
              ‖ LP( concat over entries sorted by key of ( LP(peerId) ‖ LP(hash) ) )
```

The signature is what makes storage-layer trust stop mattering. It survives envelope swapping,
which is why **Spec C's `StorageCipher` key-binding is not a prerequisite for C2** — an earlier plan
claimed it was.

**Write path.** Direct `this.deps.http.post`, exactly as the `ChatKeyVault` store already does
(`Client.ts:411-415`) — **not** `kv.set`, which swallows any non-`HttpError` and enqueues to
IndexedDB (`KvNamespace.ts:108-112`), so a resolved `await` is not evidence the pin reached the
server. The pin map stays out of the offline merge path entirely: `KvCache` picks its LWW winner by
a raw lexicographic compare on a server-supplied HLC string, so a server-pushed frame could
otherwise roll a pin back.

**Rollback detection.** The last-seen `counter` is persisted as a high-water mark in IndexedDB under
a key scoped by `ownerCommitment`. Rules:

| Situation | Behaviour |
|---|---|
| No high-water mark, no map returned | Bootstrap. Accept, create an empty map at `counter = 1`. |
| No high-water mark, map returned | Verify `sig`; accept; record `counter`. (TOFU of the map — documented.) |
| High-water mark exists, map returned with `counter >= mark` | Verify `sig`; accept; advance mark. |
| High-water mark exists, map returned with `counter < mark` | **Hard fail** — rollback. |
| **High-water mark exists, no map returned** | **Hard fail** — deletion. |

That last row is the hole a value-level AAD cannot close, and it is closed here by the counter, not
by encryption.

### 4.3 Verification rules

- Verify the certificate **before** the `KeyStore` write at `EncryptedSession.ts:218`, which today
  runs outside the `if (isNew)` guard at `:220`, and `KeyStore.storeRemotePublicKeys` overwrites
  whenever `!existing.privateKey` — always true for a peer. Pass the verified `CryptoKey`s directly
  into the ratchet rather than letting `DoubleRatchet` re-read the singleton.
- **All lookup failures are hard rejects** (`rejected/lookup-failed`). A 402/5xx/timeout on the
  identity lookup or the pin read rejects **that handshake only**; an already-established ratchet
  survives and messages continue on the existing session until the peer presents a verified rekey.
  The identity lookup lands on the singleton auth DO, and the pin read is a metered PersonalSpaceDO
  op that returns 402 over quota — so this must be explicit or it is discovered in production.
- **Unknown/decoy peers.** Because §4.1 answers unknown usernames with a decoy, a handshake with a
  not-yet-registered peer would otherwise pin the decoy and hard-fail forever once that peer
  registers. Therefore: the client does **not** pin on a first handshake whose certificate fails to
  verify against the fetched key. It rejects with `rejected/unknown-peer` and pins nothing. Only a
  certificate that *verifies* results in a pin.
- **Pinned identity key changed** ⇒ `rejected/pinned-key-changed`, hard fail, surfaced. There is no
  automatic unpin. Operator/user recovery is an explicit `client.message.unpin(peerId)` call, which
  is a documented trust decision.
- **Chat-key change with a valid certificate** is a legitimate, non-alerting event: tear down the
  ratchet, clear `sentHandshakeTo`, rebuild, surface it as a normal handshake. Only the *identity*
  key is pinned.

### 4.4 `safetyNumber()`

Exposed as a **method** (`session.safetyNumber(peerId)`), not a free export: the surface snapshot
lists top-level names only, so a method costs zero churn where a new exported function lands in both
`api-surface.txt` and `api-surface.workers.txt` (repo root) and must be regenerated.

```
ordered by the two lowercased usernames, lexicographic:
sn := SHA-256( LP("muhkoo-safety-v1") ‖ LP(identityKey_lower) ‖ LP(identityKey_higher) )
render: 12 groups of 5 decimal digits, group i = (uint16be(sn[2i..2i+2]) * 100000 / 65536)
```

It covers **both** parties' pinned identity keys — a one-sided number cannot detect a server that
substituted *your* key in the peer's view — and is a function of the pinned identity keys only, so
it survives chat-key rotation.

Docs deliverable: a short "verify a contact" page. §7.1 rests the entire first-contact story on this,
so it is not optional.

---

## 5. Recipient scoping (C3)

```ts
encryptTo(peerId: string, plaintext: string): Promise<CipherFrame>
```

A single `this.ratchets.get(peerId)` lookup replacing the loop at `:174`, threaded through
`ChannelLike`/`BroadcastChannel`. `MessageNamespace.send` passes `target.slice("user:".length)`.

`encryptTo` **throws** when no ratchet exists — it never returns zero frames.

**The silent-drop fix ships with it.** Today `MessageNamespace.send` awaits `ready`, calls
`announce()` — which only writes a frame; it does not wait for the peer — then calls `channel.send()`,
which iterates an empty ratchet map and returns `0`, discarded by the caller. So the first DM after
opening a room is silently dropped. The unit test cannot catch it: `tests/client/message.test.ts:34`
hardcodes `return 1`.

`MessageNamespace.send` therefore awaits a per-peer ratchet-ready promise, resolved by the handshake
branch, with a **10-second default timeout** (configurable via `MessageNamespaceOptions`). On
timeout it rejects with `PeerNotReadyError`, whose message names the peer and states that the
recipient must be online — matching the existing doc comment on `send`. A bare throw without the
wait would turn a silent drop into a spurious error on every first DM, so the two halves must land
together.

`encrypt()` is retained as a documented broadcast primitive — it has a second, legitimate caller in
`Space.send`. `docs/examples.md:118-121` gains a warning that broadcast means *every handshaken
peer, including hostile ones*.

---

## 6. Plumbing

### 6.1 The signer

`Session._identity` is retained for the whole unlocked session and cleared only by `logout()`. The
identity ECDSA private key is **non-extractable** with usages `['sign']`, so it must be used
in-process and can never be serialized.

Nothing under `src/sessions` or `src/crypto` imports `src/auth/identity.ts` or `src/core/Session.ts`
today, and it must stay that way: `DoubleRatchet` and `sessions` are exported from
`src/api.universal.ts`, the workers-safe slice, whose closure currently pulls **zero** npm packages.
Inject a structural callback instead of an import:

```ts
interface KxSigner {
  sign(bytes: Uint8Array): Promise<string>;      // b64 P1363
  identityKeyRaw(): Promise<string>;             // b64 rawP256
}
```

on `SessionOptions` and `BroadcastChannelOptions`, constructed in `src/core`, which is already
browser/server-only. Pass the `CryptoKey` or a callback — **never the seed**, which is strictly more
sensitive and recovers the whole account.

Note `signMessage` (`auth/keys.ts:38-46`) takes a `string` and TextEncodes it, so it cannot sign the
length-prefixed binary above. Either add a sibling that takes `Uint8Array`, or base64 the canonical
bytes before calling it — pick one and use it in both the signer and the verifier.

### 6.2 Construction sites

Five, across three chains:

| Site | Has `session`? |
|---|---|
| `SpaceNamespace.ts:288` — `new Space` | yes |
| `Space.ts:232` — `new BroadcastChannel` | via `Space` deps |
| `MessageNamespace.ts:224` — `defaultCreateChannel` | **no** — module-scope free function, signature `(url, myId)`, no `this` |
| `MessageNamespace.ts:151` — `new Room` | **no** — built from deps with no kv and no identity |
| `BroadcastChannel.ts:98` — `new EncryptedSession` | inherits whatever the channel got |

Change **both** `createChannel` seams (`MessageNamespace.ts:45`, `Space.ts:162`) from
`(url: string, myId: string)` to a single options object, so a missed call site is a type error.
This is a **breaking change to two exported typed seams** that an app or test may already supply,
and it produces no `api-surface.txt` churn only because the snapshot compares top-level names — so
it must be in the changelog explicitly.

### 6.3 Verifier modes

Three states, not two. Two states would make every non-DM channel reject every handshake, which
kills `Space`.

| Mode | Set by | Behaviour |
|---|---|---|
| `required` | `MessageNamespace` for `inbox:*` | No valid certificate ⇒ `rejected/bad-certificate`. |
| `legacy` | `MessageNamespace` for `pub:*`; `Space` | No certificate expected; TOFU as today; **documented as unauthenticated**. Space authenticates at the keyring layer instead. |
| unset | a directly-constructed `Room`/`EncryptedSession` | Defaults to `required` — fails closed. `Room`/`Space`/`RoomDeps` are public exports, so an app can build one with no compile error. |

Plumb the `e2e` flag that `MessageNamespace.ts:182` already receives and discards. Without it, every
`pub:<subject>` room gets the same auto-reciprocating session, and C2 turns any inbound frame into a
remote-triggered fetch amplifier against the singleton auth DO.

### 6.4 Concurrency and lifetime

- Serialize `receive()` per peer with an in-flight promise map. `WSTransport.ts:176-187` emits
  synchronously and `BroadcastChannel.ts:125-126` does `void this.handleInboundFrame(...)` with no
  queue, and `receive` already races today: `isNew` is read at `:213`, then **four** awaits run
  before `ratchets.set` at `:224`. At most one verify/TOFU in flight per peer; the pin write is a
  compare-and-set that re-reads before writing.
- Scope the pin cache to the `Client`/`SessionState` instance, keyed durably by `ownerCommitment`.
  `KeyStore` is a process-wide singleton keyed only by username and never cleared on logout
  (`Session.clear()` touches no `KeyStore`), so a cache modelled on it would let an unverified
  handshake in Client B bypass a pin verified in Client A.
- Add `KeyStore.forget(id)` and call it from `logout()` in this change.

### 6.5 Reconnect

`announced` resets on every reconnect (`BroadcastChannel.ts:106-108`), but the receiver gates both
rebuild and reciprocation on `isNew = !this.ratchets.has(peerId)` (`:213`, `:220`, `:229`), and
`sentHandshakeTo` is cleared only by `forgetPeer` (`:301-304`), which nothing calls on disconnect.
Today a reloaded peer re-announces, the other side ignores it, and the pair wedges silently.

Key "is new" on the peer's `(ephPublicKey, nonce)` rather than on map membership; rebuild and
re-reciprocate whenever either changes; reset `sentHandshakeTo` alongside the ratchet. This is also
what lets §4.3's hard fail tell a legitimate reconnect from an attack.

### 6.6 Locked state — enforcing an existing invariant

**Requiring an unlocked identity for DMs is the intended design; it was simply never enforced.** The
invariant is already written down in `ChatKeyVault`'s header:

> *"the wrapping secret is the **master seed** (not the password) … The seed is only ever held in
> memory (never persisted), so this vault can only provision/rehydrate while the client is
> unlocked."*

So the stable member keypair — the one the ratchet and the Space keyring both depend on — is
available only while unlocked, by design. What makes DMs *appear* to work in a locked session is a
silent fallback: `EncryptedSession.initialize()` (`:131-133`) calls
`this.keyStore.generateOwnKeyPair(this.myId)` whenever the `KeyStore` has no entry, which is exactly
the locked case. `restore()` yields a token with no identity, and `MessageNamespace.ts:215-216` needs
only `session.username`, so nothing stops it.

That fallback does not preserve the invariant, it hides its violation. A locked client substitutes a
**throwaway** P-384 pair for the `ChatKeyVault`-stable one, and per that same file the consequence is
that "the member re-admits to every space on every load and the group-key cache can never
round-trip." With C2's pinning in place it would also present to every peer as a fresh certified
chat-key on every reload — an endless stream of legitimate-looking rekeys.

So this spec is not adding a restriction. It is removing a fallback that was papering over a missing
precondition:

- `EncryptedSession.initialize()` no longer mints a keypair. An absent `KeyStore` entry is an error,
  not a cue to invent an identity.
- `client.message.send` and `subscribe('user:…')` throw a typed `IdentityLockedError` naming
  `client.auth.zk.unlock(password)`.
- A locked client rejects inbound handshakes with `rejected/locked` rather than TOFU-ing them.
- The `{encrypt: false}` escape hatch used for space keys is not available here: a plaintext pin is
  one the server rewrites at will.

Still a changelog entry, because apps relying on the accidental behaviour will see a new error where
they previously saw silent degradation — but it is a bug fix, not a policy change, and the error
message should say so.

---

## 7. What this does not close

### 7.1 C2 is TOFU

The bootstrap read is a directory lookup with no attestation: the accelerator never checks that the
`ecdsaPublicKey` it stores is the key bound inside the user's commitment (§4.1), registration
validates presence only, and the server refuses to hand out the commitment at all. So a server
hostile from the **first** handshake defeats C2 entirely.

What C2 does buy: a server that turns hostile **after** first contact cannot substitute a peer's
identity without tripping the pin, and cannot delete or roll back the pin map without tripping the
counter. Plus out-of-band verification via `safetyNumber()`.

Write it this way in the docs and the commit message. "Verified against the ZK identity" is false
and a reviewer will check.

### 7.2 C3 does not stop delivery or metadata

`wsProtocol.ts` broadcasts every `cipherMessage` to every socket in the space and never reads
`header.recipientId`; the check in `EncryptedSession` is a client-side courtesy. Anyone can be in
`inbox:bob`: the WS ticket is app-scoped with no space id, and `SharedSpaceDO` does no membership
check before `handleSession`.

C3 closes the **decryptable-copy** leak. The server-side half — a space-scoped ticket plus an
inbox-ownership check, or unicast on `recipientId` — is a separate, still-open change. Do not record
it as closed here.

### 7.3 Forward secrecy is per-connection

`KeyExchangeFrame` has no recipient field and the relay fans it to every socket, so the initiator's
broadcast leg advertises **one** ephemeral reused as `eph_I` for every peer in the room. Per-peer
ephemerals exist only on the reciprocation leg. The guarantee is per-connection forward secrecy
against the `ChatKeyVault`-stable long-term pair — real and worth having, but not per-peer or
per-session. Label it accurately.

### 7.4 Still open elsewhere

`Authenticator.ts:83` compares the proof nonce to itself, so that ZK handshake has no replay
protection. `Authenticator` and `DoubleRatchetManager` are not wired into `Client` but are public
API via `export * from "../crypto"`. Out of scope here; fix or delete in a follow-up.

---

## 8. Compatibility, per surface

- **DM wire** (`keyExchange`, `cipherMessage`) — **one break**, at step 3 below. v1 frames are
  rejected, not negotiated. All clients must upgrade. Permitted because this is alpha.
- **HTTP auth/vault** — strictly additive. `POST /api/auth/identity` is new; nothing existing
  changes shape. Old clients keep working.
- **Public TypeScript surface** — breaking: `CipherMessageHeader` loses four fields,
  `KeyExchangeFrame` gains six, both `createChannel` seams change arity, `ReceiveResult` gains a
  kind.

  **The surface test will not catch any of it, and that is the hazard.** All three types are already
  in both committed snapshots — `api-surface.txt:45,105,162` and `api-surface.workers.txt:22,28,43`
  (both at the repo root) — but only as *names*: the snapshot line is `T CipherMessageHeader`, with
  no shape. Changing an interface's fields therefore produces **zero** snapshot churn, so
  `yarn test:unit` stays green through a breaking API change. Do not treat a clean surface test as
  evidence here. Every one of these goes in the changelog by hand, and the review must read the type
  diff directly.

  Snapshot churn *is* expected if any new top-level name is exported (e.g. `RejectReason`,
  `PeerNotReadyError`, `IdentityLockedError`, `KxSigner`) — those land in both files and must be
  regenerated with `UPDATE_API_SURFACE=1` and reviewed.

---

## 9. Landing order

| # | Step | Repos | Gate |
|---|---|---|---|
| 0 | **Outage hotfix** (§0) | connect | Ships now, patch release, independent of everything below. |
| 1 | `aad?` on `encryptAesGcm`/`decryptAesGcm`; `canonicalHeader()` | connect | Additive, no behaviour change. Unblocks 3. |
| 2 | **`POST /api/auth/identity`** + rate limit + decoy | accelerator | Additive. Must be deployed before 3, or DMs break. |
| 3 | **Protocol change** — §3 frame, §3.4 root, §3.5 header, §3.6 ratchet, §3.8 decrypt order, §4 pinning, §5 `encryptTo`, §6 plumbing | connect | One release. The DM wire break. |
| 4 | `safetyNumber()` docs page | docs | Follows 3. |

Steps 1–3 are one connect release train; only 3 breaks the wire. The circular dependency in the
earlier plan is gone because the frame schema (§3.2) is defined here, in the same step as the key
schedule that consumes it.

### 9.3 Relationship to Spec C

`StorageCipher`'s missing key-binding is a real finding and Spec C's subject, but it is **not** a
prerequisite for this spec. The pin map is protected by its own signature and counter (§4.2), so
envelope swapping and deletion are both detected without value-level AAD. An earlier plan listed
AAD as blocking C2; that was wrong.

---

## 10. Test plan

Every test below must fail before its change and pass after. There is essentially no coverage today:
`grep -rn EncryptedSession tests/` returns one hit, a line of prose in
`tests/integration/README.md`.

**Hotfix (§0)**
- >100-message bidirectional exchange: both directions decrypt, and the local `KeyStore` entry is
  unchanged across the run.

**Key schedule (H1)**
- `sendChainKey !== recvChainKey`, and initiator-send equals responder-receive.
- Splice rejection: `{header: header_B, ciphertext: ciphertext_A}` fails.
- Forward secrecy: two sessions between the same pair produce different message keys at index 0.
- Role collision: peers seeing differently-cased ids still agree on role (ephemeral tie-break).
- Skip limits: `maxSkip` and `maxRetainedSkipped` both enforced; a replayed frame does not mutate
  chain state.

**Handshake (C2)**
- Unsigned, wrong-key, wrong-room, replayed-nonce, and v1 frames each rejected with the right
  `RejectReason`.
- Pinned-key change rejects; decoy/unknown peer rejects without pinning.
- Pin map: rollback (`counter <` mark) and deletion (absent map with a mark) both hard-fail.
- Locked client: `send`/`subscribe` throw; inbound handshake rejected.
- Verifier modes: `legacy` channels still complete a handshake; unset defaults to `required`.

**Recipient scoping (C3)**
- `FakeChannel` must **record the recipient** — `tests/client/message.test.ts:34` currently
  hardcodes `return 1`, so C3 has no regression test without this change.
- Three handshaken peers, one `send('user:bob')` ⇒ exactly one frame, addressed to bob.
- `send` before handshake waits, then succeeds; `send` to an absent peer rejects with
  `PeerNotReadyError` after the timeout.

**Rewrites required**
- `tests/crypto/ratchet.test.ts:41` is not a genuine two-party exchange; rewrite as two instances,
  both directions, interleaved, >100 messages.
- Message tests need `session.setIdentity(...)` — the pattern already at `tests/client/kv.test.ts:50`.

**Harness guard, same change.** `export-surface.test.ts` currently forbids only
`snarkjs|@zk-kit/groth16|circomlibjs|ffjavascript`, so importing `src/auth/identity.ts` from
`src/sessions` would **pass** while pulling `@noble/curves` into the workers bundle. Pin
`closure.external` for `WORKERS_ENTRY` to an explicit allowlist — today exactly
`['./wasm/bn128.wasm']`.

Before declaring any step done: `yarn build && REQUIRE_BUILD_ARTIFACTS=1 yarn test:unit`.

---

## 11. Decision log

| Decision | Chosen | Rejected |
|---|---|---|
| Split H1/C2/C3 | One spec — they share the frame | Three specs (created a circular dependency) |
| Root derivation | 3-DH X3DH form, no static×static | Static-static (the current defect); full X3DH with a prekey server (no async requirement) |
| Role assignment | Frame `type`, ephemeral bytes as tie-break | `myId < peerId` (relay-supplied, case-sensitive) |
| Per-message ECDSA signature | Removed; AEAD + AAD carry authenticity | Retained (needs to cover ciphertext + nonce; costs deniability) |
| DH rotation trigger | Receipt of a new peer `dhPub` | `windowSize = 100` send counter (the outage) |
| Pin storage | One signed, counter-versioned map document | Per-peer kv entries (cannot detect deletion) |
| Pin trust anchor | Signature + counter | Value-level AAD (cannot detect deletion or rollback) |
| Unknown peer | Reject without pinning | Pin the decoy (permanent hard-fail when they register) |
| Verifier modes | Three (`required`/`legacy`/unset⇒required) | Two (kills `Space`) |
| Broadcast `encrypt()` | Retained — `Space.send` needs it | Deleted |
