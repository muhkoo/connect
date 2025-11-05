import typescript from "rollup-plugin-typescript2";
import replace from "@rollup/plugin-replace";
import dts from "rollup-plugin-dts";
import packageJson from "./package.json" with { type: "json" };
import nodePolyfills from "rollup-plugin-node-polyfills";
import nodeResolve from "@rollup/plugin-node-resolve";
import alias from "@rollup/plugin-alias"
import path from "path";
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isBrowser = process.env.BUILD_ENV === "browser";

// Shared input based on environment
const input = isBrowser ? "src/browser/index.ts" : "src/server/index.ts";

// JS build config
const jsConfig = {
  input,
  output: [
    !isBrowser && {
      file: "dist/server/index.js",
      format: "es",
      sourcemap: true,
    },
    isBrowser && {
      file: "dist/browser/index.js",
      format: "es",
      sourcemap: true,
    },
  ].filter(Boolean),
  plugins: [

    alias({
      entries: isBrowser
        ? [
          {
            find: '@libp2p/mdns',
            replacement: path.resolve(__dirname, 'src/browser/shims/mdns.ts'),
          },
        ]
        : [],
    }),
    // nodeResolve({
    //   preferBuiltins: !isBrowser,
    //   browser: isBrowser,
    // }),
    // isBrowser && nodePolyfills(),
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
