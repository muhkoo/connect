import typescript from "rollup-plugin-typescript2";
import replace from "@rollup/plugin-replace";
import nodeResolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import json from "@rollup/plugin-json";
import packageJson from "./package.json" with { type: "json" };

/**
 * Rollup configuration for building worker threads as separate entry points
 * 
 * Workers need to be built as standalone modules that can be loaded by
 * the Worker constructor at runtime. They should NOT be bundled into
 * the main application code.
 */

// Define all worker entry points
const workers = [
  {
    name: "subject-worker",
    input: "src/cluster/workers/subject-worker.ts",
    output: "dist/workers/subject-worker.js"
  },
  {
    name: "data-service-worker",
    input: "src/cluster/workers/data-service-worker.ts",
    output: "dist/workers/data-service-worker.js"
  },
  {
    name: "graphql-worker",
    input: "src/cluster/workers/graphql-worker.ts",
    output: "dist/workers/graphql-worker.js"
  },
  {
    name: "message-emit-worker",
    input: "src/cluster/workers/message-emit-worker.ts",
    output: "dist/workers/message-emit-worker.js"
  },
  {
    name: "blob-worker",
    input: "src/cluster/workers/blob-worker.ts",
    output: "dist/workers/blob-worker.js"
  }

];

// Create a Rollup config for each worker
const workerConfigs = workers.map(worker => ({
  input: worker.input,
  output: {
    file: worker.output,
    format: "es",
    sourcemap: true,
    // Important: preserve the module structure for workers
    preserveModules: false,
    // Add banner for worker identification and polyfills
    banner: `/* Worker: ${worker.name} - Built: ${new Date().toISOString()} */
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Global logger polyfill for dependencies that expect it
globalThis.appLogger = console;
// Increase max listeners for worker event handling
process.setMaxListeners && process.setMaxListeners(100);`
  },
  // Mark Node.js built-ins and worker_threads as external
  external: [
    "worker_threads",
    "fs",
    "path",
    "crypto",
    "os",
    "util",
    "stream",
    "events",
    "buffer",
    "child_process",
    "cluster",
    "dgram",
    "dns",
    "http",
    "https",
    "net",
    "querystring",
    "readline",
    "tls",
    "url",
    "zlib",
    // Mark peer dependencies as external
    /^@libp2p/,
    /^@helia/,
    /^ipfs/,
    /^libp2p/,
    // Database and related dependencies should be external
    "graphql",
    "drizzle-orm",
    "@libsql/client",
    "mysql2",
    "etcd3",
    // Protobuf and related
    /^protobufjs/,
    /^@protobuf/,
    /^long$/
  ],
  plugins: [
    // Resolve node modules
    nodeResolve({
      preferBuiltins: true,
      exportConditions: ["node"],
    }),
    
    // Handle CommonJS modules with more comprehensive settings
    commonjs({
      // Transform CommonJS modules to ES6
      transformMixedEsModules: true,
      // Handle dynamic requires
      dynamicRequireTargets: [],
      // Ignore certain built-ins that should remain external
      ignoreDynamicRequires: true
    }),
    
    // Handle JSON imports
    json(),
    
    // Replace environment variables
    replace({
      "process.env.npm_package_version": JSON.stringify(packageJson.version),
      preventAssignment: true,
      // Workers should respect runtime LOG_LEVEL
      "(process.env.LOG_LEVEL || LOGLEVEL).toUpperCase() as keyof typeof LogLevel": 
        "process.env.LOG_LEVEL || 'ERROR'"
    }),
    
    // TypeScript compilation
    typescript({
      clean: true,
      tsconfig: "./tsconfig.json",
      tsconfigOverride: {
        compilerOptions: {
          // Workers use ES modules with polyfills
          module: "esnext",
          target: "es2022",
          declaration: false,
          declarationMap: false,
          // Ensure proper imports in workers
          moduleResolution: "node",
          allowSyntheticDefaultImports: true,
          esModuleInterop: true
        }
      }
    })
  ],
  // Suppress warnings about circular dependencies (common in large codebases)
  onwarn(warning, warn) {
    // Skip certain warnings
    if (warning.code === 'CIRCULAR_DEPENDENCY') return;
    if (warning.code === 'THIS_IS_UNDEFINED') return;
    // Use default for everything else
    warn(warning);
  }
}));

export default workerConfigs;