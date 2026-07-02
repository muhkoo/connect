/**
 * A ~thin promise wrapper over the raw IndexedDB API — just enough surface for
 * {@link ./IndexedDbStore}: open-with-migration, get/put/delete, prefix and
 * range cursor scans, autoincrement append, and clear. We hand-roll this rather
 * than depend on `idb`/`dexie` because the access patterns are simple and
 * `@muhkoo/connect` keeps its runtime dependency surface minimal.
 *
 * Everything here assumes a browser (or a `fake-indexeddb` test shim) — callers
 * gate construction behind {@link ../detect}.
 */

import { DB_NAME, DB_VERSION, STORES, type StoreName } from "./schema";

function req<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/** Open (and migrate) the offline database. Creates any missing object store. */
export function openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const open = indexedDB.open(DB_NAME, DB_VERSION);
        open.onupgradeneeded = () => {
            const db = open.result;
            for (const def of STORES) {
                if (db.objectStoreNames.contains(def.name)) continue;
                db.createObjectStore(
                    def.name,
                    def.autoIncrement ? { keyPath: def.keyPath, autoIncrement: true } : undefined,
                );
            }
        };
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
        // A blocked upgrade means another tab holds an older version open; let
        // it surface as an error rather than hang forever.
        open.onblocked = () => reject(new Error("offline DB upgrade blocked by another tab"));
    });
}

export interface IdbEntry<T> {
    key: string;
    value: T;
}

/** Wraps an open connection with the typed operations the store needs. */
export class IdbConnection {
    constructor(private readonly db: IDBDatabase) {}

    private tx(store: StoreName, mode: IDBTransactionMode): IDBObjectStore {
        return this.db.transaction(store, mode).objectStore(store);
    }

    get<T>(store: StoreName, key: string): Promise<T | null> {
        return req<T | undefined>(this.tx(store, "readonly").get(key)).then((v) => v ?? null);
    }

    async put<T>(store: StoreName, key: string, value: T): Promise<void> {
        await req(this.tx(store, "readwrite").put(value as unknown, key));
    }

    async delete(store: StoreName, key: IDBValidKey): Promise<void> {
        await req(this.tx(store, "readwrite").delete(key));
    }

    async clear(store: StoreName): Promise<void> {
        await req(this.tx(store, "readwrite").clear());
    }

    /** Append to an autoincrement store; resolves with the generated key. */
    async append<T>(store: StoreName, value: T): Promise<number> {
        const key = await req(this.tx(store, "readwrite").add(value as unknown));
        return key as number;
    }

    /** All entries whose string key falls in `[lower, upper)`, in key order. */
    range<T>(store: StoreName, lower: string, upper: string): Promise<Array<IdbEntry<T>>> {
        return this.scan<T>(store, IDBKeyRange.bound(lower, upper, false, true));
    }

    /** All entries whose key starts with `prefix`, in key order. */
    prefix<T>(store: StoreName, prefix: string): Promise<Array<IdbEntry<T>>> {
        // "￿" is the largest BMP code unit, so `[prefix, prefix+￿)`
        // bounds every key that begins with `prefix`.
        return this.scan<T>(store, IDBKeyRange.bound(prefix, prefix + "￿", false, true));
    }

    /** Every entry in the store, in key order. */
    all<T>(store: StoreName): Promise<Array<IdbEntry<T>>> {
        return this.scan<T>(store, null);
    }

    private scan<T>(store: StoreName, range: IDBKeyRange | null): Promise<Array<IdbEntry<T>>> {
        return new Promise((resolve, reject) => {
            const out: Array<IdbEntry<T>> = [];
            const cursorReq = this.tx(store, "readonly").openCursor(range ?? undefined);
            cursorReq.onsuccess = () => {
                const cursor = cursorReq.result;
                if (!cursor) return resolve(out);
                out.push({ key: String(cursor.key), value: cursor.value as T });
                cursor.continue();
            };
            cursorReq.onerror = () => reject(cursorReq.error);
        });
    }
}
