/**
 * Shared permission types for Connect and Accelerator
 */

/**
 * Permission types for resources
 */
export type Permission = 'read' | 'write' | 'delete' | 'admin' | 'share' | 'invite';

/**
 * Role types
 */
export type Role = 'owner' | 'admin' | 'editor' | 'viewer' | 'member';

/**
 * ACL Entry - grants permissions to a user (identified by public key)
 */
export interface ACLEntry {
  subject: string;  // Public key (dehydrated)
  permissions: Permission[];
  role?: Role;
  expiresAt?: number;
  conditions?: {
    ipAllowlist?: string[];
    ipBlocklist?: string[];
    validAfter?: number;
    validBefore?: number;
  };
}

/**
 * Access Control List for a resource
 */
export interface ACL {
  resource: string;
  entries: Record<string, ACLEntry>;
  defaultPermissions?: Permission[];
  publicPermissions?: Permission[];
  inheritFromParent?: boolean;
  createdAt: number;
  updatedAt: number;
  createdBy: string;  // Creator's public key
}

/**
 * Participant in a shared space
 */
export interface Participant {
  publicKey: string;  // User's identity
  role: Role;
  addedAt: number;
  addedBy: string;    // Adder's public key
  customPermissions?: Permission[];
}

/**
 * Permission check request
 */
export interface PermissionCheckRequest {
  publicKey: string;  // User's public key
  resource: string;
  requiredPermissions: Permission | Permission[];
  context?: {
    timestamp?: number;
    ipAddress?: string;
  };
}

/**
 * Permission check result
 */
export interface PermissionCheckResult {
  granted: boolean;
  reason?: string;
  grantedBy?: string;
  permissions: Permission[];
}
