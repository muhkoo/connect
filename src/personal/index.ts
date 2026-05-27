/**
 * Personal-space client — client-side wrappers around the accelerator's
 * `/api/personal/:commitment/*` ZK-gated KV protocol.
 *
 * NOT exported from the workers build — snarkjs has Node-only transitive deps
 * that don't run under CF Workers.
 *
 * The `wrapWithPassphrase` / `unwrapWithPassphrase` helpers used to live here;
 * they're now in `src/crypto/PassphraseWrap` as part of the canonical crypto
 * layer (and are still re-exported from `@muhkoo/connect` via the main
 * barrel, so consumer imports don't change).
 */

export * from "./PersonalSpaceClient";
