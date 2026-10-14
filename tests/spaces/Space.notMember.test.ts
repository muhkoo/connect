import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NOT_MEMBER_CLOSE_CODE, NOT_MEMBER_RECHECK_MS, type Space } from "../../src/spaces/Space";
import { BroadcastChannelEvents } from "../../src/sessions/BroadcastChannel";
import { SpaceNamespace } from "../../src/core/namespaces/SpaceNamespace";
import { HttpClient } from "../../src/core/HttpClient";
import { ChatKeyVault, type ChatKeyStore } from "../../src/core/ChatKeyVault";
import { KeyStore } from "../../src/crypto/KeyStore";
import { TrustContext } from "../../src/core/trust/TrustContext";
import { memoryTrustStore } from "../../src/core/trust/trustStore";
import type { WrappedPayload } from "../../src/crypto/PassphraseWrap";
import { channelOf, makeTrustedSpace } from "./trust/fakeSpace";

const NOT_MEMBER = { code: 4403, reason: "not-member" };

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("4403 handling (slice ruling S6)", () => {
    it("the close code and the recheck interval are the design's (§3.6, §6.7)", () => {
        expect(NOT_MEMBER_CLOSE_CODE).toBe(4403);
        expect(NOT_MEMBER_RECHECK_MS).toBe(60_000);
    });
    it("builds the upgrade URL with the ticket and refuse=close", async () => {
        const f = await makeTrustedSpace({ me: "alice", visibility: "public" });
        await f.space.create();
        expect(channelOf(f.space).url).toMatch(/\/websocket\?ticket=[^&]+&refuse=close$/);
    });
    it("4403 + state 403 → not-member, and no resume", async () => {
        const f = await makeTrustedSpace({ me: "alice", visibility: "public", probe: async () => 403 });
        await f.space.create();
        channelOf(f.space).emit(BroadcastChannelEvents.DISCONNECTED, NOT_MEMBER);
        await new Promise((r) => setTimeout(r, 0));
        expect(f.space.admission).toBe("not-member");
        expect(channelOf(f.space).resumes).toBe(0);
    });
    it("4403 + state 401 → locked", async () => {
        const f = await makeTrustedSpace({ me: "alice", visibility: "public", probe: async () => 401 });
        await f.space.create();
        channelOf(f.space).emit(BroadcastChannelEvents.DISCONNECTED, NOT_MEMBER);
        await new Promise((r) => setTimeout(r, 0));
        expect(f.space.admission).toBe("locked");
    });
    it("4403 + state 401 closes the channel for good, with no resume", async () => {
        vi.useFakeTimers();
        const f = await makeTrustedSpace({ me: "alice", visibility: "public", probe: async () => 401 });
        await f.space.create();
        const ch = channelOf(f.space);
        ch.emit(BroadcastChannelEvents.DISCONNECTED, NOT_MEMBER);
        await vi.advanceTimersByTimeAsync(2 * NOT_MEMBER_RECHECK_MS);
        expect(f.space.admission).toBe("locked");
        expect(ch.disconnected).toBe(true);
        expect(ch.resumes).toBe(0);
    });
    it("4403 + state 404 (step I) → one resume; a second 4403 within 60 s waits", async () => {
        vi.useFakeTimers();
        const f = await makeTrustedSpace({ me: "alice", visibility: "public", probe: async () => 404 });
        await f.space.create();
        const ch = channelOf(f.space);
        ch.emit(BroadcastChannelEvents.DISCONNECTED, NOT_MEMBER);
        await vi.advanceTimersByTimeAsync(1);
        expect(ch.resumes).toBe(1);
        ch.emit(BroadcastChannelEvents.DISCONNECTED, NOT_MEMBER);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(ch.resumes).toBe(1);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(ch.resumes).toBe(2);
        vi.useRealTimers();
    });
    it.each([200, 500, 503, "network"] as const)("4403 + state %s → resume (only 403 and 401 are answers, §6.9)", async (status) => {
        vi.useFakeTimers();
        const f = await makeTrustedSpace({ me: "alice", visibility: "public", probe: async () => status });
        await f.space.create();
        channelOf(f.space).emit(BroadcastChannelEvents.DISCONNECTED, NOT_MEMBER);
        await vi.advanceTimersByTimeAsync(1);
        expect(channelOf(f.space).resumes).toBe(1);
        expect(f.space.admission).not.toBe("not-member");
    });
    it("a removed member's tab stops quietly: no ticket, no resume, however long it stays open (Review Focus 2)", async () => {
        vi.useFakeTimers();
        const f = await makeTrustedSpace({ me: "alice", visibility: "public", probe: async () => 403 });
        await f.space.create();
        const ch = channelOf(f.space);
        const tickets = f.ticketsFor("alice");
        ch.emit(BroadcastChannelEvents.DISCONNECTED, NOT_MEMBER);
        await vi.advanceTimersByTimeAsync(10 * NOT_MEMBER_RECHECK_MS);
        expect(f.space.admission).toBe("not-member");
        expect(f.transport.probes).toBe(1);
        expect(ch.resumes).toBe(0);
        expect(ch.disconnected).toBe(true); // the refused channel is closed for good, never redialled
        expect(f.ticketsFor("alice")).toBe(tickets);
    });
    it("a member re-added after a confirmed 4403 reconnects on a new channel and a fresh ticket (§3.7)", async () => {
        const f = await makeTrustedSpace({ me: "alice", visibility: "private", probe: async () => 403 });
        await f.space.create();
        await f.space.add("bob");
        const bob = await f.openAs("bob");
        await bob.connect();
        await f.space.remove("bob");
        const refused = channelOf(bob);
        refused.emit(BroadcastChannelEvents.DISCONNECTED, NOT_MEMBER);
        await vi.waitFor(() => expect(bob.admission).toBe("not-member"));
        const tickets = f.ticketsFor("bob");
        await f.space.add("bob");
        await bob.connect();
        expect(bob.admission).toBe("requesting");
        expect(channelOf(bob)).not.toBe(refused); // the refused socket's ticket was single-use: never redialled
        expect(f.ticketsFor("bob")).toBe(tickets + 1);
        expect(bob.isConnected()).toBe(true);
        expect(refused.resumes).toBe(0);
    });
    it("a close with any other code, or none, asks nothing and resumes nothing", async () => {
        vi.useFakeTimers();
        const f = await makeTrustedSpace({ me: "alice", visibility: "public", probe: async () => 403 });
        await f.space.create();
        const ch = channelOf(f.space);
        ch.emit(BroadcastChannelEvents.DISCONNECTED, { code: 1006, reason: "" });
        ch.emit(BroadcastChannelEvents.DISCONNECTED, undefined);
        await vi.advanceTimersByTimeAsync(2 * NOT_MEMBER_RECHECK_MS);
        expect(f.transport.probes).toBe(0);
        expect(ch.resumes).toBe(0);
        expect(f.space.admission).not.toBe("not-member");
    });
    it("disconnect() cancels a waiting resume", async () => {
        vi.useFakeTimers();
        const f = await makeTrustedSpace({ me: "alice", visibility: "public", probe: async () => 404 });
        await f.space.create();
        const ch = channelOf(f.space);
        ch.emit(BroadcastChannelEvents.DISCONNECTED, NOT_MEMBER);
        await vi.advanceTimersByTimeAsync(1);
        expect(ch.resumes).toBe(1);
        ch.emit(BroadcastChannelEvents.DISCONNECTED, NOT_MEMBER); // waits for the recheck interval
        await vi.advanceTimersByTimeAsync(1);
        f.space.disconnect();
        await vi.advanceTimersByTimeAsync(2 * NOT_MEMBER_RECHECK_MS);
        expect(ch.resumes).toBe(1);
    });
    it("a probe that answers after disconnect() resumes nothing", async () => {
        vi.useFakeTimers();
        let answer!: (s: number) => void;
        const f = await makeTrustedSpace({ me: "alice", visibility: "public", probe: () => new Promise<number>((r) => { answer = r; }) });
        await f.space.create();
        const ch = channelOf(f.space);
        ch.emit(BroadcastChannelEvents.DISCONNECTED, NOT_MEMBER);
        await vi.advanceTimersByTimeAsync(1);
        f.space.disconnect();
        answer(404);
        await vi.advanceTimersByTimeAsync(2 * NOT_MEMBER_RECHECK_MS);
        expect(ch.resumes).toBe(0);
    });
});

/** A WebSocket stand-in for the real BroadcastChannel → WSTransport stack. */
class FakeWebSocket {
    static instances: FakeWebSocket[] = [];
    onopen: ((ev?: unknown) => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onerror: ((ev?: unknown) => void) | null = null;
    onclose: ((ev?: unknown) => void) | null = null;
    closed = false;
    readonly sent: string[] = [];

    constructor(readonly url: string) {
        FakeWebSocket.instances.push(this);
    }
    send(data: string): void {
        this.sent.push(data);
    }
    close(code?: number, reason?: string): void {
        if (this.closed) return;
        this.closed = true;
        this.onclose?.({ code: code ?? 1005, reason: reason ?? "" });
    }
    fireOpen(): void {
        this.onopen?.();
    }
}

const ME = "dora";
const SPACE_ID = "space-refused";

/** client.space over stub HTTP: `/api/ws-ticket` hands out `tickets` in order (then null); `/keyring/state` answers `state`. */
function realStack(opts: { state: number; tickets: Array<string | null>; token: string | null }) {
    const fetched: string[] = [];
    const tickets = [...opts.tickets];
    let ticketPosts = 0;
    let blob: WrappedPayload | null = null;
    const store: ChatKeyStore = { async get() { return blob; }, async put(_k, v) { blob = v; } };
    const http = {
        baseUrl: "http://test",
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
            fetched.push(`${init?.method ?? "GET"} ${String(input)}`);
            if (String(input).endsWith("/keyring/state")) return new Response("Not found", { status: opts.state });
            return new Response("{}");
        }) as typeof fetch,
        get: async () => ({}),
        post: async (path: string) => {
            if (path !== "/api/ws-ticket") return {};
            ticketPosts++;
            return { ticket: tickets.length ? tickets.shift() : null };
        },
        del: async () => ({}),
    };
    const session = { username: ME, seed: new Uint8Array(32).fill(7), commitment: "c-dora", token: opts.token };
    const ns = new SpaceNamespace({
        http: http as never,
        session: session as never,
        wsBaseUrl: "ws://test",
        chatKeys: new ChatKeyVault(store),
    });
    return {
        ns,
        probes: () => fetched.filter((l) => l === `GET http://test/api/spaces/${SPACE_ID}/keyring/state`).length,
        ticketPosts: () => ticketPosts,
    };
}

/**
 * client.space over a real HttpClient whose session token has gone stale: `/keyring/state` answers 401
 * to the stale token and `state` to a fresh one, and a silent re-auth mints the fresh one when `recovers`.
 */
function staleSessionStack(opts: { state: number; recovers: boolean }) {
    const session = { username: ME, seed: new Uint8Array(32).fill(7), commitment: "c-dora", token: "stale" };
    const probedWith: Array<string | null> = [];
    let ticketPosts = 0;
    let blob: WrappedPayload | null = null;
    const store: ChatKeyStore = { async get() { return blob; }, async put(_k, v) { blob = v; } };
    const onUnauthorized = vi.fn(async () => {
        if (opts.recovers) session.token = "fresh";
        return opts.recovers;
    });
    const http = new HttpClient({
        baseUrl: "http://test",
        getSessionToken: () => session.token,
        onUnauthorized,
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (url.endsWith("/keyring/state")) {
                const token = new Headers(init?.headers).get("X-Muhkoo-Session");
                probedWith.push(token);
                return new Response("Not found", { status: token === "fresh" ? opts.state : 401 });
            }
            if (url.endsWith("/api/ws-ticket")) return new Response(JSON.stringify({ ticket: `t${++ticketPosts}` }));
            return new Response("{}");
        }) as typeof fetch,
    });
    const ns = new SpaceNamespace({ http, session: session as never, wsBaseUrl: "ws://test", chatKeys: new ChatKeyVault(store) });
    return { ns, onUnauthorized, probedWith };
}

/**
 * client.space as a Client builds it, with a real HttpClient and a real TrustContext, whose session token has
 * gone stale: every accelerator route answers 401 to the stale token, and a silent re-auth mints a fresh one.
 */
function staleSessionTrustStack() {
    const session = { username: ME, seed: new Uint8Array(32).fill(7), commitment: "c-dora", token: "stale" };
    const logReadsWith: Array<string | null> = [];
    let blob: WrappedPayload | null = null;
    const store: ChatKeyStore = { async get() { return blob; }, async put(_k, v) { blob = v; } };
    const onUnauthorized = vi.fn(async () => {
        session.token = "fresh";
        return true;
    });
    const http = new HttpClient({
        baseUrl: "http://test",
        getSessionToken: () => session.token,
        onUnauthorized,
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const token = new Headers(init?.headers).get("X-Muhkoo-Session");
            if (url.includes("/keyring/log")) logReadsWith.push(token);
            if (token !== "fresh") return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
            if (url.includes("/keyring/log")) return new Response(JSON.stringify({ entries: [], head: null }));
            if (url.endsWith("/api/ws-ticket")) return new Response(JSON.stringify({ ticket: "t1" }));
            return new Response("{}");
        }) as typeof fetch,
    });
    const trust = new TrustContext({ http, session: session as never, openStore: async () => memoryTrustStore() });
    const ns = new SpaceNamespace({ http, session: session as never, wsBaseUrl: "ws://test", chatKeys: new ChatKeyVault(store), trust });
    return { ns, onUnauthorized, logReadsWith };
}

/** Open `space` over a FakeWebSocket (fake timers must be on). */
async function openSocket(space: Space): Promise<FakeWebSocket> {
    const p = space.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    FakeWebSocket.instances[0]!.fireOpen();
    await p;
    return FakeWebSocket.instances[0]!;
}

describe("4403 through the real channel stack (client.space → BroadcastChannel → WSTransport)", () => {
    let opened: Space | null = null;

    beforeEach(() => {
        KeyStore.getInstance().forget(ME);
        FakeWebSocket.instances = [];
        vi.stubGlobal("WebSocket", FakeWebSocket);
    });
    afterEach(() => {
        opened?.disconnect();
        opened = null;
    });

    it("a 4403 whose /keyring/state answers 403 is not-member: the socket stays down and no ticket is fetched", async () => {
        const s = realStack({ state: 403, tickets: ["t1", "t2", "t3"], token: "tok" });
        const space = (opened = await s.ns.get(SPACE_ID));
        vi.useFakeTimers();
        const sock = await openSocket(space);
        expect(sock.url).toBe(`ws://test/api/spaces/${SPACE_ID}/websocket?ticket=t1&refuse=close`);
        sock.close(4403, "not-member");
        await vi.waitFor(() => expect(space.admission).toBe("not-member"));
        await vi.advanceTimersByTimeAsync(10 * NOT_MEMBER_RECHECK_MS);
        expect(s.probes()).toBe(1);
        expect(FakeWebSocket.instances).toHaveLength(1);
        expect(s.ticketPosts()).toBe(1);
        expect(space.isConnected()).toBe(false);
    });

    it("a 4403 whose /keyring/state allows resumes on a fresh ticket, at most once per recheck interval", async () => {
        const s = realStack({ state: 404, tickets: ["t1", "t2", "t3"], token: "tok" });
        const space = (opened = await s.ns.get(SPACE_ID));
        vi.useFakeTimers();
        const sock = await openSocket(space);
        sock.close(4403, "not-member");
        await vi.advanceTimersByTimeAsync(3_100); // the resume runs at once, then the transport's default reconnect delay
        expect(FakeWebSocket.instances).toHaveLength(2);
        expect(s.probes()).toBe(1);
        expect(FakeWebSocket.instances[1]!.url).toBe(`ws://test/api/spaces/${SPACE_ID}/websocket?ticket=t2&refuse=close`);
        expect(space.admission).toBe("requesting");
        // Refused again: the transport stays down until the recheck interval since the last resume has passed.
        FakeWebSocket.instances[1]!.fireOpen();
        FakeWebSocket.instances[1]!.close(4403, "not-member");
        await vi.advanceTimersByTimeAsync(30_000);
        expect(FakeWebSocket.instances).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(FakeWebSocket.instances).toHaveLength(3);
        expect(FakeWebSocket.instances[2]!.url).toBe(`ws://test/api/spaces/${SPACE_ID}/websocket?ticket=t3&refuse=close`);
        expect(s.probes()).toBe(2);
    });

    it("a 1006 drop still reconnects, and with a live session never without a ticket", async () => {
        const s = realStack({ state: 403, tickets: ["t1", null, null, "t4"], token: "tok" });
        const space = (opened = await s.ns.get(SPACE_ID));
        vi.useFakeTimers();
        const sock = await openSocket(space);
        sock.close(1006);
        await vi.advanceTimersByTimeAsync(3_100); // the transport's default reconnect delay: no ticket yet
        await vi.advanceTimersByTimeAsync(3_000); // still none
        expect(FakeWebSocket.instances).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(3_000);
        expect(FakeWebSocket.instances).toHaveLength(2);
        expect(FakeWebSocket.instances[1]!.url).toBe(`ws://test/api/spaces/${SPACE_ID}/websocket?ticket=t4&refuse=close`);
        expect(s.probes()).toBe(0);
    });

    it("without a session token a reconnect may still go ticketless, as before", async () => {
        const s = realStack({ state: 403, tickets: ["t1"], token: null });
        const space = (opened = await s.ns.get(SPACE_ID));
        vi.useFakeTimers();
        const sock = await openSocket(space);
        sock.close(1006);
        await vi.advanceTimersByTimeAsync(3_100);
        expect(FakeWebSocket.instances).toHaveLength(2);
        expect(FakeWebSocket.instances[1]!.url).toBe(`ws://test/api/spaces/${SPACE_ID}/websocket?refuse=close`);
    });

    it("a 4403 whose /keyring/state answers 401 re-authenticates silently first, then resumes on a fresh ticket (§6.9)", async () => {
        const s = staleSessionStack({ state: 404, recovers: true });
        const space = (opened = await s.ns.get(SPACE_ID));
        vi.useFakeTimers();
        const sock = await openSocket(space);
        sock.close(4403, "not-member");
        await vi.advanceTimersByTimeAsync(3_100); // the resume runs at once, then the transport's default reconnect delay
        expect(s.onUnauthorized).toHaveBeenCalledTimes(1);
        expect(s.probedWith).toEqual(["stale", "fresh"]);
        expect(space.admission).toBe("requesting");
        expect(FakeWebSocket.instances).toHaveLength(2);
        expect(FakeWebSocket.instances[1]!.url).toBe(`ws://test/api/spaces/${SPACE_ID}/websocket?ticket=t2&refuse=close`);
    });

    it("a 4403 whose /keyring/state answers 403 once re-authenticated is not-member", async () => {
        const s = staleSessionStack({ state: 403, recovers: true });
        const space = (opened = await s.ns.get(SPACE_ID));
        vi.useFakeTimers();
        const sock = await openSocket(space);
        sock.close(4403, "not-member");
        await vi.waitFor(() => expect(space.admission).toBe("not-member"));
        await vi.advanceTimersByTimeAsync(2 * NOT_MEMBER_RECHECK_MS);
        expect(s.probedWith).toEqual(["stale", "fresh"]);
        expect(FakeWebSocket.instances).toHaveLength(1);
    });

    it("a 4403 whose /keyring/state answers 401 and whose re-auth fails is locked, and stays down", async () => {
        const s = staleSessionStack({ state: 404, recovers: false });
        const space = (opened = await s.ns.get(SPACE_ID));
        vi.useFakeTimers();
        const sock = await openSocket(space);
        sock.close(4403, "not-member");
        await vi.waitFor(() => expect(space.admission).toBe("locked"));
        await vi.advanceTimersByTimeAsync(2 * NOT_MEMBER_RECHECK_MS);
        expect(s.onUnauthorized).toHaveBeenCalledTimes(1);
        expect(s.probedWith).toEqual(["stale"]);
        expect(FakeWebSocket.instances).toHaveLength(1);
    });
});

describe("a stale session token on a public Space, with trust wired as the Client does (slice ruling S9)", () => {
    let opened: Space | null = null;

    beforeEach(() => {
        KeyStore.getInstance().forget(ME);
        FakeWebSocket.instances = [];
        vi.stubGlobal("WebSocket", FakeWebSocket);
    });
    afterEach(() => {
        opened?.disconnect();
        opened = null;
    });

    it("the membership-log read re-authenticates silently, and the Space connects instead of turning locked (§6.9)", async () => {
        const s = staleSessionTrustStack();
        const space = (opened = await s.ns.get(SPACE_ID));
        const connecting = space.connect().catch((e: unknown) => e);
        await vi.waitFor(() => expect(FakeWebSocket.instances.length > 0 || space.admission === "locked").toBe(true));
        expect(space.admission).not.toBe("locked");
        expect(s.onUnauthorized).toHaveBeenCalledTimes(1);
        expect(s.logReadsWith).toEqual(["stale", "fresh"]);
        expect(FakeWebSocket.instances).toHaveLength(1);
        expect(FakeWebSocket.instances[0]!.url).toBe(`ws://test/api/spaces/${SPACE_ID}/websocket?ticket=t1&refuse=close`);
        FakeWebSocket.instances[0]!.fireOpen();
        expect(await connecting).toBeUndefined();
        expect(space.logEnabled).toBe(false);
    });
});
