interface CipherMessageHeader {
  dhPub: string;
  prevChainLength: number;
  messageNumber: number;
  sessionId: string;
  sessionType: 'global' | 'specific';
  senderId: string;
  recipientId: string;
  timestamp: number;
  signature: string;
}

interface CipherMessage {
  header: CipherMessageHeader;
  ciphertext: string; // Hex-encoded
  nonce: string; // Hex-encoded
}

// interface RatchetState {
//   clientDhPriv: Uint8Array;
//   clientDhPub: Uint8Array;
//   serverDhPriv: Uint8Array;
//   serverDhPub: Uint8Array;
//   rootKey: Uint8Array | null;
//   sendChainKey: Uint8Array | null;
//   recvChainKey: Uint8Array | null;
//   sendCount: number;
//   recvCount: number;
//   prevChainLength: number;
//   skippedKeys: Map<number, Uint8Array>;
// }

// interface RatchetState {
//   clientDhPriv: CryptoKey | null; // ECDH private key
//   clientDhPub: CryptoKey; //
//   serverDhPriv: CryptoKey | null; // ECDH private key
//   serverDhPub: CryptoKey; // ECDH public key
//   rootKey: CryptoKey | null; // AES-GCM key
//   sendChainKey: CryptoKey | null; // AES-GCM key for sending
//   recvChainKey: CryptoKey | null; // AES-GCM key for receiving
//   sendCount: number; // Number of messages sent
//   recvCount: number; // Number of messages received
//   prevChainLength: number; // Length of the previous chain
//   skippedKeys: Map<number, CryptoKey>; // Skipped keys for messages
// }

interface RatchetState {
    clientDhPriv: CryptoKey  | null;
    clientDhPub: CryptoKey ;
    serverDhPriv: CryptoKey  | null;
    serverDhPub: CryptoKey ;
    // Symmetric key material (root key + chain keys + skipped message keys).
    // Stored as Uint8Array rather than Node's Buffer so this type works in the
    // browser/Workers builds.
    rootKey: Uint8Array | null;
    sendChainKey: Uint8Array | null;
    recvChainKey: Uint8Array | null;
    sendCount: number;
    recvCount: number;
    prevChainLength: number;
    currentSkippedKeys: Map<number, Uint8Array>;
    oldSkippedMessageKeys: Map<string, { skips: Map<number, Uint8Array>; created: number }>;
}

interface KeyPair {
  privateKey: Uint8Array | null; // ECDH private key
  publicKey: Uint8Array;
}

interface HexKeyPair {
  privateKey?: string;
  publicKey: string;
}

interface AuthKeyPair {
  privateKey: string; // PEM format for ECDSA
  publicKey: string; // PEM format for ECDSA
}

interface AuthToken {
  peerId: string;
  timestamp: number;
  signature: string; // ECDSA signature of peerId + timestamp
}

export type {
  CipherMessage,
  CipherMessageHeader,
  RatchetState
};