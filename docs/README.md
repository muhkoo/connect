# Connect SDK Documentation

`@muhkoo/connect` is a TypeScript client SDK with three build targets
(browser, server, workers) cut from a single source tree.

## Contents

- [**API Reference**](./api-reference.md) — every public class, method, and event
- [**Crypto Architecture**](./crypto-architecture.md) — Double Ratchet, ECDH P-384, ZK auth
- [**Examples**](./examples.md) — end-to-end usage of `BroadcastChannel`,
  `EncryptedSession`, `PersonalSpaceClient`, and the Groth16 verifier
- [**API Token Implementation Guide**](./api-token-implementation.md) —
  **design only**, not implemented
- [**API Token Security Plan**](./api-token-security-plan.md) —
  **design only**, not implemented

> The repo-root `README.md` and `API_REFERENCE.md` are the canonical
> high-level summary. This `docs/` directory drills into specific subsystems.

## What the SDK provides today

- `BroadcastChannel` — multi-peer E2EE room over a WebSocket
- `EncryptedSession` — transport-agnostic per-peer Double Ratchet manager
- `WSTransport` — pure WebSocket lifecycle (auto-reconnect + offline queue)
- `KeyStore` — ECDH + ECDSA P-384 keypair singleton with dehydrate/hydrate
- `DoubleRatchet`, `DoubleRatchetManager` — ratchet primitives
- `PersonalSpaceClient` — ZK-gated HTTP KV client (snarkjs-driven)
- `wrapWithPassphrase` / `unwrapWithPassphrase` — PBKDF2 + AES-GCM
- `verifyGroth16` + `initBn128Wasm` — universal Groth16 verifier
  (bn128.wasm, no snarkjs)
- Re-exported ZK helpers: `Field`, `Poseidon`, `PreimagePoK`,
  `HashKnowledge`, `AuthPublicInput`, `verifyPreimagePoK`,
  `verifyHashKnowledge`, `quickVerify`, `compilePrograms`,
  `initializeCircuits`, `encodeToHex`, `decodeFromHex`
- `Message`, `Packet`, `EventCore`, `EventCoreEvents`

The `workers` build excludes snarkjs-dependent symbols
(`PersonalSpaceClient`, wrap helpers, `Authenticator`, `ZeroKnowledge`,
`DoubleRatchetManager`). The bn128.wasm-driven `verifyGroth16` is in all three
builds and is the only Groth16 path that works under workerd.

## Quick start

```typescript
import { BroadcastChannel, BroadcastChannelEvents } from "@muhkoo/connect";

const channel = new BroadcastChannel({
  url: "wss://accelerator.example.dev/room/foo",
  myId: "alice@example.dev",
});

channel.on(BroadcastChannelEvents.MESSAGE, (e) => {
  const { from, text } = e.detail;
  console.log(`${from}: ${text}`);
});

await channel.connect();
await channel.announce();
await channel.send("hello room");
```

See [examples.md](./examples.md) for the full multi-peer flow, the
`EncryptedSession` BYO-transport pattern, the `PersonalSpaceClient` ZK-gated
storage flow, and Groth16 verification.

## Crypto at a glance

- ECDH P-384 for key agreement, ECDSA P-384 for signing — same curve as
  the deployed chat protocol uses.
- HKDF-SHA-256 for ratchet key derivation, AES-256-GCM for message bodies.
- ZK identity uses Poseidon commitments and Groth16 proofs over the
  `preimagePoK` circuit. The verification key is pinned in
  `src/types/zk.ts` as `PREIMAGE_POK_VERIFICATION_KEY`.
- Personal-space storage is gated by a fresh per-request proof. The
  accelerator's `verifyZkAuthProof` is what runs on the server side.

See [crypto-architecture.md](./crypto-architecture.md) for the full design
discussion.

## What's intentionally NOT here

- There is no single `MuhkooClient` facade. Apps wire up `BroadcastChannel`,
  `PersonalSpaceClient`, etc. directly.
- There is no offline-first sync engine, IndexedDB cache, optimistic-update
  manager, OAuth flow, or "shared namespace" abstraction in this package.
  Those concerns live in the consumer (the chat app, etc.).
- The API-token system documented under `docs/api-token-*.md` is a written
  design only — there is no implementation in `src/`.

## Platform support

| Runtime | Status |
| --- | --- |
| Node ≥ 20 (server bundle) | supported |
| Modern browsers (browser bundle) | supported |
| Cloudflare Workers / workerd (workers bundle) | supported (subset; see above) |

All three rely on globalThis-level WebCrypto (`crypto.subtle`,
`crypto.getRandomValues`), so the same crypto code runs everywhere.

## Testing

```bash
yarn test               # vitest (watch mode)
yarn test:unit          # vitest --run
yarn test:integration   # TEST_TYPE=integration vitest --run tests/integration
```

Note: some files under `tests/integration/` are stale (they import from
`src/api/`, `src/client/`, etc. which don't exist). They should be regarded as
historical until they're either deleted or updated. See
`tests/integration/README.md` for the present state.

## License

GPL-3.0 — see `LICENSE`.
