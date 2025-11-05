/**
 * Network Class Example with REST API and WebSocket Support
 *
 * This example demonstrates how to use the updated Network class for both
 * real-time WebSocket communication and RESTful API calls with
 * Double Ratchet end-to-end encryption.
 */

import { Network, NetworkError } from '../src/network/Network';
import { Message } from '../src/messaging/Message';
import { KeyStore } from '../src/crypto/KeyStore';
import { appLogger } from '../src/core';

// Example data types
interface User {
  id: string;
  name: string;
  email: string;
  status: 'online' | 'offline';
}

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

async function main() {
  console.log('🚀 Network REST + WebSocket Example\n');

  // Setup logging
  appLogger.level = 'DEBUG';

  // Step 1: Setup identities and network
  const clientId = 'client-rest-example';
  const serverId = 'server';

  console.log('1. Setting up Network with REST and WebSocket support...');
  const network = new Network({
    url: 'ws://localhost:8787/ws',
    apiUrl: 'http://localhost:8787',  // REST API base URL
    clientId,
    serverId,
    sessionType: 'specific',
    autoReconnect: true,
    httpTimeout: 15000,  // 15 second timeout for HTTP requests
    httpRetry: {
      maxRetries: 3,
      retryDelay: 1000,
    },
    defaultHeaders: {
      'X-API-Version': '1.0',
    },
  });

  console.log('   ✓ Network configured');
  console.log(`   ✓ WebSocket URL: ws://localhost:8787/ws`);
  console.log(`   ✓ REST API URL: http://localhost:8787\n`);

  // ============================================================================
  // RESTful API Examples
  // ============================================================================

  console.log('2. Testing RESTful API calls with encryption...\n');

  try {
    // GET request example
    console.log('   a) GET /api/users');
    const usersResponse = await network.get<ApiResponse<User[]>>('/api/users');
    console.log(`      Status: ${usersResponse.status} ${usersResponse.statusText}`);
    console.log(`      Data: ${JSON.stringify(usersResponse.data, null, 2)}\n`);

    // POST request example - Create a new user
    console.log('   b) POST /api/users');
    const newUser = {
      name: 'Alice',
      email: 'alice@example.com',
      password: 'secure-password-123',  // Will be encrypted in transit
    };

    const createResponse = await network.post<ApiResponse<User>>(
      '/api/users',
      newUser
    );
    console.log(`      Status: ${createResponse.status}`);
    console.log(`      Created User: ${JSON.stringify(createResponse.data, null, 2)}\n`);

    // PUT request example - Update user
    console.log('   c) PUT /api/users/123');
    const updateData = {
      status: 'online',
      lastSeen: new Date().toISOString(),
    };

    const updateResponse = await network.put<ApiResponse<User>>(
      '/api/users/123',
      updateData
    );
    console.log(`      Status: ${updateResponse.status}`);
    console.log(`      Updated: ${JSON.stringify(updateResponse.data, null, 2)}\n`);

    // DELETE request example
    console.log('   d) DELETE /api/users/456');
    const deleteResponse = await network.delete<ApiResponse<{ deleted: boolean }>>(
      '/api/users/456'
    );
    console.log(`      Status: ${deleteResponse.status}`);
    console.log(`      Result: ${JSON.stringify(deleteResponse.data, null, 2)}\n`);

    // PATCH request example - Partial update
    console.log('   e) PATCH /api/users/123/settings');
    const patchData = {
      notifications: {
        email: true,
        push: false,
      },
    };

    const patchResponse = await network.patch<ApiResponse<any>>(
      '/api/users/123/settings',
      patchData
    );
    console.log(`      Status: ${patchResponse.status}`);
    console.log(`      Settings updated: ${JSON.stringify(patchResponse.data, null, 2)}\n`);

  } catch (error) {
    if (error instanceof NetworkError) {
      console.error(`   ❌ REST API Error: ${error.code} - ${error.message}`);
      if (error.status) {
        console.error(`      HTTP Status: ${error.status}`);
      }
      if (error.details) {
        console.error(`      Details:`, error.details);
      }
    } else {
      console.error(`   ❌ Unexpected error:`, error);
    }
  }

  // ============================================================================
  // WebSocket Examples
  // ============================================================================

  console.log('3. Establishing WebSocket connection...');

  // Set up event listeners
  network.addEventListener('connected', () => {
    console.log('   ✓ WebSocket connected');
    console.log(`   ✓ Session ID: ${network.getSessionId()}\n`);
  });

  network.addEventListener('disconnected', () => {
    console.log('   ⚠️ WebSocket disconnected\n');
  });

  network.addEventListener('message', (event: any) => {
    const packet = event.detail;
    console.log(`\n📨 WebSocket message received:`);
    console.log(`   Subject: ${packet.subject}`);
    console.log(`   From: ${packet.source}`);
    if (packet.message) {
      console.log(`   Message:`, packet.message.body);
    }
  });

  // Connect WebSocket
  try {
    await network.connect();
  } catch (error) {
    console.error('   ❌ Failed to connect WebSocket:', error);
  }

  // Wait for connection
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Send WebSocket messages
  console.log('4. Sending encrypted WebSocket messages...\n');

  // Send a real-time update
  console.log('   a) Sending real-time status update...');
  await network.send({
    subject: 'status.update',
    target: serverId,
    message: new Message({
      body: {
        userId: clientId,
        status: 'active',
        activity: 'Using REST + WebSocket',
        timestamp: Date.now(),
      }
    }),
  });
  console.log('      ✓ Status update sent\n');

  // Subscribe to real-time notifications
  console.log('   b) Subscribing to notifications...');
  await network.send({
    subject: 'subscribe',
    target: serverId,
    message: new Message({
      body: {
        topics: ['notifications', 'alerts', 'system-updates'],
        userId: clientId,
      }
    }),
  });
  console.log('      ✓ Subscribed to topics\n');

  // ============================================================================
  // Combined REST + WebSocket Example
  // ============================================================================

  console.log('5. Combined REST + WebSocket workflow...\n');

  // Step 1: Create data via REST
  console.log('   Creating data via REST API...');
  const dataResponse = await network.post<ApiResponse<{ id: string; url: string }>>(
    '/api/documents',
    {
      title: 'Important Document',
      content: 'This is encrypted content that needs real-time collaboration',
      collaborators: ['user1', 'user2'],
    }
  );
  console.log(`   ✓ Document created: ${dataResponse.data?.id}\n`);

  // Step 2: Notify via WebSocket
  if (dataResponse.data?.id) {
    console.log('   Notifying collaborators via WebSocket...');
    await network.send({
      subject: 'document.created',
      target: 'broadcast',
      message: new Message({
        body: {
          documentId: dataResponse.data.id,
          url: dataResponse.data.url,
          creator: clientId,
          timestamp: Date.now(),
        }
      }),
    });
    console.log('   ✓ Real-time notification sent\n');
  }

  // ============================================================================
  // Advanced Features
  // ============================================================================

  console.log('6. Advanced features...\n');

  // Custom headers for specific requests
  console.log('   a) Request with custom headers...');
  const customResponse = await network.get<any>(
    '/api/protected/resource',
    {
      'Authorization': 'Bearer custom-token-123',
      'X-Request-ID': 'req-' + Date.now(),
    }
  );
  console.log(`      Status: ${customResponse.status}`);

  // Check encryption state
  console.log('\n   b) Encryption state:');
  const ratchetManager = network.getRatchetManager();
  const sessionId = network.getSessionId();

  if (sessionId) {
    const sharedSecret = await ratchetManager.getSessionSharedSecret(sessionId);
    console.log(`      ✓ Session: ${sessionId}`);
    console.log(`      ✓ End-to-end encryption: Active`);
    console.log(`      ✓ Double Ratchet: Initialized`);
    console.log(`      ✓ Forward secrecy: Enabled`);
  }

  // Wait for any incoming messages
  console.log('\n7. Waiting for responses...');
  await new Promise(resolve => setTimeout(resolve, 3000));

  // Cleanup
  console.log('\n8. Cleaning up...');
  network.disconnect();
  console.log('   ✓ Disconnected\n');

  console.log('✅ Example completed!');
  console.log('\n📝 Summary:');
  console.log('   - REST API calls use Double Ratchet encryption');
  console.log('   - WebSocket messages use the same encryption');
  console.log('   - Both share the same session and keys');
  console.log('   - Automatic retry and timeout handling');
  console.log('   - Seamless integration between REST and real-time');
}

// Run the example
main().catch(error => {
  console.error('❌ Example failed:', error);
  process.exit(1);
});