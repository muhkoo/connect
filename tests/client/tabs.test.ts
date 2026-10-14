import { describe, it, expect, afterEach, vi } from "vitest";
import { Client } from "../../src/core/Client";
import { MemorySessionStore } from "../../src/core/Session";

const BASE_URL = "http://localhost:8787";

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("Client — the other tabs of the app", () => {
    it("coordinates VFS writes and the offline drain with them in a browser tab with Web Locks", () => {
        vi.spyOn(console, "info").mockImplementation(() => {});
        vi.stubGlobal("window", {});
        vi.stubGlobal("navigator", { locks: { request: async () => undefined } });
        const client = new Client({ baseUrl: BASE_URL, offline: { enabled: false }, sessionStore: new MemorySessionStore() });
        expect((client.vfs as any).deps.coordinator).toBeDefined();
        expect((client.offline.queue as any).opts.tryLock).toBeDefined();
    });

    it("leaves both as they were in Node", () => {
        expect(typeof window).toBe("undefined");
        const client = new Client({ baseUrl: BASE_URL, offline: { enabled: false } });
        expect((client.vfs as any).deps.coordinator).toBeUndefined();
        expect((client.offline.queue as any).opts.tryLock).toBeUndefined();
    });
});
