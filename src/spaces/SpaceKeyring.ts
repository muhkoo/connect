/**
 * SpaceKeyring — the client's view of a space's group keys.
 *
 * Holds the per-epoch group keys this member possesses (in memory, optionally
 * mirrored to PersonalSpace), and orchestrates the server-blind distribution
 * dance against a {@link KeyringTransport}:
 *
 *   - a newcomer posts a join request and pulls the wrapped key blob addressed
 *     to it, unwrapping with its identity private key;
 *   - an existing key-holder wraps the group key for a newcomer (ECIES to the
 *     newcomer's identity public key) and posts the opaque blob;
 *   - on membership change (rotate spaces) a fresh epoch key is minted and
 *     re-wrapped to the current roster.
 *
 * The server only ever stores opaque {@link WrappedKey} blobs — it cannot read
 * the group key. Implements {@link EpochKeyProvider} so it can back a
 * {@link SpacePacketCipher} directly.
 */

import type { WrappedKey, JoinRequest, HistoryPolicy, SpaceMetadata, RosterMember } from "./types";
import {
    generateSpaceKey,
    wrapSpaceKey,
    unwrapSpaceKey,
    importEcdhPublicKey,
    importEcdsaPublicKey,
} from "./SpaceCipher";
import type { EpochKeyProvider } from "./SpacePacketCipher";
import { toBase64, fromBase64 } from "../utilities";

/**
 * Reserved member id for the app's "keeper" — a trusted always-available member
 * (the accelerator's AppDOv1) that holds the group key and re-issues it to
 * newcomers, so a channel is joinable with no human online. Admitting this id
 * at channel creation hands the key to the keeper. MUST match the accelerator's
 * `KEEPER_MEMBER_ID`.
 */
export const KEEPER_MEMBER_ID = "__keeper__";

/** Opaque-blob transport to the space's keyring (HTTP or in-memory test seam). */
export interface KeyringTransport {
    postJoinRequest(req: JoinRequest): Promise<void>;
    /** All wrapped blobs addressed to `memberId` (any epoch). */
    fetchBlobs(memberId: string): Promise<WrappedKey[]>;
    /** Post a wrapped key blob for `targetMemberId`. */
    postWrappedKey(targetMemberId: string, wrapped: WrappedKey, fromMemberId: string): Promise<void>;
    /** Outstanding join requests (for an online key-holder to fulfill). */
    fetchPending(): Promise<JoinRequest[]>;
    /** Current roster: member ids + their identity ECDH/ECDSA public keys. */
    fetchRoster(): Promise<RosterMember[]>;
    /** Advisory epoch bump; returns the agreed new epoch. */
    rotate(nextEpoch: number): Promise<{ epoch: number }>;
    /** Add `username` to a private channel's membership allowlist. */
    invite(username: string): Promise<void>;
    fetchMetadata(): Promise<SpaceMetadata | null>;
}

/** PersonalSpace-backed cache of this member's group keys (epoch → base64 key). */
export interface SpaceKeyCache {
    loadKeys(spaceId: string): Promise<Record<string, string> | null>;
    saveKeys(spaceId: string, keys: Record<string, string>): Promise<void>;
}

export interface SpaceKeyringDeps {
    spaceId: string;
    memberId: string;
    /** This member's identity ECDH public key, base64url JWK (for join requests). */
    identityEcdhPub: string;
    /** This member's identity ECDSA public key, base64url JWK (published for
     * sender-signature verification). */
    identityEcdsaPub?: string;
    /** Resolves this member's identity ECDH private key (for unwrapping). */
    ownPrivateKey: () => CryptoKey | null;
    transport: KeyringTransport;
    cache?: SpaceKeyCache;
    historyPolicy?: HistoryPolicy;
}

export class SpaceKeyring implements EpochKeyProvider {
    private readonly keys = new Map<number, Uint8Array>();
    private epoch = 0;
    private readonly policy: HistoryPolicy;
    /** Cached member directory: memberId → imported ECDSA verify key. */
    private readonly memberEcdsa = new Map<string, CryptoKey>();

    constructor(private readonly deps: SpaceKeyringDeps) {
        this.policy = deps.historyPolicy ?? "static";
    }

    // -- member directory (for verifying sender signatures) -------------------

    /** The cached ECDSA verify key for a member, if known. */
    ecdsaKeyFor(memberId: string): CryptoKey | undefined {
        return this.memberEcdsa.get(memberId);
    }

    /** Refresh the member directory (memberId → ECDSA key) from the roster. */
    async refreshDirectory(): Promise<void> {
        let roster: RosterMember[];
        try {
            roster = await this.deps.transport.fetchRoster();
        } catch {
            return;
        }
        for (const m of roster) {
            if (!m.identityEcdsaPub || this.memberEcdsa.has(m.memberId)) continue;
            try {
                this.memberEcdsa.set(m.memberId, await importEcdsaPublicKey(m.identityEcdsaPub));
            } catch {
                /* skip malformed entries */
            }
        }
    }

    // -- EpochKeyProvider ------------------------------------------------------

    currentEpoch(): number {
        return this.epoch;
    }

    keyForEpoch(epoch: number): Uint8Array | undefined {
        return this.keys.get(epoch);
    }

    hasAnyKey(): boolean {
        return this.keys.size > 0;
    }

    // -- lifecycle -------------------------------------------------------------

    /** Hydrate keys from the PersonalSpace cache, if available. Best-effort —
     * a cache miss/failure (e.g. not unlocked) must not block joining. */
    async loadFromCache(): Promise<boolean> {
        if (!this.deps.cache) return false;
        let cached: Record<string, string> | null;
        try {
            cached = await this.deps.cache.loadKeys(this.deps.spaceId);
        } catch {
            return false;
        }
        if (!cached) return false;
        for (const [epochStr, b64] of Object.entries(cached)) {
            this.keys.set(Number(epochStr), fromBase64(b64));
        }
        this.epoch = Math.max(0, ...Array.from(this.keys.keys()));
        return this.keys.size > 0;
    }

    private async persist(): Promise<void> {
        if (!this.deps.cache) return;
        const out: Record<string, string> = {};
        for (const [epoch, key] of this.keys) out[String(epoch)] = toBase64(key);
        // Best-effort: caching is an optimization; a write failure (e.g. locked
        // storage) must not break key acquisition.
        try {
            await this.deps.cache.saveKeys(this.deps.spaceId, out);
        } catch {
            /* ignore */
        }
    }

    /** Creator path: mint epoch-0 group key for a brand-new space. */
    async bootstrapNew(): Promise<void> {
        this.keys.set(0, generateSpaceKey());
        this.epoch = 0;
        await this.persist();
    }

    // -- newcomer: request + pull ---------------------------------------------

    /**
     * Post a join request so an online key-holder can wrap a key for us. Also
     * publishes our identity keys in the member directory (so others can verify
     * our message signatures, and the keeper can wrap to us).
     */
    async requestKey(desiredEpoch?: number): Promise<void> {
        await this.deps.transport.postJoinRequest({
            memberId: this.deps.memberId,
            identityEcdhPub: this.deps.identityEcdhPub,
            identityEcdsaPub: this.deps.identityEcdsaPub,
            desiredEpoch,
        });
    }

    /**
     * Pull and unwrap any blobs addressed to us. Returns the number of new
     * epoch keys obtained. Safe to call repeatedly (idempotent).
     */
    async pullKeys(): Promise<number> {
        const priv = this.deps.ownPrivateKey();
        if (!priv) throw new Error("SpaceKeyring: no identity private key to unwrap with");
        const blobs = await this.deps.transport.fetchBlobs(this.deps.memberId);
        let added = 0;
        for (const blob of blobs) {
            if (this.keys.has(blob.epoch)) continue;
            try {
                const key = await unwrapSpaceKey(blob, priv);
                this.keys.set(blob.epoch, key);
                added++;
            } catch {
                // Not for us / tampered — skip this blob.
            }
        }
        if (added > 0) {
            this.epoch = Math.max(this.epoch, ...Array.from(this.keys.keys()));
            await this.persist();
        }
        return added;
    }

    // -- key-holder: admit + rotate -------------------------------------------

    /**
     * Wrap our group key(s) for a newcomer and post the blobs. In a `static`
     * space the newcomer receives every epoch we hold (full history); in a
     * `rotate` space they receive only the current epoch.
     */
    async admit(targetMemberId: string, identityEcdhPub: string): Promise<void> {
        const recipient = await importEcdhPublicKey(identityEcdhPub);
        const epochs = this.policy === "static"
            ? Array.from(this.keys.keys())
            : [this.epoch];
        for (const epoch of epochs) {
            const key = this.keys.get(epoch);
            if (!key) continue;
            const wrapped = await wrapSpaceKey(key, epoch, recipient);
            await this.deps.transport.postWrappedKey(targetMemberId, wrapped, this.deps.memberId);
        }
    }

    /**
     * Admit every outstanding join request (an online key-holder fulfilling
     * pending newcomers). Returns the ids admitted.
     */
    async admitPending(): Promise<string[]> {
        const pending = await this.deps.transport.fetchPending();
        const admitted: string[] = [];
        for (const req of pending) {
            if (req.memberId === this.deps.memberId) continue;
            await this.admit(req.memberId, req.identityEcdhPub);
            admitted.push(req.memberId);
        }
        return admitted;
    }

    /**
     * Rotate to a fresh epoch (rotate spaces). Mints a new group key, advances
     * the epoch, and re-wraps it to every member in `roster` (plus ourselves).
     */
    async rotate(roster?: Array<{ memberId: string; identityEcdhPub: string }>): Promise<number> {
        const members = roster ?? (await this.deps.transport.fetchRoster());
        const { epoch: nextEpoch } = await this.deps.transport.rotate(this.epoch + 1);
        const newKey = generateSpaceKey();
        this.keys.set(nextEpoch, newKey);
        this.epoch = nextEpoch;
        for (const m of members) {
            if (m.memberId === this.deps.memberId) continue;
            const recipient = await importEcdhPublicKey(m.identityEcdhPub);
            const wrapped = await wrapSpaceKey(newKey, nextEpoch, recipient);
            await this.deps.transport.postWrappedKey(m.memberId, wrapped, this.deps.memberId);
        }
        await this.persist();
        return nextEpoch;
    }

    /** Add `username` to a private channel's membership allowlist (member-only). */
    async invite(username: string): Promise<void> {
        await this.deps.transport.invite(username);
    }
}
