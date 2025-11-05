/**
 * Shared messaging types for Connect and Accelerator
 */

/**
 * Message event for pub/sub messaging
 */
export interface MessageEvent {
  type: string;
  topic: string;
  data: any;
  senderPublicKey?: string;  // Sender's identity
  timestamp: number;
}

/**
 * Message subscription
 */
export interface Subscription {
  connectionId: string;
  publicKey: string;  // Subscriber's identity
  topic: string;
  filters?: any;
}

/**
 * WebSocket message types
 */
export type WSMessageType =
  | 'connect'
  | 'connected'
  | 'subscribe'
  | 'subscribed'
  | 'unsubscribe'
  | 'publish'
  | 'event'
  | 'message'
  | 'error';

/**
 * WebSocket message
 */
export interface WSMessage {
  type: WSMessageType;
  topic?: string;
  data?: any;
  publicKey?: string;
  connectionId?: string;
  timestamp?: number;
}
