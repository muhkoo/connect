import { describe, it, expect } from "vitest";
import { PeerNetwork } from "../../src/p2p/PeerNetwork";
import type { PeerId, PeerTransport } from "../../src/p2p/transport/PeerTransport";
import type { BlockStore } from "../../src/p2p/worker/blockEngine";
import { shardHash } from "../../src/storage/transport/ShardClient";

// --- in-memory paired transport (no real WebRTC) ----------------------------
class Hub {
    nodes = new Map<PeerId, FakeTransport>();
    route(from: PeerId, to: PeerId, data: Uint8Array, channel: number) {
        this.nodes.get(to)?.deliver(from, data, channel);
    }
}
class FakeTransport implements PeerTransport {
    private cbs = new Set<(p: PeerId, d: Uint8Array, c: number) => void>();
    constructor(private id: PeerId, private hub: Hub) {
        hub.nodes.set(id, this);
    }
    peers() {
        return [...this.hub.nodes.keys()].filter((k) => k !== this.id);
    }
    send(peer: PeerId, data: Uint8Array, channel = 0) {
        this.hub.route(this.id, peer, data, channel);
    }
    broadcast(data: Uint8Array, channel = 0) {
        for (const p of this.peers()) this.hub.route(this.id, p, data, channel);
    }
    onMessage(cb: (p: PeerId, d: Uint8Array, c: number) => void) {
        this.cbs.add(cb);
        return () => this.cbs.delete(cb);
    }
    onPeerChange() {
        return () => {};
    }
    close() {}
    deliver(from: PeerId, data: Uint8Array, channel: number) {
        for (const cb of this.cbs) cb(from, data, channel);
    }
}

class MemStore implements BlockStore {
    map = new Map<string, Uint8Array>();
    async get(h: string) {
        return this.map.get(h) ?? null;
    }
    async put(h: string, b: Uint8Array) {
        this.map.set(h, b);
    }
    async has(h: string) {
        return this.map.has(h);
    }
}

const fakeSpace = { sendEphemeral() {}, onEphemeral: () => () => {} };

function makeNet(id: string, hub: Hub, store: BlockStore) {
    return new PeerNetwork({ space: fakeSpace, myId: id, transport: new FakeTransport(id, hub), store });
}

describe("PeerNetwork gossip + channel mux", () => {
    it("delivers gossip to peers with the authenticated sender", async () => {
        const hub = new Hub();
        const a = makeNet("A", hub, new MemStore());
        const b = makeNet("B", hub, new MemStore());
        const got: Array<{ from: string; data: Uint8Array }> = [];
        b.onGossip((from, data) => got.push({ from, data }));

        a.gossip(new Uint8Array([1, 2, 3]));
        expect(got).toEqual([{ from: "A", data: new Uint8Array([1, 2, 3]) }]);
        a.close();
        b.close();
    });

    it("block exchange and gossip share the mesh without crossing channels", async () => {
        const hub = new Hub();
        const storeB = new MemStore();
        const bytes = new Uint8Array([9, 8, 7, 6]);
        const hash = await shardHash(bytes);
        await storeB.put(hash, bytes);

        const a = makeNet("A", hub, new MemStore());
        const b = makeNet("B", hub, storeB);

        const gossipOnA: Uint8Array[] = [];
        a.onGossip((_from, data) => gossipOnA.push(data));

        // Block fetch over channel 0 — must NOT surface as gossip on A.
        const block = await a.exchange.getBlock(hash, { timeoutMs: 1000 });
        expect(block).toEqual(bytes);
        expect(gossipOnA).toHaveLength(0);

        // Gossip over channel 1 — must NOT be parsed as a block (no throw, just
        // delivered to gossip subscribers).
        const gossipOnB: Uint8Array[] = [];
        b.onGossip((_f, d) => gossipOnB.push(d));
        a.gossip(new Uint8Array([42]));
        expect(gossipOnB).toEqual([new Uint8Array([42])]);

        a.close();
        b.close();
    });
});
