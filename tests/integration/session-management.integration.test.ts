/**
 * Session Management Integration Tests
 * Tests SessionManager integration with Accelerator server
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AcceleratorServer } from './helpers/accelerator-server';
import { SessionManager } from '../../src/api/session';
import { dehydratePublicKey, hydratePublicKey } from '../../src/crypto/ecdh';

describe('Session Management Integration', () => {
  let server: AcceleratorServer;
  let baseUrl: string;

  beforeAll(async () => {
    server = new AcceleratorServer({
      port: 8787,
      logOutput: false,
    });

    await server.start();
    baseUrl = server.getBaseUrl();
  }, 60000);

  afterAll(async () => {
    if (server) {
      await server.stop();
    }
  });

  describe('Session Creation with Accelerator', () => {
    it('should create a session with ECDH handshake', async () => {
      const sessionManager = new SessionManager();

      // Step 1: Create session on client side (defaults to P-384)
      const clientPublicKey = await sessionManager.createSession();
      expect(clientPublicKey).toBeDefined();

      // Step 2: Send to server for handshake
      const response = await fetch(`${baseUrl}/api/handshake`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientPublicKey,
          curve: 'P-384',
        }),
      });

      expect(response.ok).toBe(true);
      const { serverPublicKey, connectionId } = await response.json();

      // Step 3: Complete session on client side
      const expiresAt = Date.now() + 3600000; // 1 hour
      await sessionManager.completeSession(serverPublicKey, connectionId, expiresAt);

      // Verify session is valid
      expect(sessionManager.isValid()).toBe(true);
      expect(sessionManager.getSessionId()).toBe(connectionId);
    });

    it('should work with P-256 curve for backward compatibility', async () => {
      const sessionManager = new SessionManager();

      const clientPublicKey = await sessionManager.createSession('P-256');

      const response = await fetch(`${baseUrl}/api/handshake`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientPublicKey,
          curve: 'P-256',
        }),
      });

      const { serverPublicKey, connectionId } = await response.json();
      await sessionManager.completeSession(
        serverPublicKey,
        connectionId,
        Date.now() + 3600000
      );

      expect(sessionManager.isValid()).toBe(true);
    });
  });

  describe('Encryption/Decryption', () => {
    let sessionManager: SessionManager;

    beforeEach(async () => {
      // Establish session before each test
      sessionManager = new SessionManager();
      const clientPublicKey = await sessionManager.createSession(); // Defaults to P-384

      const response = await fetch(`${baseUrl}/api/handshake`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientPublicKey,
          curve: 'P-384',
        }),
      });

      const { serverPublicKey, connectionId } = await response.json();
      await sessionManager.completeSession(
        serverPublicKey,
        connectionId,
        Date.now() + 3600000
      );
    });

    it('should encrypt and decrypt strings', async () => {
      const plaintext = 'Hello from Connect!';
      const encrypted = await sessionManager.encrypt(plaintext);

      expect(encrypted).toBeDefined();
      expect(encrypted).not.toBe(plaintext);

      const decrypted = await sessionManager.decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it('should encrypt and decrypt JSON objects', async () => {
      const data = {
        message: 'Test message',
        timestamp: Date.now(),
        nested: {
          value: 42,
          array: [1, 2, 3],
        },
      };

      const encrypted = await sessionManager.encryptJSON(data);
      const decrypted = await sessionManager.decryptJSON(encrypted);

      expect(decrypted).toEqual(data);
    });

    it('should encrypt and decrypt empty strings', async () => {
      const encrypted = await sessionManager.encrypt('');
      const decrypted = await sessionManager.decrypt(encrypted);

      expect(decrypted).toBe('');
    });

    it('should encrypt and decrypt unicode strings', async () => {
      const plaintext = 'Hello 世界 🌍 Привет';
      const encrypted = await sessionManager.encrypt(plaintext);
      const decrypted = await sessionManager.decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it('should throw error when encrypting without session', async () => {
      const emptySession = new SessionManager();

      await expect(emptySession.encrypt('test')).rejects.toThrow('No active session');
    });

    it('should throw error when decrypting without session', async () => {
      const emptySession = new SessionManager();

      await expect(emptySession.decrypt('encrypted-data')).rejects.toThrow(
        'No active session'
      );
    });
  });

  describe('Session Lifecycle', () => {
    it('should maintain session validity', async () => {
      const sessionManager = new SessionManager();
      const clientPublicKey = await sessionManager.createSession(); // Defaults to P-384

      const response = await fetch(`${baseUrl}/api/handshake`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientPublicKey,
          curve: 'P-384',
        }),
      });

      const { serverPublicKey, connectionId } = await response.json();
      await sessionManager.completeSession(
        serverPublicKey,
        connectionId,
        Date.now() + 3600000
      );

      expect(sessionManager.isValid()).toBe(true);

      // Clear session
      sessionManager.clearSession();
      expect(sessionManager.isValid()).toBe(false);
    });

    it('should detect expired sessions', async () => {
      const sessionManager = new SessionManager();
      const clientPublicKey = await sessionManager.createSession(); // Defaults to P-384

      const response = await fetch(`${baseUrl}/api/handshake`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientPublicKey,
          curve: 'P-384',
        }),
      });

      const { serverPublicKey, connectionId } = await response.json();

      // Set expiration in the past
      await sessionManager.completeSession(
        serverPublicKey,
        connectionId,
        Date.now() - 1000
      );

      expect(sessionManager.isValid()).toBe(false);
    });

    it('should refresh session expiration', async () => {
      const sessionManager = new SessionManager();
      const clientPublicKey = await sessionManager.createSession(); // Defaults to P-384

      const response = await fetch(`${baseUrl}/api/handshake`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientPublicKey,
          curve: 'P-384',
        }),
      });

      const { serverPublicKey, connectionId } = await response.json();
      const initialExpiration = Date.now() + 1000;
      await sessionManager.completeSession(serverPublicKey, connectionId, initialExpiration);

      const session = sessionManager.getSession();
      expect(session?.expiresAt).toBe(initialExpiration);

      // Refresh with new expiration
      const newExpiration = Date.now() + 3600000;
      sessionManager.refreshSession(newExpiration);

      const refreshedSession = sessionManager.getSession();
      expect(refreshedSession?.expiresAt).toBe(newExpiration);
    });
  });

  describe('Session Export', () => {
    it('should export session data', async () => {
      const sessionManager = new SessionManager();
      const clientPublicKey = await sessionManager.createSession(); // Defaults to P-384

      const response = await fetch(`${baseUrl}/api/handshake`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientPublicKey,
          curve: 'P-384',
        }),
      });

      const { serverPublicKey, connectionId } = await response.json();
      await sessionManager.completeSession(
        serverPublicKey,
        connectionId,
        Date.now() + 3600000
      );

      const exported = sessionManager.exportSession();

      expect(exported).toBeDefined();
      expect(typeof exported).toBe('string');

      // Verify it's valid JSON
      const parsed = JSON.parse(exported!);
      expect(parsed).toHaveProperty('sessionId');
      expect(parsed).toHaveProperty('sharedSecret');
      expect(parsed).toHaveProperty('expiresAt');
    });

    it('should return null when exporting without session', () => {
      const sessionManager = new SessionManager();
      const exported = sessionManager.exportSession();

      expect(exported).toBeNull();
    });
  });
});
