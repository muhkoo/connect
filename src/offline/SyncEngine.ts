/**
 * `SyncEngine` — orchestrates catch-up when the client comes back online. It's
 * the thing wired to the {@link ConnectivityManager}'s offline→online edge.
 *
 * One `run()` does, in order:
 *   1. **Guard** — only proceed when the session is authenticated and unlocked
 *      (replays may need to re-seal/re-encrypt, and there's no point pushing
 *      writes for a logged-out user).
 *   2. **Drain** the durable {@link OutboundQueue} — push every offline write.
 *   3. **Catch-up tasks** — domain-registered pulls that reconcile *inbound*
 *      state we missed while offline (e.g. a Space paging history forward to its
 *      last-seen handle). Registered by the namespaces.
 *
 * Concurrent triggers coalesce into a single in-flight run (a reconnect often
 * fires several signals at once), mirroring `Client.recoverInFlight`.
 */

import { EventCore, EventCoreEvents } from "../events/EventCore";
import type { ConnectivityManager } from "./ConnectivityManager";
import type { OutboundQueue } from "./OutboundQueue";

export interface SyncEngineDeps {
    queue: OutboundQueue;
    connectivity: ConnectivityManager;
    /** Proceed only when this returns true (authenticated + unlocked). */
    canSync: () => boolean;
}

export class SyncEngine {
    private readonly catchUpTasks = new Set<() => Promise<void>>();
    private running: Promise<void> | null = null;

    constructor(private readonly deps: SyncEngineDeps) {}

    /** Register an inbound reconciliation task run after the queue drains. */
    registerCatchUp(task: () => Promise<void>): () => void {
        this.catchUpTasks.add(task);
        return () => this.catchUpTasks.delete(task);
    }

    /** Drain + catch up. Concurrent calls share one in-flight run. */
    run(): Promise<void> {
        if (this.running) return this.running;
        this.running = this.execute().finally(() => {
            this.running = null;
        });
        return this.running;
    }

    private async execute(): Promise<void> {
        if (!this.deps.canSync()) return;
        this.deps.connectivity.markSyncing();
        try {
            await this.deps.queue.drain();
            for (const task of this.catchUpTasks) {
                try {
                    await task();
                } catch {
                    // One domain's catch-up failing shouldn't abort the others
                    // or wedge the sync; it'll retry on the next reconnect.
                }
            }
            EventCore.emit(EventCoreEvents.SYNC_COMPLETE, {});
        } finally {
            this.deps.connectivity.markSynced();
        }
    }
}

export default SyncEngine;
