/**
 * Message-log helpers — the conflict model for a Space's message history.
 *
 * Messages are the easy CRDT: the accelerator assigns every persisted message a
 * monotonic, zero-padded `handle` that already totally-orders the log, and the
 * sealed body is immutable. So the "log" is just a grow-only set keyed by
 * `handle`, and convergence is structural — no server change needed.
 *
 * The only subtleties this module encodes:
 *   - **Optimistic sends** have no server handle yet. We key them by a
 *     provisional handle that sorts *after* every real one, and tag them with
 *     the sender's `clientId` so the real frame (carrying the same `clientId`)
 *     can replace the placeholder instead of duplicating it.
 *   - **Edits** are a per-message LWW register on the body (greater HLC wins).
 *   - **Deletes** are a tombstone at the message's handle.
 */

export type MessageOp = "msg" | "edit" | "delete";

export interface MessageEntry {
    /** Server-assigned handle, or a {@link provisionalHandle} while pending. */
    handle: string;
    /** Sealed packet string (ciphertext at rest); `null` for a delete tombstone. */
    packet: string | null;
    op: MessageOp;
    /** Sender-generated id, present on locally-originated sends for dedupe. */
    clientId?: string;
    /** HLC stamp — orders edits to the same message. */
    hlc?: string;
    /** True while an optimistic send has not yet been acked by the server. */
    pending?: boolean;
    deleted?: boolean;
}

/** IndexedDB key for a message within a space. */
export function messageKey(spaceId: string, handle: string): string {
    return `${spaceId}|${handle}`;
}

/**
 * A handle for an un-acked optimistic message. Prefixed with `"~"` (0x7E),
 * which sorts after every digit, so pending sends always appear at the tail of
 * the handle-ordered log until the real handle arrives.
 */
export function provisionalHandle(clientId: string): string {
    return `~local:${clientId}`;
}

export function isProvisional(handle: string): boolean {
    return handle.startsWith("~local:");
}

/**
 * Merge two entries for the SAME handle. A delete always wins (tombstone); an
 * edit wins over the entry it supersedes when its HLC is greater; otherwise the
 * existing entry stands (a re-delivered `msg` is idempotent).
 */
export function mergeMessage(local: MessageEntry | null, incoming: MessageEntry): MessageEntry {
    if (!local) return incoming;
    if (incoming.op === "delete" || local.deleted) {
        return { ...local, op: "delete", packet: null, deleted: true };
    }
    if (incoming.op === "edit") {
        if (!local.hlc || (incoming.hlc && incoming.hlc > local.hlc)) {
            return { ...local, packet: incoming.packet, hlc: incoming.hlc, op: "edit" };
        }
        return local;
    }
    // incoming.op === "msg": keep the already-stored (de-pending) entry.
    return { ...local, pending: false };
}
