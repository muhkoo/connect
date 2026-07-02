import typescript from "rollup-plugin-typescript2";
import replace from "@rollup/plugin-replace";
import dts from "rollup-plugin-dts";
import packageJson from "./package.json" with { type: "json" };
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
    replace({
      "process.env.npm_package_version": JSON.stringify(packageJson.version),
      "(process.env.LOG_LEVEL || LOGLEVEL).toUpperCase() as keyof typeof LogLevel": `"${process.env.LOG_LEVEL}"` || "ERROR",
      preventAssignment: true,
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
    replace({
      "process.env.npm_package_version": JSON.stringify(packageJson.version),
      preventAssignment: true,
    }),
    typescript({ clean: true }),
  ],
};

// Complete DTS build config.
// Build types from the browser entry point (not `src/index.ts`) so the
// declared shape matches what consumers actually see at runtime — the
// browser bundle uses flat `export *` re-exports, while `src/index.ts`
// uses namespaced `export * as foo` which doesn't survive
// rollup-plugin-dts cleanly. Server-build consumers also see this same
// shape (their `dist/server/index.js` is built from a near-identical entry).
const dtsComplete = {
  input: "src/browser/index.ts",
  output: {
    file: "dist/connect.d.ts",
    format: "es",
  },
  plugins: [dts()],
};

export default [jsConfig, workerConfig, dtsComplete].filter(Boolean);
