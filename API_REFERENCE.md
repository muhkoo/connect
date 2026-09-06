# @muhkoo/connect API Reference

> **The canonical docs are the [`muhkoo/docs`](../docs) site (`docs.muhkoo.dev`).**
> Start there for the unified `Client` (`client.auth` / `client.kv` /
> `client.db` / `client.storage` / `client.message` / `client.space` /
> `client.agents` / `client.functions`), the `@MuhkooAgent`/`@MuhkooSpace`/
> `@MuhkooDB`/`@MuhkooFunction` decorators, guides, and worked examples. This
> file is the low-level **export inventory** — the building blocks the `Client`
> composes — kept for contributors working in-tree.

Public surface of `@muhkoo/connect`. Every export listed below is real today;
deprecated / aspirational APIs have been removed.

## Installation

```bash
yarn add @muhkoo/connect
```

## Entry points

`@muhkoo/connect` has three build targets, selected automatically by
`package.json`'s `exports`:

| Condition | File |
| --- | --- |
| `workerd` | `dist/workers/index.js` |
| `browser` | `dist/browser/index.js` |
| default (Node) | `dist/server/index.js` |

The `types` condition resolves to a single bundled `dist/connect.d.ts` that
re-exports everything (so a type referenced in one runtime is still
declarable in another, even if the runtime impl is absent).

There is a single public entry point — `@muhkoo/connect`. Everything documented
below is exported from it; there are no subpath imports.

### What's in which build

| Symbol | browser | server | workers |
| --- | :---: | :---: | :---: |
| `BroadcastChannel`, `EncryptedSession` | yes | yes | yes |
| `WSTransport` | yes | yes | yes |
| `KeyStore`, `DoubleRatchet` | yes | yes | yes |
| `DoubleRatchetManager`, `Authenticator` | yes | yes | NO |
| `Field`, `Poseidon`, `PreimagePoK`, `HashKnowledge`, `AuthPublicInput` | yes | yes | NO |
| `verifyPreimagePoK`, `verifyHashKnowledge`, `quickVerify`, `compilePrograms`, `initializeCircuits` | yes | yes | NO |
| `PersonalSpaceClient`, `wrapWithPassphrase`, `unwrapWithPassphrase` | yes | yes | NO |
| `verifyGroth16`, `initBn128Wasm`, `PREIMAGE_POK_VERIFICATION_KEY` | yes | yes | yes |
| `EventCore`, `EventCoreEvents` | yes | yes | yes |
| `Message`, `Packet`, `SerializeMessage`, `decorators` | yes | yes | yes |

The exclusions exist because `snarkjs`/`ffjavascript` use Node-only APIs
(`os.cpus`, `URL.createObjectURL`) that edge runtimes don't expose.

## Sessions

### BroadcastChannel

`src/sessions/BroadcastChannel.ts`. Turnkey multi-peer encrypted "room"
combining `WSTransport` + `EncryptedSession`.

```typescript
import { BroadcastChannel, BroadcastChannelEvents } from "@muhkoo/connect";

const channel = new BroadcastChannel({
  url: "wss://accelerator.example.dev/room/x",
  myId: "alice@example.dev",
  autoAnnounce: false, // default — call announce() yourself
  // ...rest is forwarded to WSTransport
});
```

**Options** (`BroadcastChannelOptions extends WSTransportOptions`):

- `url: string` — WebSocket URL
- `myId: string` — local identity (username, DID, pubkey string, anything)
- `autoAnnounce?: boolean` — if true, announce immediately on CONNECTED.
  Defaults to false so chat-style apps can complete a `{name}` handshake first.
- WSTransport options: `autoReconnect`, `reconnectDelay`, `maxReconnectAttempts`,
  `maxQueueSize`

**Methods**:

- `connect(): Promise<void>` — generate keys + open socket
- `disconnect(): void` — stop reconnecting and close
- `announce(): Promise<void>` — broadcast our keyExchange. Idempotent
  per-connection, but the `announced` flag **resets on every `CONNECTED`
  event** so a fresh announce fires on reconnect (the platform's websockets hit
  a ~100s idle timeout; without re-announcing, peers who joined after our
  last reconnect would never see our pubkey). If you're driving announce
  manually (`autoAnnounce: false`), wire it to your "server ready"
  signal — the SDK will let it through on every reconnect.
- `send(plaintext: string): Promise<number>` — fan-out: one cipherMessage frame
  per peer ratchet. Returns the number of peers it sent to (0 if no peers
  handshaken yet — render locally and try later).
- `sendRaw(frame: unknown): void` — JSON-stringify and send any other app frame
- `peers(): string[]`
- `forgetPeer(peerId: string): void`
- `isConnected(): boolean`
- `on(event, handler)` / `off(event, handler)` — per-instance EventTarget

**Events** (`BroadcastChannelEvents`):

| Const | String |
| --- | --- |
| `CONNECTED` | `"connected"` |
| `DISCONNECTED` | `"disconnected"` |
| `RECONNECTING` | `"reconnecting"` |
| `ERROR` | `"error"` |
| `PEER_HANDSHAKE` | `"channel:peer_handshake"` |
| `MESSAGE` | `"channel:message"` |
| `RAW_FRAME` | `"channel:raw_frame"` |

`channel:message` event detail is `{ from, text, cipherMessage }`.
`channel:peer_handshake` detail is `{ peerId }`.
Channel-managed frames are `{ keyExchange }` and `{ cipherMessage }`; any
other inbound frame fires `RAW_FRAME`.

The events live on a per-instance `EventTarget`, so two channels in the same
app do not cross-contaminate each other's events.

### EncryptedSession

`src/sessions/EncryptedSession.ts`. Transport-agnostic per-peer ratchet
manager. Use this if you want to ship frames over something other than
`WSTransport`.

```typescript
import { EncryptedSession } from "@muhkoo/connect";

const session = new EncryptedSession({ myId: "alice" });
await session.initialize();   // generates KeyStore entries if needed
const kx = await session.getOwnKeyExchange();
// transport.send(JSON.stringify(kx))
```

**Methods**:

- `initialize(): Promise<void>`
- `get ready: Promise<void>`
- `get id: string`
- `getOwnKeyExchange(): Promise<{ keyExchange: KeyExchangeFrame }>`
- `encrypt(plaintext: string): Promise<CipherFrame[]>` — fan-out across all
  ratcheted peers. Empty array means no peers yet.
- `receive(frame: IncomingFrame): Promise<ReceiveResult>`
- `peers(): string[]`
- `hasRatchetFor(peerId: string): boolean`
- `forgetPeer(peerId: string): void`

`receive()` returns `{ kind: "plaintext" | "handshake" | "ignored", ... }`. When
`kind === "handshake"` and `outbound` is non-null, the app MUST send `outbound`
back to that peer (reciprocation). The session dedups internally — `outbound`
is only set the first time per peer per session lifetime.

`kind: "ignored"` is also returned for **stale cipherMessages** — the underlying
DoubleRatchet rejects payloads older than 5 minutes as a wallclock-based replay
defense, and `EncryptedSession.receive` catches that rejection and converts it
to `ignored` instead of throwing. The real replay defense is the consumed
message key; the wallclock check is just defense-in-depth, so legacy backlog
replays and websocket idle-reconnect cycles don't spam the channel ERROR stream.

Role assignment is deterministic: `isClient = (myId < peerId)` lexicographically.
Per-pair sessionId is `[myId, peerId].sort().join(":")`.

**Frame shapes**:

```typescript
interface KeyExchangeFrame {
  type: "handshake" | "update";
  userId: string;
  ecdhPublicKey: string;   // base64(JSON.stringify(JWK))
  ecdsaPublicKey: string;  // base64(JSON.stringify(JWK))
}

interface CipherFrame {
  cipherMessage: CipherMessage;
}
```

## Transport

### WSTransport

`src/transport/WSTransport.ts`. Pure WebSocket lifecycle. Auto-reconnect with
linear backoff, capped outbound queue while disconnected.

```typescript
import { WSTransport, EventCoreEvents } from "@muhkoo/connect";

const transport = new WSTransport({
  url: "wss://example.dev/ws",
  autoReconnect: true,
  reconnectDelay: 3000,
  maxReconnectAttempts: 5,
  maxQueueSize: 100,
});

transport.on(EventCoreEvents.CONNECTED, () => { /* ... */ });
transport.on(EventCoreEvents.MESSAGE, (e) => { /* e.detail is the raw frame string */ });

await transport.connect();
transport.send("raw frame string");
transport.disconnect();
```

Emits `CONNECTED`, `DISCONNECTED`, `RECONNECTING` (`detail: { attempt }`),
`ERROR`, `MESSAGE` (raw inbound). `send()` throws if the outbound queue is
full while disconnected.

## Crypto

### KeyStore

`src/crypto/KeyStore.ts`. Singleton holding ECDH + ECDSA P-384 keypairs keyed
by identity.

```typescript
import { KeyStore } from "@muhkoo/connect";

const ks = KeyStore.getInstance();
await ks.generateOwnKeyPair("alice");
const own = ks.getKeyPair("alice");    // { privateKey, publicKey } for ECDH
const auth = ks.getAuthKeyPair("alice"); // for ECDSA

await ks.storeRemotePublicKeys("bob", bobEcdhPub, bobEcdsaPub);

const dehydrated = await ks.dehydrateKeyPair("alice");
await ks.hydrateKeyPair("alice2", dehydrated);

const packed = await ks.packDehydratedKeys("alice");  // base64(JSON)
await ks.hydrateFromPacked("alice3", packed);

const ecdsaPubBytes = await ks.getRawEcdsaPublicKey("alice"); // SEC1 uncompressed
```

**`DehydratedKeys`**:

```typescript
interface DehydratedKeys {
  ecdhPub: string;   // serialize(JSON.stringify(JWK))
  ecdhPriv: string;  // "" if remote-only
  ecdsaPub: string;
  ecdsaPriv: string; // "" if remote-only
}
```

`serialize()` is the project's gzip+base58 wrapper from `utilities`. Strings
in `dehydrateKeyPair`'s output are JWK JSON run through that wrapper.

### DoubleRatchet / DoubleRatchetManager

`src/crypto/DoubleRatchet.ts`, `src/crypto/DoubleRatchetManager.ts`. The
Signal-style ratchet primitives. `EncryptedSession` wraps them; you generally
don't construct these directly. `DoubleRatchetManager` is NOT in the workers
build (snarkjs dependency chain).

### Authenticator

`src/crypto/Authenticator.ts`. ECDSA auth-token signing and verification +
ZK proof verification. Not in the workers build.

### ZeroKnowledge

`src/crypto/ZeroKnowledge.ts`. circomlibjs + snarkjs-backed circuit utilities.
Exports include `Field`, `Field as FieldElement`, `Poseidon`, `PreimagePoK`,
`HashKnowledge`, `AuthPublicInput`, `verifyPreimagePoK`,
`verifyHashKnowledge`, `verify`, `quickVerify`, `compilePrograms`,
`initializeCircuits`, `encodeToHex`, `decodeFromHex`, plus types
`SnarkProof` (alias for `Groth16Proof`), `VerificationKey`, `ZkCompiled`,
`CircuitBufferConfig`. Not in the workers build.

## Personal-space client

### PersonalSpaceClient

`src/personal/PersonalSpaceClient.ts`. HTTP wrapper for the accelerator's
`/api/personal/:commitment/*` ZK-gated KV API. NOT in the workers build.

```typescript
const client = new PersonalSpaceClient({
  baseUrl: "https://accelerator.example.dev",
  commitment, secret, salt, ecdsaPub, ecdsaPubHash, // decimal BigInt strings
  circuits: {
    wasmUrl: "/circuits/build/preimagePoK_js/preimagePoK.wasm",
    zkeyUrl: "/circuits/build/preimagePoK_0001.zkey",
  },
});

await client.put("notes", { hello: "world" });
const v = await client.get<{ hello: string }>("notes");
const existed = await client.delete("notes"); // boolean
const keys = await client.list();
```

Each call:

1. `POST /api/personal/:commitment/challenge` to get a one-shot
   `{ challengeId, nonce, commitment }`.
2. Reduce `nonce` (hex) to a BN254 field element (mod
   21888242871839275222246405745257275088548364400416034343698204186575808495617).
3. Generate a fresh Groth16 proof via `snarkjs.groth16.fullProve` over the
   `preimagePoK` circuit. Public signals: `[commitment, nonce, ecdsaPubHash]`.
   Private witnesses: `secret, salt, ecdsaPub`.
4. POST the gated endpoint with `{ challengeId, proof, publicSignals, value? }`.

`snarkjs` is a bare-specifier import — externalized by rollup. Browser
consumers provide it via import map (the accelerator chat app uses esm.sh);
Node consumers install it as a peer dep.

### wrapWithPassphrase / unwrapWithPassphrase

`src/personal/wrap.ts`. PBKDF2-SHA256 (200_000 iterations) → 256-bit
AES-GCM key → encrypt with random 16-byte salt + 12-byte IV. NOT in the
workers build.

```typescript
const wrapped = await wrapWithPassphrase("hunter2", new TextEncoder().encode("plaintext"));
// wrapped: { salt, iv, ciphertext, alg: "PBKDF2-SHA256/AES-256-GCM", iter: 200000 }
//   all bytes base64-encoded
const plaintext = await unwrapWithPassphrase("hunter2", wrapped);
// throws "decryption failed (wrong passphrase or tampered payload)"
// on AES-GCM tag mismatch.
```

## Groth16 verification

### initBn128Wasm + verifyGroth16

`src/workers/groth16-verifier.ts`. Universal — works in Node, browsers, and
edge runtimes. bn128.wasm-driven, no snarkjs dependency.

```typescript
import {
  initBn128Wasm,
  verifyGroth16,
  PREIMAGE_POK_VERIFICATION_KEY,
} from "@muhkoo/connect";
import type { Groth16Proof, VerificationKey } from "@muhkoo/connect";

const { instance, memory, initialPFree } = await initBn128Wasm();
// Or, on an edge runtime, pre-compile the .wasm at deploy time:
//   import wasmModule from "./bn128.wasm";
//   await initBn128Wasm(wasmModule);

const ok = await verifyGroth16(
  instance, memory, initialPFree,
  PREIMAGE_POK_VERIFICATION_KEY,
  proof, publicSignals,
);
```

`verifyGroth16` returns `false` for any structural problem (malformed proof,
out-of-range field elements, off-curve points, failed pairing). Throws only
for WASM/runtime faults.

`PREIMAGE_POK_VERIFICATION_KEY` is pinned in `src/types/zk.ts`. If the
circuit is recompiled, regenerate this constant together with the
verification-key JSON shipped in the accelerator's
`public/circuits/build/preimagePoK_verification_key.json`.

## Types

From `src/index.d.ts`:

```typescript
export interface Attribute {
  dataType: string;
  attribute: string;
  value: string | number | boolean | Array<string | boolean | number> | object;
}

export type Tag = string;

export interface FileOptions {
  id?: string; name?: string; size?: number; hash?: string;
  contentType?: string; path?: string; isArchived?: boolean;
  version?: number; attributes?: Attribute[]; tags?: string[];
}

export interface FilesInterface {
  id?: string; name: string; size: number; hash: string;
  contentType: string; version: number; tags: Tag[]; attributes: Attribute[];
}
```

Plus the shared types from `src/types/`: `Groth16Proof`, `VerificationKey`,
`PREIMAGE_POK_VERIFICATION_KEY`, and the messaging / identity / permissions
types (re-exported wholesale).

## Events

`EventCore` (`src/events/EventCore.ts`) is a static event emitter built on
`EventTarget` plus an enum of standard event names. `WSTransport` extends it;
`BroadcastChannel` uses its own per-instance EventTarget but reuses
the `EventCoreEvents` enum values for lifecycle event names.

```typescript
export enum EventCoreEvents {
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

## Messaging

`Message`, `Packet`, `SerializeMessage` decorator, `decorators` namespace.
Used internally by the legacy `Network` / `Storage` classes that aren't part
of the public build today. Useful if you're building your own protocol on top
of `WSTransport`.

## Things that DO NOT exist (despite older docs)

- `MuhkooClient` — the unified client class is `Client` (with `client.auth`,
  `client.storage`, `client.message`). There is no `client.shared`.
- `Network` class — still in `src/network/` but NOT exported from any build.
- `SessionManager`, `ApiClient` — referenced by old examples and integration
  tests; do not exist in `src/`.

## License

MIT — see [LICENSE](./LICENSE).
