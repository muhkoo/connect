# Examples

This directory is currently empty of runnable scripts. Every script that used to
live here (`basic-usage.ts`, `network-example.ts`, `network-ratchet-example.ts`,
`network-rest-example.ts`, `network-unified-example.ts`) imported classes —
`ApiClient`, `SessionManager`, the legacy `Network` — that were removed in the
2026-05 unified-`Client` overhaul. They no longer compiled against `src/`, so
they have been deleted rather than left as misleading reference material.

For runnable, current usage examples, see
[`../docs/examples.md`](../docs/examples.md). It covers:

- `BroadcastChannel` — multi-peer E2EE rooms
- `EncryptedSession` — bring your own transport
- `PersonalSpaceClient` — ZK-gated personal KV
- `wrapWithPassphrase` / `unwrapWithPassphrase` — passphrase-based AES-GCM
- `verifyGroth16` + `initBn128Wasm` — universal Groth16 verification
- `WSTransport` — raw WebSocket lifecycle
- `KeyStore` — dehydrate/hydrate identity

The canonical docs site (the `../docs` repo → `docs.muhkoo.dev`) is the source of
truth for the `Client` API. The `muhkoo/web` SPA drives the `Client` directly and
is the best end-to-end reference for a real application.

## Quick start (using the current public API)

```typescript
import { BroadcastChannel, BroadcastChannelEvents } from "@muhkoo/connect";

const channel = new BroadcastChannel({
  url: "wss://accelerator.example.dev/room/foo",
  myId: "alice@example.dev",
});

channel.on(BroadcastChannelEvents.MESSAGE, (e) => {
  console.log(`${e.detail.from}: ${e.detail.text}`);
});

await channel.connect();
await channel.announce();
await channel.send("hello room");
```

## Next steps

If someone wants examples back in this folder, write them against the real
surface (`Client`, `BroadcastChannel`, `PersonalSpaceClient`) and wire them into
`package.json` with an `example:*` script so they stay compiled and honest.
