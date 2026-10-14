/**
 * How a long walk hands the event loop back.
 *
 * Only Node's path runs here, so what a browser would do is checked by
 * stubbing what a browser has.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTurn } from "../../src/vfs/bounds";

describe("nextTurn", () => {
    const g = globalThis as { scheduler?: unknown; setImmediate?: unknown };
    const saved = { scheduler: g.scheduler, setImmediate: g.setImmediate };
    afterEach(() => {
        g.scheduler = saved.scheduler;
        g.setImmediate = saved.setImmediate;
        vi.restoreAllMocks();
    });

    it("never uses scheduler.yield, which runs ahead of timers and messages", async () => {
        // Chromium schedules a yield() continuation before tasks already
        // queued at the same priority, and a timer, a postMessage and a
        // socket message are such tasks: 2s of walking gave a 1ms interval
        // no ticks at all.
        const yieldStub = vi.fn(() => Promise.resolve());
        g.scheduler = { yield: yieldStub };
        await nextTurn();
        expect(yieldStub).not.toHaveBeenCalled();
    });

    it("uses a message rather than a timer where there is no setImmediate", async () => {
        // A browser clamps a timer set from inside another, and throttles it
        // hard in a background tab.
        g.scheduler = { yield: vi.fn(() => Promise.resolve()) };
        g.setImmediate = undefined;
        const timer = vi.spyOn(globalThis, "setTimeout");
        await nextTurn();
        expect(timer).not.toHaveBeenCalled();
    });
});
