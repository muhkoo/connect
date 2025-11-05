/**
 * Network Class Example
 *
 * This example demonstrates how to use the Network class for real-time
 * communication with the Accelerator server using the Packet/Message protocol.
 */

import { Network, SessionManager } from '../src';
import { Message } from '../src/messaging/Message';

async function main() {
  console.log('🚀 Network Example\n');

  // Step 1: Create a session
  console.log('1. Creating session...');
  const sessionManager = new SessionManager();

  // In a real app, you'd provide your app's public key
  const appPublicKey = 'your-app-public-key';

  // Create session with automatic server handshake
  const sessionId = await sessionManager.createServerSession('P-384', appPublicKey, 'http://localhost:8787');
  console.log(`   ✓ Session created: ${sessionId}`);
  console.log(`   ✓ Client public key: ${sessionManager.getPublicKey()}\n`);

  // Step 2: Connect to WebSocket
  console.log('2. Connecting to WebSocket...');
  const network = new Network({
    url: `ws://localhost:8787/ws?appPublicKey=${appPublicKey}&sessionId=${sessionId}`,
    sessionManager,
    autoReconnect: true,
  });

  // Listen for connection events
  network.addEventListener('connected', () => {
    console.log('   ✓ Connected to server\n');
  });

  network.addEventListener('disconnected', () => {
    console.log('   ⚠️ Disconnected from server\n');
  });

  network.addEventListener('error', (event: CustomEvent<Error>) => {
    console.error('   ❌ Error:', event.detail.message);
  });

  network.addEventListener('reconnecting', (event: CustomEvent<{ attempt: number }>) => {
    console.log(`   🔄 Reconnecting (attempt ${event.detail.attempt})...`);
  });

  // Listen for incoming messages
  network.addEventListener('message', (event: CustomEvent<any>) => {
    const packet = event.detail;
    console.log(`\n📨 Received packet:`);
    console.log(`   Subject: ${packet.subject}`);
    console.log(`   From: ${packet.source}`);
    console.log(`   Message:`, packet.message?.body);
  });

  // Connect
  await network.connect();

  // Step 3: Send a ping message
  console.log('3. Sending ping message...');
  await network.send({
    subject: 'ping',
    target: 'server',
    message: new Message({ timestamp: Date.now() }),
  });
  console.log('   ✓ Ping sent\n');

  // Step 4: Subscribe to a topic
  console.log('4. Subscribing to topic...');
  await network.send({
    subject: 'subscribe',
    target: 'server',
    message: new Message({
      topic: 'notifications',
      filters: { type: 'urgent' },
    }),
  });
  console.log('   ✓ Subscription sent\n');

  // Step 5: Publish an event
  console.log('5. Publishing event...');
  await network.send({
    subject: 'publish',
    target: 'server',
    message: new Message({
      topic: 'notifications',
      event: {
        type: 'urgent',
        title: 'System Alert',
        body: 'This is a test notification',
        timestamp: Date.now(),
      },
    }),
  });
  console.log('   ✓ Event published\n');

  // Step 6: Send direct message
  console.log('6. Sending direct message...');
  await network.send({
    subject: 'send',
    target: 'server',
    message: new Message({
      toUserId: 'another-user-id',
      message: {
        text: 'Hello from Network example!',
        timestamp: Date.now(),
      },
    }),
  });
  console.log('   ✓ Direct message sent\n');

  // Keep connection alive for a bit to receive responses
  console.log('Waiting for responses...\n');
  await new Promise(resolve => setTimeout(resolve, 5000));

  // Disconnect
  console.log('7. Disconnecting...');
  network.disconnect();
  console.log('   ✓ Disconnected\n');

  console.log('✅ Example completed!');
}

// Run the example
main().catch(error => {
  console.error('❌ Example failed:', error);
  process.exit(1);
});
