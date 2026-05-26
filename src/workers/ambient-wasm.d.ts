/**
 * Type declaration for the `.wasm` import handled by `@rollup/plugin-wasm` with
 * `targetEnv: 'auto-inline'`. The default export is a loader function that
 * decodes the base64-inlined module and returns an instantiated WebAssembly
 * instance, given the import object.
 *
 * See `rollup.config.js` for the plugin configuration.
 */
declare module "*.wasm" {
  const loader: (imports?: Record<string, Record<string, unknown>>) => Promise<WebAssembly.Instance>;
  export default loader;
}
