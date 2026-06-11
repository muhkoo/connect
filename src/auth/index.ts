/**
 * Auth — HTTP client + ZK identity / proof helpers for the accelerator's
 * `/api/auth/*` endpoints.
 *
 *   - {@link AuthClient}         — wraps the four auth round-trips
 *   - {@link deriveIdentity}     — deterministic (username, password) → identity
 *   - {@link buildCommitment}    — Poseidon commitment binding the identity
 *   - {@link generateAuthProof}  — full Groth16 proof for the `preimagePoK` circuit
 *   - {@link poseidonHash}       — circomlibjs-backed lazy hash
 *   - {@link exportPublicKeyHex}, {@link exportPublicKeyBase64}, {@link signMessage}
 *
 * `export *` form so rollup-plugin-dts keeps everything in the rolled
 * `dist/connect.d.ts`.
 */

export * from "./AuthClient";
export * from "./identity";
export * from "./poseidon";
export * from "./proof";
export * from "./keys";
export * from "./hostedHandoff";
