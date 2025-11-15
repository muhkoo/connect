# @muhkoo/connect API Reference

Complete API reference for the Muhkoo Connect client SDK.

## Installation

```bash
yarn add @muhkoo/connect
```

## Package Structure

The library supports multiple import paths for tree-shaking and modular usage:

```typescript
// Main entry point (includes everything)
import * as Connect from '@muhkoo/connect';

// Subpath imports (recommended for smaller bundles)
import { DoubleRatchet, KeyStore } from '@muhkoo/connect/crypto';
import { UserIdentity, Session } from '@muhkoo/connect/types';
import { EventCore } from '@muhkoo/connect/events';
import { Message, Packet } from '@muhkoo/connect/messaging';
import { serialize, deserialize, Logger } from '@muhkoo/connect/utilities';
```

### Available Entry Points

- `@muhkoo/connect` - Main entry (browser or server based on environment)
- `@muhkoo/connect/crypto` - Cryptographic utilities
- `@muhkoo/connect/types` - TypeScript type definitions
- `@muhkoo/connect/events` - Event handling
- `@muhkoo/connect/messaging` - Message and packet classes
- `@muhkoo/connect/utilities` - Helper functions and utilities

## Environment Support

The library provides separate builds for browser and Node.js environments:

- **Browser**: Uses Web Crypto API, IndexedDB
- **Node.js**: Uses Node.js crypto module, file system

The correct version is automatically selected based on the `package.json` exports configuration.

---

## Core Modules

### 1. Crypto Module

End-to-end encryption using Double Ratchet algorithm and key management.

#### DoubleRatchet

Implements the Double Ratchet algorithm for forward-secure messaging encryption.

```typescript
import { DoubleRatchet } from '@muhkoo/connect/crypto';

// Create a new ratchet session
const ratchet = new DoubleRatchet(
  senderId: string,
  recipientId: string,
  sessionType: 'global' | 'specific',
  isClient: boolean = true
);

// Initialize the session (must be called before encryption/decryption)
await ratchet.initializeSession(isClient: boolean);

// Encrypt a message
const cipherMessage = await ratchet.encrypt(
  plaintext: string,
  newDhKey: boolean,
  senderId: string,
  recipientId: string,
  sessionId: string,
  sessionType: 'global' | 'specific'
);

// Decrypt a message
const plaintext = await ratchet.decrypt(
  cipherMessage: CipherMessage,
  recipientId: string,
  senderId: string,
  sessionId: string
);
```

**CipherMessage Type**:
```typescript
interface CipherMessage {
  header: CipherMessageHeader;
  ciphertext: string;
}

interface CipherMessageHeader {
  senderId: string;
  recipientId: string;
  sessionId: string;
  sessionType: 'global' | 'specific';
  dhPub?: string;        // New DH public key (if ratchet step)
  prevChainLength: number;
  sendCount: number;
  timestamp: number;
}
```

#### KeyStore

Singleton for managing cryptographic key pairs.

```typescript
import { KeyStore } from '@muhkoo/connect/crypto';

// Get the singleton instance
const keyStore = KeyStore.getInstance();

// Generate a new key pair for an ID
const keyPair = await keyStore.generateOwnKeyPair(id: string);
// Returns: { privateKey: CryptoKey, publicKey: CryptoKey }

// Store remote public keys (for someone else)
await keyStore.storeRemotePublicKeys(
  id: string,
  ecdhPublicKey: CryptoKey,
  ecdsaPublicKey: CryptoKey
);

// Get a key pair by ID
const keyPair = keyStore.getKeyPair(id: string);

// Get auth keys (ECDSA) by ID
const authKeyPair = keyStore.getAuthKeyPair(id: string);

// Dehydrate keys for storage/transport
const dehydrated = await keyStore.dehydrateKeyPair(id: string);
// Returns: { ecdhPub, ecdhPriv, ecdsaPub, ecdsaPriv } as base58 strings

// Rehydrate keys from storage
await keyStore.hydrateKeyPair(id: string, dehydrated: DehydratedKeys);

// Clear all keys (e.g., on logout)
keyStore.clear();
```

**KeyPair Interfaces**:
```typescript
interface KeyPair {
  privateKey: CryptoKey | null;  // null for remote keys
  publicKey: CryptoKey;
}

interface DehydratedKeys {
  ecdhPub: string;    // Base58-encoded JWK
  ecdhPriv: string;   // Base58-encoded JWK
  ecdsaPub: string;   // Base58-encoded JWK
  ecdsaPriv: string;  // Base58-encoded JWK
}
```

#### DoubleRatchetManager

Manages multiple Double Ratchet sessions.

```typescript
import { DoubleRatchetManager } from '@muhkoo/connect/crypto';

// Get the singleton instance
const manager = DoubleRatchetManager.getInstance();

// Initialize a session
await manager.initializeSession(
  senderId: string,
  recipientId: string,
  sessionId: string,
  sessionType: 'global' | 'specific',
  isClient: boolean
);

// Encrypt a message
const cipherMessage = await manager.encrypt(
  plaintext: string,
  sessionId: string,
  senderId: string,
  recipientId: string,
  sessionType: 'global' | 'specific',
  newDhKey?: boolean
);

// Decrypt a message
const plaintext = await manager.decrypt(
  cipherMessage: CipherMessage,
  sessionId: string,
  recipientId: string,
  senderId: string
);

// Remove a session
manager.removeSession(sessionId: string);
```

---

### 2. Messaging Module

Message and packet handling with serialization and checksums.

#### Message

Represents a message with automatic serialization, checksums, and status tracking.

```typescript
import { Message } from '@muhkoo/connect/messaging';

// Create a message from body
const msg = new Message({ hello: 'world' });

// Or with options
const msg = new Message({
  id: 'custom-id',           // Optional, auto-generated if omitted
  body: { hello: 'world' },
  status: 'pending',         // 'pending' | 'processed' | 'failed' | 'delivered'
  checksum: 'abc123'         // Optional, auto-generated if omitted
});

// Access properties
console.log(msg.id);         // Auto-generated or custom ID
console.log(msg.timestamp);  // Timestamp in milliseconds
console.log(msg.status);     // Message status
console.log(msg.body);       // Automatically deserialized body
console.log(msg.checksum);   // Message checksum

// Verify checksum
msg.verifyChecksum();  // Throws error if invalid

// Serialize for transmission
const serialized = msg.serialize();  // JSON string

// Deserialize from string
const msg = Message.deserialize(serialized);
```

**Message Properties**:
- `id: string` - Unique message ID (auto-generated with MSG prefix)
- `timestamp: number` - Creation timestamp
- `status: "pending" | "processed" | "failed" | "delivered"`
- `checksum: string` - Integrity checksum
- `body: any` - Message payload (auto-serialized/deserialized)

**Size Limit**: Messages are limited to 3MB by default.

#### Packet

Network packet for routing messages between peers.

```typescript
import { Packet, Message } from '@muhkoo/connect/messaging';

// Create a packet
const packet = new Packet({
  subject: 'chat',              // Packet subject/topic
  source: 'user:alice',         // Sender address
  target: 'user:bob',           // Recipient address
  message: new Message({ text: 'Hello' }),  // Optional message
  headers: {                    // Optional metadata
    priority: 'high',
    encrypted: true
  },
  ttl: 60000,                   // Optional TTL in milliseconds
  signature: 'abc123'           // Optional signature
});

// Access properties
console.log(packet.id);        // Auto-generated packet ID
console.log(packet.timestamp); // Creation timestamp
console.log(packet.subject);   // Packet subject
console.log(packet.source);    // Source address
console.log(packet.target);    // Target address
console.log(packet.message);   // Message object (if present)
console.log(packet.headers);   // Custom headers

// Check if packet is expired
if (packet.isExpired()) {
  console.log('Packet has expired');
}

// Serialize for transmission
const serialized = packet.serialize();  // JSON string

// Deserialize from string
const packet = Packet.deserialize(serialized);
```

**Packet Properties**:
- `id: string` - Unique packet ID (auto-generated with PKT prefix)
- `subject: string` - Packet subject/topic
- `source: string` - Source address
- `target: string` - Target address
- `message?: Message` - Optional message payload
- `headers?: Record<string, string | number | boolean>` - Optional metadata
- `timestamp: number` - Creation timestamp
- `ttl?: number` - Time-to-live in milliseconds
- `signature?: string` - Optional cryptographic signature

---

### 3. Events Module

Event handling using browser EventTarget API.

#### EventCore

Static event emitter for application-wide events.

```typescript
import { EventCore, EventCoreEvents } from '@muhkoo/connect/events';

// Listen to an event
EventCore.on(EventCoreEvents.CONNECTED, (event: CustomEvent) => {
  console.log('Connected:', event.detail);
});

// Emit an event
EventCore.emit(EventCoreEvents.CONNECTED, { connectionId: '123' });

// Stop listening
const handler = (event: CustomEvent) => console.log(event.detail);
EventCore.on(EventCoreEvents.MESSAGE, handler);
EventCore.off(EventCoreEvents.MESSAGE, handler);
```

**Built-in Events**:
```typescript
enum EventCoreEvents {
  CONNECTED = "connected",
  DISCONNECTED = "disconnected",
  RECONNECTING = "reconnecting",
  ERROR = "error",
  DATA_RECEIVED = "data_received",
  DATA_SENT = "data_sent",
  MESSAGE = "message",
  GET_HISTORY = "get_history",
  RECEIVED_HISTORY = "received_history",
}
```

**Instance Usage**:

EventCore can also be extended by classes:

```typescript
class MyClient extends EventCore {
  emit = EventCore.emit;
  on = EventCore.on;
  off = EventCore.off;
}

const client = new MyClient();
client.on(EventCoreEvents.CONNECTED, handler);
client.emit(EventCoreEvents.CONNECTED, data);
```

---

### 4. Utilities Module

Helper functions for serialization, encoding, logging, and more.

#### Serialization

```typescript
import { serialize, deserialize } from '@muhkoo/connect/utilities';

// Serialize any data to base58 string
const data = { name: 'Alice', age: 30, items: [1, 2, 3] };
const serialized = serialize(data);  // Base58 string

// Deserialize back to original
const restored = deserialize<typeof data>(serialized);
```

Supports:
- Primitives (string, number, boolean, null)
- Objects and arrays
- Maps and Sets
- Dates
- Symbols (with Symbol.for)

#### Base58 Encoding

```typescript
import { base58Encode, base58Decode } from '@muhkoo/connect/utilities';

// Encode to base58
const encoded = base58Encode('Hello World');
const encoded2 = base58Encode(arrayBuffer);

// Decode from base58
const decoded = base58Decode(encoded);  // ArrayBuffer
```

#### Checksums

```typescript
import { generateChecksum, verifyChecksum } from '@muhkoo/connect/utilities';

// Generate checksum
const checksum = generateChecksum('my data string');

// Verify checksum
const isValid = verifyChecksum('my data string', checksum);  // true/false
```

#### ID Generation

```typescript
import {
  generateId,
  _messageId,
  _packetId,
  _userId,
  _accountId,
  _objectId,
  _socketId
} from '@muhkoo/connect/utilities';

// Generate base58-encoded UUIDs
const id = generateId();           // Base58 UUID
const msgId = _messageId();        // MSG + base58 UUID
const packetId = _packetId();      // PKT + base58 UUID
const userId = _userId();          // USR + base58 UUID
const accountId = _accountId();    // ACC + base58 UUID
const objectId = _objectId();      // OBJ + base58 UUID
const socketId = _socketId();      // SKT + base58 UUID
```

#### Type Assertions

```typescript
import { assertType } from '@muhkoo/connect/utilities';

// Assert primitive types
assertType<string>(value, 'string');
assertType<number>(value, 'number');

// Assert class instances
assertType<Message>(value, Message);

// Assert multiple possible types (OR)
assertType<Message | Packet>(value, [Message, Packet]);
```

#### Decorators

```typescript
import { Retry, Ready } from '@muhkoo/connect/utilities';

class MyService {
  ready: Promise<boolean>;

  // Retry a method 3 times with 1 second delay
  @Retry(3, 1000)
  async fetchData() {
    // This will retry on failure
  }

  // Wait for ready promise before executing
  @Ready('ready')
  async performAction() {
    // This waits for this.ready to resolve
  }
}
```

#### Logger

```typescript
import { Logger } from '@muhkoo/connect/utilities';

// Create a logger
const logger = new Logger('MyModule', 'DEBUG');

// Log levels
logger.debug('Debug message');
logger.verbose('Verbose message');
logger.log('Info message');
logger.warn('Warning message');
logger.error('Error message');

// Change log level
logger.setLevel('ERROR');  // 'DEBUG' | 'VERBOSE' | 'INFO' | 'WARN' | 'ERROR'
```

**Global Logger**:
```typescript
// Access the global app logger
appLogger.debug('Debug message');
```

#### Utility Functions

```typescript
import {
  _formatBytes,
  getIPAddress,
  isNumber,
  getId
} from '@muhkoo/connect/utilities';

// Format bytes to human-readable size
_formatBytes(1024);        // "1.00 KB"
_formatBytes(1048576, 0);  // "1 MB"

// Resolve hostname to IP using Cloudflare DNS
const ips = await getIPAddress('example.com');
// Returns: ["93.184.216.34"]

// Check if value is a number
isNumber(123);      // true
isNumber("123");    // true
isNumber("abc");    // false

// Get ID from database row
getId({ insertId: 5 });  // 5
getId({ id: 10 });       // 10
```

---

### 5. Types Module

Shared TypeScript type definitions between Connect and Accelerator.

#### Crypto Types

```typescript
import {
  ECDHCurve,
  PublicKeyJWK,
  Keypair,
  DehydratedKeypair
} from '@muhkoo/connect/types';

type ECDHCurve = 'P-256' | 'P-384';

interface PublicKeyJWK {
  kty: 'EC';
  crv: 'P-256' | 'P-384';
  x: string;
  y: string;
  ext?: boolean;
}

interface Keypair {
  publicKey: PublicKeyJWK;
  privateKey: CryptoKey;
}

interface DehydratedKeypair {
  publicKey: string;   // Dehydrated JWK (base64url)
  privateKey: string;  // Dehydrated JWK (base64url)
}
```

#### Identity Types

```typescript
import {
  UserIdentity,
  Session,
  AuthType,
  OAuthProvider
} from '@muhkoo/connect/types';

interface UserIdentity {
  publicKey: string;  // Dehydrated public key (primary identity)
  accountType: 'self-sovereign' | 'custodial';
  did?: string;       // Optional DID for self-sovereign users
  provider?: string;  // OAuth provider for custodial users
  createdAt: number;
}

interface Session {
  sessionId: string;
  publicKey: string;      // User's identity
  appPublicKey: string;
  createdAt: number;
  expiresAt: number;
  sharedSecret?: string;
}

type AuthType = 'self-sovereign' | 'custodial';
type OAuthProvider = 'google' | 'github' | 'discord' | 'twitter';
```

#### Messaging Types

```typescript
import {
  MessageEvent,
  Subscription,
  WSMessageType,
  WSMessage
} from '@muhkoo/connect/types';

interface MessageEvent {
  type: string;
  topic: string;
  data: any;
  senderPublicKey?: string;
  timestamp: number;
}

interface Subscription {
  connectionId: string;
  publicKey: string;  // Subscriber's identity
  topic: string;
  filters?: any;
}

type WSMessageType =
  | 'connect'
  | 'connected'
  | 'subscribe'
  | 'subscribed'
  | 'unsubscribe'
  | 'publish'
  | 'event'
  | 'message'
  | 'error';

interface WSMessage {
  type: WSMessageType;
  topic?: string;
  data?: any;
  publicKey?: string;
  connectionId?: string;
  timestamp?: number;
}
```

---

## Usage Examples

### End-to-End Encrypted Messaging

```typescript
import { KeyStore, DoubleRatchetManager } from '@muhkoo/connect/crypto';
import { Message, Packet } from '@muhkoo/connect/messaging';

// Setup
const keyStore = KeyStore.getInstance();
const ratchetManager = DoubleRatchetManager.getInstance();

// Generate key pairs for both parties
await keyStore.generateOwnKeyPair('alice');
await keyStore.generateOwnKeyPair('bob');

// Exchange public keys (in real app, this happens over network)
const aliceKeys = keyStore.getKeyPair('alice');
const bobKeys = keyStore.getKeyPair('bob');
await keyStore.storeRemotePublicKeys('alice', bobKeys.publicKey,
  keyStore.getAuthKeyPair('bob').publicKey);
await keyStore.storeRemotePublicKeys('bob', aliceKeys.publicKey,
  keyStore.getAuthKeyPair('alice').publicKey);

// Initialize encrypted session
await ratchetManager.initializeSession(
  'alice',
  'bob',
  'session-123',
  'specific',
  true  // alice is client
);

// Encrypt a message
const plaintext = 'Hello Bob!';
const cipherMessage = await ratchetManager.encrypt(
  plaintext,
  'session-123',
  'alice',
  'bob',
  'specific'
);

// Create packet for transport
const packet = new Packet({
  subject: 'encrypted-message',
  source: 'alice',
  target: 'bob',
  message: new Message(cipherMessage)
});

// --- On Bob's side ---
// Decrypt the message
const receivedCipher = packet.message.body;
const decrypted = await ratchetManager.decrypt(
  receivedCipher,
  'session-123',
  'bob',
  'alice'
);

console.log(decrypted);  // "Hello Bob!"
```

### Event-Driven Architecture

```typescript
import { EventCore, EventCoreEvents } from '@muhkoo/connect/events';
import { Message } from '@muhkoo/connect/messaging';

// Setup event listeners
EventCore.on(EventCoreEvents.MESSAGE, (event: CustomEvent) => {
  const message = event.detail as Message;
  console.log('Received message:', message.body);
});

EventCore.on(EventCoreEvents.ERROR, (event: CustomEvent) => {
  console.error('Error:', event.detail);
});

// Emit events
const msg = new Message({ text: 'Hello!' });
EventCore.emit(EventCoreEvents.MESSAGE, msg);
```

### Serialization and Transport

```typescript
import { serialize, deserialize } from '@muhkoo/connect/utilities';
import { Message, Packet } from '@muhkoo/connect/messaging';

// Create complex data structure
const data = {
  user: { name: 'Alice', joined: new Date() },
  tags: new Set(['developer', 'designer']),
  metadata: new Map([['role', 'admin'], ['level', 5]])
};

// Serialize for storage/transport
const serialized = serialize(data);  // Base58 string

// Send over network, save to file, etc.
// ...

// Deserialize
const restored = deserialize(serialized);
console.log(restored.user.joined instanceof Date);  // true
console.log(restored.tags instanceof Set);          // true
console.log(restored.metadata instanceof Map);      // true
```

---

## Performance Considerations

### Known Issues

1. **Base58 encoding** is slow for large payloads (>100KB)
   - Uses BigInt arithmetic which can be CPU-intensive
   - Consider chunking large data or using alternative encoding for bulk transfers

2. **Message body serialization** happens on every get/set
   - Avoid repeatedly accessing `message.body` in tight loops
   - Cache the deserialized value if accessed multiple times

### Best Practices

1. **Reuse KeyStore and RatchetManager instances** - they are singletons
2. **Batch message encryption** when possible
3. **Use specific sessions** for high-volume messaging (enables DH ratcheting)
4. **Set appropriate TTLs** on packets to prevent stale messages
5. **Verify checksums** on critical messages only (has performance cost)

---

## Browser vs Node.js Differences

| Feature | Browser | Node.js |
|---------|---------|---------|
| Crypto API | Web Crypto API | Node.js crypto module |
| Storage | IndexedDB | File system / SQLite |
| Import | `dist/browser/index.js` | `dist/server/index.js` |
| Workers | Web Workers | Worker threads |

Both environments use the same API surface - differences are handled internally.

---

## TypeScript Support

The library is written in TypeScript and provides full type definitions:

```typescript
import type {
  Message,
  MessageOptions,
  Packet,
  PacketOptions,
  UserIdentity,
  Session,
  WSMessage
} from '@muhkoo/connect';
```

All types are exported from their respective modules and from the main entry point.

---

## License

GPL-3.0 - See LICENSE file for details.

## Version

Current version: 0.1.0-alpha.1

Requires Node.js >= 20.0.0
