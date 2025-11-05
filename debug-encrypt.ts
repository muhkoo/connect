import { encrypt, decrypt } from './src/crypto/encryption';
import { generateEphemeralKeypair, deriveSharedSecret } from './src/crypto/ecdh';

async function debugTest() {
  console.log('Generating keypairs...');
  const aliceKeypair = await generateEphemeralKeypair('P-256');
  const bobKeypair = await generateEphemeralKeypair('P-256');

  console.log('Deriving shared secret...');
  const sharedSecret = await deriveSharedSecret(aliceKeypair.privateKey, bobKeypair.publicKey);
  console.log('Shared secret (hex):', sharedSecret);
  console.log('Shared secret length:', sharedSecret.length, 'chars');
  console.log('Shared secret bytes:', sharedSecret.length / 2, 'bytes');
  console.log('Shared secret bits:', (sharedSecret.length / 2) * 8, 'bits');

  // Test 1: Simple message
  console.log('\n--- Test 1: Simple message ---');
  try {
    const plaintext1 = 'Hello, World!';
    console.log('Encrypting:', plaintext1);
    const ciphertext1 = await encrypt(sharedSecret, plaintext1);
    console.log('Encrypted successfully');
    console.log('Ciphertext:', ciphertext1);

    console.log('Decrypting...');
    const decrypted1 = await decrypt(sharedSecret, ciphertext1);
    console.log('Decrypted:', decrypted1);
    console.log('Match:', decrypted1 === plaintext1);
  } catch (error) {
    console.error('Error:', error);
  }

  // Test 2: Empty string
  console.log('\n--- Test 2: Empty string ---');
  try {
    const plaintext2 = '';
    console.log('Encrypting:', plaintext2);
    const ciphertext2 = await encrypt(sharedSecret, plaintext2);
    console.log('Encrypted successfully');
    console.log('Ciphertext:', ciphertext2);

    console.log('Decrypting...');
    const decrypted2 = await decrypt(sharedSecret, ciphertext2);
    console.log('Decrypted:', decrypted2);
    console.log('Match:', decrypted2 === plaintext2);
  } catch (error) {
    console.error('Error:', error);
  }
}

debugTest().catch(console.error);
