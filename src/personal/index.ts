/**
 * Personal-space client — client-side wrappers around the accelerator's
 * `/api/personal/:commitment/*` ZK-gated KV protocol.
 *
 * The {@link PersonalSpaceClient} class produces a fresh Groth16 proof per
 * operation; the {@link wrapWithPassphrase} / {@link unwrapWithPassphrase}
 * helpers are a convenient way to client-side-encrypt the values before
 * persisting them.
 *
 * NOT exported from the workers build — snarkjs has Node-only transitive deps
 * that don't run under CF Workers.
 */

export * from "./PersonalSpaceClient";
export * from "./wrap";
