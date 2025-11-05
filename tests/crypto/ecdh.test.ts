/**
 * ECDH (Elliptic Curve Diffie-Hellman) Tests
 * Tests for key generation, shared secret derivation, and key serialization
 */

import { describe, it, expect } from 'vitest';
import {
  generateEphemeralKeypair,
  deriveSharedSecret,
  deriveEncryptionKey,
  dehydratePublicKey,
  hydratePublicKey,
  importPublicKey,
  generateConnectionId,
} from '../../src/crypto/ecdh';
import type { PublicKeyJWK, Keypair } from '../../src/types';

describe('ECDH Key Generation', () => {
  it('should generate a P-256 keypair', async () => {
    const keypair = await generateEphemeralKeypair('P-256');

    expect(keypair).toBeDefined();
    expect(keypair.publicKey).toBeDefined();
    expect(keypair.privateKey).toBeDefined();
    expect(keypair.publicKey.kty).toBe('EC');
    expect(keypair.publicKey.crv).toBe('P-256');
    expect(keypair.publicKey.x).toBeDefined();
    expect(keypair.publicKey.y).toBeDefined();
  });

  it('should generate a P-384 keypair', async () => {
    const keypair = await generateEphemeralKeypair('P-384');

    expect(keypair).toBeDefined();
    expect(keypair.publicKey).toBeDefined();
    expect(keypair.privateKey).toBeDefined();
    expect(keypair.publicKey.kty).toBe('EC');
    expect(keypair.publicKey.crv).toBe('P-384');
  });

  it('should default to P-256 when no curve specified', async () => {
    const keypair = await generateEphemeralKeypair();

    expect(keypair.publicKey.crv).toBe('P-256');
  });

  it('should generate unique keypairs', async () => {
    const keypair1 = await generateEphemeralKeypair('P-256');
    const keypair2 = await generateEphemeralKeypair('P-256');

    expect(keypair1.publicKey.x).not.toBe(keypair2.publicKey.x);
    expect(keypair1.publicKey.y).not.toBe(keypair2.publicKey.y);
  });
});

describe('ECDH Shared Secret Derivation', () => {
  it('should derive the same shared secret from both sides (P-256)', async () => {
    // Alice generates keypair
    const aliceKeypair = await generateEphemeralKeypair('P-256');

    // Bob generates keypair
    const bobKeypair = await generateEphemeralKeypair('P-256');

    // Alice derives shared secret using Bob's public key
    const aliceSharedSecret = await deriveSharedSecret(
      aliceKeypair.privateKey,
      bobKeypair.publicKey
    );

    // Bob derives shared secret using Alice's public key
    const bobSharedSecret = await deriveSharedSecret(
      bobKeypair.privateKey,
      aliceKeypair.publicKey
    );

    // Both should derive the same shared secret
    expect(aliceSharedSecret).toBe(bobSharedSecret);
    expect(aliceSharedSecret).toBeDefined();
    expect(aliceSharedSecret.length).toBeGreaterThan(0);
  });

  it('should derive the same shared secret from both sides (P-384)', async () => {
    const aliceKeypair = await generateEphemeralKeypair('P-384');
    const bobKeypair = await generateEphemeralKeypair('P-384');

    const aliceSharedSecret = await deriveSharedSecret(
      aliceKeypair.privateKey,
      bobKeypair.publicKey
    );
    const bobSharedSecret = await deriveSharedSecret(
      bobKeypair.privateKey,
      aliceKeypair.publicKey
    );

    expect(aliceSharedSecret).toBe(bobSharedSecret);
  });

  it('should derive shared secret from dehydrated public key', async () => {
    const aliceKeypair = await generateEphemeralKeypair('P-256');
    const bobKeypair = await generateEphemeralKeypair('P-256');

    // Dehydrate Bob's public key
    const bobPublicKeyDehydrated = dehydratePublicKey(bobKeypair.publicKey);

    // Alice derives shared secret using dehydrated key
    const aliceSharedSecret = await deriveSharedSecret(
      aliceKeypair.privateKey,
      bobPublicKeyDehydrated
    );

    // Bob derives shared secret normally
    const bobSharedSecret = await deriveSharedSecret(
      bobKeypair.privateKey,
      aliceKeypair.publicKey
    );

    expect(aliceSharedSecret).toBeDefined();
    expect(bobSharedSecret).toBeDefined();
  });

  it('should produce different shared secrets for different key pairs', async () => {
    const alice1 = await generateEphemeralKeypair('P-256');
    const alice2 = await generateEphemeralKeypair('P-256');
    const bob = await generateEphemeralKeypair('P-256');

    const secret1 = await deriveSharedSecret(alice1.privateKey, bob.publicKey);
    const secret2 = await deriveSharedSecret(alice2.privateKey, bob.publicKey);

    expect(secret1).not.toBe(secret2);
  });
});

describe('ECDH Encryption Key Derivation', () => {
  it('should derive encryption key from ECDH', async () => {
    const aliceKeypair = await generateEphemeralKeypair('P-256');
    const bobKeypair = await generateEphemeralKeypair('P-256');

    const aliceEncryptionKey = await deriveEncryptionKey(
      aliceKeypair.privateKey,
      bobKeypair.publicKey
    );

    expect(aliceEncryptionKey).toBeDefined();
    expect(aliceEncryptionKey.type).toBe('secret');
    expect(aliceEncryptionKey.algorithm).toMatchObject({
      name: 'AES-GCM',
      length: 256,
    });
  });

  it('should derive encryption key from dehydrated public key', async () => {
    const aliceKeypair = await generateEphemeralKeypair('P-256');
    const bobKeypair = await generateEphemeralKeypair('P-256');

    const bobPublicKeyDehydrated = dehydratePublicKey(bobKeypair.publicKey);

    const encryptionKey = await deriveEncryptionKey(
      aliceKeypair.privateKey,
      bobPublicKeyDehydrated
    );

    expect(encryptionKey).toBeDefined();
    expect(encryptionKey.type).toBe('secret');
  });
});

describe('Public Key Dehydration/Hydration', () => {
  it('should dehydrate and hydrate public key correctly', async () => {
    const keypair = await generateEphemeralKeypair('P-256');
    const originalPublicKey = keypair.publicKey;

    // Dehydrate
    const dehydrated = dehydratePublicKey(originalPublicKey);

    expect(dehydrated).toBeDefined();
    expect(typeof dehydrated).toBe('string');
    expect(dehydrated.length).toBeGreaterThan(0);

    // Hydrate
    const hydrated = hydratePublicKey(dehydrated);

    expect(hydrated).toMatchObject(originalPublicKey);
    expect(hydrated.kty).toBe(originalPublicKey.kty);
    expect(hydrated.crv).toBe(originalPublicKey.crv);
    expect(hydrated.x).toBe(originalPublicKey.x);
    expect(hydrated.y).toBe(originalPublicKey.y);
  });

  it('should produce base58-encoded strings', async () => {
    const keypair = await generateEphemeralKeypair('P-256');
    const dehydrated = dehydratePublicKey(keypair.publicKey);

    // Base58 alphabet: 123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz
    const base58Regex = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/;
    expect(base58Regex.test(dehydrated)).toBe(true);
  });

  it('should handle P-384 keys', async () => {
    const keypair = await generateEphemeralKeypair('P-384');
    const dehydrated = dehydratePublicKey(keypair.publicKey);
    const hydrated = hydratePublicKey(dehydrated);

    expect(hydrated.crv).toBe('P-384');
    expect(hydrated).toMatchObject(keypair.publicKey);
  });
});

describe('Public Key Import', () => {
  it('should import public key from JWK', async () => {
    const keypair = await generateEphemeralKeypair('P-256');
    const imported = await importPublicKey(keypair.publicKey, 'P-256');

    expect(imported).toBeDefined();
    expect(imported.type).toBe('public');
  });

  it('should import public key from dehydrated string', async () => {
    const keypair = await generateEphemeralKeypair('P-256');
    const dehydrated = dehydratePublicKey(keypair.publicKey);
    const imported = await importPublicKey(dehydrated, 'P-256');

    expect(imported).toBeDefined();
    expect(imported.type).toBe('public');
  });

  it('should work with derived shared secrets', async () => {
    const aliceKeypair = await generateEphemeralKeypair('P-256');
    const bobKeypair = await generateEphemeralKeypair('P-256');

    // Import Bob's public key from JWK
    const bobPublicKeyImported = await importPublicKey(bobKeypair.publicKey, 'P-256');

    // Derive shared secret using imported key
    const sharedSecret = await deriveSharedSecret(
      aliceKeypair.privateKey,
      bobPublicKeyImported
    );

    expect(sharedSecret).toBeDefined();
    expect(sharedSecret.length).toBeGreaterThan(0);
  });
});

describe('Connection ID Generation', () => {
  it('should generate a valid UUID v4', () => {
    const connectionId = generateConnectionId();

    expect(connectionId).toBeDefined();
    expect(typeof connectionId).toBe('string');

    // UUID v4 regex
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(uuidRegex.test(connectionId)).toBe(true);
  });

  it('should generate unique IDs', () => {
    const id1 = generateConnectionId();
    const id2 = generateConnectionId();
    const id3 = generateConnectionId();

    expect(id1).not.toBe(id2);
    expect(id2).not.toBe(id3);
    expect(id1).not.toBe(id3);
  });
});

describe('End-to-End ECDH Workflow', () => {
  it('should complete full ECDH handshake workflow', async () => {
    // 1. Client generates ephemeral keypair
    const clientKeypair = await generateEphemeralKeypair('P-256');
    const clientPublicKeyDehydrated = dehydratePublicKey(clientKeypair.publicKey);

    // 2. Server receives dehydrated client public key and generates its own keypair
    const serverKeypair = await generateEphemeralKeypair('P-256');
    const serverPublicKeyDehydrated = dehydratePublicKey(serverKeypair.publicKey);

    // 3. Server derives shared secret
    const clientPublicKeyHydrated = hydratePublicKey(clientPublicKeyDehydrated);
    const serverSharedSecret = await deriveSharedSecret(
      serverKeypair.privateKey,
      clientPublicKeyHydrated
    );

    // 4. Client receives server's dehydrated public key and derives shared secret
    const serverPublicKeyHydrated = hydratePublicKey(serverPublicKeyDehydrated);
    const clientSharedSecret = await deriveSharedSecret(
      clientKeypair.privateKey,
      serverPublicKeyHydrated
    );

    // 5. Verify both parties have the same shared secret
    expect(clientSharedSecret).toBe(serverSharedSecret);

    // 6. Both can now use this shared secret for encryption/decryption
    expect(clientSharedSecret).toBeDefined();
    expect(clientSharedSecret.length).toBeGreaterThan(0);
  });

  it('should work with different curves on compatible systems', async () => {
    // P-256 and P-384 cannot derive shared secrets with each other,
    // but each curve should work independently
    const alice256 = await generateEphemeralKeypair('P-256');
    const bob256 = await generateEphemeralKeypair('P-256');

    const alice384 = await generateEphemeralKeypair('P-384');
    const bob384 = await generateEphemeralKeypair('P-384');

    const secret256 = await deriveSharedSecret(alice256.privateKey, bob256.publicKey);
    const secret384 = await deriveSharedSecret(alice384.privateKey, bob384.publicKey);

    expect(secret256).toBeDefined();
    expect(secret384).toBeDefined();
    // Both curves use 256-bit derived secrets (standard for AES-256)
    // P-256 = 256 bits = 64 hex chars
    // P-384 also uses 256 bits = 64 hex chars (for AES-256 compatibility)
    expect(secret256.length).toBe(64);
    expect(secret384.length).toBe(64);
  });
});
