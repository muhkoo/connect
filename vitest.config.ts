import { defineConfig, defaultExclude } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

/**
 * Two projects, no curated allowlist.
 *
 *   unit  every tests/**\/*.test.ts that isn't e2e — runs by default, so a new
 *         test file runs the moment it lands, with no config edit.
 *   e2e   tests/**\/*.e2e.test.ts — needs a live deployment, so it is opt-in
 *         (`yarn test:e2e`) rather than silently self-skipping inside the
 *         default run and being counted as "passing".
 *
 * This replaces a 60-line hand-curated `include` allowlist. That allowlist
 * didn't merely default files off — a CLI path argument is INTERSECTED with
 * `include`, so an unlisted file could not be run at all, even explicitly.
 */

const paths = () =>
  tsconfigPaths({
    root: './',
    projects: ['./tsconfig.json'],
    loose: true,
    ignoreConfigErrors: true,
  });

const shared = {
  setupFiles: ['./vitest.setup.ts'],
  environment: 'node' as const,
  globals: true,
};

/**
 * Suites that cannot run. Each entry names its reason and is a bug to fix or a
 * file to delete — not a permanent home. Keep this list short and justified.
 */
const CANNOT_RUN = [
  // Its "Body Size Validation" block base58-encodes 2-4MB payloads synchronously
  // and never returns. A sync hang ignores testTimeout, so it wedges the whole
  // run rather than failing. Tracked as the known base58 perf issue in CLAUDE.md.
  'tests/messaging/message.test.ts',
];

const NEVER = [...defaultExclude, '**/dist/**', 'wip/**', 'connect-docs/**'];

export default defineConfig({
  plugins: [paths()],
  test: {
    coverage: { reporter: ['text', 'json', 'html'] },
    // Project configs don't inherit the root `plugins`, so each repeats paths().
    projects: [
      {
        plugins: [paths()],
        test: {
          ...shared,
          name: 'unit',
          include: ['tests/**/*.test.ts'],
          exclude: [...NEVER, '**/*.e2e.test.ts', ...CANNOT_RUN],
          testTimeout: 30000,
        },
      },
      {
        plugins: [paths()],
        test: {
          ...shared,
          name: 'e2e',
          include: ['tests/**/*.e2e.test.ts'],
          exclude: NEVER,
          testTimeout: 120000,
        },
      },
    ],
  },
});
