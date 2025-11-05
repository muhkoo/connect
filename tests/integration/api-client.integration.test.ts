/**
 * Integration tests for ApiClient with real Accelerator server
 * Tests the full Connect SDK API client against a running Accelerator instance
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AcceleratorServer } from './helpers/accelerator-server';
import { ApiClient } from '../../src/api/client';

describe('ApiClient Integration Tests', () => {
  let server: AcceleratorServer;
  let baseUrl: string;
  let client: ApiClient;

  beforeAll(async () => {
    server = new AcceleratorServer({
      port: 8787,
      logOutput: false,
    });

    await server.start();
    baseUrl = server.getBaseUrl();

    // Create API client with Accelerator base URL
    client = new ApiClient({ baseUrl });
  }, 60000);

  afterAll(async () => {
    if (server) {
      await server.stop();
    }
  });

  describe('Session Creation', () => {
    it('should create a session with ECDH handshake', async () => {
      const response = await client.createSession();

      expect(response).toBeDefined();
      expect(response.sessionId).toBeDefined();
      expect(response.serverPublicKey).toBeDefined();
      expect(response.expiresAt).toBeGreaterThan(Date.now());

      // Verify client is authenticated after session creation
      expect(client.isAuthenticated()).toBe(true);
    });

    it('should create a session with provider', async () => {
      const newClient = new ApiClient({ baseUrl });
      const response = await newClient.createSession('google');

      expect(response).toBeDefined();
      expect(response.provider).toBe('google');
      expect(newClient.isAuthenticated()).toBe(true);
    });

    it('should have access to public key after session', async () => {
      const newClient = new ApiClient({ baseUrl });
      await newClient.createSession();

      const publicKey = newClient.getPublicKey();
      expect(publicKey).toBeDefined();
      expect(typeof publicKey).toBe('string');
    });

    it('should not be authenticated before creating session', () => {
      const newClient = new ApiClient({ baseUrl });
      expect(newClient.isAuthenticated()).toBe(false);
    });
  });

  describe('Session Management', () => {
    it('should allow logout to clear session', async () => {
      const newClient = new ApiClient({ baseUrl });
      await newClient.createSession();

      expect(newClient.isAuthenticated()).toBe(true);

      newClient.logout();

      expect(newClient.isAuthenticated()).toBe(false);
      expect(newClient.getPublicKey()).toBeNull();
    });

    it('should get session manager for advanced use cases', async () => {
      const newClient = new ApiClient({ baseUrl });
      await newClient.createSession();

      const sessionManager = newClient.getSessionManager();
      expect(sessionManager).toBeDefined();
      expect(sessionManager.isValid()).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should handle network errors gracefully', async () => {
      const badClient = new ApiClient({
        baseUrl: 'http://localhost:9999', // Non-existent server
        timeout: 2000,
      });

      await expect(badClient.createSession()).rejects.toThrow();
    });

    it('should require authentication for protected operations', async () => {
      const unauthClient = new ApiClient({ baseUrl });

      // Try to send message without authentication
      await expect(
        unauthClient.sendMessage('test-topic', { message: 'hello' })
      ).rejects.toThrow('Authentication required');
    });
  });

  describe('Message Encryption', () => {
    it('should encrypt and decrypt messages', async () => {
      const newClient = new ApiClient({ baseUrl });
      await newClient.createSession();

      const testData = { message: 'Hello, World!', timestamp: Date.now() };

      // Get session manager to test encryption
      const sessionManager = newClient.getSessionManager();
      const encrypted = await sessionManager.encryptJSON(testData);

      expect(encrypted).toBeDefined();
      expect(typeof encrypted).toBe('string');

      const decrypted = await sessionManager.decryptJSON(encrypted);
      expect(decrypted).toEqual(testData);
    });

    it('should handle complex data structures', async () => {
      const newClient = new ApiClient({ baseUrl });
      await newClient.createSession();

      const complexData = {
        user: { id: 1, name: 'Alice' },
        items: [1, 2, 3, 4, 5],
        nested: {
          deep: {
            value: 'test',
          },
        },
      };

      const sessionManager = newClient.getSessionManager();
      const encrypted = await sessionManager.encryptJSON(complexData);
      const decrypted = await sessionManager.decryptJSON(encrypted);

      expect(decrypted).toEqual(complexData);
    });
  });

  describe('Configuration', () => {
    it('should allow updating configuration', () => {
      const newClient = new ApiClient({ baseUrl });

      newClient.updateConfig({
        timeout: 5000,
        headers: { 'X-Custom-Header': 'test' },
      });

      // Config should be updated (can't directly test, but shouldn't throw)
      expect(() => newClient.updateConfig({ timeout: 10000 })).not.toThrow();
    });

    it('should handle custom headers', async () => {
      const newClient = new ApiClient({
        baseUrl,
        headers: { 'X-App-Name': 'test-app' },
      });

      await newClient.createSession();
      expect(newClient.isAuthenticated()).toBe(true);
    });
  });

  describe('Multiple Sessions', () => {
    it('should allow multiple independent clients', async () => {
      const client1 = new ApiClient({ baseUrl });
      const client2 = new ApiClient({ baseUrl });

      await client1.createSession();
      await client2.createSession();

      expect(client1.isAuthenticated()).toBe(true);
      expect(client2.isAuthenticated()).toBe(true);

      // Sessions should be independent
      const publicKey1 = client1.getPublicKey();
      const publicKey2 = client2.getPublicKey();

      expect(publicKey1).not.toBe(publicKey2);
    });
  });

  describe('Session Persistence', () => {
    it('should export session data', async () => {
      const newClient = new ApiClient({ baseUrl });
      await newClient.createSession();

      const sessionManager = newClient.getSessionManager();
      const exported = sessionManager.exportSession();

      expect(exported).toBeDefined();
      expect(typeof exported).toBe('string');

      const parsed = JSON.parse(exported!);
      expect(parsed.sessionId).toBeDefined();
      expect(parsed.sharedSecret).toBeDefined();
    });
  });

  // Note: The following tests are pending implementation of these endpoints in Accelerator
  describe.skip('Messaging API (Pending Implementation)', () => {
    it('should send a message', async () => {
      const newClient = new ApiClient({ baseUrl });
      await newClient.createSession();

      const response = await newClient.sendMessage('test-topic', {
        message: 'Hello, World!',
      });

      expect(response).toBeDefined();
      expect(response.messageId).toBeDefined();
    });

    it('should subscribe to a topic', async () => {
      const newClient = new ApiClient({ baseUrl });
      await newClient.createSession();

      const response = await newClient.subscribe('test-topic');

      expect(response).toBeDefined();
      expect(response.subscriptionId).toBeDefined();
    });
  });

  describe.skip('Storage API (Pending Implementation)', () => {
    it('should store and retrieve data', async () => {
      const newClient = new ApiClient({ baseUrl });
      await newClient.createSession();

      const testData = { value: 'test123' };

      await newClient.storeData('test-key', testData);
      const retrieved = await newClient.retrieveData('test-key');

      expect(retrieved).toEqual(testData);
    });

    it('should delete data', async () => {
      const newClient = new ApiClient({ baseUrl });
      await newClient.createSession();

      await newClient.storeData('delete-key', { value: 'will-be-deleted' });
      await newClient.deleteData('delete-key');

      await expect(newClient.retrieveData('delete-key')).rejects.toThrow();
    });

    it('should list keys', async () => {
      const newClient = new ApiClient({ baseUrl });
      await newClient.createSession();

      await newClient.storeData('key1', { value: 1 });
      await newClient.storeData('key2', { value: 2 });

      const response = await newClient.listKeys();

      expect(response.keys).toContain('key1');
      expect(response.keys).toContain('key2');
    });
  });

  describe.skip('Permissions API (Pending Implementation)', () => {
    it('should check permissions', async () => {
      const newClient = new ApiClient({ baseUrl });
      await newClient.createSession();

      const hasPermission = await newClient.checkPermission('resource1', 'read');

      expect(typeof hasPermission).toBe('boolean');
    });

    it('should grant permissions', async () => {
      const newClient = new ApiClient({ baseUrl });
      await newClient.createSession();

      const otherUserKey = 'other-user-public-key';

      const response = await newClient.grantPermission(
        'resource1',
        otherUserKey,
        ['read', 'write']
      );

      expect(response).toBeDefined();
    });
  });
});
