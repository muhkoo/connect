import { describe, it, expect, vi } from "vitest";
import { BlockEngine, type BlockStore, type OutSink } from "../../src/p2p/worker/blockEngine";
import { shardHash } from "../../src/storage/transport/ShardClient";

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

describe("BlockEngine", () => {
    it("fetches a block a peer holds, verifies it, stores it, and resolves", async () => {
        const storeA = new MemStore();
        const storeB = new MemStore();
        const bytes = new Uint8Array([10, 20, 30, 40]);
        const hash = await shardHash(bytes);
        await storeB.put(hash, bytes);

        let engineA!: BlockEngine;
        let engineB!: BlockEngine;
        const outA: OutSink = (_t, frame) => void engineB.handleFrame("A", frame);
        const outB: OutSink = (_t, frame) => void engineA.handleFrame("B", frame);
        engineA = new BlockEngine(storeA, outA, shardHash);
        engineB = new BlockEngine(storeB, outB, shardHash);

        const got = await engineA.want(hash, 1000);
        expect(got).toEqual(bytes);
        // A cached it locally for next time.
        expect(await storeA.get(hash)).toEqual(bytes);
    });

    it("returns a local hit immediately without going to peers", async () => {
        const store = new MemStore();
        const bytes = new Uint8Array([1, 2, 3]);
        const hash = await shardHash(bytes);
        await store.put(hash, bytes);
        const out = vi.fn();
        const engine = new BlockEngine(store, out, shardHash);
        expect(await engine.want(hash, 1000)).toEqual(bytes);
        expect(out).not.toHaveBeenCalled(); // no WANT broadcast
    });

    it("drops a tampered block (hash mismatch) and times out to null", async () => {
        const storeA = new MemStore();
        const storeB = new MemStore();
        const bytes = new Uint8Array([5, 5, 5, 5]);
        const hash = await shardHash(bytes);
        // B claims to have `hash` but actually serves different bytes.
        await storeB.put(hash, new Uint8Array([6, 6, 6, 6]));

        let engineA!: BlockEngine;
        let engineB!: BlockEngine;
        engineA = new BlockEngine(storeA, (_t, f) => void engineB.handleFrame("A", f), shardHash);
        engineB = new BlockEngine(storeB, (_t, f) => void engineA.handleFrame("B", f), shardHash);

        const got = await engineA.want(hash, 150);
        expect(got).toBeNull(); // mismatch rejected → timeout
        expect(await storeA.get(hash)).toBeNull(); // store not poisoned
    });

    it("times out to null when no peer has the block", async () => {
        const engine = new BlockEngine(new MemStore(), () => {}, shardHash);
        const got = await engine.want("b".repeat(64), 100);
        expect(got).toBeNull();
    });

    it("dedupes concurrent wants for the same hash into one request", async () => {
        const storeA = new MemStore();
        const storeB = new MemStore();
        const bytes = new Uint8Array([7, 7, 7]);
        const hash = await shardHash(bytes);
        await storeB.put(hash, bytes);

        let engineA!: BlockEngine;
        let engineB!: BlockEngine;
        const wants: number[] = [];
        engineA = new BlockEngine(
            storeA,
            (_t, f) => {
                if (f[0] === 0 /* WANT */) wants.push(1);
                void engineB.handleFrame("A", f);
            },
            shardHash,
        );
        engineB = new BlockEngine(storeB, (_t, f) => void engineA.handleFrame("B", f), shardHash);

        const [a, b] = await Promise.all([engine_wait(engineA, hash), engine_wait(engineA, hash)]);
        expect(a).toEqual(bytes);
        expect(b).toEqual(bytes);
        expect(wants.length).toBe(1); // only one WANT went out
    });
});

function engine_wait(e: BlockEngine, hash: string) {
    return e.want(hash, 1000);
}
