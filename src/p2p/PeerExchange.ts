/**
 * `PeerExchange` — the thin façade the storage layer consults to try fetching a
 * block from peers before falling back to origin. It satisfies the structural
 * `PeerBlockSource` interface that {@link ../storage/transport/ShardClient}
 * declares (so storage never imports the p2p module — the dependency arrow stays
 * one-way, p2p → storage).
 *
 * It delegates to an {@link EngineHandle} — either an in-process {@link
 * ./worker/blockEngine.BlockEngine} or the Web Worker proxy — so the same façade
 * works whether the block engine runs on the main thread or off it.
 */

import type { PeerBlockSource } from "../storage/transport/ShardClient";

/** The subset of a block engine (in-process or worker-proxied) PeerExchange drives. */
export interface EngineHandle {
    want(hash: string, timeoutMs: number): Promise<Uint8Array | null>;
    announce(hash: string): void;
}

export interface PeerExchangeOptions {
    /** How long to wait for a peer before giving up to origin. Default 2500ms. */
    timeoutMs?: number;
    /** Log peer-served vs origin-fallback per block to the console. */
    debug?: boolean;
}

export class PeerExchange implements PeerBlockSource {
    private readonly timeoutMs: number;
    private readonly debug: boolean;

    constructor(private readonly engine: EngineHandle, opts: PeerExchangeOptions = {}) {
        this.timeoutMs = opts.timeoutMs ?? 2500;
        this.debug = opts.debug ?? false;
    }

    async getBlock(hash: string, opts?: { timeoutMs?: number }): Promise<Uint8Array | null> {
        const bytes = await this.engine.want(hash, opts?.timeoutMs ?? this.timeoutMs);
        if (this.debug) {
            console.info(
                `%c[muhkoo:p2p] ${bytes ? "✓ peer-served" : "✗ miss → origin"} shard ${hash.slice(0, 10)}…`,
                `color:${bytes ? "#58da7d" : "#888"}`,
            );
        }
        return bytes;
    }

    announce(hash: string): void {
        if (this.debug) console.info(`[muhkoo:p2p] announce shard ${hash.slice(0, 10)}…`);
        this.engine.announce(hash);
    }
}

export default PeerExchange;
