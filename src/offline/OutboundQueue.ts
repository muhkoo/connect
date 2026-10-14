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
 *   - refused for payment (`PaymentRequiredError`: the app takes paid plans
 *     only, or someone's payment is past due) → keep it and everything after
 *     it, stop, and surface a `SYNC_ERROR` with `dropped: false`. The server
 *     accepts it once the user or the app owner pays, so it waits for the next
 *     reconnect, or for `client.app.access()` to report the app allowed;
 *   - permanent failure (any other 4xx, or a Space whose member list refuses
 *     this user) → drop it and surface a `SYNC_ERROR` (a write the server will
 *     never accept must not wedge the queue forever);
 *   - transient/network failure → stop draining and leave the rest for the next
 *     reconnect.
 *
 * Replays are idempotent by construction (kv/db are LWW-by-key, messages dedupe
 * by `clientId`, file PUTs are content-addressed), so re-running a partially
 * drained queue is safe.
 *
 * Every tab of an origin shares the queue. Given a `tryLock`, a drain runs
 * only while holding `muhkoo:offline-drain:<commitment>`, so two tabs coming
 * back online replay it once between them, not once each.
 */

import { EventCore, EventCoreEvents } from "../events/EventCore";
import { HttpError } from "../core/HttpClient";
import { PaymentRequiredError } from "../core/PaymentRequiredError";
import { AdmissionDeniedError } from "../spaces/trust/errors";
import type { OfflineStore, QueueEntry } from "./store/OfflineStore";

export type Replayer = (entry: QueueEntry) => Promise<void>;

/**
 * Run `fn` holding lock `name` if no one else holds it: true once it has
 * run, false - without running it - when another holder has it. Web Locks'
 * `ifAvailable` in a browser tab; see `core/crossTab.ts`.
 */
export type TryLock = (name: string, fn: () => Promise<void>) => Promise<boolean>;

export interface OutboundQueueOptions {
    /**
     * The lock that keeps two tabs from draining at once. Every tab of an
     * origin shares one IndexedDB queue, and each replayed all of it when it
     * came back online: two tabs, every queued write twice. Absent (Node,
     * tests), every drain runs, as before.
     */
    tryLock?: TryLock;
    /**
     * The signed-in user: stamps each enqueued write, picks which writes a
     * drain sends, and names the drain lock. With no one signed in, writes are
     * unstamped and the drain runs unlocked.
     */
    commitment?: () => string | null;
}

export class OutboundQueue {
    private readonly replayers = new Map<QueueEntry["domain"], Replayer>();
    private draining: Promise<void> | null = null;

    constructor(
        private readonly store: OfflineStore,
        private readonly opts: OutboundQueueOptions = {},
    ) {}

    /** A domain registers how to replay its mutations. */
    register(domain: QueueEntry["domain"], replayer: Replayer): void {
        this.replayers.set(domain, replayer);
    }

    /**
     * Record a mutation for later replay; resolves with its assigned seq.
     * Stamped with the signed-in user's commitment, so that it is only ever
     * sent under their session (see {@link waiting}).
     */
    enqueue(entry: Omit<QueueEntry, "seq">): Promise<number> {
        const who = entry.commitment ?? this.opts.commitment?.();
        return this.store.enqueue(who ? { ...entry, commitment: who } : entry);
    }

    /** Number of writes still awaiting sync, every user's. */
    async pending(): Promise<number> {
        return (await this.store.queued()).length;
    }

    /**
     * The writes a drain would send now, in order: the signed-in user's, and
     * any an older SDK queued without saying whose they are. Every tab of an
     * origin shares this queue, and every replayer builds its request from
     * the session signed in when it runs, so another user's write sent now
     * would land in this user's space, or overwrite their data. It stays
     * queued, as it is, until its own user signs in on this device again.
     */
    async waiting(): Promise<QueueEntry[]> {
        return (await this.store.queued()).filter((entry) => this.sendable(entry));
    }

    /** True for an entry this drain may send: the signed-in user's, or one with no user. */
    private sendable(entry: QueueEntry): boolean {
        return !entry.commitment || entry.commitment === this.opts.commitment?.();
    }

    /**
     * Replay queued mutations in HLC order. Coalesces concurrent calls into a
     * single in-flight drain. Stops on the first transient failure, leaving the
     * remaining entries for the next attempt.
     */
    drain(): Promise<void> {
        if (this.draining) return this.draining;
        this.draining = this.drainOnce().finally(() => {
            this.draining = null;
        });
        return this.draining;
    }

    /**
     * One drain, holding the device-wide drain lock where there is one. A
     * tab that finds another tab holding it leaves the queue to that one,
     * which is replaying it already and removes each entry as it lands - so
     * a drain after it finds only what it left.
     */
    private async drainOnce(): Promise<void> {
        const who = this.opts.commitment?.();
        if (!this.opts.tryLock || !who) {
            await this.runDrain();
            return;
        }
        await this.opts.tryLock(`muhkoo:offline-drain:${who}`, async () => {
            // A tab that found this one draining skipped its own drain, and
            // what it queued after this pass read the queue was left to this
            // tab. So drain until a pass leaves nothing of this user's; a
            // transient failure still stops it, by throwing. So does a write
            // refused for payment, which stays queued: another pass would
            // only be refused again, at once and without end. Another user's
            // writes never leave, so counting them would loop for ever too.
            do {
                if (!(await this.runDrain())) return;
            } while ((await this.waiting()).length > 0);
        });
    }

    /**
     * One pass over the queue. False when a write refused for payment stopped
     * it, which leaves that write and everything after it queued.
     */
    private async runDrain(): Promise<boolean> {
        const entries = await this.store.queued();
        for (const entry of entries) {
            // Another user's write, theirs to send under their own session.
            // Asked per entry, so a sign-out in the middle of a pass stops
            // the rest of it going out under the next user's session.
            if (!this.sendable(entry)) continue;
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
                // Asked before `isPermanent`, which would drop it as a 4xx.
                if (err instanceof PaymentRequiredError) {
                    // The user's plan, or a payment past due: the server will
                    // accept this write once that changes. Keep it, and keep
                    // every write after it in order; a delete queued after an
                    // upload never goes first. Stop rather than send the rest,
                    // which the server would refuse for the same reason.
                    EventCore.emit(EventCoreEvents.SYNC_ERROR, {
                        domain: entry.domain,
                        method: entry.method,
                        error: err.message,
                        code: err.code,
                        dropped: false,
                    });
                    return false;
                }
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
        return true;
    }
}

/** A 4xx is the server permanently refusing the write, and so is a Space whose
 *  member list does not admit this user (design §4.5.12): the relay refuses
 *  their frames. Anything else, a locked session included, is worth retrying
 *  on the next reconnect. A refusal for payment is a 4xx that is not
 *  permanent; `runDrain` keeps it before asking this. */
function isPermanent(err: unknown): boolean {
    if (err instanceof AdmissionDeniedError) return true;
    return err instanceof HttpError && err.status >= 400 && err.status < 500;
}

export default OutboundQueue;
