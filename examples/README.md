# Connect SDK Examples

This directory contains examples demonstrating how to use the Connect SDK for end-to-end encrypted communication with Cloudflare Workers.

## Overview

Connect SDK provides:
- **End-to-end encryption** using ECDH key exchange + AES-GCM
- **Type-safe API client** for Cloudflare Workers backend
- **Session management** with automatic encryption/decryption
- **Zero-knowledge architecture** - server never sees plaintext data

## Basic Usage

### 1. Install Dependencies

```bash
yarn add @muhkoo/connect
```

### 2. Initialize Client

```typescript
import { ApiClient } from '@muhkoo/connect/api';

const client = new ApiClient({
  baseUrl: 'https://api.example.com',
  timeout: 30000,
});
```

### 3. Authenticate (ECDH Key Exchange)

```typescript
// Client and server perform ECDH key exchange
// Both derive the same shared secret without transmitting it
const session = await client.createSession();

console.log('Session ID:', session.sessionId);
console.log('Expires:', new Date(session.expiresAt));
```

### 4. Send Encrypted Message

```typescript
// Message is automatically encrypted before sending
const response = await client.sendMessage('chat:general', {
  text: 'Hello, secure world!',
  timestamp: Date.now(),
});

console.log('Message sent:', response.messageId);
```

### 5. Fetch and Decrypt Messages

```typescript
const { messages } = await client.fetchMessages('chat:general');

// Decrypt each message
for (const msg of messages) {
  const decrypted = await client.decryptMessage(msg.encryptedData);
  console.log('From:', msg.senderPublicKey);
  console.log('Data:', decrypted);
}
```

### 6. Store Encrypted Data

```typescript
// Data is automatically encrypted before storage
await client.storeData('user:preferences', {
  theme: 'dark',
  language: 'en',
}, 'settings');
```

### 7. Retrieve and Decrypt Data

```typescript
// Data is automatically decrypted after retrieval
const preferences = await client.retrieveData('user:preferences', 'settings');
console.log(preferences); // { theme: 'dark', language: 'en' }
```

## How End-to-End Encryption Works

### ECDH Key Exchange

```
Client                          Server
------                          ------
1. Generate keypair (P-256)
2. Send public key    ------>   3. Receive client's public key
                                 4. Generate keypair (P-256)
5. Receive server's   <------   5. Send public key
   public key
6. Derive shared secret         6. Derive same shared secret
   using server's public           using client's public
   key + own private key           key + own private key

7. Both now have the same shared secret (never transmitted!)
```

### Encrypted Communication

```
Client                                  Server
------                                  ------
1. Encrypt data with shared secret
2. Send encrypted data      ------>    3. Store encrypted blob
                                         (cannot decrypt - no secret!)

4. Request data             ------>    5. Return encrypted blob
5. Decrypt with shared      <------
   secret
```

## Architecture

```
┌─────────────────────────────────────────────────┐
│                 Browser/Client                   │
├─────────────────────────────────────────────────┤
│ • Generate ephemeral keypair (P-256)            │
│ • ECDH shared secret derivation                 │
│ • AES-GCM encryption/decryption                 │
│ • Base58 encoding for transport                 │
└──────────────┬──────────────────────────────────┘
               │
               │ Encrypted data only
               │ (base58-encoded)
               ▼
┌─────────────────────────────────────────────────┐
│          Cloudflare Workers (Server)             │
├─────────────────────────────────────────────────┤
│ • Store encrypted blobs (opaque)                │
│ • Route messages                                │
│ • Enforce permissions                           │
│ • Never sees plaintext!                         │
└─────────────────────────────────────────────────┘
```

## Security Properties

✅ **End-to-end encrypted** - Only client has decryption keys
✅ **Forward secrecy** - Ephemeral session keys
✅ **Zero-knowledge** - Server cannot read data
✅ **Public key as identity** - No passwords
✅ **Authenticated encryption** - AES-GCM with integrity
✅ **Base58 encoding** - Compact, URL-safe transport

## API Methods

### Authentication
- `createSession()` - Establish ECDH session
- `refreshSession()` - Extend session expiration
- `logout()` - Clear session
- `isAuthenticated()` - Check session validity

### Messaging
- `sendMessage(topic, data, recipient?)` - Send encrypted message
- `subscribe(topic)` - Subscribe to topic
- `fetchMessages(topic, since?, limit?)` - Fetch messages
- `decryptMessage(encrypted)` - Decrypt message data

### Storage
- `storeData(key, data, namespace?)` - Store encrypted data
- `retrieveData(key, namespace?)` - Retrieve and decrypt data
- `deleteData(key, namespace?)` - Delete data
- `listKeys(namespace?, prefix?)` - List keys

### Permissions
- `checkPermission(resource, permission)` - Check access
- `grantPermission(resource, user, permissions)` - Grant access

## Examples

### Direct Encryption (No API)

```typescript
import { generateEphemeralKeypair, deriveSharedSecret } from '@muhkoo/connect/crypto';
import { encrypt, decrypt } from '@muhkoo/connect/crypto';

// Alice and Bob each generate keypairs
const alice = await generateEphemeralKeypair('P-256');
const bob = await generateEphemeralKeypair('P-256');

// Both derive the same shared secret
const aliceSecret = await deriveSharedSecret(alice.privateKey, bob.publicKey);
const bobSecret = await deriveSharedSecret(bob.privateKey, alice.publicKey);

// Alice encrypts
const encrypted = await encrypt(aliceSecret, 'Secret message');

// Bob decrypts
const decrypted = await decrypt(bobSecret, encrypted);
```

### Custom Session Management

```typescript
import { SessionManager } from '@muhkoo/connect/api';

const session = new SessionManager();

// Create session
const publicKey = await session.createSession('P-256');

// Complete after server response
await session.completeSession(serverPublicKey, sessionId, expiresAt);

// Encrypt/decrypt directly
const encrypted = await session.encrypt('plaintext');
const decrypted = await session.decrypt(encrypted);

// Or with JSON
const encryptedJSON = await session.encryptJSON({ foo: 'bar' });
const decryptedObj = await session.decryptJSON(encryptedJSON);
```

## Testing

Run the example:

```bash
# Install dependencies
yarn install

# Build the SDK
yarn build

# Run the example
npx tsx examples/basic-usage.ts
```

### Real-time Communication with Network Class

```typescript
import { Network, SessionManager } from '@muhkoo/connect';
import { Message } from '@muhkoo/connect/messaging';

// Create and initialize session
const sessionManager = new SessionManager();
const sessionId = await sessionManager.createSession('P-384', appPublicKey);

// Create Network instance
const network = new Network({
  url: `ws://localhost:8787/ws?appPublicKey=${appPublicKey}&sessionId=${sessionId}`,
  sessionManager,
  autoReconnect: true,
});

// Listen for events
network.addEventListener('connected', () => {
  console.log('Connected to server');
});

network.addEventListener('message', (event: CustomEvent) => {
  const packet = event.detail;
  console.log('Received:', packet.subject, packet.message?.body);
});

// Connect
await network.connect();

// Send messages using Packet protocol
await network.send({
  subject: 'ping',
  target: 'server',
  message: new Message({ timestamp: Date.now() }),
});

// Subscribe to topics
await network.send({
  subject: 'subscribe',
  target: 'server',
  message: new Message({ topic: 'notifications' }),
});

// Publish events
await network.send({
  subject: 'publish',
  target: 'server',
  message: new Message({
    topic: 'notifications',
    event: { type: 'alert', message: 'Important update!' },
  }),
});
```

Run the network example:

```bash
# Start Accelerator server
cd accelerator
yarn dev

# In another terminal, run the example
cd connect
npx tsx examples/network-example.ts
```

## Next Steps

1. **Set up Cloudflare Workers backend** - Implement API endpoints ✅
2. **Add WebSocket support** - Real-time encrypted messaging ✅
3. **Implement group encryption** - Multi-party E2E encryption
4. **Add key rotation** - Periodic session key refresh

## Resources

- [ECDH (Elliptic Curve Diffie-Hellman)](https://en.wikipedia.org/wiki/Elliptic-curve_Diffie%E2%80%93Hellman)
- [AES-GCM](https://en.wikipedia.org/wiki/Galois/Counter_Mode)
- [Base58 Encoding](https://en.wikipedia.org/wiki/Base58)
- [Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API)
