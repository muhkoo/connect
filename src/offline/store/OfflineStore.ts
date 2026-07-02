/**
 * `OfflineStore` — the pluggable persistence interface the offline layer is
 * built on, mirroring the {@link ../../core/Session.SessionStore} pattern. The
 * default browser implementation is {@link ./IndexedDbStore}; environments
 * without IndexedDB (Node, Workers, SSR) get {@link ./NoopStore}, whose every
 * method resolves to empty so the namespace hooks become branch-free no-ops.
 *
 * Keys are plain strings (most are prefixed with the user's `commitment` to
 * isolate users on a shared origin). Values are whatever the caller stores —
 * the store is format-agnostic; CRDT/ciphertext shape is the namespace's
 * concern.
 */

import type { StoreName } from "./schema";

/** A durable outbound mutation awaiting replay on reconnect. */
export interface QueueEntry {
    /** Auto-assigned monotonic sequence (insertion order). */
    seq: number;
    /** HLC stamp of the mutation — the order replays run in. */
    hlc: string;
    /** Client-generated id for idempotent replay / dedupe. */
    clientId: string;
    domain: "kv" | "db" | "file" | "space" | "snapshot";
    /** Namespace method to re-invoke (e.g. `"set"`, `"update"`, `"sendMessage"`). */
    method: string;
    /** Serializable arguments captured at enqueue time. */
    args: unknown;
}

export interface OfflineEntry<T> {
    key: string;
    value: T;
}

export interface OfflineStore {
    /** False for {@link ./NoopStore} so hooks can skip all work cheaply. */
    readonly enabled: boolean;

    /** Resolve once the backing store is open and ready (no-op when disabled). */
    ready(): Promise<void>;

    get<T>(store: StoreName, key: string): Promise<T | null>;
    put<T>(store: StoreName, key: string, value: T): Promise<void>;
    delete(store: StoreName, key: string): Promise<void>;

    /** Entries whose key starts with `prefix`, in ascending key order. */
    prefix<T>(store: StoreName, prefix: string): Promise<Array<OfflineEntry<T>>>;
    /** Entries whose key is in `[lower, upper)`, in ascending key order. */
    range<T>(store: StoreName, lower: string, upper: string): Promise<Array<OfflineEntry<T>>>;
    /** Every entry in a store, in ascending key order. */
    all<T>(store: StoreName): Promise<Array<OfflineEntry<T>>>;

    clear(store: StoreName): Promise<void>;

    /** Append a mutation to the durable outbound queue; resolves with its seq. */
    enqueue(entry: Omit<QueueEntry, "seq">): Promise<number>;
    /** Remove a drained queue entry by seq. */
    dequeue(seq: number): Promise<void>;
    /** All queued mutations, HLC-ordered (the order to replay them in). */
    queued(): Promise<QueueEntry[]>;
}
