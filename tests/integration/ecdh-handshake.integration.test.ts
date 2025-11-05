/**
 * ECDH Handshake Integration Tests
 * Tests ECDH key exchange between Connect client and Accelerator server
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AcceleratorServer } from './helpers/accelerator-server';
import {
  generateEphemeralKeypair,
  deriveSharedSecret,
  dehydratePublicKey,
  hydratePublicKey,
} from '../../src/crypto/ecdh';

describe('ECDH Handshake Integration', () => {
  let server: AcceleratorServer;
  let baseUrl: string;

  beforeAll(async () => {
    // Start Accelerator dev server
    server = new AcceleratorServer({
      port: 8787,
      logOutput: false, // Set to true for debugging
    });

    await server.start();
    baseUrl = server.getBaseUrl();
  }, 60000); // 60 second timeout for server startup

  afterAll(async () => {
    // Stop Accelerator dev server
    if (server) {
      await server.stop();
    }
  });

  it('should perform ECDH handshake with Accelerator', async () => {
    // 1. Generate client ephemeral keypair
    const clientKeypair = await generateEphemeralKeypair('P-384');

    // 2. Dehydrate client public key for transmission
    const clientPublicKeyDehydrated = dehydratePublicKey(clientKeypair.publicKey);

    // 3. Send handshake request to Accelerator
    const response = await fetch(`${baseUrl}/api/handshake`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        clientPublicKey: clientPublicKeyDehydrated,
        curve: 'P-384',
      }),
    });

    expect(response.ok).toBe(true);

    const handshakeResult = await response.json();
    expect(handshakeResult).toHaveProperty('serverPublicKey');
    expect(handshakeResult).toHaveProperty('connectionId');

    // 4. Rehydrate server's public key
    const serverPublicKey = hydratePublicKey(handshakeResult.serverPublicKey);

    // 5. Derive shared secret on client side
    const clientSharedSecret = await deriveSharedSecret(
      clientKeypair.privateKey,
      serverPublicKey
    );

    // Verify shared secret was derived successfully
    expect(clientSharedSecret).toBeDefined();
    expect(typeof clientSharedSecret).toBe('string');
    expect(clientSharedSecret.length).toBe(64); // 256-bit hex string

    // Store connection ID for potential follow-up tests
    expect(handshakeResult.connectionId).toBeDefined();
    expect(typeof handshakeResult.connectionId).toBe('string');
  });

  it('should handle P-256 curve for backward compatibility', async () => {
    // Test with P-256 curve for backward compatibility
    const clientKeypair = await generateEphemeralKeypair('P-256');
    const clientPublicKeyDehydrated = dehydratePublicKey(clientKeypair.publicKey);

    const response = await fetch(`${baseUrl}/api/handshake`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        clientPublicKey: clientPublicKeyDehydrated,
        curve: 'P-256',
      }),
    });

    expect(response.ok).toBe(true);

    const handshakeResult = await response.json();
    const serverPublicKey = hydratePublicKey(handshakeResult.serverPublicKey);

    // Verify it's a P-256 key
    expect(serverPublicKey.crv).toBe('P-256');

    // Derive shared secret
    const clientSharedSecret = await deriveSharedSecret(
      clientKeypair.privateKey,
      serverPublicKey
    );

    expect(clientSharedSecret).toBeDefined();
    expect(clientSharedSecret.length).toBe(64); // Both curves use 256-bit derived secrets
  });

  it('should reject invalid public key format', async () => {
    const response = await fetch(`${baseUrl}/api/handshake`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        clientPublicKey: 'invalid-key-format',
        curve: 'P-384',
      }),
    });

    expect(response.ok).toBe(false);
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('should reject unsupported curve', async () => {
    const clientKeypair = await generateEphemeralKeypair('P-384');
    const clientPublicKeyDehydrated = dehydratePublicKey(clientKeypair.publicKey);

    const response = await fetch(`${baseUrl}/api/handshake`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        clientPublicKey: clientPublicKeyDehydrated,
        curve: 'P-521', // Unsupported curve
      }),
    });

    expect(response.ok).toBe(false);
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('should generate unique connection IDs for each handshake', async () => {
    // Perform two handshakes
    const handshakes = await Promise.all([
      performHandshake(),
      performHandshake(),
    ]);

    const [result1, result2] = handshakes;

    expect(result1.connectionId).not.toBe(result2.connectionId);
  });

  // Helper function
  async function performHandshake() {
    const clientKeypair = await generateEphemeralKeypair('P-384');
    const clientPublicKeyDehydrated = dehydratePublicKey(clientKeypair.publicKey);

    const response = await fetch(`${baseUrl}/api/handshake`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        clientPublicKey: clientPublicKeyDehydrated,
        curve: 'P-384',
      }),
    });

    return response.json();
  }
});
