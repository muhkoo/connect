/**
 * IndexedDB schema for the offline layer — the single source of truth for the
 * database name, version, and object stores. Bump {@link DB_VERSION} whenever
 * the store set changes; {@link ./idb}'s `onupgradeneeded` creates any store
 * that doesn't exist yet (additive migrations only — never drop
 * `outbound-queue`, it holds un-synced writes).
 *
 * One database per origin. Records are partitioned *by key* (most keys are
 * prefixed with the user's `commitment`) rather than by separate databases, so
 * a single connection serves every signed-in user on the origin and prefix
 * scans isolate a user's data.
 */

export const DB_NAME = "muhkoo.offline";
export const DB_VERSION = 1;

export type StoreName =
    | "kv-cache"
    | "db-row-cache"
    | "db-query-cache"
    | "space-messages"
    | "space-cursors"
    | "outbound-queue"
    | "snapshots"
    | "hlc-state"
    | "meta";

export interface StoreDef {
    name: StoreName;
    /** Auto-incrementing in-line key (used by the durable outbound queue). */
    autoIncrement?: boolean;
    /** Key path for an in-line key; omit for out-of-line (explicit) keys. */
    keyPath?: string;
}

export const STORES: StoreDef[] = [
    { name: "kv-cache" },
    { name: "db-row-cache" },
    { name: "db-query-cache" },
    { name: "space-messages" },
    { name: "space-cursors" },
    { name: "outbound-queue", autoIncrement: true, keyPath: "seq" },
    { name: "snapshots" },
    { name: "hlc-state" },
    { name: "meta" },
];

/** Fixed keys in the `meta` store. */
export const META_NODE_ID = "nodeId";
export const META_SCHEMA_VERSION = "schemaVersion";
