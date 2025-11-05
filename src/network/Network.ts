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
  private socket: WebSocket | null = null;
  private socketId: string = _socketId();

  // HTTP configuration
  private httpTimeout: number;
  private httpRetry: { maxRetries: number; retryDelay: number };
  private defaultHeaders: Record<string, string>;

  // Reconnection state
  private autoReconnect: boolean;
  private reconnectDelay: number;
  private maxReconnectAttempts: number;
  private reconnectAttempts: number = 0;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

  // Message queue for offline messages
  private messageQueue: Packet[] = [];
  private maxQueueSize: number = 100;

  // Connection state
  private _isConnected: boolean = false;
  private _isConnecting: boolean = false;

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
    this.autoReconnect = options.autoReconnect ?? true;
    this.reconnectDelay = options.reconnectDelay || 3000;
    this.maxReconnectAttempts = options.maxReconnectAttempts || 5;

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
   * Connect to the WebSocket server
   */
  async connect(): Promise<void> {
    if (this._isConnected || this._isConnecting) {
      throw new Error('Already connected or connecting');
    }

    // Initialize session if not already done
    await this.initializeSession();

    this._isConnecting = true;

    return new Promise((resolve, reject) => {
      try {
        this.socket = new WebSocket(this.url);

        this.socket.onopen = () => {
          this._isConnected = true;
          this._isConnecting = false;
          this.reconnectAttempts = 0;

          console.log(`[Network] Connected to ${this.url}`);
          // this.dispatchEvent(new CustomEvent('connected'));
          this.emit(EventCoreEvents.CONNECTED, undefined);

          // Flush queued messages
          this.flushMessageQueue();

          resolve();
        };

        this.socket.onmessage = async (event) => {
          await this.handleIncomingMessage(event.data);
        };

        this.socket.onerror = (error) => {
          console.error('[Network] WebSocket error:', error);
          // this.dispatchEvent(new CustomEvent('error', { detail: error }));
          this.emit(EventCoreEvents.ERROR, error);

          if (this._isConnecting) {
            this._isConnecting = false;
            reject(error);
          }
        };

        this.socket.onclose = () => {
          const wasConnected = this._isConnected;
          this._isConnected = false;
          this._isConnecting = false;

          console.log('[Network] Disconnected from server');
          // this.dispatchEvent(new CustomEvent('disconnected'));
          this.emit(EventCoreEvents.DISCONNECTED, undefined);

          // Attempt reconnection if enabled and we were previously connected
          if (this.autoReconnect && wasConnected) {
            this.scheduleReconnect();
          }
        };

      } catch (error) {
        this._isConnecting = false;
        reject(error);
      }
    });
  }

  /**
   * Disconnect from the WebSocket server
   */
  disconnect(): void {
    // Cancel any pending reconnection
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    // Disable auto-reconnect when manually disconnecting
    this.autoReconnect = false;

    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }

    this._isConnected = false;
    this._isConnecting = false;
  }

  /**
   * Schedule a reconnection attempt
   */
  private scheduleReconnect(): void {
    // Check if we've exceeded max attempts
    if (this.maxReconnectAttempts > 0 && this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[Network] Max reconnection attempts reached');
      // this.dispatchEvent(new CustomEvent('error', {
      //   detail: new Error('Max reconnection attempts reached')
      // }));
      this.emit(EventCoreEvents.ERROR, new Error('Max reconnection attempts reached'));

      return;
    }

    this.reconnectAttempts++;
    console.log(`[Network] Reconnecting in ${this.reconnectDelay}ms (attempt ${this.reconnectAttempts})`);
    // this.dispatchEvent(new CustomEvent('reconnecting', {
    //   detail: { attempt: this.reconnectAttempts }
    // }));
    this.emit(EventCoreEvents.RECONNECTING, { attempt: this.reconnectAttempts });

    this.reconnectTimeout = setTimeout(async () => {
      try {
        await this.connect();
      } catch (error) {
        console.error('[Network] Reconnection failed:', error);
        // scheduleReconnect will be called again via socket.onclose
      }
    }, this.reconnectDelay);
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
      // Ensure session is initialized
      if (!this.sessionId) {
        await this.initializeSession();
      }

      // Create packet with source set to clientId
      const packet = new Packet({
        ...options,
        source: this.clientId,
      });

      // If message exists, encrypt it
      if (packet.message) {
        const serializedMessage = packet.message.serialize();

        // Encrypt using DoubleRatchetManager
        const cipherMessage = await this.ratchetManager.encrypt(
          this.clientId,
          this.serverId,
          this.sessionId!,
          serializedMessage,
          false, // newDhKey - let ratchet manage key rotation
          this.sessionType
        );

        // Store encrypted message in packet headers
        packet.headers = {
          ...packet.headers,
          encrypted: true,
          cipherMessage: JSON.stringify(cipherMessage),
        };

        // Clear the message field (we'll send encrypted version in headers)
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
   * Send a packet over the WebSocket
   */
  private async sendPacket(packet: Packet): Promise<void> {
    if (!this._isConnected || !this.socket) {
      // Queue message if not connected
      if (this.messageQueue.length < this.maxQueueSize) {
        this.messageQueue.push(packet);
        console.log('[Network] Message queued (offline)');
      } else {
        throw new Error('Message queue full. Cannot send message.');
      }
      return;
    }

    try {
      const serialized = packet.serialize();
      this.socket.send(serialized);
    } catch (error) {
      console.error('[Network] Failed to send packet:', error);
      throw error;
    }
  }

  /**
   * Flush queued messages after reconnection
   */
  private async flushMessageQueue(): Promise<void> {
    if (this.messageQueue.length === 0) return;

    console.log(`[Network] Flushing ${this.messageQueue.length} queued messages`);

    const queue = [...this.messageQueue];
    this.messageQueue = [];

    for (const packet of queue) {
      try {
        await this.sendPacket(packet);
      } catch (error) {
        console.error('[Network] Failed to send queued packet:', error);
        // Re-queue if failed
        this.messageQueue.push(packet);
      }
    }
  }

  // ============================================================================
  // Message Receiving
  // ============================================================================

  /**
   * Handle incoming WebSocket message
   */
  private async handleIncomingMessage(data: string): Promise<void> {
    try {
      // Deserialize packet
      const packet = Packet.deserialize(data);

      // Check if packet is expired
      if (packet.isExpired()) {
        console.warn('[Network] Received expired packet:', packet.id);
        return;
      }

      // Decrypt message if encrypted
      if (packet.headers?.encrypted && packet.headers?.cipherMessage) {
        const cipherMessage = JSON.parse(packet.headers.cipherMessage as string) as CipherMessage;

        // Decrypt using DoubleRatchetManager
        const decryptedMessage = await this.ratchetManager.decrypt(
          cipherMessage,
          true // isClient
        );

        // Reconstruct message
        packet.message = Message.deserialize(decryptedMessage);

        // Verify checksum
        if (packet.message.checksum) {
          packet.message.verifyChecksum();
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
    return this._isConnected;
  }

  /**
   * Check if currently connecting
   */
  isConnecting(): boolean {
    return this._isConnecting;
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
    return this.messageQueue.length;
  }

  /**
   * Get reconnection attempt count
   */
  getReconnectAttempts(): number {
    return this.reconnectAttempts;
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
