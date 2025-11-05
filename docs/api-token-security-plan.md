# API Token Security Implementation Plan

## Overview
This document outlines a comprehensive strategy for implementing a secure public API token system that allows public distribution while protecting against abuse. The approach integrates with the existing Double Ratchet encryption architecture.

## Core Strategy: "Public Identifier + Private Authentication"

Similar to Firebase and Stripe's approach, we'll treat public tokens as **identifiers** rather than secrets. Security will be achieved through:

1. **Server-side validation and rate limiting**
2. **Double Ratchet encryption for actual data**
3. **Progressive abuse detection and mitigation**

## Architecture Overview

```
┌─────────────┐     Public Token      ┌─────────────┐
│   Client    │────────────────────→  │   Server    │
│             │  (App Identifier)      │             │
│             │                        │  Validates: │
│             │    Double Ratchet      │  - Rate     │
│             │◄───────────────────►  │  - Abuse    │
│             │  (Encrypted Data)      │  - Scope    │
└─────────────┘                        └─────────────┘
```

## Implementation Phases

### Phase 1: Token Architecture (Foundation)

#### 1.1 Create Public App Token System

**File: `src/api/tokens/AppToken.ts`**

```typescript
interface AppKeyPair {
  // Publishable key (safe for client-side)
  publishable: {
    type: 'publishable',
    appId: string,
    publicKey: string, // ECDH public key
    permissions: [
      'session:create',
      'messages:subscribe',
      'data:read',
    ],
    restrictions: {
      domains: string[],
      ipRanges: string[],
    }
  },

  // Secret key (server-side only)
  secret: {
    type: 'secret',
    appId: string,
    privateKey: CryptoKey, // ECDH private key
    permissions: ['*'], // All operations
  }
}
```

#### 1.2 Extend Session Management

**Modifications to existing session system:**

- Add access token + refresh token pattern
- 15-minute access token expiry
- 7-day refresh token expiry
- Automatic token rotation with reuse detection

```typescript
interface TokenPair {
  accessToken: {
    sessionId: string,
    expiresAt: number, // Now + 15 minutes
    scopes: string[],
  },
  refreshToken: {
    tokenId: string,
    expiresAt: number, // Now + 7 days
    family: string, // Token family for reuse detection
  }
}
```

#### 1.3 Update Network Class

**Modifications to `src/network/Network.ts`:**

- Add `appToken` parameter to NetworkOptions
- Include app token in all requests as identifier
- Maintain Double Ratchet for actual data encryption

### Phase 2: Rate Limiting & Abuse Protection

#### 2.1 Multi-Layer Rate Limiting

**File: `src/api/middleware/RateLimiter.ts`**

```typescript
interface RateLimitConfig {
  // Per-IP rate limits
  ip: {
    requestsPerSecond: 10,
    burstSize: 20,
    blockDuration: 300, // seconds
  },

  // Per-session rate limits
  session: {
    requestsPerMinute: 100,
    requestsPerHour: 1000,
    requestsPerDay: 10000,
  },

  // Per-endpoint specific limits
  endpoints: {
    '/auth/session': { requestsPerMinute: 5 },
    '/messages/send': { requestsPerSecond: 1 },
    '/storage/store': { requestsPerMinute: 60 },
  },

  // Progressive throttling
  throttling: {
    warningThreshold: 0.8, // 80% of limit
    progressiveDelay: true, // Add delays as limits approach
  }
}
```

**Implementation:**
- Token bucket algorithm per session/IP/endpoint
- Progressive throttling (warn at 80%, throttle at 90%, block at 100%)
- Distributed rate limiting using Cloudflare Durable Objects

#### 2.2 Abuse Detection System

**File: `src/api/middleware/AbuseDetector.ts`**

**Features:**
- Device fingerprinting for browser/mobile
- Behavioral analysis:
  - Request patterns
  - Mouse/keyboard metrics
  - Navigation patterns
- Proof-of-work challenges for suspicious requests

```typescript
interface BehaviorProfile {
  mouseMetrics: {
    averageSpeed: number,
    pauseDuration: number,
    accelerationPattern: number[],
  },
  keystrokeMetrics: {
    averageKeyHoldTime: number,
    averageKeyLatency: number,
    rhythm: number[],
  },
  requestMetrics: {
    requestsPerMinute: number,
    endpointDistribution: Record<string, number>,
    timeDistribution: number[],
  }
}
```

**Progressive Enforcement:**

| Severity | Action | Duration |
|----------|--------|----------|
| < 0.3 | Log | - |
| < 0.5 | Throttle | 60 seconds |
| < 0.7 | Challenge (CAPTCHA/PoW) | - |
| < 0.9 | Block | 1 hour |
| ≥ 0.9 | Ban | 24 hours |

#### 2.3 Domain/Origin Restrictions

**CORS Configuration:**

```typescript
const ALLOWED_ORIGINS = [
  'https://app.example.com',
  'https://*.example.com',
  'http://localhost:3000', // Dev environment
];
```

**Additional Security:**
- Referrer validation
- Content Security Policy headers
- App attestation (iOS App Attest, Android SafetyNet, reCAPTCHA v3)

### Phase 3: Token Scoping & Permissions

#### 3.1 Token Scoping System

**Hybrid Approach:**

```typescript
// Token contains coarse-grained scopes
interface AccessToken {
  sessionId: string,
  publicKey: string,
  scopes: [
    'messaging:read',
    'messaging:write',
    'storage:read',
    'storage:write',
  ],
  expiresAt: number,
}

// Fine-grained permissions checked server-side
async function checkPermission(
  sessionId: string,
  resource: string,
  operation: Permission
): Promise<PermissionCheckResult> {
  // 1. Verify session
  // 2. Check coarse scope (fast gate)
  // 3. Check fine ACL (authoritative)
  // 4. Validate conditions
  // 5. Return result
}
```

#### 3.2 Resource-Bound Tokens

```typescript
interface ResourceToken {
  resource: string, // 'document:abc123'
  operations: ('read' | 'write' | 'delete')[],
  expiresAt: number,
  allowedIps?: string[],
  nonce?: string, // One-time use
}
```

### Phase 4: Token Validation

#### 4.1 Validation Methods

**HMAC-Based (Stateless)**
```typescript
class HMACTokenValidator {
  async generateToken(payload: TokenPayload): Promise<string>
  async validateToken(tokenStr: string): Promise<TokenPayload | null>
}
```

**JWT with RS256 (Public/Private Key)**
```typescript
class JWTValidator {
  async validateJWT(token: string): Promise<JWTPayload | null>
}
```

**Challenge-Response (High Security)**
```typescript
class ChallengeResponseAuth {
  generateChallenge(): Challenge
  async respondToChallenge(challenge: string, privateKey: CryptoKey): Promise<string>
  async verifyResponse(challenge: string, response: string, publicKey: CryptoKey): Promise<boolean>
}
```

### Phase 5: Monitoring & Management

#### 5.1 Token Management API

**Endpoints:**
- `POST /api/tokens/create` - Create new app token
- `DELETE /api/tokens/{tokenId}` - Revoke token
- `GET /api/tokens/usage` - Usage analytics
- `POST /api/tokens/rotate` - Force rotation

#### 5.2 Monitoring Dashboard

**Features:**
- Real-time abuse detection alerts
- Rate limit visualization
- Token usage analytics
- Automatic suspension for abuse

## File Structure

```
src/
├── api/
│   ├── tokens/
│   │   ├── AppToken.ts         # App-level token management
│   │   ├── TokenValidator.ts   # Token validation logic
│   │   ├── TokenScopes.ts      # Scope definitions
│   │   └── ResourceToken.ts    # Resource-bound tokens
│   ├── middleware/
│   │   ├── RateLimiter.ts      # Rate limiting implementation
│   │   ├── AbuseDetector.ts    # Abuse detection system
│   │   ├── TokenAuth.ts        # Token authentication middleware
│   │   └── CORSHandler.ts      # CORS and origin validation
│   └── session.ts               # Extended with token support
├── network/
│   └── Network.ts               # Updated to include app tokens
└── crypto/
    └── (existing Double Ratchet implementation)
```

## Usage Examples

### Client-Side (Browser/Mobile)

```typescript
// Public token - safe to expose in client code
const network = new Network({
  url: 'wss://api.example.com',
  apiUrl: 'https://api.example.com',
  appToken: 'pk_live_abc123...', // Public app identifier
  clientId: 'client1',
  serverId: 'server1',
});

// Initialize session (automatic rate limiting applied)
await network.connect();

// Make API call (automatically encrypted with Double Ratchet)
const response = await network.post({
  subject: 'api.users',
  target: 'server',
  message: new Message({
    body: { name: 'Alice', email: 'alice@example.com' }
  })
});
```

### Server-Side (Admin Operations)

```typescript
// Secret key - never exposed to clients
const adminClient = new AdminNetwork({
  secretKey: process.env.SECRET_KEY, // From environment
  apiUrl: 'https://api.example.com',
});

// Admin operations with full permissions
await adminClient.grantPermission(
  'document:abc123',
  'user:xyz789',
  ['read', 'write']
);
```

## Security Features Summary

| Feature | Purpose | Implementation |
|---------|---------|----------------|
| Public Tokens as Identifiers | Safe public distribution | Tokens identify app, not grant access |
| Double Ratchet Encryption | Data protection | All payloads encrypted end-to-end |
| Rate Limiting | Prevent resource exhaustion | Token bucket per session/IP/endpoint |
| Abuse Detection | Identify bots/attacks | Behavioral analysis + device fingerprinting |
| Token Scoping | Limit permissions | Coarse scopes + fine ACL checks |
| Progressive Enforcement | Better UX | Log → Throttle → Challenge → Block → Ban |
| Token Rotation | Prevent theft | Automatic refresh with reuse detection |
| Domain Restrictions | Prevent unauthorized use | CORS + referrer validation |
| Proof-of-Work | Deter bots | Computational challenges for suspicious requests |

## Benefits

1. **Public Distribution Safe** - Tokens are identifiers, not secrets
2. **Maintains Strong Encryption** - Double Ratchet protects all data
3. **Abuse Protection** - Multi-layer detection and mitigation
4. **Progressive UX** - Warns legitimate users before blocking
5. **Scalable Architecture** - Stateless tokens with distributed limiting
6. **Easy Integration** - Simple client SDK with automatic security

## Implementation Timeline

| Week | Phase | Tasks |
|------|-------|-------|
| 1-2 | Foundation | Token system, session extension, Network updates |
| 3-4 | Security | Rate limiting, abuse detection, domain restrictions |
| 5-6 | Permissions | Token scoping, resource binding, validation |
| 7-8 | Integration | Monitoring, testing, documentation |

## Testing Strategy

1. **Unit Tests** - Each component individually
2. **Integration Tests** - Token flow end-to-end
3. **Load Tests** - Rate limiting under stress
4. **Security Tests** - Penetration testing, abuse scenarios
5. **UX Tests** - Progressive enforcement flow

## Migration Path

For existing implementations:

1. **Phase 1**: Add app tokens alongside existing auth (backward compatible)
2. **Phase 2**: Enable rate limiting (monitor only mode)
3. **Phase 3**: Enable abuse detection (log only mode)
4. **Phase 4**: Progressive enforcement activation
5. **Phase 5**: Deprecate old auth method

## Conclusion

This implementation provides enterprise-grade security for public API tokens while maintaining the superior encryption of the Double Ratchet protocol. The multi-layered approach ensures that even if tokens are exposed, the system remains secure through rate limiting, abuse detection, and end-to-end encryption.