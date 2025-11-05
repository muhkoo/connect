/**
 * Encryption/Decryption Tests
 * Tests for AES-GCM encryption with ECDH-derived keys
 */

import { describe, it, expect } from 'vitest';
import {
  encrypt,
  decrypt,
  encryptWithKey,
  decryptWithKey,
} from '../../src/crypto/encryption';
import {
  generateEphemeralKeypair,
  deriveSharedSecret,
  deriveEncryptionKey,
} from '../../src/crypto/ecdh';

describe('String Encryption/Decryption with Shared Secret', () => {
  it('should encrypt and decrypt a simple message', async () => {
    // Setup ECDH
    const aliceKeypair = await generateEphemeralKeypair('P-256');
    const bobKeypair = await generateEphemeralKeypair('P-256');
    const sharedSecret = await deriveSharedSecret(aliceKeypair.privateKey, bobKeypair.publicKey);

    // Encrypt
    const plaintext = 'Hello, World!';
    const ciphertext = await encrypt(sharedSecret, plaintext);

    expect(ciphertext).toBeDefined();
    expect(typeof ciphertext).toBe('string');
    expect(ciphertext).not.toBe(plaintext);
    expect(ciphertext.length).toBeGreaterThan(0);

    // Decrypt
    const decrypted = await decrypt(sharedSecret, ciphertext);

    expect(decrypted).toBe(plaintext);
  });

  it('should encrypt and decrypt empty string', async () => {
    const aliceKeypair = await generateEphemeralKeypair('P-256');
    const bobKeypair = await generateEphemeralKeypair('P-256');
    const sharedSecret = await deriveSharedSecret(aliceKeypair.privateKey, bobKeypair.publicKey);

    const plaintext = '';
    const ciphertext = await encrypt(sharedSecret, plaintext);
    const decrypted = await decrypt(sharedSecret, ciphertext);

    expect(decrypted).toBe(plaintext);
  });

  it('should encrypt and decrypt long messages', async () => {
    const aliceKeypair = await generateEphemeralKeypair('P-256');
    const bobKeypair = await generateEphemeralKeypair('P-256');
    const sharedSecret = await deriveSharedSecret(aliceKeypair.privateKey, bobKeypair.publicKey);

    const plaintext = 'A'.repeat(10000); // 10KB message
    const ciphertext = await encrypt(sharedSecret, plaintext);
    const decrypted = await decrypt(sharedSecret, ciphertext);

    expect(decrypted).toBe(plaintext);
    expect(decrypted.length).toBe(10000);
  });

  it('should encrypt and decrypt unicode characters', async () => {
    const aliceKeypair = await generateEphemeralKeypair('P-256');
    const bobKeypair = await generateEphemeralKeypair('P-256');
    const sharedSecret = await deriveSharedSecret(aliceKeypair.privateKey, bobKeypair.publicKey);

    const plaintext = 'Hello 世界 🌍 Привет مرحبا';
    const ciphertext = await encrypt(sharedSecret, plaintext);
    const decrypted = await decrypt(sharedSecret, ciphertext);

    expect(decrypted).toBe(plaintext);
  });

  it('should produce different ciphertexts for same plaintext (nonce randomization)', async () => {
    const aliceKeypair = await generateEphemeralKeypair('P-256');
    const bobKeypair = await generateEphemeralKeypair('P-256');
    const sharedSecret = await deriveSharedSecret(aliceKeypair.privateKey, bobKeypair.publicKey);

    const plaintext = 'Same message';
    const ciphertext1 = await encrypt(sharedSecret, plaintext);
    const ciphertext2 = await encrypt(sharedSecret, plaintext);

    expect(ciphertext1).not.toBe(ciphertext2);

    // But both should decrypt to the same plaintext
    const decrypted1 = await decrypt(sharedSecret, ciphertext1);
    const decrypted2 = await decrypt(sharedSecret, ciphertext2);

    expect(decrypted1).toBe(plaintext);
    expect(decrypted2).toBe(plaintext);
  });

  it('should fail to decrypt with wrong shared secret', async () => {
    const aliceKeypair = await generateEphemeralKeypair('P-256');
    const bobKeypair = await generateEphemeralKeypair('P-256');
    const eveKeypair = await generateEphemeralKeypair('P-256');

    const correctSecret = await deriveSharedSecret(aliceKeypair.privateKey, bobKeypair.publicKey);
    const wrongSecret = await deriveSharedSecret(eveKeypair.privateKey, bobKeypair.publicKey);

    const plaintext = 'Secret message';
    const ciphertext = await encrypt(correctSecret, plaintext);

    // Attempting to decrypt with wrong secret should fail
    await expect(decrypt(wrongSecret, ciphertext)).rejects.toThrow();
  });

  it('should fail to decrypt corrupted ciphertext', async () => {
    const aliceKeypair = await generateEphemeralKeypair('P-256');
    const bobKeypair = await generateEphemeralKeypair('P-256');
    const sharedSecret = await deriveSharedSecret(aliceKeypair.privateKey, bobKeypair.publicKey);

    const plaintext = 'Test message';
    const ciphertext = await encrypt(sharedSecret, plaintext);

    // Corrupt the ciphertext by modifying a character
    const corrupted = ciphertext.slice(0, -5) + 'XXXXX';

    await expect(decrypt(sharedSecret, corrupted)).rejects.toThrow();
  });

  it('should produce base58-encoded ciphertext', async () => {
    const aliceKeypair = await generateEphemeralKeypair('P-256');
    const bobKeypair = await generateEphemeralKeypair('P-256');
    const sharedSecret = await deriveSharedSecret(aliceKeypair.privateKey, bobKeypair.publicKey);

    const plaintext = 'Test';
    const ciphertext = await encrypt(sharedSecret, plaintext);

    // Base58 alphabet
    const base58Regex = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/;
    expect(base58Regex.test(ciphertext)).toBe(true);
  });
});

describe('Encryption/Decryption with CryptoKey', () => {
  it('should encrypt and decrypt with derived encryption key', async () => {
    const aliceKeypair = await generateEphemeralKeypair('P-256');
    const bobKeypair = await generateEphemeralKeypair('P-256');

    const encryptionKey = await deriveEncryptionKey(
      aliceKeypair.privateKey,
      bobKeypair.publicKey
    );

    const plaintext = 'Encrypted with CryptoKey';
    const encrypted = await encryptWithKey(encryptionKey, plaintext);

    expect(encrypted).toBeDefined();
    expect(encrypted instanceof ArrayBuffer).toBe(true);
    expect(encrypted.byteLength).toBeGreaterThan(plaintext.length);

    const decrypted = await decryptWithKey(encryptionKey, encrypted);

    expect(decrypted).toBe(plaintext);
  });

  it('should encrypt and decrypt empty string with CryptoKey', async () => {
    const aliceKeypair = await generateEphemeralKeypair('P-256');
    const bobKeypair = await generateEphemeralKeypair('P-256');
    const encryptionKey = await deriveEncryptionKey(
      aliceKeypair.privateKey,
      bobKeypair.publicKey
    );

    const plaintext = '';
    const encrypted = await encryptWithKey(encryptionKey, plaintext);
    const decrypted = await decryptWithKey(encryptionKey, encrypted);

    expect(decrypted).toBe(plaintext);
  });

  it('should encrypt and decrypt unicode with CryptoKey', async () => {
    const aliceKeypair = await generateEphemeralKeypair('P-256');
    const bobKeypair = await generateEphemeralKeypair('P-256');
    const encryptionKey = await deriveEncryptionKey(
      aliceKeypair.privateKey,
      bobKeypair.publicKey
    );

    const plaintext = '🔐 Secure 日本語 данные';
    const encrypted = await encryptWithKey(encryptionKey, plaintext);
    const decrypted = await decryptWithKey(encryptionKey, encrypted);

    expect(decrypted).toBe(plaintext);
  });

  it('should fail to decrypt with wrong key', async () => {
    const aliceKeypair = await generateEphemeralKeypair('P-256');
    const bobKeypair = await generateEphemeralKeypair('P-256');
    const eveKeypair = await generateEphemeralKeypair('P-256');

    const correctKey = await deriveEncryptionKey(aliceKeypair.privateKey, bobKeypair.publicKey);
    const wrongKey = await deriveEncryptionKey(eveKeypair.privateKey, bobKeypair.publicKey);

    const plaintext = 'Secret';
    const encrypted = await encryptWithKey(correctKey, plaintext);

    await expect(decryptWithKey(wrongKey, encrypted)).rejects.toThrow();
  });

  it('should include IV in encrypted data', async () => {
    const aliceKeypair = await generateEphemeralKeypair('P-256');
    const bobKeypair = await generateEphemeralKeypair('P-256');
    const encryptionKey = await deriveEncryptionKey(
      aliceKeypair.privateKey,
      bobKeypair.publicKey
    );

    const plaintext = 'Test';
    const encrypted = await encryptWithKey(encryptionKey, plaintext);

    // IV is 12 bytes (96 bits) for AES-GCM
    // Encrypted data should be IV + ciphertext + auth tag
    expect(encrypted.byteLength).toBeGreaterThan(12);
  });
});

describe('JSON Encryption/Decryption', () => {
  it('should encrypt and decrypt JSON objects', async () => {
    const aliceKeypair = await generateEphemeralKeypair('P-256');
    const bobKeypair = await generateEphemeralKeypair('P-256');
    const sharedSecret = await deriveSharedSecret(aliceKeypair.privateKey, bobKeypair.publicKey);

    const data = {
      message: 'Hello',
      count: 42,
      nested: {
        array: [1, 2, 3],
        flag: true,
      },
    };

    const plaintext = JSON.stringify(data);
    const ciphertext = await encrypt(sharedSecret, plaintext);
    const decrypted = await decrypt(sharedSecret, ciphertext);
    const parsed = JSON.parse(decrypted);

    expect(parsed).toEqual(data);
  });

  it('should handle complex nested structures', async () => {
    const aliceKeypair = await generateEphemeralKeypair('P-256');
    const bobKeypair = await generateEphemeralKeypair('P-256');
    const sharedSecret = await deriveSharedSecret(aliceKeypair.privateKey, bobKeypair.publicKey);

    const complexData = {
      users: [
        { id: 1, name: 'Alice', roles: ['admin', 'user'] },
        { id: 2, name: 'Bob', roles: ['user'] },
      ],
      metadata: {
        timestamp: Date.now(),
        version: '1.0.0',
        settings: {
          theme: 'dark',
          notifications: true,
        },
      },
    };

    const plaintext = JSON.stringify(complexData);
    const ciphertext = await encrypt(sharedSecret, plaintext);
    const decrypted = await decrypt(sharedSecret, ciphertext);
    const parsed = JSON.parse(decrypted);

    expect(parsed).toEqual(complexData);
  });
});

describe('End-to-End Encryption Workflow', () => {
  it('should complete full E2E encryption workflow between two parties', async () => {
    // Step 1: Alice and Bob generate keypairs
    const aliceKeypair = await generateEphemeralKeypair('P-256');
    const bobKeypair = await generateEphemeralKeypair('P-256');

    // Step 2: Both derive the same shared secret
    const aliceSharedSecret = await deriveSharedSecret(
      aliceKeypair.privateKey,
      bobKeypair.publicKey
    );
    const bobSharedSecret = await deriveSharedSecret(
      bobKeypair.privateKey,
      aliceKeypair.publicKey
    );

    expect(aliceSharedSecret).toBe(bobSharedSecret);

    // Step 3: Alice encrypts a message
    const aliceMessage = 'Hello Bob!';
    const aliceCiphertext = await encrypt(aliceSharedSecret, aliceMessage);

    // Step 4: Bob decrypts Alice's message
    const bobDecrypted = await decrypt(bobSharedSecret, aliceCiphertext);
    expect(bobDecrypted).toBe(aliceMessage);

    // Step 5: Bob encrypts a reply
    const bobMessage = 'Hi Alice!';
    const bobCiphertext = await encrypt(bobSharedSecret, bobMessage);

    // Step 6: Alice decrypts Bob's reply
    const aliceDecrypted = await decrypt(aliceSharedSecret, bobCiphertext);
    expect(aliceDecrypted).toBe(bobMessage);
  });

  it('should support bidirectional encrypted communication', async () => {
    const aliceKeypair = await generateEphemeralKeypair('P-256');
    const bobKeypair = await generateEphemeralKeypair('P-256');

    const aliceSecret = await deriveSharedSecret(aliceKeypair.privateKey, bobKeypair.publicKey);
    const bobSecret = await deriveSharedSecret(bobKeypair.privateKey, aliceKeypair.publicKey);

    // Multiple messages back and forth
    const messages = [
      { sender: 'Alice', text: 'First message' },
      { sender: 'Bob', text: 'Got it!' },
      { sender: 'Alice', text: 'Great 👍' },
      { sender: 'Bob', text: 'See you later' },
    ];

    for (const msg of messages) {
      if (msg.sender === 'Alice') {
        const encrypted = await encrypt(aliceSecret, msg.text);
        const decrypted = await decrypt(bobSecret, encrypted);
        expect(decrypted).toBe(msg.text);
      } else {
        const encrypted = await encrypt(bobSecret, msg.text);
        const decrypted = await decrypt(aliceSecret, encrypted);
        expect(decrypted).toBe(msg.text);
      }
    }
  });
});

describe('Performance and Edge Cases', () => {
  it('should handle very long messages efficiently', async () => {
    const aliceKeypair = await generateEphemeralKeypair('P-256');
    const bobKeypair = await generateEphemeralKeypair('P-256');
    const sharedSecret = await deriveSharedSecret(aliceKeypair.privateKey, bobKeypair.publicKey);

    // 100KB message (reduced from 1MB for faster tests)
    const plaintext = 'x'.repeat(100 * 1024);
    const start = Date.now();
    const ciphertext = await encrypt(sharedSecret, plaintext);
    const encrypted_time = Date.now() - start;

    const decrypt_start = Date.now();
    const decrypted = await decrypt(sharedSecret, ciphertext);
    const decrypted_time = Date.now() - decrypt_start;

    expect(decrypted).toBe(plaintext);
    // Should complete in reasonable time (< 2 seconds for 100KB)
    expect(encrypted_time).toBeLessThan(2000);
    expect(decrypted_time).toBeLessThan(2000);
  });

  it('should handle special characters and control codes', async () => {
    const aliceKeypair = await generateEphemeralKeypair('P-256');
    const bobKeypair = await generateEphemeralKeypair('P-256');
    const sharedSecret = await deriveSharedSecret(aliceKeypair.privateKey, bobKeypair.publicKey);

    const plaintext = '\n\r\t\0\x1b[31mRed Text\x1b[0m';
    const ciphertext = await encrypt(sharedSecret, plaintext);
    const decrypted = await decrypt(sharedSecret, ciphertext);

    expect(decrypted).toBe(plaintext);
  });
});
