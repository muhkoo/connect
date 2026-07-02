/**
 * `DbCache` — the offline adapter for `client.db`. Unlike kv, db rows are
 * server-plaintext, so they're cached as-is. The SDK doesn't know a table's
 * primary-key column, so it caches schema-agnostically:
 *   - `get(id)` results keyed by the requested id (`${table}|row|${id}`),
 *   - `query(q)` result pages keyed by a stable hash of the query.
 *
 * Writes carry per-column HLC stamps (`_hlc`) so the accelerator's per-column
 * LWW merge can converge concurrent edits; offline writes are queued and
 * replayed. Optimistic row patches keep `get` fresh between sync cycles.
 */

import type { OfflineManager } from "./OfflineManager";
import type { OfflineStore } from "./store/OfflineStore";

export interface DbQueryPage {
    rows: Array<Record<string, unknown>>;
    nextCursor: string | null;
}

/** Stable JSON for query-cache keys (sorted object keys → deterministic). */
export function stableStringify(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
        .join(",")}}`;
}

export class DbCache {
    private readonly store: OfflineStore;
    constructor(private readonly manager: OfflineManager) {
        this.store = manager.store;
    }

    get enabled(): boolean {
        return this.manager.enabled;
    }
    nextHlc(): Promise<string> {
        return this.manager.nextHlc();
    }
    newClientId(): string {
        return this.manager.newClientId();
    }

    /** Build the `{ [col]: hlc }` map for a write (one stamp across its columns). */
    columnStamps(values: Record<string, unknown>, hlc: string): Record<string, string> {
        const out: Record<string, string> = {};
        for (const col of Object.keys(values)) out[col] = hlc;
        return out;
    }

    private rowKey(table: string, id: string): string {
        return `${table}|row|${id}`;
    }
    private queryKey(table: string, q: unknown): string {
        return `${table}|query|${stableStringify(q)}`;
    }

    async readRow(table: string, id: string): Promise<Record<string, unknown> | null> {
        return this.store.get("db-row-cache", this.rowKey(table, id));
    }
    async writeRow(table: string, id: string, row: Record<string, unknown>): Promise<void> {
        await this.store.put("db-row-cache", this.rowKey(table, id), row);
    }
    /** Shallow-merge a partial update into a cached row (optimistic). */
    async patchRow(table: string, id: string, values: Record<string, unknown>): Promise<void> {
        const existing = (await this.readRow(table, id)) ?? {};
        await this.writeRow(table, id, { ...existing, ...values });
    }
    async deleteRow(table: string, id: string): Promise<void> {
        await this.store.delete("db-row-cache", this.rowKey(table, id));
    }

    async readQuery(table: string, q: unknown): Promise<DbQueryPage | null> {
        return this.store.get("db-query-cache", this.queryKey(table, q));
    }
    async writeQuery(table: string, q: unknown, page: DbQueryPage): Promise<void> {
        await this.store.put("db-query-cache", this.queryKey(table, q), page);
    }

    async enqueue(
        method: "insert" | "update" | "delete",
        args: unknown,
        hlc: string,
        clientId: string,
    ): Promise<void> {
        await this.manager.enqueue({ hlc, clientId, domain: "db", method, args });
    }
}

export default DbCache;
