import { describe, it, expect, afterEach, vi } from "vitest";
import { log } from "../../src/utilities";
import type { SpaceMessageEvent } from "../../src/spaces/Space";
import { user } from "./trust/chainHelper";
import { channelOf, makeTrustedSpace, TRUSTED_SPACE_ID, type TrustedSpaceFixture } from "./trust/fakeSpace";

afterEach(() => vi.useRealTimers());

describe("admission on a signed private Space (design §3.4, §3.7, §4.5.12; slice ruling S9)", () => {
    it("a user the log does not list is not-member; connect rejects before any ticket", async () => {
        const f = await makeTrustedSpace({ me: "alice", visibility: "private" });
        await f.space.create();
        const carolSpace = await f.openAs("carol"); // same server, carol not added
        await expect(carolSpace.connect()).rejects.toMatchObject({ name: "AdmissionDeniedError", code: "not-member" });
        expect(carolSpace.admission).toBe("not-member");
        expect(f.ticketsFor("carol")).toBe(0);
    });
    it("GET /keyring/log answering 403 is not-member", async () => {
        const f = await makeTrustedSpace({ me: "alice", visibility: "private" });
        await f.space.create();
        const bob = await f.openAs("bob");
        f.server.status = 403;
        await expect(bob.connect()).rejects.toMatchObject({ code: "not-member" });
    });
    it("an add naming a different IK for me is identity-mismatch", async () => {
        const f = await makeTrustedSpace({ me: "alice", visibility: "private" });
        await f.space.create();
        f.directory.bob = (await user("impostor")).ik; // the owner was given the wrong key
        await f.space.add("bob");
        const bob = await f.openAs("bob");
        await expect(bob.connect()).rejects.toMatchObject({ code: "identity-mismatch" });
    });
    it("a member connects, requests with a certificate and turns keyed", async () => {
        const f = await makeTrustedSpace({ me: "alice", visibility: "private" });
        await f.space.create();
        await f.space.add("bob");
        const bob = await f.openAs("bob");
        await bob.connect();
        expect(bob.admission).toBe("requesting");
        await bob.keyring!.requestKey();
        expect(f.transport.joinRequests.at(-1)!.keyCert).toBeDefined();
    });
    it("integrity pauses sending but not reading", async () => {
        const f = await makeTrustedSpace({ me: "alice", visibility: "private" });
        await f.space.create();
        await f.space.add("bob");
        await f.server.truncate(0); // server rolls the log back below alice's high-water mark
        const again = await f.openAs("alice");
        await again.connect();
        expect(again.admission).toBe("integrity");
        await expect(again.sendMessage("hi")).rejects.toMatchObject({ code: "integrity" });
    });
    it("being removed while connected turns not-member and drops the socket", async () => {
        vi.useFakeTimers();
        const f = await makeTrustedSpace({ me: "alice", visibility: "private" });
        await f.space.create();
        await f.space.add("bob");
        const bob = await f.openAs("bob");
        await bob.connect();
        await f.space.remove("bob");
        channelOf(bob).emitFrame({ mlog: { seq: 2, hash: f.server.head!.hash } });
        await vi.advanceTimersByTimeAsync(1000);
        await vi.waitFor(() => expect(bob.admission).toBe("not-member"));
        expect(channelOf(bob).disconnected).toBe(true);
        vi.useRealTimers();
    });
});

describe("admission edges (design §3.3, §3.7, §4.5.12)", () => {
    it("a Space in integrity keeps its socket and still decodes what arrives", async () => {
        const f = await makeTrustedSpace({ me: "alice", visibility: "private" });
        await f.space.create();
        await f.space.add("bob");
        await f.server.truncate(0);
        const again = await f.openAs("alice");
        await again.connect();
        expect(again.admission).toBe("integrity");
        expect(again.isConnected()).toBe(true);
        // The first tab (not yet re-synced) wraps the key to alice's chat key and sends; the second tab reads it.
        const alicePub = f.transport.joinRequests.find((r) => r.memberId === "alice")!.identityEcdhPub;
        await f.space.admit("alice", alicePub);
        expect(await again.keyring!.pullKeys()).toBeGreaterThan(0);
        await f.space.sendMessage("still readable");
        const frame = channelOf(f.space).sent.at(-1) as { spaceMessage: string };
        const seen: SpaceMessageEvent[] = [];
        again.onMessage((e) => seen.push(e));
        channelOf(again).emitFrame({ spaceMessage: frame.spaceMessage, timestamp: 5 });
        await vi.waitFor(() => expect(seen).toHaveLength(1));
        expect(seen[0]).toMatchObject({ from: "alice", handle: 5, epoch: 0 });
        await expect(again.editMessage(5, "edited")).rejects.toMatchObject({ code: "integrity" });
    });
    it("a log that went missing, where this client holds a mark, is integrity too", async () => {
        const f = await makeTrustedSpace({ me: "alice", visibility: "private" });
        await f.space.create();
        await f.server.truncate(-1); // the relay answers as if the Space never had a log
        const again = await f.openAs("alice");
        await again.connect();
        expect(again.logEnabled).toBe(false);
        expect(again.admission).toBe("integrity");
        await expect(again.sendMessage("hi")).rejects.toMatchObject({ code: "integrity" });
    });
    it("GET /keyring/log answering 401 is locked, before any ticket", async () => {
        const f = await makeTrustedSpace({ me: "alice", visibility: "private" });
        await f.space.create();
        await f.space.add("bob");
        const bob = await f.openAs("bob");
        f.server.status = 401;
        await expect(bob.connect()).rejects.toMatchObject({ name: "IdentityLockedError" });
        expect(bob.admission).toBe("locked");
        expect(f.ticketsFor("bob")).toBe(0);
    });
    it("identity-mismatch and a 403 open no socket either", async () => {
        const f = await makeTrustedSpace({ me: "alice", visibility: "private" });
        await f.space.create();
        f.directory.bob = (await user("impostor")).ik;
        await f.space.add("bob");
        const bob = await f.openAs("bob");
        await expect(bob.connect()).rejects.toMatchObject({ name: "AdmissionDeniedError", code: "identity-mismatch" });
        expect(bob.admission).toBe("identity-mismatch");
        expect(bob.raw).toBeNull();
        const carol = await f.openAs("carol");
        f.server.status = 403;
        await expect(carol.connect()).rejects.toMatchObject({ name: "AdmissionDeniedError", code: "not-member" });
        expect(carol.admission).toBe("not-member");
        expect(carol.raw).toBeNull();
        expect(f.ticketsFor("bob") + f.ticketsFor("carol")).toBe(0);
    });
    it.each<[string, (f: TrustedSpaceFixture) => void]>([
        ["a 500", (f) => { f.server.status = 500; }],
        ["a network error", (f) => { f.server.fetchLog = async () => { throw new TypeError("Failed to fetch"); }; }],
    ])("%s from GET /keyring/log on a first open (no mark held) opens the Space unlogged, with a warning", async (_label, fail) => {
        const f = await makeTrustedSpace({ me: "alice", visibility: "private" });
        await f.space.create();
        await f.space.add("bob");
        const bob = await f.openAs("bob");
        fail(f);
        const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
        try {
            await bob.connect();
            expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ spaceId: TRUSTED_SPACE_ID }));
        } finally {
            warn.mockRestore();
        }
        expect(bob.logEnabled).toBe(false);
        expect(bob.admission).toBe("requesting");
        expect(f.ticketsFor("bob")).toBe(1);
    });
    it("the same failure rejects where this client holds a mark for the Space, before any ticket", async () => {
        const f = await makeTrustedSpace({ me: "alice", visibility: "private" });
        await f.space.create(); // alice's sync records the mark
        const ticketsBefore = f.ticketsFor("alice");
        const again = await f.openAs("alice");
        f.server.status = 500;
        await expect(again.connect()).rejects.toMatchObject({ name: "KeyringHttpError", status: 500 });
        expect(again.raw).toBeNull();
        expect(f.ticketsFor("alice")).toBe(ticketsBefore);
    });
    it("a trust store that cannot be read fails the open: a mark may be held", async () => {
        const f = await makeTrustedSpace({ me: "alice", visibility: "private" });
        await f.space.create();
        await f.space.add("bob");
        const bob = await f.openAs("bob");
        f.store.get = async () => { throw new Error("muhkoo.trust unreadable"); };
        await expect(bob.connect()).rejects.toThrow("muhkoo.trust unreadable");
        expect(f.ticketsFor("bob")).toBe(0);
    });
    it("after being dropped, connect() checks the log again: still removed is refused; re-added opens a new socket on a fresh ticket", async () => {
        vi.useFakeTimers();
        const f = await makeTrustedSpace({ me: "alice", visibility: "private" });
        await f.space.create();
        await f.space.add("bob");
        const bob = await f.openAs("bob");
        await bob.connect();
        const heard: unknown[] = [];
        bob.on("app-event", (e) => heard.push(e.detail)); // a raw listener added while connected
        await f.space.remove("bob");
        const dropped = channelOf(bob);
        dropped.emitFrame({ mlog: { seq: 2, hash: f.server.head!.hash } });
        await vi.advanceTimersByTimeAsync(1000);
        await vi.waitFor(() => expect(bob.admission).toBe("not-member"));
        vi.useRealTimers();
        const tickets = f.ticketsFor("bob");
        await expect(bob.connect()).rejects.toMatchObject({ name: "AdmissionDeniedError", code: "not-member" });
        expect(bob.isConnected()).toBe(false);
        expect(f.ticketsFor("bob")).toBe(tickets); // a refusal fetches no ticket
        await f.space.add("bob");
        await bob.connect();
        expect(bob.admission).toBe("requesting");
        expect(bob.isConnected()).toBe(true);
        // The dropped socket's ticket was single-use: the reconnect mints a fresh one on a new channel.
        expect(f.ticketsFor("bob")).toBe(tickets + 1);
        expect(channelOf(bob)).not.toBe(dropped);
        expect(channelOf(bob).url).toContain(`ticket=ticket-bob-${tickets + 1}`);
        expect(dropped.isConnected()).toBe(false);
        // The new channel is wired as the first was: the handshake, the fan-out frames and the app's raw listeners.
        expect(channelOf(bob).sent).toContainEqual({ name: "bob" });
        channelOf(bob).emit("app-event", 1);
        dropped.emit("app-event", 2);
        expect(heard).toEqual([1]);
        // A second removal drops the new socket as well.
        vi.useFakeTimers();
        await f.space.remove("bob");
        channelOf(bob).emitFrame({ mlog: { seq: 4, hash: f.server.head!.hash } });
        await vi.advanceTimersByTimeAsync(1000);
        await vi.waitFor(() => expect(bob.admission).toBe("not-member"));
        expect(channelOf(bob).disconnected).toBe(true);
    });
});
