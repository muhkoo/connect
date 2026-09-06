# Examples

This directory contains TypeScript example scripts for the SDK. **Most of the
scripts in this folder are stale** — they import classes (`ApiClient`,
`SessionManager`, `Network`) that no longer exist in `src/` or are not
exported from any build. They are kept for historical reference until
they're rewritten or deleted.

If you're looking for runnable, current usage examples, see
[`../docs/examples.md`](../docs/examples.md). It covers:

- `BroadcastChannel` — multi-peer E2EE rooms
- `EncryptedSession` — bring your own transport
- `PersonalSpaceClient` — ZK-gated personal KV
- `wrapWithPassphrase` / `unwrapWithPassphrase` — passphrase-based AES-GCM
- `verifyGroth16` + `initBn128Wasm` — universal Groth16 verification
- `WSTransport` — raw WebSocket lifecycle
- `KeyStore` — dehydrate/hydrate identity

## Files in this directory

| File | Status |
| --- | --- |
| `basic-usage.ts` | Stale. Imports `ApiClient` from `../src/api/client` (does not exist). |
| `network-example.ts` | Stale. Imports `SessionManager` from `../src` (does not exist) and uses the legacy `Network` class. |
| `network-ratchet-example.ts` | Stale. Uses the legacy `Network` class (not exported in any build). |
| `network-rest-example.ts` | Stale. Legacy `Network`. |
| `network-unified-example.ts` | Stale. Legacy `Network`. |

Reproducing the chat flow against the current SDK is best done by reading the
`muhkoo/web` SPA (which drives the `Client` directly) alongside the snippets in
`docs/examples.md`. The `public/*.html` pages in `muhkoo/accelerator` are the
pre-SPA demos and predate the `Client` entirely.

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

## Running

The current scripts don't compile against the current source tree, so there's
nothing useful to run from this folder. The `package.json` has no
`examples` script.

## Next steps

When someone gets to it, the action items are:

1. Delete the four stale `network-*.ts` scripts.
2. Rewrite `basic-usage.ts` against the real surface (`BroadcastChannel` +
   `PersonalSpaceClient`).
3. Add a `yarn example:chat` and `yarn example:storage` script wiring the new
   files into the project test/build setup.
