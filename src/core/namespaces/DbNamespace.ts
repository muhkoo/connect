/**
 * `client.db` — the app's scalable database. A developer defines tables in the
 * Muhkoo portal (columns + indexes); each table is backed by its own Durable
 * Object SQLite instance and reachable through a sanitized REST gateway. This
 * namespace wraps that gateway:
 *
 *   const todos = client.db.table('todos');
 *   const { id } = await todos.insert({ title: 'Buy milk', done: false });
 *   const one    = await todos.get(id);
 *   const { rows, nextCursor } = await todos.query({
 *     where: [{ column: 'done', op: 'eq', value: false }],
 *     orderBy: { column: 'rank', dir: 'asc' },
 *     limit: 50,
 *   });
 *   await todos.update(id, { done: true });
 *   await todos.delete(id);
 *
 * Authorization is the **app key** ({@link HttpClient} stamps it on every
 * request); the appId + environment are resolved server-side from the key, so a
 * key can only ever reach its own app's tables. The front end never touches the
 * database directly — this REST surface is the only gateway, and all input is
 * validated against the table's schema (parameterized statements, column +
 * operator allowlists). There is no raw-SQL passthrough.
 *
 * Schema is authored in the portal, not here (the SDK reads + writes rows, it
 * doesn't create tables). Pagination is keyset-based: pass the `nextCursor` from
 * a previous `query()` back as `cursor` to fetch the next page.
 */

import { HttpClient, HttpError } from "../HttpClient";
import type { DbCache } from "../../offline/DbCache";
import type { QueueEntry } from "../../offline/store/OfflineStore";

export interface DbNamespaceDeps {
    http: HttpClient;
    /** Offline row/query cache + write queue. Undefined ⇒ network-only. */
    offline?: DbCache;
}

/** Comparison operators allowed in a {@link DbQuery} `where` clause. */
export type DbFilterOp =
    | "eq" | "neq" | "gt" | "gte" | "lt" | "lte"
    | "in" | "like" | "likeStartsWith" | "likeContains";

export interface DbWhereCondition {
    column: string;
    op: DbFilterOp;
    /** Scalar for most ops; an array for `in`; a string for the `like` family. */
    value: unknown;
}

export interface DbQuery {
    /** Columns to return; omit for all columns. */
    select?: string[];
    /** Conditions AND-combined. */
    where?: DbWhereCondition[];
    /** Sort by a column (defaults to the primary key, ascending). */
    orderBy?: { column: string; dir?: "asc" | "desc" };
    /** Page size, clamped server-side to 100. */
    limit?: number;
    /** Opaque keyset cursor from a previous query's `nextCursor`. */
    cursor?: string;
}

export interface DbQueryResult<T = Record<string, unknown>> {
    rows: T[];
    /** Cursor for the next page, or `null` when the last page was returned. */
    nextCursor: string | null;
}

/** A handle to one table — the ergonomic surface for row operations. */
export class DbTable<T extends Record<string, unknown> = Record<string, unknown>> {
    constructor(
        private readonly http: HttpClient,
        private readonly name: string,
        private readonly offline?: DbCache,
    ) {}

    private base(): string {
        return `/api/db/${encodeURIComponent(this.name)}`;
    }
    private rowUrl(id: string | number): string {
        return `${this.base()}/${encodeURIComponent(String(id))}`;
    }

    /** Insert a row. Returns the created row and its primary-key value. */
    async insert(values: Partial<T>): Promise<{ row: T; id: unknown }> {
        if (!this.offline?.enabled) return this.http.post(this.base(), { values });
        const hlc = await this.offline.nextHlc();
        const _hlc = this.offline.columnStamps(values as Record<string, unknown>, hlc);
        try {
            const res = await this.http.post<{ row: T; id: unknown }>(this.base(), { values, _hlc });
            await this.offline.writeRow(this.name, String(res.id), res.row as Record<string, unknown>);
            return res;
        } catch (err) {
            if (err instanceof HttpError) throw err;
            // Offline: queue for replay. No server pk yet — return a provisional
            // client id so the caller has a stable handle until sync.
            const clientId = this.offline.newClientId();
            await this.offline.enqueue("insert", { table: this.name, values, _hlc }, hlc, clientId);
            return { row: values as T, id: clientId };
        }
    }

    /** Fetch a row by primary key, or `null` if it doesn't exist. */
    async get(id: string | number): Promise<T | null> {
        try {
            const res = await this.http.get<{ row: T }>(this.rowUrl(id));
            if (this.offline?.enabled) await this.offline.writeRow(this.name, String(id), res.row as Record<string, unknown>);
            return res.row;
        } catch (e) {
            if ((e as { status?: number })?.status === 404) return null;
            if (this.offline?.enabled && !(e instanceof HttpError)) {
                return (await this.offline.readRow(this.name, String(id))) as T | null;
            }
            throw e;
        }
    }

    /** Query rows with filters, ordering, and keyset pagination. */
    async query(query: DbQuery = {}): Promise<DbQueryResult<T>> {
        if (!this.offline?.enabled) return this.http.post(`${this.base()}/query`, query);
        try {
            const res = await this.http.post<DbQueryResult<T>>(`${this.base()}/query`, query);
            await this.offline.writeQuery(this.name, query, res as { rows: Array<Record<string, unknown>>; nextCursor: string | null });
            return res;
        } catch (e) {
            if (e instanceof HttpError) throw e;
            const cached = await this.offline.readQuery(this.name, query);
            return (cached as DbQueryResult<T> | null) ?? { rows: [], nextCursor: null };
        }
    }

    /** Update a row by primary key. Returns the updated row. */
    async update(id: string | number, values: Partial<T>): Promise<{ row: T }> {
        if (!this.offline?.enabled) return this.http.patch(this.rowUrl(id), { values });
        const hlc = await this.offline.nextHlc();
        const _hlc = this.offline.columnStamps(values as Record<string, unknown>, hlc);
        await this.offline.patchRow(this.name, String(id), values as Record<string, unknown>); // optimistic
        try {
            const res = await this.http.patch<{ row: T }>(this.rowUrl(id), { values, _hlc });
            await this.offline.writeRow(this.name, String(id), res.row as Record<string, unknown>);
            return res;
        } catch (err) {
            if (err instanceof HttpError) throw err;
            await this.offline.enqueue("update", { table: this.name, id, values, _hlc }, hlc, this.offline.newClientId());
            return { row: (await this.offline.readRow(this.name, String(id))) as T };
        }
    }

    /** Delete a row by primary key. Returns the number of rows removed (0 or 1). */
    async delete(id: string | number): Promise<number> {
        if (!this.offline?.enabled) {
            const res = await this.http.del<{ deleted: number }>(this.rowUrl(id));
            return res.deleted ?? 0;
        }
        const hlc = await this.offline.nextHlc();
        await this.offline.deleteRow(this.name, String(id)); // optimistic
        try {
            const res = await this.http.del<{ deleted: number }>(this.rowUrl(id), { _hlc: hlc });
            return res.deleted ?? 0;
        } catch (err) {
            if (err instanceof HttpError) throw err;
            await this.offline.enqueue("delete", { table: this.name, id, hlc }, hlc, this.offline.newClientId());
            return 1; // optimistic
        }
    }
}

export class DbNamespace {
    constructor(private readonly deps: DbNamespaceDeps) {}

    /**
     * A handle to a table defined in the portal. The optional type parameter
     * gives row operations a typed shape:
     *
     *   interface Todo { _id: number; title: string; done: boolean }
     *   const todos = client.db.table<Todo>('todos');
     */
    table<T extends Record<string, unknown> = Record<string, unknown>>(name: string): DbTable<T> {
        return new DbTable<T>(this.deps.http, name, this.deps.offline);
    }

    /** Replay one queued db mutation (called by the sync engine). */
    async replay(entry: QueueEntry): Promise<void> {
        const a = entry.args as {
            table: string;
            id?: string | number;
            values?: Record<string, unknown>;
            _hlc?: Record<string, string>;
            hlc?: string;
        };
        const base = `/api/db/${encodeURIComponent(a.table)}`;
        if (entry.method === "insert") {
            await this.deps.http.post(base, { values: a.values, _hlc: a._hlc });
        } else if (entry.method === "update") {
            await this.deps.http.patch(`${base}/${encodeURIComponent(String(a.id))}`, { values: a.values, _hlc: a._hlc });
        } else if (entry.method === "delete") {
            await this.deps.http.del(`${base}/${encodeURIComponent(String(a.id))}`, { _hlc: a.hlc });
        }
    }
}

export default DbNamespace;
