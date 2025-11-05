# Connect SDK Documentation

Welcome to the **Connect SDK** documentation. This SDK provides end-to-end encrypted communication with zero-knowledge authentication, built on the Signal Protocol's Double Ratchet algorithm.

## Table of Contents

1. [**Crypto Architecture**](./crypto-architecture.md) - Overview of the encryption system
2. [**API Reference**](./api-reference.md) - Detailed API documentation
3. [**Usage Examples**](./examples.md) - Practical implementation examples
4. [**WebSocket Integration**](./websocket-integration.md) - Real-time messaging setup

## Quick Start

```typescript
import { DoubleRatchetManager, KeyStore } from '@muhkoo/connect';

// Initialize key store and generate keypair
const keyStore = KeyStore.getInstance();
await keyStore.generateOwnKeyPair('client1');

// Create session manager
const manager = new DoubleRatchetManager('client1');

// Initialize encrypted session
const sessionId = await manager.initializeSession(
  'client1',
  'server1',
  true,
  'specific'
);

// Send encrypted message
const message = await manager.encrypt(
  'client1',
  'server1',
  sessionId,
  'Hello, secure world!',
  false,
  'specific'
);

// Decrypt message
const plaintext = await manager.decrypt(message, true);
console.log(plaintext); // "Hello, secure world!"
```

## Key Features

- ✅ **Double Ratchet Protocol** - Signal-style forward secrecy
- ✅ **Zero-Knowledge Authentication** - Privacy-preserving ZK proofs using o1js
- ✅ **Session Management** - Persistent, resumable encrypted sessions
- ✅ **Multi-tenant Support** - Isolated key spaces per tenant
- ✅ **Broadcast & P2P** - Support for both 1:1 and fan-out messaging
- ✅ **File Encryption** - Reuse session keys for file/data encryption
- ✅ **Out-of-Order Delivery** - Handle network reordering gracefully
- ✅ **Message Authentication** - ECDSA signatures on every message
- ✅ **Replay Protection** - Timestamp validation prevents replay attacks

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│          Zero-Knowledge Authentication                  │
│  (o1js circuits for privacy-preserving handshake)       │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│          Double Ratchet Session Management              │
│  (ECDH key agreement + symmetric key ratcheting)        │
│                                                          │
│  ┌────────────────┐         ┌─────────────────┐        │
│  │ KeyStore       │────────▶│ RatchetManager  │        │
│  │ (P-384 keys)   │         │ (Sessions)      │        │
│  └────────────────┘         └────────┬────────┘        │
│                                      │                  │
│         ┌────────────────────────────┴────────┐        │
│         ▼                                     ▼        │
│  ┌─────────────┐                    ┌──────────────┐  │
│  │ Real-time   │                    │ File/Data    │  │
│  │ Messages    │                    │ Encryption   │  │
│  │ (WebSocket) │                    │ (AES-GCM)    │  │
│  └─────────────┘                    └──────────────┘  │
└─────────────────────────────────────────────────────────┘
```

## Security Properties

### Forward Secrecy
New message keys are derived for every message. Compromising current keys doesn't reveal past messages.

### Future Secrecy (Break-in Recovery)
DH ratchet rotates every 100 messages (configurable). Compromised session recovers after next DH ratchet.

### Message Authentication
Every message includes an ECDSA signature. Recipients verify sender identity.

### Replay Protection
Timestamps with 5-minute validity window prevent replay attacks.

### Zero-Knowledge Registration
Server never sees client secrets during registration. ZK proofs verify knowledge without revelation.

## Cryptographic Primitives

- **ECDH**: P-384 curve for key exchange
- **ECDSA**: P-384 curve for message signing
- **HKDF**: SHA-256 for key derivation
- **AES-GCM**: 256-bit for symmetric encryption
- **Poseidon**: Hash function for ZK circuits
- **Base58**: Compact encoding for key transport
- **Gzip**: Compression for key serialization

## Session Types

### Specific (1:1)
Private session between two parties. Keys rotate every 100 messages.

```typescript
const sessionId = await manager.initializeSession(
  senderId,
  recipientId,
  isClient,
  'specific'
);
```

### Global (Broadcast)
Shared session where server broadcasts to multiple clients. All clients decrypt with same keys.

```typescript
const sessionId = await manager.initializeSession(
  serverId,
  'global-client',
  false,
  'global'
);
```

## Multi-Tenant Isolation

Tenants are isolated by using different keypairs. No additional abstraction needed:

```typescript
// Tenant A
const keyStoreA = KeyStore.getInstance();
await keyStoreA.generateOwnKeyPair('tenant-a-server');

// Tenant B
const keyStoreB = KeyStore.getInstance();
await keyStoreB.generateOwnKeyPair('tenant-b-server');

// Clients can only decrypt if they have the correct tenant's public key
```

## Platform Support

- **Node.js**: Full support (uses Node crypto module)
- **Browser**: Planned (requires WebCrypto API adaptation)
- **React Native**: Planned (requires native crypto bridge)

## Testing

```bash
# Run all crypto tests
yarn test tests/crypto/

# Run specific test suite
yarn test tests/crypto/ratchet.test.ts
```

## License

[Your License Here]

## Contributing

[Contributing Guidelines]
