/**
 * Pure WebSocket transport — owns the socket lifecycle and nothing else.
 *
 * Hands raw frame strings up (via the `MESSAGE` event) and accepts raw frame
 * strings down (via `send`). Anything frame-shape, encryption, or serialization
 * related belongs in the layer above (e.g. `Network` for client↔server
 * encrypted pipes, `BroadcastChannel` for multi-peer E2E rooms).
 *
 * Responsibilities:
 *   - Open / close the WebSocket
 *   - Auto-reconnect with linear backoff after an unexpected close
 *   - Buffer outbound frames while disconnected (capped queue)
 *   - Emit lifecycle events (CONNECTED / DISCONNECTED / RECONNECTING / ERROR)
 *     plus raw inbound MESSAGE events
 */

import { EventCore, EventCoreEvents } from "../events";

/** Monotonic source of unique transport ids when a caller doesn't supply one. */
let __wsInstanceSeq = 0;

export interface WSTransportOptions {
  /** WebSocket URL, e.g. `ws://localhost:8787/foo`. */
  url: string;
  /**
   * Stable identifier for this connection (a channel / space / personal-space
   * id). Lifecycle + MESSAGE events are namespaced by it on the shared
   * `EventCore` bus so concurrent transports (chat room A, room B, the storage
   * feed, …) never receive each other's frames. Optional — a unique id is
   * generated when omitted; pass a semantic one for clearer debugging.
   */
  id?: string;
  /** Reconnect automatically after unexpected disconnect (default `true`). */
  autoReconnect?: boolean;
  /** Delay between reconnect attempts in ms (default `3000`). */
  reconnectDelay?: number;
  /** Cap on reconnect attempts (default `5`; `0` means unlimited). */
  maxReconnectAttempts?: number;
  /**
   * Max outbound frames buffered while disconnected. Sending past this caps
   * throws synchronously. Default `100`.
   */
  maxQueueSize?: number;
  /**
   * Heartbeat interval in ms. While connected, a `pingFrame` is sent every
   * interval to keep the socket warm (long-lived WebSockets get dropped by CF
   * / intermediaries when idle) and to detect a silently-dead connection.
   * Default `30000`. Set `0` to disable the heartbeat entirely.
   */
  heartbeatInterval?: number;
  /**
   * How long (ms) to wait for a `pongFrame` after sending a ping before
   * treating the connection as dead and forcing a reconnect. Should be well
   * under `heartbeatInterval`. Default `10000`.
   */
  heartbeatTimeout?: number;
  /** Outbound keep-alive frame. Default `"ping"`. */
  pingFrame?: string;
  /**
   * Inbound keep-alive ack. Matching frames are swallowed (never surfaced as a
   * `MESSAGE`) and reset the liveness timer. Must match the server's
   * auto-response. Default `"pong"`.
   */
  pongFrame?: string;
}

export class WSTransport extends EventCore {
  /**
   * Per-instance event scope. `EventCore` is a process-global static emitter,
   * so without namespacing every WSTransport would hear every other one's
   * frames. We prefix each event with this transport's `id` and expose
   * `on`/`off`/`emit` that scope transparently — callers still use the plain
   * `EventCoreEvents` enum and only ever see their own connection's events.
   */
  readonly id: string;

  readonly emit = (event: EventCoreEvents, data: unknown): void => {
    EventCore.emit(this.scopedEvent(event), data);
  };
  readonly on = (event: EventCoreEvents, handler: EventListener | CallableFunction): void => {
    EventCore.on(this.scopedEvent(event), handler);
  };
  readonly off = (event: EventCoreEvents, handler: EventListener | CallableFunction): void => {
    EventCore.off(this.scopedEvent(event), handler);
  };

  private scopedEvent(event: EventCoreEvents): EventCoreEvents {
    return `${this.id}:${event}` as EventCoreEvents;
  }

  private url: string;
  private socket: WebSocket | null = null;
  private _isConnected = false;
  private _isConnecting = false;

  // Reconnect state
  private autoReconnect: boolean;
  private reconnectDelay: number;
  private maxReconnectAttempts: number;
  private reconnectAttempts = 0;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

  // Outbound queue (raw frame strings — already serialized by caller)
  private outboundQueue: string[] = [];
  private maxQueueSize: number;

  // Heartbeat / liveness state
  private heartbeatInterval: number;
  private heartbeatTimeout: number;
  private pingFrame: string;
  private pongFrame: string;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: WSTransportOptions) {
    super();
    if (!opts || !opts.url) {
      throw new Error("WSTransport: `url` is required");
    }
    this.url = opts.url;
    this.id = opts.id ?? `ws${++__wsInstanceSeq}`;
    this.autoReconnect = opts.autoReconnect ?? true;
    this.reconnectDelay = opts.reconnectDelay ?? 3000;
    this.maxReconnectAttempts = opts.maxReconnectAttempts ?? 5;
    this.maxQueueSize = opts.maxQueueSize ?? 100;
    this.heartbeatInterval = opts.heartbeatInterval ?? 30000;
    this.heartbeatTimeout = opts.heartbeatTimeout ?? 10000;
    this.pingFrame = opts.pingFrame ?? "ping";
    this.pongFrame = opts.pongFrame ?? "pong";
  }

  /** Open the socket. Resolves when CONNECTED fires. Rejects on first error. */
  async connect(): Promise<void> {
    if (this._isConnected || this._isConnecting) {
      throw new Error("WSTransport: already connected or connecting");
    }
    this._isConnecting = true;

    return new Promise<void>((resolve, reject) => {
      try {
        const socket = new WebSocket(this.url);
        this.socket = socket;

        socket.onopen = () => {
          this._isConnected = true;
          this._isConnecting = false;
          this.reconnectAttempts = 0;
          this.emit(EventCoreEvents.CONNECTED, undefined);
          this.flushQueue();
          this.startHeartbeat();
          resolve();
        };

        socket.onmessage = (event: MessageEvent) => {
          // Heartbeat ack — swallow it (don't surface as a MESSAGE) and clear
          // the liveness deadline. The layer above never sees keep-alive frames.
          if (event.data === this.pongFrame) {
            if (this.pongTimer) {
              clearTimeout(this.pongTimer);
              this.pongTimer = null;
            }
            return;
          }
          // Raw inbound frame — layer above is responsible for parsing.
          this.emit(EventCoreEvents.MESSAGE, event.data);
        };

        socket.onerror = (err) => {
          this.emit(EventCoreEvents.ERROR, err);
          if (this._isConnecting) {
            this._isConnecting = false;
            reject(err);
          }
        };

        socket.onclose = () => {
          const wasConnected = this._isConnected;
          this._isConnected = false;
          this._isConnecting = false;
          this.stopHeartbeat();
          this.emit(EventCoreEvents.DISCONNECTED, undefined);
          if (this.autoReconnect && wasConnected) {
            this.scheduleReconnect();
          }
        };
      } catch (err) {
        this._isConnecting = false;
        reject(err);
      }
    });
  }

  /** Close the socket and stop reconnecting. */
  disconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.stopHeartbeat();
    this.autoReconnect = false;
    if (this.socket) {
      try { this.socket.close(); } catch { /* ignore */ }
      this.socket = null;
    }
    this._isConnected = false;
    this._isConnecting = false;
  }

  /**
   * Send a raw frame. If currently disconnected, the frame is queued and sent
   * after the next successful reconnect (up to `maxQueueSize`).
   */
  send(frame: string): void {
    if (this._isConnected && this.socket) {
      this.socket.send(frame);
      return;
    }
    if (this.outboundQueue.length >= this.maxQueueSize) {
      throw new Error(
        `WSTransport: outbound queue full (${this.maxQueueSize}); drop or wait for reconnect`,
      );
    }
    this.outboundQueue.push(frame);
  }

  isConnected(): boolean { return this._isConnected; }
  isConnecting(): boolean { return this._isConnecting; }
  queuedFrames(): number { return this.outboundQueue.length; }
  reconnectAttemptCount(): number { return this.reconnectAttempts; }

  // -- internals -------------------------------------------------------------

  /** Begin the keep-alive loop (no-op when disabled). */
  private startHeartbeat(): void {
    if (this.heartbeatInterval <= 0) return;
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), this.heartbeatInterval);
  }

  /** Stop the keep-alive loop and clear any pending liveness deadline. */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  /**
   * Send one ping and arm a liveness deadline. If no `pongFrame` arrives before
   * `heartbeatTimeout`, the connection is considered dead and we force a
   * reconnect — this is what catches a silently-dropped TCP connection that
   * never fired `onclose` (the failure mode that "loses connection with the
   * Accelerator" on long sessions).
   */
  private sendHeartbeat(): void {
    if (!this._isConnected || !this.socket) return;
    try {
      this.socket.send(this.pingFrame);
    } catch {
      this.forceReconnect();
      return;
    }
    // A still-pending deadline means the previous pong never came back.
    if (this.pongTimer) return;
    this.pongTimer = setTimeout(() => {
      this.pongTimer = null;
      this.forceReconnect();
    }, this.heartbeatTimeout);
  }

  /**
   * Tear down a connection we believe is dead and kick off reconnect, without
   * waiting on the OS/browser to eventually fire `onclose` (which a half-open
   * socket may never do). We detach the handlers first so the normal close path
   * can't double-fire the reconnect.
   */
  private forceReconnect(): void {
    this.stopHeartbeat();
    const sock = this.socket;
    const wasConnected = this._isConnected;
    this.socket = null;
    this._isConnected = false;
    this._isConnecting = false;
    if (sock) {
      sock.onopen = null;
      sock.onmessage = null;
      sock.onerror = null;
      sock.onclose = null;
      try { sock.close(); } catch { /* already gone */ }
    }
    this.emit(EventCoreEvents.ERROR, new Error("WSTransport: heartbeat timeout"));
    this.emit(EventCoreEvents.DISCONNECTED, undefined);
    if (this.autoReconnect && wasConnected) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (
      this.maxReconnectAttempts > 0 &&
      this.reconnectAttempts >= this.maxReconnectAttempts
    ) {
      this.emit(
        EventCoreEvents.ERROR,
        new Error("WSTransport: max reconnect attempts reached"),
      );
      return;
    }
    this.reconnectAttempts++;
    this.emit(EventCoreEvents.RECONNECTING, { attempt: this.reconnectAttempts });
    this.reconnectTimeout = setTimeout(async () => {
      try {
        await this.connect();
      } catch {
        // scheduleReconnect will fire again from onclose
      }
    }, this.reconnectDelay);
  }

  private flushQueue(): void {
    if (this.outboundQueue.length === 0 || !this.socket) return;
    const pending = this.outboundQueue;
    this.outboundQueue = [];
    for (const frame of pending) {
      try {
        this.socket.send(frame);
      } catch {
        // re-queue if a flush fails
        this.outboundQueue.push(frame);
      }
    }
  }
}

export default WSTransport;
