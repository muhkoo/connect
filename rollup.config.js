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
      clean: true
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
    typescript({ clean: true }),
  ],
};

// Complete DTS build config.
// Types are rolled up from the browser entry so the declared shape matches a
// real runtime bundle. Server consumers currently see this same shape (their
// entry is near-identical). NOTE: the workers bundle exports far less, so
// dist/connect.d.ts overstates what `workerd` consumers actually get — a
// separate workers .d.ts is the fix, tracked with the export-surface work.
const dtsComplete = {
  input: "src/browser/index.ts",
  output: {
    file: "dist/connect.d.ts",
    format: "es",
  },
  plugins: [dts()],
};

export default [jsConfig, workerConfig, dtsComplete].filter(Boolean);
