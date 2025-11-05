/**
 * Unified Network Example - Using PacketOptions for both REST and WebSocket
 *
 * This example demonstrates the unified approach where both WebSocket messages
 * and RESTful API calls use the same PacketOptions structure with Double Ratchet encryption.
 */

import { Network, NetworkError } from '../src/network/Network';
import { Message } from '../src/messaging/Message';
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
  console.log('🚀 Unified Network Example - PacketOptions for REST + WebSocket\n');

  // Setup logging
  appLogger.level = 'DEBUG';

  // Setup
  const clientId = 'unified-client';
  const serverId = 'api-server';

  console.log('1. Initializing unified Network...');
  const network = new Network({
    url: 'ws://localhost:8787/ws',
    apiUrl: 'http://localhost:8787',
    clientId,
    serverId,
    sessionType: 'specific',
    autoReconnect: true,
    httpTimeout: 15000,
    httpRetry: {
      maxRetries: 3,
      retryDelay: 1000,
    },
  });
  console.log('   ✓ Network initialized\n');

  // ============================================================================
  // RESTful API using PacketOptions
  // ============================================================================

  console.log('2. RESTful API calls using PacketOptions...\n');

  try {
    // GET request using PacketOptions
    console.log('   a) GET request - Fetch users');
    const getUsersResponse = await network.get<ApiResponse<User[]>>({
      subject: 'api.users',  // Will be converted to /api/users
      target: serverId,
      headers: {
        'Api-Version': '2.0',
        timeout: 5000,  // Override timeout for this request
      },
    });
    console.log(`      Status: ${getUsersResponse.status}`);
    console.log(`      Users: ${JSON.stringify(getUsersResponse.data, null, 2)}\n`);

    // POST request with Message body
    console.log('   b) POST request - Create user with Message');
    const newUser = {
      name: 'Bob',
      email: 'bob@example.com',
      password: 'encrypted-password',
    };

    const createUserResponse = await network.post<ApiResponse<User>>({
      subject: 'api.users',
      target: serverId,
      message: new Message({
        body: newUser,
        checksum: true,  // Add checksum verification
      }),
      headers: {
        'Operation': 'create',
      },
    });
    console.log(`      Status: ${createUserResponse.status}`);
    console.log(`      Created: ${JSON.stringify(createUserResponse.data, null, 2)}\n`);

    // PUT request with raw body in headers
    console.log('   c) PUT request - Update user with raw body');
    const updateUserResponse = await network.put<ApiResponse<User>>({
      subject: 'api.users.123',  // Will be converted to /api/users/123
      target: serverId,
      headers: {
        body: {  // Raw body in headers (will be encrypted)
          status: 'active',
          lastSeen: new Date().toISOString(),
        },
        retries: 5,  // Override retry count for this request
      },
    });
    console.log(`      Status: ${updateUserResponse.status}`);
    console.log(`      Updated: ${JSON.stringify(updateUserResponse.data, null, 2)}\n`);

    // DELETE request with packet metadata
    console.log('   d) DELETE request - Remove user');
    const deleteUserResponse = await network.delete<ApiResponse<{ deleted: boolean }>>({
      subject: 'api.users.456',
      target: serverId,
      ttl: 10000,  // Packet time-to-live
      headers: {
        'Reason': 'account-closed',
        'Authorized-By': 'admin',
      },
    });
    console.log(`      Status: ${deleteUserResponse.status}`);
    console.log(`      Result: ${JSON.stringify(deleteUserResponse.data, null, 2)}\n`);

    // PATCH request with complex message
    console.log('   e) PATCH request - Update settings');
    const patchResponse = await network.patch<ApiResponse<any>>({
      subject: 'api.users.123.settings',
      target: serverId,
      message: new Message({
        body: {
          notifications: {
            email: true,
            push: false,
            sms: true,
          },
          preferences: {
            theme: 'dark',
            language: 'en',
          },
        },
        metadata: {
          updatedBy: clientId,
          version: '1.0.0',
        },
      }),
    });
    console.log(`      Status: ${patchResponse.status}`);
    console.log(`      Settings: ${JSON.stringify(patchResponse.data, null, 2)}\n`);

  } catch (error) {
    if (error instanceof NetworkError) {
      console.error(`   ❌ REST Error: ${error.code} - ${error.message}`);
    } else {
      console.error(`   ❌ Error:`, error);
    }
  }

  // ============================================================================
  // WebSocket using same PacketOptions
  // ============================================================================

  console.log('3. WebSocket communication using same PacketOptions...\n');

  // Setup listeners
  network.on('connected', () => {
    console.log('   ✓ WebSocket connected');
  });

  network.on('message', (packet: any) => {
    console.log(`\n📨 WebSocket message:`);
    console.log(`   Subject: ${packet.subject}`);
    console.log(`   From: ${packet.source}`);
    if (packet.message) {
      console.log(`   Body:`, packet.message.body);
    }
  });

  // Connect
  try {
    await network.connect();
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Send WebSocket messages with same PacketOptions structure
    console.log('   a) Sending status update...');
    await network.send({
      subject: 'status.update',
      target: serverId,
      message: new Message({
        body: {
          status: 'online',
          activity: 'Testing unified API',
        },
      }),
      headers: {
        'Priority': 'high',
      },
    });
    console.log('      ✓ Status sent\n');

    // Send subscription request
    console.log('   b) Subscribing to events...');
    await network.send({
      subject: 'events.subscribe',
      target: serverId,
      message: new Message({
        body: {
          events: ['user.login', 'user.logout', 'system.alert'],
          filters: {
            severity: ['high', 'critical'],
          },
        },
      }),
    });
    console.log('      ✓ Subscribed\n');

  } catch (error) {
    console.error('   ❌ WebSocket error:', error);
  }

  // ============================================================================
  // Unified Workflow Example
  // ============================================================================

  console.log('4. Unified workflow - REST creates, WebSocket notifies...\n');

  // Create document via REST
  console.log('   Creating document via REST...');
  const docResponse = await network.post<ApiResponse<{ id: string; url: string }>>({
    subject: 'api.documents',
    target: serverId,
    message: new Message({
      body: {
        title: 'Project Plan',
        content: 'Encrypted content here',
        type: 'collaborative',
      },
    }),
    headers: {
      'Content-Type': 'document',
    },
  });

  if (docResponse.data?.id) {
    console.log(`   ✓ Document created: ${docResponse.data.id}\n`);

    // Notify via WebSocket using same packet structure
    console.log('   Notifying via WebSocket...');
    await network.send({
      subject: 'document.created',
      target: 'broadcast',
      message: new Message({
        body: {
          documentId: docResponse.data.id,
          url: docResponse.data.url,
          createdBy: clientId,
        },
      }),
      headers: {
        'Notification-Type': 'broadcast',
        'Priority': 'normal',
      },
    });
    console.log('   ✓ Notification sent\n');
  }

  // ============================================================================
  // Advanced PacketOptions Features
  // ============================================================================

  console.log('5. Advanced PacketOptions features...\n');

  // Request with all packet options
  const advancedResponse = await network.post<any>({
    subject: 'api.advanced.operation',
    target: serverId,
    message: new Message({
      body: {
        operation: 'complex-task',
        parameters: {
          mode: 'async',
          priority: 1,
        },
      },
      checksum: true,
      metadata: {
        requestId: 'req-' + Date.now(),
        clientVersion: '2.0.0',
      },
    }),
    ttl: 30000,  // 30 second TTL
    headers: {
      timeout: 20000,  // 20 second timeout
      retries: 2,      // 2 retries
      'X-Custom-Header': 'custom-value',
      'Trace-Id': 'trace-' + Date.now(),
    },
  });

  console.log(`   Response Status: ${advancedResponse.status}`);
  console.log(`   Packet Headers Used:`, Object.keys(advancedResponse.headers).filter(k => k.startsWith('X-')));

  // Show encryption info
  console.log('\n6. Encryption status:');
  const sessionId = network.getSessionId();
  if (sessionId) {
    console.log(`   ✓ Session: ${sessionId}`);
    console.log(`   ✓ All REST calls: End-to-end encrypted`);
    console.log(`   ✓ All WebSocket messages: End-to-end encrypted`);
    console.log(`   ✓ Packet structure: Unified across protocols`);
  }

  // Wait and cleanup
  await new Promise(resolve => setTimeout(resolve, 2000));

  console.log('\n7. Cleanup...');
  network.disconnect();
  console.log('   ✓ Disconnected\n');

  console.log('✅ Example completed!');
  console.log('\n📝 Key Points:');
  console.log('   - Same PacketOptions structure for REST and WebSocket');
  console.log('   - Packet headers are preserved and forwarded');
  console.log('   - Message body is always encrypted with Double Ratchet');
  console.log('   - Subject can be used as REST endpoint path');
  console.log('   - Unified error handling and retry logic');
}

// Run the example
main().catch(error => {
  console.error('❌ Example failed:', error);
  process.exit(1);
});