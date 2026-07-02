/**
 * `PeerTransport` — the pluggable wire under the block engine. It moves opaque
 * frames between Space peers; it knows nothing about blocks, hashes, or the
 * protocol. {@link ./WebRtcTransport} implements it over RTCDataChannels today;
 * a future libp2p/Helia transport can implement the same interface without the
 * block engine or `ShardClient` changing.
 *
 * Implementations are responsible for fragmenting/ reassembling frames larger
 * than the underlying channel's max message size (a 4 MiB shard won't fit in one
 * `RTCDataChannel.send`); the engine always deals in whole frames.
 */

export type PeerId = string;

/**
 * Logical channels multiplexed over the one data link. `0` is block exchange
 * (the engine), `1` is gossip (app/CRDT data). The tag rides the framing header
 * so payloads aren't copied to prepend it.
 */
export const CHANNEL_BLOCK = 0;
export const CHANNEL_GOSSIP = 1;

export interface PeerTransport {
    /** Currently connected peer ids. */
    peers(): PeerId[];
    /** Dial a discovered peer (optional — some transports connect implicitly). */
    connectTo?(peer: PeerId): void;
    /** Send a whole frame to one peer on `channel` (fragmented internally if needed). */
    send(peer: PeerId, data: Uint8Array, channel?: number): void;
    /** Send a whole frame to every connected peer on `channel`. */
    broadcast(data: Uint8Array, channel?: number): void;
    /** Subscribe to inbound (reassembled) frames. Returns an unsubscribe fn. */
    onMessage(cb: (peer: PeerId, data: Uint8Array, channel: number) => void): () => void;
    /** Subscribe to the connected-peer set changing. Returns an unsubscribe fn. */
    onPeerChange(cb: (peers: PeerId[]) => void): () => void;
    /** Tear down all connections. */
    close(): void;
}
