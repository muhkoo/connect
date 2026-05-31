/**
 * PacketCipher — the strategy `Network` uses to seal/open a packet's payload.
 *
 * `Network` owns the wire shape (Message ↔ Packet, header placement, transport,
 * reconnect, checksum). The *encryption* is pluggable: the default
 * {@link DoubleRatchetCipher} reproduces the per-peer Double Ratchet behavior
 * Network has always had, while the Space layer supplies a group-key cipher.
 *
 * The sealed ciphertext always rides in `Packet.headers` (cleartext routing
 * fields stay readable to the server); `Packet.message` is left undefined on
 * the wire so the server never sees the real payload.
 */

import type { Packet } from "../messaging/Packet";
import type { DoubleRatchetManager, CipherMessage } from "../crypto/DoubleRatchetManager";

export type PacketHeaders = Packet["headers"];

/** Header fields a cipher merges into the outgoing packet. */
export type SealedHeaders = Record<string, string | number | boolean>;

export interface PacketCipher {
    /**
     * Seal the serialized `Message`. Returns the header fields to merge into
     * the outgoing packet (these carry the ciphertext). `Network` clears
     * `packet.message` after calling this.
     */
    seal(serializedMessage: string, packet: Packet): Promise<SealedHeaders>;

    /** True if the inbound headers look like this cipher's sealed form. */
    handles(headers: PacketHeaders): boolean;

    /**
     * Open an inbound packet's headers back into a serialized `Message` string.
     * Returns `null` when the packet is not sealed for / not decryptable by us
     * (e.g. an epoch key we don't hold) — `Network` then leaves `packet.message`
     * untouched rather than throwing.
     */
    open(headers: PacketHeaders): Promise<string | null>;
}

export interface DoubleRatchetCipherDeps {
    ratchetManager: DoubleRatchetManager;
    clientId: string;
    serverId: string;
    sessionType: "global" | "specific";
    /** Resolves the live session id (Network manages the session lifecycle). */
    getSessionId: () => string | null;
    /** Whether this side is the ratchet "client" (default true). */
    isClient?: boolean;
}

/**
 * Default cipher: per-peer Double Ratchet. Reproduces Network's original
 * `{ encrypted: true, cipherMessage: <json> }` header convention exactly so
 * existing consumers are unaffected.
 */
export class DoubleRatchetCipher implements PacketCipher {
    constructor(private readonly deps: DoubleRatchetCipherDeps) {}

    async seal(serializedMessage: string): Promise<SealedHeaders> {
        const sessionId = this.deps.getSessionId();
        if (!sessionId) {
            throw new Error("DoubleRatchetCipher: no active session to seal under");
        }
        const cipherMessage = await this.deps.ratchetManager.encrypt(
            this.deps.clientId,
            this.deps.serverId,
            sessionId,
            serializedMessage,
            false, // newDhKey — let the ratchet manage key rotation
            this.deps.sessionType,
        );
        return { encrypted: true, cipherMessage: JSON.stringify(cipherMessage) };
    }

    handles(headers: PacketHeaders): boolean {
        return !!(headers?.encrypted && headers?.cipherMessage);
    }

    async open(headers: PacketHeaders): Promise<string | null> {
        if (!this.handles(headers)) return null;
        const cipherMessage = JSON.parse(headers!.cipherMessage as string) as CipherMessage;
        return this.deps.ratchetManager.decrypt(cipherMessage, this.deps.isClient ?? true);
    }
}
