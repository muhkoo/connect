/**
 * `SpaceCache` — the offline adapter a {@link ../spaces/Space} talks to. It
 * persists sealed message frames (ciphertext at rest), tracks per-space sync
 * cursors, and records offline sends in the durable queue. Kept as its own
 * object (rather than wiring the Space straight to the store + clock) so the
 * Space stays decoupled from IndexedDB and so the no-op path is a single
 * `enabled` check.
 *
 * Messages are the structural CRDT (see {@link ./crdt/MessageLog}): the server
 * assigns a monotonic `handle` that totally-orders the log, so the cache just
 * stores frames keyed by a zero-padded handle (real) or a provisional key
 * (pending sends, which sort to the tail until their echo arrives).
 */

import {
    messageKey,
    provisionalHandle,
    type MessageEntry,
    type MessageOp,
} from "./crdt/MessageLog";
import type { OfflineManager } from "./OfflineManager";
import type { OfflineStore } from "./store/OfflineStore";

/** Zero-pad a numeric server handle so string keys sort in handle order. */
export function padHandle(handle: number): string {
    return String(Math.max(0, Math.floor(handle))).padStart(16, "0");
}

export interface SpaceCursor {
    lastSeenHandle: number;
    oldestHandle: number;
    fullyBackfilled: boolean;
}

/**
 * The surface a {@link ../spaces/Space} uses. Declared structurally on the
 * Space side too (as `SpaceOfflineAdapter`) so the spaces module never imports
 * the offline module.
 */
export class SpaceCache {
    private readonly store: OfflineStore;

    constructor(private readonly manager: OfflineManager) {
        this.store = manager.store;
    }

    get enabled(): boolean {
        return this.manager.enabled;
    }

    newClientId(): string {
        return this.manager.newClientId();
    }

    nextHlc(): Promise<string> {
        return this.manager.nextHlc();
    }

    /** Persist a sealed message frame keyed by its (real or provisional) handle. */
    async putMessage(spaceId: string, entry: MessageEntry): Promise<void> {
        await this.store.put("space-messages", messageKey(spaceId, entry.handle), entry);
    }

    /** Tombstone the message at `handle`. */
    async putDeleted(spaceId: string, handle: number): Promise<void> {
        const key = messageKey(spaceId, padHandle(handle));
        const existing = await this.store.get<MessageEntry>("space-messages", key);
        await this.store.put("space-messages", key, {
            handle: padHandle(handle),
            packet: null,
            op: "delete" as MessageOp,
            deleted: true,
            clientId: existing?.clientId,
        });
    }

    /** Drop a pending (optimistic) entry once its real echo has been stored. */
    async dropPending(spaceId: string, clientId: string): Promise<void> {
        await this.store.delete("space-messages", messageKey(spaceId, provisionalHandle(clientId)));
    }

    /** All cached frames for a space, in handle order (pending ones last). */
    async loadMessages(spaceId: string): Promise<MessageEntry[]> {
        const rows = await this.store.range<MessageEntry>(
            "space-messages",
            `${spaceId}|`,
            `${spaceId}|￿`,
        );
        return rows.map((r) => r.value);
    }

    async getCursor(spaceId: string): Promise<SpaceCursor | null> {
        return this.store.get<SpaceCursor>("space-cursors", spaceId);
    }

    /** Advance the last-seen handle (monotonic) and track the oldest fetched. */
    async observeHandle(spaceId: string, handle: number): Promise<void> {
        if (!handle) return;
        const cur = (await this.getCursor(spaceId)) ?? {
            lastSeenHandle: 0,
            oldestHandle: handle,
            fullyBackfilled: false,
        };
        const next: SpaceCursor = {
            lastSeenHandle: Math.max(cur.lastSeenHandle, handle),
            oldestHandle: cur.oldestHandle ? Math.min(cur.oldestHandle, handle) : handle,
            fullyBackfilled: cur.fullyBackfilled,
        };
        await this.store.put("space-cursors", spaceId, next);
    }

    /** Queue a raw space frame for replay when the connection returns. */
    async enqueueFrame(spaceId: string, frame: unknown, clientId: string, hlc: string): Promise<void> {
        await this.manager.enqueue({
            hlc,
            clientId,
            domain: "space",
            method: "sendRaw",
            args: { spaceId, frame },
        });
    }

    /** Register an inbound catch-up task (forward/back history paging). */
    registerCatchUp(task: () => Promise<void>): () => void {
        return this.manager.registerCatchUp(task);
    }
}

export default SpaceCache;
