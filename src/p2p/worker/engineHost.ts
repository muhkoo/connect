/**
 * `EngineHost` — the boundary {@link ../PeerNetwork} wires a transport to. It
 * abstracts *where* the {@link ./blockEngine.BlockEngine} runs:
 *   - {@link LocalEngineHost} runs it on the calling thread (tests, or a
 *     fallback when the Web Worker can't be built by a consumer's bundler);
 *   - the Worker proxy ({@link ./engineClient}) runs it off-thread.
 *
 * Either way the host exposes the same surface: drive `want`/`announce`, feed it
 * inbound frames via `handleFrame`, and receive its outbound frames via
 * `onOutbound` (which the network forwards to the transport).
 */

import { BlockEngine, type BlockStore, type Hasher } from "./blockEngine";

export interface EngineHost {
    want(hash: string, timeoutMs: number): Promise<Uint8Array | null>;
    announce(hash: string): void;
    /** Feed an inbound frame received from `peer` on the transport. */
    handleFrame(peer: string, frame: Uint8Array): void;
    /** Receive frames the engine wants to send (`"*"` = broadcast). */
    onOutbound(cb: (target: string, frame: Uint8Array) => void): () => void;
    close(): void;
}

/** Runs the engine in-process (main thread or test). */
export class LocalEngineHost implements EngineHost {
    private readonly engine: BlockEngine;
    private readonly cbs = new Set<(target: string, frame: Uint8Array) => void>();

    constructor(store: BlockStore, hasher: Hasher) {
        this.engine = new BlockEngine(
            store,
            (target, frame) => {
                for (const cb of this.cbs) cb(target, frame);
            },
            hasher,
        );
    }

    want(hash: string, timeoutMs: number): Promise<Uint8Array | null> {
        return this.engine.want(hash, timeoutMs);
    }
    announce(hash: string): void {
        this.engine.announce(hash);
    }
    handleFrame(peer: string, frame: Uint8Array): void {
        void this.engine.handleFrame(peer, frame);
    }
    onOutbound(cb: (target: string, frame: Uint8Array) => void): () => void {
        this.cbs.add(cb);
        return () => this.cbs.delete(cb);
    }
    close(): void {
        this.engine.close();
        this.cbs.clear();
    }
}

export default LocalEngineHost;
