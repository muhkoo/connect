/**
 * Network Class - Central handler for encrypted WebSocket communication
 *
 * Responsibilities:
 * - Manages WebSocket connection lifecycle
 * - Encrypts/decrypts all communication using SessionManager
 * - Serializes Messages into Packets for transmission
 * - Deserializes incoming Packets into Messages
 * - Event-driven architecture for handling received messages (uses EventTarget)
 * - Automatic reconnection logic
 * - Message queue for offline messages
 *
 * Events:
 * - 'connected': Fired when connection established
 * - 'disconnected': Fired when connection closed
 * - 'message': Fired when message received (detail: Packet)
 * - 'error': Fired on error (detail: Error)
 * - 'reconnecting': Fired when attempting reconnect (detail: { attempt: number })
 */

import { DoubleRatchetManager, CipherMessage } from '../crypto/DoubleRatchetManager';
import { KeyStore } from '../crypto/KeyStore';
import { Message } from '../messaging/Message';
import { Packet, PacketOptions } from '../messaging/Packet';
import { _socketId } from '../utilities';
import { appLogger } from '../core';
import { EventCore, EventCoreEvents } from '../events';
import { WSTransport } from '../transport';
import { PacketCipher, DoubleRatchetCipher } from './PacketCipher';

export interface NetworkOptions {
  /** WebSocket URL (e.g., ws://localhost:8787 or wss://api.example.com) */
  url: string;
  /** Base URL for REST API calls (e.g., http://localhost:8787 or https://api.example.com) */
  apiUrl?: string;
  /** Client identifier */
  clientId: string;
  /** Server identifier */
  serverId: string;
  /** Session type (default: 'specific') */
  sessionType?: 'global' | 'specific';
  /** Auto-reconnect on disconnect (default: true) */
  autoReconnect?: boolean;
  /** Reconnect delay in milliseconds (default: 3000) */
  reconnectDelay?: number;
  /** Maximum reconnection attempts (default: 5, 0 = infinite) */
  maxReconnectAttempts?: number;
  /** HTTP request timeout in milliseconds (default: 30000) */
  httpTimeout?: number;
  /** HTTP retry configuration */
  httpRetry?: {
    maxRetries: number;
    retryDelay: number;
  };
  /** Default HTTP headers */
  defaultHeaders?: Record<string, string>;
  /**
   * Payload cipher strategy. Defaults to a {@link DoubleRatchetCipher} bound
   * to this Network's ratchet manager (the historical behavior). Supply a
   * group-key cipher (e.g. from the Space layer) to seal fan-out messages.
   */
  cipher?: PacketCipher;
  /**
   * Optional top-level frame discriminator. When set, outbound packets are
   * wrapped as `{ [frameTag]: <packet.serialize()> }` and inbound frames are
   * unwrapped from `frame[frameTag]` before decryption. Frames lacking the tag
   * are surfaced verbatim via the `data_received` event (control frames).
   * Needed for the SharedSpace transport, which discriminates on top-level keys.
   */
  frameTag?: string;
}

/**
 * Network events
 */
export type NetworkEventMap = {
  'connected': CustomEvent<void>;
  'disconnected': CustomEvent<void>;
  'message': CustomEvent<Packet>;
  'error': CustomEvent<Error>;
  'reconnecting': CustomEvent<{ attempt: number }>;
};

/**
 * HTTP request/response types
 */
export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  headers?: Record<string, string>;
  body?: any;
  timeout?: number;
  retries?: number;
}

export interface HttpResponse<T = any> {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  data: T;
}

/**
 * Network Error class for HTTP errors
 */
export class NetworkError extends Error {
  constructor(
    public code: string,
    message: string,
    public status?: number,
    public details?: any
  ) {
    super(message);
    this.name = 'NetworkError';
  }
}

/**
 * Network class extends EventCore for proper event handling
 */
export class Network extends EventCore {
  private url: string;
  private apiUrl: string;
  private ratchetManager: DoubleRatchetManager;
  private keyStore: KeyStore;
  private clientId: string;
  private serverId: string;
  private sessionType: 'global' | 'specific';
  private sessionId: string | null = null;
  private socketId: string = _socketId();

  // WebSocket lifecycle is delegated to WSTransport. Network re-emits its
  // events so existing consumers (Client.ts) keep working unchanged.
  private transport: WSTransport;

  // Pluggable payload cipher (default: Double Ratchet).
  private cipher: PacketCipher;
  // Optional top-level frame discriminator for transports that route on it.
  private frameTag?: string;
  // False when a custom cipher manages its own keys (skip DR session setup).
  private usesDefaultCipher: boolean = true;

  // HTTP configuration
  private httpTimeout: number;
  private httpRetry: { maxRetries: number; retryDelay: number };
  private defaultHeaders: Record<string, string>;

  emit = EventCore.emit;
  on = EventCore.on;
  off = EventCore.off;

  constructor(options: NetworkOptions) {
    super(); // Call EventTarget constructor

    this.url = options.url || 'ws://localhost:8787';
    this.apiUrl = options.apiUrl || options.url.replace(/^ws/, 'http').replace(/\/ws.*$/, '');
    this.clientId = options.clientId || 'client-' + _socketId();
    this.serverId = options.serverId || 'server';
    this.sessionType = options.sessionType || 'specific';
    this.ratchetManager = new DoubleRatchetManager(this.clientId);
    this.keyStore = KeyStore.getInstance();

    this.transport = new WSTransport({
      url: this.url,
      autoReconnect: options.autoReconnect ?? true,
      reconnectDelay: options.reconnectDelay || 3000,
      maxReconnectAttempts: options.maxReconnectAttempts || 5,
    });
    // Route inbound frames through Network's decryption layer.
    this.transport.on(EventCoreEvents.MESSAGE, (e: CustomEvent) => {
      void this.handleIncomingMessage(e.detail as string);
    });

    // Payload cipher: caller-supplied (e.g. group-key) or the default Double
    // Ratchet bound to this Network's ratchet manager + session.
    this.cipher = options.cipher ?? new DoubleRatchetCipher({
      ratchetManager: this.ratchetManager,
      clientId: this.clientId,
      serverId: this.serverId,
      sessionType: this.sessionType,
      getSessionId: () => this.sessionId,
      isClient: true,
    });
    this.frameTag = options.frameTag;
    // A caller-supplied cipher (e.g. group-key) manages its own keys; skip the
    // Double Ratchet session bootstrap entirely in that case.
    this.usesDefaultCipher = !options.cipher;

    // HTTP configuration
    this.httpTimeout = options.httpTimeout || 30000;
    this.httpRetry = options.httpRetry || { maxRetries: 3, retryDelay: 1000 };
    this.defaultHeaders = options.defaultHeaders || {};
  }

  // ============================================================================
  // Connection Management
  // ============================================================================

  /**
   * Generate key pairs for the client if not already present
   */
  async generateKeys(): Promise<void> {
    const existingKeys = this.keyStore.getKeyPair(this.clientId);
    if (!existingKeys) {
      await this.keyStore.generateOwnKeyPair(this.clientId);
      appLogger.debug(`[Network] Generated key pairs for ${this.clientId}`);
    }
  }

  /**
   * Initialize the ratchet session
   */
  async initializeSession(): Promise<void> {
    // Custom ciphers (e.g. group-key) own their key material — no DR session.
    if (!this.usesDefaultCipher) {
      await this.generateKeys();
      return;
    }
    if (!this.sessionId) {
      // Ensure keys are generated
      await this.generateKeys();

      // Initialize session with the server
      this.sessionId = await this.ratchetManager.initializeSession(
        this.clientId,
        this.serverId,
        true, // isClient
        this.sessionType
      );
      appLogger.debug(`[Network] Session initialized: ${this.sessionId}`);
    }
  }

  /**
   * Connect to the WebSocket server. Delegates the actual socket lifecycle
   * to WSTransport; Network only owns the encrypted-session layer above.
   */
  async connect(): Promise<void> {
    // Initialize session before opening the socket so we have a ratchet
    // ready by the time the first message can flow.
    await this.initializeSession();
    return this.transport.connect();
  }

  /** Close the WebSocket. */
  disconnect(): void {
    this.transport.disconnect();
  }

  // ============================================================================
  // Message Sending
  // ============================================================================

  /**
   * Send a message to the server
   * Messages are automatically encrypted using the DoubleRatchetManager
   */
  async send(options: Omit<PacketOptions, 'source'>): Promise<boolean> {
    try {
      // Ensure key material / session is ready.
      if (this.usesDefaultCipher && !this.sessionId) {
        await this.initializeSession();
      }

      // Create packet with source set to clientId
      const packet = new Packet({
        ...options,
        source: this.clientId,
      });

      // If a payload exists, seal it via the active cipher. The ciphertext
      // rides in headers; the cleartext message field is cleared on the wire.
      if (packet.message) {
        const sealed = await this.cipher.seal(packet.message.serialize(), packet);
        packet.headers = { ...packet.headers, ...sealed };
        packet.message = undefined;
      }

      // Send packet
      await this.sendPacket(packet);
      return true;
    } catch (error) {
      console.error('[Network] Failed to send message:', error);
      return false;
    }
  }

  /**
   * Send a packet over the WebSocket. WSTransport handles the connected /
   * disconnected branch and queues frames when offline. When a `frameTag` is
   * configured the serialized packet is wrapped under that key so transports
   * that discriminate on a top-level field (e.g. SharedSpace) can route it.
   */
  private async sendPacket(packet: Packet): Promise<void> {
    const serialized = packet.serialize();
    const frame = this.frameTag
      ? JSON.stringify({ [this.frameTag]: serialized })
      : serialized;
    this.transport.send(frame);
  }

  // ============================================================================
  // Message Receiving
  // ============================================================================

  /**
   * Handle incoming WebSocket message
   */
  private async handleIncomingMessage(data: string): Promise<void> {
    try {
      // When a frameTag is configured, the wire carries a top-level envelope.
      // Pull the packet out of `frame[frameTag]`; anything without the tag is a
      // control frame the higher layer (e.g. Space) handles — surface it raw.
      let packetJson = data;
      if (this.frameTag) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          this.emit(EventCoreEvents.DATA_RECEIVED, data);
          return;
        }
        const tagged = (parsed as Record<string, unknown>)?.[this.frameTag];
        if (typeof tagged !== 'string') {
          this.emit(EventCoreEvents.DATA_RECEIVED, parsed);
          return;
        }
        packetJson = tagged;
      }

      // Deserialize packet
      const packet = Packet.deserialize(packetJson);

      // Check if packet is expired
      if (packet.isExpired()) {
        console.warn('[Network] Received expired packet:', packet.id);
        return;
      }

      // Open the sealed payload via the active cipher (null = not for us).
      if (this.cipher.handles(packet.headers)) {
        const decrypted = await this.cipher.open(packet.headers);
        if (decrypted !== null) {
          packet.message = Message.deserialize(decrypted);
          if (packet.message.checksum) {
            packet.message.verifyChecksum();
          }
        }
      }

      // Emit message event with packet
      this.emit(EventCoreEvents.MESSAGE, packet);

    } catch (error) {
      console.error('[Network] Error handling incoming message:', error);
      this.emit(EventCoreEvents.ERROR, error as Error);
    }
  }

  // ============================================================================
  // HTTP/REST Methods
  // ============================================================================

  /**
   * Make an encrypted GET request using packet structure
   */
  async get<T = any>(options: Omit<PacketOptions, 'source'>): Promise<HttpResponse<T>> {
    return this.rest<T>('GET', options);
  }

  /**
   * Make an encrypted POST request using packet structure
   */
  async post<T = any>(options: Omit<PacketOptions, 'source'>): Promise<HttpResponse<T>> {
    return this.rest<T>('POST', options);
  }

  /**
   * Make an encrypted PUT request using packet structure
   */
  async put<T = any>(options: Omit<PacketOptions, 'source'>): Promise<HttpResponse<T>> {
    return this.rest<T>('PUT', options);
  }

  /**
   * Make an encrypted DELETE request using packet structure
   */
  async delete<T = any>(options: Omit<PacketOptions, 'source'>): Promise<HttpResponse<T>> {
    return this.rest<T>('DELETE', options);
  }

  /**
   * Make an encrypted PATCH request using packet structure
   */
  async patch<T = any>(options: Omit<PacketOptions, 'source'>): Promise<HttpResponse<T>> {
    return this.rest<T>('PATCH', options);
  }

  /**
   * Make an encrypted REST request using packet structure
   */
  private async rest<T = any>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
    options: Omit<PacketOptions, 'source'>
  ): Promise<HttpResponse<T>> {
    // Ensure session is initialized
    if (!this.sessionId) {
      await this.initializeSession();
    }

    // Create packet with source set to clientId
    const packet = new Packet({
      ...options,
      source: this.clientId,
    });

    // Build URL from subject (as path) or use target as path
    const path = packet.subject ? `/${packet.subject.replace(/\./g, '/')}` : `/${packet.target}`;
    const url = `${this.apiUrl}${path}`;

    const timeout = (packet.headers?.timeout as number) || this.httpTimeout;
    const maxRetries = (packet.headers?.retries as number) ?? this.httpRetry.maxRetries;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // Prepare request body
        let requestBody: string | undefined;

        if (packet.message) {
          // Serialize and encrypt the message
          const serializedMessage = packet.message.serialize();
          const cipherMessage = await this.ratchetManager.encrypt(
            this.clientId,
            this.serverId,
            this.sessionId!,
            serializedMessage,
            false,
            this.sessionType
          );

          // Send encrypted payload
          requestBody = JSON.stringify({
            encrypted: true,
            cipherMessage,
            packetId: packet.id,
            timestamp: packet.timestamp,
          });
        } else if (packet.headers?.body) {
          // If raw body is provided in headers
          const bodyData = JSON.stringify(packet.headers.body);
          const cipherMessage = await this.ratchetManager.encrypt(
            this.clientId,
            this.serverId,
            this.sessionId!,
            bodyData,
            false,
            this.sessionType
          );

          requestBody = JSON.stringify({
            encrypted: true,
            cipherMessage,
            packetId: packet.id,
            timestamp: packet.timestamp,
          });
        }

        // Prepare headers - merge packet headers with default headers
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'X-Client-Id': this.clientId,
          'X-Session-Id': this.sessionId!,
          'X-Packet-Id': packet.id,
          'X-Source': packet.source,
          'X-Target': packet.target,
          ...this.defaultHeaders,
        };

        // Add custom headers from packet (excluding special ones)
        if (packet.headers) {
          Object.keys(packet.headers).forEach(key => {
            if (!['timeout', 'retries', 'body', 'encrypted', 'cipherMessage'].includes(key)) {
              headers[`X-${key}`] = String(packet.headers![key]);
            }
          });
        }

        // Make the request
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        const response = await fetch(url, {
          method,
          headers,
          body: requestBody,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        // Parse response
        const responseText = await response.text();
        let responseData: any;

        try {
          const parsedResponse = JSON.parse(responseText);

          // Check if response is encrypted
          if (parsedResponse.encrypted && parsedResponse.cipherMessage) {
            const decryptedText = await this.ratchetManager.decrypt(
              parsedResponse.cipherMessage as CipherMessage,
              true
            );
            responseData = JSON.parse(decryptedText);
          } else {
            responseData = parsedResponse;
          }
        } catch (e) {
          // If not JSON or decryption fails, use raw text
          responseData = responseText;
        }

        // Convert headers to object
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });

        // Return successful response
        return {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
          data: responseData as T,
        };

      } catch (error) {
        lastError = error as Error;

        // Handle specific error types
        if (error instanceof Error) {
          if (error.name === 'AbortError') {
            throw new NetworkError('TIMEOUT', `Request timed out after ${timeout}ms`);
          }
        }

        // Retry logic
        if (attempt < maxRetries) {
          appLogger.debug(
            `[Network] HTTP request failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying...`
          );
          await new Promise(resolve => setTimeout(resolve, this.httpRetry.retryDelay));
          continue;
        }
      }
    }

    // All retries exhausted
    throw new NetworkError(
      'REQUEST_FAILED',
      `Request failed after ${maxRetries + 1} attempts: ${lastError?.message || 'Unknown error'}`,
      undefined,
      lastError
    );
  }

  subscribe<T>(event: string, listener: (data: T) => void): void {
    this.on(event as EventCoreEvents, listener);
  }

  // ============================================================================
  // Getters
  // ============================================================================

  /**
   * Check if connected to server
   */
  isConnected(): boolean {
    return this.transport.isConnected();
  }

  /**
   * Check if currently connecting
   */
  isConnecting(): boolean {
    return this.transport.isConnecting();
  }

  /**
   * Get the current socket ID
   */
  getSocketId(): string {
    return this.socketId;
  }

  /**
   * Get the client ID
   */
  getClientId(): string {
    return this.clientId;
  }

  /**
   * Get number of queued messages
   */
  getQueuedMessageCount(): number {
    return this.transport.queuedFrames();
  }

  /**
   * Get reconnection attempt count
   */
  getReconnectAttempts(): number {
    return this.transport.reconnectAttemptCount();
  }

  /**
   * Get the ratchet manager instance
   */
  getRatchetManager(): DoubleRatchetManager {
    return this.ratchetManager;
  }

  /**
   * Get the current session ID
   */
  getSessionId(): string | null {
    return this.sessionId;
  }
}

export default Network;
