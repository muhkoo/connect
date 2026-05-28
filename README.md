# @muhkoo/connect

Client SDK for the Muhkoo Accelerator. Provides end-to-end-encrypted messaging
primitives (Double Ratchet + ECDH P-384), a turnkey multi-peer `BroadcastChannel`,
a ZK-gated personal-storage client, and a Cloudflare-Workers-compatible Groth16
verifier — all bundled from a single TypeScript source tree.

> Status: alpha. The library is consumed in tree by `../accelerator` (see the
> chat app under `accelerator/public/chat/`).

## What's in the box

- **`BroadcastChannel`** — multi-peer end-to-end-encrypted "room". Wires
  `WSTransport` (socket lifecycle, reconnect, offline queue) together with
  `EncryptedSession` (per-peer Double Ratchet, handshake fan-out, recipient
  filtering). Drops onto a chat protocol without changing the wire format.
- **`EncryptedSession`** — transport-agnostic per-peer ratchet manager. Lets you
  bring your own transport.
- **`WSTransport`** — pure WebSocket lifecycle (connect / auto-reconnect /
  buffered outbound queue / lifecycle events).
- **`KeyStore`** — singleton holding ECDH + ECDSA P-384 keypairs per identity,
  with dehydrate/hydrate helpers for persistence.
- **`DoubleRatchet`** + **`DoubleRatchetManager`** — the underlying ratchet
  primitives (browser/server builds only — see below).
- **`PersonalSpaceClient`** — HTTP client for the accelerator's
  `/api/personal/:commitment/*` ZK-gated KV API. Generates a fresh Groth16
  proof per request using snarkjs and the `preimagePoK` circuit.
- **`wrapWithPassphrase` / `unwrapWithPassphrase`** — PBKDF2-SHA256 (200k
  iterations) + AES-256-GCM passphrase wrap. Pairs naturally with
  `PersonalSpaceClient` for client-side payload encryption.
- **`verifyGroth16` / `initBn128Wasm`** — universal Groth16 verifier driven by
  bn128.wasm. Runs anywhere WebAssembly does (Node, browsers, CF Workers).
  Used by the accelerator's `verifyZkAuthProof`.
- ZK building blocks re-exported from `crypto/ZeroKnowledge` (`Field`,
  `Poseidon`, `PreimagePoK`, `HashKnowledge`, `AuthPublicInput`,
  `verifyHashKnowledge`, `verifyPreimagePoK`, `quickVerify`,
  `compilePrograms`, `initializeCircuits`, `encodeToHex`, `decodeFromHex`).
- Messaging utilities (`Message`, `Packet`, `SerializeMessage`) and event
  primitives (`EventCore`, `EventCoreEvents`).

## Three build targets

`yarn build` produces three bundles from one source tree. They are selected via
the `exports` field in `package.json`:

| Target | Entry | Output |
| --- | --- | --- |
| `browser` | `src/browser/index.ts` | `dist/browser/index.js` |
| `server` | `src/server/index.ts` | `dist/server/index.js` |
| `workers` | `src/workers/index.ts` | `dist/workers/index.js` |

The `workers` build deliberately excludes anything that pulls in
`snarkjs` / `ffjavascript` transitive deps (which need `URL.createObjectURL`
and other APIs workerd doesn't expose):

- `ZeroKnowledge.ts` — `Field`, `Poseidon`, `PreimagePoK`, `verifyPreimagePoK`,
  etc.
- `Authenticator.ts`
- `DoubleRatchetManager.ts`
- `personal/` — `PersonalSpaceClient`, `wrapWithPassphrase`,
  `unwrapWithPassphrase`

The `workers` build keeps `KeyStore`, `DoubleRatchet`, `EncryptedSession`,
`BroadcastChannel`, `WSTransport`, and the bn128.wasm-driven
`groth16-verifier` — that last one is the only viable Groth16 path on the edge.

Types in `dist/connect.d.ts` (re-exported from `src/index.d.ts`) include
everything from all three runtimes so consumers can reference types even when
the runtime impl is absent for their target. Calling
`verifyGroth16` / `initBn128Wasm` works under workerd; importing
`PersonalSpaceClient` and calling it in a worker will fail at runtime.

### Bare specifiers and snarkjs

Browser and server builds externalize bare specifiers — the consumer's bundler
(or an import map for direct browser use) resolves them. The accelerator's
chat app provides `snarkjs` via an esm.sh import map; Node consumers add
`snarkjs` as a peer dependency.

## Quick start

### Multi-peer encrypted room (chat-style)

```typescript
import { BroadcastChannel, BroadcastChannelEvents } from "@muhkoo/connect";

const channel = new BroadcastChannel({
  url: "wss://accelerator.example.dev/room/abc",
  myId: "alice@example.dev",
});

channel.on(BroadcastChannelEvents.MESSAGE, (e) => {
  const { from, text } = e.detail;
  console.log(`${from}: ${text}`);
});

channel.on(BroadcastChannelEvents.PEER_HANDSHAKE, (e) => {
  console.log("new peer ready:", e.detail.peerId);
});

await channel.connect();   // generates keys + opens WS
await channel.announce();  // broadcast our keyExchange (re-fires on reconnect)
await channel.send("hello room"); // fan-out one cipherMessage per peer
```

The wire protocol is JSON frames: `{ keyExchange: ... }`, `{ cipherMessage: ... }`,
plus arbitrary frames you ship with `channel.sendRaw(obj)` and receive via the
`RAW_FRAME` event.

### Bring-your-own-transport encrypted session

```typescript
import { EncryptedSession } from "@muhkoo/connect";

const session = new EncryptedSession({ myId: "alice" });
await session.initialize();

// outbound handshake
const kx = await session.getOwnKeyExchange();
yourTransport.send(JSON.stringify(kx));

// inbound frame
const result = await session.receive(JSON.parse(rawFrame));
if (result.kind === "plaintext") {
  console.log("from", result.from, ":", result.text);
} else if (result.kind === "handshake" && result.outbound) {
  yourTransport.send(JSON.stringify(result.outbound)); // reciprocate
}

// outbound message
const frames = await session.encrypt("hi");
for (const f of frames) yourTransport.send(JSON.stringify(f));
```

`EncryptedSession` assigns roles deterministically with
`isClient = (myId < peerId)` lexicographically and dedups handshake
reciprocation with an internal `sentHandshakeTo` set.

### ZK-gated personal storage

```typescript
import {
  PersonalSpaceClient,
  wrapWithPassphrase,
  unwrapWithPassphrase,
} from "@muhkoo/connect";

const client = new PersonalSpaceClient({
  baseUrl: "https://accelerator.example.dev",
  commitment, secret, salt, ecdsaPub, ecdsaPubHash, // decimal BigInt strings
  circuits: {
    wasmUrl: "/circuits/build/preimagePoK_js/preimagePoK.wasm",
    zkeyUrl: "/circuits/build/preimagePoK_0001.zkey",
  },
});

// Each call: POST /challenge -> reduce nonce -> snarkjs.groth16.fullProve -> POST gated endpoint
const wrapped = await wrapWithPassphrase("hunter2", new TextEncoder().encode("secret"));
await client.put("notes", wrapped);

const got = await client.get<typeof wrapped>("notes");
const plaintext = await unwrapWithPassphrase("hunter2", got!);
```

Identity derivation (deriving `commitment / secret / salt / ecdsaPub / ecdsaPubHash`
from a username + password) lives on the consumer side. The accelerator's chat
app uses PBKDF2(password, "muhkoo-zk-v1:" + username) -> 32-byte seed ->
HKDF-Expand for each material -> P-256 via `@noble/curves` -> Poseidon
commitment.

### Universal Groth16 verification (Workers / Node / browser)

```typescript
import {
  initBn128Wasm,
  verifyGroth16,
  PREIMAGE_POK_VERIFICATION_KEY,
} from "@muhkoo/connect";

const { instance, memory, initialPFree } = await initBn128Wasm();
const ok = await verifyGroth16(
  instance, memory, initialPFree,
  PREIMAGE_POK_VERIFICATION_KEY,
  proof, publicSignals,
);
```

Initialize once at boot. For CF Workers, pass a pre-compiled
`WebAssembly.Module` to skip runtime compilation:
`await initBn128Wasm(myWasmModule)`.

## KeyStore

Singleton store for ECDH + ECDSA P-384 keypairs keyed by identity ID.

```typescript
import { KeyStore } from "@muhkoo/connect";

const ks = KeyStore.getInstance();
await ks.generateOwnKeyPair("alice");           // ECDH + ECDSA pair
const dehydrated = await ks.dehydrateKeyPair("alice"); // JWK -> string fields
await ks.hydrateKeyPair("bob", dehydrated);

await ks.storeRemotePublicKeys("carol", carolEcdhPub, carolEcdsaPub);
const packed = await ks.packDehydratedKeys("alice");    // base64 blob
await ks.hydrateFromPacked("alice", packed);
```

Dehydrated form is JWK-based; the personal-space wrap/unwrap helpers above are
how you'd persist the packed blob (passphrase-wrapped) into the accelerator's
ZK-gated KV layer.

## Repo layout

```
src/
  browser/        rollup entrypoint for the browser build
  server/         rollup entrypoint for the server / default build
  workers/        rollup entrypoint for the workers build (+ groth16-verifier + bundled bn128.wasm)
  crypto/         KeyStore, DoubleRatchet, DoubleRatchetManager, Authenticator, ZeroKnowledge
  sessions/       EncryptedSession, BroadcastChannel
  transport/      WSTransport
  personal/       PersonalSpaceClient + wrap.ts (excluded from workers build)
  events/         EventCore + EventCoreEvents
  messaging/      Message, Packet, decorators
  types/          shared type defs (incl. zk.ts with PREIMAGE_POK_VERIFICATION_KEY)
  network/        legacy Network class (not exported from any build)
  storage/        Reed-Solomon Storage (not exported from any build)
  utilities/      Logger, base58, ID generation, decorators
```

## Scripts

```bash
yarn build              # rm -rf dist && yarn rollup:browser && yarn rollup:server && yarn rollup:workers
yarn dev                # all three targets in watch mode (concurrently)
yarn rollup:browser     # one-off browser build
yarn rollup:server      # one-off server build
yarn rollup:workers     # one-off workers build
yarn build:dts          # complete .d.ts bundle -> dist/connect.d.ts
yarn build:docs         # typedoc -> docs/

yarn test               # vitest
yarn test:unit          # vitest --run (no integration tests)
yarn test:integration   # TEST_TYPE=integration vitest --run tests/integration
yarn lint               # eslint ./src
```

## Compatibility

- Node >= 20
- All three builds rely on globalThis-level WebCrypto (`crypto.subtle`,
  `crypto.getRandomValues`), available natively in modern browsers, Node 16+,
  Bun, Deno, and CF Workers.
- The bn128.wasm verifier needs runtime `WebAssembly.compile()` available
  (true for all of the above; on CF Workers, pre-compile via wrangler's
  `.wasm` import if you want to skip startup cost).

## Related

- [`muhkoo/accelerator`](https://github.com/muhkoo/accelerator) — the CF
  Workers + DOs backend this SDK targets, including the personal-space DO,
  message-bus DO, and the bn128.wasm-driven `verifyZkAuthProof`.

## License

GPL-3.0 — see `LICENSE`.
