/**
 * Transport primitives — own a socket / connection and surface raw frames.
 * Higher-level layers (encryption, framing, protocols) compose these.
 *
 * `export *` form so rollup-plugin-dts keeps the symbol in the rolled
 * `connect.d.ts`.
 */

export * from "./WSTransport";
