/**
 * `BlockEngine` — the bitswap-lite want/have ledger. Host-agnostic: it speaks
 * only to a {@link BlockStore} (get/put/has) and an `out` sink that ships
 * encoded frames to a peer (or `"*"` to broadcast). The host wires `out` and
 * `handleFrame` to a real transport — on the main thread or inside the Web
 * Worker (see {@link ./engineClient}) — so this class is pure and unit-testable.
 *
 * It never sees keys: blocks are AES-GCM ciphertext, addressed by SHA-256. The
 * one trust check is integrity — an inbound BLOCK is re-hashed and dropped on
 * mismatch, so a malicious peer can't poison the store (the requester just
 * falls back to origin).
 */

import {
    FrameType,
    decode,
    encodeWant,
    encodeHave,
    encodeBlock,
    encodeCancel,
} from "./protocol";

export interface BlockStore {
    get(hash: string): Promise<Uint8Array | null>;
    put(hash: string, bytes: Uint8Array): Promise<void>;
    has(hash: string): Promise<boolean>;
}

/** Ship an encoded frame to one peer, or `"*"` for every connected peer. */
export type OutSink = (target: string | "*", frame: Uint8Array) => void;

/** Lowercase hex SHA-256 of `bytes` — injected so tests can stub it. */
export type Hasher = (bytes: Uint8Array) => Promise<string>;

interface PendingWant {
    resolvers: Array<(b: Uint8Array | null) => void>;
    timer: ReturnType<typeof setTimeout>;
}

export class BlockEngine {
    private readonly wants = new Map<string, PendingWant>();

    constructor(
        private readonly store: BlockStore,
        private readonly out: OutSink,
        private readonly hash: Hasher,
    ) {}

    /**
     * Ask the swarm for a block. Resolves with the verified bytes, or `null` on
     * timeout (caller then falls back to origin). Returns immediately if we
     * already hold it; concurrent wants for the same hash share one request.
     */
    want(hash: string, timeoutMs: number): Promise<Uint8Array | null> {
        return new Promise((resolve) => {
            void this.store.get(hash).then((local) => {
                if (local) return resolve(local);
                const existing = this.wants.get(hash);
                if (existing) {
                    existing.resolvers.push(resolve);
                    return;
                }
                const timer = setTimeout(() => {
                    const w = this.wants.get(hash);
                    this.wants.delete(hash);
                    this.out("*", encodeCancel(hash));
                    w?.resolvers.forEach((r) => r(null));
                }, timeoutMs);
                this.wants.set(hash, { resolvers: [resolve], timer });
                this.out("*", encodeWant(hash));
            });
        });
    }

    /** Tell the swarm we now hold `hash` (so peers wanting it can pull from us). */
    announce(hash: string): void {
        this.out("*", encodeHave(hash));
    }

    /** Handle one inbound frame from `peer`. */
    async handleFrame(peer: string, frame: Uint8Array): Promise<void> {
        let f;
        try {
            f = decode(frame);
        } catch {
            return; // malformed — ignore
        }
        switch (f.type) {
            case FrameType.WANT: {
                const bytes = await this.store.get(f.hash);
                if (bytes) this.out(peer, encodeBlock(f.hash, bytes));
                return;
            }
            case FrameType.HAVE: {
                // A peer announced a block we're still waiting for → pull from them.
                if (this.wants.has(f.hash)) this.out(peer, encodeWant(f.hash));
                return;
            }
            case FrameType.BLOCK: {
                const pending = this.wants.get(f.hash);
                if (!pending || !f.payload) return; // unsolicited / empty — ignore
                // Integrity: a peer can't poison the store. Drop a mismatch and
                // keep waiting (the timeout will fall back to origin).
                const got = await this.hash(f.payload);
                if (got !== f.hash) return;
                await this.store.put(f.hash, f.payload);
                this.wants.delete(f.hash);
                clearTimeout(pending.timer);
                this.out("*", encodeCancel(f.hash)); // others can stop sending
                pending.resolvers.forEach((r) => r(f.payload!));
                return;
            }
            case FrameType.CANCEL:
                // We serve WANTs synchronously, so there's nothing in flight to
                // cancel yet. Reserved for chunked-send cancellation later.
                return;
        }
    }

    /** Drop all pending waits (resolve null) — on teardown. */
    close(): void {
        for (const [, w] of this.wants) {
            clearTimeout(w.timer);
            w.resolvers.forEach((r) => r(null));
        }
        this.wants.clear();
    }
}

export default BlockEngine;
