import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import { subtle } from 'crypto';

import { DoubleRatchetManager } from '../../src/crypto/DoubleRatchetManager';
import { KeyStore } from '../../src/crypto/KeyStore';
import { PreimagePoK,AuthPublicInput } from '../../src/crypto/ZeroKnowledge';
import { Field, Poseidon } from 'o1js';

const _dir = './tests/v1/crypto/keys';
// Cleanup JSON files before and after tests
async function cleanupFiles() {
  const files = await fs.readdir(_dir);
  console.log('Cleaning up files:', files);
  for (const file of files) {
    if (file.endsWith('.json')) {
      await fs.unlink(_dir + `/${file}`).catch(() => { });
    }
  }
}

describe('Double Ratchet with ZK Registration and JWK/Base58 Keys', () => {
  let verificationKey: { data: string; hash: Field };

  beforeAll(async () => {
    await cleanupFiles();
    appLogger.debug('Compiling PreimagePoK...');
    const compiled = await PreimagePoK.compile();
    verificationKey = compiled.verificationKey;
  }, 20000);

  afterAll(async () => {
    // await cleanupFiles();
  });

  it('should register with JWK keys, perform ZK handshake, and communicate (1:1)', async () => {
    const clientId = 'client1';
    const serverId = 'server1';
    const keyStore = KeyStore.getInstance();
    const clientManager = new DoubleRatchetManager(clientId);
    const serverManager = new DoubleRatchetManager(serverId);

    // Generate keys
    const clientKeyPair = await keyStore.generateOwnKeyPair(clientId);
    const clientAuthKeyPair = keyStore.getAuthKeyPair(clientId)!;
    const serverKeyPair = await keyStore.generateOwnKeyPair(serverId);
    const serverAuthKeyPair = keyStore.getAuthKeyPair(serverId)!;
    const clientDehydrated = await keyStore.dehydrateKeyPair(clientId);
    const compressedKeys = await keyStore.compressDehydratedKeys(clientId);
    appLogger.debug(`Developer view - Client ${clientId} keys:`, {
      ecdhPub: clientDehydrated.ecdhPub.slice(0, 16) + '...',
      ecdsaPriv: clientDehydrated.ecdsaPriv.slice(0, 16) + '...',
      compressed: compressedKeys
    });


    console.log('Compressed Keys:', compressedKeys);

    await keyStore.hydrateFromCompressed(clientId, compressedKeys);

    console.log(clientDehydrated)

    // Register
    const secret = Field.random();
    const salt = Field.random();
    await serverManager.registerZK(
      clientId,
      secret,
      salt,
      clientAuthKeyPair.publicKey)

    // Handshake
    const nonce = Field.random();
    const ecdhJwk = await subtle.exportKey('jwk', clientKeyPair.publicKey);
    const ecdsaJwk = await subtle.exportKey('jwk', clientAuthKeyPair.publicKey);
    const ecdhHex = '0x' + Buffer.from(ecdhJwk.x!, 'base64url').toString('hex').slice(0, 64);
    console.log('ECDH Public Key Hex:', ecdhHex);
    const ecdsaHex = '0x' + Buffer.from(ecdsaJwk.x!, 'base64url').toString('hex').slice(0, 64);
    console.log('ECDSA Public Key Hex:', ecdsaHex);
    const ecdsaPubField = Field(BigInt(ecdsaHex));
    const ecdsaPubHash = Poseidon.hash([ecdsaPubField]);
    const commitment = Poseidon.hash([secret, salt, ecdsaPubHash]);
    const publicInput = new AuthPublicInput({
      commitment,
      nonce,
      ecdsaPubHash,
    });
    const { proof } = await PreimagePoK.proveKnowledge(publicInput, secret, salt, ecdsaPubField);
    // senderId: string,
    // recipientId: string,
    // zkProof: any,
    // publicInput: AuthPublicInput,
    // clientPublicKey: CryptoKey, // ECDH pub for session
    // clientAuthPublicKey: CryptoKey, // ECDSA pub for auth
    // authToken: AuthToken // Client-generated token
    // Client generates auth token
    const authToken = await clientManager.authenticator.generateAuthToken(clientId, clientAuthKeyPair.privateKey!);
    await serverManager.performHandshake(
      clientId,
      serverId,
      proof,
      publicInput,
      clientKeyPair.publicKey,
      clientAuthKeyPair.publicKey,
      authToken
    );

    // Communicate
    const sessionId = await clientManager.initializeSession(clientId, serverId, true, 'specific');
    appLogger.debug(`Session initialized: ${sessionId}`);
    await serverManager.initializeSession(serverId, clientId, false, 'specific', sessionId);
    appLogger.debug('fasdfasdfasfdas', clientId, serverId, sessionId, 'Secure message', false, 'specific')
    const message = await serverManager.encrypt(clientId, serverId, sessionId, 'Secure message', false, 'specific');
    const plaintext = await serverManager.decrypt(message, false);
    expect(plaintext).toBe('Secure message');
  });

  it('should support broadcast with JWK/Base58 keys and multiple client decryption', async () => {
    const serverManager = new DoubleRatchetManager('global-server');
    const client1Manager = new DoubleRatchetManager('global-client1');
    const client2Manager = new DoubleRatchetManager('global-client2');
    const client3Manager = new DoubleRatchetManager('global-client3');
    const keyStore = KeyStore.getInstance();

    // Generate keys
    const serverKeyPair = await keyStore.generateOwnKeyPair('global-server');
    const serverAuthKeyPair = keyStore.getAuthKeyPair('global-server')!;
    const clientKeyPair = await keyStore.generateOwnKeyPair('global-client');
    const clientAuthKeyPair = keyStore.getAuthKeyPair('global-client')!;
    const serverDehydrated = await keyStore.dehydrateKeyPair('global-server');
    appLogger.debug(`Developer view - Server keys:`, {
      ecdhPub: serverDehydrated.ecdhPub.slice(0, 16) + '...',
      ecdsaPriv: serverDehydrated.ecdsaPriv.slice(0, 16) + '...'
    });

    // Pre-share keys
    await keyStore.storeRemotePublicKeys('global-server', serverKeyPair.publicKey, serverAuthKeyPair.publicKey);
    await keyStore.storeRemotePublicKeys('global-client', clientKeyPair.publicKey, clientAuthKeyPair.publicKey);
    await serverManager.addTrustedServer('global-server', serverAuthKeyPair.publicKey);
    await client1Manager.addTrustedServer('global-server', serverAuthKeyPair.publicKey);
    await client2Manager.addTrustedServer('global-server', serverAuthKeyPair.publicKey);
    await client3Manager.addTrustedServer('global-server', serverAuthKeyPair.publicKey);

    // Initialize broadcast session
    const sessionId = await serverManager.initializeSession('global-server', 'global-client', false, 'global');
    await client1Manager.initializeSession('global-client', 'global-server', true, 'global', sessionId);
    await client2Manager.initializeSession('global-client', 'global-server', true, 'global', sessionId);
    await client3Manager.initializeSession('global-client', 'global-server', true, 'global', sessionId);

    // Broadcast two messages
    const broadcastMessage1 = await serverManager.encrypt(
      'global-server',
      'global-client',
      sessionId,
      'Broadcast: System update #1',
      false,
      'global'
    );
    const broadcastMessage2 = await serverManager.encrypt(
      'global-server',
      'global-client',
      sessionId,
      'Broadcast: System update #2',
      false,
      'global'
    );

    // Client 1 decrypts both
    const plaintext1_1 = await client1Manager.decrypt(broadcastMessage1, true);
    expect(plaintext1_1).toBe('Broadcast: System update #1');
    const plaintext1_2 = await client1Manager.decrypt(broadcastMessage2, true);
    expect(plaintext1_2).toBe('Broadcast: System update #2');

    // Client 2 decrypts both
    const plaintext2_1 = await client2Manager.decrypt(broadcastMessage1, true);
    expect(plaintext2_1).toBe('Broadcast: System update #1');
    const plaintext2_2 = await client2Manager.decrypt(broadcastMessage2, true);
    expect(plaintext2_2).toBe('Broadcast: System update #2');

    // Client 3 misses first, decrypts second, then first
    const plaintext3_2 = await client3Manager.decrypt(broadcastMessage2, true);
    expect(plaintext3_2).toBe('Broadcast: System update #2');
    const plaintext3_1 = await client3Manager.decrypt(broadcastMessage1, true);
    expect(plaintext3_1).toBe('Broadcast: System update #1');
  });
});