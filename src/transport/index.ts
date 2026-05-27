/**
 * Transport primitives — own a socket / connection and surface raw frames.
 * Higher-level layers (encryption, framing, protocols) compose these.
 */

export { WSTransport } from "./WSTransport";
export type { WSTransportOptions } from "./WSTransport";
