# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Muhkoo Connect is a client SDK for building distributed edge-based applications. It's currently undergoing a major architectural transformation from a monolithic system to a lightweight client library that communicates with the Muhkoo Accelerator infrastructure (Cloudflare Durable Objects).

## Key Architecture Components

### Current State
- **Monolithic system** with database, KV stores, file storage, and server components
- Contains comprehensive distributed application middleware framework
- Includes P2P networking, messaging system, and encryption capabilities

### Target Architecture
- **Lightweight client SDK** that interfaces with Accelerator backend via REST/WebSocket
- **Offline-first** with local state management and automatic sync
- **Hybrid identity** supporting both self-sovereign (bring your own keys) and custodial (OAuth) authentication
- **Application namespaces** derived from public keys for data isolation

### Core Concepts

1. **Three Main APIs**:
   - `client.auth` - Identity and authentication (OAuth or self-sovereign)
   - `client.message` - Real-time messaging and pub/sub
   - `client.storage` - Offline-first data persistence with sync

2. **ECDH Key Exchange**: Secure communication using ephemeral keys without exposing app private keys

3. **Namespace System**: Cryptographic derivation of namespaces from public keys for data isolation

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
- `/src/core/` - Core client implementation (Client.ts is main entry)
- `/src/crypto/` - Cryptographic utilities (ECDH, Double Ratchet, ZeroKnowledge with snarkjs-based proof generation, Key Store)
- `/src/messaging/` - Message and packet handling with serialization
- `/src/network/` - Network layer implementation
- `/src/storage/` - Storage abstraction and encoding (Reed-Solomon)
- `/src/events/` - Event emitter and handling
- `/src/utilities/` - Helper functions, decorators, and logging
- `/src/types/` - TypeScript type definitions (includes `zk.ts` with shared Groth16 types and `PREIMAGE_POK_VERIFICATION_KEY`)
- `/src/browser/` - Browser-specific entry
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
- Implements Double Ratchet algorithm for end-to-end encryption
- ECDH key exchange for secure session establishment
- ED25519 keypairs for identity

### Storage System
- Abstract storage layer with Reed-Solomon encoding for redundancy
- Supports offline-first operations with pending operation queue
- Conflict resolution strategies: Last-Write-Wins, Client-Wins, Server-Wins, Custom

### Known Issues
1. **Base58 encoding performance**: Currently slow for large payloads (>100KB). Message class tests disabled due to this bottleneck.
2. **Integration tests**: Require Accelerator infrastructure to be running, not included in default test suite.

### Migration in Progress
The codebase is transitioning from a monolithic architecture to a client SDK. Components being:
- **Moved to Accelerator**: Database operations, KV stores, file storage backends, GraphQL execution
- **Kept in Connect**: Client models, identity management, namespace utilities, offline sync, local storage
- **Deprecated**: Task management system, server-side clustering (handled by Cloudflare)

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
- App private keys NEVER leave the server
- All client-server communication uses ECDH-derived shared secrets
- Support both self-sovereign (user controls keys) and custodial (OAuth) identity
- Implement proper signature verification for all authenticated operations

## Environment Requirements
- Node.js >= 20.0.0
- Yarn 1.22.22 (specified in packageManager field)
- TypeScript 5.7.3
- Vitest for testing

## Related Resources
- Main README.md contains detailed architecture documentation and roadmap
- Accelerator repository (../accelerator/) contains the backend infrastructure
- API documentation generated via TypeDoc (yarn build:docs)