/**
 * IndexedDB `muhkoo.trust` (design §6.6): pin high-water marks and per-Space log
 * heads. When IndexedDB is absent, throws on open, or has not opened within 2 s,
 * it is an in-memory store for the life of the Client, and `persistent` is
 * false (KI1).
 */
export interface TrustStore {
    readonly persistent: boolean;
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    del(key: string): Promise<void>;
}

export const TRUST_OPEN_TIMEOUT_MS = 2000;
const DB_NAME = "muhkoo.trust";
const STORE = "kv";

export function memoryTrustStore(): TrustStore {
    const m = new Map<string, unknown>();
    return {
        persistent: false,
        async get<T>(k: string) { return m.get(k) as T | undefined; },
        async put(k, v) { m.set(k, structuredClone(v)); },
        async del(k) { m.delete(k); },
    };
}

export async function openTrustStore(opts: { idb?: IDBFactory | null; timeoutMs?: number } = {}): Promise<TrustStore> {
    const idb = opts.idb === undefined ? (globalThis as { indexedDB?: IDBFactory }).indexedDB : opts.idb;
    if (!idb) return memoryTrustStore();
    const db = await new Promise<IDBDatabase | null>((resolve) => {
        let settled = false;
        const done = (v: IDBDatabase | null) => { if (!settled) { settled = true; resolve(v); } };
        const timer = setTimeout(() => done(null), opts.timeoutMs ?? TRUST_OPEN_TIMEOUT_MS);
        try {
            const req = idb.open(DB_NAME, 1);
            req.onupgradeneeded = () => {
                if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
            };
            req.onsuccess = () => { clearTimeout(timer); done(req.result); };
            req.onerror = () => { clearTimeout(timer); done(null); };
        } catch {
            clearTimeout(timer);
            done(null);
        }
    });
    if (!db) return memoryTrustStore();
    const run = <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
        new Promise((resolve, reject) => {
            const r = fn(db.transaction(STORE, mode).objectStore(STORE));
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => reject(r.error);
        });
    return {
        persistent: true,
        get: <T>(k: string) => run("readonly", (s) => s.get(k)) as Promise<T | undefined>,
        put: async (k, v) => { await run("readwrite", (s) => s.put(v, k)); },
        del: async (k) => { await run("readwrite", (s) => s.delete(k)); },
    };
}
