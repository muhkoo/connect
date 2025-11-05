# Usage Examples

Practical examples for integrating the Connect SDK into your application.

## Table of Contents

1. [Basic 1:1 Messaging](#basic-11-messaging)
2. [Broadcast Messaging](#broadcast-messaging)
3. [File Encryption](#file-encryption)
4. [WebSocket Integration](#websocket-integration)
5. [Multi-Tenant Setup](#multi-tenant-setup)
6. [Session Recovery](#session-recovery)
7. [Error Handling](#error-handling)

## Basic 1:1 Messaging

### Complete Flow

```typescript
import { DoubleRatchetManager, KeyStore, PreimagePoK, AuthPublicInput } from '@muhkoo/connect';
import { Field, Poseidon } from 'o1js';

// ============================================
// 1. Setup (one-time)
// ============================================

const keyStore = KeyStore.getInstance();

// Client generates keypair
const clientKeyPair = await keyStore.generateOwnKeyPair('client1');
const clientAuthKeyPair = keyStore.getAuthKeyPair('client1')!;

// Server generates keypair
const serverKeyPair = await keyStore.generateOwnKeyPair('server1');
const serverAuthKeyPair = keyStore.getAuthKeyPair('server1')!;

// ============================================
// 2. Registration (client → server)
// ============================================

// Client: Generate secret and commitment
const secret = Field.random();
const salt = Field.random();

// Client: Hash ECDSA public key
const ecdsaJwk = await crypto.subtle.exportKey('jwk', clientAuthKeyPair.publicKey);
const ecdsaHex = '0x' + Buffer.from(ecdsaJwk.x!, 'base64url').toString('hex').slice(0, 64);
const ecdsaPubField = Field(BigInt(ecdsaHex));
const ecdsaPubHash = Poseidon.hash([ecdsaPubField]);

// Client: Create commitment
const commitment = Poseidon.hash([secret, salt, ecdsaPubHash]);

// Server: Register client
const serverManager = new DoubleRatchetManager('server1');
await serverManager.registerZK(
  'client1',
  secret,      // In production, server doesn't have this
  salt,        // In production, server doesn't have this
  clientAuthKeyPair.publicKey
);

// ============================================
// 3. Handshake (client → server)
// ============================================

// Compile ZK circuit (one-time, slow)
await PreimagePoK.compile();

// Client: Generate ZK proof
const nonce = Field.random();
const publicInput = new AuthPublicInput({
  commitment,
  nonce,
  ecdsaPubHash
});

const { proof } = await PreimagePoK.proveKnowledge(
  publicInput,
  secret,
  salt,
  ecdsaPubField
);

// Client: Generate auth token
const clientManager = new DoubleRatchetManager('client1');
const authToken = await clientManager.authenticator.generateAuthToken(
  'client1',
  clientAuthKeyPair.privateKey!
);

// Server: Verify and establish session
await serverManager.performHandshake(
  'client1',
  'server1',
  proof,
  publicInput,
  clientKeyPair.publicKey,
  clientAuthKeyPair.publicKey,
  authToken
);

// ============================================
// 4. Session Initialization
// ============================================

// Client initializes session
const sessionId = await clientManager.initializeSession(
  'client1',
  'server1',
  true,      // isClient = true
  'specific'
);

// Server initializes matching session
await serverManager.initializeSession(
  'server1',
  'client1',
  false,     // isClient = false
  'specific',
  sessionId  // Use same sessionId
);

// ============================================
// 5. Encrypted Communication
// ============================================

// Client sends message
const message = await clientManager.encrypt(
  'client1',
  'server1',
  sessionId,
  'Hello, Server!',
  false,
  'specific'
);

// Server decrypts message
const plaintext = await serverManager.decrypt(message, false);
console.log(plaintext); // "Hello, Server!"

// Server replies
const reply = await serverManager.encrypt(
  'server1',
  'client1',
  sessionId,
  'Hello, Client!',
  false,
  'specific'
);

// Client decrypts reply
const replyText = await clientManager.decrypt(reply, true);
console.log(replyText); // "Hello, Client!"
```

## Broadcast Messaging

Server sends messages to multiple clients:

```typescript
// ============================================
// Setup
// ============================================

const serverManager = new DoubleRatchetManager('global-server');
const client1Manager = new DoubleRatchetManager('global-client1');
const client2Manager = new DoubleRatchetManager('global-client2');
const client3Manager = new DoubleRatchetManager('global-client3');

// Generate keys
await keyStore.generateOwnKeyPair('global-server');
await keyStore.generateOwnKeyPair('global-client');

// Pre-share server's public keys with all clients
const serverKeyPair = keyStore.getKeyPair('global-server')!;
const serverAuthKeyPair = keyStore.getAuthKeyPair('global-server')!;

await keyStore.storeRemotePublicKeys(
  'global-server',
  serverKeyPair.publicKey,
  serverAuthKeyPair.publicKey
);

// Clients trust server
await client1Manager.addTrustedServer('global-server', serverAuthKeyPair.publicKey);
await client2Manager.addTrustedServer('global-server', serverAuthKeyPair.publicKey);
await client3Manager.addTrustedServer('global-server', serverAuthKeyPair.publicKey);

// ============================================
// Initialize Broadcast Session
// ============================================

const sessionId = await serverManager.initializeSession(
  'global-server',
  'global-client',
  false,   // server is not client
  'global'
);

// All clients initialize with SAME sessionId
await client1Manager.initializeSession('global-client', 'global-server', true, 'global', sessionId);
await client2Manager.initializeSession('global-client', 'global-server', true, 'global', sessionId);
await client3Manager.initializeSession('global-client', 'global-server', true, 'global', sessionId);

// ============================================
// Broadcast Messages
// ============================================

// Server broadcasts message
const broadcast = await serverManager.encrypt(
  'global-server',
  'global-client',
  sessionId,
  'System update: Version 2.0 deployed',
  false,
  'global'
);

// All clients can decrypt the same message
const text1 = await client1Manager.decrypt(broadcast, true);
const text2 = await client2Manager.decrypt(broadcast, true);
const text3 = await client3Manager.decrypt(broadcast, true);

console.log(text1); // "System update: Version 2.0 deployed"
console.log(text2); // "System update: Version 2.0 deployed"
console.log(text3); // "System update: Version 2.0 deployed"

// ============================================
// Out-of-Order Delivery
// ============================================

// Server sends multiple messages
const msg1 = await serverManager.encrypt('global-server', 'global-client', sessionId, 'Message 1', false, 'global');
const msg2 = await serverManager.encrypt('global-server', 'global-client', sessionId, 'Message 2', false, 'global');
const msg3 = await serverManager.encrypt('global-server', 'global-client', sessionId, 'Message 3', false, 'global');

// Client receives out of order: 3, 1, 2
const text3_first = await client1Manager.decrypt(msg3, true);  // "Message 3"
const text1_later = await client1Manager.decrypt(msg1, true);  // "Message 1"
const text2_last = await client1Manager.decrypt(msg2, true);   // "Message 2"

// All decrypt successfully!
```

## File Encryption

Use session shared secret for file encryption:

```typescript
import { promises as fs } from 'fs';
import * as crypto from 'crypto';

// ============================================
// 1. Establish Session First
// ============================================

const sessionId = await clientManager.initializeSession(
  'client1',
  'server1',
  true,
  'specific'
);

await serverManager.initializeSession(
  'server1',
  'client1',
  false,
  'specific',
  sessionId
);

// ============================================
// 2. Get Shared Secret from Session
// ============================================

const clientSecret = await clientManager.getSessionSharedSecret(sessionId);
const serverSecret = await serverManager.getSessionSharedSecret(sessionId);

// Secrets match!
console.log(clientSecret!.equals(serverSecret!)); // true

// ============================================
// 3. Encrypt File (Client)
// ============================================

// Convert shared secret to AES key
const fileEncryptionKey = await crypto.subtle.importKey(
  'raw',
  clientSecret!,
  'AES-GCM',
  false,
  ['encrypt']
);

// Read file
const fileData = await fs.readFile('./documents/report.pdf');

// Encrypt
const iv = crypto.randomBytes(12);
const encryptedFile = await crypto.subtle.encrypt(
  { name: 'AES-GCM', iv },
  fileEncryptionKey,
  fileData
);

// Send to server: { iv, encryptedFile }
const payload = {
  sessionId,
  iv: iv.toString('hex'),
  data: Buffer.from(encryptedFile).toString('base64')
};

// ============================================
// 4. Decrypt File (Server)
// ============================================

// Server receives payload
const fileDecryptionKey = await crypto.subtle.importKey(
  'raw',
  serverSecret!,
  'AES-GCM',
  false,
  ['decrypt']
);

const decryptedFile = await crypto.subtle.decrypt(
  { name: 'AES-GCM', iv: Buffer.from(payload.iv, 'hex') },
  fileDecryptionKey,
  Buffer.from(payload.data, 'base64')
);

// Save decrypted file
await fs.writeFile('./uploads/report.pdf', Buffer.from(decryptedFile));

console.log('File encrypted and decrypted successfully!');
```

### Chunked File Upload (Large Files)

```typescript
const CHUNK_SIZE = 64 * 1024; // 64KB chunks

async function encryptFileInChunks(
  filePath: string,
  sharedSecret: Buffer
): Promise<{ chunks: Buffer[], iv: Buffer }> {
  const fileKey = await crypto.subtle.importKey(
    'raw',
    sharedSecret,
    'AES-GCM',
    false,
    ['encrypt']
  );

  const iv = crypto.randomBytes(12);
  const fileData = await fs.readFile(filePath);
  const chunks: Buffer[] = [];

  for (let i = 0; i < fileData.length; i += CHUNK_SIZE) {
    const chunk = fileData.slice(i, Math.min(i + CHUNK_SIZE, fileData.length));
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: Buffer.concat([iv, Buffer.from([i / CHUNK_SIZE])]) },
      fileKey,
      chunk
    );
    chunks.push(Buffer.from(encrypted));
  }

  return { chunks, iv };
}

async function decryptFileChunks(
  chunks: Buffer[],
  iv: Buffer,
  sharedSecret: Buffer
): Promise<Buffer> {
  const fileKey = await crypto.subtle.importKey(
    'raw',
    sharedSecret,
    'AES-GCM',
    false,
    ['decrypt']
  );

  const decryptedChunks: Buffer[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: Buffer.concat([iv, Buffer.from([i])]) },
      fileKey,
      chunks[i]
    );
    decryptedChunks.push(Buffer.from(decrypted));
  }

  return Buffer.concat(decryptedChunks);
}

// Usage
const secret = await clientManager.getSessionSharedSecret(sessionId);
const { chunks, iv } = await encryptFileInChunks('./large-file.mp4', secret!);

// Send chunks over network...

const decrypted = await decryptFileChunks(chunks, iv, secret!);
```

## WebSocket Integration

Real-time encrypted messaging over WebSocket:

```typescript
import WebSocket from 'ws';

// ============================================
// Server-Side WebSocket Handler
// ============================================

class EncryptedWebSocketServer {
  private wss: WebSocket.Server;
  private managers: Map<string, DoubleRatchetManager> = new Map();

  constructor(port: number) {
    this.wss = new WebSocket.Server({ port });

    this.wss.on('connection', (ws, req) => {
      const clientId = this.authenticateConnection(req); // Your auth logic

      ws.on('message', async (data) => {
        await this.handleMessage(clientId, data.toString());
      });
    });
  }

  private async handleMessage(clientId: string, data: string) {
    const message = JSON.parse(data);

    if (message.type === 'handshake') {
      await this.handleHandshake(clientId, message);
    } else if (message.type === 'encrypted') {
      await this.handleEncrypted(clientId, message);
    }
  }

  private async handleHandshake(clientId: string, msg: any) {
    const manager = new DoubleRatchetManager('server');

    // Verify ZK proof
    await manager.performHandshake(
      clientId,
      'server',
      msg.proof,
      msg.publicInput,
      msg.ecdhPublicKey,
      msg.ecdsaPublicKey,
      msg.authToken
    );

    // Initialize session
    const sessionId = await manager.initializeSession(
      'server',
      clientId,
      false,
      'specific',
      msg.sessionId
    );

    this.managers.set(clientId, manager);

    // Send acknowledgment
    this.sendToClient(clientId, {
      type: 'handshake-ack',
      sessionId
    });
  }

  private async handleEncrypted(clientId: string, msg: any) {
    const manager = this.managers.get(clientId);
    if (!manager) throw new Error('No session for client');

    // Decrypt message
    const plaintext = await manager.decrypt(msg.message, false);

    console.log(`Received from ${clientId}: ${plaintext}`);

    // Encrypt reply
    const reply = await manager.encrypt(
      'server',
      clientId,
      msg.message.header.sessionId,
      `Echo: ${plaintext}`,
      false,
      'specific'
    );

    // Send encrypted reply
    this.sendToClient(clientId, {
      type: 'encrypted',
      message: reply
    });
  }

  private sendToClient(clientId: string, data: any) {
    // Find client WebSocket and send
    // Implementation depends on your WebSocket management
  }
}

// ============================================
// Client-Side WebSocket
// ============================================

class EncryptedWebSocketClient {
  private ws: WebSocket;
  private manager: DoubleRatchetManager;
  private sessionId: string | null = null;

  constructor(url: string, clientId: string) {
    this.ws = new WebSocket(url);
    this.manager = new DoubleRatchetManager(clientId);

    this.ws.on('message', async (data) => {
      await this.handleMessage(data.toString());
    });
  }

  async connect(serverId: string, proof: any, publicInput: any, authToken: any) {
    // Initialize session
    this.sessionId = await this.manager.initializeSession(
      'client1',
      serverId,
      true,
      'specific'
    );

    // Send handshake
    const keyStore = KeyStore.getInstance();
    const ecdhPub = keyStore.getKeyPair('client1')!.publicKey;
    const ecdsaPub = keyStore.getAuthKeyPair('client1')!.publicKey;

    this.ws.send(JSON.stringify({
      type: 'handshake',
      sessionId: this.sessionId,
      proof,
      publicInput,
      ecdhPublicKey: ecdhPub,
      ecdsaPublicKey: ecdsaPub,
      authToken
    }));
  }

  async sendEncrypted(text: string) {
    if (!this.sessionId) throw new Error('Not connected');

    const message = await this.manager.encrypt(
      'client1',
      'server',
      this.sessionId,
      text,
      false,
      'specific'
    );

    this.ws.send(JSON.stringify({
      type: 'encrypted',
      message
    }));
  }

  private async handleMessage(data: string) {
    const msg = JSON.parse(data);

    if (msg.type === 'handshake-ack') {
      console.log('Handshake successful!');
    } else if (msg.type === 'encrypted') {
      const plaintext = await this.manager.decrypt(msg.message, true);
      console.log(`Received: ${plaintext}`);
    }
  }
}

// Usage
const client = new EncryptedWebSocketClient('ws://localhost:8080', 'client1');
await client.connect('server', proof, publicInput, authToken);
await client.sendEncrypted('Hello, encrypted world!');
```

## Multi-Tenant Setup

Isolate tenants using different key IDs:

```typescript
// ============================================
// Tenant Manager
// ============================================

class TenantManager {
  private keyStore = KeyStore.getInstance();
  private ratchetManagers: Map<string, DoubleRatchetManager> = new Map();

  async createTenant(tenantId: string) {
    // Generate tenant server keypair
    await this.keyStore.generateOwnKeyPair(`${tenantId}-server`);

    const manager = new DoubleRatchetManager(`${tenantId}-server`);
    this.ratchetManagers.set(tenantId, manager);
  }

  async addClient(tenantId: string, clientId: string) {
    const fullClientId = `${tenantId}-${clientId}`;

    // Generate client keypair
    await this.keyStore.generateOwnKeyPair(fullClientId);

    // Register with tenant's server
    const manager = this.ratchetManagers.get(tenantId);
    if (!manager) throw new Error('Tenant not found');

    // ... perform handshake and initialize session
  }

  async sendMessage(
    tenantId: string,
    fromClientId: string,
    toClientId: string,
    text: string
  ) {
    const manager = this.ratchetManagers.get(tenantId);
    if (!manager) throw new Error('Tenant not found');

    const sessionId = `${tenantId}-${fromClientId}-${toClientId}`;

    return await manager.encrypt(
      `${tenantId}-${fromClientId}`,
      `${tenantId}-${toClientId}`,
      sessionId,
      text,
      false,
      'specific'
    );
  }
}

// Usage
const tenantMgr = new TenantManager();

// Tenant A
await tenantMgr.createTenant('tenant-a');
await tenantMgr.addClient('tenant-a', 'client1');
await tenantMgr.addClient('tenant-a', 'client2');

// Tenant B (completely isolated)
await tenantMgr.createTenant('tenant-b');
await tenantMgr.addClient('tenant-b', 'client1');

// Messages within Tenant A
await tenantMgr.sendMessage('tenant-a', 'client1', 'client2', 'Hello from A');

// Messages within Tenant B (different encryption keys!)
await tenantMgr.sendMessage('tenant-b', 'client1', 'server', 'Hello from B');
```

## Session Recovery

Recover sessions after restart:

```typescript
// ============================================
// Before Restart
// ============================================

const manager = new DoubleRatchetManager('client1');
const sessionId = await manager.initializeSession(
  'client1',
  'server1',
  true,
  'specific'
);

// Send some messages
await manager.encrypt('client1', 'server1', sessionId, 'Message 1', false, 'specific');
await manager.encrypt('client1', 'server1', sessionId, 'Message 2', false, 'specific');

// Session state is automatically saved to disk:
// ./tests/v1/crypto/keys/client1-{sessionId}.json

// ============================================
// After Restart
// ============================================

// Create new manager instance
const newManager = new DoubleRatchetManager('client1');

// Session state is automatically loaded when needed
const message = await newManager.encrypt(
  'client1',
  'server1',
  sessionId,  // Same sessionId
  'Message 3 after restart',
  false,
  'specific'
);

// Ratchet state continues from where it left off!
// Message numbers: 1, 2, 3 (not reset)
```

## Error Handling

Handle common error scenarios:

```typescript
async function sendSecureMessage(
  manager: DoubleRatchetManager,
  sessionId: string,
  text: string
): Promise<void> {
  try {
    const message = await manager.encrypt(
      'client1',
      'server1',
      sessionId,
      text,
      false,
      'specific'
    );

    // Send message over network...

  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('Session not found')) {
        // Session expired or never initialized
        console.error('Session not found. Please re-initialize.');

      } else if (error.message.includes('Missing own key pair')) {
        // Keypair not generated
        console.error('Keypair missing. Generate keys first.');

      } else if (error.message.includes('Session type mismatch')) {
        // Trying to use global session as specific or vice versa
        console.error('Wrong session type');

      } else {
        console.error('Encryption failed:', error.message);
      }
    }
  }
}

async function receiveSecureMessage(
  manager: DoubleRatchetManager,
  message: Message
): Promise<string | null> {
  try {
    return await manager.decrypt(message, true);

  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('Invalid signature')) {
        // Message tampered or wrong sender
        console.error('Message authentication failed');
        return null;

      } else if (error.message.includes('Message too old')) {
        // Replay attack or clock skew
        console.error('Message timestamp invalid');
        return null;

      } else if (error.message.includes('Too many skipped messages')) {
        // DoS attack or severe packet loss
        console.error('Message gap too large');
        return null;

      } else if (error.message.includes('Decryption failed')) {
        // Wrong key or corrupted ciphertext
        console.error('Decryption error');
        return null;

      } else {
        console.error('Unknown error:', error.message);
        return null;
      }
    }
    return null;
  }
}
```

## Next Steps

- See [API Reference](./api-reference.md) for detailed method documentation
- See [Crypto Architecture](./crypto-architecture.md) for security analysis
- See [WebSocket Integration](./websocket-integration.md) for production deployment
