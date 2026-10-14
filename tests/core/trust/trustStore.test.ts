import { describe, it, expect, vi } from "vitest";
import "fake-indexeddb/auto";
import { openTrustStore } from "../../../src/core/trust/trustStore";

describe("muhkoo.trust (KI1)", () => {
    it("persists through IndexedDB when available", async () => {
        const s = await openTrustStore();
        expect(s.persistent).toBe(true);
        await s.put("k", { seq: 3 });
        expect(await s.get("k")).toEqual({ seq: 3 });
    });
    it("falls back to memory when indexedDB is absent", async () => {
        const s = await openTrustStore({ idb: null as never });
        expect(s.persistent).toBe(false);
    });
    it("falls back to memory when open never settles within 2 s", async () => {
        vi.useFakeTimers();
        const never = { open: () => ({}) } as unknown as IDBFactory;
        const p = openTrustStore({ idb: never });
        await vi.advanceTimersByTimeAsync(2000);
        expect((await p).persistent).toBe(false);
        vi.useRealTimers();
    });
});
