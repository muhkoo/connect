/**
 * BroadcastChannel — a turnkey end-to-end encrypted channel for multi-peer
 * "room"-style apps (e.g. a chat). Wires together:
 *
 *   - `WSTransport` for socket lifecycle, reconnect, and offline frame queue
 *   - `EncryptedSession` for per-peer Double Ratchet state, handshake
 *     reciprocation, fan-out encryption, and recipient filtering
 *
 * The host app only deals with high-level events and method calls; it never
 * touches `new WebSocket(...)` or builds cipherMessage frames by hand.
 *
 * Wire protocol (kept compatible with the existing chat protocol so this
 * drops into the deployed Accelerator without server changes):
 *
 *   outbound: `{ keyExchange: {...} }`      — produced by us on `announce()`
 *             `{ cipherMessage: {...} }`    — produced by `send(text)`,
 *                                              one frame per peer
 *             arbitrary JSON                — sent via `sendRaw(obj)`
 *
 *   inbound:  `{ keyExchange: {...} }`      — routed into EncryptedSession;
 *                                              emits `peer_handshake`
 *             `{ cipherMessage: {...} }`    — decrypted; emits `message`
 *             anything else                 — passes through as `raw_frame`
 *                                              (the app decides what to do)
 *
 * **Event scoping.** Unlike `Network`, BroadcastChannel uses a per-instance
 * `EventTarget`, so two channels (e.g. two rooms in the same app) don't
 * cross-contaminate each other's events.
 *
 * Note: this class shadows the `BroadcastChannel` Web API global (cross-tab
 * messaging) only when imported by name. They're unrelated.
 */

import { EventCoreEvents } from "../events";
import { WSTransport, WSTransportOptions } from "../transport";
import { EncryptedSession } from "./EncryptedSession";

// ---------------------------------------------------------------------------
// Event names
// ---------------------------------------------------------------------------

/**
 * Event names BroadcastChannel emits. Lifecycle events reuse the
 * `EventCoreEvents` string values (`connected`, `disconnected`, etc.) so
 * apps can use shared constants if they want. Channel-specific events are
 * prefixed `channel:` to avoid colliding with other event systems in the
 * same app.
 */
export const BroadcastChannelEvents = {
  CONNECTED: EventCoreEvents.CONNECTED,
  DISCONNECTED: EventCoreEvents.DISCONNECTED,
  RECONNECTING: EventCoreEvents.RECONNECTING,
  ERROR: EventCoreEvents.ERROR,
  /** A peer's ratchet is now ready. `detail.peerId` is the peer's id. */
  PEER_HANDSHAKE: "channel:peer_handshake",
  /** Decrypted message. `detail` is `{ from, text, cipherMessage }`. */
  MESSAGE: "channel:message",
  /** Inbound frame BroadcastChannel didn't recognize. App handles it. */
  RAW_FRAME: "channel:raw_frame",
} as const;

export type BroadcastChannelEvent = (typeof BroadcastChannelEvents)[keyof typeof BroadcastChannelEvents];

export interface BroadcastChannelOptions extends WSTransportOptions {
  /** This client's identifier (username, DID, public-key string, etc.). */
  myId: string;
  /**
   * If true (default false), automatically send our keyExchange as soon as
   * the socket is connected. For chat-style apps that send a `{name}` frame
   * first, leave this false and call `announce()` after that handshake.
   */
  autoAnnounce?: boolean;
}

// ---------------------------------------------------------------------------
// BroadcastChannel
// ---------------------------------------------------------------------------

export class BroadcastChannel {
  readonly transport: WSTransport;
  readonly session: EncryptedSession;
  readonly myId: string;

  private autoAnnounce: boolean;
  private announced = false;

  /** Per-instance EventTarget — events do NOT leak across BroadcastChannels. */
  private events = new EventTarget();

  constructor(opts: BroadcastChannelOptions) {
    if (!opts || !opts.myId) {
      throw new Error("BroadcastChannel: `myId` is required");
    }
    this.myId = opts.myId;
    this.autoAnnounce = opts.autoAnnounce ?? false;

    this.transport = new WSTransport(opts);
    this.session = new EncryptedSession({ myId: opts.myId });

    // Pass-through lifecycle events from the transport. `EventCore.on` is
    // static so it routes back through the shared singleton; we bridge it
    // into our instance-scoped event target.
    this.transport.on(EventCoreEvents.CONNECTED, () => {
      // Reset the announce flag on every (re)connect. CF Workers WebSockets
      // hit an idle timeout and force reconnects; without resetting, the
      // SDK would short-circuit announce() and any peer who joined the
      // room after our last announce would never see our pubkey.
      this.announced = false;
      this.emit(BroadcastChannelEvents.CONNECTED);
      if (this.autoAnnounce) {
        void this.announce();
      }
    });
    this.transport.on(EventCoreEvents.DISCONNECTED, () => {
      this.emit(BroadcastChannelEvents.DISCONNECTED);
    });
    this.transport.on(EventCoreEvents.RECONNECTING, (e: CustomEvent) => {
      this.emit(BroadcastChannelEvents.RECONNECTING, e.detail);
    });
    this.transport.on(EventCoreEvents.ERROR, (e: CustomEvent) => {
      this.emit(BroadcastChannelEvents.ERROR, e.detail);
    });

    // Route inbound raw frames through our framing/decryption logic.
    this.transport.on(EventCoreEvents.MESSAGE, (e: CustomEvent) => {
      void this.handleInboundFrame(e.detail as string);
    });
  }

  // -- event API -------------------------------------------------------------

  /** Subscribe to a channel event. Handler receives a CustomEvent. */
  on(event: BroadcastChannelEvent | string, handler: (e: CustomEvent) => void): void {
    this.events.addEventListener(event, handler as EventListener);
  }

  /** Unsubscribe. */
  off(event: BroadcastChannelEvent | string, handler: (e: CustomEvent) => void): void {
    this.events.removeEventListener(event, handler as EventListener);
  }

  private emit(event: BroadcastChannelEvent | string, detail?: unknown): void {
    this.events.dispatchEvent(new CustomEvent(event, { detail }));
  }

  // -- lifecycle -------------------------------------------------------------

  /** Generate our keys (idempotent) and open the WebSocket. */
  async connect(): Promise<void> {
    await this.session.initialize();
    await this.transport.connect();
  }

  /** Close the WebSocket and stop reconnecting. */
  disconnect(): void {
    this.transport.disconnect();
  }

  /**
   * Send our `keyExchange` frame to the room. Idempotent — only sends on the
   * first call. Call this once your higher-level handshake (e.g. sending a
   * `{name}` identification frame) has completed.
   */
  async announce(): Promise<void> {
    if (this.announced) return;
    this.announced = true;
    const frame = await this.session.getOwnKeyExchange();
    this.transport.send(JSON.stringify(frame));
  }

  /**
   * Encrypt `plaintext` to every peer we have a ratchet with, and send each
   * cipherMessage as its own WS frame. Returns the number of peers we sent to
   * (0 if no peers are handshaken yet — in which case the caller should
   * typically render the message locally for the sender and try again later).
   */
  async send(plaintext: string): Promise<number> {
    const frames = await this.session.encrypt(plaintext);
    for (const frame of frames) {
      this.transport.send(JSON.stringify(frame));
    }
    return frames.length;
  }

  /**
   * Send an arbitrary JSON-serializable frame as-is. The app uses this for
   * any frame that isn't channel-managed (e.g. a chat's `{name}`, `{file}`,
   * or unencrypted `{message}`).
   */
  sendRaw(frame: unknown): void {
    this.transport.send(JSON.stringify(frame));
  }

  // -- introspection ---------------------------------------------------------

  /** List of peer ids we have an established ratchet for. */
  peers(): string[] {
    return this.session.peers();
  }

  /** Drop a peer's ratchet (e.g. when they leave the room). */
  forgetPeer(peerId: string): void {
    this.session.forgetPeer(peerId);
  }

  isConnected(): boolean {
    return this.transport.isConnected();
  }

  // -- internals -------------------------------------------------------------

  private async handleInboundFrame(raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.emit(BroadcastChannelEvents.ERROR, err);
      return;
    }

    if (!parsed || typeof parsed !== "object") {
      this.emit(BroadcastChannelEvents.RAW_FRAME, parsed);
      return;
    }

    const obj = parsed as Record<string, unknown>;

    // Channel-managed: keyExchange & cipherMessage. Anything else is RAW_FRAME.
    if ("keyExchange" in obj || "cipherMessage" in obj) {
      try {
        const result = await this.session.receive(
          obj as Parameters<typeof this.session.receive>[0],
        );
        if (result.kind === "handshake") {
          if (result.outbound) {
            this.transport.send(JSON.stringify(result.outbound));
          }
          this.emit(BroadcastChannelEvents.PEER_HANDSHAKE, { peerId: result.peerId });
        } else if (result.kind === "plaintext") {
          this.emit(BroadcastChannelEvents.MESSAGE, {
            from: result.from,
            text: result.text,
            cipherMessage: result.cipherMessage,
          });
        }
        // `ignored` is intentionally swallowed; subscribe to ERROR for bad frames.
      } catch (err) {
        this.emit(BroadcastChannelEvents.ERROR, err);
      }
      return;
    }

    this.emit(BroadcastChannelEvents.RAW_FRAME, obj);
  }
}

export default BroadcastChannel;
