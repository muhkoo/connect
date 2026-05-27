/**
 * Bundled-WASM loader for the RS codec.
 *
 * Isolated in its own module so the rollup-plugin-wasm `import` of `.wasm` is
 * only encountered when this file is actually evaluated. The main `rs.ts`
 * file dynamically imports this module only on the fallback path (no
 * pre-compiled `WebAssembly.Module` provided), which lets tools that can't
 * parse the `.wasm` import (vitest under vite, without `vite-plugin-wasm`)
 * import `rs.ts` cleanly as long as callers always supply a module.
 *
 * Production builds (rollup) hit this path via the bundled loader; tests
 * skip it entirely by passing a fs-loaded module to `initRsWasm`.
 */

import loadRsWasm from "./wasm_reed_solomon_erasure_bg.wasm";

/** Re-exports the rollup-plugin-wasm loader shape. */
export default loadRsWasm;
