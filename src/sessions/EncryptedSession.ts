/**
 * An end-to-end-encrypted communication session for one local identity
 * (`myId`) talking to an arbitrary set of peers. Wraps `KeyStore` +
 * per-pair `DoubleRatchet` instances and owns the protocol bookkeeping
 * (handshake reciprocation, dedup, role assignment, broadcast fan-out,
 * recipient filtering) so application code doesn't have to.
 *
 * Transport-agnostic by design: the Session never touches a WebSocket
 * (or HTTP, or anything else). Application code:
 *   - calls `session.encrypt(text)` and gets back an array of frames it
 *     ships over whatever transport it has;
 *   - calls `session.receive(frame)` with each inbound frame and acts on
 *     the typed result (plaintext, handshake-done, ignored).
 *
 * Frames are plain JSON objects with the same shape the existing chat
 * protocol uses (`{ keyExchange: {...} }` and `{ cipherMessage: {...} }`),
 * so this can drop into a chat app without changing the wire format.
 */

import { KeyStore } from "../crypto/KeyStore";
import { DoubleRatchet } from "../crypto/DoubleRatchet";
import type { CipherMessage } from "../crypto/types.d";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SessionOptions {
  /** This client's identifier (e.g. username / DID / public-key string). */
  myId: string;
}

/** A handshake frame the application ships to peers (or receives from them). */
export interface KeyExchangeFrame {
  type: "handshake" | "update";
  userId: string;
  /** Base64-encoded JWK of the sender's ECDH public key. */
  ecdhPublicKey: string;
  /** Base64-encoded JWK of the sender's ECDSA public key. */
  ecdsaPublicKey: string;
}

/** A ciphertext frame, addressed to exactly one peer. */
export interface CipherFrame {
  cipherMessage: CipherMessage;
}

/** Anything inbound the application might hand to `session.receive()`. */
export type IncomingFrame =
  | { keyExchange: KeyExchangeFrame }
  | { cipherMessage: CipherMessage }
  // Permits passing arbitrary frames; Session returns `kind: 'ignored'`.
  | Record<string, unknown>;

/** Outcome of feeding one frame through `session.receive()`. */
export type ReceiveResult =
  | {
      kind: "plaintext";
      /** The sender's id (from the cipherMessage header). */
      from: string;
      /** Decrypted message body. */
      text: string;
      /** The original cipherMessage, for callers that want it. */
      cipherMessage: CipherMessage;
    }
  | {
      kind: "handshake";
      /** The peer whose handshake was just processed. */
      peerId: string;
      /**
       * If non-null, the application MUST send this frame back to the peer
       * (e.g. broadcast on the room WebSocket). It's our reciprocation —
       * giving the peer our public keys so they can verify our messages.
       *
       * The Session dedups internally: we only emit this on the first
       * handshake we process for a given peer in this Session's lifetime.
       */
      outbound: { keyExchange: KeyExchangeFrame } | null;
    }
  | {
      kind: "ignored";
      /** Why we ignored the frame (debugging aid; not for branching on). */
      reason: string;
    };

// ---------------------------------------------------------------------------
// EncryptedSession
// ---------------------------------------------------------------------------

export class EncryptedSession {
  private readonly myId: string;
  private readonly keyStore: KeyStore;

  /** One DoubleRatchet per peer pair. */
  private readonly ratchets = new Map<string, DoubleRatchet>();

  /** Peers we've already sent our keyExchange to in this Session. */
  private readonly sentHandshakeTo = new Set<string>();

  /** Resolved when own keys are generated and ready to use. */
  private readonly _ready: Promise<void>;
  private _resolveReady!: () => void;
  private _initialized = false;

  constructor(opts: SessionOptions) {
    if (!opts || !opts.myId) {
      throw new Error("EncryptedSession: `myId` is required");
    }
    this.myId = opts.myId;
    this.keyStore = KeyStore.getInstance();
    this._ready = new Promise<void>((resolve) => {
      this._resolveReady = resolve;
    });
  }

  /** A promise that resolves once `initialize()` has completed. */
  get ready(): Promise<void> {
    return this._ready;
  }

  /** Our local identifier. */
  get id(): string {
    return this.myId;
  }

  /**
   * Generate this client's ECDH + ECDSA keypair (idempotent — safe to call
   * multiple times across reconnects; only the first call generates).
   */
  async initialize(): Promise<void> {
    if (this._initialized) return;
    if (!this.keyStore.getKeyPair(this.myId)) {
      await this.keyStore.generateOwnKeyPair(this.myId);
    }
    this._initialized = true;
    this._resolveReady();
  }

  /**
   * Build the keyExchange frame this client should send to peers when it
   * comes online. Application is responsible for actually transmitting it
   * (e.g. ws.send(JSON.stringify(frame))).
   */
  async getOwnKeyExchange(): Promise<{ keyExchange: KeyExchangeFrame }> {
    await this._ready;
    const ownEcdh = this.keyStore.getKeyPair(this.myId);
    const ownEcdsa = this.keyStore.getAuthKeyPair(this.myId);
    if (!ownEcdh || !ownEcdsa) {
      throw new Error("EncryptedSession.getOwnKeyExchange: keys not initialized");
    }
    return {
      keyExchange: {
        type: "handshake",
        userId: this.myId,
        ecdhPublicKey: await exportJwkBase64(ownEcdh.publicKey),
        ecdsaPublicKey: await exportJwkBase64(ownEcdsa.publicKey),
      },
    };
  }

  /**
   * Encrypt a plaintext to every peer we currently have a ratchet for, and
   * return one cipherMessage frame per recipient. The application sends
   * each frame over its transport.
   *
   * If there are no peers yet (or all peers are still mid-handshake), the
   * returned array may be empty — the caller should typically render the
   * outgoing message locally in that case (since there's no one to send
   * it to yet).
   */
  async encrypt(plaintext: string): Promise<CipherFrame[]> {
    await this._ready;
    const frames: CipherFrame[] = [];
    for (const peerId of this.ratchets.keys()) {
      const ratchet = this.ratchets.get(peerId)!;
      const sessionId = this._sessionIdFor(peerId);
      const cipherMessage = await ratchet.encrypt(
        plaintext,
        /* newDhKey */ false,
        this.myId,
        peerId,
        sessionId,
        "specific",
      );
      frames.push({ cipherMessage });
    }
    return frames;
  }

  /**
   * Hand an inbound frame to the session. Returns a typed result the
   * application acts on.
   *
   *   - `kind: 'plaintext'`         — decrypted; render `result.text`
   *   - `kind: 'handshake'`         — a peer's keys are now stored, and if
   *                                   `result.outbound` is set, send it
   *   - `kind: 'ignored'`           — not for us, malformed, duplicate, etc.
   *
   * Calling code should always handle `'ignored'` (no UI side effect).
   */
  async receive(frame: IncomingFrame): Promise<ReceiveResult> {
    await this._ready;

    // -- handshake frame -----------------------------------------------------
    if (isKeyExchangeFrame(frame)) {
      const kx = frame.keyExchange;
      const peerId = kx.userId;

      if (peerId === this.myId) {
        return { kind: "ignored", reason: "own keyExchange echo" };
      }

      const isNew = !this.ratchets.has(peerId);

      // (Re-)store the peer's pubkeys + (re-)build the ratchet if needed.
      const peerEcdh = await importJwkBase64(kx.ecdhPublicKey, "ECDH");
      const peerEcdsa = await importJwkBase64(kx.ecdsaPublicKey, "ECDSA");
      await this.keyStore.storeRemotePublicKeys(peerId, peerEcdh, peerEcdsa);

      if (isNew) {
        const isClient = this.myId < peerId;
        const ratchet = new DoubleRatchet(this.myId, peerId, "specific", isClient);
        await ratchet.initializeSession(isClient);
        this.ratchets.set(peerId, ratchet);
      }

      // Reciprocate exactly once per peer per session lifetime.
      let outbound: { keyExchange: KeyExchangeFrame } | null = null;
      if (isNew && !this.sentHandshakeTo.has(peerId)) {
        outbound = await this.getOwnKeyExchange();
        this.sentHandshakeTo.add(peerId);
      }

      return { kind: "handshake", peerId, outbound };
    }

    // -- ciphertext frame ----------------------------------------------------
    if (isCipherFrame(frame)) {
      const cipherMessage = frame.cipherMessage;
      const header = cipherMessage?.header;
      if (!header) {
        return { kind: "ignored", reason: "cipherMessage has no header" };
      }
      if (header.senderId === this.myId) {
        return { kind: "ignored", reason: "own outbound echo" };
      }
      if (header.recipientId && header.recipientId !== this.myId) {
        return { kind: "ignored", reason: "addressed to a different peer" };
      }

      const ratchet = this.ratchets.get(header.senderId);
      if (!ratchet) {
        return {
          kind: "ignored",
          reason: `no ratchet with sender ${header.senderId} (handshake hasn't completed)`,
        };
      }

      const isClient = this.myId < header.senderId;
      let text: string;
      try {
        text = await ratchet.decrypt(cipherMessage, isClient);
      } catch (err) {
        // DoubleRatchet's wallclock-based replay-protection check throws
        // "CipherMessage too old, possible replay attack" for any frame
        // older than 5 minutes. Real replays still fail downstream because
        // the message key has been consumed; the wallclock check is a
        // defense-in-depth heuristic, not a security boundary. Treating it
        // as `ignored` lets the channel survive legacy backlog replays and
        // CF WS-idle-timeout reconnect cycles without spamming the
        // channel's ERROR stream.
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("too old") || msg.includes("replay attack")) {
          return { kind: "ignored", reason: `stale cipherMessage rejected: ${msg}` };
        }
        throw err;
      }
      return { kind: "plaintext", from: header.senderId, text, cipherMessage };
    }

    return { kind: "ignored", reason: "unknown frame type" };
  }

  // -- introspection ---------------------------------------------------------

  /** List of peer ids we have an established ratchet for. */
  peers(): string[] {
    return Array.from(this.ratchets.keys());
  }

  /** Has the handshake completed for this peer? */
  hasRatchetFor(peerId: string): boolean {
    return this.ratchets.has(peerId);
  }

  /**
   * Tear down a peer's ratchet (e.g. when they leave the room). The peer's
   * stored keys remain in `KeyStore` so a fresh handshake can be set up
   * later without re-fetching them, but the ratchet state is dropped.
   */
  forgetPeer(peerId: string): void {
    this.ratchets.delete(peerId);
    this.sentHandshakeTo.delete(peerId);
  }

  // -- internals -------------------------------------------------------------

  /** Deterministic per-pair session id — same string on both sides. */
  private _sessionIdFor(peerId: string): string {
    return [this.myId, peerId].sort().join(":");
  }
}

// ---------------------------------------------------------------------------
// Helpers — JWK <-> base64 string for key transport
// ---------------------------------------------------------------------------

async function exportJwkBase64(key: CryptoKey): Promise<string> {
  const jwk = await crypto.subtle.exportKey("jwk", key);
  return btoa(JSON.stringify(jwk));
}

async function importJwkBase64(
  b64: string,
  type: "ECDH" | "ECDSA",
): Promise<CryptoKey> {
  const jwk = JSON.parse(atob(b64));
  const algorithm =
    type === "ECDH"
      ? { name: "ECDH", namedCurve: "P-384" }
      : { name: "ECDSA", namedCurve: "P-384" };
  const usages: KeyUsage[] = type === "ECDH" ? [] : ["verify"];
  return await crypto.subtle.importKey("jwk", jwk, algorithm, true, usages);
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isKeyExchangeFrame(
  frame: IncomingFrame,
): frame is { keyExchange: KeyExchangeFrame } {
  const kx = (frame as { keyExchange?: unknown }).keyExchange;
  if (!kx || typeof kx !== "object") return false;
  const k = kx as Partial<KeyExchangeFrame>;
  return (
    typeof k.userId === "string" &&
    typeof k.ecdhPublicKey === "string" &&
    typeof k.ecdsaPublicKey === "string"
  );
}

function isCipherFrame(
  frame: IncomingFrame,
): frame is { cipherMessage: CipherMessage } {
  const cm = (frame as { cipherMessage?: unknown }).cipherMessage;
  if (!cm || typeof cm !== "object") return false;
  const m = cm as Partial<CipherMessage>;
  return Boolean(m.header && m.ciphertext && m.nonce);
}
