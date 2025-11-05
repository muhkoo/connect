/**
 * SessionManager Tests
 * Tests for ECDH session lifecycle management
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SessionManager } from '../../src/api/session';
import { generateEphemeralKeypair, dehydratePublicKey, deriveSharedSecret } from '../../src/crypto/ecdh';

describe('SessionManager - Session Creation', () => {
  let sessionManager: SessionManager;

  beforeEach(() => {
    sessionManager = new SessionManager();
  });

  it('should create a new session with P-256 curve', async () => {
    const clientPublicKey = await sessionManager.createSession('P-256');

    expect(clientPublicKey).toBeDefined();
    expect(typeof clientPublicKey).toBe('string');
    expect(clientPublicKey.length).toBeGreaterThan(0);
  });

  it('should create a new session with P-384 curve', async () => {
    const clientPublicKey = await sessionManager.createSession('P-384');

    expect(clientPublicKey).toBeDefined();
    expect(typeof clientPublicKey).toBe('string');
  });

  it('should default to P-256 when no curve specified', async () => {
    const clientPublicKey = await sessionManager.createSession();

    expect(clientPublicKey).toBeDefined();
    // P-256 keys should be shorter than P-384 keys when serialized
    expect(clientPublicKey.length).toBeLessThan(200);
  });

  it('should not be valid immediately after creation', async () => {
    await sessionManager.createSession('P-256');

    expect(sessionManager.isValid()).toBe(false);
  });

  it('should have no session ID after creation', async () => {
    await sessionManager.createSession('P-256');

    expect(sessionManager.getSessionId()).toBeNull();
  });
});

describe('SessionManager - Session Completion', () => {
  let sessionManager: SessionManager;
  let serverKeypair: any;

  beforeEach(async () => {
    sessionManager = new SessionManager();
    serverKeypair = await generateEphemeralKeypair('P-256');
  });

  it('should complete session with server public key', async () => {
    const clientPublicKey = await sessionManager.createSession('P-256');
    const serverPublicKeyDehydrated = dehydratePublicKey(serverKeypair.publicKey);
    const sessionId = 'test-session-id';
    const expiresAt = Date.now() + 3600000; // 1 hour

    await sessionManager.completeSession(serverPublicKeyDehydrated, sessionId, expiresAt);

    expect(sessionManager.isValid()).toBe(true);
    expect(sessionManager.getSessionId()).toBe(sessionId);
    expect(sessionManager.getPublicKey()).toBe(clientPublicKey);
  });

  it('should have valid session data after completion', async () => {
    await sessionManager.createSession('P-256');
    const serverPublicKeyDehydrated = dehydratePublicKey(serverKeypair.publicKey);

    await sessionManager.completeSession(
      serverPublicKeyDehydrated,
      'session-123',
      Date.now() + 3600000
    );

    const session = sessionManager.getSession();

    expect(session).toBeDefined();
    expect(session?.sessionId).toBe('session-123');
    expect(session?.sharedSecret).toBeDefined();
    expect(session?.sharedSecret.length).toBeGreaterThan(0);
  });

  it('should derive the same shared secret as server', async () => {
    // Client creates session
    const clientPublicKey = await sessionManager.createSession('P-256');

    // Server completes handshake
    const clientSession = sessionManager.getSession();
    const serverPublicKeyDehydrated = dehydratePublicKey(serverKeypair.publicKey);
    await sessionManager.completeSession(
      serverPublicKeyDehydrated,
      'session-456',
      Date.now() + 3600000
    );

    // Derive server's shared secret
    const clientKeypair = clientSession?.clientKeypair;
    const serverSharedSecret = await deriveSharedSecret(
      serverKeypair.privateKey,
      clientKeypair!.publicKey
    );

    const clientSharedSecret = sessionManager.getSession()?.sharedSecret;

    expect(clientSharedSecret).toBe(serverSharedSecret);
  });
});

describe('SessionManager - Encryption/Decryption', () => {
  let sessionManager: SessionManager;
  let serverKeypair: any;

  beforeEach(async () => {
    sessionManager = new SessionManager();
    serverKeypair = await generateEphemeralKeypair('P-256');

    // Complete session setup
    await sessionManager.createSession('P-256');
    const serverPublicKeyDehydrated = dehydratePublicKey(serverKeypair.publicKey);
    await sessionManager.completeSession(
      serverPublicKeyDehydrated,
      'test-session',
      Date.now() + 3600000
    );
  });

  it('should encrypt and decrypt strings', async () => {
    const plaintext = 'Hello, SessionManager!';
    const encrypted = await sessionManager.encrypt(plaintext);

    expect(encrypted).toBeDefined();
    expect(encrypted).not.toBe(plaintext);

    const decrypted = await sessionManager.decrypt(encrypted);

    expect(decrypted).toBe(plaintext);
  });

  it('should encrypt and decrypt empty strings', async () => {
    const plaintext = '';
    const encrypted = await sessionManager.encrypt(plaintext);
    const decrypted = await sessionManager.decrypt(encrypted);

    expect(decrypted).toBe(plaintext);
  });

  it('should encrypt and decrypt unicode strings', async () => {
    const plaintext = 'こんにちは 🌍 Привет';
    const encrypted = await sessionManager.encrypt(plaintext);
    const decrypted = await sessionManager.decrypt(encrypted);

    expect(decrypted).toBe(plaintext);
  });

  it('should encryptJSON and decryptJSON objects', async () => {
    const data = {
      message: 'Test data',
      count: 42,
      nested: {
        array: [1, 2, 3],
        flag: true,
      },
    };

    const encrypted = await sessionManager.encryptJSON(data);

    expect(encrypted).toBeDefined();
    expect(typeof encrypted).toBe('string');

    const decrypted = await sessionManager.decryptJSON(encrypted);

    expect(decrypted).toEqual(data);
  });

  it('should handle complex JSON structures', async () => {
    const complexData = {
      users: [
        { id: 1, name: 'Alice', roles: ['admin'] },
        { id: 2, name: 'Bob', roles: ['user'] },
      ],
      metadata: {
        timestamp: Date.now(),
        settings: {
          theme: 'dark',
          notifications: true,
        },
      },
    };

    const encrypted = await sessionManager.encryptJSON(complexData);
    const decrypted = await sessionManager.decryptJSON(encrypted);

    expect(decrypted).toEqual(complexData);
  });

  it('should throw error when encrypting without valid session', async () => {
    const newManager = new SessionManager();

    await expect(newManager.encrypt('test')).rejects.toThrow();
  });

  it('should throw error when decrypting without valid session', async () => {
    const newManager = new SessionManager();

    await expect(newManager.decrypt('encrypted')).rejects.toThrow();
  });
});

describe('SessionManager - Session Lifecycle', () => {
  let sessionManager: SessionManager;

  beforeEach(() => {
    sessionManager = new SessionManager();
  });

  it('should clear session data', async () => {
    await sessionManager.createSession('P-256');
    const serverKeypair = await generateEphemeralKeypair('P-256');
    const serverPublicKeyDehydrated = dehydratePublicKey(serverKeypair.publicKey);
    await sessionManager.completeSession(
      serverPublicKeyDehydrated,
      'session-to-clear',
      Date.now() + 3600000
    );

    expect(sessionManager.isValid()).toBe(true);

    sessionManager.clearSession();

    expect(sessionManager.isValid()).toBe(false);
    expect(sessionManager.getSessionId()).toBeNull();
    expect(sessionManager.getPublicKey()).toBeNull();
    expect(sessionManager.getSession()).toBeNull();
  });

  it('should refresh session expiration', async () => {
    await sessionManager.createSession('P-256');
    const serverKeypair = await generateEphemeralKeypair('P-256');
    const serverPublicKeyDehydrated = dehydratePublicKey(serverKeypair.publicKey);
    const initialExpiresAt = Date.now() + 1000;
    await sessionManager.completeSession(
      serverPublicKeyDehydrated,
      'session-refresh',
      initialExpiresAt
    );

    const newExpiresAt = Date.now() + 7200000; // 2 hours
    sessionManager.refreshSession(newExpiresAt);

    const session = sessionManager.getSession();
    expect(session?.expiresAt).toBe(newExpiresAt);
  });

  it('should detect expired sessions', async () => {
    await sessionManager.createSession('P-256');
    const serverKeypair = await generateEphemeralKeypair('P-256');
    const serverPublicKeyDehydrated = dehydratePublicKey(serverKeypair.publicKey);
    const pastExpiration = Date.now() - 1000; // Expired 1 second ago
    await sessionManager.completeSession(
      serverPublicKeyDehydrated,
      'expired-session',
      pastExpiration
    );

    expect(sessionManager.isValid()).toBe(false);
  });

  it('should detect valid non-expired sessions', async () => {
    await sessionManager.createSession('P-256');
    const serverKeypair = await generateEphemeralKeypair('P-256');
    const serverPublicKeyDehydrated = dehydratePublicKey(serverKeypair.publicKey);
    const futureExpiration = Date.now() + 3600000; // Expires in 1 hour
    await sessionManager.completeSession(
      serverPublicKeyDehydrated,
      'valid-session',
      futureExpiration
    );

    expect(sessionManager.isValid()).toBe(true);
  });
});

describe('SessionManager - Session Export/Import', () => {
  let sessionManager: SessionManager;

  beforeEach(async () => {
    sessionManager = new SessionManager();
    await sessionManager.createSession('P-256');
    const serverKeypair = await generateEphemeralKeypair('P-256');
    const serverPublicKeyDehydrated = dehydratePublicKey(serverKeypair.publicKey);
    await sessionManager.completeSession(
      serverPublicKeyDehydrated,
      'export-session',
      Date.now() + 3600000
    );
  });

  it('should export session as string', () => {
    const exported = sessionManager.exportSession();

    expect(exported).toBeDefined();
    expect(typeof exported).toBe('string');
    expect(exported!.length).toBeGreaterThan(0);
  });

  it('should import exported session', async () => {
    const originalSessionId = sessionManager.getSessionId();
    const originalPublicKey = sessionManager.getPublicKey();
    const exported = sessionManager.exportSession();

    // Create new manager and import
    const newManager = new SessionManager();
    await newManager.importSession(exported!);

    expect(newManager.isValid()).toBe(true);
    expect(newManager.getSessionId()).toBe(originalSessionId);
    expect(newManager.getPublicKey()).toBe(originalPublicKey);
  });

  it('should maintain encryption capability after import', async () => {
    const plaintext = 'Test message';
    const encrypted = await sessionManager.encrypt(plaintext);

    const exported = sessionManager.exportSession();

    const newManager = new SessionManager();
    await newManager.importSession(exported!);

    const decrypted = await newManager.decrypt(encrypted);

    expect(decrypted).toBe(plaintext);
  });

  it('should return null when exporting without valid session', () => {
    const emptyManager = new SessionManager();
    const exported = emptyManager.exportSession();

    expect(exported).toBeNull();
  });

  it('should handle JSON serialization correctly', () => {
    const exported = sessionManager.exportSession();

    expect(() => JSON.parse(exported!)).not.toThrow();

    const parsed = JSON.parse(exported!);
    expect(parsed.sessionId).toBeDefined();
    expect(parsed.expiresAt).toBeDefined();
    expect(parsed.sharedSecret).toBeDefined();
  });
});

describe('SessionManager - End-to-End Workflow', () => {
  it('should complete full client-server session establishment', async () => {
    // 1. Client creates session
    const clientManager = new SessionManager();
    const clientPublicKey = await clientManager.createSession('P-256');

    expect(clientManager.isValid()).toBe(false);

    // 2. Server generates keypair and derives shared secret
    const serverKeypair = await generateEphemeralKeypair('P-256');
    const serverPublicKeyDehydrated = dehydratePublicKey(serverKeypair.publicKey);
    const sessionId = crypto.randomUUID();
    const expiresAt = Date.now() + 3600000;

    // 3. Client completes session with server's public key
    await clientManager.completeSession(serverPublicKeyDehydrated, sessionId, expiresAt);

    expect(clientManager.isValid()).toBe(true);
    expect(clientManager.getSessionId()).toBe(sessionId);

    // 4. Both parties can now encrypt/decrypt
    const message = 'Secure communication established';
    const encrypted = await clientManager.encrypt(message);
    const decrypted = await clientManager.decrypt(encrypted);

    expect(decrypted).toBe(message);
  });

  it('should support multiple independent sessions', async () => {
    const manager1 = new SessionManager();
    const manager2 = new SessionManager();

    await manager1.createSession('P-256');
    await manager2.createSession('P-256');

    const server1 = await generateEphemeralKeypair('P-256');
    const server2 = await generateEphemeralKeypair('P-256');

    await manager1.completeSession(
      dehydratePublicKey(server1.publicKey),
      'session-1',
      Date.now() + 3600000
    );
    await manager2.completeSession(
      dehydratePublicKey(server2.publicKey),
      'session-2',
      Date.now() + 3600000
    );

    expect(manager1.getSessionId()).toBe('session-1');
    expect(manager2.getSessionId()).toBe('session-2');

    // Each manager should have independent encryption
    const msg1 = 'Message 1';
    const msg2 = 'Message 2';

    const encrypted1 = await manager1.encrypt(msg1);
    const encrypted2 = await manager2.encrypt(msg2);

    expect(await manager1.decrypt(encrypted1)).toBe(msg1);
    expect(await manager2.decrypt(encrypted2)).toBe(msg2);

    // Should not decrypt each other's messages
    await expect(manager1.decrypt(encrypted2)).rejects.toThrow();
    await expect(manager2.decrypt(encrypted1)).rejects.toThrow();
  });

  it('should persist session across export/import', async () => {
    const originalManager = new SessionManager();
    await originalManager.createSession('P-256');

    const serverKeypair = await generateEphemeralKeypair('P-256');
    await originalManager.completeSession(
      dehydratePublicKey(serverKeypair.publicKey),
      'persistent-session',
      Date.now() + 3600000
    );

    const testData = { message: 'Persistent data', value: 123 };
    const encrypted = await originalManager.encryptJSON(testData);

    // Export and import to new manager
    const exported = originalManager.exportSession();
    const newManager = new SessionManager();
    await newManager.importSession(exported!);

    // Should be able to decrypt with new manager
    const decrypted = await newManager.decryptJSON(encrypted);
    expect(decrypted).toEqual(testData);

    // Should be able to encrypt new data
    const newData = { updated: true };
    const newEncrypted = await newManager.encryptJSON(newData);
    const newDecrypted = await originalManager.decryptJSON(newEncrypted);

    expect(newDecrypted).toEqual(newData);
  });
});
