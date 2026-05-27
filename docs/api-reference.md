# API Reference (docs/)

This file is the long-form companion to the repo-root `API_REFERENCE.md`. It
focuses on the classes and helpers exposed in the public build today.

## Contents

1. [BroadcastChannel](#broadcastchannel) — turnkey multi-peer E2EE
2. [EncryptedSession](#encryptedsession) — transport-agnostic ratchet manager
3. [WSTransport](#wstransport) — WebSocket lifecycle primitive
4. [KeyStore](#keystore) — ECDH + ECDSA P-384 keypair singleton
5. [DoubleRatchet](#doubleratchet) — low-level ratchet (internal)
6. [PersonalSpaceClient](#personalspaceclient) — ZK-gated personal KV client
7. [wrapWithPassphrase / unwrapWithPassphrase](#wrap-helpers) — PBKDF2+AES-GCM
8. [Groth16 verifier](#groth16-verifier) — universal bn128.wasm verifier
9. [Authenticator / ZeroKnowledge](#zk-helpers) — circuits, Field, Poseidon
10. [Events](#events) — `EventCore`, `EventCoreEvents`
11. [Messaging](#messaging) — `Message`, `Packet`

---

## BroadcastChannel

`src/sessions/BroadcastChannel.ts`. Multi-peer end-to-end-encrypted room
combining `WSTransport` + `EncryptedSession`. Per-instance EventTarget; events
do NOT leak across BroadcastChannels.

```typescript
import { BroadcastChannel, BroadcastChannelEvents } from "@muhkoo/connect";

const channel = new BroadcastChannel({
  url: "wss://accelerator.example.dev/room/foo",
  myId: "alice@example.dev",
  autoAnnounce: false, // call announce() after your own bootstrap handshake
});
```

**Options** — extend `WSTransportOptions` (`url`, `autoReconnect`,
`reconnectDelay`, `maxReconnectAttempts`, `maxQueueSize`) plus:

- `myId: string` — local identity (chat app uses commitment-derived usernames)
- `autoAnnounce?: boolean` — default false; if true, announce on `CONNECTED`

**Methods**:

| Method | Notes |
| --- | --- |
| `connect()` | Generates keys + opens socket |
| `disconnect()` | Stops reconnect and closes |
| `announce()` | Sends our `{ keyExchange }` once (idempotent) |
| `send(text)` | Fan-out: one cipherMessage per peer. Returns peer count. |
| `sendRaw(frame)` | `JSON.stringify(frame)` then send (unencrypted) |
| `peers()` | List of peer ids with established ratchets |
| `forgetPeer(id)` | Drop a peer's ratchet |
| `isConnected()` | Transport connectivity |
| `on(event, cb)`, `off(event, cb)` | Per-instance EventTarget |

**Events** (constants on `BroadcastChannelEvents`):

- `CONNECTED` / `DISCONNECTED` / `RECONNECTING` / `ERROR` — lifecycle
- `PEER_HANDSHAKE` (`"channel:peer_handshake"`) — `detail: { peerId }`
- `MESSAGE` (`"channel:message"`) — `detail: { from, text, cipherMessage }`
- `RAW_FRAME` (`"channel:raw_frame"`) — anything not channel-managed

---

## EncryptedSession

`src/sessions/EncryptedSession.ts`. Transport-agnostic. Wraps a per-peer
`DoubleRatchet` plus role assignment + handshake dedup.

```typescript
const session = new EncryptedSession({ myId: "alice" });
await session.initialize();
const kx = await session.getOwnKeyExchange();
yourTransport.send(JSON.stringify(kx));

const result = await session.receive(JSON.parse(inbound));
// result.kind: "plaintext" | "handshake" | "ignored"
```

**Methods**:

- `initialize(): Promise<void>` — idempotent
- `get ready: Promise<void>` — resolves after `initialize()`
- `get id: string`
- `getOwnKeyExchange(): Promise<{ keyExchange: KeyExchangeFrame }>`
- `encrypt(plaintext): Promise<CipherFrame[]>` — empty array means no peers
- `receive(frame): Promise<ReceiveResult>`
- `peers(): string[]`
- `hasRatchetFor(peerId): boolean`
- `forgetPeer(peerId): void`

**ReceiveResult** is a discriminated union:

```typescript
type ReceiveResult =
  | { kind: "plaintext"; from: string; text: string; cipherMessage: CipherMessage }
  | { kind: "handshake"; peerId: string; outbound: { keyExchange } | null }
  | { kind: "ignored"; reason: string };
```

When `kind === "handshake"`, `outbound` is set the first time we see a peer
(reciprocation); the app must transmit it. Subsequent re-handshakes from the
same peer return `outbound === null` (dedup via internal `sentHandshakeTo`).

**Role assignment**: `isClient = (myId < peerId)` lexicographically.
**Per-pair sessionId**: `[myId, peerId].sort().join(":")` — same string on
both sides.

**Frame shapes**:

```typescript
interface KeyExchangeFrame {
  type: "handshake" | "update";
  userId: string;
  ecdhPublicKey: string;   // base64(JSON.stringify(JWK)) of ECDH pub
  ecdsaPublicKey: string;  // base64(JSON.stringify(JWK)) of ECDSA pub
}

interface CipherFrame { cipherMessage: CipherMessage; }
```

---

## WSTransport

`src/transport/WSTransport.ts`. Pure WebSocket lifecycle. Owns the socket
and emits `EventCoreEvents.MESSAGE` with raw frame strings; higher layers
parse them.

```typescript
const transport = new WSTransport({
  url: "wss://example.dev/ws",
  autoReconnect: true,     // default true
  reconnectDelay: 3000,    // ms, default 3000
  maxReconnectAttempts: 5, // default 5; 0 means unlimited
  maxQueueSize: 100,       // default 100 outbound frames while disconnected
});
```

**Methods**:

- `connect(): Promise<void>` — resolves on `CONNECTED`, rejects on first error
- `disconnect(): void` — stops reconnect + closes
- `send(frame: string): void` — queues if disconnected; throws when queue full
- `isConnected()`, `isConnecting()`, `queuedFrames()`, `reconnectAttemptCount()`

**Events** (via inherited `EventCore`):

- `EventCoreEvents.CONNECTED`
- `EventCoreEvents.DISCONNECTED`
- `EventCoreEvents.RECONNECTING` (`detail: { attempt }`)
- `EventCoreEvents.ERROR`
- `EventCoreEvents.MESSAGE` (`detail: rawFrameString`)

---

## KeyStore

`src/crypto/KeyStore.ts`. Singleton (`KeyStore.getInstance()`). Each
identity has an ECDH P-384 pair (for ratchet DH) and an ECDSA P-384 pair
(for message signing).

| Method | Description |
| --- | --- |
| `generateOwnKeyPair(id)` | Creates both ECDH + ECDSA pairs. Throws if `id` already has an ECDH pair. |
| `storeRemotePublicKeys(id, ecdhPub, ecdsaPub)` | Stash a peer's pubkeys (private fields stay `null`) |
| `getKeyPair(id)` | Returns `{ privateKey, publicKey }` for ECDH (`privateKey: null` for remote) |
| `getAuthKeyPair(id)` | Same shape, for ECDSA |
| `getRawEcdsaPublicKey(id)` | SEC1 uncompressed `0x04 || x || y` (used by ZK identity binding) |
| `dehydrateKeyPair(id)` | JWK → `serialize(...)` for each of 4 fields |
| `hydrateKeyPair(id, dehydrated)` | reverse of dehydrate |
| `packDehydratedKeys(id)` | `base64(JSON.stringify(dehydrated))` |
| `hydrateFromPacked(id, packed)` | reverse of pack |

**DehydratedKeys**:

```typescript
interface DehydratedKeys {
  ecdhPub: string;
  ecdhPriv: string;  // "" if no private (remote-only)
  ecdsaPub: string;
  ecdsaPriv: string; // "" if no private
}
```

The fields are JWK JSON run through the project's `serialize()` helper
(gzip + base58). `packDehydratedKeys` wraps the whole thing as base64 for
easy passphrase-wrap into personal-space KV.

---

## DoubleRatchet

`src/crypto/DoubleRatchet.ts`. Low-level Signal-style ratchet. Used
internally by `EncryptedSession`. Most consumers should never touch it
directly. It is in all three builds (the snarkjs/o1js dependency was on
`Authenticator` and `ZeroKnowledge`, not the ratchet itself).

```typescript
new DoubleRatchet(senderId, recipientId, sessionType, isClient);
await ratchet.initializeSession(isClient);
const cm = await ratchet.encrypt(text, false, senderId, recipientId, sessionId, "specific");
const text = await ratchet.decrypt(cm, isClient);
```

---

## PersonalSpaceClient

`src/personal/PersonalSpaceClient.ts`. HTTP wrapper around the accelerator's
ZK-gated KV API. **NOT in the workers build** — uses `snarkjs.groth16.fullProve`
which pulls in `ffjavascript` and Node-only APIs.

```typescript
const client = new PersonalSpaceClient({
  baseUrl: "https://accelerator.example.dev",
  commitment, secret, salt, ecdsaPub, ecdsaPubHash,
  circuits: {
    wasmUrl: "/circuits/build/preimagePoK_js/preimagePoK.wasm",
    zkeyUrl: "/circuits/build/preimagePoK_0001.zkey",
  },
});

await client.put(key, value);              // POST /api/personal/:c/kv/:k
const v = await client.get(key);           // POST /api/personal/:c/kv/:k/get
const existed = await client.delete(key);  // DELETE /api/personal/:c/kv/:k
const keys = await client.list();          // POST /api/personal/:c/list
```

Each call:

1. POST `/api/personal/:commitment/challenge` → `{ challengeId, nonce, commitment }`
2. Reduce hex `nonce` to a BN254 field element by `BigInt(nonce) % q`
3. `snarkjs.groth16.fullProve({ commitment, nonce, ecdsaPubHash, secret, salt, ecdsaPub }, wasmUrl, zkeyUrl)`
4. POST the gated endpoint with `{ challengeId, proof, publicSignals, value? }`

`commitment / secret / salt / ecdsaPub / ecdsaPubHash` are decimal-encoded
BigInt strings (snarkjs convention). The accelerator's chat app derives them
deterministically from `(username, password)` via PBKDF2 → HKDF-Expand →
`@noble/curves` for P-256 → Poseidon commitment.

`snarkjs` is a bare-specifier import; rollup externalizes it. Browser
consumers provide it via import map (esm.sh in the chat app); Node consumers
install it as a peer dependency.

---

## Wrap helpers

`src/personal/wrap.ts`. PBKDF2-SHA256 (200_000 iterations) → 256-bit AES-GCM
key → encrypt with random 16-byte salt + 12-byte IV. NOT in workers build.

```typescript
const wrapped = await wrapWithPassphrase("hunter2", new TextEncoder().encode("hello"));
// {
//   salt: "...",        // base64, 16 bytes
//   iv: "...",          // base64, 12 bytes
//   ciphertext: "...",  // base64, includes 16-byte GCM auth tag
//   alg: "PBKDF2-SHA256/AES-256-GCM",
//   iter: 200000,
// }

const plaintext = await unwrapWithPassphrase("hunter2", wrapped);
```

`unwrapWithPassphrase` throws `"decryption failed (wrong passphrase or
tampered payload)"` on AES-GCM tag mismatch. Callers treat that as "wrong
passphrase".

---

## Groth16 verifier

`src/workers/groth16-verifier.ts`. The name is historical — this file works
in Node, browsers, AND CF Workers. Drives bn128.wasm directly; does not
pull in snarkjs / ffjavascript / @zk-kit/groth16.

```typescript
import {
  initBn128Wasm,
  verifyGroth16,
  PREIMAGE_POK_VERIFICATION_KEY,
} from "@muhkoo/connect";

// At boot, once:
const { instance, memory, initialPFree } = await initBn128Wasm();

// Per verification:
const ok = await verifyGroth16(
  instance, memory, initialPFree,
  PREIMAGE_POK_VERIFICATION_KEY,
  proof, publicSignals,
);
```

**Two initialization paths**:

1. `initBn128Wasm()` — uses the bundled bn128.wasm (base64-inlined at build
   time by `@rollup/plugin-wasm`). Works in any modern JS runtime that allows
   runtime `WebAssembly.compile()`.
2. `initBn128Wasm(myWasmModule)` — accepts a pre-compiled
   `WebAssembly.Module`. Recommended inside CF Workers, where wrangler can
   precompile `.wasm` imports at deploy time and avoid the runtime compile.

`verifyGroth16` returns `false` for any structural issue (malformed proof,
out-of-range field elements, off-curve points, failed pairing); it only
throws on WASM/runtime faults.

Pinned VK: `PREIMAGE_POK_VERIFICATION_KEY` in `src/types/zk.ts` matches the
`preimagePoK_verification_key.json` shipped from the accelerator. Re-generate
both together if the circuit is recompiled.

---

## ZK helpers

`src/crypto/ZeroKnowledge.ts`. circomlibjs + snarkjs-backed. **NOT in workers
build**. Exports:

- `Field`, also re-exported as `FieldElement` — BN254 scalar field wrapper
- `Poseidon` — `hash(fields: Field[]): Field`
- `PreimagePoK`, `HashKnowledge` — circuit interfaces
- `AuthPublicInput` — `{ commitment, nonce, ecdsaPubHash }`
- `verifyPreimagePoK`, `verifyHashKnowledge`, `verify`, `quickVerify`
- `compilePrograms`, `initializeCircuits` — boot-time setup
- `encodeToHex(field) -> string`, `decodeFromHex(hex) -> Field`
- types: `SnarkProof` (alias for `Groth16Proof`), `VerificationKey`,
  `ZkCompiled`, `CircuitBufferConfig`

`Authenticator` (`src/crypto/Authenticator.ts`) is the higher-level
counterpart that combines ZK proof verification with ECDSA auth tokens.

---

## Events

```typescript
enum EventCoreEvents {
  CONNECTED = "connected",
  DISCONNECTED = "disconnected",
  RECONNECTING = "reconnecting",
  ERROR = "error",
  DATA_RECEIVED = "data_received",
  DATA_SENT = "data_sent",
  MESSAGE = "message",
  GET_HISTORY = "get_history",
  RECEIVED_HISTORY = "received_history",
}
```

`EventCore` (`src/events/EventCore.ts`) exposes static `on/off/emit` over an
internal `EventTarget`. `WSTransport` extends it; `BroadcastChannel` uses its
own per-instance `EventTarget` but reuses the enum's strings for lifecycle
events.

---

## Messaging

`src/messaging/`. Lower-level building blocks used by the legacy `Network`
and `Storage` classes. Useful if you're writing a custom protocol on top of
`WSTransport`.

- `Message` — body + status + base58-checked serialization
- `Packet` — addressing wrapper for routing messages between peers
- `SerializeMessage` — method decorator
- `decorators` — namespace of all method decorators

`Network` (`src/network/Network.ts`) and `Storage` (`src/storage/Storage.ts`)
exist in the source tree but are NOT exported from any build. They're being
phased out in favor of the new session / channel primitives.

---

## Symbols that are NOT in the public surface

If you saw these in older docs, they're gone (or were never real):

- `MuhkooClient` (planned facade — not implemented)
- `SessionManager`, `ApiClient` (referenced by stale examples/tests)
- `client.auth`, `client.storage`, `client.message`, `client.shared`
- `generateEphemeralKeypair`, `deriveSharedSecret`, `dehydratePublicKey`,
  `hydratePublicKey` from `@muhkoo/connect/crypto`
- `compressDehydratedKeys` / `hydrateFromCompressed` — replaced by
  `packDehydratedKeys` / `hydrateFromPacked`
- App-token / api-token API (`X-App-Token`, `AppTokenValidator`, etc.) —
  see `docs/api-token-*.md` for the design; no implementation.
