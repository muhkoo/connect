/**
 * `OutboundQueue` — the durable record of writes made while offline (or that
 * failed mid-flight) plus the machinery to replay them on reconnect. This is
 * what makes offline writes *survive a reload*: unlike the in-memory buffer in
 * {@link ../transport/WSTransport}, every entry lives in IndexedDB until it has
 * been acknowledged by the server.
 *
 * Each domain registers a **replayer** — a function that re-applies one queued
 * mutation by re-invoking the real namespace method (with an `isReplay` flag so
 * it doesn't re-enqueue). `drain()` replays entries in HLC order:
 *   - success → remove the entry;
 *   - permanent failure (4xx) → drop it and surface a `SYNC_ERROR` (a write the
 *     server will never accept must not wedge the queue forever);
 *   - transient/network failure → stop draining and leave the rest for the next
 *     reconnect.
 *
 * Replays are idempotent by construction (kv/db are LWW-by-key, messages dedupe
 * by `clientId`, file PUTs are content-addressed), so re-running a partially
 * drained queue is safe.
 */

import { EventCore, EventCoreEvents } from "../events/EventCore";
import { HttpError } from "../core/HttpClient";
import type { OfflineStore, QueueEntry } from "./store/OfflineStore";

export type Replayer = (entry: QueueEntry) => Promise<void>;

export class OutboundQueue {
    private readonly replayers = new Map<QueueEntry["domain"], Replayer>();
    private draining: Promise<void> | null = null;

    constructor(private readonly store: OfflineStore) {}

    /** A domain registers how to replay its mutations. */
    register(domain: QueueEntry["domain"], replayer: Replayer): void {
        this.replayers.set(domain, replayer);
    }

    /** Record a mutation for later replay; resolves with its assigned seq. */
    enqueue(entry: Omit<QueueEntry, "seq">): Promise<number> {
        return this.store.enqueue(entry);
    }

    /** Number of writes still awaiting sync. */
    async pending(): Promise<number> {
        return (await this.store.queued()).length;
    }

    /**
     * Replay queued mutations in HLC order. Coalesces concurrent calls into a
     * single in-flight drain. Stops on the first transient failure, leaving the
     * remaining entries for the next attempt.
     */
    drain(): Promise<void> {
        if (this.draining) return this.draining;
        this.draining = this.runDrain().finally(() => {
            this.draining = null;
        });
        return this.draining;
    }

    private async runDrain(): Promise<void> {
        const entries = await this.store.queued();
        for (const entry of entries) {
            const replayer = this.replayers.get(entry.domain);
            if (!replayer) {
                // No handler registered (namespace not wired) — drop it rather
                // than block the queue; nothing can ever replay it.
                await this.store.dequeue(entry.seq);
                continue;
            }
            try {
                await replayer(entry);
                await this.store.dequeue(entry.seq);
                EventCore.emit(EventCoreEvents.SYNC_PROGRESS, {
                    domain: entry.domain,
                    method: entry.method,
                });
            } catch (err) {
                if (isPermanent(err)) {
                    await this.store.dequeue(entry.seq);
                    EventCore.emit(EventCoreEvents.SYNC_ERROR, {
                        domain: entry.domain,
                        method: entry.method,
                        error: String((err as Error)?.message ?? err),
                        dropped: true,
                    });
                    continue;
                }
                // Transient (offline again, 5xx) — keep the entry, stop here.
                throw err;
            }
        }
    }
}

/** A 4xx is the server permanently refusing the write; anything else is worth
 *  retrying on the next reconnect. */
function isPermanent(err: unknown): boolean {
    return err instanceof HttpError && err.status >= 400 && err.status < 500;
}

export default OutboundQueue;
