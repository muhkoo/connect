/**
 * Shared cryptographic types for Connect and Accelerator
 */

/**
 * Supported ECDH curves
 */
export type ECDHCurve = 'P-256' | 'P-384';

/**
 * JSON Web Key format for public keys
 */
export interface PublicKeyJWK {
  kty: 'EC';
  crv: 'P-256' | 'P-384';
  x: string;
  y: string;
  ext?: boolean;
}

/**
 * Keypair with dehydrated public key (JWK) and CryptoKey private key
 */
export interface Keypair {
  publicKey: PublicKeyJWK;
  privateKey: CryptoKey;
}

/**
 * Dehydrated keypair (both keys as strings for transport/storage)
 */
export interface DehydratedKeypair {
  publicKey: string;  // Dehydrated JWK (base64url)
  privateKey: string; // Dehydrated JWK (base64url)
}
