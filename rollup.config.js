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

// Redirect ffjavascript/src/random.js (which statically imports Node's `crypto`)
// to a Web-Crypto-backed shim. The `@rollup/plugin-alias` `find` field matches
// against the import specifier (which is `./random.js` here, not the resolved
// path), so we need importer-context — hence a small custom plugin.
const ffjavascriptRandomShim = path.resolve(
  __dirname,
  "src/workers/shims/ffjavascript-random.ts",
);
const ffjavascriptRandomRedirect = isWorkers && {
  name: "ffjavascript-random-redirect",
  resolveId(source, importer) {
    if (
      source === "./random.js" &&
      importer &&
      /[/\\]ffjavascript[/\\]src[/\\][^/\\]+\.js$/.test(importer)
    ) {
      return ffjavascriptRandomShim;
    }
    return null;
  },
};

// For library builds (browser/server) externalize every bare specifier — npm
// packages and Node builtins alike — so the consumer's bundler resolves them.
// Rollup was already doing this implicitly (hence the "unresolved dependencies"
// warnings); declaring it explicitly just silences the noise. The Workers build
// must bundle everything, so externals stay disabled there.
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
    ffjavascriptRandomRedirect,
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
    // .wasm imports are auto-inlined as base64 in every build so the Groth16
    // verifier's bundled-WASM fallback works in Node, browser, and Workers.
    wasm({
      targetEnv: 'auto-inline',
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
