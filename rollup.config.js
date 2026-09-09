import typescript from "rollup-plugin-typescript2";
import dts from "rollup-plugin-dts";
import nodeResolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import wasm from "@rollup/plugin-wasm";
import path from "path";

const isBrowser = process.env.BUILD_ENV === "browser";
const isWorkers = process.env.BUILD_ENV === "workers";

// Shared input based on environment
const input = isWorkers
  ? "src/workers/index.ts"
  : isBrowser
    ? "src/browser/index.ts"
    : "src/server/index.ts";

// Server and browser library builds externalize bare specifiers — the
// consumer's bundler (or an import map for direct browser use) resolves them.
// The Workers build bundles everything since CF Workers has no module
// resolver at runtime.
const externalFn = isWorkers
  ? undefined
  : (id) => !id.startsWith(".") && !path.isAbsolute(id);

// JS build config
const jsConfig = {
  input,
  external: externalFn,
  output: [
    !isBrowser && !isWorkers && {
      file: "dist/server/index.js",
      format: "es",
      sourcemap: true,
      // The storage layer dynamically imports `./bundled-loader` so the
      // `.wasm` static import is only encountered when production code runs.
      // Single-file output requires us to inline that dynamic chunk.
      inlineDynamicImports: true,
    },
    isBrowser && {
      file: "dist/browser/index.js",
      format: "es",
      sourcemap: true,
      inlineDynamicImports: true, // same reason as the server build
    },
    isWorkers && {
      file: "dist/workers/index.js",
      format: "es",
      sourcemap: true,
      inlineDynamicImports: true, // required for Workers single-file output
    },
  ].filter(Boolean),
  plugins: [
    // For Workers: bundle all dependencies since there's no node_modules at runtime
    isWorkers && nodeResolve({
      browser: true,
      preferBuiltins: false,
    }),
    isWorkers && commonjs(),
    // .wasm imports are auto-inlined as base64 in every build so the Groth16
    // verifier's bundled-WASM fallback works in Node, browser, and Workers.
    wasm({
      targetEnv: 'auto-inline',
    }),
    typescript({
      clean: true,
      // The rolled-up bundles in rollup.dts.config.js are the only declarations
      // we ship. Per-file emit additionally scattered ~427 stray .d.ts through
      // dist/, including a mislabelled dist/browser/index.d.ts that declared a
      // DIFFERENT entry than the bundle beside it.
      tsconfigOverride: { compilerOptions: { declaration: false, declarationMap: false } },
    }),
  ].filter(Boolean),
};

// P2P block-engine Web Worker — emitted (browser build only) as a SEPARATE
// chunk so `PeerNetwork` can spin it up via `new Worker(new URL(...))`. Kept out
// of the main bundle (nothing imports it directly); ships alongside index.js.
const workerConfig = isBrowser && {
  input: "src/p2p/worker/blockEngine.worker.ts",
  external: externalFn,
  output: {
    file: "dist/browser/blockEngine.worker.js",
    format: "es",
    sourcemap: true,
    inlineDynamicImports: true,
  },
  plugins: [
    wasm({ targetEnv: "auto-inline" }),
    typescript({
      clean: true,
      tsconfigOverride: { compilerOptions: { declaration: false, declarationMap: false } },
    }),
  ],
};

// NOTE: the declaration bundles are NOT built here. They live in
// rollup.dts.config.js (`yarn build:dts`). This block used to hold a duplicate
// dts config that ran on EVERY BUILD_ENV, so `yarn build` rolled connect.d.ts
// four times — three of them thrown away.

export default [jsConfig, workerConfig].filter(Boolean);
