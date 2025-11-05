/**
 * Basic Usage Example
 * Demonstrates end-to-end encrypted communication with Cloudflare Workers backend
 */

import { ApiClient } from '../src/api/client';
import type { UserIdentity } from '../src/types';

// ============================================================================
// 1. Initialize the API Client
// ============================================================================

const client = new ApiClient({
  baseUrl: 'https://api.example.com',
  timeout: 30000,
});

// ============================================================================
// 2. Create Session (ECDH Key Exchange)
// ============================================================================

async function authenticateUser() {
  try {
    // Client generates ephemeral keypair and sends public key to server
    // Server responds with its public key
    // Both derive the same shared secret using ECDH
    const session = await client.createSession();

    console.log('✅ Session created:', {
      sessionId: session.sessionId,
      expiresAt: new Date(session.expiresAt).toISOString(),
    });

    // Server's encrypted identity response is automatically decrypted
    const identity = await client.getSessionManager().decryptJSON<UserIdentity>(
      session.identity
    );

    console.log('📋 User Identity:', identity);

    return session;
  } catch (error) {
    console.error('❌ Authentication failed:', error);
    throw error;
  }
}

// ============================================================================
// 3. Send Encrypted Message
// ============================================================================

async function sendEncryptedMessage() {
  try {
    const messageData = {
      text: 'Hello, secure world!',
      timestamp: Date.now(),
      metadata: {
        priority: 'high',
        tags: ['urgent', 'encrypted'],
      },
    };

    // Message is automatically encrypted with shared secret before sending
    const response = await client.sendMessage(
      'chat:general',
      messageData
    );

    console.log('✅ Message sent:', {
      messageId: response.messageId,
      timestamp: new Date(response.timestamp).toISOString(),
    });

    return response;
  } catch (error) {
    console.error('❌ Failed to send message:', error);
    throw error;
  }
}

// ============================================================================
// 4. Receive and Decrypt Messages
// ============================================================================

async function fetchEncryptedMessages() {
  try {
    const response = await client.fetchMessages('chat:general', Date.now() - 3600000, 50);

    console.log(`📬 Fetched ${response.messages.length} encrypted messages`);

    // Decrypt each message
    const decryptedMessages = await Promise.all(
      response.messages.map(async (msg) => {
        const decrypted = await client.decryptMessage(msg.encryptedData);
        return {
          id: msg.id,
          from: msg.senderPublicKey,
          data: decrypted,
          timestamp: new Date(msg.timestamp).toISOString(),
        };
      })
    );

    console.log('📝 Decrypted messages:', decryptedMessages);

    return decryptedMessages;
  } catch (error) {
    console.error('❌ Failed to fetch messages:', error);
    throw error;
  }
}

// ============================================================================
// 5. Store Encrypted Data
// ============================================================================

async function storeEncryptedData() {
  try {
    const userData = {
      preferences: {
        theme: 'dark',
        notifications: true,
      },
      settings: {
        language: 'en',
        timezone: 'UTC',
      },
    };

    // Data is automatically encrypted before storage
    const response = await client.storeData(
      'user:preferences',
      userData,
      'settings'
    );

    console.log('💾 Data stored:', {
      key: response.key,
      version: response.version,
      timestamp: new Date(response.timestamp).toISOString(),
    });

    return response;
  } catch (error) {
    console.error('❌ Failed to store data:', error);
    throw error;
  }
}

// ============================================================================
// 6. Retrieve and Decrypt Data
// ============================================================================

async function retrieveEncryptedData() {
  try {
    // Data is automatically decrypted after retrieval
    const userData = await client.retrieveData<{
      preferences: any;
      settings: any;
    }>('user:preferences', 'settings');

    console.log('📦 Retrieved data:', userData);

    return userData;
  } catch (error) {
    console.error('❌ Failed to retrieve data:', error);
    throw error;
  }
}

// ============================================================================
// 7. Check Permissions
// ============================================================================

async function checkResourcePermission() {
  try {
    const canWrite = await client.checkPermission(
      'document:abc123',
      'write'
    );

    console.log('🔐 Permission check:', { canWrite });

    return canWrite;
  } catch (error) {
    console.error('❌ Failed to check permission:', error);
    throw error;
  }
}

// ============================================================================
// 8. Grant Permissions
// ============================================================================

async function grantUserPermission(userPublicKey: string) {
  try {
    const response = await client.grantPermission(
      'document:abc123',
      userPublicKey,
      ['read', 'write']
    );

    console.log('✅ Permissions granted:', {
      resource: response.resource,
      user: response.userPublicKey,
      permissions: response.permissions,
    });

    return response;
  } catch (error) {
    console.error('❌ Failed to grant permission:', error);
    throw error;
  }
}

// ============================================================================
// 9. Complete Example Flow
// ============================================================================

async function completeExample() {
  console.log('🚀 Starting complete E2E encrypted example...\n');

  try {
    // Step 1: Authenticate and establish encrypted session
    console.log('Step 1: Authentication');
    await authenticateUser();
    console.log('');

    // Step 2: Send encrypted message
    console.log('Step 2: Send encrypted message');
    await sendEncryptedMessage();
    console.log('');

    // Step 3: Fetch and decrypt messages
    console.log('Step 3: Fetch encrypted messages');
    await fetchEncryptedMessages();
    console.log('');

    // Step 4: Store encrypted data
    console.log('Step 4: Store encrypted data');
    await storeEncryptedData();
    console.log('');

    // Step 5: Retrieve and decrypt data
    console.log('Step 5: Retrieve encrypted data');
    await retrieveEncryptedData();
    console.log('');

    // Step 6: Check permissions
    console.log('Step 6: Check permissions');
    await checkResourcePermission();
    console.log('');

    console.log('✅ Complete example finished successfully!');
  } catch (error) {
    console.error('❌ Example failed:', error);
  } finally {
    // Clean up: logout
    client.logout();
    console.log('👋 Session cleared');
  }
}

// ============================================================================
// 10. Direct Encryption/Decryption (without API)
// ============================================================================

async function directEncryptionExample() {
  const { generateEphemeralKeypair, deriveSharedSecret } = await import('../src/crypto/ecdh');
  const { encrypt, decrypt } = await import('../src/crypto/encryption');

  // Generate two keypairs (simulating Alice and Bob)
  const aliceKeypair = await generateEphemeralKeypair('P-256');
  const bobKeypair = await generateEphemeralKeypair('P-256');

  // Alice derives shared secret with Bob's public key
  const aliceSharedSecret = await deriveSharedSecret(
    aliceKeypair.privateKey,
    bobKeypair.publicKey
  );

  // Bob derives the same shared secret with Alice's public key
  const bobSharedSecret = await deriveSharedSecret(
    bobKeypair.privateKey,
    aliceKeypair.publicKey
  );

  console.log('🔑 Shared secrets match:', aliceSharedSecret === bobSharedSecret);

  // Alice encrypts a message
  const message = 'Secret message from Alice to Bob';
  const encrypted = await encrypt(aliceSharedSecret, message);
  console.log('🔒 Encrypted:', encrypted);

  // Bob decrypts the message
  const decrypted = await decrypt(bobSharedSecret, encrypted);
  console.log('🔓 Decrypted:', decrypted);
  console.log('✅ Messages match:', message === decrypted);
}

// Run the example
if (require.main === module) {
  completeExample();
}

export {
  authenticateUser,
  sendEncryptedMessage,
  fetchEncryptedMessages,
  storeEncryptedData,
  retrieveEncryptedData,
  checkResourcePermission,
  grantUserPermission,
  directEncryptionExample,
};
