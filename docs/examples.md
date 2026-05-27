# Examples

End-to-end usage of the public APIs in `@muhkoo/connect`. Every snippet below
imports symbols that actually exist in `src/`.

## Contents

1. [BroadcastChannel — turnkey multi-peer E2EE room](#1-broadcastchannel)
2. [EncryptedSession — bring your own transport](#2-encryptedsession)
3. [PersonalSpaceClient — ZK-gated personal KV](#3-personalspaceclient)
4. [wrapWithPassphrase + PersonalSpaceClient — encrypted KV](#4-wrap-the-payload)
5. [verifyGroth16 — universal proof verification](#5-verifygroth16)
6. [WSTransport — pure WebSocket lifecycle](#6-wstransport)
7. [KeyStore — dehydrate + hydrate identities](#7-keystore)

---

## 1. BroadcastChannel

Multi-peer end-to-end-encrypted "room" over a WebSocket. Wires
`WSTransport` + `EncryptedSession`. Per-instance EventTarget; safe to
instantiate multiple side by side.

```typescript
import { BroadcastChannel, BroadcastChannelEvents } from "@muhkoo/connect";

const channel = new BroadcastChannel({
  url: "wss://accelerator.example.dev/room/team-chat",
  myId: "alice@example.dev",
});

channel.on(BroadcastChannelEvents.CONNECTED, () => {
  console.log("ws open");
});

channel.on(BroadcastChannelEvents.PEER_HANDSHAKE, (e) => {
  console.log("peer ready:", e.detail.peerId);
});

channel.on(BroadcastChannelEvents.MESSAGE, (e) => {
  const { from, text } = e.detail;
  console.log(`${from}: ${text}`);
});

channel.on(BroadcastChannelEvents.RAW_FRAME, (e) => {
  // Anything not channel-managed. The chat app uses this for {name}, {file}, etc.
  console.log("app frame:", e.detail);
});

channel.on(BroadcastChannelEvents.ERROR, (e) => {
  console.error("channel error:", e.detail);
});

// Generate keys + open WS.
await channel.connect();

// Send our identity first (app-level handshake), then announce ZK keys.
channel.sendRaw({ name: "alice@example.dev" });
await channel.announce();

// Outbound: one cipherMessage per peer ratchet.
const sentTo = await channel.send("hello room");
if (sentTo === 0) {
  // No peers handshaken yet — render locally and try again later.
}

// Tear down a peer.
channel.forgetPeer("bob@example.dev");

// Stop.
channel.disconnect();
```

The wire protocol is JSON frames:

- `{ keyExchange: { type, userId, ecdhPublicKey, ecdsaPublicKey } }` — created
  by `announce()`, consumed by `session.receive()`
- `{ cipherMessage: { header, ciphertext, nonce } }` — created by `send()`,
  fanned out one per peer
- anything else — `channel.sendRaw(obj)` to send, `RAW_FRAME` event to receive

---

## 2. EncryptedSession

Use this if you want to ship encrypted frames over something other than a
WebSocket (HTTP polling, WebRTC data channel, etc.). `EncryptedSession` does
no transport work.

```typescript
import { EncryptedSession } from "@muhkoo/connect";

const session = new EncryptedSession({ myId: "alice" });
await session.initialize();

// Bootstrap outbound:
const kx = await session.getOwnKeyExchange();
yourTransport.send(JSON.stringify(kx));

// Handle each inbound frame:
async function onInbound(raw: string) {
  const result = await session.receive(JSON.parse(raw));
  switch (result.kind) {
    case "handshake":
      if (result.outbound) {
        yourTransport.send(JSON.stringify(result.outbound));
      }
      console.log("peer ready:", result.peerId);
      break;
    case "plaintext":
      console.log(`${result.from}: ${result.text}`);
      break;
    case "ignored":
      // Bad frame, addressed elsewhere, duplicate handshake, etc.
      console.debug("ignored:", result.reason);
      break;
  }
}

// Outbound message — one frame per peer ratchet.
const frames = await session.encrypt("hello peers");
for (const f of frames) yourTransport.send(JSON.stringify(f));
```

Role assignment is deterministic: `isClient = (myId < peerId)`
lexicographically. The per-pair sessionId is `[myId, peerId].sort().join(":")`,
which both sides arrive at independently.

---

## 3. PersonalSpaceClient

The accelerator hosts a per-user ZK-gated KV store. The client generates a
fresh Groth16 proof per call and POSTs it alongside the operation.

```typescript
import { PersonalSpaceClient } from "@muhkoo/connect";

const client = new PersonalSpaceClient({
  baseUrl: "https://accelerator.example.dev",

  // Decimal-encoded BigInt strings (snarkjs convention).
  // The chat app derives these deterministically from (username, password)
  // via PBKDF2 -> HKDF-Expand -> @noble/curves P-256 -> Poseidon.
  commitment: "12345...",
  secret:     "234...",
  salt:       "345...",
  ecdsaPub:   "456...",
  ecdsaPubHash: "567...",

  circuits: {
    wasmUrl: "/circuits/build/preimagePoK_js/preimagePoK.wasm",
    zkeyUrl: "/circuits/build/preimagePoK_0001.zkey",
  },
});

await client.put("profile", { displayName: "Alice", joined: Date.now() });
const profile = await client.get<{ displayName: string }>("profile");
const keys = await client.list();
const existed = await client.delete("profile"); // boolean
```

Each call performs:

1. `POST /api/personal/:commitment/challenge` → `{ challengeId, nonce, commitment }`
2. Reduce `nonce` (hex) to a BN254 field element (mod the scalar field).
3. `snarkjs.groth16.fullProve({ commitment, nonce, ecdsaPubHash, secret, salt, ecdsaPub }, wasmUrl, zkeyUrl)`.
4. POST the gated endpoint with `{ challengeId, proof, publicSignals, value? }`.

`snarkjs` is a bare-specifier import. Browser apps provide it via import map
(the accelerator's chat app uses esm.sh); Node apps install it as a peer
dependency.

> `PersonalSpaceClient` is NOT in the workers build (`snarkjs` has Node-only
> transitive deps). Use it from the browser or Node only.

---

## 4. Wrap the payload

Combine `wrapWithPassphrase` + `PersonalSpaceClient` to ensure the
accelerator only ever sees opaque ciphertext.

```typescript
import {
  PersonalSpaceClient,
  wrapWithPassphrase,
  unwrapWithPassphrase,
  type WrappedPayload,
} from "@muhkoo/connect";

const enc = new TextEncoder();
const dec = new TextDecoder();

// Save:
const wrapped = await wrapWithPassphrase(
  "hunter2",
  enc.encode(JSON.stringify({ secret: 42 })),
);
// wrapped = {
//   salt: "<base64>", iv: "<base64>", ciphertext: "<base64>",
//   alg: "PBKDF2-SHA256/AES-256-GCM", iter: 200000,
// }
await client.put("vault", wrapped);

// Load:
const stored = await client.get<WrappedPayload>("vault");
if (stored) {
  try {
    const bytes = await unwrapWithPassphrase("hunter2", stored);
    const value = JSON.parse(dec.decode(bytes));
    console.log("unwrapped:", value);
  } catch (err) {
    // AES-GCM tag mismatch — wrong passphrase or tampered payload.
    console.error("decrypt failed");
  }
}
```

The chat app uses this pattern to persist client identity material
(packed `KeyStore` blob → wrapped with the user's password → stored in
personal-space KV under the user's commitment).

---

## 5. verifyGroth16

Verify a Groth16 proof anywhere — Node, browsers, or CF Workers.

```typescript
import {
  initBn128Wasm,
  verifyGroth16,
  PREIMAGE_POK_VERIFICATION_KEY,
  type Groth16Proof,
} from "@muhkoo/connect";

// Initialize once at boot.
const { instance, memory, initialPFree } = await initBn128Wasm();

async function verifyProof(proof: Groth16Proof, publicSignals: string[]) {
  return verifyGroth16(
    instance, memory, initialPFree,
    PREIMAGE_POK_VERIFICATION_KEY,
    proof, publicSignals,
  );
}
```

In a CF Worker you'd normally pre-compile the wasm at deploy time:

```typescript
// wrangler precompiles this at deploy time.
import wasmModule from "./bn128.wasm";

const ctx = await initBn128Wasm(wasmModule);
```

`verifyGroth16` returns `false` for any structural problem (malformed proof,
out-of-range field elements, off-curve points, failed pairing). It throws
only on runtime/WASM faults.

The accelerator's `verifyZkAuthProof` is built on exactly this API.

---

## 6. WSTransport

If you don't want the framing logic of `BroadcastChannel`, you can use the
raw transport on its own.

```typescript
import { WSTransport, EventCoreEvents } from "@muhkoo/connect";

const ws = new WSTransport({
  url: "wss://example.dev/ws",
  autoReconnect: true,
  reconnectDelay: 3000,
  maxReconnectAttempts: 0,    // unlimited
  maxQueueSize: 250,
});

ws.on(EventCoreEvents.CONNECTED, () => console.log("connected"));
ws.on(EventCoreEvents.MESSAGE, (e) => {
  // e.detail is the raw frame string the server sent.
  handleFrame(e.detail);
});
ws.on(EventCoreEvents.RECONNECTING, (e) => {
  console.log("reconnect attempt", e.detail.attempt);
});

await ws.connect();
ws.send(JSON.stringify({ type: "ping" }));
ws.disconnect();
```

While disconnected, `send()` queues frames (up to `maxQueueSize`) and they
flush automatically on the next successful reconnect.

---

## 7. KeyStore

Dehydrate identities for persistence (e.g. to passphrase-wrap and stash in
personal-space KV):

```typescript
import { KeyStore, wrapWithPassphrase, unwrapWithPassphrase } from "@muhkoo/connect";

const ks = KeyStore.getInstance();

// First boot — generate.
await ks.generateOwnKeyPair("alice");

// Persist.
const packed = await ks.packDehydratedKeys("alice"); // base64(JSON)
const wrapped = await wrapWithPassphrase("hunter2", new TextEncoder().encode(packed));
await client.put("identity", wrapped);  // PersonalSpaceClient from above

// Later boot — restore.
const storedWrap = await client.get<typeof wrapped>("identity");
const bytes = await unwrapWithPassphrase("hunter2", storedWrap!);
const restoredPacked = new TextDecoder().decode(bytes);
await ks.hydrateFromPacked("alice", restoredPacked);
```

Once hydrated, `ks.getKeyPair("alice")` and `ks.getAuthKeyPair("alice")`
return the same `CryptoKey` pairs you had pre-restore, ready to be picked up
by `EncryptedSession({ myId: "alice" }).initialize()` (which is itself
idempotent — it only generates if the keystore doesn't already have the
identity).

---

## Symbols you might've seen in older docs

If you came here from an old example and these don't work, they don't exist:

- `MuhkooClient`, `client.auth`, `client.storage`, `client.message`,
  `client.shared`
- `SessionManager`, `ApiClient` from `@muhkoo/connect/api`
- `generateEphemeralKeypair`, `deriveSharedSecret`,
  `dehydratePublicKey` from `@muhkoo/connect/crypto`
- `Network` class (still in `src/network/` but not exported anywhere)

Use the primitives in this file instead.
