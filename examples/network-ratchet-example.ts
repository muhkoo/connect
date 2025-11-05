/**
 * Network Class Example with Double Ratchet Encryption
 *
 * This example demonstrates how to use the updated Network class with
 * the DoubleRatchetManager for end-to-end encrypted communication.
 */

import { Network } from '../src/network/Network';
import { Message } from '../src/messaging/Message';
import { KeyStore } from '../src/crypto/KeyStore';
import { appLogger } from '../src/core';

async function main() {
  console.log('🚀 Network Double Ratchet Example\n');

  // Setup logging
  appLogger.level = 'DEBUG';

  // Step 1: Define client and server identities
  const clientId = 'client-example';
  const serverId = 'server-example';

  console.log('1. Setting up client and server identities...');
  console.log(`   Client ID: ${clientId}`);
  console.log(`   Server ID: ${serverId}\n`);

  // Step 2: Initialize key store and generate keys
  console.log('2. Generating cryptographic keys...');
  const keyStore = KeyStore.getInstance();

  // Generate keys for client (this would normally happen once during setup)
  await keyStore.generateOwnKeyPair(clientId);
  const clientKeyPair = keyStore.getKeyPair(clientId);
  const clientAuthKeyPair = keyStore.getAuthKeyPair(clientId);

  console.log('   ✓ Client keys generated');
  console.log(`   ✓ ECDH Public Key: ${clientKeyPair?.publicKey ? '[Generated]' : '[Missing]'}`);
  console.log(`   ✓ ECDSA Auth Key: ${clientAuthKeyPair?.publicKey ? '[Generated]' : '[Missing]'}\n`);

  // In a real application, you would exchange public keys with the server
  // For this example, we'll assume the server keys are pre-shared
  console.log('3. Creating Network instance...');
  const network = new Network({
    url: 'ws://localhost:8787',
    clientId,
    serverId,
    sessionType: 'specific', // Use 'global' for broadcast mode
    autoReconnect: true,
    reconnectDelay: 3000,
    maxReconnectAttempts: 5,
  });

  // Listen for connection events
  network.addEventListener('connected', () => {
    console.log('   ✓ Connected to server');
    console.log(`   ✓ Session ID: ${network.getSessionId()}\n`);
  });

  network.addEventListener('disconnected', () => {
    console.log('   ⚠️ Disconnected from server\n');
  });

  network.addEventListener('error', (event: any) => {
    console.error('   ❌ Error:', event.detail.message);
  });

  network.addEventListener('reconnecting', (event: any) => {
    console.log(`   🔄 Reconnecting (attempt ${event.detail.attempt})...`);
  });

  // Listen for incoming messages
  network.addEventListener('message', (event: any) => {
    const packet = event.detail;
    console.log(`\n📨 Received packet:`);
    console.log(`   Subject: ${packet.subject}`);
    console.log(`   From: ${packet.source}`);
    if (packet.message) {
      console.log(`   Message:`, packet.message.body);
    }
  });

  // Step 4: Connect to server
  console.log('4. Connecting to WebSocket server...');
  try {
    await network.connect();
  } catch (error) {
    console.error('   ❌ Failed to connect:', error);
    // In a real app, you might want to handle handshake here
    // For demo purposes, we'll continue
  }

  // Wait a moment for connection to establish
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Step 5: Send encrypted messages
  console.log('5. Sending encrypted messages...');

  // Send a ping message
  console.log('   Sending ping...');
  await network.send({
    subject: 'ping',
    target: serverId,
    message: new Message({
      timestamp: Date.now(),
      body: { type: 'ping' }
    }),
  });
  console.log('   ✓ Ping sent (encrypted)\n');

  // Send a data message
  console.log('   Sending data message...');
  await network.send({
    subject: 'data',
    target: serverId,
    message: new Message({
      body: {
        action: 'update',
        data: {
          userId: clientId,
          status: 'active',
          timestamp: Date.now(),
        }
      }
    }),
  });
  console.log('   ✓ Data message sent (encrypted)\n');

  // Step 6: Subscribe to a topic (encrypted)
  console.log('6. Subscribing to topic...');
  await network.send({
    subject: 'subscribe',
    target: serverId,
    message: new Message({
      body: {
        topic: 'notifications',
        filters: { type: 'urgent', userId: clientId },
      }
    }),
  });
  console.log('   ✓ Subscription sent (encrypted)\n');

  // Step 7: Check encryption state
  console.log('7. Checking encryption state...');
  const ratchetManager = network.getRatchetManager();
  const sessionId = network.getSessionId();

  if (sessionId) {
    const sharedSecret = await ratchetManager.getSessionSharedSecret(sessionId);
    console.log(`   ✓ Session established: ${sessionId}`);
    console.log(`   ✓ Shared secret exists: ${sharedSecret !== null}`);
    console.log(`   ✓ End-to-end encryption: Active\n`);
  }

  // Keep connection alive for a bit to receive responses
  console.log('Waiting for responses...\n');
  await new Promise(resolve => setTimeout(resolve, 5000));

  // Step 8: Disconnect
  console.log('8. Disconnecting...');
  network.disconnect();
  console.log('   ✓ Disconnected\n');

  console.log('✅ Example completed!');
  console.log('\nNote: This example demonstrates the client side.');
  console.log('The server would need to implement the corresponding');
  console.log('DoubleRatchetManager to decrypt and respond to messages.');
}

// Run the example
main().catch(error => {
  console.error('❌ Example failed:', error);
  process.exit(1);
});