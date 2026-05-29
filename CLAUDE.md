# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Muhkoo Connect is a client SDK for building **end-to-end-encrypted apps** on the
Muhkoo Accelerator (a Cloudflare Workers + Durable Objects backend). The
headline surface is a single **`Client`** (`src/core/Client.ts`) that exposes
three namespaces over one shared session:

- `client.auth` — zero-knowledge identity (`client.auth.zk.{register,login,restore,unlock,logout}`)
- `client.storage` — per-user key/value, AES-256-GCM **encrypted at rest**
- `client.message` — pub/sub + end-to-end-encrypted DMs and group rooms

The lower-level building blocks (`AuthClient`, `PersonalSpaceClient`,
`FileStorage`, `BroadcastChannel`, `EncryptedSession`, the Groth16 verifier)
remain exported, but the `Client` is the supported surface.

> **History:** the SDK previously carried a monolithic/aspirational design
> (OAuth, offline-first sync, namespace derivation). That was replaced in the
> 2026-05 "unified Client" overhaul — trust `src/core/` and the docs site over
> any older prose.

### Core concepts

1. **One client, three namespaces** — `client.auth` / `client.storage` /
   `client.message`, all driven off one session (`src/core/Session.ts`,
   `src/core/HttpClient.ts`).
2. **Zero-knowledge identity** — derived from `(username, password)` on the
   device; the server stores only a Poseidon commitment. Login proves knowledge
   with a Groth16 proof (`src/auth/`).
3. **Encryption by default** — storage values sealed with AES-256-GCM under an
   identity-derived key (`src/crypto/StorageCipher.ts`); DMs use the Double
   Ratchet (`src/crypto/`, `src/sessions/`).
4. **Spaces** — the backend primitive both storage (personal space) and
   messaging/rooms (shared space) ride on. A `Room` (`src/core/Room.ts`) wraps
   a shared space's group channel + file storage.
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

# Run integration tests (requires Accelerator running)
TEST_TYPE=integration yarn test:integration
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
- `/src/core/` - The unified `Client`. `Client.ts` (facade), `HttpClient.ts`
  (header-injecting transport), `Session.ts` (session + identity state),
  `Room.ts` (shared-space group channel + files), and
  `namespaces/{Auth,Storage,Message}Namespace.ts`
- `/src/auth/` - ZK auth: identity derivation, Groth16 proof, Poseidon, key
  helpers, and `AuthClient` (the `/api/auth/*` HTTP client)
- `/src/crypto/` - Crypto primitives + Double Ratchet, KeyStore, ZeroKnowledge
  (snarkjs proof gen), `StorageCipher.ts` (at-rest AES-GCM for `client.storage`)
- `/src/sessions/` - `EncryptedSession` + `BroadcastChannel` (E2E room transport)
- `/src/storage/` - Chunked/encrypted/erasure-coded file storage (FileStorage,
  ShardClient, SharedSpaceClient, Reed-Solomon)
- `/src/personal/` - `PersonalSpaceClient` (proof-gated per-user KV; the
  lower-level building block under `client.storage`)
- `/src/messaging/`, `/src/network/`, `/src/transport/` - Message/Packet,
  Network, and WSTransport primitives
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
- **Exports**: Multiple entry points for different modules (crypto, types, api, events, messaging, utilities). The `.` export uses conditional resolution (`workerd` / `browser` / `default`) to pick the right bundle

## Important Technical Details

### Crypto Implementation
- **Zero-knowledge proofs**: snarkjs (via `@zk-kit/groth16`) for proof generation in the browser/server builds (see `src/crypto/ZeroKnowledge.ts` — `HashKnowledge`, `PreimagePoK`). Proof generation is NOT possible in the CF Workers build because snarkjs/ffjavascript depend on `URL.createObjectURL` and worker_threads, which CF Workers don't expose
- **Edge ZK verification**: `src/workers/groth16-verifier.ts` drives `bn128.wasm` directly to verify Groth16 proofs. Workers-safe (no snarkjs/ffjavascript). Available from all three builds; under `workerd` consumers get the same code path as Node/browser
- Implements the Double Ratchet algorithm for end-to-end encryption (DMs/rooms)
- ECDH (P-256) key exchange for session establishment; P-256 ECDSA for signing
- Identity keypairs are **deterministically derived** from `(username, password)`
  (`src/auth/identity.ts`), not random — that's what makes federated login work
- `StorageCipher` (`src/crypto/StorageCipher.ts`) derives the at-rest AES key
  from the identity via HKDF

### Storage System
- `client.storage` = per-user KV over the personal space, AES-256-GCM encrypted
  at rest by default; the server only sees ciphertext
- No server-side query (encrypted at rest) — `list()` returns ids; filter
  client-side. `storage.on('change')` is a realtime cross-device feed over the
  personal space's websocket
- File storage (`src/storage/`) is chunked + AES-GCM + Reed-Solomon erasure
  coded into content-addressed shards; room files ride `Room.putFile/getFile`

### Known Issues
1. **Base58 encoding performance**: Currently slow for large payloads (>100KB). Message class tests disabled due to this bottleneck.
2. **Integration tests**: Require Accelerator infrastructure to be running, not included in default test suite.
3. **dts roll-up gaps**: `rollup-plugin-dts` drops some subtrees from
   `dist/connect.d.ts` (storage/sessions/personal/core). Consumers that hit
   missing types use a local shim (see `muhkoo/web/src/lib/connect.ts`).
   Worth fixing properly.

### Test config note
`vitest.config.ts` uses a curated `include` allowlist (many tests are commented
out for perf/flakiness). When adding a test, add its path to that list or it
won't run.

## Development Guidelines

### When Working on Features
1. Check if the feature belongs in the client SDK or should be part of Accelerator backend
2. Maintain offline-first principles - all operations should work without network
3. Use the existing event system for real-time updates
4. Follow the namespace derivation pattern for multi-tenancy

### Testing Approach
- Unit tests for individual components
- Integration tests require Accelerator running (use `yarn test:integration`)
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