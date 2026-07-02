/**
 * client.offline.snapshot — encrypted local app-state cache. Verifies an
 * encrypted round-trip, that a locked client can't read it, and list/delete.
 */

import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { OfflineManager } from "../../src/offline/OfflineManager";
import { IndexedDbStore } from "../../src/offline/store/IndexedDbStore";
import { SessionState } from "../../src/core/Session";
import { deriveIdentity } from "../../src/auth/identity";
import { OfflineLockedError } from "../../src/offline/errors";

beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
});

async function unlockedManager() {
    const session = new SessionState();
    await session.setSession({ token: "t".repeat(64), username: "alice", commitment: "12345" });
    session.setIdentity(await deriveIdentity("alice", "correct horse battery staple"));
    const manager = new OfflineManager({ store: new IndexedDbStore(), session, enabled: true });
    await manager.ready();
    return { manager, session };
}

describe("client.offline.snapshot", () => {
    it("round-trips encrypted app state", async () => {
        const { manager } = await unlockedManager();
        await manager.snapshot.save("ui", { route: "/chat", openSpaceId: "s1", draft: "hello" });
        const loaded = await manager.snapshot.load<{ route: string; draft: string }>("ui");
        expect(loaded).toEqual({ route: "/chat", openSpaceId: "s1", draft: "hello" });
    });

    it("stores ciphertext at rest (not plaintext)", async () => {
        const { manager } = await unlockedManager();
        await manager.snapshot.save("ui", { secret: "do not leak" });
        const raw = await manager.store.get<{ envelope: unknown }>("snapshots", "12345|ui");
        expect(JSON.stringify(raw)).not.toContain("do not leak");
    });

    it("returns null and throws appropriately when locked", async () => {
        const { manager, session } = await unlockedManager();
        await manager.snapshot.save("ui", { a: 1 });
        // Simulate a reload: token restored, identity gone (locked).
        await session.clear();
        await session.setSession({ token: "t".repeat(64), username: "alice", commitment: "12345" });
        expect(await manager.snapshot.load("ui")).toBeNull();
        await expect(manager.snapshot.save("ui", { a: 2 })).rejects.toBeInstanceOf(OfflineLockedError);
    });

    it("lists and deletes snapshots", async () => {
        const { manager } = await unlockedManager();
        await manager.snapshot.save("ui", { a: 1 });
        await manager.snapshot.save("draft", { b: 2 });
        expect((await manager.snapshot.list()).sort()).toEqual(["draft", "ui"]);
        await manager.snapshot.delete("draft");
        expect(await manager.snapshot.list()).toEqual(["ui"]);
    });
});
