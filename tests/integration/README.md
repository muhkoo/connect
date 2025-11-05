# Integration Tests

Integration tests for Connect SDK with Accelerator infrastructure.

## Overview

These tests verify the full end-to-end integration between the Connect client SDK and the Accelerator server, including:

- **ECDH Handshake**: Key exchange and connection establishment
- **Session Management**: Session creation, encryption/decryption, lifecycle
- **API Client**: Full API operations including messages, storage, and permissions

## Requirements

- **Accelerator** must be available in the parent directory: `../accelerator`
- **Node.js** >= 20.0.0
- **Yarn** 1.22.22+

## Understanding Integration vs Unit Tests

**Unit Tests** (`tests/api/`, `tests/crypto/`, etc.):
- Use **mocked** dependencies (fetch, etc.)
- Test Connect SDK logic in isolation
- Fast, no external services needed
- Run with: `yarn test:unit`

**Integration Tests** (`tests/integration/`):
- Hit the **real** Accelerator server
- Test full end-to-end Connect ↔ Accelerator communication
- Slower, requires Accelerator to be running
- Run with: `yarn test:integration`

## Running Integration Tests

### Manual Testing (Recommended First)

Start Accelerator manually to see what's happening:

```bash
# Terminal 1: Start Accelerator
cd ../accelerator
yarn dev

# Wait for: "Ready on http://localhost:8787"

# Terminal 2: Run manual test
cd ../connect
npx tsx tests/integration/manual-test.ts
```

This will test the ECDH handshake and show you exactly what's happening.

### Automatic Server Management

Integration tests can automatically start and stop the Accelerator dev server:

```bash
# Run all integration tests
yarn test:integration

# Run specific integration test file
yarn vitest --run ecdh-handshake.integration.test.ts

# Run with verbose output (see Accelerator logs)
yarn vitest --run --reporter=verbose
```

The `AcceleratorServer` helper in `helpers/accelerator-server.ts` will:
1. Start the Accelerator dev server on port 8787
2. Wait for the server to be ready
3. Run the tests
4. Stop the server when tests complete

### Manual Server Management (Recommended)

**The tests will automatically detect if Accelerator is already running!**

If you start Accelerator manually, the tests will use your running server instead of starting a new one:

```bash
# Terminal 1: Start Accelerator
cd ../accelerator
yarn dev

# Wait for: "Ready on http://localhost:8787"

# Terminal 2: Run integration tests
cd ../connect
yarn test:integration

# Output will show:
# ✓ Found Accelerator already running on port 8787
#   Using existing server for tests
```

**Benefits:**
- See Accelerator logs in real-time
- Faster test runs (no server startup delay)
- Keep server running between test runs
- Easier debugging

## Test Structure

### Test Files

- `ecdh-handshake.integration.test.ts` - ECDH key exchange tests
- `session-management.integration.test.ts` - Session lifecycle and encryption tests
- `api-client.integration.test.ts` - Full API client integration tests

### Helpers

- `helpers/accelerator-server.ts` - Server management utility

## Configuration

### Server Port

By default, tests use port 8787 (Wrangler's default). To change:

```typescript
const server = new AcceleratorServer({
  port: 9000, // Custom port
  logOutput: true, // Enable server logs
});
```

### Timeouts

Integration tests have longer timeouts due to server startup:
- Server startup: 60 seconds
- Individual tests: 30 seconds (default)

## Writing New Integration Tests

Create a new test file with the `.integration.test.ts` suffix:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AcceleratorServer } from './helpers/accelerator-server';

describe('My Integration Test', () => {
  let server: AcceleratorServer;
  let baseUrl: string;

  beforeAll(async () => {
    server = new AcceleratorServer({
      port: 8787,
      logOutput: false,
    });

    await server.start();
    baseUrl = server.getBaseUrl();
  }, 60000); // 60 second timeout for server startup

  afterAll(async () => {
    if (server) {
      await server.stop();
    }
  });

  it('should do something', async () => {
    // Your test code here
    const response = await fetch(`${baseUrl}/api/endpoint`);
    expect(response.ok).toBe(true);
  });
});
```

## Test Coverage

Current integration test coverage:

### ECDH Handshake
- ✅ P-256 curve handshake
- ✅ P-384 curve handshake
- ✅ Invalid public key rejection
- ✅ Unsupported curve rejection
- ✅ Unique connection ID generation

### Session Management
- ✅ Session creation (P-256 and P-384)
- ✅ String encryption/decryption
- ✅ JSON encryption/decryption
- ✅ Unicode support
- ✅ Session lifecycle (clear, expire, refresh)
- ✅ Session export/import
- ✅ Multiple independent sessions

### API Client
- ✅ Session initialization
- ✅ Message operations (send, complex bodies, error handling)
- ✅ Storage operations (set, get, update, delete, list)
- ✅ Permission operations (check, grant, revoke)
- ✅ Error handling (network errors, malformed requests)
- ✅ Concurrent operations
- ✅ Session persistence

## Troubleshooting

### Server Won't Start

If the Accelerator server fails to start:

1. Check if Accelerator directory exists at `../accelerator`
2. Ensure Accelerator dependencies are installed: `cd ../accelerator && yarn`
3. Check if port 8787 is already in use
4. Enable server logs: `logOutput: true` in `AcceleratorServer` config

### Tests Timing Out

If tests timeout:

1. Check Accelerator server logs for errors
2. Verify network connectivity to `localhost:8787`
3. Increase timeout in `beforeAll` if server startup is slow
4. Check if Wrangler is installed: `yarn global add wrangler`

### Connection Refused Errors

If you see "connection refused" errors:

1. Ensure Accelerator server is running
2. Check the port matches (default: 8787)
3. Verify firewall settings allow localhost connections

## Performance Considerations

- Integration tests are slower than unit tests (server startup + network requests)
- Run unit tests (`yarn test:unit`) during development
- Run integration tests before commits or in CI/CD pipeline
- Consider using `test.only()` to focus on specific integration tests during debugging

## CI/CD Integration

For CI/CD pipelines:

```yaml
# Example GitHub Actions workflow
- name: Run Integration Tests
  run: |
    cd accelerator
    yarn install
    cd ../connect
    yarn install
    yarn test:integration
```

## Future Enhancements

- [ ] WebSocket integration tests
- [ ] Real-time event subscription tests
- [ ] Performance benchmarking
- [ ] Load testing with concurrent clients
- [ ] Error recovery and retry logic tests
