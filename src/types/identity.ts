/**
 * Shared identity types for Connect and Accelerator
 */

/**
 * User identity - public key is the primary identifier
 */
export interface UserIdentity {
  publicKey: string;  // Dehydrated public key (primary identity)
  accountType: 'self-sovereign' | 'custodial';
  did?: string;       // Optional DID for self-sovereign users
  provider?: string;  // OAuth provider for custodial users
  createdAt: number;
}

/**
 * Session
 */
export interface Session {
  sessionId: string;
  publicKey: string;  // User's identity
  appPublicKey: string;
  createdAt: number;
  expiresAt: number;
  sharedSecret?: string;
}

/**
 * Authentication types
 */
export type AuthType = 'self-sovereign' | 'custodial';

/**
 * OAuth provider types
 */
export type OAuthProvider = 'google' | 'github' | 'discord' | 'twitter';
