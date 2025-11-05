# Muhkoo Connect

**Connect** is a client library for interacting with the Muhkoo Accelerator infrastructure, providing a high-level TypeScript/JavaScript API for distributed application development.

> **Note**: This repository was written from scratch on 11/08/2024

## Overview

Connect serves as the client-side SDK that interfaces with Cloudflare Durable Objects-based infrastructure (Accelerator) through RESTful APIs and WebSocket protocols. It abstracts the complexity of distributed systems, enabling developers to build scalable applications with minimal infrastructure management.

## Current State

Connect currently contains a **comprehensive distributed application middleware framework** with the following implemented features:

### Core Infrastructure (To Be Migrated)
- **Database Layer**: Full ORM implementation with Drizzle supporting SQLite, CockroachDB, and TiDB
  - 14+ entity types (Account, User, Device, Location, File, Blob, DataSet, Event, etc.)
  - 16+ relationship models
  - QueryEngine with GraphQL support
- **Key-Value Stores**: Redis and Etcd implementations with namespace support
- **File Storage**: IPFS integration (Helia JS and Daemon modes) with chunked upload/download

### Client Features (Will Remain)
- **Messaging System**: Message serialization, deduplication, and status tracking
- **Event System**: Centralized event emitter for real-time updates
- **Persistence Models**: AbstractComposable base classes for entities
- **Networking**: LibP2P-based P2P networking with pub/sub support
- **Utilities**: Logging, encoding, decorators, hashing

### Components to Be Deprecated
- **Task Management**: Redis/Etcd-backed task coordination (unnecessary with Durable Objects' atomic state management)
- **Server-side Clustering**: Multi-threaded server with worker pools (Cloudflare handles scaling)

### Current Architecture
```
┌─────────────────────────────────────────┐
│         Connect (Monolith)              │
├─────────────────────────────────────────┤
│  • ServerCore / Client                  │
│  • Database (Drizzle ORM)              │
│  • KV Stores (Redis/Etcd)              │
│  • File Storage (IPFS)                 │
│  • GraphQL API                         │
│  • Messaging & Events                  │
│  • Clustering & Workers                │
└─────────────────────────────────────────┘
```

## Target Architecture

The goal is to transform Connect into a **lightweight client library** that communicates with Accelerator's infrastructure:

```
┌──────────────────────────┐         ┌─────────────────────────────┐
│   Connect (Client SDK)   │ ◄─────► │  Accelerator (Cloudflare)   │
├──────────────────────────┤         ├─────────────────────────────┤
│  • REST Client           │         │  • Durable Objects          │
│  • WebSocket Client      │         │    - Database DO            │
│  • Message Protocol      │         │    - KV Store DO            │
│  • Entity Models         │         │    - Blob Storage DO        │
│  • Event Handling        │         │    - Event Bus DO           │
│  • Type Definitions      │         │  • RESTful API              │
│  • Client-side Caching   │         │  • WebSocket Protocol       │
│  • Offline Support       │         │  • GraphQL Endpoint         │
└──────────────────────────┘         └─────────────────────────────┘
          │                                      │
          └──────────── Communication ───────────┘
                  (HTTPS + WebSocket)
```

## Offline-First Client Architecture

Connect is designed as an **offline-first** client library, allowing applications to function seamlessly whether online or offline. The client maintains a local state replica and synchronizes with Accelerator when connectivity is available.

### Client-Side State Management

```
┌─────────────────────────────────────────────────────────────┐
│  Connect Client SDK (Browser/Node.js)                       │
├─────────────────────────────────────────────────────────────┤
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Local State Store (IndexedDB/SQLite)                 │  │
│  │  ┌─────────────────────────────────────────────────┐  │  │
│  │  │  Entity Cache                                    │  │  │
│  │  │  - accounts: Map<id, Account>                   │  │  │
│  │  │  - users: Map<id, User>                         │  │  │
│  │  │  - devices: Map<id, Device>                     │  │  │
│  │  │  - [versioned with updatedAt/version]           │  │  │
│  │  └─────────────────────────────────────────────────┘  │  │
│  │  ┌─────────────────────────────────────────────────┐  │  │
│  │  │  Pending Operations Queue                       │  │  │
│  │  │  - CREATE account (id: temp-123)                │  │  │
│  │  │  - UPDATE user (id: user-456)                   │  │  │
│  │  │  - DELETE device (id: device-789)               │  │  │
│  │  └─────────────────────────────────────────────────┘  │  │
│  │  ┌─────────────────────────────────────────────────┐  │  │
│  │  │  Sync Metadata                                   │  │  │
│  │  │  - lastSyncTimestamp: 1699564800000             │  │  │
│  │  │  - syncToken: "abc123xyz"                       │  │  │
│  │  │  - deviceId: "device-uuid"                      │  │  │
│  │  └─────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Sync Engine                                          │  │
│  │  - Monitors online/offline status                    │  │
│  │  - Processes pending operations queue                │  │
│  │  - Performs delta sync (pull + push)                 │  │
│  │  - Resolves conflicts                                │  │
│  │  - Emits sync events                                 │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Entity Managers                                      │  │
│  │  - client.accounts.create() → optimistic update      │  │
│  │  - client.users.update() → queue + local update      │  │
│  │  - client.devices.delete() → queue + local delete    │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### Sync Flow

```
Offline Operation:
┌────────┐    ┌──────────────┐    ┌────────────────┐
│  App   │───►│ Entity Mgr   │───►│ Local Storage  │
│        │    │              │    │ + Queue        │
└────────┘    └──────────────┘    └────────────────┘
              returns immediately     operation queued
              with optimistic result

When Online:
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│ Sync Engine  │───►│  Accelerator │───►│ Sync Engine  │
│ (PUSH)       │    │              │    │ (PULL)       │
└──────────────┘    └──────────────┘    └──────────────┘
  send queued ops    process & respond   apply server changes

Conflict Detected:
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│ Sync Engine  │───►│  Strategy    │───►│ Resolution   │
│              │    │  (LWW/Custom)│    │              │
└──────────────┘    └──────────────┘    └──────────────┘
  version mismatch   apply strategy     update local state
```

### Conflict Resolution Strategies

The client supports multiple conflict resolution strategies:

1. **Last-Write-Wins (LWW)** - Default strategy, server timestamp wins
```typescript
const client = new MuhkooClient({
  endpoint: 'https://api.example.com',
  sync: {
    conflictResolution: 'last-write-wins'
  }
});
```

2. **Client-Wins** - Client changes always take precedence
```typescript
const client = new MuhkooClient({
  endpoint: 'https://api.example.com',
  sync: {
    conflictResolution: 'client-wins'
  }
});
```

3. **Server-Wins** - Server state is always authoritative
```typescript
const client = new MuhkooClient({
  endpoint: 'https://api.example.com',
  sync: {
    conflictResolution: 'server-wins'
  }
});
```

4. **Custom Merge** - Application-defined merge logic
```typescript
const client = new MuhkooClient({
  endpoint: 'https://api.example.com',
  sync: {
    conflictResolution: 'custom',
    onConflict: (local, remote) => {
      // Custom merge logic
      return {
        ...remote,
        customField: local.customField // keep client's custom field
      };
    }
  }
});
```

### Optimistic Updates

All mutations are applied locally immediately for instant UI feedback:

```typescript
// Create account - immediate local update
const account = await client.accounts.create({
  name: 'My New Account'
});
// Returns immediately with temporary ID
// Operation queued for server sync

// Update user - optimistic UI update
await client.users.update('user-123', {
  name: 'Updated Name'
});
// UI updates immediately
// Server sync happens in background

// Listen for sync confirmations
client.sync.on('confirmed', (operation) => {
  console.log('Operation confirmed by server:', operation);
});

// Listen for sync conflicts
client.sync.on('conflict', (conflict) => {
  console.log('Conflict detected:', conflict);
  // Optionally show UI to user for manual resolution
});
```

### Sync Events

The client emits events to track sync status:

```typescript
// Connection status
client.on('online', () => console.log('Connected to server'));
client.on('offline', () => console.log('Disconnected from server'));

// Sync lifecycle
client.sync.on('start', () => console.log('Sync started'));
client.sync.on('progress', (stats) => console.log('Syncing:', stats));
client.sync.on('complete', (stats) => console.log('Sync complete:', stats));
client.sync.on('error', (error) => console.log('Sync error:', error));

// Individual operation status
client.sync.on('operation:queued', (op) => console.log('Queued:', op));
client.sync.on('operation:sent', (op) => console.log('Sent:', op));
client.sync.on('operation:confirmed', (op) => console.log('Confirmed:', op));
client.sync.on('operation:failed', (op) => console.log('Failed:', op));
```

### Local Storage Strategy

**Browser Environment:**
- **IndexedDB** for entity cache and operation queue
- **LocalStorage** for sync metadata (last sync timestamp, tokens)
- **Memory** for in-flight operations

**Node.js Environment:**
- **SQLite** for entity cache and operation queue
- **File system** for sync metadata
- **Memory** for in-flight operations

## Identity & Authentication

Connect supports **hybrid identity** - allowing users to choose between self-sovereign identity (bring your own keys) or custodial identity (traditional OAuth).

### Self-Sovereign Authentication

Users bring their own DID and cryptographic keys:

```typescript
import { MuhkooClient } from '@muhkoo/connect';

// Generate or import your keys
const { publicKey, privateKey } = await generateED25519Keypair();
const did = `did:key:${publicKeyToMultibase(publicKey)}`;

// Register with the service
const client = await MuhkooClient.registerSovereign({
  endpoint: 'https://accelerator.muhkoo.dev',
  did,
  publicKey,
  privateKey, // Used for signing, never sent to server
});

// Session established
console.log(client.identity);
// {
//   userId: "user:7f3a9c2e41d5b6f8",
//   publicKey: "04a1b2c3...",
//   accountType: "self-sovereign",
//   did: "did:key:z6MkpTHR..."
// }
```

### Custodial Authentication (OAuth)

Traditional OAuth flow with server-managed keys:

```typescript
import { MuhkooClient } from '@muhkoo/connect';

// Option 1: Browser redirect flow
const client = await MuhkooClient.loginWithOAuth({
  endpoint: 'https://accelerator.muhkoo.dev',
  provider: 'google', // or 'github', 'microsoft'
  redirectUri: 'https://myapp.com/callback',
});

// Option 2: Programmatic flow (Node.js)
const client = await MuhkooClient.loginWithOAuth({
  endpoint: 'https://accelerator.muhkoo.dev',
  provider: 'google',
  onAuthUrl: (url) => {
    console.log('Visit:', url);
    // Open browser or display QR code
  },
});

// Session established with generated keys
console.log(client.identity);
// {
//   userId: "user:e4b5d8a19f2c3e7d",
//   publicKey: "04x7y8z9...", // Generated by server
//   accountType: "custodial",
//   provider: "google",
//   canMigrate: true
// }

// User can export keys later
const exportedKey = await client.identity.exportPrivateKey('my-password');
// Save this to migrate to self-sovereign later
```

### Migration from Custodial to Self-Sovereign

Users can progressively decentralize:

```typescript
// Step 1: Export custodial keys (optional)
const encryptedKey = await client.identity.exportPrivateKey('my-password');
// User can import this into their wallet

// Step 2: Migrate to new self-managed keys
const { publicKey, privateKey } = await generateED25519Keypair();

await client.identity.migrateTo Sovereign({
  newPublicKey: publicKey,
  newPrivateKey: privateKey,
});

// Identity updated, user now controls their own keys
console.log(client.identity.accountType); // "self-sovereign"
```

## Application Namespaces

Each application has its own namespace derived from its public key. Applications are registered server-side, and clients only need to know the app's **public key** to interact with it.

### Registering an Application (Server-Side)

Application registration happens on the **server/admin side only**. The app's private key is kept secure on the Accelerator infrastructure:

```typescript
// This happens server-side during app provisioning
// NOT in client code

// POST /api/apps/register
{
  "name": "My Todo App",
  "description": "Task management application",
  "version": "1.0.0",
  "appPublicKey": "04a1b2c3...", // Your app's public key
  "appPrivateKey": "04xyz...", // KEPT SECURE ON SERVER
}

// Response:
{
  "appId": "app:7f3a9c2e41d5b6f8",
  "publicKey": "04a1b2c3...",
  "namespace": "app:7f3a9c2e41d5b6f8",
  "apiEndpoint": "wss://accelerator.muhkoo.dev/app/7f3a9c2e41d5b6f8"
}
```

### Using Application Context (Client-Side)

**IMPORTANT**: Clients only know the app's **public key**. The app's **private key never leaves the server**.

```typescript
import { MuhkooClient } from '@muhkoo/connect';

// Initialize client with app's PUBLIC key only
const client = new MuhkooClient({
  endpoint: 'https://accelerator.muhkoo.dev',
  appPublicKey: '04a1b2c3...', // Your app's PUBLIC key
});

// Authenticate user (either method)
await client.auth.loginWithOAuth({ provider: 'google' });
// or
await client.auth.loginSovereign({ did, publicKey, privateKey });

// Now all operations are scoped to your app + user
const todo = await client.todos.create({
  title: 'Buy groceries',
  completed: false,
});

// Todo is stored in namespace: app:<yourApp>:user:<currentUser>
console.log(todo.namespace); // "user:e4b5d8a19f2c3e7d"
```

### Shared Namespaces (Multi-User Collaboration)

For features like collaborative documents, shared projects, or multi-user spaces:

```typescript
// Example 1: Collaborative Document
const document = await client.shared.create({
  participants: [
    'user:7f3a9c2e...', // Current user
    'user:e4b5d8a1...', // Collaborator
  ],
  type: 'document',
  data: {
    title: 'Project Proposal',
    content: '',
    version: 1,
  },
});

// Document is stored in deterministic shared namespace
console.log(document.namespace);
// "shared:9c3f7e2a5b8d1f4e" (derived from app + both user public keys)

// Both users can access and edit
const doc = await client.shared.get(document.id);

// Make edits
await client.shared.update(document.id, {
  content: 'Updated content...',
  version: 2,
  editedBy: 'user:7f3a9c2e...',
  timestamp: Date.now(),
});

// Real-time updates to all participants
client.shared.on('updated', (docId, data) => {
  console.log('Document updated by:', data.editedBy);
});

// Example 2: Shared Project Board
const project = await client.shared.create({
  participants: [
    'user:7f3a9c2e...',
    'user:e4b5d8a1...',
    'user:a2f8c3d9...',
  ],
  type: 'project-board',
  data: {
    name: 'Website Redesign',
    tasks: [],
    status: 'active',
  },
});

// Add task to shared project
await client.shared.update(project.id, {
  tasks: [
    { id: 't1', title: 'Design mockups', assignee: 'user:e4b5d8a1...' },
    { id: 't2', title: 'Implement header', assignee: 'user:a2f8c3d9...' },
  ],
});
```

### Namespace Benefits

1. **Collision-Free**: Cryptographic hashing guarantees uniqueness
2. **Deterministic**: Same keys always produce same namespace
3. **Privacy**: User data isolated per-app
4. **Verifiable**: Ownership proven via signatures
5. **Cross-App Identity**: Same user key works across all apps

## Secure Connection with ECDH Key Exchange

**CRITICAL SECURITY PRINCIPLE**: Application private keys **NEVER leave the server**. Clients only know the app's public key.

To enable secure, encrypted communication between clients and the server, Connect uses **ECDH (Elliptic Curve Diffie-Hellman)** key exchange to derive a shared secret. This allows the server to keep the app's private key secure while still enabling encrypted channels for each client.

### How ECDH Works in Connect

```
┌──────────────────────────────────────────────────────────────┐
│  Client                          Server                       │
├──────────────────────────────────────────────────────────────┤
│                                                                │
│  1. Generate ephemeral keypair                                │
│     clientEphemeralPrivate ──────────────────────┐            │
│     clientEphemeralPublic                        │            │
│                                                   │            │
│  2. Send handshake                                │            │
│     ───────────────────────────────────────────> │            │
│     {                                             │            │
│       type: "ecdh_handshake",                    │            │
│       appPublicKey: "04a1b2c3...",               │            │
│       clientEphemeralPublic: "04x7y8z9..."       │            │
│     }                                             │            │
│                                                   │            │
│                                   3. Lookup app private key   │
│                                      appPrivateKey (secure)   │
│                                                   │            │
│                                   4. Derive shared secret     │
│                      sharedSecret = ECDH(appPrivate,          │
│                                          clientEphemeralPub)  │
│                                                   │            │
│  5. Receive confirmation          <─────────────────────────  │
│     {                                             │            │
│       type: "handshake_complete",                │            │
│       connectionId: "uuid-123",                  │            │
│       serverEphemeralPublic: "04m9n8..."         │            │
│     }                                             │            │
│                                                   │            │
│  6. Derive shared secret (same value)            │            │
│     sharedSecret = ECDH(clientEphemeralPrivate,  │            │
│                         serverEphemeralPublic)   │            │
│                                                   │            │
│  7. Both sides now have same sharedSecret        │            │
│     Use for AES-GCM symmetric encryption         │            │
│                                                   │            │
└──────────────────────────────────────────────────────────────┘
```

### Client Implementation

```typescript
import { MuhkooClient } from '@muhkoo/connect';

// Initialize client with app's public key
const client = new MuhkooClient({
  endpoint: 'wss://accelerator.muhkoo.dev',
  appPublicKey: '04a1b2c3...', // App's public key (known to all clients)
});

// The client automatically performs ECDH handshake on connection
await client.connect();

// Behind the scenes:
// 1. Client generates ephemeral keypair
// 2. Sends ephemeral public key to server
// 3. Server uses app's private key to derive shared secret
// 4. Client derives same shared secret using server's ephemeral public key
// 5. All subsequent messages are encrypted with the shared secret

// Now you can securely communicate
await client.auth.loginSovereign({ did, publicKey, privateKey });

// All messages are encrypted with the derived shared secret
const todo = await client.todos.create({
  title: 'Secure task',
  encrypted: true,
});
```

### Advanced: Manual ECDH Handshake

For lower-level control, you can manually perform the ECDH handshake:

```typescript
import { MuhkooClient, generateEphemeralKeypair, ecdh } from '@muhkoo/connect';

// Create WebSocket connection
const ws = new WebSocket('wss://accelerator.muhkoo.dev');

// Generate ephemeral keypair (destroyed after session)
const { publicKey: ephemeralPublic, privateKey: ephemeralPrivate } =
  await generateEphemeralKeypair();

// Send handshake
ws.send(JSON.stringify({
  type: 'ecdh_handshake',
  appPublicKey: '04a1b2c3...', // Your app's public key
  clientEphemeralPublic: ephemeralPublic,
}));

// Receive server's ephemeral public key
ws.onmessage = async (event) => {
  const msg = JSON.parse(event.data);

  if (msg.type === 'handshake_complete') {
    // Derive shared secret
    const sharedSecret = await ecdh(
      ephemeralPrivate,
      msg.serverEphemeralPublic
    );

    // Use shared secret for AES-GCM encryption
    const encryptedMessage = await encrypt(
      sharedSecret,
      JSON.stringify({ action: 'createTodo', data: {...} })
    );

    ws.send(encryptedMessage);
  }
};
```

### Real-Time Event Delivery with Encryption

Once the ECDH handshake is complete, the server can fan out encrypted events to clients:

```typescript
// Client subscribes to events
client.events.subscribe('todos:*');

// Server sends encrypted events using the shared secret
client.events.on('todos:created', (todo) => {
  // Event is automatically decrypted using the shared secret
  console.log('New todo created:', todo);
});

// Multi-user scenario: Each client has their own shared secret
// Server encrypts the same event differently for each client
```

### Security Benefits

1. **App Private Keys Never Exposed**
   - Server keeps app private key secure
   - Clients only know public key
   - No risk of key theft from client apps

2. **Perfect Forward Secrecy**
   - Each session uses ephemeral keys
   - Compromising one session doesn't affect others
   - Keys are destroyed after session ends

3. **Encrypted Event Delivery**
   - All real-time events encrypted per-client
   - Even the server can't read messages without the shared secret
   - End-to-end encryption option available

4. **Authorization Built-In**
   - Only clients with the correct app public key can connect
   - Server verifies handshake before establishing connection
   - Session-based access control

5. **Replay Protection**
   - Each encrypted message includes a nonce
   - Prevents replay attacks
   - Ensures message freshness

## Roadmap to Target Architecture

### Phase 1: Infrastructure Extraction
- [ ] Identify all infrastructure components to migrate to Accelerator
  - Database layer (Drizzle schemas, QueryEngine)
  - KV store implementations (Redis/Etcd interfaces)
  - Blob storage and IPFS coordination
- [ ] Identify components to deprecate
  - Task management (unnecessary with Durable Objects)
  - Server-side clustering (Cloudflare handles scaling)
- [ ] Document API contracts for each service
- [ ] Create migration plan with backwards compatibility strategy

### Phase 2: Protocol Definition
- [ ] Define RESTful API specification
  - Entity CRUD operations
  - GraphQL query endpoint
  - Blob upload/download endpoints
- [ ] Define WebSocket protocol
  - Real-time event subscriptions
  - Live query updates
  - Bi-directional messaging
  - Connection management (heartbeat, reconnection)
- [ ] Create OpenAPI/Swagger documentation
- [ ] Define message schemas and versioning strategy

### Phase 3: Client SDK Development
- [ ] Implement HTTP client with retry logic and error handling
- [ ] Implement WebSocket client with automatic reconnection
- [ ] Create high-level entity managers (mirroring current persistence layer)
- [ ] Implement hybrid identity system
  - Self-sovereign authentication (DID + keypair)
  - Custodial authentication (OAuth providers)
  - Key generation utilities (ED25519)
  - Signature creation and verification
  - Challenge-response flow
  - Session management
  - Key export for migration
  - Custodial → self-sovereign migration
- [ ] Implement namespace utilities
  - App registration and management
  - User namespace derivation
  - Shared namespace creation (multi-user)
  - Public key-based ID generation
  - Deterministic hashing functions
- [ ] Implement offline-first architecture
  - Local state store (IndexedDB for browser, SQLite for Node.js)
  - Entity cache with version tracking
  - Pending operations queue
  - Sync metadata storage
- [ ] Build sync engine
  - Online/offline status monitoring
  - Delta synchronization (pull + push)
  - Operation queue processing
  - Conflict detection and resolution
  - Sync event emitters
- [ ] Implement conflict resolution strategies
  - Last-Write-Wins (LWW)
  - Client-Wins
  - Server-Wins
  - Custom merge functions
- [ ] Add optimistic updates
  - Immediate local state updates
  - Background server synchronization
  - Rollback on conflict/error
- [ ] Create TypeScript type definitions for all APIs

### Phase 4: Migration Support
- [ ] Create adapter layer for backwards compatibility
- [ ] Implement dual-mode operation (local + remote)
- [ ] Build migration utilities for existing applications
- [ ] Update all tests to work with new architecture
- [ ] Create migration guide documentation

### Phase 5: Optimization & Features
- [ ] Implement request batching and deduplication
- [ ] Add client-side GraphQL query optimization
- [ ] Create reactive data layer (RxJS/Observables)
- [ ] Implement connection pooling and load balancing
- [ ] Add client-side encryption for sensitive data
- [ ] Build developer tools (debugging, monitoring)

## What Will Change

### Components Moving to Accelerator
- Database operations and ORM layer
- KV store backend implementations
- File storage and blob management (IPFS coordination)
- GraphQL query execution engine
- Event bus and real-time subscriptions

### Components Staying in Connect
- Client-side entity models and type definitions
- Identity management
  - Self-sovereign auth implementation
  - OAuth flow coordination
  - Key management (generation, storage, signing)
  - Migration utilities
- Namespace utilities
  - App/user/shared namespace derivation
  - Public key-based ID generation
- Message protocol and serialization
- Event handling and subscriptions
- Client-side caching and state management
- Offline-first sync engine
- Local storage layer (IndexedDB/SQLite)
- Conflict resolution strategies
- Networking utilities (for P2P features if needed)
- Logging and debugging utilities
- Decorators and helper functions

### Components Being Deprecated
- Task management system (TaskManager, TaskManagerRedis, TaskManagerEtcd)
- Server-side clustering infrastructure (ClusteredServer, worker pools)
- Capability registration and task claiming (replaced by Durable Objects' atomic state)

### New Components to Build
- RESTful API client with retry logic
- WebSocket client with automatic reconnection
- Hybrid identity system
  - Self-sovereign auth (DID + signature)
  - Custodial auth (OAuth integration)
  - Key management and migration
  - Session management
- Namespace system
  - App registration
  - User/shared namespace derivation
  - Public key utilities
- Request/response interceptors
- Client-side query builder
- Offline sync engine
  - Local state store
  - Operation queue
  - Delta sync implementation
  - Conflict resolver
- Connection status monitoring
- Optimistic update manager
- Sync event system

## Getting Started (Current)

### Installation
```bash
yarn install
```

### Build
```bash
yarn build          # Production build
yarn dev            # Development watch mode
```

### Testing
```bash
yarn test           # Run test suite
yarn lint           # Code quality checks
```

## Simple API Design

Connect provides **three core abstractions** that cover all your distributed application needs:

### 1. **client.auth** - Identity & Authentication
Handle user authentication with self-sovereign or custodial identity

### 2. **client.message** - Real-Time Messaging
Send messages, subscribe to events, and enable real-time communication

### 3. **client.storage** - Data Persistence
Store, query, and sync data across devices with offline-first support

---

## Core API Reference

### client.auth

Manage user authentication and identity.

```typescript
// OAuth login (custodial)
await client.auth.login({
  provider: 'google', // or 'github', 'microsoft'
  redirectUri: 'https://myapp.com/callback',
});

// Self-sovereign login (bring your own keys)
await client.auth.loginSovereign({
  did: 'did:key:z6MkpTHR...',
  publicKey: '04a1b2c3...',
  privateKey: '04xyz...', // Never sent to server
});

// Get current user
const user = client.auth.currentUser;
// { userId: 'user:abc123', did: '...', accountType: 'self-sovereign' }

// Logout
await client.auth.logout();

// Export keys (for custodial accounts)
const encryptedKey = await client.auth.exportPrivateKey('my-password');

// Migrate custodial to self-sovereign
await client.auth.migrateToSovereign({
  newPublicKey: '...',
  newPrivateKey: '...',
});
```

### client.message

Real-time messaging and pub/sub.

```typescript
// Subscribe to a topic/channel
client.message.subscribe('todos', (event) => {
  console.log('Event:', event.type, event.data);
});

// Subscribe with filters
client.message.subscribe('todos', (event) => {
  console.log('Todo created:', event.data);
}, { eventType: 'created' });

// Send message to another user
await client.message.send('user:abc123', {
  type: 'chat',
  text: 'Hello!',
  timestamp: Date.now(),
});

// Broadcast to a channel (shared namespace)
await client.message.broadcast('project:xyz', {
  type: 'task-updated',
  taskId: 'task-1',
  status: 'completed',
});

// Unsubscribe
const unsubscribe = client.message.subscribe('todos', handler);
unsubscribe(); // Stop listening

// Publish event (for your own app's event system)
await client.message.publish('todos', {
  type: 'created',
  data: { id: 'todo-1', title: 'New task' },
});
```

### client.storage

Offline-first data storage with automatic sync.

```typescript
// Set a value (collection, key, data)
await client.storage.set('todos', 'todo-1', {
  title: 'Buy groceries',
  completed: false,
  createdAt: Date.now(),
});

// Get a value
const todo = await client.storage.get('todos', 'todo-1');

// Delete a value
await client.storage.delete('todos', 'todo-1');

// List all items in a collection
const allTodos = await client.storage.list('todos');

// Query with filters
const activeTodos = await client.storage.query('todos', {
  where: { completed: false },
  orderBy: 'createdAt',
  limit: 10,
});

// Query with complex conditions
const recentTodos = await client.storage.query('todos', {
  where: {
    completed: false,
    createdAt: { gt: Date.now() - 86400000 }, // Last 24h
  },
  orderBy: { createdAt: 'desc' },
});

// Update a value (partial update)
await client.storage.update('todos', 'todo-1', {
  completed: true,
});

// Batch operations
await client.storage.batch([
  { op: 'set', collection: 'todos', key: 'todo-1', data: {...} },
  { op: 'set', collection: 'todos', key: 'todo-2', data: {...} },
  { op: 'delete', collection: 'todos', key: 'todo-3' },
]);

// Watch for changes (real-time)
client.storage.watch('todos', 'todo-1', (newValue) => {
  console.log('Todo updated:', newValue);
});

// Storage events
client.storage.on('synced', (stats) => {
  console.log('Sync complete:', stats);
});

client.storage.on('conflict', (conflict) => {
  console.log('Conflict detected:', conflict);
  // Optionally resolve manually
});
```

### Shared Data (Multi-User Collaboration)

For shared workspaces, collaborative documents, or multi-user features:

```typescript
// Create a shared space
const sharedSpace = await client.storage.createShared({
  participants: ['user:abc123', 'user:def456'],
  name: 'project-board',
});

// Set data in shared space
await client.storage.setShared(sharedSpace.id, 'tasks', 'task-1', {
  title: 'Design mockups',
  assignee: 'user:abc123',
});

// Get data from shared space
const task = await client.storage.getShared(sharedSpace.id, 'tasks', 'task-1');

// Query shared space
const tasks = await client.storage.queryShared(sharedSpace.id, 'tasks', {
  where: { assignee: 'user:abc123' },
});

// All participants receive real-time updates
client.message.subscribe(`shared:${sharedSpace.id}`, (event) => {
  console.log('Shared space updated:', event);
});
```

## Getting Started (Future)

```bash
# Install the client library
yarn add @muhkoo/connect

# Initialize the client
import { MuhkooClient } from '@muhkoo/connect';

const client = new MuhkooClient({
  endpoint: 'https://your-accelerator.workers.dev',
  appPublicKey: '04a1b2c3...', // Your app's public key
});

// 1. Authenticate
await client.auth.login({ provider: 'google' });
// or bring your own identity
await client.auth.loginSovereign({ did, publicKey, privateKey });

// 2. Store data (works offline, syncs automatically)
await client.storage.set('todos', 'todo-1', {
  title: 'Buy groceries',
  completed: false,
});

// 3. Subscribe to real-time updates
client.message.subscribe('todos', (event) => {
  console.log('Todo updated:', event.data);
});

// Query data
const todos = await client.storage.query('todos', {
  where: { completed: false },
  orderBy: 'createdAt',
});

// Send messages to other users
await client.message.send('user:abc123', {
  type: 'chat',
  text: 'Hello!',
});

// Everything works offline - syncs when online
client.on('online', () => console.log('Connected and syncing...'));
```

### Complete Example: Todo App

Here's a complete example showing how simple it is to build a collaborative todo app:

```typescript
import { MuhkooClient } from '@muhkoo/connect';

// Initialize
const client = new MuhkooClient({
  endpoint: 'https://your-accelerator.workers.dev',
  appPublicKey: '04a1b2c3...',
});

// Authenticate user
await client.auth.login({ provider: 'google' });

// Subscribe to todo updates (real-time)
client.message.subscribe('todos', (event) => {
  if (event.type === 'created') {
    addTodoToUI(event.data);
  } else if (event.type === 'updated') {
    updateTodoInUI(event.data);
  } else if (event.type === 'deleted') {
    removeTodoFromUI(event.data.id);
  }
});

// Create a todo
async function createTodo(title) {
  const id = crypto.randomUUID();

  // Store locally first (works offline)
  await client.storage.set('todos', id, {
    id,
    title,
    completed: false,
    createdAt: Date.now(),
    userId: client.auth.currentUser.userId,
  });

  // Notify other users/devices
  await client.message.publish('todos', {
    type: 'created',
    data: { id, title, completed: false },
  });

  return id;
}

// Toggle todo completion
async function toggleTodo(id) {
  const todo = await client.storage.get('todos', id);

  await client.storage.update('todos', id, {
    completed: !todo.completed,
  });

  await client.message.publish('todos', {
    type: 'updated',
    data: { id, completed: !todo.completed },
  });
}

// Delete a todo
async function deleteTodo(id) {
  await client.storage.delete('todos', id);

  await client.message.publish('todos', {
    type: 'deleted',
    data: { id },
  });
}

// Load all todos
async function loadTodos() {
  const todos = await client.storage.query('todos', {
    where: { userId: client.auth.currentUser.userId },
    orderBy: { createdAt: 'desc' },
  });

  renderTodos(todos);
}

// Share a todo with another user
async function shareTodo(todoId, otherUserId) {
  const todo = await client.storage.get('todos', todoId);

  // Send message to the other user
  await client.message.send(otherUserId, {
    type: 'todo-shared',
    data: todo,
  });
}

// Receive shared todos
client.message.subscribe('direct-messages', (event) => {
  if (event.type === 'todo-shared') {
    // Save shared todo to local storage
    const id = crypto.randomUUID();
    client.storage.set('todos', id, {
      ...event.data,
      id,
      sharedBy: event.senderId,
    });
  }
});

// Load todos when app starts
await loadTodos();

// Everything works offline and syncs automatically!
```

### Complete Example: Collaborative Document Editor

```typescript
import { MuhkooClient } from '@muhkoo/connect';

const client = new MuhkooClient({
  endpoint: 'https://your-accelerator.workers.dev',
  appPublicKey: '04a1b2c3...',
});

await client.auth.login({ provider: 'github' });

// Create a shared document
const sharedSpace = await client.storage.createShared({
  participants: [
    client.auth.currentUser.userId,
    'user:collaborator-123',
  ],
  name: 'project-proposal',
});

// Initialize document
await client.storage.setShared(sharedSpace.id, 'documents', 'doc-1', {
  title: 'Q4 Project Proposal',
  content: '',
  version: 0,
  lastEditedBy: client.auth.currentUser.userId,
  lastEditedAt: Date.now(),
});

// Watch for changes from collaborators
client.storage.watchShared(sharedSpace.id, 'documents', 'doc-1', (doc) => {
  if (doc.lastEditedBy !== client.auth.currentUser.userId) {
    // Another user edited - update UI
    updateEditorContent(doc.content);
    showNotification(`${doc.lastEditedBy} made changes`);
  }
});

// Save changes (with debouncing)
let saveTimeout;
function onEditorChange(newContent) {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(async () => {
    const doc = await client.storage.getShared(sharedSpace.id, 'documents', 'doc-1');

    await client.storage.updateShared(sharedSpace.id, 'documents', 'doc-1', {
      content: newContent,
      version: doc.version + 1,
      lastEditedBy: client.auth.currentUser.userId,
      lastEditedAt: Date.now(),
    });

    // Notify collaborators
    await client.message.broadcast(`shared:${sharedSpace.id}`, {
      type: 'document-updated',
      documentId: 'doc-1',
      editedBy: client.auth.currentUser.userId,
    });
  }, 500);
}

// Show who's currently viewing
await client.message.broadcast(`shared:${sharedSpace.id}`, {
  type: 'user-joined',
  userId: client.auth.currentUser.userId,
});

// Listen for presence updates
client.message.subscribe(`shared:${sharedSpace.id}`, (event) => {
  if (event.type === 'user-joined') {
    showPresence(event.userId, 'online');
  } else if (event.type === 'user-left') {
    showPresence(event.userId, 'offline');
  }
});
```

## Next Steps

### Testing & Quality

1. **Optimize base58 encoding** for large data (currently slow for >100KB)
   - Current implementation uses BigInt arithmetic which can be slow for large payloads
   - Consider using optimized base58 libraries or implementing chunked encoding
   - Target: Support efficient encoding/decoding of 1MB+ payloads
   - **Known Issue**: Message class tests disabled due to performance bottleneck (body getter/setter constantly serialize/deserialize with base58)

2. **Add integration tests** for Accelerator's Durable Objects
   - Test ECDH handshake between client and Durable Objects
   - Verify session management across DO instances
   - Test encrypted message routing through MessageBusDO
   - Validate storage operations with UserStorageDO and SharedStorageDO

3. **Add browser-specific tests** for Web Crypto API edge cases
   - Test in different browsers (Chrome, Firefox, Safari)
   - Verify crypto operations in web workers
   - Test with different key formats and curves
   - Validate cross-browser compatibility for encryption

4. **Performance benchmarks** for encryption operations
   - Benchmark ECDH key derivation times
   - Measure encryption/decryption throughput
   - Test SessionManager overhead
   - Profile ApiClient request latency
   - Create performance regression tests

## Development Status

- **Current Version**: v0.1.0-alpha.1
- **Node Version**: >= 20.0.0
- **Package Manager**: Yarn 1.22.22
- **License**: GPLv3

## Documentation

- **API Docs**: Auto-generated via TypeDoc (run `yarn build:docs`)
- **Architecture**: See this README for current and target architecture
- **Migration Guide**: Coming soon

## Contributing

This project is in active development and undergoing architectural transformation. Please coordinate with the core team before making significant changes.

## Related Projects

- [**Muhkoo Accelerator**](../accelerator/README.md) - Cloudflare Durable Objects infrastructure providing backend services for Connect

## License

GPLv3 - See LICENSE file for details
