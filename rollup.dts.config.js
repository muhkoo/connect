import dts from 'rollup-plugin-dts';

/**
 * Declaration bundles. Two of them, because the three JS builds do NOT share a
 * surface and pretending they do was an active bug.
 *
 *   dist/connect.d.ts          <- src/api.ts        (browser + node)
 *   dist/connect.workers.d.ts  <- src/workers/index.ts  (workerd)
 *
 * Until now a single connect.d.ts served every export condition, so a workerd
 * consumer was told 175 symbols existed — `Client`, `KvNamespace`, `FileStorage`
 * and `AuthClient` among them — while dist/workers/index.js exports 29, none of
 * which is `Client`. That is a compile-time green light for a runtime
 * `undefined is not a constructor`.
 *
 * Rolling the workers types costs ~0.5s and 42KB, and the result matches its
 * bundle exactly (29/29 values, symmetric difference empty), the same invariant
 * dist/connect.d.ts already holds against dist/browser/index.js. Both are
 * asserted in tests/api/export-surface.test.ts.
 *
 * Rolling from src/api.ts rather than a platform entry means the declared shape
 * IS the canonical surface, not one build's view of it.
 *
 * (The old comment here blamed rollup-plugin-dts for dropping named
 * cross-module re-exports. That was a misdiagnosis — see the note in
 * src/api.ts. The plugin is fine; the entry used to be namespaced.)
 */

const dtsPlugin = () =>
  dts({
    respectExternal: false,
    compilerOptions: {
      preserveSymlinks: false,
      declaration: true,
    },
  });

export default [
  {
    input: './src/api.ts',
    output: [{ file: 'dist/connect.d.ts', format: 'es' }],
    plugins: [dtsPlugin()],
  },
  {
    input: './src/workers/index.ts',
    output: [{ file: 'dist/connect.workers.d.ts', format: 'es' }],
    plugins: [dtsPlugin()],
  },
];
