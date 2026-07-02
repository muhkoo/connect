import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ConnectivityManager } from "../../src/offline/ConnectivityManager";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("ConnectivityManager", () => {
    it("starts online when navigator is unavailable (Node)", () => {
        const cm = new ConnectivityManager();
        expect(cm.current).toBe("online");
        expect(cm.isOnline).toBe(true);
    });

    it("debounces a fetch failure before going offline", () => {
        const cm = new ConnectivityManager({ debounceMs: 1000 });
        const seen: string[] = [];
        cm.onChange((s) => seen.push(s));
        cm.reportFetchFailure();
        expect(cm.current).toBe("online"); // not yet — debounced
        vi.advanceTimersByTime(1000);
        expect(cm.current).toBe("offline");
        expect(seen).toEqual(["offline"]);
    });

    it("a successful fetch recovers and fires onReconnect once", () => {
        const onReconnect = vi.fn();
        const cm = new ConnectivityManager({ debounceMs: 500, onReconnect });
        cm.reportFetchFailure();
        vi.advanceTimersByTime(500);
        expect(cm.current).toBe("offline");

        cm.reportFetchSuccess();
        expect(cm.current).toBe("online");
        expect(onReconnect).toHaveBeenCalledTimes(1);

        // Already online → no further reconnect callbacks.
        cm.reportFetchSuccess();
        expect(onReconnect).toHaveBeenCalledTimes(1);
    });

    it("the sync engine owns the syncing→online edge", () => {
        const onReconnect = vi.fn();
        const cm = new ConnectivityManager({ onReconnect });
        cm.markSyncing();
        expect(cm.current).toBe("syncing");
        // A request succeeding mid-sync must not cut syncing short or re-fire.
        cm.reportFetchSuccess();
        expect(cm.current).toBe("syncing");
        cm.markSynced();
        expect(cm.current).toBe("online");
        expect(onReconnect).not.toHaveBeenCalled();
    });
});
