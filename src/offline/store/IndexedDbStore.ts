/**
 * `IndexedDbStore` — the browser {@link OfflineStore}, backed by one IndexedDB
 * database per origin (see {@link ./schema}). It opens lazily on first use and
 * memoizes the connection. The queue methods sit on the autoincrement
 * `outbound-queue` store and return mutations in HLC order for the sync engine.
 *
 * Construct only where `indexedDB` exists — {@link ../detect.isOfflineCapable}
 * gates this, and the {@link ../../core/Client} falls back to {@link ./NoopStore}
 * everywhere else.
 */

import { compareHlc } from "../clock/HlcTimestamp";
import { IdbConnection, openDatabase } from "./idb";
import type { OfflineEntry, OfflineStore, QueueEntry } from "./OfflineStore";
import type { StoreName } from "./schema";

export class IndexedDbStore implements OfflineStore {
    readonly enabled = true;
    private conn: IdbConnection | null = null;
    private opening: Promise<IdbConnection> | null = null;

    private connect(): Promise<IdbConnection> {
        if (this.conn) return Promise.resolve(this.conn);
        if (!this.opening) {
            this.opening = openDatabase()
                .then((db) => {
                    this.conn = new IdbConnection(db);
                    return this.conn;
                })
                .finally(() => {
                    this.opening = null;
                });
        }
        return this.opening;
    }

    async ready(): Promise<void> {
        await this.connect();
    }

    async get<T>(store: StoreName, key: string): Promise<T | null> {
        return (await this.connect()).get<T>(store, key);
    }

    async put<T>(store: StoreName, key: string, value: T): Promise<void> {
        await (await this.connect()).put(store, key, value);
    }

    async delete(store: StoreName, key: string): Promise<void> {
        await (await this.connect()).delete(store, key);
    }

    async prefix<T>(store: StoreName, prefix: string): Promise<Array<OfflineEntry<T>>> {
        return (await this.connect()).prefix<T>(store, prefix);
    }

    async range<T>(store: StoreName, lower: string, upper: string): Promise<Array<OfflineEntry<T>>> {
        return (await this.connect()).range<T>(store, lower, upper);
    }

    async all<T>(store: StoreName): Promise<Array<OfflineEntry<T>>> {
        return (await this.connect()).all<T>(store);
    }

    async clear(store: StoreName): Promise<void> {
        await (await this.connect()).clear(store);
    }

    async enqueue(entry: Omit<QueueEntry, "seq">): Promise<number> {
        // keyPath autoincrement writes the generated `seq` back into the record.
        return (await this.connect()).append("outbound-queue", entry);
    }

    async dequeue(seq: number): Promise<void> {
        await (await this.connect()).delete("outbound-queue", seq);
    }

    async queued(): Promise<QueueEntry[]> {
        const rows = await (await this.connect()).all<QueueEntry>("outbound-queue");
        return rows.map((r) => r.value).sort((a, b) => compareHlc(a.hlc, b.hlc));
    }
}

export default IndexedDbStore;
