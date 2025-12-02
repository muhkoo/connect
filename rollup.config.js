import typescript from "rollup-plugin-typescript2";
import replace from "@rollup/plugin-replace";
import dts from "rollup-plugin-dts";
import packageJson from "./package.json" with { type: "json" };
import nodePolyfills from "rollup-plugin-node-polyfills";
import nodeResolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import alias from "@rollup/plugin-alias"
import wasm from "@rollup/plugin-wasm";
import path from "path";
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isBrowser = process.env.BUILD_ENV === "browser";
const isWorkers = process.env.BUILD_ENV === "workers";

// Shared input based on environment
const input = isWorkers
  ? "src/workers/index.ts"
  : isBrowser
    ? "src/browser/index.ts"
    : "src/server/index.ts";

// JS build config
const jsConfig = {
  input,
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

    alias({
      entries: [

        ...(isWorkers
          ? [
            {
              find: 'circom_runtime',
              replacement: path.resolve(__dirname, 'src/workers/shims/circom-runtime.ts'),
            },
            {
              find: 'web-worker',
              replacement: path.resolve(__dirname, 'src/workers/shims/web-worker.ts'),
            },
            {
              find: 'ffjavascript',
              replacement: path.resolve(__dirname, 'src/workers/shims/ffjavascript-workers.ts'),
            },
          ]
          : []),
      ],
    }),
    // For Workers: bundle all dependencies since there's no node_modules at runtime
    isWorkers && nodeResolve({
      browser: true,
      preferBuiltins: false,
    }),
    isWorkers && commonjs(),
    // For Workers: handle .wasm imports for pre-compiled modules
    isWorkers && wasm({
      targetEnv: 'auto-inline', // Inlines WASM as base64 for Workers
    }),
    replace({
      "process.env.npm_package_version": JSON.stringify(packageJson.version),
      "(process.env.LOG_LEVEL || LOGLEVEL).toUpperCase() as keyof typeof LogLevel": `"${process.env.LOG_LEVEL}"` || "ERROR",
      // For Workers: patch ffjavascript to use single-threaded mode and browser crypto
      // - Stub globalThis.Blob to avoid URL.createObjectURL
      // - Stub globalThis.Worker to force singleThread mode
      // - Set process.browser to true so ffjavascript uses globalThis.crypto
      ...(isWorkers ? {
        "globalThis?.Blob": "undefined",
        "globalThis?.Worker": "undefined",
        "process.browser": "true",
      } : {}),
      preventAssignment: true,
    }),
    typescript({
      clean: true
    }),
  ].filter(Boolean),
};

// DTS build config
const dtsConfig = {
  input,
  output: {
    file: isBrowser ? "dist/browser/connect.d.ts" : "dist/server/connect.d.ts",
    format: "es",
  },
  plugins: [
    dts({
      // respectExternal: true, // Respect external modules if needed
    }),
  ],
  // external: [/node_modules/], // Exclude node_modules from the .d.ts bundle
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
