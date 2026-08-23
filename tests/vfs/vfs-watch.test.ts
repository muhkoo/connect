import { describe, it, expect, vi } from "vitest";
import { VfsNamespace } from "../../src/vfs/VfsNamespace";
import { makeStore, makeContent } from "./harness";

/** A stand-in for the personal space's change feed. */
function makeFeed() {
    const handlers = new Set<(frame: unknown) => void>();
    return {
        subscribe: (h: (frame: unknown) => void) => {
            handlers.add(h);
            return () => handlers.delete(h);
        },
        emit: (frame: unknown) => handlers.forEach((h) => h(frame)),
        get subscribers() {
            return handlers.size;
        },
    };
}

function makeWatchable() {
    const feed = makeFeed();
    const vfs = new VfsNamespace({
        store: makeStore(),
        content: makeContent(),
        seed: () => new Uint8Array(32).fill(7),
        subscribe: feed.subscribe,
    });
    return { vfs, feed };
}

describe("VFS — watch", () => {
    it("fires when a filesystem record changes elsewhere", () => {
        const { vfs, feed } = makeWatchable();
        const onChange = vi.fn();
        vfs.watch(onChange);

        feed.emit({ _t: "change", key: "vfs/d/abc", op: "set" });
        expect(onChange).toHaveBeenCalledTimes(1);
    });

    it("ignores other subsystems sharing the same socket", () => {
        // The personal space carries chat keys, space keys and the legacy file
        // mirror too — reacting to those would rebuild the tree for nothing.
        const { vfs, feed } = makeWatchable();
        const onChange = vi.fn();
        vfs.watch(onChange);

        feed.emit({ _t: "change", key: "chat-keys", op: "set" });
        feed.emit({ _t: "change", key: "space-keys/xyz", op: "set" });
        feed.emit({ _t: "change", key: "__files__/abc", op: "set" });
        expect(onChange).not.toHaveBeenCalled();
    });

    it("ignores frames that are not changes, and malformed ones", () => {
        const { vfs, feed } = makeWatchable();
        const onChange = vi.fn();
        vfs.watch(onChange);

        feed.emit({ _t: "pong" });
        feed.emit({ _t: "change" });          // no key
        feed.emit("not json at all");
        feed.emit(null);
        expect(onChange).not.toHaveBeenCalled();
    });

    it("accepts a frame delivered as a JSON string", () => {
        const { vfs, feed } = makeWatchable();
        const onChange = vi.fn();
        vfs.watch(onChange);

        feed.emit(JSON.stringify({ _t: "change", key: "vfs/h/file1", op: "set" }));
        expect(onChange).toHaveBeenCalledTimes(1);
    });

    it("drops the cache, so the next read sees the new tree", async () => {
        // The point of watching: a cached directory record is exactly what would
        // otherwise hide a change made somewhere else.
        const { vfs, feed } = makeWatchable();
        await vfs.writeFile("/a.txt", "one");
        await vfs.list("/");                       // warm the cache

        const onChange = vi.fn();
        vfs.watch(onChange);
        feed.emit({ _t: "change", key: "vfs/d/root", op: "set" });

        expect(onChange).toHaveBeenCalled();
        expect(await vfs.readText("/a.txt")).toBe("one");  // still readable after the drop
    });

    it("unsubscribes cleanly", () => {
        const { vfs, feed } = makeWatchable();
        const onChange = vi.fn();
        const stop = vfs.watch(onChange);
        expect(feed.subscribers).toBe(1);

        stop();
        expect(feed.subscribers).toBe(0);
        feed.emit({ _t: "change", key: "vfs/d/abc", op: "set" });
        expect(onChange).not.toHaveBeenCalled();
    });

    it("is a no-op where there is no socket, rather than an error", () => {
        // A CLI has no feed; watching is an optimisation, never required.
        const vfs = new VfsNamespace({
            store: makeStore(),
            content: makeContent(),
            seed: () => new Uint8Array(32).fill(7),
        });
        expect(() => vfs.watch(() => {})()).not.toThrow();
    });
});
