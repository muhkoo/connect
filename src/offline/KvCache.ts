/**
 * `KvCache` — the offline adapter for `client.kv`. Stores each value's
 * ciphertext envelope (never plaintext) under `${commitment}|${collection}/${id}`
 * as an LWW-Register stamped with an HLC, so reads work offline and concurrent
 * writes converge (see {@link ./crdt/LWWRegister}). Deletes are causal
 * tombstones — a stale write can't resurrect a key a newer delete removed.
 *
 * True cross-device convergence also needs the accelerator to honor the HLC
 * (see the server's `kvmeta` sidecar); this adapter embeds the stamp now and
 * degrades gracefully (last-writer-by-arrival) until that ships.
 */

import {
    emptyRegister,
    mergeRegister,
    writeRegister,
    deleteRegister,
    type LwwRegister,
} from "./crdt/LWWRegister";
import type { OfflineManager } from "./OfflineManager";
import type { OfflineStore } from "./store/OfflineStore";

export type KvEntry = LwwRegister<unknown>;

export class KvCache {
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

    private key(commitment: string, fullKey: string): string {
        return `${commitment}|${fullKey}`;
    }

    /** Read the cached register for `collection/id`, or null when absent. */
    read(commitment: string, fullKey: string): Promise<KvEntry | null> {
        return this.store.get<KvEntry>("kv-cache", this.key(commitment, fullKey));
    }

    /** Optimistically record a local `set` (ciphertext envelope + HLC). */
    async writeLocal(commitment: string, fullKey: string, envelope: unknown, hlc: string): Promise<void> {
        await this.store.put("kv-cache", this.key(commitment, fullKey), writeRegister(envelope, hlc));
    }

    /** Optimistically record a local `delete` (tombstone at HLC). */
    async deleteLocal(commitment: string, fullKey: string, hlc: string): Promise<void> {
        await this.store.put("kv-cache", this.key(commitment, fullKey), deleteRegister(hlc));
    }

    /**
     * Merge an authoritative value (from a GET refresh or a realtime frame) into
     * the cache by HLC. When the server doesn't supply an HLC yet, treat it as
     * "now-ish" by stamping our clock so a server value still beats stale local
     * state but a fresh local write wins.
     */
    async mergeRemote(
        commitment: string,
        fullKey: string,
        envelope: unknown | null,
        op: "set" | "delete",
        hlc?: string,
    ): Promise<void> {
        const k = this.key(commitment, fullKey);
        const incoming: KvEntry =
            op === "delete"
                ? deleteRegister(hlc ?? (await this.nextHlc()))
                : writeRegister(envelope, hlc ?? (await this.nextHlc()));
        const local = (await this.store.get<KvEntry>("kv-cache", k)) ?? emptyRegister();
        await this.store.put("kv-cache", k, mergeRegister(local, incoming));
    }

    /** Non-tombstoned full keys for a commitment (used for offline `list`). */
    async liveKeys(commitment: string): Promise<string[]> {
        const prefix = `${commitment}|`;
        const rows = await this.store.prefix<KvEntry>("kv-cache", prefix);
        return rows.filter((r) => !r.value.deleted).map((r) => r.key.slice(prefix.length));
    }

    /** Queue a kv mutation for replay on reconnect. */
    async enqueue(method: "set" | "delete", args: unknown, hlc: string, clientId: string): Promise<void> {
        await this.manager.enqueue({ hlc, clientId, domain: "kv", method, args });
    }
}

export default KvCache;
