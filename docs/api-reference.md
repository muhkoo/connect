# API Reference

Complete API documentation for the Connect SDK.

## Table of Contents

1. [KeyStore](#keystore)
2. [DoubleRatchetManager](#doubleratchetmanager)
3. [DoubleRatchet](#doubleratchet)
4. [Authenticator](#authenticator)
5. [ZeroKnowledge](#zeroknowledge)
6. [Types](#types)

---

## KeyStore

Singleton class for managing ECDH and ECDSA keypairs.

### `getInstance(): KeyStore`

Get singleton instance.

```typescript
const keyStore = KeyStore.getInstance();
```

### `async generateOwnKeyPair(id: string): Promise<KeyPair>`

Generate new ECDH and ECDSA keypair for given ID.

**Parameters:**
- `id`: Unique identifier (e.g., 'client1', 'tenant-a-server')

**Returns:** ECDH KeyPair

**Throws:** Error if keypair already exists for this ID

```typescript
const keyPair = await keyStore.generateOwnKeyPair('client1');
// Generates both ECDH keypair (for encryption) and ECDSA keypair (for signing)
```

### `async storeRemotePublicKeys(id: string, ecdhPublicKey: CryptoKey, ecdsaPublicKey: CryptoKey): Promise<void>`

Store remote party's public keys (without private keys).

**Parameters:**
- `id`: Remote party identifier
- `ecdhPublicKey`: Remote ECDH public key
- `ecdsaPublicKey`: Remote ECDSA public key

```typescript
await keyStore.storeRemotePublicKeys(
  'server1',
  serverEcdhPub,
  serverEcdsaPub
);
```

### `getKeyPair(id: string): KeyPair | null`

Get ECDH keypair for given ID.

**Returns:** `{ privateKey: CryptoKey | null, publicKey: CryptoKey }` or `null`

```typescript
const keyPair = keyStore.getKeyPair('client1');
if (keyPair?.privateKey) {
  // We have the private key (local keypair)
} else {
  // Public key only (remote keypair)
}
```

### `getAuthKeyPair(id: string): AuthKeyPair | null`

Get ECDSA keypair for given ID.

**Returns:** `{ privateKey: CryptoKey | null, publicKey: CryptoKey }` or `null`

### `async dehydrateKeyPair(id: string): Promise<DehydratedKeys>`

Serialize keypair to base58-encoded strings.

**Returns:**
```typescript
{
  ecdhPub: string;    // base58(JWK)
  ecdhPriv: string;   // base58(JWK) or empty
  ecdsaPub: string;   // base58(JWK)
  ecdsaPriv: string;  // base58(JWK) or empty
}
```

```typescript
const dehydrated = await keyStore.dehydrateKeyPair('client1');
// Send dehydrated.ecdhPub to server for key exchange
```

### `async compressDehydratedKeys(id: string): Promise<string>`

Compress and serialize all keys to single base64 string.

**Returns:** base64(gzip(JSON)) - ~1.5KB string containing all 4 keys

```typescript
const masterKey = await keyStore.compressDehydratedKeys('client1');
// Store masterKey securely, can restore full keypair from it
```

### `async hydrateKeyPair(id: string, dehydrated: DehydratedKeys): Promise<void>`

Restore keypair from dehydrated keys.

```typescript
await keyStore.hydrateKeyPair('client1', dehydratedKeys);
```

### `async hydrateFromCompressed(id: string, compressed: string): Promise<void>`

Restore keypair from compressed master key.

```typescript
await keyStore.hydrateFromCompressed('client1', masterKey);
```

---

## DoubleRatchetManager

Manages encrypted sessions using the Double Ratchet protocol.

### `constructor(id: string)`

Create new session manager.

**Parameters:**
- `id`: Unique identifier for this manager (e.g., 'client1', 'server1')

```typescript
const manager = new DoubleRatchetManager('client1');
```

### `async registerZK(clientId: string, secret: Field, salt: Field, ecdsaPub: CryptoKey): Promise<void>`

Register client with zero-knowledge proof.

**Parameters:**
- `clientId`: Client identifier
- `secret`: Random secret (private, used in ZK proof)
- `salt`: Random salt (private, used in ZK proof)
- `ecdsaPub`: Client's ECDSA public key

**Note:** Server-side only. In production, server should NOT know `secret` or `salt`.

```typescript
const secret = Field.random();
const salt = Field.random();

await serverManager.registerZK(
  'client1',
  secret,
  salt,
  clientEcdsaPublicKey
);
```

### `async performHandshake(senderId, recipientId, zkProof, publicInput, clientPublicKey, clientAuthPublicKey, authToken): Promise<void>`

Perform ZK proof verification and establish trust.

**Parameters:**
- `senderId`: Client ID
- `recipientId`: Server ID
- `zkProof`: ZK proof from PreimagePoK
- `publicInput`: AuthPublicInput containing commitment, nonce, ecdsaPubHash
- `clientPublicKey`: Client's ECDH public key
- `clientAuthPublicKey`: Client's ECDSA public key
- `authToken`: Client-generated auth token

**Throws:** Error if ZK proof invalid or auth token verification fails

```typescript
await serverManager.performHandshake(
  'client1',
  'server1',
  zkProof,
  publicInput,
  clientEcdhPub,
  clientEcdsaPub,
  authToken
);
```

### `async initializeSession(senderId, recipientId, isClient, sessionType, sessionId?, ...): Promise<string>`

Initialize encrypted session.

**Parameters:**
- `senderId`: Sender identifier
- `recipientId`: Recipient identifier
- `isClient`: `true` for client, `false` for server
- `sessionType`: `'specific'` (1:1) or `'global'` (broadcast)
- `sessionId?`: Optional session ID (must match on both sides)

**Returns:** Session ID

```typescript
// Client
const sessionId = await clientManager.initializeSession(
  'client1',
  'server1',
  true,       // isClient
  'specific'
);

// Server (must use same sessionId)
await serverManager.initializeSession(
  'server1',
  'client1',
  false,      // isClient
  'specific',
  sessionId   // MUST match client's sessionId
);
```

### `async encrypt(senderId, recipientId, sessionId, plaintext, newDhKey, sessionType): Promise<Message>`

Encrypt plaintext message.

**Parameters:**
- `senderId`: Sender ID
- `recipientId`: Recipient ID
- `sessionId`: Session ID from initializeSession
- `plaintext`: Message to encrypt
- `newDhKey`: Force DH ratchet (optional, default: false)
- `sessionType`: `'specific'` or `'global'`

**Returns:** Encrypted Message

```typescript
const message = await manager.encrypt(
  'client1',
  'server1',
  sessionId,
  'Hello, Server!',
  false,      // Don't force DH ratchet
  'specific'
);
```

### `async decrypt(message: Message, isClient: boolean): Promise<string>`

Decrypt message.

**Parameters:**
- `message`: Encrypted Message
- `isClient`: `true` for client, `false` for server

**Returns:** Decrypted plaintext

**Throws:** Error if signature invalid, timestamp expired, or decryption fails

```typescript
const plaintext = await manager.decrypt(message, true);
```

### `async getSessionSharedSecret(sessionId: string): Promise<Buffer | null>`

Get shared secret from session for file encryption.

**Parameters:**
- `sessionId`: Session ID

**Returns:** 32-byte shared secret (root key) or `null` if session not found

```typescript
const sharedSecret = await manager.getSessionSharedSecret(sessionId);

// Convert to AES key for file encryption
const fileKey = await crypto.subtle.importKey(
  'raw',
  sharedSecret!,
  'AES-GCM',
  false,
  ['encrypt', 'decrypt']
);
```

### `async addTrustedServer(serverId: string, publicKey: CryptoKey): Promise<void>`

Add trusted server's ECDSA public key (for broadcast mode).

**Parameters:**
- `serverId`: Server identifier
- `publicKey`: Server's ECDSA public key

```typescript
await clientManager.addTrustedServer('global-server', serverEcdsaPub);
```

---

## DoubleRatchet

Low-level ratchet implementation. **Use DoubleRatchetManager instead.**

### `constructor(senderId: string, recipientId: string, sessionType: 'global' | 'specific', isClient: boolean)`

Create ratchet instance.

### `async initializeSession(isClient: boolean): Promise<void>`

Initialize ratchet state.

### `async encrypt(plaintext, newDhKey, senderId, recipientId, sessionId, sessionType): Promise<Message>`

Encrypt message.

### `async decrypt(message: Message, isClient: boolean): Promise<string>`

Decrypt message.

### `getState(): RatchetState`

Get current ratchet state (for persistence).

### `setState(state: RatchetState): void`

Restore ratchet state (from persistence).

---

## Authenticator

Handles zero-knowledge authentication.

### `async initializeZK(): Promise<void>`

Compile ZK circuit. **Must call before using ZK proofs.**

**Note:** Compilation takes 3-5 seconds. Call once at startup.

```typescript
const authenticator = new Authenticator();
await authenticator.initializeZK();
```

### `addTrustedServer(serverId: string, publicKey: CryptoKey): void`

Add trusted server's ECDSA public key.

```typescript
authenticator.addTrustedServer('server1', serverEcdsaPub);
```

### `async generateAuthToken(peerId: string, privateKey: CryptoKey): Promise<AuthToken>`

Generate signed authentication token.

**Parameters:**
- `peerId`: Peer identifier
- `privateKey`: ECDSA private key

**Returns:** `{ peerId, timestamp, signature }`

```typescript
const token = await authenticator.generateAuthToken(
  'client1',
  clientEcdsaPrivateKey
);
```

### `async verifyAuthToken(token: AuthToken, publicKey: CryptoKey): Promise<boolean>`

Verify authentication token.

**Parameters:**
- `token`: Auth token to verify
- `publicKey`: ECDSA public key of claimed peer

**Returns:** `true` if valid, `false` if expired or invalid signature

```typescript
const isValid = await authenticator.verifyAuthToken(token, clientEcdsaPub);
```

### `async verifyZKProof(proof, publicInput, storedCommitment, ecdsaPub): Promise<boolean>`

Verify zero-knowledge proof.

**Parameters:**
- `proof`: ZK proof from PreimagePoK
- `publicInput`: AuthPublicInput
- `storedCommitment`: Commitment stored during registration
- `ecdsaPub`: Client's ECDSA public key

**Returns:** `true` if proof valid and matches commitment

```typescript
const isValid = await authenticator.verifyZKProof(
  proof,
  publicInput,
  storedCommitment,
  clientEcdsaPub
);
```

---

## ZeroKnowledge

o1js ZK circuits for privacy-preserving authentication.

### `PreimagePoK`

ZK program for proving knowledge of (secret, salt) that hash to commitment.

#### `static async compile(): Promise<{ verificationKey: { data: string, hash: Field } }>`

Compile circuit. **Must call once before generating proofs.**

```typescript
const { verificationKey } = await PreimagePoK.compile();
```

#### `static async proveKnowledge(publicInput, secret, salt, ecdsaPub): Promise<{ proof: Proof }>`

Generate ZK proof.

**Parameters:**
- `publicInput`: AuthPublicInput
- `secret`: Secret Field (private input)
- `salt`: Salt Field (private input)
- `ecdsaPub`: ECDSA public key Field (private input)

**Returns:** `{ proof: Proof }`

```typescript
const { proof } = await PreimagePoK.proveKnowledge(
  publicInput,
  secret,
  salt,
  ecdsaPubField
);
```

### `AuthPublicInput`

Struct for ZK public inputs.

**Fields:**
- `commitment: Field` - Poseidon(secret, salt, Poseidon(ecdsaPub))
- `nonce: Field` - Fresh random nonce
- `ecdsaPubHash: Field` - Poseidon(ecdsaPub)

```typescript
const publicInput = new AuthPublicInput({
  commitment: Poseidon.hash([secret, salt, ecdsaPubHash]),
  nonce: Field.random(),
  ecdsaPubHash: Poseidon.hash([ecdsaPubField])
});
```

### Utility Functions

#### `encodeToHex(field: Field): string`

Convert Field to hex string.

```typescript
const hex = encodeToHex(field); // "0x1234..."
```

#### `decodeFromHex(hexStr: string): Field`

Convert hex string to Field.

```typescript
const field = decodeFromHex("0x1234abcd");
```

---

## Types

### `KeyPair`

```typescript
interface KeyPair {
  privateKey: CryptoKey | null; // null for remote keys
  publicKey: CryptoKey;
}
```

### `AuthKeyPair`

```typescript
interface AuthKeyPair {
  privateKey: CryptoKey | null; // null for remote keys
  publicKey: CryptoKey;
}
```

### `DehydratedKeys`

```typescript
interface DehydratedKeys {
  ecdhPub: string;    // base58(JWK)
  ecdhPriv: string;   // base58(JWK) or empty
  ecdsaPub: string;   // base58(JWK)
  ecdsaPriv: string;  // base58(JWK) or empty
}
```

### `Message`

```typescript
interface Message {
  header: MessageHeader;
  ciphertext: string; // hex-encoded
  nonce: string;      // hex-encoded 12 bytes
}
```

### `MessageHeader`

```typescript
interface MessageHeader {
  dhPub: string;           // base58(JWK) sender's ECDH pub
  prevChainLength: number; // for DH ratchet
  messageNumber: number;   // sequence number
  sessionId: string;
  sessionType: 'global' | 'specific';
  senderId: string;
  recipientId: string;
  timestamp: number;       // Unix timestamp (ms)
  signature: string;       // hex-encoded ECDSA signature
}
```

### `RatchetState`

```typescript
interface RatchetState {
  clientDhPriv: CryptoKey | null;
  clientDhPub: CryptoKey;
  serverDhPriv: CryptoKey | null;
  serverDhPub: CryptoKey;
  rootKey: Buffer | null;
  sendChainKey: Buffer | null;
  recvChainKey: Buffer | null;
  sendCount: number;
  recvCount: number;
  prevChainLength: number;
  currentSkippedKeys: Map<number, Buffer>;
  oldSkippedMessageKeys: Map<string, {
    skips: Map<number, Buffer>;
    created: number;
  }>;
}
```

### `AuthToken`

```typescript
interface AuthToken {
  peerId: string;
  timestamp: number;
  signature: string; // hex-encoded ECDSA signature
}
```

---

## Constants

### DH Ratchet Window

```typescript
const WINDOW_SIZE = 100; // DH ratchet every 100 messages
```

### Max Skipped Messages

```typescript
const MAX_SKIP = 3000; // Reject messages with gap > 3000
```

### Old Key Retention

```typescript
const OVERLAP_PERIOD = 30000; // 30 seconds
```

### Timestamp Validation

```typescript
const MAX_AGE = 5 * 60 * 1000; // 5 minutes
```

---

## Error Messages

| Error | Meaning | Solution |
|-------|---------|----------|
| `Missing own key pair for sender` | Keypair not generated | Call `keyStore.generateOwnKeyPair()` |
| `Missing public key for recipient` | Remote pub key not stored | Call `keyStore.storeRemotePublicKeys()` |
| `Session not found` | Session ID invalid or expired | Re-initialize session |
| `Session type mismatch` | Using global session as specific | Check sessionType parameter |
| `Invalid signature` | Message tampered or wrong sender | Reject message |
| `Message too old` | Timestamp outside 5-min window | Check clocks, reject message |
| `Too many skipped messages` | Gap > 3000 messages | Possible DoS, reinitialize session |
| `Decryption failed` | Wrong key or corrupted data | Check session, reject message |
| `ZK handshake failed` | Invalid ZK proof | Authentication failed |
| `Token verification failed` | Invalid auth token | Re-authenticate |

---

## Best Practices

### Key Management

✅ **DO:**
- Generate new keypairs for each user/tenant
- Store dehydrated keys securely (encrypted at rest)
- Use compressed master keys for backup
- Rotate keys periodically (re-register)

❌ **DON'T:**
- Reuse keypairs across tenants
- Store private keys in plaintext
- Share KeyStore instances across processes

### Session Management

✅ **DO:**
- Initialize sessions once, reuse for multiple messages
- Persist session state for recovery
- Use same sessionId on both client and server
- Handle out-of-order messages gracefully

❌ **DON'T:**
- Create new session for every message
- Delete session state prematurely
- Mix 'specific' and 'global' session types

### Error Handling

✅ **DO:**
- Validate all messages (signature, timestamp)
- Reject messages with invalid signatures
- Log security events (failed auth, old messages)
- Implement retry logic for network errors

❌ **DON'T:**
- Ignore signature verification failures
- Accept messages with old timestamps
- Expose cryptographic errors to clients

### Performance

✅ **DO:**
- Compile ZK circuits once at startup
- Cache KeyStore instances
- Batch message encryption when possible
- Use broadcast mode for fan-out

❌ **DON'T:**
- Recompile ZK circuits for each proof
- Create new KeyStore instances
- Encrypt messages one-by-one in loops
- Use specific sessions for broadcasts

---

## Next Steps

- See [Examples](./examples.md) for complete usage examples
- See [Crypto Architecture](./crypto-architecture.md) for security details
- See [WebSocket Integration](./websocket-integration.md) for production deployment
