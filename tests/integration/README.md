# Integration Tests

Integration tests intended to exercise Connect against a real running
Accelerator. **The test files in this directory are presently stale** — they
import from paths that no longer exist in `src/` (`src/api/session`,
`src/api/client`, `src/crypto/ecdh`). The companion `SETUP.md` describes the
original design.

Treat this directory as historical until it's rewritten against the current
surface (`BroadcastChannel`, `EncryptedSession`, `PersonalSpaceClient`,
`verifyGroth16`).

## What was originally intended

These tests were supposed to verify:

- ECDH handshake between the SDK and the accelerator's `/api/handshake`
  endpoint
- `SessionManager` lifecycle: create, complete, encrypt, decrypt, refresh,
  expire, clear
- `ApiClient` operations: messages, storage, permissions

None of those classes / endpoints exist today. The actual chat flow is:

- Client opens a WebSocket to a room DO and exchanges Double Ratchet
  handshakes peer-to-peer (`BroadcastChannel`).
- Personal storage goes through `PersonalSpaceClient` →
  `/api/personal/:commitment/{challenge,kv,list}` (ZK-gated, not the old
  ECDH handshake).
- Groth16 verification on the worker uses `verifyGroth16` from this SDK.

## Files in this directory

| File | Status |
| --- | --- |
| `ecdh-handshake.integration.test.ts` | Stale; targets a removed `/api/handshake` flow |
| `session-management.integration.test.ts` | Stale; imports `SessionManager` from `../../src/api/session` (does not exist) |
| `api-client.integration.test.ts` | Stale; imports `ApiClient` from `../../src/api/client` (does not exist) |
| `manual-test.ts` | Stale; same as above |
| `helpers/accelerator-server.ts` | Still relevant — wraps `wrangler dev` startup/teardown |

## Running

```bash
yarn test:integration
# TEST_TYPE=integration vitest --run tests/integration
```

The above command will currently fail at module-resolution time. To get
working integration tests, the files need to be rewritten against
`BroadcastChannel` and `PersonalSpaceClient`. The helper
(`helpers/accelerator-server.ts`) and the auto-detect-running-server pattern
can be reused.

## Auto-detecting a running accelerator

The helper checks for an already-running server on the configured port
(default 8787) and reuses it if found. Recommended dev workflow:

```bash
# Terminal 1
cd ../accelerator
yarn dev

# Terminal 2
cd connect
yarn test:integration   # will detect the running server and skip startup
```

This is faster, surfaces Accelerator logs in the dev terminal, and keeps the
server warm across runs.

## Next steps (rewrite checklist)

When somebody picks these up:

1. Delete the three `.integration.test.ts` files and `manual-test.ts`.
2. Add `broadcast-channel.integration.test.ts` — two `BroadcastChannel`
   instances against the room DO, verify handshake fan-out + decrypt.
3. Add `personal-space.integration.test.ts` — `PersonalSpaceClient.put/get`
   against the personal DO with snarkjs proof generation. Will require
   the test environment to provide `snarkjs`, the compiled
   `preimagePoK.wasm`, and the `.zkey`.
4. Add `groth16-verifier.integration.test.ts` — verify a sample proof from
   the accelerator against `verifyGroth16` directly.
5. Keep `helpers/accelerator-server.ts` as-is.
