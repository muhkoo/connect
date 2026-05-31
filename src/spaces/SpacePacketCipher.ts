/**
 * SpacePacketCipher — the {@link PacketCipher} that seals packets with a
 * space's group key instead of a per-peer Double Ratchet.
 *
 * It pulls the active epoch's key from an {@link EpochKeyProvider} (the
 * SpaceKeyring), so this adapter stays decoupled from the keyring's transport
 * and caching concerns — it only needs "what key seals epoch N".
 */

import type { PacketCipher, PacketHeaders, SealedHeaders } from "../network/PacketCipher";
import { sealSerialized, openSerialized } from "./SpaceCipher";

/** Minimal view of the keyring the cipher needs. */
export interface EpochKeyProvider {
    /** Epoch new messages are sealed under (advances on rotation). */
    currentEpoch(): number;
    /** The 32-byte group key for an epoch, or undefined if we don't hold it. */
    keyForEpoch(epoch: number): Uint8Array | undefined;
}

export class SpacePacketCipher implements PacketCipher {
    constructor(
        private readonly keys: EpochKeyProvider,
        private readonly contentType?: string,
    ) {}

    async seal(serializedMessage: string): Promise<SealedHeaders> {
        const epoch = this.keys.currentEpoch();
        const key = this.keys.keyForEpoch(epoch);
        if (!key) {
            throw new Error(`SpacePacketCipher: no group key for epoch ${epoch}`);
        }
        const { iv, ciphertext } = await sealSerialized(key, serializedMessage);
        const headers: SealedHeaders = { spaceSealed: true, epoch, iv, ciphertext };
        if (this.contentType) headers.contentType = this.contentType;
        return headers;
    }

    handles(headers: PacketHeaders): boolean {
        return headers?.spaceSealed === true &&
            typeof headers?.iv === "string" &&
            typeof headers?.ciphertext === "string";
    }

    /** Returns null for epochs we don't hold (surfaced as undecryptable). */
    async open(headers: PacketHeaders): Promise<string | null> {
        if (!this.handles(headers)) return null;
        const epoch = Number(headers!.epoch);
        const key = this.keys.keyForEpoch(epoch);
        if (!key) return null;
        return openSerialized(key, headers!.iv as string, headers!.ciphertext as string);
    }
}
