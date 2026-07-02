/**
 * `ConnectivityManager` — the single source of truth for "are we online", which
 * the offline layer needs to decide between a network call and a cache read, and
 * to know when to flush the durable outbound queue.
 *
 * `navigator.onLine` alone lies often (captive portals, VPN flaps, a laptop
 * that's "connected" to a network with no route), so we fuse three signals:
 *   1. the browser `online`/`offline` events (coarse but free),
 *   2. real fetch outcomes reported by {@link ../core/HttpClient} and the shard
 *      client — a thrown `TypeError`/abort is the most reliable "offline" tell,
 *      and a 2xx is the most reliable "online" tell,
 *   3. the sync engine, which flips us to `syncing` while it drains the queue.
 *
 * The offline→online edge fires `onReconnect` (wired to the sync engine) so
 * queued writes replay automatically. Transitions are debounced to avoid
 * flapping the UI on a brief blip. State changes also emit on {@link EventCore}
 * (`ONLINE`/`OFFLINE`/`SYNCING`) so apps can render a status indicator.
 */

import { EventCore, EventCoreEvents } from "../events/EventCore";

export type ConnectivityState = "online" | "offline" | "syncing";

export interface ConnectivityOptions {
    /** Called on each offline→online transition (drives queue replay). */
    onReconnect?: () => void;
    /** Debounce window for offline transitions, ms. Default 1500. */
    debounceMs?: number;
}

export class ConnectivityManager {
    private state: ConnectivityState;
    private readonly listeners = new Set<(state: ConnectivityState) => void>();
    private readonly onReconnect?: () => void;
    private readonly debounceMs: number;
    private offlineTimer: ReturnType<typeof setTimeout> | null = null;
    private started = false;

    private readonly handleOnline = () => this.markOnline();
    private readonly handleOffline = () => this.scheduleOffline();

    constructor(opts: ConnectivityOptions = {}) {
        this.onReconnect = opts.onReconnect;
        this.debounceMs = opts.debounceMs ?? 1500;
        this.state =
            typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "online";
    }

    /** Attach to the browser online/offline events. Safe to call in Node (no-op). */
    start(): void {
        if (this.started || typeof window === "undefined") return;
        window.addEventListener("online", this.handleOnline);
        window.addEventListener("offline", this.handleOffline);
        this.started = true;
    }

    stop(): void {
        if (!this.started || typeof window === "undefined") return;
        window.removeEventListener("online", this.handleOnline);
        window.removeEventListener("offline", this.handleOffline);
        if (this.offlineTimer) clearTimeout(this.offlineTimer);
        this.started = false;
    }

    get current(): ConnectivityState {
        return this.state;
    }

    get isOnline(): boolean {
        return this.state !== "offline";
    }

    /** Subscribe to state changes. Returns an unsubscribe function. */
    onChange(cb: (state: ConnectivityState) => void): () => void {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }

    /** Report a failed network attempt (thrown fetch / abort). */
    reportFetchFailure(): void {
        this.scheduleOffline();
    }

    /** Report a successful network round-trip — strongest "we're online" signal. */
    reportFetchSuccess(): void {
        this.markOnline();
    }

    /** The sync engine entering its drain phase. */
    markSyncing(): void {
        if (this.offlineTimer) {
            clearTimeout(this.offlineTimer);
            this.offlineTimer = null;
        }
        this.set("syncing");
    }

    /** The sync engine finished — settle back to online. */
    markSynced(): void {
        this.set("online");
    }

    private markOnline(): void {
        if (this.offlineTimer) {
            clearTimeout(this.offlineTimer);
            this.offlineTimer = null;
        }
        // The sync engine owns the syncing→online transition (via markSynced).
        // A request succeeding mid-drain must not cut the syncing state short.
        if (this.state === "syncing") return;
        const wasOffline = this.state === "offline";
        this.set("online");
        if (wasOffline) {
            try {
                this.onReconnect?.();
            } catch {
                /* a reconnect handler must not break connectivity tracking */
            }
        }
    }

    private scheduleOffline(): void {
        if (this.state === "offline" || this.offlineTimer) return;
        this.offlineTimer = setTimeout(() => {
            this.offlineTimer = null;
            this.set("offline");
        }, this.debounceMs);
    }

    private set(state: ConnectivityState): void {
        if (state === this.state) return;
        this.state = state;
        for (const cb of this.listeners) {
            try {
                cb(state);
            } catch {
                /* a bad listener mustn't break the others */
            }
        }
        const event =
            state === "online"
                ? EventCoreEvents.ONLINE
                : state === "offline"
                  ? EventCoreEvents.OFFLINE
                  : EventCoreEvents.SYNCING;
        EventCore.emit(event, { state });
    }
}

export default ConnectivityManager;
