import dts from 'rollup-plugin-dts';

/**
 * Rollup configuration for generating TypeScript declaration (.d.ts) bundle
 * This replaces API Extractor for simpler and more flexible type bundling
 */

const config = {
  // Build the declaration bundle from the SAME entry the runtime browser build
  // uses (`src/browser/index.ts`), not `src/index.ts`. The latter re-exports via
  // namespaces (`export * as core`, `export * as storage`, …), and
  // rollup-plugin-dts silently drops those cross-module namespace re-exports —
  // which stripped the top-level `Client`, `BroadcastChannel`, `FileStorage`,
  // `AuthClient`, etc. from `connect.d.ts` even though the runtime exports them.
  // The browser entry's flat `export *` form survives the roll-up intact, so the
  // published types now match the runtime surface.
  input: './src/browser/index.ts',
  output: [
    {
      file: 'dist/connect.d.ts',
      format: 'es'
    }
  ],
  plugins: [
    dts({
      // Respect external modules
      respectExternal: false,
      // Include all exports
      compilerOptions: {
        preserveSymlinks: false,
        declaration: true
      }
    })
  ],
  // Don't bundle external dependencies' types
  external: [
    // Add any modules whose types you want to keep external
    // For example: /node_modules/
  ]
};

export default config;