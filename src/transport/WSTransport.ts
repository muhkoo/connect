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

export interface WSTransportOptions {
  /** WebSocket URL, e.g. `ws://localhost:8787/foo`. */
  url: string;
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
}

export class WSTransport extends EventCore {
  emit = EventCore.emit;
  on = EventCore.on;
  off = EventCore.off;

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

  constructor(opts: WSTransportOptions) {
    super();
    if (!opts || !opts.url) {
      throw new Error("WSTransport: `url` is required");
    }
    this.url = opts.url;
    this.autoReconnect = opts.autoReconnect ?? true;
    this.reconnectDelay = opts.reconnectDelay ?? 3000;
    this.maxReconnectAttempts = opts.maxReconnectAttempts ?? 5;
    this.maxQueueSize = opts.maxQueueSize ?? 100;
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
          resolve();
        };

        socket.onmessage = (event: MessageEvent) => {
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
