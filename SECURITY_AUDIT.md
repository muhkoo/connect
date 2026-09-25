# Security audit — `@muhkoo/connect`

- **Repo/commit:** `muhkoo/connect` @ `f40dddb` (`main`), version `0.14.0-alpha.7`
- **Scope:** 145 TypeScript files, 22,749 LOC (client SDK only; the accelerator backend is out of scope)
- **Date:** 2026-09-08
- **Result:** 170 raw findings → **145 confirmed**, 25 refuted

| Severity | Count |
|---|---|
| Critical | 5 |
| High | 18 |
| Medium | 26 |
| Low | 70 |
| Informational | 26 |

Findings by attacker position (a finding can have more than one):

| | Attacker | Findings |
|---|---|---|
| A1 | Malicious / compromised server | **102** |
| A3 | Malicious co-member of a space | 35 |
| A7 | Local attacker / next user of the browser | 26 |
| A5 | Hostile origin, XSS, redirect/postMessage sender | 20 |
| A4 | Network attacker | 16 |
| A2 | Offline attacker with a stolen server DB | 7 |
| A6 | Malicious WebRTC peer | 2 |

---

## Verdict

**The blind-relay guarantee does not hold.** Of 145 confirmed findings, 102 are exploitable by the
accelerator itself — the party the entire architecture is designed to distrust. A malicious or
compromised server can read `client.message` DMs in plaintext, inject its own group key into any
Space, forge messages as any member, substitute any file, roll back any VCS object, and hand the
login prover a witness generator of its choosing.

**Three defects are structural, not incidental.**

1. **Identity keys are never bound to wire identities.** `keyExchange.userId`, the keyring roster,
   and join requests are all self-asserted and accepted verbatim.
2. **AEAD ciphertexts are bound to no context** — not to their storage key, sender, space, or
   version — so any tag-valid blob is interchangeable with any other under the same key.
3. **The OPRF runs in RFC 9497 base mode 0x00**, which carries no proof, so the server can silently
   collapse the vault wrap key to a function of public data.

**The Double Ratchet in `src/crypto/` is not a Double Ratchet.** `initializeSession` assigns the
same 32 bytes to `rootKey`, `sendChainKey` and `recvChainKey`, so all four chain keys in a session
are one value and both directions derive identical message keys. The root is a static-static ECDH of
two long-term identity keys with no ephemeral contribution, so there is no forward secrecy and every
session between a pair replays the same key stream. Its test suite errors out in `beforeAll` and is
excluded from the vitest allowlist, so none of this was caught.

**Two documented guarantees are contradicted by the code's own comments.** `src/storage/types.ts:47`
says the per-chunk AES keys are *"Plain in the manifest — gating happens at the SpaceDO"*, and
`writeFile` POSTs that manifest to the server: `client.storage` is access-controlled, not
end-to-end encrypted. `client.db` is plaintext to the accelerator by design. Both sit under a README
and a CLAUDE.md that lead with encryption by default.

---

## Critical (5 findings, 4 write-ups)

> Two of the five confirmed criticals landed on the same root cause at the same location
> (`EncryptedSession.ts:207`, found independently by the ratchet and websocket passes) and are
> written up once, as C2. The severity table above counts findings; the headings below count
> write-ups. There is no finding numbered C5 — the Double Ratchet key-schedule defect is **H1**.

### C1 — The prover downloads its own witness generator and proving key from the party the proof is meant to convince
`src/auth/proof.ts:60` · CWE-494 · A1

`defaultCircuitUrls()` anchors `preimagePoK.wasm` and `preimagePoK_0001.zkey` at
`${baseUrl}/circuits/build/…` — the accelerator. `Client` uses this by default (`Client.ts:251`).
`generateAuthProof` then passes the HKDF-derived `secret` and `salt` into
`snarkjs.groth16.fullProve(input, wasmUrl, zkeyUrl)`, which fetches both artifacts over the network.
No SRI, no digest pin, no signature, no bundled copy.

**Attack.** The server serves a modified witness generator that writes `secret` into the public-signal
slots — public signals are just `witness[1..nPublic]` — and `proveAndStore` forwards them without ever
comparing them to the values it computed locally. Even leaving the WASM alone, the server also
controls the zkey: a subverted CRS breaks Groth16's zero-knowledge property outright. With
`secret` + `salt` it derives the `client.kv` at-rest key via `StorageCipher` and decrypts everything
it stores. `HostedAuth.mintSession` and `PersonalSpaceClient.proveFreshChallenge` take the same path.

**Fix.** Bundle the artifacts the way `bn128.wasm` is already base64-inlined by `@rollup/plugin-wasm`
in all three builds — or fetch the bytes yourself, SHA-256 them against constants shipped beside
`PREIMAGE_POK_VERIFICATION_KEY`, and pass verified buffers to snarkjs (`ZeroKnowledge` already has a
from-buffer path). Verify the zkey against the pinned verification key before proving. Make
`ClientOptions.circuits` require a digest per URL.

---

### C2 — Any WebSocket frame can announce itself as any user
`src/sessions/EncryptedSession.ts:207` · CWE-290/322 · A1, A3

`receive()` takes the peer's claimed identity verbatim from the wire (`const peerId = kx.userId`) and
installs the accompanying ECDH/ECDSA keys under it. Nothing binds `userId` to the ZK identity, the
Poseidon commitment, the session username, or any server-attested roster. No fingerprint, no safety
number, no TOFU pinning. The only rejection is `peerId === this.myId`. `storeRemotePublicKeys` runs on
*every* keyExchange frame — `isNew` gates only the ratchet rebuild — so a peer's verification key can
be swapped mid-conversation.

**Attack.** Alice calls `client.message.send('user:bob', …)`, opening `inbox:bob` and announcing her
keys. The accelerator drops that frame and instead mints two keypairs, telling Bob it is Alice and
Alice it is Bob. Both sides build ratchets against server-held keys, so the root key
`HKDF(ECDH(myPriv, injectedPub))` is known to the relay: a textbook MITM on the surface documented as
"end-to-end-encrypted direct messages". Because room names derive from usernames, any registered user
of the app can do the same without being the server — the publishable `mk_*_pk_*` key ships in every
browser bundle.

**Fix.** Require the frame to carry a signature by the claimed user's ZK identity ECDSA key —
`identity.ts` derives it deterministically from the seed and it is already registered at
`/api/auth/zk-register` — fetch that key over the authenticated HTTP channel keyed by username, and
reject any frame that does not verify. Minimally, pin on first sight and hard-fail on change.

---

### C3 — Direct messages fan out to every peer in the room
`src/core/namespaces/MessageNamespace.ts:122` · CWE-863 · A3, A1

`send()` derives the room purely from the caller's target string (`inbox:${target.slice(5)}`) and
calls `channel.send(...)`, reaching `EncryptedSession.encrypt`. That method iterates
`this.ratchets.keys()` and emits one ciphertext per handshaken peer — it has no notion of an intended
recipient. `subscribe()` derives the same room name from an arbitrary caller string with no check
that the id is the caller's own, and the WS-upgrade ticket (`POST /api/ws-ticket`, body `{}`) carries
no space id, so it authorises a socket to any space.

**Attack.** Mallory registers a normal account, calls `client.message.send('user:bob', {})` once to
open `inbox:bob`, and announces herself. She is now a handshaken peer in Bob's inbox. Every DM Alice
writes to Bob in that room is encrypted to Mallory's ratchet as well as Bob's and put on the wire.
No server compromise required.

**Fix.** Add `EncryptedSession.encryptTo(peerId, plaintext)` — a single `ratchets.get(peerId)` lookup
replacing the loop at `EncryptedSession.ts:174` — expose it through `ChannelLike`/`BroadcastChannel`,
and have `send()` pass `target.slice('user:'.length)`, throwing when no ratchet exists rather than
silently sealing to everyone. Separately, scope the WS ticket to a space and make the server reject a
subscription to an inbox that is not the caller's.

---

### C4 — The OPRF runs in base mode 0x00, so the server can collapse the wrap key
`src/auth/gatedFactor.ts:56` (and `AuthNamespace.ts:851` for the password factor) · CWE-345 · A1 → A2

The email/Google factor wraps the master seed under `HKDF(OPRF(K1,input) ‖ OPRF(K2,input))`. The SDK
uses `ristretto255_oprf.oprf` — RFC 9497 base mode, no DLEQ proof — and `oprfFinalize` verifies
nothing. noble's `voprf` variant, which does call `verifyProof`, is present in the dependency and
unused. `src/auth/oprf.ts:12` states the guarantee this destroys: *"a stolen vault blob is NOT
offline-crackable; every guess costs a round-trip to a rate-limited server endpoint."*

**Attack.** On enrolment the client posts `blinded` to `POST /api/auth/oprf`. A hostile server answers
`{evaluated: blinded, evaluated2: blinded}` (k=1). The unblinded point is then just `H(input)`, and
`input` is `SHA-256("muhkoo/factor:email:v1:<username>:<email>")`. The wrap key becomes a pure
function of two public strings. The same downgrade applied to `passwordWrapKey` at `register`,
`changePassword` or `migrateLegacyPasswordFactor` turns the password factor into an offline-crackable
blob — and that blob is fetchable by anyone holding a publishable app key.

**Fix.** Switch every call to `ristretto255_oprf.voprf` (mode 0x01) and pin the server public keys for
K1 and K2 as build-time constants in `src/auth/oprf.ts` — they must not be fetched per request, or the
server simply picks a matching key. Widen `AuthClient.oprfEvaluate` to carry the proof and throw on
verification failure. Separately, require proof of possession before `vaultRead` serves a factor blob.

---

## High (18, grouped)

### H1 — The Double Ratchet has one chain, no forward secrecy, and a signature that does not cover the ciphertext
`src/crypto/DoubleRatchet.ts:77–84, 171` · CWE-320/323/347 · A1

- **One chain.** `initializeSession` assigns the same 32 bytes to `rootKey`, `sendChainKey` and
  `recvChainKey`; since `symmetricRatchet` is a pure function of the chain key, all four chain keys
  are identical and message key #n is the same AES-256-GCM key in both directions. `dhRatchet`
  repeats the mistake asymmetrically (`sendChainKey = isClient ? recvChainKey : rootKey`).
- **No forward secrecy.** The root is a static-static ECDH of two long-term identity keys with a fixed
  label and empty salt — no ephemeral, no session nonce — so every page reload restarts the identical
  key stream, and one later key compromise decrypts every archived message.
- **Unsigned payload.** The ECDSA signature covers only header fields; `ciphertext` and `nonce` are
  excluded, and `encryptAesGcm` takes no AAD at all.

**Attack.** Because the two directions share message key #n and the signature omits the payload, a
relay delivers Alice `{header: header_B, ciphertext: ciphertext_A, nonce: nonce_A}`. Bob's signature
over Bob's untouched header verifies, the key matches, and Alice's own message renders as Bob's.

**Fix.** Expand 96 bytes of HKDF and split into root/send/recv with the halves assigned by role. Add
the `aad` parameter `aes-gcm.ts:19` already anticipates and pass the canonical header bytes on both
encrypt and decrypt. Introduce an X3DH-style ephemeral. `SpaceCipher.canonicalMessage` already gets
the signing part right — mirror it.

### H2 — The group-key layer trusts the server for keys, membership, and who may sign
`src/spaces/SpaceKeyring.ts:136, 257, 265`; `src/spaces/Space.ts:754` · CWE-345/862 · A1, A3

- **Key injection.** `pullKeys()` installs any blob that decrypts under the member's identity ECDH
  private key as the group key for whatever epoch the blob claims, then sets `this.epoch = Math.max(...)`.
  `WrappedKey` carries no sender identity and no signature; wrapping needs only the victim's public
  key, published in every roster and join request.
- **No context binding.** The ECIES HKDF binds only the epoch — not the space id, not an authorised sender.
- **Auto-admit.** A relayed `joinRequest` frame causes any client holding the key to wrap it for the
  `memberId` and `identityEcdhPub` named on the wire, with no roster or allowlist check. `autoAdmit`
  defaults on and `SpaceNamespace.build` never sets it.
- **Unpinned roster.** `verifySender` resolves signing keys solely from `GET /keyring/roster`,
  re-learned on every page load with no change warning.

**Fix.** Add an issuer field and ECDSA signature to `WrappedKey` (over
`epoch‖ephemeralPub‖iv‖ciphertext‖targetMemberId`) and reject untrusted issuers; never let an inbound
blob advance `currentEpoch()`. Fold the space id and sender member id into the HKDF `info`. Default
`autoAdmit` to **false** until join requests are signed by the account's ZK identity key. Chain the
space keypair to the account identity at `ChatKeyVault.provision` time and publish that certificate in
the roster, or at minimum persist `memberId → ecdsaPub` for durable TOFU.

### H3 — `client.storage` POSTs the per-chunk AES keys to the server inside an unauthenticated manifest
`src/core/namespaces/FileNamespace.ts:88`; `src/storage/transport/SharedSpaceClient.ts:58` · CWE-522/345 · A1

`FileStorage.writeFileToShards` encrypts each chunk under a fresh AES-256-GCM key and puts that key
and IV in cleartext inside the `FileManifest`, which `writeFile` POSTs to the space's Durable Object.
`src/storage/types.ts:47` is explicit about it. The accelerator holds both the shard ciphertext and
the keys. Nothing signs or version-pins the manifest either, so on read the GCM tag proves only that
the server's ciphertext matches the server's own key — enabling substitution, truncation and rollback.

**Fix.** Seal `ChunkManifest.cipher` before it leaves the client (space epoch key via the existing
`SpaceCipher`/`SpaceKeyring` machinery, or `StorageCipher` for single-user files) and store only the
wrapped blob. Authenticate the manifest itself. Note `Space.putFile`, used by `client.vfs`, already
keeps manifests out of the server's hands — `client.storage` is the outlier. Until fixed, correct the
README and CLAUDE.md.

### H4 — TV pairing renders a server-chosen URL as a QR code, and its "mandatory" commitment check is self-referential
`src/core/namespaces/HostedAuth.ts:423, 775` · CWE-345/601 · A1

`startDevicePairing` takes `verification_uri` and `verification_uri_complete` verbatim from the
`/api/auth/device/code` response — no origin check against `authBaseUrl`, no https check, no parse
check — and the doc comment says "render as a QR code". The file is otherwise scrupulous here: the
adjacent field carries the comment *"LOCAL derivation — never `body.verification_code`"*. Separately,
`adoptSealedSeed` compares the locally derived Poseidon commitment against `payload.commitment`, but
both that and `sealedKeys` came from the same server response, so the check proves only that the
server was internally consistent. Sealing to the device costs no secret. These calls bypass
`HttpClient` entirely — raw `globalThis.fetch`, no app key, no session.

**Fix.** Pin both URLs to `new URL(authBaseUrl).origin` with an https scheme; treat a mismatch as a
`DevicePairingError`. Have the approver's browser sign a transcript binding
`sealed_keys ‖ device_public_key ‖ user_code` with the account's ECDSA identity key, and verify it in
`adoptSealedSeed` before `mintSession`.

### H5 — Legacy identities use PBKDF2-SHA256 200k under a username salt, and the target commitment is in localStorage
`src/auth/identity.ts:173` · CWE-916/760 · A2, A7

For pre-vault and migrated accounts the whole identity is a deterministic function of
`(username, password)` through `pbkdf2Bytes(password, "muhkoo-zk-v1:" + username, 32)`: 200,000
iterations against an OWASP figure of 600,000, no memory-hardness (while the same repo already
depends on scrypt for the vault path), and a salt that is a pure function of the username — known
before the breach and permitting per-target precomputation. The verifier is available from the
accelerator's account table *or* from `localStorage["muhkoo.session.commitment"]`, which
`LocalStorageSessionStore.save` writes in plaintext on every sign-in. A hostile server can also force
this path — a separate confirmed finding shows login can be silently downgraded to it.

**Fix.** Retire the derivation rather than tuning it: mark an account migrated server-side after its
first successful vault migration and stop calling `deriveMasterSeedFromPassword` for it. Stop writing
`commitment` to `localStorage`.

### H6 — VCS objects are never re-hashed on read, and the offline queue has no idea which user wrote it
`src/vcs/VcsNamespace.ts:104`; `src/offline/SyncEngine.ts:51` · CWE-345/283 · A1, A7

`Repo.get<T>(hash)` unseals and returns without checking that the object hashes to `hash`;
`hashObject` is called on the write path only. Because every object in a repo is sealed under one key,
the AEAD tag verifies for *any* object of that repo, so the server can answer a read for one hash with
the ciphertext stored under another — rewriting history while `status()` reports a clean tree.
Separately, `QueueEntry` records `hlc`, `clientId`, `domain`, `method`, `args` and nothing identifying
the user; it lives in the origin-wide `muhkoo.offline` IndexedDB, is never cleared on logout
(`IndexedDbStore.clear` has zero callers in `src/`), and `canSync()` checks only that *some* user is
signed in. Replayers rebuild the target path from the *current* session's commitment. Every other
offline store is prefixed with the user's commitment — the queue is the one that is not.

**Fix.** In `Repo.get`, recompute `hashObject(value)` after unseal and throw unless it matches. Stamp
every `QueueEntry` with the originating commitment at enqueue time and have `runDrain` skip (not drop)
entries whose commitment differs from the live session; capture the target path in `args`.

---

## Systemic patterns

Individual fixes will not hold unless these four are addressed as design decisions.

1. **Wire identity is never bound to cryptographic identity.** The SDK derives a perfectly good
   long-term ECDSA identity from the seed and registers it at `/api/auth/zk-register` — then never
   uses it to authenticate anything on the wire. One primitive (sign wire identity assertions with the
   ZK identity key; verify against a key fetched over the authenticated channel) closes the DM MITM,
   the roster forgery, and the auto-admit hole together.

2. **AEAD is used without associated data, everywhere.** `encryptAesGcm` has no AAD parameter at all,
   and its own header comment concedes it. Consequently `StorageCipher` envelopes are not bound to
   their collection/id, `recordCipher` records not to their path, VCS objects not to their hash,
   ratchet payloads not to their header, and space key wraps not to their space. Adding the parameter
   and threading context through every call site removes a whole class.

3. **Nothing is torn down on logout.** `logout()` is effectively `session.clear()`. `KeyStore` has no
   `clear()` API and its keys are `extractable: true`; the personal-space WebSocket stays open and the
   next user attaches to it; `MessageNamespace`'s room map, the offline queue, and the db/kv/space
   caches are all unscoped and survive. An in-flight 401 re-auth can even restore the session token
   and full identity after sign-out.

4. **The tests that would have caught this do not run.** Confirmed by running `yarn test:unit`: 4
   failed files, 2 failed tests, 16 skipped. The Double Ratchet suite errors in `beforeAll`, so the
   shared-chain and forward-secrecy defects have zero executing coverage. The only tests asserting a
   *bad* Groth16 proof is rejected never execute. Two crypto test files import modules that no longer
   exist and are hidden by the curated `vitest.config.ts` allowlist. There is no CI, and
   `prepublishOnly` does not run tests.

---

## Medium (26)

| Location | Finding |
|---|---|
| `crypto/StorageCipher.ts:49` | kv at-rest envelopes bound to neither key id nor version — server can serve any ciphertext for any key, or roll back |
| `vfs/recordCipher.ts:64` | Sealed records carry no binding to their storage key; ciphertexts interchangeable between paths, stale ones replay |
| `namespaces/KvNamespace.ts:310` | `decode` content-sniffs the envelope: server returns chosen plaintext for any encrypted key and it is accepted as authentic |
| `crypto/DoubleRatchet.ts:145` | DH ratchet hardcodes the client role, DHs against the sender's own public key, and overwrites the process-global identity ECDH keypair `SpaceNamespace` uses |
| `crypto/DoubleRatchet.ts:296` | One replayed ciphertext permanently desyncs the receive chain — advanced before AEAD verification, never rolled back, no dedup |
| `spaces/SpaceCipher.ts:98` | Signed canonical form has no anti-replay binding and omits `contentType` — replay and type-flip |
| `namespaces/SpaceNamespace.ts:350` | History policy from an unauthenticated `/metadata` read, defaults to `static` on error — joiner hands every historical epoch key to the next newcomer |
| `namespaces/AuthNamespace.ts:155` | Login silently downgradable to legacy PBKDF2; changing the password never revokes it for pre-vault accounts |
| `namespaces/AuthNamespace.ts:195` | `logout()` silently undone by an in-flight 401 re-auth — token and full identity restored after sign-out |
| `namespaces/AuthNamespace.ts:222` | Client never checks the prover's own `publicSignals` against locally computed values before shipping them |
| `auth/hostedHandoff.ts:268` | Pairing verification code is a 39.3-bit precomputable function of a public key, and is the only thing binding the seal to the real TV |
| `namespaces/KvNamespace.ts:210,234,242` | Session bearer token in the WebSocket query string; socket left open on logout; feed memoized without keying to the session |
| `namespaces/MessageNamespace.ts:68` | Never torn down on logout, room map not user-scoped — next user DMs over the previous user's socket and identity |
| `offline/OfflineManager.ts:67` | Outbound queue and `openSpaces` not owner-scoped |
| `crypto/KeyStore.ts:20` | No clear/delete API; long-term private keys outlive logout, enumerable via public live-Map getters, generated `extractable: true` |
| `storage/transport/ShardClient.ts:455` | Shards never checked against their content address — hostile host turns a repairable erasure into permanent, cache-persisted loss |
| `p2p/signaling/SpaceSignaler.ts:49` | WebRTC signaling unauthenticated and unencrypted — accelerator can join or MITM every peer mesh |
| `spaces/Space.ts:822` | One relayed frame freezes the client for minutes: quadratic base58 re-encode before any signature or decryption check |
| `utilities/index.ts:279` | Co-member bricks a channel: `__type` markers in a signed body make `Message.body` throw on every read; poisoned frame is cached and replayed |

---

## Low and informational (96, by theme)

**Credential and transport handling.** `HttpClient` follows redirects with `X-Muhkoo-Key` and
`X-Muhkoo-Session` intact (`:127`); `isSameOrigin` misclassifies protocol-relative and single-slash
URLs and fails open on parse error (`:154`); no transport-security floor, so a non-https `baseUrl` is
accepted and propagated to `ws://…?session=<bearer>` (`:105`); a staging diagnostic console-logs every
request path including the commitment and plaintext KV key names (`:148`); `FunctionsNamespace`
interpolates an unvalidated server-supplied function name into the host position (`:247, :253`);
access tokens default to never-expiring and scopes are never validated (`AccessTokensNamespace.ts:63`);
the SDK installs a writable `globalThis.appLogger` whose DEBUG stream carries ratchet and session
metadata (`browser/index.ts:4`).

**Auth flow and recovery factors.** `scrubUrl()` runs only on the success path, leaving `code`,
`state` and the seed-handoff key `#k=<K_t>` in the address bar and history on failure
(`HostedAuth.ts:1018, :351`); `manageAccount()` forwards the entire current URL including that
fragment into a query parameter (`:313`); the callback adopts the server's `commitment` and `username`
without recomputing them (`:347`); `completeAuthorize` applies no scheme or allowlist check to
`redirectUri` (`:369`); `approveDevicePairing` seals without re-deriving the code the human compared
(`:677`); a revoked TV keeps signing itself in (`:596`) and the approval screen's risk signals are
server-supplied (`:649`); email/Google factors wrap the seed under public-derived material with no
stretching and both "trust domain" halves come from one endpoint (`gatedFactor.ts:25, :50`); removing
the recovery-phrase factor revokes nothing and there is no seed-rotation path (`AuthNamespace.ts:363,
:442`); `logout()` leaves the seed on a paired device so `resumeDeviceSession()` signs the previous
user back in (`:658`); the passkey releasing the master seed requests only
`userVerification: "preferred"` (`passkey.ts:176`); vault scrypt uses 2009 "interactive" parameters
with a username-only salt (`vault.ts:34`).

**Spaces, channels and group messaging.** `joinChannel` trusts the app-public name→spaceId registry
with no pinning (`SpaceNamespace.ts:201`); the create-vs-join fork is server-steerable via a 404
(`:164`); `visibility` is write-only and `createChannel` wraps every key to an unpinned keeper key
(`:179, :189`); `deleteSpaceMessage` tombstones applied with no signature check (`Space.ts:730`);
messages claiming to be from yourself skip verification (`:862`); signatures do not cover the
server-assigned handle (`:708`); no backward secrecy — no member-removal path, rotation never
triggered (`spaces/types.ts:11`); group key injectable via the unauthenticated `space-keys` kv row
(`Client.ts:393`); the README's "every other Space stays blind" claim is contradicted by
`createChannel` (`README.md:234`).

**Data namespaces, VFS and offline cache.** `client.db` is authorized by the publishable app key
alone — any visitor can read, modify and delete every row of every non-backend table
(`DbNamespace.ts:18`); a table name of `..` escapes the `/api/db` prefix (`:79`); unbounded
client-authored `_hlc` stamps freeze shared rows, transport failures become indistinguishable empty
pages, rejected writes are not rolled back (`:90, :130, :139`); the kv change feed is unauthenticated
and its server-chosen HLC merges into the persistent cache, and key names are plaintext
(`KvNamespace.ts:294, :326`); a malformed sealed record reads as an *empty* directory
(`VfsNamespace.ts:766`); `globToRegExp` has unbounded nested quantifiers (`glob.ts:11, :26`);
`merge3`'s LCS allocates a full n×m table (`merge3.ts:33`); `__proto__` is an accepted VFS/VCS entry
name producing a colliding tree hash (`VcsNamespace.ts:216`); db/kv/space/shard caches are plaintext,
unscoped, never cleared, LWW-decided by unvalidated server HLCs, and re-read with verification
disabled (`offline/DbCache.ts:55`, `KvCache.ts:68`, `SpaceCache.ts:60`, `cache/ShardCache.ts:39`); a
stable per-install `nodeId` in every HLC links every account used in the browser
(`OfflineManager.ts:169`); server-declared `shardSize` drives unbounded allocation and assembled bytes
are never cross-checked against the manifest (`FileStorage.ts:234, :413`).

**Wire primitives, p2p and agents.** The public `deserialize()` writes a wire-supplied `__proto__` key
onto a fresh object (`utilities/index.ts:293`); djb2 is shipped as public integrity API and `Network`
calls it on inbound relayed data (`:161`); `Packet.signature` is carried on the wire and verified
nowhere — the verifier is commented out (`Packet.ts:101`); `Network.handleIncomingMessage` accepts an
unencrypted body and emits the cleartext as if decrypted (`Network.ts:341`); quadratic base58 in
`Message` body is a remote main-thread freeze (~18 s per `.body` read on a 128 KB message,
`Message.ts:59`); `Logger` fails open to INFO and silently disables `error` on a numeric level
(`Logger.ts:65`); peer ids are spoofable to tear down another member's WebRTC connection
(`WebRtcTransport.ts:176`) and frame reassembly has no bounds while ICE leaks local IPs (`:255, :129`);
the block engine serves WANT for any hash out of the origin-wide shard cache (`blockEngine.ts:90`);
the generated agent prompt orders unconditional tool execution with no authority boundary between
developer instructions and Space content, and `ejectAgentTools` grants write access to read-only and
`backend: true` tables (`describe.ts:215, :253`); `unsubscribe()` before the socket resolves is a
permanent no-op and reconnects replay a spent single-use ticket (`MessageNamespace.ts:81, :185`);
pub/sub subjects are an app-wide plaintext bus presented as a scoped "room", and `subscribe()` reads
the sender from client-controlled `pub.from` (`:78, :94`).

**Build, packaging and test integrity.** The curated vitest allowlist hides four test files importing
deleted modules and switches off 71 passing tests (`vitest.config.ts:72`); the credential-injection
test has been failing since the M1.0 vault change (`tests/client/client.test.ts:69`); the rollup
`replace` key matches no source text, so the build-time `LOG_LEVEL` pin is a silent no-op
(`rollup.config.js:69`); the publish gate only mtime-checks `dist/connect.d.ts` (`check-dts.mjs:36`);
`bn128.wasm` ships with no recorded hash from a script with undeclared build deps
(`extract-bn128-wasm.js:8`); one `connect.d.ts` built from the browser entry serves as `types` for the
`workerd` and `default` conditions (`package.json:39`); `unwrapWithPassphrase`, whose PBKDF2 iteration
count is unbounded and taken from the payload being decrypted, is one of only 29 symbols in the
`workerd` surface (`workers/index.ts:16`); an IPFS/Kubo node private key committed to the
open-sourced repo is still extractable from the object store (`.gitignore:139`).

---

## Overturned refutations

The verification stage was told to default to *refuted* under uncertainty, which trades false
positives for false negatives. I re-read the source for the discarded findings that looked wrong to
discard. Five were killed in error:

**`src/workers/groth16-verifier.ts:136` — no public-signal arity check.** Three independent finders
raised this and all three were refuted. `grep -n "nPublic\|IC\.length\|signals\.length"` over the file
returns nothing: the loop runs `for (let i = 0; i < signals.length; i++)` and indexes `vk.IC[i + 1]`
with no arity check anywhere. A *truncated* `publicSignals` array computes `vk_x` from fewer terms — a
different statement — and can return `true`. Enforcing `signals.length === vk.IC.length - 1` is the
standard, mandatory Groth16 check. This is the one auth-critical primitive shipped identically to all
three build targets, and it has no test file at all.

**`package.json:71` / `.gitignore:134` — no lockfile is committed.** `.gitignore` lines 134–135 ignore
`yarn.lock` *and* `package-lock.json`; `git ls-files` confirms neither is tracked, so dependency
resolution is not reproducible and the `underscore` override cannot be verified as effective. `dist`
is gitignored too, and `release` is `npm publish` with no build step. Compounding it,
`npm publish --tag alpha && npm dist-tag add …@$npm_package_version latest` means a bare
`npm install @muhkoo/connect` installs prerelease crypto by default.

**`src/auth/vault.ts:20` — `@noble/hashes` is a phantom dependency.**
`import { scrypt } from "@noble/hashes/scrypt.js"` resolves only through `@noble/curves`' own tree. It
appears in neither `dependencies` nor `optionalDependencies`. A `@noble/curves` release that drops or
moves it breaks password protection at install time.

**`src/vcs/VcsNamespace.ts:438` — `abs()` concatenates without containment.**
`private abs(path) { return \`${this.root}${path}\` }` is plain concatenation, and `normalizePath`
implements `..` as `out.pop()` with no floor — so `/apps/x` plus `/../../etc/y` resolves to `/etc/y`.
`collect()` builds those paths from server-supplied tree entry names with no validation, then
`checkout` writes them via `writeManifest(this.abs(path), …)`. The module already exports an
`isUnder()` guard; `abs()` does not use it.

**`src/crypto/Authenticator.ts:83` — the nonce check compares the nonce to itself.**
`publicSignals = publicInput.toPublicSignals()`, then `expectedNonce = new Field(publicInput.nonce)` —
both sides derive from the same caller-supplied object, so the check is tautological and the ZK
handshake has no replay protection. The commitment check beside it *is* meaningful. `Authenticator`
and `DoubleRatchetManager` are not wired into `Client`, but both are public API via
`export * from "../crypto"` in the browser entry.

---

## What held up

Recording this matters as much as the findings — it is what makes the coverage claim checkable.
Twenty-five raw findings were refuted on close reading and stayed refuted.

- **Prototype pollution in CRDT merge.** Probed directly across `offline/crdt/merge.ts`, `LWWMap` and
  `ORSet`. The merge paths do not assign untrusted keys onto shared objects. The two real pollution
  vectors found are elsewhere (`utilities/index.ts:293`, and the VCS entry name).
- **DbNamespace query construction.** No string concatenation into a query, filter or sort reaches the
  backend; operator injection through a filter object was probed and not found. The `..` table-name
  issue is path handling, not query injection.
- **The bn128 pairing verifier's curve checks.** `g1m_inCurve` / `g2m_inCurve` are called on all three
  proof points before pairing, and X/Y coordinates are range-checked. The gap is the missing arity
  check, not point validation.
- **Space fan-out decode path.** The failing `Space.wire.test.ts:242` assertion is a stale
  under-settled test, *not* a `verifySender` regression.
- **AES-GCM nonce generation.** IVs are 12 random bytes from `crypto.getRandomValues` per message, with
  no counter-based construction and no `Math.random` fallback on any runtime path. The AEAD weakness
  is missing AAD, not nonce reuse.
- **Poseidon degradation.** The claim that Poseidon silently falls back to SHA-256 when `circomlibjs`
  is absent was raised twice and refuted twice on reading the actual load path.

---

## Remediation order

1. **Before any further release** — stop shipping alpha as `latest`, commit a lockfile, declare
   `@noble/hashes`, make `prepublishOnly` run the tests. Everything below is moot if a fix cannot be
   shipped reproducibly.
2. **Immediate** — turn the red suite green and re-enable the excluded crypto tests. Fix the two stale
   imports, remove them from the `vitest.config.ts` allowlist, stand up CI. You need a working harness
   before touching the protocols.
3. Pin the ZK artifacts and add the verifier's arity check (`signals.length === vk.IC.length - 1`).
   Small, self-contained, and closes the finding that hands the server the identity secret outright.
4. Switch the OPRF to `ristretto255_oprf.voprf` with pinned K1/K2 public keys and proof verification.
5. Bind wire identity to the ZK identity key, once, everywhere. One primitive closes the DM MITM, the
   roster forgery, the auto-admit hole and the join-request spoof. Default `autoAdmit` to false until
   it lands.
6. Add AAD to `encryptAesGcm` and thread context through every call site — kv envelopes to
   collection+id+version, VFS records to their path, VCS objects to their hash (plus the one-line
   re-hash on read), ratchet payloads to their header, space wraps to their space id.
7. Rewrite the ratchet's key schedule, or replace it with a reviewed implementation. Separate chains by
   role, add an X3DH-style ephemeral, cover the ciphertext in the signature, give
   `MessageNamespace.send` a recipient-scoped encrypt path.
8. Give logout a real teardown (`KeyStore.clear()`, non-extractable keys, close the personal-space
   socket, scope every offline store and room map to the commitment, clear the queue), and correct the
   documentation: say plainly that `client.db` rows and `client.storage` chunk keys are visible to the
   accelerator.

---

## Method and limits

**How this was produced.** 469 agents across five phases. Two recon passes built a trust-boundary map
and a complete external-surface inventory (every endpoint, persistence write and crypto call site),
given to all finders. Twenty-two threat-dimension finders then read their assigned files end to end.
Every finding was attacked by three independent verifiers with different mandates — one checking that
the code actually says what the finding claims, one tracing reachability from the public `Client` API,
one instructed to refute and to default to refuted under uncertainty — with a majority required to
survive. A completeness critic then diffed the 22 dimensions against all 145 source files and opened
six gap probes, which found the `MessageNamespace` DM fan-out, the `KeyStore` lifetime defects, the
`EventCore` cross-wiring, the wire-primitive issues, and the red test suite.

**What was verified by hand.** All five criticals and the headline highs, by reading the cited source
directly; the red test suite, by running `yarn test:unit`; and the five overturned refutations above.
Eleven `file:line` anchors carry two independent findings — corroboration, not duplication.

**Limits.** This is a client-side audit: the accelerator backend is out of scope, so server-side
mitigations (rate limits on the vault endpoint, allowlist enforcement on private channels, ws-ticket
scoping) may already blunt some paths — but none of them are visible to, or verifiable by, this SDK,
which is the point of the blind-relay design. Exploitability was reasoned from source, not
demonstrated with working exploits. Severity reflects the reachable impact the verifiers agreed on;
the refuted list is included above so the judgment calls are auditable rather than hidden.

Findings are anchored to commit `f40dddb` on `main`, version `0.14.0-alpha.7`. Line numbers will drift.
