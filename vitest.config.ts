import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths({
    root: './', // Set the root directory for tsconfig paths
    projects: ['./tsconfig.json'], // Specify the tsconfig files to use
    loose: true, // Allow resolution of non-module files
    ignoreConfigErrors: true, // Ignore errors in tsconfig files
  })],
  test: {
    setupFiles: ['./vitest.setup.ts'],
    environment: "node", // Use "jsdom" if testing browser-specific code
    globals: true,       // Enables global APIs like `describe` and `it`
    coverage: {
      reporter: ["text", "json", "html"], // Add coverage reporting (optional)
    },
    include: [
      // Unified Client facade + namespaces
      "**/client.test.ts",
      "**/tests/client/kv.test.ts",
      "**/tests/client/file-storage.test.ts",
      "**/tests/client/message.test.ts",
      "**/tests/client/functions.test.ts",
      // App-describing decorators (@MuhkooAgent/@MuhkooSpace/… + ejectAgentPrompt)
      "**/tests/core/agentDescribe.test.ts",
      // HTTP credential plumbing + session recovery, WebSocket transport
      "**/tests/core/HttpClient.test.ts",
      // SDK-owned ratchet-keypair vault (stable keypair across reloads)
      "**/tests/core/ChatKeyVault.test.ts",
      "**/tests/transport/WSTransport.test.ts",
      // "**/ecdh.test.ts",
      "**/tests/crypto/ratchet.test.ts",
      "**/tests/crypto/zk-real.test.ts",
      // Identity vault crypto (M1.0): OPRF, seed↔identity split, seed wrap/unwrap
      "**/tests/auth/vault.test.ts",
      "**/tests/auth/passkey-origin.test.ts",
      "**/tests/auth/passkey-auto-unlock.test.ts",
      // SDK-level vault auth e2e (opt-in: E2E_STAGING=1 + MUHKOO_BASE_URL)
      "**/tests/auth/vault-sdk.e2e.test.ts",
      "**/tests/auth/recovery-phrase.e2e.test.ts",
      "**/tests/auth/vault-migration.e2e.test.ts",
      "**/tests/auth/change-password.e2e.test.ts",
      "**/tests/auth/ecdsa-signature.e2e.test.ts",
      "**/tests/auth/hex-pubkey-login.e2e.test.ts",
      // M2.1 email factor (gated split-key) e2e - local form: MUHKOO_BASE_URL +
      // OTP_LOG (scrapes the dev-mode OTP from the accelerator's wrangler log)
      "**/tests/auth/email-factor.e2e.test.ts",
      // Staging close-out e2e (real mailbox; codes handed in via $OTP_DIR files)
      "**/tests/auth/email-factor-staging.e2e.test.ts",
      // Hosted-auth handoff crypto (unit)
      "**/tests/auth/hosted-handoff.test.ts",
      // v2 ECDH device-pairing handoff (TV pairing) crypto (unit)
      "**/tests/auth/device-pairing-handoff.test.ts",
      // TV device pairing SDK surface (client.auth.hosted.*) + deviceStore (unit;
      // fake fetch + fake storage + injected sleep, no network/timers/snarkjs)
      "**/tests/auth/device-pairing-sdk.test.ts",
            "**/tests/auth/device-login.test.ts",
      // Hosted-auth full flow (e2e; opt-in: E2E_STAGING=1 + MUHKOO_BASE_URL)
      "**/tests/auth/hosted-flow.e2e.test.ts",
      // Storage pipeline (cipher + RS codec + FileStorage end-to-end)
      "**/tests/storage/FileStorage.test.ts",
      // Space fan-out group-encryption layer
      "**/tests/vfs/**/*.test.ts",
      "**/tests/vcs/**/*.test.ts",
      "**/tests/spaces/**/*.test.ts",
      // Offline layer — HLC clock, CRDT primitives, IndexedDB store, sync
      "**/tests/offline/**/*.test.ts",
      // P2P layer — block-exchange protocol, engine, ShardClient peer hook
      "**/tests/p2p/**/*.test.ts",
      // "**/session-manager.test.ts",
      // "**/api-client.test.ts",
      // Salvaged tests
      // "**/utilities.test.ts",
      // "**/event-core.test.ts",
      // Temporarily disabled due to performance issues with base58 encoding
      // "**/message.test.ts",
      // Integration tests (require Accelerator to be running)
      // "**/*.integration.test.ts",
      // "tests/**/*.{test,spec}.{ts,tsx,js,jsx}"
    ], // Include all test files
    exclude: [
      "node_modules",
      "connect-docs",
      'wip',
      "**/dist/**",
      // Exclude integration tests from default test run
      // Run them explicitly with: yarn test:integration
      process.env.TEST_TYPE !== 'integration' ? "**/*.integration.test.ts" : ""
    ], // Exclude node_modules and dist folders
    testTimeout: 30000,  // Set a timeout for all tests
  },
});