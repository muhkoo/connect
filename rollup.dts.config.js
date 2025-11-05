import dts from 'rollup-plugin-dts';

/**
 * Rollup configuration for generating TypeScript declaration (.d.ts) bundle
 * This replaces API Extractor for simpler and more flexible type bundling
 */

const config = {
  input: './src/index.ts',
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