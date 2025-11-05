/**
 * ApiClient Tests
 * Tests for type-safe API client with E2E encryption
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ApiClient, ApiError } from '../../src/api/client';
import { generateEphemeralKeypair, dehydratePublicKey } from '../../src/crypto/ecdh';
import type { CreateSessionResponse } from '../../src/api/schemas';

// Mock fetch globally
global.fetch = vi.fn();

describe('ApiClient - Initialization', () => {
  it('should initialize with basic config', () => {
    const client = new ApiClient({
      baseUrl: 'https://api.example.com',
    });

    expect(client).toBeDefined();
    expect(client.isAuthenticated()).toBe(false);
  });

  it('should initialize with custom headers', () => {
    const client = new ApiClient({
      baseUrl: 'https://api.example.com',
      headers: {
        'X-Custom-Header': 'value',
      },
    });

    expect(client).toBeDefined();
  });

  it('should initialize with custom timeout', () => {
    const client = new ApiClient({
      baseUrl: 'https://api.example.com',
      timeout: 60000,
    });

    expect(client).toBeDefined();
  });

  it('should initialize with retry configuration', () => {
    const client = new ApiClient({
      baseUrl: 'https://api.example.com',
      retry: {
        maxRetries: 5,
        retryDelay: 2000,
      },
    });

    expect(client).toBeDefined();
  });
});

describe('ApiClient - Session Management', () => {
  let client: ApiClient;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new ApiClient({
      baseUrl: 'https://api.example.com',
    });
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  it('should create session successfully', async () => {
    const serverKeypair = await generateEphemeralKeypair('P-256');
    const serverPublicKey = dehydratePublicKey(serverKeypair.publicKey);
    const sessionId = 'test-session-id';
    const expiresAt = Date.now() + 3600000;

    const mockResponse: CreateSessionResponse = {
      serverPublicKey,
      sessionId,
      expiresAt,
      identity: 'encrypted-identity-data',
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, data: mockResponse }),
    });

    const response = await client.createSession();

    expect(response).toEqual(mockResponse);
    expect(client.isAuthenticated()).toBe(true);
    expect(client.getPublicKey()).toBeDefined();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/auth/session',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
        }),
      })
    );
  });

  it('should create session with provider info', async () => {
    const serverKeypair = await generateEphemeralKeypair('P-256');
    const mockResponse: CreateSessionResponse = {
      serverPublicKey: dehydratePublicKey(serverKeypair.publicKey),
      sessionId: 'session-with-provider',
      expiresAt: Date.now() + 3600000,
      identity: 'encrypted-identity',
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, data: mockResponse }),
    });

    await client.createSession({
      type: 'oauth',
      providerId: 'google-oauth2',
    });

    expect(mockFetch).toHaveBeenCalled();
    const callArgs = mockFetch.mock.calls[0];
    const requestBody = JSON.parse(callArgs[1].body);

    expect(requestBody.provider).toEqual({
      type: 'oauth',
      providerId: 'google-oauth2',
    });
  });

  it('should refresh session', async () => {
    // First create a session
    const serverKeypair = await generateEphemeralKeypair('P-256');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          serverPublicKey: dehydratePublicKey(serverKeypair.publicKey),
          sessionId: 'original-session',
          expiresAt: Date.now() + 1000,
          identity: 'encrypted',
        },
      }),
    });

    await client.createSession();

    // Then refresh
    const newExpiresAt = Date.now() + 7200000;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          sessionId: 'original-session',
          expiresAt: newExpiresAt,
        },
      }),
    });

    const refreshResponse = await client.refreshSession();

    expect(refreshResponse.sessionId).toBe('original-session');
    expect(refreshResponse.expiresAt).toBe(newExpiresAt);
    expect(client.isAuthenticated()).toBe(true);
  });

  it('should logout and clear session', async () => {
    // Create session first
    const serverKeypair = await generateEphemeralKeypair('P-256');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          serverPublicKey: dehydratePublicKey(serverKeypair.publicKey),
          sessionId: 'session-to-logout',
          expiresAt: Date.now() + 3600000,
          identity: 'encrypted',
        },
      }),
    });

    await client.createSession();
    expect(client.isAuthenticated()).toBe(true);

    client.logout();

    expect(client.isAuthenticated()).toBe(false);
    expect(client.getPublicKey()).toBeNull();
  });

  it('should handle session creation errors', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Invalid session request',
        },
      }),
    });

    await expect(client.createSession()).rejects.toThrow(ApiError);
    expect(client.isAuthenticated()).toBe(false);
  });
});

describe('ApiClient - Messaging', () => {
  let client: ApiClient;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    client = new ApiClient({
      baseUrl: 'https://api.example.com',
    });
    mockFetch = vi.fn();
    global.fetch = mockFetch;

    // Setup authenticated session
    const serverKeypair = await generateEphemeralKeypair('P-256');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          serverPublicKey: dehydratePublicKey(serverKeypair.publicKey),
          sessionId: 'test-session',
          expiresAt: Date.now() + 3600000,
          identity: 'encrypted',
        },
      }),
    });
    await client.createSession();
    mockFetch.mockClear();
  });

  it('should send encrypted message', async () => {
    const messageId = 'msg-123';
    const timestamp = Date.now();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: { messageId, timestamp },
      }),
    });

    const response = await client.sendMessage('chat:general', {
      text: 'Hello, World!',
    });

    expect(response.messageId).toBe(messageId);
    expect(response.timestamp).toBe(timestamp);

    // Verify the message was encrypted
    const callArgs = mockFetch.mock.calls[0];
    const requestBody = JSON.parse(callArgs[1].body);
    expect(requestBody.encryptedData).toBeDefined();
    expect(requestBody.encryptedData).not.toContain('Hello, World!');
  });

  it('should send direct message with recipient', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: { messageId: 'msg-456', timestamp: Date.now() },
      }),
    });

    await client.sendMessage('direct', { text: 'Private message' }, 'recipient-public-key');

    const callArgs = mockFetch.mock.calls[0];
    const requestBody = JSON.parse(callArgs[1].body);
    expect(requestBody.recipientPublicKey).toBe('recipient-public-key');
  });

  it('should subscribe to topic', async () => {
    const subscriptionId = 'sub-789';
    const topic = 'notifications';

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: { subscriptionId, topic },
      }),
    });

    const response = await client.subscribe(topic, { filters: { type: 'important' } });

    expect(response.subscriptionId).toBe(subscriptionId);
    expect(response.topic).toBe(topic);
  });

  it('should fetch messages from topic', async () => {
    const messages = [
      {
        id: 'msg-1',
        topic: 'chat:general',
        senderPublicKey: 'sender-key',
        encryptedData: 'encrypted-message-1',
        timestamp: Date.now(),
      },
      {
        id: 'msg-2',
        topic: 'chat:general',
        senderPublicKey: 'sender-key',
        encryptedData: 'encrypted-message-2',
        timestamp: Date.now(),
      },
    ];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: { messages, hasMore: false },
      }),
    });

    const response = await client.fetchMessages('chat:general', Date.now() - 3600000, 10);

    expect(response.messages).toHaveLength(2);
    expect(response.hasMore).toBe(false);
  });

  it('should require authentication for messaging', async () => {
    const unauthenticatedClient = new ApiClient({
      baseUrl: 'https://api.example.com',
    });

    await expect(unauthenticatedClient.sendMessage('topic', { data: 'test' })).rejects.toThrow(
      'Authentication required'
    );
  });
});

describe('ApiClient - Storage', () => {
  let client: ApiClient;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    client = new ApiClient({
      baseUrl: 'https://api.example.com',
    });
    mockFetch = vi.fn();
    global.fetch = mockFetch;

    // Setup authenticated session
    const serverKeypair = await generateEphemeralKeypair('P-256');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          serverPublicKey: dehydratePublicKey(serverKeypair.publicKey),
          sessionId: 'test-session',
          expiresAt: Date.now() + 3600000,
          identity: 'encrypted',
        },
      }),
    });
    await client.createSession();
    mockFetch.mockClear();
  });

  it('should store encrypted data', async () => {
    const key = 'user:preferences';
    const version = 1;
    const timestamp = Date.now();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: { key, version, timestamp },
      }),
    });

    const data = { theme: 'dark', language: 'en' };
    const response = await client.storeData(key, data, 'user-settings');

    expect(response.key).toBe(key);
    expect(response.version).toBe(version);

    // Verify data was encrypted
    const callArgs = mockFetch.mock.calls[0];
    const requestBody = JSON.parse(callArgs[1].body);
    expect(requestBody.encryptedData).toBeDefined();
    expect(requestBody.encryptedData).not.toContain('dark');
  });

  it('should retrieve and decrypt data', async () => {
    // First, store the data (to get encrypted version)
    const originalData = { value: 42, text: 'test' };
    const sessionManager = client.getSessionManager();
    const encryptedData = await sessionManager.encryptJSON(originalData);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          key: 'test:key',
          encryptedData,
          version: 1,
          timestamp: Date.now(),
        },
      }),
    });

    const retrieved = await client.retrieveData('test:key');

    expect(retrieved).toEqual(originalData);
  });

  it('should delete data', async () => {
    const key = 'data:to-delete';
    const timestamp = Date.now();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: { key, timestamp },
      }),
    });

    const response = await client.deleteData(key, 'namespace');

    expect(response.key).toBe(key);
    expect(response.timestamp).toBe(timestamp);
  });

  it('should list keys in namespace', async () => {
    const keys = ['key1', 'key2', 'key3'];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          keys,
          hasMore: false,
        },
      }),
    });

    const response = await client.listKeys('test-namespace', 'prefix-', undefined, 10);

    expect(response.keys).toEqual(keys);
    expect(response.hasMore).toBe(false);
  });
});

describe('ApiClient - Permissions', () => {
  let client: ApiClient;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    client = new ApiClient({
      baseUrl: 'https://api.example.com',
    });
    mockFetch = vi.fn();
    global.fetch = mockFetch;

    // Setup authenticated session
    const serverKeypair = await generateEphemeralKeypair('P-256');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          serverPublicKey: dehydratePublicKey(serverKeypair.publicKey),
          sessionId: 'test-session',
          expiresAt: Date.now() + 3600000,
          identity: 'encrypted',
        },
      }),
    });
    await client.createSession();
    mockFetch.mockClear();
  });

  it('should check permissions', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          granted: true,
        },
      }),
    });

    const granted = await client.checkPermission('resource:123', 'read', 'user-public-key');

    expect(granted).toBe(true);
  });

  it('should grant permissions', async () => {
    const resource = 'document:456';
    const userPublicKey = 'user-key';
    const permissions = ['read', 'write'] as const;
    const timestamp = Date.now();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          resource,
          userPublicKey,
          permissions,
          timestamp,
        },
      }),
    });

    const response = await client.grantPermission(resource, userPublicKey, permissions);

    expect(response.resource).toBe(resource);
    expect(response.userPublicKey).toBe(userPublicKey);
    expect(response.permissions).toEqual(permissions);
  });
});

describe('ApiClient - Error Handling', () => {
  let client: ApiClient;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new ApiClient({
      baseUrl: 'https://api.example.com',
    });
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  it('should handle API errors', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Invalid request data',
          details: { field: 'clientPublicKey' },
        },
      }),
    });

    try {
      await client.createSession();
      expect.fail('Should have thrown ApiError');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('INVALID_REQUEST');
      expect((error as ApiError).message).toContain('Invalid request data');
      expect((error as ApiError).details).toEqual({ field: 'clientPublicKey' });
    }
  });

  it('should handle network errors', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    await expect(client.createSession()).rejects.toThrow('Network error');
  });

  it('should handle HTTP errors', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({}),
    });

    await expect(client.createSession()).rejects.toThrow();
  });
});

describe('ApiClient - Configuration', () => {
  it('should allow updating configuration', () => {
    const client = new ApiClient({
      baseUrl: 'https://api.example.com',
    });

    client.updateConfig({
      baseUrl: 'https://new-api.example.com',
      timeout: 60000,
    });

    // Configuration should be updated (we can't directly test this without making a request)
    expect(client).toBeDefined();
  });

  it('should allow accessing session manager', () => {
    const client = new ApiClient({
      baseUrl: 'https://api.example.com',
    });

    const sessionManager = client.getSessionManager();

    expect(sessionManager).toBeDefined();
    expect(sessionManager.isValid()).toBe(false);
  });
});
