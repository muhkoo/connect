# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Muhkoo Connect is a client SDK for building **end-to-end-encrypted apps** on the
Muhkoo Accelerator (a Cloudflare Workers + Durable Objects backend). The
headline surface is a single **`Client`** (`src/core/Client.ts`) that exposes
every namespace over one shared session:

- `client.auth` — zero-knowledge identity (`client.auth.zk.{register,login,restore,unlock,logout}`),
  the recoverable factors (passkey / phrase / email / Google / `device`), and
  `client.auth.hosted` (the redirect flow + TV device pairing)
- `client.kv` — per-user key/value, AES-256-GCM **encrypted at rest**
- `client.db` — the app's scalable database (table specs in the portal; typed query/insert/update/delete)
- `client.storage` — encrypted, chunked file storage
- `client.vfs` / `client.vcs` — the encrypted filesystem and its history
- `client.message` — pub/sub + end-to-end-encrypted DMs
- `client.space` — fan-out group channels with persisted history
- `client.agents` — server-side Programmable Agents (persona, triggers, optional `tools`)
- `client.functions` — developer-authored serverless functions (HTTP + Space-bound)
- `client.accessTokens` — scoped, expiring machine credentials
- `client.offline` — CRDT offline sync (on by default in browsers)

Plus app-describing **decorators** (`src/core/agents/describe.ts`):
`@MuhkooAgent`/`@MuhkooSpace`/`@MuhkooDB`/`@MuhkooFunction` + `ejectAgentPrompt`/
`ejectAgentTools` generate an agent `systemPrompt` + tool allowlist from a class.

The lower-level building blocks (`AuthClient`, `PersonalSpaceClient`,
`FileStorage`, `BroadcastChannel`, `EncryptedSession`, the Groth16 verifier)
remain exported, but the `Client` is the supported surface.

> **History:** the SDK previously carried a monolithic/aspirational design
> (OAuth, offline-first sync, namespace derivation). That was replaced in the
> 2026-05 "unified Client" overhaul — trust `src/core/` and the docs site over
> any older prose.

### Core concepts

1. **One client, many namespaces** — the list above, all driven off one session
   (`src/core/Session.ts`, `src/core/HttpClient.ts`).
2. **Zero-knowledge identity** — derived from `(username, password)` on the
   device; the server stores only a Poseidon commitment. Login proves knowledge
   with a Groth16 proof (`src/auth/`).
3. **Encryption by default** — storage values sealed with AES-256-GCM under an
   identity-derived key (`src/crypto/StorageCipher.ts`); direct messages use the
   Double Ratchet (`src/crypto/`, `src/sessions/`); group channels use a fan-out
   group key (`src/spaces/`).
4. **Spaces** — the backend primitive both storage (personal space) and
   messaging (shared space) ride on. A `Space` (`src/spaces/Space.ts`, formerly
   `Room` — still aliased via `src/core/Room.ts`) wraps a shared space's group
   channel + file storage. `src/spaces/` adds the fan-out group-encryption layer
   (`SpaceCipher`, `SpaceKeyring`, `KeyringClient`) and `client.space`
   (`SpaceNamespace`): `createChannel`/`joinChannel`/`listChannels` over an
   app-scoped channel registry, with a server-side **keeper** admitting members.
5. **Two credentials** — an app key (`mk_…`, `X-Muhkoo-Key`) identifies the app
   for billing; a session token (`X-Muhkoo-Session`) identifies the user. The
   `HttpClient` attaches both.

## Documentation

- **Canonical docs site**: the `../docs` repo (Astro Starlight) → `docs.muhkoo.dev`.
  This is the source of truth for the `Client` API, guides, and examples. Keep
  it updated when the SDK surface changes.
- `README.md` — quick reference, leads with the unified `Client`.
- `API_REFERENCE.md` — lower-level export inventory (building blocks).

## Common Development Commands

### Building and Development
```bash
# Install dependencies
yarn install

# Development mode with watch (builds server, browser, and workers in parallel)
yarn dev

# Production build (creates dist/server, dist/browser, and dist/workers)
yarn build

# Build a single target
yarn rollup:server     # Node.js
yarn rollup:browser    # Browser
yarn rollup:workers    # Cloudflare Workers
```

### Testing
```bash
# Run all tests
yarn test

# Watch mode for tests
yarn test:watch

# Run unit tests once
yarn test:unit

# Run the e2e suites (need a live deployment)
E2E_STAGING=1 MUHKOO_BASE_URL=... yarn test:e2e

# Typecheck (tsc --noEmit)
yarn typecheck
```

### Code Quality
```bash
# Run linting
yarn lint

# Fix linting issues
yarn lint:fix
```

### Documentation
```bash
# Generate TypeDoc documentation
yarn build:docs

# Watch mode for documentation
yarn watch:docs
```

## Project Structure

### Source Code Organization
- `/src/api.ts` - **The canonical public surface.** Every public symbol is
  reachable from exactly this file; the three platform entries re-export it and
  name zero symbols, so they cannot drift from each other or from the shipped
  types. `/src/api.universal.ts` is the Workers-safe slice it builds on and is
  the ONLY declared platform delta — read its header before adding anything to
  the workers build, and note that `src/personal` is tainted only DYNAMICALLY
  (it looks clean to a static check but bundles snarkjs).
- `/src/runtime/appLogger.ts` - The single `globalThis.appLogger` bootstrap,
  previously duplicated across three entry files.
- `/src/core/` - The unified `Client`. `Client.ts` (facade), `HttpClient.ts`
  (header-injecting transport), `Session.ts` (session + identity state),
  `Room.ts` (back-compat alias re-exporting `Space`), and `namespaces/` —
  `AuthNamespace`, `KvNamespace`, `DbNamespace`, `FileNamespace` (which is
  where `StorageNamespace` lives — there is no `StorageNamespace.ts`),
  `MessageNamespace`, `SpaceNamespace`, `AgentsNamespace`,
  `FunctionsNamespace`, `AccessTokensNamespace`, `HostedAuth`
- `/src/spaces/` - Fan-out group-encryption layer: `Space.ts` (the shared-space
  handle, formerly `Room`), `SpaceCipher` (ECIES group-key wrap + message seal),
  `SpaceKeyring` + `KeyringClient` (group-key distribution), `SpacePacketCipher`
- `/src/auth/` - ZK auth: identity derivation, Groth16 proof, Poseidon, key
  helpers, and `AuthClient` (the `/api/auth/*` HTTP client)
- `/src/crypto/` - Crypto primitives + Double Ratchet, KeyStore, ZeroKnowledge
  (snarkjs proof gen), `StorageCipher.ts` (at-rest AES-GCM for `client.storage`)
- `/src/sessions/` - `EncryptedSession` + `BroadcastChannel` (E2E space transport)
- `/src/storage/` - Chunked/encrypted/erasure-coded file storage (FileStorage,
  ShardClient, SharedSpaceClient, Reed-Solomon)
- `/src/personal/` - `PersonalSpaceClient` (proof-gated per-user KV). A
  standalone building block exported from the browser/server builds; nothing
  in `src/core/` uses it — `client.kv` (`src/core/namespaces/KvNamespace.ts`)
  talks to `/api/personal/:commitment/*` itself
- `/src/messaging/`, `/src/network/`, `/src/transport/` - Message/Packet,
  `PacketCipher`/`DoubleRatchetCipher`, and WSTransport primitives. The legacy
  `Network` class is gone; `src/network/PacketCipher.ts` survives and is
  exported from the browser and server builds
- `/src/events/` - Event emitter and handling
- `/src/utilities/` - Helper functions, decorators, logging, byte helpers
- `/src/types/` - TypeScript type definitions (incl. `zk.ts` + `PREIMAGE_POK_VERIFICATION_KEY`)
- `/src/browser/` - Browser entry (exports the `Client` + building blocks)
- `/src/server/` - Node.js-specific entry
- `/src/workers/` - Cloudflare-Workers-compatible entry. Contains `groth16-verifier.ts` (drives `bn128.wasm` directly, no snarkjs/ffjavascript dependency) and `wasm/bn128.wasm` (~86KB BN128 curve module). The verifier is re-exported from the browser and server entries too, so it's a universal Groth16 verification primitive

### Build Configuration
- **TypeScript**: ESNext target with strict mode enabled
- **Rollup**: Three separate builds — browser (`dist/browser/`), Node.js server (`dist/server/`), and Cloudflare Workers (`dist/workers/`). The build target is selected by `BUILD_ENV={browser,server,workers}`
- **`@rollup/plugin-wasm`** is enabled in all three builds with `targetEnv: 'auto-inline'` — `.wasm` imports are base64-inlined so the Groth16 verifier's bundled-WASM fallback works in any runtime
- **Exports**: `package.json` declares three entry points — `.`, `./workers` and
  `./p2p-worker`. There are no per-module subpaths (`@muhkoo/connect/crypto` and
  friends do not resolve). The `.` export uses conditional resolution (`workerd` /
  `browser` / `default`) to pick the right bundle, and each condition carries its
  OWN types: `workerd` → `dist/connect.workers.d.ts` (29 values, matching that
  bundle exactly), everything else → `dist/connect.d.ts`, rolled from `src/api.ts`.

  **Workers consumers should import from `@muhkoo/connect/workers`, not `.`.**
  The `workerd` CONDITION alone is not enough: a consumer on
  `moduleResolution: "bundler"` without `customConditions` resolves with
  `["import","types"]`, never sees `workerd`, and falls through to `default` —
  getting types that promise 175 symbols the workers bundle does not export,
  `Client` among them. The explicit `./workers` subpath resolves correctly under
  every configuration with no consumer-side opt-in. Verified: importing `Client`
  from `@muhkoo/connect/workers` fails with TS2305, while the root specifier
  still gives the full surface.

  `tests/api/export-surface.test.ts` asserts the exports map stays coherent —
  every target exists AND is matched by `files`. A target `files` omits fails
  resolution hard once published, which is worse than the stale types it replaces.

## Important Technical Details

### Crypto Implementation
- **Zero-knowledge proofs**: snarkjs (via `@zk-kit/groth16`) for proof generation in the browser/server builds (see `src/crypto/ZeroKnowledge.ts` — `HashKnowledge`, `PreimagePoK`). Proof generation is NOT possible in the CF Workers build because snarkjs/ffjavascript depend on `URL.createObjectURL` and worker_threads, which CF Workers don't expose
- **Edge ZK verification**: `src/workers/groth16-verifier.ts` drives `bn128.wasm` directly to verify Groth16 proofs. Workers-safe (no snarkjs/ffjavascript). Available from all three builds; under `workerd` consumers get the same code path as Node/browser
- Implements the Double Ratchet algorithm for end-to-end encryption (DMs/rooms)
- Two distinct curves, do not conflate them: the Double Ratchet / session /
  space stack uses **ECDH P-384** for key agreement and **ECDSA P-384** for
  signing (`src/crypto/KeyStore.ts`, `src/crypto/DoubleRatchet.ts`,
  `src/sessions/EncryptedSession.ts`, `src/spaces/SpaceCipher.ts`), while the
  auth identity layer uses **P-256** (`src/auth/identity.ts` derives the
  P-256 ECDSA + ECDH identity pairs; `src/auth/hostedHandoff.ts` pairing ECDH
  and `src/auth/deviceStore.ts` device ECDSA are P-256 too)
- Identity keypairs are **deterministically derived** from `(username, password)`
  (`src/auth/identity.ts`), not random — that's what makes federated login work
- `StorageCipher` (`src/crypto/StorageCipher.ts`) derives the at-rest AES key
  from the identity via HKDF

### Storage System
- `client.kv` = per-user key/value over the personal space, AES-256-GCM
  encrypted at rest by default; the server only sees ciphertext
- No server-side query (encrypted at rest) — `list()` returns ids; filter
  client-side. `kv.on('change')` is a realtime cross-device feed over the
  personal space's websocket
- `client.storage` = files (`src/storage/`): chunked + AES-GCM + Reed-Solomon
  erasure coded into content-addressed shards; space files ride
  `Space.putFile/getFile`
- Shard reads fetch only the DATA shards (RS needs `dataShards` of
  `dataShards + parityShards`) and coalesce into `POST /api/shards/batch`.
  `ShardClientOptions.batchShards` turns coalescing off; a server without the
  route is detected and permanently degraded to one request per shard. Read
  concurrency and batching are coupled — too few reads in flight makes batching
  worse than not batching

### Group messaging (`client.space`)
- Fan-out group key: a `spaceMessage` is sealed once with the channel's group
  key (not per-peer like the Double Ratchet), so the server persists + replays
  it as **history**. Loops back to the sender — don't local-echo; dedupe by id
- Channels = named pointers (`name → space id`) in an app-public registry
  (`/api/app/channels`). `createChannel` vs `joinChannel` is explicit
- **Keeper**: the accelerator's per-app DO holds the group key and admits new
  members, so channels are joinable with nobody online. The relay stays blind
  (opaque ECIES-wrapped blobs only)

### Known Issues
1. **Base58 encoding performance**: Currently slow for large payloads (>100KB). Message class tests disabled due to this bottleneck.
2. **Integration tests**: Require Accelerator infrastructure to be running, not included in default test suite.
3. ~~**dts roll-up gaps**~~ — RESOLVED (2026-09). This was a misdiagnosis.
   `rollup-plugin-dts` does NOT drop named cross-module re-exports (verified
   against the installed 6.2.3; the in-tree proof is that `src/offline/index.ts`
   and `src/p2p/index.ts` are written entirely as named re-exports and all 39 of
   their symbols reach `dist/connect.d.ts`). The real cause was that the d.ts was
   rolled from the NAMESPACED `src/index.ts` (`export * as core from './core'`)
   while the JS came from the flat `src/browser/index.ts`, so top-level `Client`
   was absent by ES semantics, not by plugin bug. The surface now has one source
   of truth (`src/api.ts`) and is asserted by `tests/api/export-surface.test.ts`.
   Consumer-side shims can be deleted.

### Test config note
`vitest.config.ts` has TWO projects and no allowlist: `unit` (every
`tests/**/*.test.ts` that isn't e2e — the default run) and `e2e`
(`tests/**/*.e2e.test.ts`, opt-in via `yarn test:e2e`, so those suites are never
counted as passing when they only skipped). A new test file runs the moment it
lands; no config edit. The only exclusion is `CANNOT_RUN` in that file, which
today holds one entry with its reason.

CI builds BEFORE testing and sets `REQUIRE_BUILD_ARTIFACTS=1`, because `dist/` is
gitignored and `tests/api/export-surface.test.ts`'s artifact assertions — the only
ones that check what actually ships — would otherwise skip silently.

## Development Guidelines

### When Working on Features
1. Check if the feature belongs in the client SDK or should be part of Accelerator backend
2. Maintain offline-first principles - all operations should work without network
3. Use the existing event system for real-time updates
4. Multi-tenancy is enforced server-side from the app key, not derived
   client-side — don't reintroduce the old namespace-derivation design

### Testing Approach
- Unit tests for individual components
- The `*.e2e.test.ts` suites need a live deployment (`yarn test:e2e`); they are a
  separate vitest project so they are never counted as passing when they only skipped
- Browser-specific features need Web Crypto API testing
- Performance benchmarks needed for encryption operations

### Security Considerations
- **Zero-knowledge identity**: the server stores only a Poseidon commitment;
  passwords/secrets never leave the device. A forgotten password is
  unrecoverable by design.
- **Encryption by default**: storage values + DMs are encrypted client-side;
  the accelerator relays/stores ciphertext.
- **App key trajectory**: the `mk_*` app key is transitionally optional but is
  becoming required (auth/attribution/billing). Never ship a secret (`sk`) key
  in a browser bundle — only publishable (`pk`).

## Environment Requirements
- Node.js >= 20.0.0
- Yarn 1.22.22 (specified in packageManager field)
- TypeScript 5.7.3
- Vitest for testing

## Related Resources
- Main README.md contains detailed architecture documentation and roadmap
- Accelerator repository (../accelerator/) contains the backend infrastructure
- API documentation generated via TypeDoc (yarn build:docs)