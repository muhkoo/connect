/**
 * ESLint 9 flat config for @muhkoo/connect.  CommonJS (`.cjs`) because
 * package.json sets `"type": "module"` and ESLint loads this file with require().
 *
 * Two severity tiers, drawn from what the code actually does today:
 *
 *   "error" = an invariant src/ ALREADY holds. Breaking it fails `yarn lint`.
 *   "warn"  = known debt with a small, countable number of hits. Burn it down,
 *             then promote to "error".
 *
 * Nothing here needs type information, so `yarn lint` stays fast and does not
 * depend on tsconfig.json's include/exclude. Typed rules (no-floating-promises,
 * no-misused-promises) are the natural next step once the refactor settles.
 */

const js = require("@eslint/js");
const tseslint = require("typescript-eslint");
const tsdoc = require("eslint-plugin-tsdoc");
const prettier = require("eslint-config-prettier");

/**
 * `any` is an error everywhere EXCEPT these files, which predate the
 * convention. Every other directory (core, auth, spaces, storage, offline,
 * vfs, vcs, p2p, personal, sessions, transport, workers, browser, server) is
 * already `any`-free, so the rule is a real ratchet rather than an aspiration.
 * Shrink this list; never add to it.
 */
const LEGACY_ANY_FILES = [
  "src/utilities/Logger.ts",
  "src/utilities/index.ts",
  "src/crypto/ZeroKnowledge.ts",
  "src/crypto/DoubleRatchetManager.ts",
  "src/crypto/Authenticator.ts",
  "src/messaging/Message.ts",
  "src/messaging/decorators.ts",
  "src/events/EventCore.ts",
  "src/types/messaging.ts",
];

/** Build/tooling scripts run in Node; declared inline to avoid a `globals` dep. */
const NODE_GLOBALS = {
  console: "readonly",
  process: "readonly",
  Buffer: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  TextEncoder: "readonly",
  TextDecoder: "readonly",
  fetch: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
};

module.exports = [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "circuits/**",
      "docs/**",
      "coverage/**",
      "lib/**",
      "examples/**",
      "**/*.wasm",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Disables the stylistic rules Prettier owns. A no-op today (this config
  // enables no formatting rules) but keeps future additions from fighting
  // Prettier. Placed before the project block so our rules stay authoritative.
  prettier,

  {
    files: ["**/*.ts", "**/*.tsx"],
    plugins: { tsdoc },
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: "latest",
      sourceType: "module",
    },
    linterOptions: {
      // Catches suppressions that outlived the problem they suppressed.
      reportUnusedDisableDirectives: "warn",
    },
    rules: {
      // --- Tier 1: enforced invariants (currently 0 violations in src/) ---
      eqeqeq: ["error", "smart"],
      "no-var": "error",
      "no-throw-literal": "error",
      "prefer-promise-reject-errors": "error",

      // --- Tier 2: known debt, 9 hits total in src/ ---
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          args: "after-used",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
          ignoreRestSiblings: true,
        },
      ],
      "prefer-const": "warn",
      "no-prototype-builtins": "warn",
      "no-useless-escape": "warn",

      // --- Off, deliberately ---
      // eslint-plugin-tsdoc validates the API Extractor TSDoc spec. This repo
      // publishes docs through TypeDoc (`yarn build:docs`) and rolls types up
      // with rollup-plugin-dts; api-extractor.json is not wired to any script.
      // Measured against src/: 194 warnings, 0 of which are real doc defects.
      // 171 come from module-banner comments before the imports (which TypeDoc
      // never renders), and the rest from ordinary prose — `{ apiKey }` in
      // unfenced examples, `->` arrows, `{@link ../core/Client}` file refs,
      // "me@x.com". The rule is one ESLint rule with no per-message options, so
      // it cannot be narrowed; it is off until the source pattern changes.
      //
      // To re-enable cleanly (verified counts):
      //   1. `/**` -> `/*` on the 44 module banners           -> 194 to 23
      //   2. fence the ~6 remaining inline examples in ```    -> 23 to ~10
      //   3. backtick the `{@link ../relative/path}` refs     -> ~0
      // Then flip this to "warn".
      "tsdoc/syntax": "off",
    },
  },

  // --- Narrow, justified exemptions ---------------------------------------

  // See LEGACY_ANY_FILES above.
  {
    files: LEGACY_ANY_FILES,
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },

  // Ambient declaration files. "Unused" is the point (src/crypto/types.d.ts),
  // and `any` is the honest type when shimming an untyped third-party library
  // we do not own — src/types/snarkjs.d.ts describes snarkjs's loose surface so
  // the two `await import("snarkjs")` call sites typecheck under noImplicitAny.
  {
    files: ["**/*.d.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },

  // The decorator eject helpers take a decorated class constructor; `Function`
  // is the accurate parameter type for "any class we might have decorated".
  {
    files: ["src/core/agents/describe.ts"],
    rules: { "@typescript-eslint/no-unsafe-function-type": "off" },
  },

  // CONTROL_OR_BIDI deliberately matches control and bidi characters to reject
  // them from VFS paths. Flagging it would be exactly backwards.
  {
    files: ["src/vfs/paths.ts"],
    rules: { "no-control-regex": "off" },
  },

  // --- Non-src lanes -------------------------------------------------------

  // Tests are not published API: they lean on `any` for fixtures and on bare
  // expression assertions. Kept lintable (not ignored) so real breakage shows.
  {
    files: ["tests/**/*.ts", "**/*.test.ts", "**/*.spec.ts", "vitest.setup.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      "@typescript-eslint/ban-ts-comment": "warn",
    },
  },

  // Build tooling: rollup configs, scripts/*.mjs. ESM, Node globals.
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      sourceType: "module",
      ecmaVersion: "latest",
      globals: NODE_GLOBALS,
    },
  },

  // This file, and anything else that must stay CommonJS.
  {
    files: ["**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      ecmaVersion: "latest",
      globals: {
        ...NODE_GLOBALS,
        require: "readonly",
        module: "writable",
        exports: "writable",
        __dirname: "readonly",
        __filename: "readonly",
      },
    },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
];
