/**
 * `NoopStore` — the {@link OfflineStore} used wherever offline support is off
 * (Node, Workers, SSR, or when a consumer disables it). Every read returns
 * empty and every write is dropped, so the namespace hooks that call into it
 * behave exactly as they did before the offline layer existed. `enabled` is
 * `false` so hot paths can skip the call entirely.
 */

import type { OfflineEntry, OfflineStore, QueueEntry } from "./OfflineStore";
import type { StoreName } from "./schema";

export class NoopStore implements OfflineStore {
    readonly enabled = false;

    async ready(): Promise<void> {}
    async get<T>(_store: StoreName, _key: string): Promise<T | null> {
        return null;
    }
    async put<T>(_store: StoreName, _key: string, _value: T): Promise<void> {}
    async delete(_store: StoreName, _key: string): Promise<void> {}
    async prefix<T>(_store: StoreName, _prefix: string): Promise<Array<OfflineEntry<T>>> {
        return [];
    }
    async range<T>(_store: StoreName, _lower: string, _upper: string): Promise<Array<OfflineEntry<T>>> {
        return [];
    }
    async all<T>(_store: StoreName): Promise<Array<OfflineEntry<T>>> {
        return [];
    }
    async clear(_store: StoreName): Promise<void> {}
    async enqueue(_entry: Omit<QueueEntry, "seq">): Promise<number> {
        return -1;
    }
    async dequeue(_seq: number): Promise<void> {}
    async queued(): Promise<QueueEntry[]> {
        return [];
    }
}

export default NoopStore;
