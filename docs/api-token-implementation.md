# API Token Implementation Guide (DESIGN — NOT IMPLEMENTED)

> **Status:** design document. None of the code described below exists in
> `src/`. `grep -r "appToken\|X-App-Token\|AppTokenValidator" src/` returns
> nothing. The companion design doc is
> [`api-token-security-plan.md`](./api-token-security-plan.md).
>
> Keep this file for future reference, but do not write code assuming any of
> it is in place.

## Overview

This guide describes a proposed secure public API token system that would
allow you to:
1. Embed a single `appToken` in your client code (web/mobile)
2. Bill all usage to you (the app owner)
3. Ensure only YOUR authorized clients can use the token
4. Prevent both unauthorized apps AND malicious users from abusing it

## The Problem We're Solving

You need **one public appToken** that can be safely shared in client code while ensuring:
- Only requests from YOUR apps are accepted
- All usage is billed to you
- Individual users can't abuse the system
- Other developers can't steal and use your token

## How It Works - The Complete Flow

```
┌──────────────────────────────────────────────────────────────┐
│ 1. Your Client Code (Browser/Mobile)                        │
│    const network = new Network({                             │
│      appToken: 'pk_live_abc123',  // ← Public, in your code │
│      url: 'wss://your-api.com'                               │
│    });                                                       │
└──────────────────────────────────────────────────────────────┘
                        ↓
┌──────────────────────────────────────────────────────────────┐
│ 2. Request to Server                                         │
│    Headers:                                                  │
│      X-App-Token: pk_live_abc123                            │
│      Origin: https://your-app.com                           │
│      X-Platform-Attestation: <proof from Apple/Google>      │
└──────────────────────────────────────────────────────────────┘
                        ↓
┌──────────────────────────────────────────────────────────────┐
│ 3. Server Validation (Multi-Layer)                          │
│                                                               │
│  Layer 1: Does token exist?                                 │
│    ✓ Token found in database                                │
│    ✓ Not revoked                                            │
│    ✓ App owner account is active                            │
│                                                               │
│  Layer 2: Domain/Origin restriction                         │
│    ✓ Request from allowed origin                            │
│    OR                                                        │
│    ✓ Valid platform attestation (mobile)                    │
│                                                               │
│  Layer 3: Rate limiting (per IP/user)                       │
│    ✓ User hasn't exceeded rate limit                        │
│                                                               │
│  Layer 4: Abuse detection                                   │
│    ✓ Behavioral patterns look legitimate                    │
│                                                               │
│  → If all pass: Allow request & increment usage counter     │
│  → Usage billed to app owner (pk_live_abc123)               │
└──────────────────────────────────────────────────────────────┘
```

## Implementation Components

### 1. App Token Data Structure

```typescript
// Database schema for app tokens
interface AppToken {
  id: string;                    // 'tok_abc123...'
  publicKey: string;             // 'pk_live_abc123...' (shareable)
  secretKey: string;             // 'sk_live_xyz789...' (server-only)
  ownerId: string;               // Who gets billed

  // Domain restrictions (web)
  allowedOrigins: string[];      // ['https://your-app.com', 'https://*.your-app.com']

  // Platform attestation (mobile)
  iosAppIds: string[];           // ['com.yourcompany.app']
  androidPackages: string[];     // ['com.yourcompany.app']

  // Usage limits
  rateLimit: {
    requestsPerSecond: number;   // e.g., 10
    requestsPerDay: number;      // e.g., 100000
  };

  // Billing info
  usage: {
    requestCount: number;
    lastResetAt: Date;
  };

  metadata: {
    createdAt: Date;
    lastUsedAt: Date;
    isActive: boolean;
  };
}
```

### 2. Server-Side Validation Flow

**File: `src/api/middleware/AppTokenValidator.ts`**

```typescript
class AppTokenValidator {
  /**
   * Validate incoming request against app token rules
   */
  async validate(request: Request): Promise<ValidationResult> {
    const token = request.headers.get('X-App-Token');

    // ============================================================
    // STEP 1: Basic token validation
    // ============================================================
    const appToken = await db.getAppToken(token);

    if (!appToken) {
      return { valid: false, reason: 'INVALID_TOKEN' };
    }

    if (!appToken.metadata.isActive) {
      return { valid: false, reason: 'TOKEN_REVOKED' };
    }

    // ============================================================
    // STEP 2: Platform-specific validation
    // ============================================================
    const origin = request.headers.get('Origin');
    const platformAttestation = request.headers.get('X-Platform-Attestation');

    if (origin) {
      // WEB REQUEST - Check domain restrictions
      if (!this.isOriginAllowed(origin, appToken.allowedOrigins)) {
        return {
          valid: false,
          reason: 'UNAUTHORIZED_ORIGIN',
          details: `Origin ${origin} not in allowed list`
        };
      }
    } else if (platformAttestation) {
      // MOBILE REQUEST - Verify platform attestation
      const isValid = await this.verifyPlatformAttestation(
        platformAttestation,
        appToken
      );

      if (!isValid) {
        return {
          valid: false,
          reason: 'INVALID_ATTESTATION',
          details: 'Platform attestation verification failed'
        };
      }
    } else {
      // No platform info provided
      return {
        valid: false,
        reason: 'MISSING_PLATFORM_INFO',
        details: 'Must provide either Origin header or Platform-Attestation'
      };
    }

    // ============================================================
    // STEP 3: Rate limiting (per user/IP)
    // ============================================================
    const userFingerprint = await this.getUserFingerprint(request);
    const rateCheck = await this.checkRateLimit(
      appToken.id,
      userFingerprint,
      appToken.rateLimit
    );

    if (!rateCheck.allowed) {
      return {
        valid: false,
        reason: 'RATE_LIMIT_EXCEEDED',
        retryAfter: rateCheck.retryAfter,
        details: `Limit: ${appToken.rateLimit.requestsPerSecond}/s`
      };
    }

    // ============================================================
    // STEP 4: Abuse detection
    // ============================================================
    const abuseCheck = await this.detectAbuse(request, appToken);

    if (abuseCheck.isAbusive) {
      return {
        valid: false,
        reason: 'ABUSE_DETECTED',
        severity: abuseCheck.severity,
        details: abuseCheck.signals.join(', ')
      };
    }

    // ============================================================
    // All checks passed!
    // ============================================================
    return {
      valid: true,
      appToken,
      userFingerprint // For usage tracking
    };
  }

  /**
   * Check if origin is in allowed list (supports wildcards)
   */
  private isOriginAllowed(origin: string, allowedOrigins: string[]): boolean {
    // Exact match
    if (allowedOrigins.includes(origin)) {
      return true;
    }

    // Wildcard match (*.example.com)
    for (const pattern of allowedOrigins) {
      if (pattern.startsWith('*.')) {
        const domain = pattern.slice(2); // Remove '*.'
        try {
          const originUrl = new URL(origin);
          if (originUrl.hostname.endsWith(domain)) {
            return true;
          }
        } catch {
          return false;
        }
      }
    }

    return false;
  }

  /**
   * Verify platform attestation (iOS/Android)
   */
  private async verifyPlatformAttestation(
    attestation: string,
    appToken: AppToken
  ): Promise<boolean> {
    try {
      const parsed = JSON.parse(atob(attestation));

      // iOS App Attest
      if (parsed.platform === 'ios') {
        return await this.verifyAppleAttestation(parsed, appToken.iosAppIds);
      }

      // Android Play Integrity
      if (parsed.platform === 'android') {
        return await this.verifyAndroidAttestation(parsed, appToken.androidPackages);
      }

      return false;
    } catch (error) {
      appLogger.error('Platform attestation verification failed:', error);
      return false;
    }
  }

  /**
   * Get unique user fingerprint for rate limiting
   */
  private async getUserFingerprint(request: Request): Promise<string> {
    // Combine multiple signals for uniqueness
    const ip = request.headers.get('CF-Connecting-IP') ||
               request.headers.get('X-Forwarded-For') ||
               'unknown';

    const userAgent = request.headers.get('User-Agent') || 'unknown';
    const sessionId = request.headers.get('X-Session-Id') || 'anonymous';

    // Create hash of combined signals
    const combined = `${ip}:${userAgent}:${sessionId}`;
    const hash = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(combined)
    );

    return Buffer.from(hash).toString('hex');
  }
}
```

### 3. Usage Tracking & Billing

**File: `src/api/billing/UsageTracker.ts`**

```typescript
class UsageTracker {
  /**
   * Record request for billing
   */
  async recordUsage(
    appTokenId: string,
    request: Request,
    userFingerprint: string
  ): Promise<void> {
    // Increment usage counter
    await db.transaction(async (tx) => {
      // Update app token usage
      await tx.execute(`
        UPDATE app_tokens
        SET usage_request_count = usage_request_count + 1,
            metadata_last_used_at = NOW()
        WHERE id = ?
      `, [appTokenId]);

      // Log detailed usage
      await tx.execute(`
        INSERT INTO usage_logs (
          app_token_id,
          timestamp,
          endpoint,
          method,
          user_fingerprint,
          response_size,
          ip_address
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [
        appTokenId,
        Date.now(),
        new URL(request.url).pathname,
        request.method,
        userFingerprint,
        request.headers.get('Content-Length') || 0,
        request.headers.get('CF-Connecting-IP'),
      ]);
    });

    // Check if approaching quota
    const usage = await this.getCurrentUsage(appTokenId);
    const limit = await this.getLimit(appTokenId);

    if (usage.requestCount > limit.requestsPerDay * 0.8) {
      await this.notifyOwner(appTokenId, {
        type: 'APPROACHING_QUOTA',
        current: usage.requestCount,
        limit: limit.requestsPerDay,
        percentage: (usage.requestCount / limit.requestsPerDay) * 100,
      });
    }
  }

  /**
   * Get billing report for period
   */
  async getBillingReport(
    appTokenId: string,
    period: { start: Date; end: Date }
  ): Promise<BillingReport> {
    const logs = await db.query(`
      SELECT
        COUNT(*) as total_requests,
        SUM(response_size) as total_bytes,
        endpoint,
        COUNT(DISTINCT user_fingerprint) as unique_users,
        DATE(FROM_UNIXTIME(timestamp/1000)) as day
      FROM usage_logs
      WHERE app_token_id = ?
        AND timestamp >= ?
        AND timestamp <= ?
      GROUP BY endpoint, day
    `, [appTokenId, period.start.getTime(), period.end.getTime()]);

    // Calculate costs
    const COST_PER_REQUEST = 0.0001; // $0.0001 per request
    const COST_PER_GB = 0.10;        // $0.10 per GB transferred

    const totalRequests = logs.reduce((sum, row) => sum + row.total_requests, 0);
    const totalGigabytes = logs.reduce((sum, row) => sum + row.total_bytes, 0) / (1024 ** 3);

    return {
      period,
      totalRequests,
      totalDataTransfer: `${totalGigabytes.toFixed(2)} GB`,
      costs: {
        requests: totalRequests * COST_PER_REQUEST,
        dataTransfer: totalGigabytes * COST_PER_GB,
        total: (totalRequests * COST_PER_REQUEST) + (totalGigabytes * COST_PER_GB),
      },
      breakdown: {
        byEndpoint: this.groupByEndpoint(logs),
        byDay: this.groupByDay(logs),
        uniqueUsers: Math.max(...logs.map(row => row.unique_users)),
      },
    };
  }

  /**
   * Generate invoice for billing period
   */
  async generateInvoice(ownerId: string, month: Date): Promise<Invoice> {
    // Get all app tokens for this owner
    const tokens = await db.getAppTokensByOwner(ownerId);

    const lineItems: InvoiceLineItem[] = [];

    for (const token of tokens) {
      const report = await this.getBillingReport(token.id, {
        start: startOfMonth(month),
        end: endOfMonth(month),
      });

      lineItems.push({
        description: `API Usage - ${token.publicKey}`,
        quantity: report.totalRequests,
        unitPrice: 0.0001,
        amount: report.costs.requests,
      });

      lineItems.push({
        description: `Data Transfer - ${token.publicKey}`,
        quantity: parseFloat(report.totalDataTransfer),
        unitPrice: 0.10,
        amount: report.costs.dataTransfer,
      });
    }

    const total = lineItems.reduce((sum, item) => sum + item.amount, 0);

    return {
      invoiceId: `inv_${Date.now()}`,
      ownerId,
      period: month,
      lineItems,
      subtotal: total,
      tax: total * 0.08, // 8% tax
      total: total * 1.08,
      dueDate: addDays(endOfMonth(month), 15),
    };
  }
}
```

### 4. Platform Attestation Verification

**File: `src/api/middleware/PlatformAttestator.ts`**

```typescript
class PlatformAttestator {
  /**
   * Verify iOS App Attest
   * https://developer.apple.com/documentation/devicecheck/validating_apps_that_connect_to_your_server
   */
  async verifyAppleAttestation(
    attestation: any,
    allowedAppIds: string[]
  ): Promise<boolean> {
    try {
      // 1. Decode the attestation object
      const { appId, challenge, keyId, certificate } = attestation;

      // 2. Verify app ID is in allowed list
      if (!allowedAppIds.includes(appId)) {
        appLogger.warn(`iOS app ID ${appId} not in allowed list`);
        return false;
      }

      // 3. Verify certificate chain (issued by Apple)
      const isValidCert = await this.verifyAppleCertificate(certificate);
      if (!isValidCert) {
        appLogger.warn('Invalid Apple certificate');
        return false;
      }

      // 4. Verify challenge (prevents replay attacks)
      const isValidChallenge = await this.verifyChallenge(challenge, keyId);
      if (!isValidChallenge) {
        appLogger.warn('Invalid challenge');
        return false;
      }

      return true;
    } catch (error) {
      appLogger.error('Apple attestation verification failed:', error);
      return false;
    }
  }

  /**
   * Verify Android Play Integrity API
   * https://developer.android.com/google/play/integrity/overview
   */
  async verifyAndroidAttestation(
    attestation: any,
    allowedPackages: string[]
  ): Promise<boolean> {
    try {
      // 1. Parse the JWS (JSON Web Signature)
      const jws = attestation.token;
      const [header, payload, signature] = jws.split('.');

      const parsedPayload = JSON.parse(atob(payload));

      // 2. Verify package name
      if (!allowedPackages.includes(parsedPayload.appPackageName)) {
        appLogger.warn(`Android package ${parsedPayload.appPackageName} not allowed`);
        return false;
      }

      // 3. Verify signature with Google's public key
      const isValidSignature = await this.verifyGoogleSignature(
        `${header}.${payload}`,
        signature
      );

      if (!isValidSignature) {
        appLogger.warn('Invalid Google Play signature');
        return false;
      }

      // 4. Check integrity verdict
      const verdict = parsedPayload.integrityVerdict;
      if (!['MEETS_DEVICE_INTEGRITY', 'MEETS_BASIC_INTEGRITY'].includes(verdict)) {
        appLogger.warn(`Failed integrity check: ${verdict}`);
        return false;
      }

      return true;
    } catch (error) {
      appLogger.error('Android attestation verification failed:', error);
      return false;
    }
  }
}
```

### 5. Update Network Class

**Modifications to `src/network/Network.ts`:**

```typescript
export interface NetworkOptions {
  url: string;
  apiUrl?: string;
  appToken: string;              // NEW: Required public app token
  clientId: string;
  serverId: string;
  sessionType?: 'global' | 'specific';
  // ... existing options
}

export class Network extends EventCore {
  private url: string;
  private apiUrl: string;
  private appToken: string;      // NEW
  private ratchetManager: DoubleRatchetManager;
  private keyStore: KeyStore;
  private clientId: string;
  private serverId: string;
  private sessionType: 'global' | 'specific';
  private sessionId: string | null = null;

  // ... existing properties

  constructor(options: NetworkOptions) {
    super();

    this.url = options.url || 'ws://localhost:8787';
    this.apiUrl = options.apiUrl || options.url.replace(/^ws/, 'http').replace(/\/ws.*$/, '');
    this.appToken = options.appToken;  // NEW
    this.clientId = options.clientId || 'client-' + _socketId();
    this.serverId = options.serverId || 'server';
    this.sessionType = options.sessionType || 'specific';

    // ... rest of constructor
  }

  /**
   * Get platform attestation for mobile apps
   */
  private async getPlatformAttestation(): Promise<string | null> {
    // Check if running in mobile environment
    if (typeof navigator !== 'undefined' && navigator.userAgent) {
      // Web browser - no attestation needed (uses Origin header)
      return null;
    }

    // Mobile platform detection would go here
    // For React Native, you'd use:
    // - expo-device-check (iOS)
    // - react-native-google-safetynet (Android)

    return null;
  }

  /**
   * Get default headers for all requests
   */
  private getDefaultHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'X-App-Token': this.appToken,  // NEW: Include app token
      'X-Client-Id': this.clientId,
      'Content-Type': 'application/json',
    };

    // Add session ID if available
    if (this.sessionId) {
      headers['X-Session-Id'] = this.sessionId;
    }

    return headers;
  }

  /**
   * Make an encrypted REST request using packet structure
   */
  private async rest<T = any>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
    options: Omit<PacketOptions, 'source'>
  ): Promise<HttpResponse<T>> {
    // Ensure session is initialized
    if (!this.sessionId) {
      await this.initializeSession();
    }

    // Create packet
    const packet = new Packet({
      ...options,
      source: this.clientId,
    });

    // Build URL
    const path = packet.subject ? `/${packet.subject.replace(/\./g, '/')}` : `/${packet.target}`;
    const url = `${this.apiUrl}${path}`;

    // Prepare headers
    const headers: Record<string, string> = {
      ...this.getDefaultHeaders(),  // Includes X-App-Token
      'X-Packet-Id': packet.id,
      'X-Source': packet.source,
      'X-Target': packet.target,
    };

    // Add platform attestation for mobile
    const attestation = await this.getPlatformAttestation();
    if (attestation) {
      headers['X-Platform-Attestation'] = attestation;
    }

    // ... rest of REST implementation
  }
}
```

## Usage Examples

### Setup: Create App Token (One Time)

```bash
# Via CLI (to be implemented)
$ muhkoo-cli tokens create \
  --name "My Production App" \
  --origins "https://myapp.com,https://*.myapp.com" \
  --ios-app-id "com.mycompany.app" \
  --android-package "com.mycompany.app" \
  --rate-limit "10/s,100000/day"

✓ App token created:
  Public Key: pk_live_abc123... (safe to embed in your app)
  Secret Key: sk_live_xyz789... (NEVER share - server-side only)

  Allowed Origins:
    - https://myapp.com
    - https://*.myapp.com

  Mobile Apps:
    - iOS: com.mycompany.app
    - Android: com.mycompany.app

  Rate Limits:
    - 10 requests/second per user
    - 100,000 requests/day total
```

### Client Code: Web Browser

```typescript
// This is SAFE to put in your public JavaScript bundle
import { Network } from '@muhkoo/connect';

const network = new Network({
  url: 'wss://api.muhkoo.com',
  apiUrl: 'https://api.muhkoo.com',
  appToken: 'pk_live_abc123...',  // PUBLIC - safe to expose
  clientId: 'user-' + userId,
  serverId: 'muhkoo-server',
});

// Connect and send messages
await network.connect();

await network.post({
  subject: 'api.users',
  target: 'muhkoo-server',
  message: new Message({
    body: { name: 'Alice', email: 'alice@example.com' }
  })
});

// Server automatically validates:
// ✓ Token pk_live_abc123 exists and is active
// ✓ Request came from https://myapp.com (allowed origin)
// ✓ User hasn't exceeded 10 req/s rate limit
// ✓ No abusive behavior detected
// → Request allowed
// → Usage incremented and billed to app owner
```

### Client Code: React Native (iOS/Android)

```typescript
import { Network } from '@muhkoo/connect';
import DeviceCheck from '@expo/device-check'; // iOS
import PlayIntegrity from '@react-native-google-play/integrity'; // Android

const network = new Network({
  url: 'wss://api.muhkoo.com',
  apiUrl: 'https://api.muhkoo.com',
  appToken: 'pk_live_abc123...',  // PUBLIC - safe in app bundle
  clientId: 'user-' + userId,
  serverId: 'muhkoo-server',
  platform: Platform.OS, // 'ios' or 'android'
});

// Network class automatically generates platform attestation
// iOS: Uses App Attest API
// Android: Uses Play Integrity API

await network.connect();

// Server validates:
// ✓ Token exists
// ✓ Platform attestation proves request from legitimate app
// ✓ App ID (com.mycompany.app) matches allowed list
// ✓ Rate limits not exceeded
// → Request allowed and billed to app owner
```

### Server Code: Token Management

```typescript
import { AppTokenManager } from '@muhkoo/connect/server';

const tokenManager = new AppTokenManager();

// Create new app token
const token = await tokenManager.create({
  ownerId: 'user_123',
  allowedOrigins: ['https://myapp.com'],
  iosAppIds: ['com.mycompany.app'],
  androidPackages: ['com.mycompany.app'],
  rateLimit: {
    requestsPerSecond: 10,
    requestsPerDay: 100000,
  },
});

console.log('Public Key:', token.publicKey);   // Share with client
console.log('Secret Key:', token.secretKey);   // Keep server-side only

// Revoke token
await tokenManager.revoke(token.publicKey);

// Get usage stats
const stats = await tokenManager.getUsage(token.publicKey, {
  start: new Date('2025-01-01'),
  end: new Date('2025-01-31'),
});

console.log('Total requests:', stats.totalRequests);
console.log('Cost:', stats.costs.total);
```

## Security Guarantees

| Threat Scenario | Protection Mechanism | Result |
|----------------|---------------------|--------|
| Developer steals token for different website | Domain restriction validation | ❌ Blocked - origin not in allowed list |
| Developer uses token from localhost | Domain restriction | ❌ Blocked unless localhost explicitly allowed |
| Bot makes 1 million requests/second | Rate limiting (10 req/s per user) | ❌ Blocked after 10th request |
| User runs automation script | Behavioral analysis | ❌ Detected and challenged/blocked |
| Attacker spoofs Origin header | Browser controls Origin (can't be spoofed) | ❌ Spoofing fails |
| Attacker decompiles mobile app | Platform attestation required | ✓ Allowed - proves request from real app |
| You accidentally commit secret key to GitHub | Secret key grants full access | 🔴 **CATASTROPHIC** - Revoke immediately! |
| Legitimate user makes 9 req/s | Rate limit 10 req/s | ✓ Allowed - within limits |

## Billing Flow

```
Every Request
     ↓
┌─────────────────────────────┐
│ 1. Validate App Token       │
│    ✓ Token exists            │
│    ✓ Origin/attestation OK   │
│    ✓ Rate limits OK          │
│    ✓ No abuse detected       │
└─────────────────────────────┘
     ↓
┌─────────────────────────────┐
│ 2. Process Request           │
│    - Handle business logic   │
│    - Encrypt with Double     │
│      Ratchet                 │
│    - Send response           │
└─────────────────────────────┘
     ↓
┌─────────────────────────────┐
│ 3. Record Usage              │
│    UPDATE app_tokens         │
│    SET request_count++       │
│                              │
│    INSERT INTO usage_logs    │
│    (timestamp, endpoint,     │
│     user, size, ...)         │
└─────────────────────────────┘
     ↓
┌─────────────────────────────┐
│ 4. Daily Billing Job         │
│    (Runs at midnight UTC)    │
│                              │
│    Calculate usage:          │
│    - pk_live_abc: 50k reqs   │
│    - pk_live_xyz: 125k reqs  │
│                              │
│    Generate invoice:         │
│    - App 1: 50k × $0.0001    │
│      = $5.00                 │
│    - App 2: 125k × $0.0001   │
│      = $12.50                │
│                              │
│    Charge card on file       │
└─────────────────────────────┘
```

## Implementation Checklist

### Phase 1: Core Token System
- [ ] Create `src/api/tokens/AppToken.ts` - Type definitions
- [ ] Create `src/api/tokens/AppTokenManager.ts` - CRUD operations
- [ ] Create database schema for `app_tokens` table
- [ ] Create database schema for `usage_logs` table

### Phase 2: Validation Middleware
- [ ] Create `src/api/middleware/AppTokenValidator.ts`
- [ ] Implement domain/origin validation
- [ ] Implement rate limiting logic
- [ ] Implement abuse detection basics

### Phase 3: Platform Attestation
- [ ] Create `src/api/middleware/PlatformAttestator.ts`
- [ ] Implement iOS App Attest verification
- [ ] Implement Android Play Integrity verification
- [ ] Add attestation to Network class

### Phase 4: Usage Tracking
- [ ] Create `src/api/billing/UsageTracker.ts`
- [ ] Implement request logging
- [ ] Implement usage aggregation
- [ ] Create billing report generator

### Phase 5: Network Class Integration
- [ ] Add `appToken` to NetworkOptions
- [ ] Include appToken in all request headers
- [ ] Add platform attestation generation
- [ ] Update examples and documentation

### Phase 6: Management & Tooling
- [ ] Create CLI tool for token management
- [ ] Create admin dashboard for usage monitoring
- [ ] Add alerting for quota warnings
- [ ] Implement automatic billing

## Best Practices

### DO ✅

1. **Always use HTTPS/WSS** - Never send tokens over unencrypted connections
2. **Rotate secret keys regularly** - Keep secret keys in environment variables
3. **Set conservative rate limits** - Start low, increase based on usage patterns
4. **Monitor usage actively** - Set up alerts for unusual patterns
5. **Use platform attestation** - Implement for all mobile apps
6. **Document allowed origins** - Keep a clear list of authorized domains

### DON'T ❌

1. **Never commit secret keys** - Use `.env` files (in `.gitignore`)
2. **Don't use tokens in URLs** - Always use headers
3. **Don't skip validation layers** - All 4 layers are important
4. **Don't ignore abuse signals** - Act on behavioral anomalies
5. **Don't over-provision limits** - Start conservative
6. **Don't expose billing data** - Keep usage stats server-side only

## FAQ

**Q: Can someone steal my public token and use it on their own website?**
A: They can try, but it won't work. The server validates that requests come from your allowed origins only. Web browsers automatically include the `Origin` header which cannot be spoofed by client code.

**Q: What if someone decompiles my mobile app and extracts the token?**
A: The token alone isn't enough. Mobile requests must include platform attestation (iOS App Attest or Android Play Integrity) which proves the request came from a legitimate, unmodified app installed from the App Store/Play Store.

**Q: How do I prevent a single user from making millions of requests?**
A: Rate limiting is enforced per user fingerprint (IP + session + user agent). Even if they have your valid token, they'll be blocked after exceeding the rate limit (e.g., 10 requests/second).

**Q: What happens if I accidentally commit my secret key to GitHub?**
A: **Revoke it immediately!** The secret key grants full access without restrictions. After revoking, generate a new token pair and update your server configuration.

**Q: Can I have multiple apps using the same billing account?**
A: Yes! Create multiple app tokens (one per app) all owned by the same `ownerId`. Each token will have its own usage tracking but all bill to the same account.

**Q: How do I test locally without setting up domain restrictions?**
A: Add `http://localhost:3000` to your `allowedOrigins` list for development tokens. Use a separate production token with stricter rules.

## Next Steps

This is a design document. Before any of it can ship:

1. Decide whether this belongs in `connect` at all, or in `accelerator`
   (the API-token enforcement layer would live with the request handlers,
   not the client SDK)
2. Reconcile with the existing `EncryptedSession` / `BroadcastChannel`
   primitives — there is no `Network` class with `appToken` support today
3. Decide whether the chat app's username/password → Poseidon commitment
   identity flow obviates the need for app tokens entirely
4. Pick a single design (this doc vs. `api-token-security-plan.md`) and
   delete the other

For now, nothing in `src/` references `appToken`, `X-App-Token`, or any of
the structures in this document.