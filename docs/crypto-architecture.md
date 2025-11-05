# Cryptographic Architecture

This document provides an in-depth overview of the Connect SDK's cryptographic design.

## Table of Contents

1. [Overview](#overview)
2. [Double Ratchet Protocol](#double-ratchet-protocol)
3. [Key Management](#key-management)
4. [Zero-Knowledge Authentication](#zero-knowledge-authentication)
5. [Session Lifecycle](#session-lifecycle)
6. [Message Format](#message-format)
7. [File Encryption](#file-encryption)
8. [Security Analysis](#security-analysis)

## Overview

The Connect SDK implements a modified Signal Protocol with zero-knowledge authentication. The system provides:

- **End-to-end encryption** for all messages
- **Forward secrecy** (past messages safe if current key compromised)
- **Future secrecy** (future messages safe after rekeying)
- **Privacy-preserving authentication** (ZK proofs hide secrets)
- **Multi-tenant isolation** (tenant data cryptographically separated)

## Double Ratchet Protocol

### How It Works

The Double Ratchet has two components:

1. **Diffie-Hellman (DH) Ratchet**: Rotates ECDH keypairs periodically
2. **Symmetric Ratchet**: Derives unique message keys using HKDF

```
Initial Handshake:
  Client ECDH private + Server ECDH public → Shared Secret
  Shared Secret → HKDF → Root Key

Per Message:
  Root Key → HKDF → (Message Key, New Root Key)
  Message Key → AES-GCM encrypt → Ciphertext

Every 100 Messages (DH Ratchet):
  Generate new ECDH keypair
  New private + Remote public → New Shared Secret
  Old Root Key + New Shared Secret → HKDF → New Root Key
```

### Key Derivation

```typescript
// Initial session
sharedSecret = ECDH(clientPrivate, serverPublic)
rootKey = HKDF(sharedSecret, "DoubleRatchetInit", 32 bytes)

// Per message
(messageKey, newRootKey) = HKDF(rootKey, "DoubleRatchetMsg", 64 bytes)

// DH ratchet
newSharedSecret = ECDH(newPrivate, remotePublic)
keys = HKDF(rootKey || newSharedSecret, "DoubleRatchetDH", 64 bytes)
newRootKey = keys[0:32]
newChainKey = keys[32:64]
```

### Ratchet State

```typescript
interface RatchetState {
  // ECDH keys
  clientDhPriv: CryptoKey | null;
  clientDhPub: CryptoKey;
  serverDhPriv: CryptoKey | null;
  serverDhPub: CryptoKey;

  // Chain keys
  rootKey: Buffer | null;
  sendChainKey: Buffer | null;
  recvChainKey: Buffer | null;

  // Message counters
  sendCount: number;
  recvCount: number;
  prevChainLength: number;

  // Out-of-order handling
  currentSkippedKeys: Map<number, Buffer>;
  oldSkippedMessageKeys: Map<string, { skips: Map<number, Buffer>; created: number }>;
}
```

### Out-of-Order Message Handling

When messages arrive out of order:

1. **Skip ahead**: Derive and store keys for skipped messages
2. **Old chain**: Keep keys from previous DH ratchet for 30 seconds
3. **Max skip**: Reject if gap > 3000 messages (DoS protection)

```typescript
// Example: Receive message #5 before #3 and #4
Receive message #5:
  - Derive and store keys for #3, #4
  - Decrypt #5 with its key

Later receive message #3:
  - Use stored key for #3
  - Delete stored key after use
```

## Key Management

### KeyStore

Central singleton for key storage:

```typescript
class KeyStore {
  private keys: Map<string, KeyPair>; // ECDH keys
  private authKeys: Map<string, AuthKeyPair>; // ECDSA keys

  // Generate new keypair
  async generateOwnKeyPair(id: string): Promise<KeyPair>

  // Store remote public keys only
  async storeRemotePublicKeys(id: string, ecdhPub: CryptoKey, ecdsaPub: CryptoKey)

  // Serialize for transport/storage
  async dehydrateKeyPair(id: string): Promise<DehydratedKeys>

  // Compressed serialization
  async compressDehydratedKeys(id: string): Promise<string> // base64(gzip(JSON))

  // Deserialize
  async hydrateKeyPair(id: string, keys: DehydratedKeys)
  async hydrateFromCompressed(id: string, compressed: string)
}
```

### Key Serialization

Keys are serialized for transport:

1. **Export** to JWK format
2. **Stringify** JSON
3. **Encode** with base58 (for public keys) or base64 (for compressed)
4. **Compress** with gzip (optional, for "master keys")

```typescript
// Example: Compressed master key
const compressed = await keyStore.compressDehydratedKeys('client1');
// Result: ~1.5KB base64 string containing all 4 keys (ECDH pub/priv, ECDSA pub/priv)

// Later, restore from compressed
await keyStore.hydrateFromCompressed('client1', compressed);
```

### Multi-Tenant Isolation

Each tenant uses a different `id` in KeyStore:

```typescript
// Tenant A - Server
await keyStore.generateOwnKeyPair('tenant-a-server');

// Tenant A - Client 1
await keyStore.generateOwnKeyPair('tenant-a-client1');

// Tenant B - Server (completely isolated from Tenant A)
await keyStore.generateOwnKeyPair('tenant-b-server');
```

Keys are cryptographically isolated. Cross-tenant decryption is impossible without key exchange.

## Zero-Knowledge Authentication

### Registration

Client registers with server without revealing secret:

```typescript
// Client-side
const secret = Field.random();
const salt = Field.random();
const ecdsaPubHash = Poseidon.hash([ecdsaPublicKeyField]);
const commitment = Poseidon.hash([secret, salt, ecdsaPubHash]);

// Send commitment to server (server stores it)
await server.register(clientId, commitment);
```

### Handshake

Client proves knowledge of secret during handshake:

```typescript
// Client generates proof
const nonce = Field.random();
const publicInput = new AuthPublicInput({
  commitment,
  nonce,
  ecdsaPubHash
});

const { proof } = await PreimagePoK.proveKnowledge(
  publicInput,
  secret,      // private
  salt,        // private
  ecdsaPubField // private
);

// Send proof + publicInput to server

// Server verifies
const isValid = await authenticator.verifyZKProof(
  proof,
  publicInput,
  storedCommitment,
  clientEcdsaPublicKey
);
```

### Security Properties

- **Server never sees**: secret, salt, or raw ECDSA key
- **ZK proof verifies**: Client knows (secret, salt) that hash to commitment
- **Nonce binding**: Each proof is fresh (prevents replay)
- **Public key binding**: Proof cryptographically tied to client's ECDSA key

## Session Lifecycle

### 1. Key Generation

```typescript
const keyStore = KeyStore.getInstance();

// Client generates its keypair
await keyStore.generateOwnKeyPair('client1');

// Server generates its keypair
await keyStore.generateOwnKeyPair('server1');
```

### 2. Zero-Knowledge Registration

```typescript
// Server-side
const serverManager = new DoubleRatchetManager('server1');
await serverManager.registerZK(
  'client1',
  secret,
  salt,
  clientAuthPublicKey
);
```

### 3. Handshake

```typescript
// Client generates auth token
const authToken = await clientManager.authenticator.generateAuthToken(
  'client1',
  clientAuthPrivateKey
);

// Server performs handshake (verifies ZK proof + auth token)
await serverManager.performHandshake(
  'client1',
  'server1',
  zkProof,
  publicInput,
  clientEcdhPublicKey,
  clientEcdsaPublicKey,
  authToken
);
```

### 4. Session Initialization

```typescript
// Client initializes session
const sessionId = await clientManager.initializeSession(
  'client1',
  'server1',
  true,  // isClient
  'specific'
);

// Server initializes matching session
await serverManager.initializeSession(
  'server1',
  'client1',
  false, // isClient
  'specific',
  sessionId // same sessionId
);
```

### 5. Encrypted Communication

```typescript
// Client sends message
const message = await clientManager.encrypt(
  'client1',
  'server1',
  sessionId,
  'Hello, Server!',
  false,
  'specific'
);

// Server decrypts
const plaintext = await serverManager.decrypt(message, false);
// plaintext === "Hello, Server!"
```

### 6. Session Persistence

Sessions are automatically persisted to disk:

```typescript
// State saved after each encrypt/decrypt
await manager.saveState(sessionId, ratchetState);

// Automatically loaded when needed
const state = await manager.loadState(sessionId);
```

## Message Format

### Message Structure

```typescript
interface Message {
  header: MessageHeader;
  ciphertext: string; // hex-encoded AES-GCM ciphertext + tag
  nonce: string;      // hex-encoded 12-byte IV
}

interface MessageHeader {
  dhPub: string;           // base58-encoded sender's ECDH public key
  prevChainLength: number; // messages in previous chain (for DH ratchet)
  messageNumber: number;   // sequence number in current chain
  sessionId: string;
  sessionType: 'global' | 'specific';
  senderId: string;
  recipientId: string;
  timestamp: number;       // Unix timestamp (ms)
  signature: string;       // hex-encoded ECDSA signature
}
```

### Signature

The signature covers the header (excluding signature field itself):

```typescript
const signaturePayload = JSON.stringify({
  dhPub: header.dhPub,
  prevChainLength: header.prevChainLength,
  messageNumber: header.messageNumber,
  sessionId: header.sessionId,
  sessionType: header.sessionType,
  senderId: header.senderId,
  recipientId: header.recipientId,
  timestamp: header.timestamp
});

const signature = await ECDSA.sign(senderPrivateKey, signaturePayload);
```

### Validation

Recipients verify:

1. **Signature**: ECDSA signature matches sender's public key
2. **Timestamp**: Within 5-minute window (prevents replay)
3. **Session**: sessionId matches expected session
4. **Sequence**: messageNumber is valid (not too many skips)

## File Encryption

### Using Session Shared Secret

```typescript
// Get shared secret from existing session
const sharedSecret = await manager.getSessionSharedSecret(sessionId);

// Convert to AES-GCM key
const fileKey = await crypto.subtle.importKey(
  'raw',
  sharedSecret!,
  'AES-GCM',
  false,
  ['encrypt', 'decrypt']
);

// Encrypt file
const fileData = await fs.readFile('document.pdf');
const encrypted = await crypto.subtle.encrypt(
  { name: 'AES-GCM', iv: crypto.randomBytes(12) },
  fileKey,
  fileData
);

// Recipient (with same session) can decrypt
const recipientSecret = await recipientManager.getSessionSharedSecret(sessionId);
const recipientKey = await crypto.subtle.importKey('raw', recipientSecret!, 'AES-GCM', false, ['decrypt']);
const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, recipientKey, encrypted);
```

### Why This Works

- Session establishes trust via ZK authentication
- Shared secret is 32 bytes (256-bit) derived from ECDH
- Same secret available to both parties in session
- No additional key exchange needed
- Access control via session membership

## Security Analysis

### Threat Model

**Assumptions:**
- TLS protects transport layer
- ZK circuit (o1js) is sound
- ECDH (P-384), ECDSA (P-384), AES-GCM are secure
- Server is honest-but-curious (doesn't actively tamper)

**Protected Against:**
- ✅ Passive eavesdropping
- ✅ Replay attacks (timestamp validation)
- ✅ Message tampering (ECDSA signatures)
- ✅ Key compromise (forward secrecy, future secrecy)
- ✅ Impersonation (ZK auth + signatures)
- ✅ Traffic analysis (messages look random)

**Not Protected Against:**
- ❌ Endpoint compromise (malware on client/server)
- ❌ Denial of Service (no rate limiting in crypto layer)
- ❌ Metadata leakage (sender/recipient IDs in clear)

### Forward Secrecy

Compromising message key K_n doesn't reveal K_{n-1} or K_{n+1}:

```
K_n = HKDF(rootKey_n, "DoubleRatchetMsg")
K_{n+1} = HKDF(rootKey_n, "DoubleRatchetMsg")  // different derive

// rootKey_n is one-way derived from rootKey_{n-1}
// Cannot reverse HKDF to get previous root keys
```

### Future Secrecy (Break-in Recovery)

DH ratchet every 100 messages creates new shared secret:

```
At message 100:
  newSharedSecret = ECDH(newPrivate, remotePublic)
  newRootKey = HKDF(oldRootKey || newSharedSecret)

// Attacker with oldRootKey cannot compute newRootKey
// because they don't know newPrivate or newSharedSecret
```

### Cryptographic Strength

| Primitive | Algorithm | Key Size | Security Level |
|-----------|-----------|----------|----------------|
| ECDH | P-384 | 384-bit | ~192-bit |
| ECDSA | P-384 | 384-bit | ~192-bit |
| AES-GCM | AES-256 | 256-bit | ~256-bit |
| HKDF | SHA-256 | 256-bit | ~256-bit |
| Poseidon | Poseidon | ~256-bit | ~128-bit (ZK) |

Overall security level: **~128-bit** (limited by ZK circuit security)

### Known Limitations

1. **Metadata visible**: Session IDs, sender/recipient IDs transmitted in clear
2. **Timestamp leakage**: Message timestamps visible (traffic analysis)
3. **No deniability**: ECDSA signatures prove authorship
4. **No post-quantum**: P-384 vulnerable to quantum computers
5. **State required**: Must persist ratchet state (not stateless)

### Future Improvements

- **Post-quantum**: Hybrid key exchange (P-384 + Kyber)
- **Padding**: Constant-size messages to hide length
- **Metadata protection**: Onion routing or mix networks
- **Deniability**: Replace ECDSA with deniable signatures
- **Hardware security**: Integrate with TPM/Secure Enclave

## References

- [Signal Protocol](https://signal.org/docs/)
- [Double Ratchet Algorithm](https://signal.org/docs/specifications/doubleratchet/)
- [o1js Documentation](https://docs.minaprotocol.com/zkapps/o1js)
- [RFC 5869 - HKDF](https://tools.ietf.org/html/rfc5869)
- [RFC 5116 - AES-GCM](https://tools.ietf.org/html/rfc5116)
