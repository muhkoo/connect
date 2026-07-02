import { describe, it, expect } from "vitest";
import { HLC } from "../../src/offline/clock/HLC";
import { compareHlc, unpack, pack, ZERO_HLC } from "../../src/offline/clock/HlcTimestamp";

describe("HlcTimestamp", () => {
    it("packs to a lexicographically-sortable string", () => {
        const a = pack(100, 0, "node-a");
        const b = pack(100, 1, "node-a");
        const c = pack(101, 0, "node-a");
        expect(a < b).toBe(true);
        expect(b < c).toBe(true);
        // string compare == causal order
        expect(compareHlc(a, c)).toBe(-1);
        expect(compareHlc(c, a)).toBe(1);
        expect(compareHlc(a, a)).toBe(0);
    });

    it("round-trips through unpack", () => {
        const parts = unpack(pack(1716000000000, 42, "node-xyz"));
        expect(parts).toEqual({ wall: 1716000000000, counter: 42, nodeId: "node-xyz" });
    });

    it("ZERO_HLC loses to any real stamp", () => {
        expect(compareHlc(pack(1, 0, "n"), ZERO_HLC)).toBe(1);
    });
});

describe("HLC", () => {
    it("is monotonic even when physical time stalls", () => {
        let t = 1000;
        const hlc = new HLC("node-a", { physical: () => t });
        const s1 = hlc.now();
        const s2 = hlc.now(); // same ms → counter bumps
        const s3 = hlc.now();
        expect(compareHlc(s1, s2)).toBe(-1);
        expect(compareHlc(s2, s3)).toBe(-1);
        expect(unpack(s3).counter).toBe(2);
    });

    it("resets the counter when physical time advances", () => {
        let t = 1000;
        const hlc = new HLC("node-a", { physical: () => t });
        hlc.now();
        hlc.now();
        t = 2000;
        const s = hlc.now();
        expect(unpack(s)).toMatchObject({ wall: 2000, counter: 0 });
    });

    it("advances strictly past an observed remote stamp", () => {
        let t = 1000;
        const hlc = new HLC("node-a", { physical: () => t });
        const remote = unpack(pack(5000, 7, "node-b")); // remote clock ahead of us
        const merged = hlc.update(remote);
        // our next local stamp must be causally after the remote one
        expect(compareHlc(merged, pack(5000, 7, "node-b"))).toBe(1);
        const next = hlc.now();
        expect(compareHlc(next, merged)).toBe(1);
    });

    it("persists + restores state across a reload", () => {
        let t = 3000;
        const first = new HLC("node-a", { physical: () => t });
        first.now();
        first.now();
        const saved = first.getState();
        // Simulate a reload where physical time went backwards (stale clock).
        const reloaded = new HLC("node-a", { state: saved, physical: () => 2500 });
        const afterReload = reloaded.now();
        // It must not regress below what we already handed out.
        expect(unpack(afterReload).wall).toBe(3000);
        expect(unpack(afterReload).counter).toBeGreaterThan(saved.counter);
    });
});
