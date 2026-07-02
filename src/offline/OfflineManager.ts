/**
 * `OfflineManager` — the object `client.offline` points at, and the single
 * owner of everything the offline layer needs at runtime: the {@link
 * OfflineStore}, the {@link HLC} (Hybrid Logical Clock), the {@link
 * ConnectivityManager}, the durable {@link OutboundQueue}, the {@link
 * SyncEngine}, and the {@link SnapshotNamespace}.
 *
 * The {@link ../core/Client} constructs one of these (always — it's a cheap
 * no-op when offline support is off) and hands the namespaces the small set of
 * primitives they need to participate: `nextHlc()` to stamp a write,
 * `observeHlc()` to fold in a remote stamp, `enqueue()` to record an offline
 * mutation, and `registerReplayer()`/`registerCatchUp()` to define how their
 * domain re-syncs on reconnect. Keeping that wiring here means the namespaces
 * stay decoupled from IndexedDB and the clock.
 */

import { generateId } from "../utilities";
import type { SessionState } from "../core/Session";
import { HLC, type HlcState } from "./clock/HLC";
import { unpack } from "./clock/HlcTimestamp";
import { ConnectivityManager, type ConnectivityState } from "./ConnectivityManager";
import { OutboundQueue, type Replayer } from "./OutboundQueue";
import { SyncEngine } from "./SyncEngine";
import { SnapshotNamespace } from "./namespaces/SnapshotNamespace";
import { ShardCache } from "./cache/ShardCache";
import type { OfflineStore, QueueEntry } from "./store/OfflineStore";
import { META_NODE_ID } from "./store/schema";

export interface OfflineManagerDeps {
    store: OfflineStore;
    session: SessionState;
    /** Whether offline support is active (browser) vs a no-op (Node/Workers). */
    enabled: boolean;
}

const HLC_STATE_KEY = "global";

export class OfflineManager {
    /** True in browsers with IndexedDB; false when running over a NoopStore. */
    readonly enabled: boolean;
    readonly store: OfflineStore;
    readonly connectivity: ConnectivityManager;
    readonly queue: OutboundQueue;
    readonly sync: SyncEngine;
    /** `client.offline.snapshot` — encrypted app-state cache. */
    readonly snapshot: SnapshotNamespace;
    /** Cache-API store for file-shard bytes (browser only). */
    readonly fileCache?: ShardCache;

    private hlc: HLC | null = null;
    private nodeId = "";
    private readonly bootPromise: Promise<void>;
    private persistTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(deps: OfflineManagerDeps) {
        this.enabled = deps.enabled;
        this.store = deps.store;
        this.queue = new OutboundQueue(deps.store);
        this.connectivity = new ConnectivityManager({
            onReconnect: () => void this.sync.run(),
        });
        this.sync = new SyncEngine({
            queue: this.queue,
            connectivity: this.connectivity,
            // Replays may need to re-seal/re-encrypt, and there's no point
            // pushing a logged-out user's writes — gate on a usable session.
            canSync: () => deps.session.isAuthenticated && deps.session.isUnlocked,
        });
        this.snapshot = new SnapshotNamespace({
            store: deps.store,
            session: deps.session,
            nextHlc: () => this.nextHlc(),
        });

        if (this.enabled && ShardCache.available()) this.fileCache = new ShardCache();

        this.bootPromise = this.boot();
        if (this.enabled) this.connectivity.start();
    }

    /**
     * Queue a shard upload that couldn't reach the network. The bytes are
     * already cached (keyed by `hash`), so only the hash is recorded; the file
     * replayer re-PUTs from the cache on reconnect.
     */
    async deferShardUpload(hash: string): Promise<void> {
        await this.enqueue({
            hlc: await this.nextHlc(),
            clientId: this.newClientId(),
            domain: "file",
            method: "putShard",
            args: { hash },
        });
    }

    /** Resolve once the clock + node id are loaded. */
    ready(): Promise<void> {
        return this.bootPromise;
    }

    /** Current connectivity state (`online` | `offline` | `syncing`). */
    get status(): ConnectivityState {
        return this.connectivity.current;
    }

    /** Subscribe to connectivity changes. Returns an unsubscribe function. */
    onStatusChange(cb: (state: ConnectivityState) => void): () => void {
        return this.connectivity.onChange(cb);
    }

    /** Stamp a locally-generated write with a fresh, monotonic HLC. */
    async nextHlc(): Promise<string> {
        await this.bootPromise;
        const stamp = this.hlc!.now();
        this.schedulePersist();
        return stamp;
    }

    /** Fold an observed remote HLC into the clock (call for inbound stamps). */
    async observeHlc(remote: string): Promise<void> {
        await this.bootPromise;
        this.hlc!.update(unpack(remote));
        this.schedulePersist();
    }

    /** A fresh client-generated id (idempotent replay / message dedupe). */
    newClientId(): string {
        return generateId();
    }

    /** Record an offline mutation for replay on reconnect. */
    enqueue(entry: Omit<QueueEntry, "seq">): Promise<number> {
        return this.queue.enqueue(entry);
    }

    /** A domain registers how to replay its queued mutations. */
    registerReplayer(domain: QueueEntry["domain"], replayer: Replayer): void {
        this.queue.register(domain, replayer);
    }

    /** A domain registers an inbound catch-up task (run after the queue drains). */
    registerCatchUp(task: () => Promise<void>): () => void {
        return this.sync.registerCatchUp(task);
    }

    /** Surface a network failure to connectivity tracking. */
    reportFetchFailure(): void {
        this.connectivity.reportFetchFailure();
    }

    /** Surface a successful round-trip to connectivity tracking. */
    reportFetchSuccess(): void {
        this.connectivity.reportFetchSuccess();
    }

    /** Tear down listeners (tests / hot-reload). */
    dispose(): void {
        this.connectivity.stop();
        if (this.persistTimer) clearTimeout(this.persistTimer);
    }

    private async boot(): Promise<void> {
        if (!this.enabled) {
            // In-memory clock only; nothing is persisted over a NoopStore.
            this.nodeId = generateId();
            this.hlc = new HLC(this.nodeId);
            return;
        }
        let nodeId = await this.store.get<string>("meta", META_NODE_ID);
        if (!nodeId) {
            nodeId = generateId();
            await this.store.put("meta", META_NODE_ID, nodeId);
        }
        this.nodeId = nodeId;
        const state = await this.store.get<HlcState>("hlc-state", HLC_STATE_KEY);
        this.hlc = new HLC(nodeId, { state });
    }

    /** Coalesce HLC-state writes — a burst of stamps persists once. */
    private schedulePersist(): void {
        if (!this.enabled || this.persistTimer) return;
        this.persistTimer = setTimeout(() => {
            this.persistTimer = null;
            if (this.hlc) void this.store.put("hlc-state", HLC_STATE_KEY, this.hlc.getState());
        }, 200);
    }
}

export default OfflineManager;
