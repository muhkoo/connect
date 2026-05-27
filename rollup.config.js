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
    },
    isBrowser && {
      file: "dist/browser/index.js",
      format: "es",
      sourcemap: true,
    },
    isWorkers && {
      file: "dist/workers/index.js",
      format: "es",
      sourcemap: true,
      inlineDynamicImports: true, // Required for Workers single-file output
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

// Complete DTS build config
const dtsComplete = {
  input: "src/index.ts",
  output: {
    file: "dist/connect.d.ts",
    format: "es",
  },
  plugins: [dts()],
};

export default [jsConfig, dtsComplete];
