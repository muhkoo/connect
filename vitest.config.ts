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
      // Crypto and API tests
      // "**/client.test.ts",
      // "**/ecdh.test.ts",
      "**/tests/crypto/ratchet.test.ts",
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