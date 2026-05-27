/**
 * End-to-end-encrypted communication sessions, built on the
 * Double Ratchet primitives in `src/crypto/`.
 *
 * The `EncryptedSession` class is a transport-agnostic wrapper for one
 * local identity that manages handshake state with arbitrary peers and
 * exposes `encrypt(text) -> frames[]` and `receive(frame) -> result` so
 * app code just shuffles JSON over its WebSocket (or HTTP, or whatever).
 */

export { EncryptedSession } from "./EncryptedSession";
export type {
  SessionOptions,
  KeyExchangeFrame,
  CipherFrame,
  IncomingFrame,
  ReceiveResult,
} from "./EncryptedSession";

export { BroadcastChannel, BroadcastChannelEvents } from "./BroadcastChannel";
export type { BroadcastChannelOptions } from "./BroadcastChannel";
