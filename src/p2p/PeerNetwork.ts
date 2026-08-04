/**
 * `PeerNetwork` — the per-Space orchestrator that ties the pieces together on
 * the main thread:
 *
 *   transport (WebRTC)  ⇄  engine host (Worker or in-process)  →  PeerExchange
 *        ▲                                                            │
 *        └────────────── signaling over the Space relay ─────────────┘
 *
 * It owns one {@link ./transport/WebRtcTransport} + one {@link
 * ./worker/engineHost.EngineHost}, wires inbound frames to the engine and the
 * engine's outbound frames back to the transport, runs peer discovery over the
 * Space's ephemeral channel, and exposes a {@link ./PeerExchange.PeerExchange}
 * for `ShardClient` to consult. Scope is one Space (private swarm).
 *
 * `engineHost` defaults to in-process; pass `workerFactory` to run the block
 * engine off the main thread (the consumer's bundler resolves the worker URL).
 */

import { ShardCache } from "../offline/cache/ShardCache";
import { shardHash } from "../storage/transport/ShardClient";
import { PeerExchange } from "./PeerExchange";
import { SpaceSignaler, type SignalingSpace } from "./signaling/SpaceSignaler";
import { WebRtcTransport } from "./transport/WebRtcTransport";
import { CHANNEL_BLOCK, CHANNEL_GOSSIP, type PeerTransport } from "./transport/PeerTransport";
import { LocalEngineHost, type EngineHost } from "./worker/engineHost";
import { WorkerEngineHost } from "./worker/engineClient";
import type { BlockStore } from "./worker/blockEngine";

export interface PeerNetworkOptions {
    /** The Space (used for signaling over its ephemeral relay). */
    space: SignalingSpace;
    /** Our authenticated member id (the Space's `myId`). */
    myId: string;
    /** Blockstore for the in-process engine. Defaults to a `ShardCache`. */
    store?: BlockStore;
    /** Run the block engine in a Worker — `() => new Worker(new URL(...))`. */
    workerFactory?: () => Worker;
    iceServers?: RTCIceServer[];
    maxPeers?: number;
    /** Peer fetch timeout passed to PeerExchange. */
    timeoutMs?: number;
    /** Inject a transport (tests / a future libp2p transport). Default WebRTC. */
    transport?: PeerTransport;
    /** Log mesh + block-exchange activity to the console (use on staging/dev). */
    debug?: boolean;
}

/**
 * Build the engine host, preferring an off-thread Web Worker:
 *   1. an explicit `workerFactory` (most reliable in app bundlers), else
 *   2. the bundled worker resolved relative to this module (works where the
 *      bundler supports `new Worker(new URL(...))`, e.g. Vite builds), else
 *   3. the in-process engine (always works; tests + non-worker runtimes).
 * Any worker construction failure degrades to in-process.
 */
function buildEngineHost(opts: PeerNetworkOptions): EngineHost {
    try {
        const worker = opts.workerFactory ? opts.workerFactory() : defaultWorker();
        if (worker) return new WorkerEngineHost(worker);
    } catch {
        /* no Worker global / bundler can't resolve it → in-process */
    }
    return new LocalEngineHost(opts.store ?? new ShardCache(), shardHash);
}

/** Construct the bundled worker if the runtime + bundler support it, else null. */
function defaultWorker(): Worker | null {
    try {
        if (typeof Worker === "undefined") return null;
        // The string is resolved by the consumer's bundler relative to the
        // built connect module (sibling of dist/browser/index.js).
        return new Worker(new URL("./blockEngine.worker.js", import.meta.url), { type: "module" });
    } catch {
        return null;
    }
}

export class PeerNetwork {
    /** Pass this to a `ShardClient` as `peers`. */
    readonly exchange: PeerExchange;
    private readonly transport: PeerTransport;
    private readonly host: EngineHost;
    private readonly signaler: SpaceSignaler;
    private readonly offs: Array<() => void> = [];
    private readonly gossipCbs = new Set<(from: string, data: Uint8Array) => void>();
    private closed = false;

    constructor(opts: PeerNetworkOptions) {
        this.signaler = new SpaceSignaler(opts.space, opts.myId);
        this.transport =
            opts.transport ??
            new WebRtcTransport(this.signaler, opts.myId, {
                iceServers: opts.iceServers,
                maxPeers: opts.maxPeers,
                debug: opts.debug,
            });
        this.host = buildEngineHost(opts);

        // Wire transport ⇄ engine, demuxing block (engine) from gossip (app).
        this.offs.push(
            this.transport.onMessage((peer, data, channel) => {
                if (channel === CHANNEL_GOSSIP) {
                    for (const cb of this.gossipCbs) cb(peer, data);
                } else {
                    this.host.handleFrame(peer, data);
                }
            }),
        );
        this.offs.push(
            this.host.onOutbound((target, frame) =>
                target === "*"
                    ? this.transport.broadcast(frame, CHANNEL_BLOCK)
                    : this.transport.send(target, frame, CHANNEL_BLOCK),
            ),
        );

        // Discovery: a broadcast hello triggers a unicast hello back (so a
        // newcomer learns existing members); both sides connectTo (the smaller
        // id actually dials). Deterministic + idempotent.
        this.offs.push(
            this.signaler.onSignal((from, kind, data) => {
                if (kind !== "hello") return;
                this.transport.connectTo?.(from);
                if ((data as { broadcast?: boolean } | undefined)?.broadcast) {
                    this.signaler.send(from, "hello", { broadcast: false });
                }
            }),
        );

        this.exchange = new PeerExchange(this.host, { timeoutMs: opts.timeoutMs, debug: opts.debug });

        if (opts.debug) {
            console.info("[muhkoo:p2p] mesh attached for space; awaiting peers…");
            this.offs.push(
                this.transport.onPeerChange((peers) =>
                    console.info(`%c[muhkoo:p2p] connected peers: ${peers.length}`, "color:#58da7d", peers),
                ),
            );
        }
    }

    /**
     * Begin peer discovery — broadcast a hello so existing members dial us and
     * we learn them. Call once the signaling channel is live (the Space fires
     * this on CONNECTED); safe to call again on reconnect.
     */
    start(): void {
        if (this.closed) return;
        this.signaler.broadcast("hello", { broadcast: true });
    }

    /**
     * Broadcast an app payload to all connected peers over the gossip channel —
     * a direct, server-bypassing data path for CRDT ops / high-frequency state
     * (cursors, presence, collaborative edits). Single-hop (no re-forwarding).
     */
    gossip(data: Uint8Array): void {
        this.transport.broadcast(data, CHANNEL_GOSSIP);
    }

    /** Subscribe to gossip from peers. Returns an unsubscribe function. */
    onGossip(cb: (from: string, data: Uint8Array) => void): () => void {
        this.gossipCbs.add(cb);
        return () => this.gossipCbs.delete(cb);
    }

    /** Connected peer count (open data channels). */
    peerCount(): number {
        return this.transport.peers().length;
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        try { this.signaler.broadcast("bye"); } catch { /* socket may be gone */ }
        for (const off of this.offs) off();
        this.transport.close();
        this.host.close();
    }
}

export default PeerNetwork;
