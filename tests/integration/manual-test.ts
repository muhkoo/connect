/**
 * Manual Integration Test
 * Run Accelerator manually, then run: tsx tests/integration/manual-test.ts
 */

import { generateEphemeralKeypair, dehydratePublicKey, hydratePublicKey, deriveSharedSecret } from '../../src/crypto/ecdh';

const ACCELERATOR_URL = 'http://localhost:8787';

async function testHandshake() {
  console.log('Testing ECDH handshake with Accelerator...\n');

  // 1. Generate client keypair
  console.log('1. Generating client ephemeral keypair (P-384)...');
  const clientKeypair = await generateEphemeralKeypair('P-384');
  const clientPublicKey = dehydratePublicKey(clientKeypair.publicKey);
  console.log('   ✓ Client public key:', clientPublicKey.substring(0, 50) + '...\n');

  // 2. Send handshake request
  console.log('2. Sending handshake request to Accelerator...');
  const response = await fetch(`${ACCELERATOR_URL}/api/handshake`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientPublicKey,
      curve: 'P-384',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Handshake failed: ${response.status} ${error}`);
  }

  const result = await response.json();
  console.log('   ✓ Received server response');
  console.log('   - Connection ID:', result.connectionId);
  console.log('   - Server public key:', result.serverPublicKey.substring(0, 50) + '...');
  console.log('   - Expires at:', new Date(result.expiresAt).toISOString(), '\n');

  // 3. Derive shared secret
  console.log('3. Deriving shared secret on client side...');
  const serverPublicKey = hydratePublicKey(result.serverPublicKey);
  const sharedSecret = await deriveSharedSecret(clientKeypair.privateKey, serverPublicKey);
  console.log('   ✓ Shared secret derived:', sharedSecret.substring(0, 32) + '...\n');

  console.log('✅ ECDH Handshake successful!\n');
  console.log('Summary:');
  console.log('  - Client and server established shared secret');
  console.log('  - Connection ID:', result.connectionId);
  console.log('  - Shared secret length:', sharedSecret.length, 'characters (256-bit)');
}

// Run test
console.log('='.repeat(60));
console.log('MANUAL INTEGRATION TEST');
console.log('='.repeat(60), '\n');
console.log('Prerequisites:');
console.log('  1. Start Accelerator: cd ../accelerator && yarn dev');
console.log('  2. Wait for "Ready on http://localhost:8787"');
console.log('  3. Run this test: tsx tests/integration/manual-test.ts\n');
console.log('='.repeat(60), '\n');

testHandshake()
  .then(() => {
    console.log('='.repeat(60));
    console.log('Test completed successfully!');
    console.log('='.repeat(60));
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Test failed:', error.message);
    console.error('\nMake sure Accelerator is running on http://localhost:8787');
    process.exit(1);
  });
