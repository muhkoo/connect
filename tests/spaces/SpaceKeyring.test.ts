/**
 * SpaceKeyring tests — the server-blind key-distribution dance over an
 * in-memory transport: request → admit (wrap) → pull (unwrap), plus rotation
 * isolation and the PersonalSpace cache round-trip.
 */

import { describe, it, expect } from "vitest";
import {
    SpaceKeyring,
    type KeyringTransport,
    type SpaceKeyCache,
} from "../../src/spaces/SpaceKeyring";
import { exportEcdhPublicKey } from "../../src/spaces/SpaceCipher";
import type { WrappedKey, JoinRequest, HistoryPolicy } from "../../src/spaces/types";

/** Shared in-memory keyring server: opaque blob storage + pending list. */
class MemTransport implements KeyringTransport {
    blobs = new Map<string, WrappedKey[]>();
    pending: JoinRequest[] = [];
    roster: Array<{ memberId: string; identityEcdhPub: string }> = [];
    epoch = 0;

    async postJoinRequest(req: JoinRequest): Promise<void> {
        this.pending = this.pending.filter((p) => p.memberId !== req.memberId);
        this.pending.push(req);
    }
    async fetchBlobs(memberId: string): Promise<WrappedKey[]> {
        return [...(this.blobs.get(memberId) ?? [])];
    }
    async postWrappedKey(targetMemberId: string, wrapped: WrappedKey): Promise<void> {
        const list = this.blobs.get(targetMemberId) ?? [];
        list.push(wrapped);
        this.blobs.set(targetMemberId, list);
    }
    async fetchPending(): Promise<JoinRequest[]> {
        return [...this.pending];
    }
    async fetchRoster(): Promise<Array<{ memberId: string; identityEcdhPub: string }>> {
        return [...this.roster];
    }
    async rotate(nextEpoch: number): Promise<{ epoch: number }> {
        this.epoch = Math.max(this.epoch + 1, nextEpoch);
        return { epoch: this.epoch };
    }
    async fetchMetadata() {
        return null;
    }
}

interface Member {
    id: string;
    pub: string;
    priv: CryptoKey;
    keyring: SpaceKeyring;
}

async function makeMember(
    id: string,
    spaceId: string,
    transport: KeyringTransport,
    historyPolicy: HistoryPolicy,
    cache?: SpaceKeyCache,
): Promise<Member> {
    const kp = (await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-384" },
        true,
        ["deriveBits"],
    )) as CryptoKeyPair;
    const pub = await exportEcdhPublicKey(kp.publicKey);
    const keyring = new SpaceKeyring({
        spaceId,
        memberId: id,
        identityEcdhPub: pub,
        ownPrivateKey: () => kp.privateKey,
        transport,
        cache,
        historyPolicy,
    });
    return { id, pub, priv: kp.privateKey, keyring };
}

describe("SpaceKeyring — static distribution", () => {
    it("a newcomer requests, an online holder admits, and keys match", async () => {
        const t = new MemTransport();
        const spaceId = "space-A";
        const alice = await makeMember("alice", spaceId, t, "static");
        const bob = await makeMember("bob", spaceId, t, "static");

        await alice.keyring.bootstrapNew();          // creator mints epoch 0
        await bob.keyring.requestKey();              // newcomer asks
        const admitted = await alice.keyring.admitPending(); // holder wraps for bob
        expect(admitted).toEqual(["bob"]);

        const added = await bob.keyring.pullKeys();  // newcomer unwraps
        expect(added).toBe(1);
        expect(bob.keyring.keyForEpoch(0)).toBeDefined();
        expect(Array.from(bob.keyring.keyForEpoch(0)!)).toEqual(
            Array.from(alice.keyring.keyForEpoch(0)!),
        );
    });
});

describe("SpaceKeyring — rotate isolation", () => {
    it("a member admitted after rotation only holds the current epoch", async () => {
        const t = new MemTransport();
        const spaceId = "space-R";
        const alice = await makeMember("alice", spaceId, t, "rotate");
        const bob = await makeMember("bob", spaceId, t, "rotate");
        const carol = await makeMember("carol", spaceId, t, "rotate");

        // epoch 0: alice + bob.
        await alice.keyring.bootstrapNew();
        await bob.keyring.requestKey();
        await alice.keyring.admitPending();
        await bob.keyring.pullKeys();
        expect(bob.keyring.keyForEpoch(0)).toBeDefined();

        // Rotate to epoch 1, re-wrapping to bob.
        const newEpoch = await alice.keyring.rotate([{ memberId: bob.id, identityEcdhPub: bob.pub }]);
        expect(newEpoch).toBe(1);
        await bob.keyring.pullKeys();
        expect(bob.keyring.keyForEpoch(1)).toBeDefined();
        expect(alice.keyring.currentEpoch()).toBe(1);

        // Carol joins at epoch 1: rotate-mode admit gives only the current epoch.
        await carol.keyring.requestKey();
        await alice.keyring.admitPending();
        await carol.keyring.pullKeys();
        expect(carol.keyring.keyForEpoch(1)).toBeDefined();
        expect(carol.keyring.keyForEpoch(0)).toBeUndefined(); // cannot read pre-join history
    });
});

describe("SpaceKeyring — PersonalSpace cache", () => {
    it("rehydrates keys from cache without a network round-trip", async () => {
        const store: Record<string, Record<string, string>> = {};
        const cache: SpaceKeyCache = {
            loadKeys: async (id) => store[id] ?? null,
            saveKeys: async (id, keys) => { store[id] = keys; },
        };
        const t = new MemTransport();
        const spaceId = "space-C";

        const first = await makeMember("alice", spaceId, t, "static", cache);
        await first.keyring.bootstrapNew(); // persists epoch 0 to cache

        // A fresh keyring (e.g. next session) loads from cache.
        const second = await makeMember("alice", spaceId, t, "static", cache);
        expect(await second.keyring.loadFromCache()).toBe(true);
        expect(Array.from(second.keyring.keyForEpoch(0)!)).toEqual(
            Array.from(first.keyring.keyForEpoch(0)!),
        );
    });
});
