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

import type { HttpClient } from "../HttpClient";

export interface DbNamespaceDeps {
    http: HttpClient;
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
    constructor(private readonly http: HttpClient, private readonly name: string) {}

    private base(): string {
        return `/api/db/${encodeURIComponent(this.name)}`;
    }

    /** Insert a row. Returns the created row and its primary-key value. */
    async insert(values: Partial<T>): Promise<{ row: T; id: unknown }> {
        return this.http.post<{ row: T; id: unknown }>(this.base(), { values });
    }

    /** Fetch a row by primary key, or `null` if it doesn't exist. */
    async get(id: string | number): Promise<T | null> {
        try {
            const res = await this.http.get<{ row: T }>(`${this.base()}/${encodeURIComponent(String(id))}`);
            return res.row;
        } catch (e) {
            if ((e as { status?: number })?.status === 404) return null;
            throw e;
        }
    }

    /** Query rows with filters, ordering, and keyset pagination. */
    async query(query: DbQuery = {}): Promise<DbQueryResult<T>> {
        return this.http.post<DbQueryResult<T>>(`${this.base()}/query`, query);
    }

    /** Update a row by primary key. Returns the updated row. */
    async update(id: string | number, values: Partial<T>): Promise<{ row: T }> {
        return this.http.patch<{ row: T }>(`${this.base()}/${encodeURIComponent(String(id))}`, { values });
    }

    /** Delete a row by primary key. Returns the number of rows removed (0 or 1). */
    async delete(id: string | number): Promise<number> {
        const res = await this.http.del<{ deleted: number }>(`${this.base()}/${encodeURIComponent(String(id))}`);
        return res.deleted ?? 0;
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
        return new DbTable<T>(this.deps.http, name);
    }
}

export default DbNamespace;
