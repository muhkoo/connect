# Cryptographic Architecture

This document covers the cryptography behind the Connect SDK as it stands
today. The user-facing surface is `BroadcastChannel` / `EncryptedSession`
plus the `PersonalSpaceClient` (for ZK-gated personal storage). The
`DoubleRatchet` and `KeyStore` primitives sit underneath; the
`Authenticator` / `PreimagePoK` ZK helpers are used at registration /
challenge-response time.

## Contents

1. [Layered overview](#layered-overview)
2. [Double Ratchet primitives](#double-ratchet-primitives)
3. [Key management](#key-management)
4. [Session orchestration: EncryptedSession + BroadcastChannel](#session-orchestration)
5. [Zero-knowledge authentication](#zero-knowledge-authentication)
6. [Personal-space storage flow](#personal-space-storage-flow)
7. [Universal Groth16 verifier](#universal-groth16-verifier)
8. [Cryptographic primitives summary](#primitives-summary)
9. [Threat model](#threat-model)

## Layered overview

```
+----------------------------------------------------------+
|                application code                          |
|     (chat UI, personal-space CRUD, custom protocols)     |
+--------------------+-------------------------------------+
                     |
        +------------+------------+--------------------+
        v                         v                    v
+----------------+   +-------------------+    +--------------+
| BroadcastChannel|   | EncryptedSession  |   | PersonalSpace |
| (turnkey room)  |   | (BYO transport)   |   |    Client     |
+--------+-------+   +---------+---------+    +-------+------+
         |                     |                      |
         v                     v                      v
+----------------+    +------------------+    +-----------------+
|   WSTransport  |    |  app's transport |    |  fetch + snarkjs|
+----------------+    +------------------+    +-----------------+
         |                     |                      |
         |                     +----+--+--+           |
         +----------> +-----------+   |  |            |
                      | DoubleRatchet |  |            |
                      +-------+-------+  |            |
                              |          |            |
                              v          v            v
                        +----------+ +----------+ +------------+
                        |  KeyStore | | ZK helpers|  Groth16    |
                        | (ECDH/ECDSA)|(Field,Poseidon)| verifier |
                        +----------+ +----------+ +------------+
```

The blocks in the bottom row are the shared primitives. The middle row is
what consumers actually instantiate today.

## Double Ratchet primitives

### Algorithm shape

`src/crypto/DoubleRatchet.ts` implements a Signal-style Double Ratchet:

1. **DH ratchet** — ECDH P-384 keypairs that rotate (in this implementation,
   every 100 messages by default).
2. **Symmetric ratchet** — HKDF-SHA-256 derives a fresh message key for each
   send, after which the root key advances.

```
Initial:
  sharedSecret = ECDH(myEcdhPriv, peerEcdhPub)
  rootKey      = HKDF(sharedSecret, "DoubleRatchetInit", 32)

Per message:
  (messageKey, newRootKey) = HKDF(rootKey, "DoubleRatchetMsg", 64)
  ciphertext               = AES-256-GCM(messageKey, plaintext, iv)

Periodic DH ratchet:
  newPriv, newPub  = ECDH(P-384).generate()
  newSharedSecret  = ECDH(newPriv, peerEcdhPub)
  (newRoot, newCK) = HKDF(rootKey || newSharedSecret, "DoubleRatchetDH", 64)
```

### State

Each ratchet keeps:

- ECDH `myPriv` / `myPub` / `peerPub`
- Root key, send chain key, recv chain key
- `sendCount`, `recvCount`, `prevChainLength`
- Out-of-order: `currentSkippedKeys` (keys already derived but not yet used)
  and `oldSkippedMessageKeys` (keys from the previous DH chain, retained
  for ~30 s after a DH ratchet)
- Max skip = 3000 (anything past that gap is rejected — DoS guard)

### Out-of-order handling

When message `n+k` arrives before `n`, the ratchet derives the keys for
`n..n+k-1` and stashes them in `currentSkippedKeys`. Late arrivals look up
their key, use it once, then drop it.

## Key management

### KeyStore (`src/crypto/KeyStore.ts`)

Singleton. One entry per identity string. Holds ECDH (for the ratchet) and
ECDSA (for message signing) P-384 pairs. Public surface:

| Method | Purpose |
| --- | --- |
| `generateOwnKeyPair(id)` | New ECDH + ECDSA pair for this identity |
| `storeRemotePublicKeys(id, ecdhPub, ecdsaPub)` | Stash a peer's pubkeys |
| `getKeyPair(id)`, `getAuthKeyPair(id)` | Lookup |
| `getRawEcdsaPublicKey(id)` | SEC1 uncompressed bytes (used by ZK identity binding) |
| `dehydrateKeyPair(id)` | JWK → serialized string per field |
| `hydrateKeyPair(id, dehydrated)` | reverse |
| `packDehydratedKeys(id)` | `base64(JSON.stringify(dehydrated))` |
| `hydrateFromPacked(id, packed)` | reverse |

`dehydrate` returns four serialized fields (`ecdhPub/Priv`, `ecdsaPub/Priv`).
Private fields are empty strings for remote-only identities. `pack`/
`hydrateFromPacked` give you a single base64 string that can be passphrase-wrapped
(via `wrapWithPassphrase`) and stashed in the accelerator's personal-space
KV — the chat app uses this to persist client identities across reloads.

### Multi-identity isolation

Because the store is keyed by identity string, "tenant isolation" is just
"use different identity strings". There is no cross-identity decryption path
unless keys are explicitly exchanged via `storeRemotePublicKeys`.

## Session orchestration

### EncryptedSession (`src/sessions/EncryptedSession.ts`)

Transport-agnostic. One instance per local identity; tracks one
`DoubleRatchet` per peer.

```typescript
const session = new EncryptedSession({ myId: "alice" });
await session.initialize();

// Outbound bootstrap:
const kx = await session.getOwnKeyExchange();
yourTransport.send(JSON.stringify(kx));

// Per inbound frame:
const result = await session.receive(JSON.parse(rawFrame));
switch (result.kind) {
  case "handshake":
    if (result.outbound) yourTransport.send(JSON.stringify(result.outbound));
    break;
  case "plaintext":
    handle(result.from, result.text);
    break;
  case "ignored":
    // not our problem
    break;
}

// Outbound message — one ciphertext per peer:
const frames = await session.encrypt("hi");
for (const f of frames) yourTransport.send(JSON.stringify(f));
```

Two key design choices:

- **Deterministic role assignment.** `isClient = (myId < peerId)`
  lexicographically. Both sides agree on who plays which role without an
  explicit negotiation.
- **Handshake dedup.** `sentHandshakeTo` set prevents bouncing the same
  reciprocation back to a peer that's re-announced.

### BroadcastChannel (`src/sessions/BroadcastChannel.ts`)

Composes `WSTransport` + `EncryptedSession`. Designed to drop onto a chat
protocol without changing the wire format:

| Inbound | Action |
| --- | --- |
| `{ keyExchange }` | route to `session.receive`; reciprocate if needed; fire `PEER_HANDSHAKE` |
| `{ cipherMessage }` | decrypt via `session.receive`; fire `MESSAGE` |
| anything else | fire `RAW_FRAME` for the app |

Events live on a per-instance `EventTarget`, so two channels in one app do
not cross-contaminate each other's events. (This is a deliberate departure
from the older `Network` class, which used the static `EventCore` and had
that exact bug.)

## Zero-knowledge authentication

The chat app does NOT do a long-lived ZK handshake over the WebSocket.
Instead, ZK proofs are used at two specific points:

1. **Identity registration** — when a user first uses a passphrase, the
   client side derives `(secret, salt, ecdhPriv, ecdsaPriv)` from
   `(username, password)`, computes
   `commitment = Poseidon(secret, salt, Poseidon(ecdsaPub))`, and ships that
   commitment to the accelerator. The accelerator never sees `secret` or
   `salt`.
2. **Personal-space operations** — every call to
   `PersonalSpaceClient.{put,get,delete,list}` first POSTs `/challenge`, then
   generates a fresh Groth16 proof over the `preimagePoK` circuit binding
   `(commitment, nonce, ecdsaPubHash)` as public signals and
   `(secret, salt, ecdsaPub)` as private witnesses. The accelerator verifies
   the proof via `verifyZkAuthProof` (driven by `verifyGroth16` from this
   package).

### preimagePoK circuit

Public signals (in order):

1. `commitment` — Poseidon(secret, salt, ecdsaPubHash)
2. `nonce` — a fresh BN254 field element (the accelerator's hex nonce mod BN254 q)
3. `ecdsaPubHash` — Poseidon(ecdsaPub field)

Private witnesses:

- `secret`, `salt`, `ecdsaPub`

`PREIMAGE_POK_VERIFICATION_KEY` (pinned in `src/types/zk.ts`) is the literal
verifying key the bn128.wasm verifier uses; it must stay in sync with
`accelerator/public/circuits/build/preimagePoK_verification_key.json`.

### Why two layers (handshake vs. ZK)?

- The handshake (`BroadcastChannel`/`EncryptedSession`) binds peers to each
  other on a WebSocket. It uses ordinary ECDH + ECDSA — no ZK.
- The ZK layer binds a *user* to the *accelerator backend* for personal-space
  operations. It proves ownership of a Poseidon commitment without revealing
  the preimage.

The two layers are independent. The chat protocol can run E2EE without ever
touching ZK; the personal-space protocol uses ZK without touching the chat
ratchet.

## Personal-space storage flow

End-to-end, from the SDK's point of view:

```
+-------+                                            +-----------------+
| user  |                                            | accelerator     |
+---+---+                                            +--------+--------+
    |   PersonalSpaceClient.put(key, wrappedValue)            |
    |--------------------------------------------------------->|
    |                                              POST /challenge
    |    { challengeId, nonce, commitment }                    |
    |<---------------------------------------------------------|
    | nonceField = BigInt(nonce) % BN254_q                    |
    | proof = snarkjs.groth16.fullProve(                       |
    |   { commitment, nonce: nonceField, ecdsaPubHash,         |
    |     secret, salt, ecdsaPub },                            |
    |   wasmUrl, zkeyUrl)                                       |
    |                                                          |
    | POST /kv/:key { challengeId, proof, publicSignals,      |
    |                  value: wrappedValue }                   |
    |--------------------------------------------------------->|
    |                                              verify with bn128.wasm
    |                                              (verifyZkAuthProof)
    |                                              consume challengeId
    |    { ok: true }                              persist value
    |<---------------------------------------------------------|
```

`wrappedValue` typically comes from `wrapWithPassphrase(passphrase, bytes)`:
PBKDF2-SHA256 (200k iters) → AES-256-GCM with random salt+IV. The
accelerator only ever sees opaque JSON.

## Universal Groth16 verifier

`src/workers/groth16-verifier.ts`. Despite the path, it works in Node,
browsers, AND edge runtimes. Bn128.wasm-driven; does not depend on
snarkjs or ffjavascript (which both fail on the edge).

Two init paths:

1. `await initBn128Wasm()` — uses the bundled bn128.wasm
   (base64-inlined at build time by `@rollup/plugin-wasm`).
2. `await initBn128Wasm(myWasmModule)` — accepts a pre-compiled
   `WebAssembly.Module`. On an edge runtime the deploy toolchain can
   precompile a `.wasm` import and avoid the runtime compile.

`verifyGroth16(instance, memory, initialPFree, vk, proof, publicSignals)`
returns `false` for any structural problem (off-curve points, out-of-range
field elements, malformed proof, failed pairing) and throws only for
runtime/WASM faults.

This module is the only Groth16 path that runs on an edge runtime — the
accelerator's `verifyZkAuthProof` uses it for the personal space.

## Primitives summary

| Use | Primitive | Notes |
| --- | --- | --- |
| Key agreement (chat ratchet) | ECDH P-384 | per identity in `KeyStore` |
| Message signing (chat) | ECDSA P-384 | per identity in `KeyStore` |
| Symmetric encryption | AES-256-GCM | per-message key from ratchet |
| Key derivation | HKDF-SHA-256 | root/chain/message keys |
| Passphrase wrap | PBKDF2-SHA256 (200_000) → AES-256-GCM | `wrapWithPassphrase` |
| ZK commitment | Poseidon over BN254 scalar field | identity registration |
| ZK proof | Groth16 over `preimagePoK` (BN254) | per-request, snarkjs prover |
| ZK verification | Groth16 via bn128.wasm | runs in Node/browser/Workers |

## Threat model

**Assumed:**

- TLS protects the transport. (We do not authenticate the WebSocket beyond
  the higher-layer keyExchange.)
- The BN254 curve and snarkjs's Groth16 implementation are sound.
- ECDH P-384 and AES-256-GCM are secure.

**Defended against:**

- Passive eavesdropping on the chat (E2EE)
- Server impersonating users in personal-space (proof binds to ECDSA pub
  + commitment, accelerator can't forge a proof)
- Replay attacks on personal-space (one-shot challenge nonces, consumed
  after verify)
- Cross-instance event leakage in `BroadcastChannel` (per-instance
  `EventTarget`)

**NOT defended against:**

- Endpoint compromise — if the client or server is rooted, all bets are off
- Metadata leakage — sender/recipient IDs in the chat protocol are
  cleartext
- DoS — no rate limiting in the crypto layer
- Post-quantum — P-384 + BN254 + AES-GCM-256 are pre-PQ
- Deniability — ECDSA signatures prove authorship

## Open work

- The chat protocol does not yet make use of ZK identity for peer-to-peer
  authentication. Today, peers identify themselves with `myId` strings; only
  the personal-space layer binds those to ZK commitments.
- Session persistence across reloads is the consumer's responsibility — the
  ratchet state is purely in-memory in `DoubleRatchet`. The chat app re-runs
  the handshake on reconnect.

## References

- [Signal Double Ratchet specification](https://signal.org/docs/specifications/doubleratchet/)
- [Groth16 paper](https://eprint.iacr.org/2016/260)
- [Circom + snarkjs](https://docs.circom.io/)
- [BN254 / alt_bn128 curve](https://hackmd.io/@aztec-network/ByzgNxBfd)
