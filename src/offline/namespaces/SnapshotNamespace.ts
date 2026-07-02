/**
 * `client.offline.snapshot` — a small, encrypted, app-state cache. Apps stash
 * whatever they need to repaint instantly on a cold offline boot: the last open
 * Space, a draft message, scroll position, the current route. It's deliberately
 * separate from `client.kv`: snapshots are **local-only by default** (instant,
 * never metered, never leave the device) and hold view state rather than domain
 * data.
 *
 *   await client.offline.snapshot.save('ui', { route, openSpaceId, draft })
 *   const ui = await client.offline.snapshot.load<UiState>('ui')
 *
 * Values are encrypted at rest with the same identity-derived {@link StorageCipher}
 * as `client.kv`, so a snapshot is unreadable until the user unlocks — `load`
 * returns `null` when locked or absent, and `save` throws {@link OfflineLockedError}.
 * Conflict model is a single-writer LWW register (the latest save wins).
 */

import type { SessionState } from "../../core/Session";
import type { ZkIdentity } from "../../auth/identity";
import { StorageCipher, type EncryptedEnvelope } from "../../crypto/StorageCipher";
import type { OfflineStore } from "../store/OfflineStore";
import { OfflineLockedError } from "../errors";

export interface SnapshotNamespaceDeps {
    store: OfflineStore;
    session: SessionState;
    /** Stamp the saved record (LWW ordering); supplied by the OfflineManager. */
    nextHlc: () => Promise<string>;
}

interface SnapshotRecord {
    envelope: EncryptedEnvelope;
    hlc: string;
    updatedAt: number;
}

export class SnapshotNamespace {
    private cipher: StorageCipher | null = null;
    private cipherIdentity: ZkIdentity | null = null;

    constructor(private readonly deps: SnapshotNamespaceDeps) {}

    /** Persist `state` under `name` (encrypted). No-op when offline support is off. */
    async save<T = unknown>(name: string, state: T): Promise<void> {
        if (!this.deps.store.enabled) return;
        const envelope = await this.requireCipher().encrypt(state);
        const record: SnapshotRecord = {
            envelope,
            hlc: await this.deps.nextHlc(),
            updatedAt: Date.now(),
        };
        await this.deps.store.put("snapshots", this.key(name), record);
    }

    /** Load and decrypt the snapshot `name`, or `null` if absent/locked. */
    async load<T = unknown>(name: string): Promise<T | null> {
        if (!this.deps.store.enabled) return null;
        const record = await this.deps.store.get<SnapshotRecord>("snapshots", this.key(name));
        if (!record) return null;
        if (!this.deps.session.isUnlocked) return null;
        return this.requireCipher().decrypt<T>(record.envelope);
    }

    /** Remove the snapshot `name`. */
    async delete(name: string): Promise<void> {
        if (!this.deps.store.enabled) return;
        await this.deps.store.delete("snapshots", this.key(name));
    }

    /** Names of all snapshots for the current user. */
    async list(): Promise<string[]> {
        if (!this.deps.store.enabled) return [];
        const prefix = `${this.commitment()}|`;
        const rows = await this.deps.store.prefix<SnapshotRecord>("snapshots", prefix);
        return rows.map((r) => r.key.slice(prefix.length));
    }

    private key(name: string): string {
        return `${this.commitment()}|${name}`;
    }

    private commitment(): string {
        // Snapshots are scoped per user; before sign-in they share an "anon"
        // bucket so pre-auth UI state (e.g. a chosen theme) still persists.
        return this.deps.session.commitment ?? "anon";
    }

    private requireCipher(): StorageCipher {
        if (!this.deps.session.isUnlocked) throw new OfflineLockedError();
        const identity = this.deps.session.requireIdentity();
        if (this.cipher && this.cipherIdentity === identity) return this.cipher;
        this.cipher = new StorageCipher(identity.secretHex, identity.saltHex);
        this.cipherIdentity = identity;
        return this.cipher;
    }
}

export default SnapshotNamespace;
