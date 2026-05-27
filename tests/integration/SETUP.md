# Integration Test Setup (HISTORICAL)

> This document describes the integration-test setup as it existed when the
> SDK had a `SessionManager` / `ApiClient` + `/api/handshake` flow. That
> design is gone; the tests under this folder no longer compile.
>
> See `README.md` in this directory for the present state and rewrite
> checklist.

## Original design

```
+------------------------------+
|   Integration Test Flow      |
+------------------------------+

1. TEST SETUP (beforeAll)
   - Start Accelerator server (yarn dev)
   - Wait for "Ready on http://localhost:8787"

2. CLIENT SIDE (Connect SDK)
   - Generate ephemeral keypair
   - Dehydrate public key
   - POST /api/handshake

3. SERVER SIDE (Accelerator)
   - Generate server ephemeral keypair
   - Derive shared secret (ECDH)
   - Store in KeyVault DO
   - Return { serverPublicKey, connectionId }

4. CLIENT COMPLETES HANDSHAKE
   - Receive server public key
   - Derive shared secret
   - Store in SessionManager

5. ENCRYPTED COMMUNICATION
   - Encrypt with shared secret on the client
   - Decrypt on the server

6. TEST CLEANUP (afterAll)
   - Stop Accelerator server
```

Both endpoints in step 2-3 (`/api/handshake`) and the `SessionManager`
abstraction in step 4 no longer exist. They were replaced by:

- For chat: `BroadcastChannel` over a WebSocket to a room DO, with Double
  Ratchet handshakes negotiated peer-to-peer (not via REST).
- For storage: `PersonalSpaceClient` → `/api/personal/:commitment/*`, gated
  by per-request Groth16 proofs of knowledge.
- For Groth16 verification on the edge: the `verifyGroth16` /
  `initBn128Wasm` exports from this SDK.

## Reusable bits

- `helpers/accelerator-server.ts` — boots `wrangler dev`, captures stdout,
  auto-detects an already-running server on the configured port. This is
  still useful and should be carried into the rewritten integration tests.
- The "two-terminal" workflow (running accelerator in one shell, tests in
  another, with the helper auto-detecting the running server) is still the
  recommended dev pattern.

## Migration TODO

When somebody re-does these tests:

1. Delete `ecdh-handshake.integration.test.ts`,
   `session-management.integration.test.ts`,
   `api-client.integration.test.ts`, and `manual-test.ts`.
2. Add tests against the current endpoints:
   - `BroadcastChannel` against the room DO (chat fan-out)
   - `PersonalSpaceClient` against `/api/personal/:commitment/*`
   - `verifyGroth16` against a sample circuit proof
3. Keep `helpers/accelerator-server.ts` as-is.
4. Drop or rewrite this file.
