/**
 * Space offline caching + send-queue test. Reuses an in-memory SharedSpaceDO
 * stand-in (mirrors tests/spaces/Space.wire.test.ts) and drives the offline
 * adapter over an in-memory OfflineStore so each member is isolated.
 */

import { describe, it, expect } from "vitest";
import { Space, type SpaceChannelLike } from "../../src/spaces/Space";
import { SpaceKeyring, type KeyringTransport } from "../../src/spaces/SpaceKeyring";
import { exportEcdhPublicKey, exportEcdsaPublicKey } from "../../src/spaces/SpaceCipher";
import { KeyStore } from "../../src/crypto/KeyStore";
import { OfflineManager } from "../../src/offline/OfflineManager";
import { SpaceCache } from "../../src/offline/SpaceCache";
import type { OfflineEntry, OfflineStore, QueueEntry } from "../../src/offline/store/OfflineStore";
import type { StoreName } from "../../src/offline/store/schema";
import { compareHlc } from "../../src/offline/clock/HlcTimestamp";
import type { WrappedKey, JoinRequest } from "../../src/spaces/types";

// --- in-memory OfflineStore (per-device isolation) --------------------------
class MemoryOfflineStore implements OfflineStore {
    readonly enabled = true;
    private data = new Map<string, Map<string, unknown>>();
    private queue: QueueEntry[] = [];
    private seq = 0;
    private bucket(s: StoreName) {
        let m = this.data.get(s);
        if (!m) this.data.set(s, (m = new Map()));
        return m;
    }
    async ready() {}
    async get<T>(s: StoreName, k: string) {
        return (this.bucket(s).get(k) as T) ?? null;
    }
    async put<T>(s: StoreName, k: string, v: T) {
        this.bucket(s).set(k, v);
    }
    async delete(s: StoreName, k: string) {
        this.bucket(s).delete(k);
    }
    private sorted<T>(s: StoreName, pred: (k: string) => boolean): Array<OfflineEntry<T>> {
        return [...this.bucket(s).entries()]
            .filter(([k]) => pred(k))
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, value]) => ({ key, value: value as T }));
    }
    async prefix<T>(s: StoreName, p: string) {
        return this.sorted<T>(s, (k) => k.startsWith(p));
    }
    async range<T>(s: StoreName, lo: string, hi: string) {
        return this.sorted<T>(s, (k) => k >= lo && k < hi);
    }
    async all<T>(s: StoreName) {
        return this.sorted<T>(s, () => true);
    }
    async clear(s: StoreName) {
        this.bucket(s).clear();
    }
    async enqueue(e: Omit<QueueEntry, "seq">) {
        const seq = ++this.seq;
        this.queue.push({ ...e, seq });
        return seq;
    }
    async dequeue(seq: number) {
        this.queue = this.queue.filter((q) => q.seq !== seq);
    }
    async queued() {
        return [...this.queue].sort((a, b) => compareHlc(a.hlc, b.hlc));
    }
}

class FakeSpaceServer implements KeyringTransport {
    private channels = new Map<string, FakeChannel>();
    private persisted = new Map<number, string>();
    private blobs = new Map<string, WrappedKey[]>();
    private members = new Map<string, { ecdh: string; ecdsa?: string }>();
    private pending: JoinRequest[] = [];
    private ts = 0;
    channelFor(myId: string): SpaceChannelLike {
        return new FakeChannel(myId, this);
    }
    register(id: string, ch: FakeChannel) {
        this.channels.set(id, ch);
    }
    unregister(id: string) {
        this.channels.delete(id);
    }
    handleFrame(fromId: string, frame: Record<string, unknown>): void {
        if (typeof frame.name === "string") {
            const ch = this.channels.get(fromId);
            for (const raw of this.persisted.values()) ch?.deliver(JSON.parse(raw));
            return;
        }
        if (typeof frame.spaceMessage === "string") {
            const ts = Math.max(++this.ts, Date.now());
            const out = { name: fromId, spaceMessage: frame.spaceMessage, timestamp: ts };
            this.persisted.set(ts, JSON.stringify(out));
            for (const [id, ch] of this.channels) if (id !== fromId) ch.deliver(out);
            return;
        }
    }
    fetch: typeof fetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/history")) {
            return new Response(
                JSON.stringify({ messages: Array.from(this.persisted.values()), nextCursor: null }),
                { status: 200, headers: { "Content-Type": "application/json" } },
            );
        }
        return new Response("{}", { status: 200 });
    }) as typeof fetch;
    async postJoinRequest(req: JoinRequest) {
        this.pending = this.pending.filter((p) => p.memberId !== req.memberId);
        this.pending.push(req);
        this.members.set(req.memberId, { ecdh: req.identityEcdhPub, ecdsa: req.identityEcdsaPub });
        for (const [id, ch] of this.channels) if (id !== req.memberId) ch.deliver({ joinRequest: req });
    }
    async fetchBlobs(memberId: string) {
        return [...(this.blobs.get(memberId) ?? [])];
    }
    async postWrappedKey(target: string, wrapped: WrappedKey) {
        const list = this.blobs.get(target) ?? [];
        list.push(wrapped);
        this.blobs.set(target, list);
        this.channels.get(target)?.deliver({ keyringReady: { epoch: wrapped.epoch, targetMemberId: target } });
    }
    async fetchPending() {
        return [...this.pending];
    }
    async fetchRoster() {
        return Array.from(this.members.entries()).map(([memberId, k]) => ({
            memberId,
            identityEcdhPub: k.ecdh,
            identityEcdsaPub: k.ecdsa,
        }));
    }
    async rotate(n: number) {
        return { epoch: n };
    }
    async invite() {}
    async fetchMetadata() {
        return null;
    }
}

class FakeChannel implements SpaceChannelLike {
    private listeners = new Map<string, Set<(e: CustomEvent) => void>>();
    private connected = false;
    constructor(private myId: string, private server: FakeSpaceServer) {}
    on(e: string, h: (e: CustomEvent) => void) {
        (this.listeners.get(e) ?? this.listeners.set(e, new Set()).get(e)!).add(h);
    }
    off(e: string, h: (e: CustomEvent) => void) {
        this.listeners.get(e)?.delete(h);
    }
    async connect() {
        this.connected = true;
        this.server.register(this.myId, this);
        this.fire("connected", undefined);
    }
    disconnect() {
        this.connected = false;
        this.server.unregister(this.myId);
    }
    isConnected() {
        return this.connected;
    }
    async announce() {}
    async send() {
        return 0;
    }
    sendRaw(frame: unknown) {
        this.server.handleFrame(this.myId, frame as Record<string, unknown>);
    }
    deliver(frame: unknown) {
        this.fire("channel:raw_frame", frame);
    }
    private fire(e: string, detail: unknown) {
        for (const h of this.listeners.get(e) ?? []) h(new CustomEvent(e, { detail }));
    }
}

function manager(): OfflineManager {
    return new OfflineManager({
        store: new MemoryOfflineStore(),
        session: { isAuthenticated: true, isUnlocked: true } as never,
        enabled: true,
    });
}

async function makeSpace(memberId: string, spaceId: string, server: FakeSpaceServer, offline: SpaceCache): Promise<Space> {
    const ks = KeyStore.getInstance();
    if (!ks.getKeyPair(memberId)) await ks.generateOwnKeyPair(memberId);
    const identityEcdhPub = await exportEcdhPublicKey(ks.getKeyPair(memberId)!.publicKey);
    const identityEcdsaPub = await exportEcdsaPublicKey(ks.getAuthKeyPair(memberId)!.publicKey);
    const keyring = new SpaceKeyring({
        spaceId,
        memberId,
        identityEcdhPub,
        identityEcdsaPub,
        ownPrivateKey: () => ks.getKeyPair(memberId)?.privateKey ?? null,
        transport: server,
        historyPolicy: "static",
    });
    return new Space({
        name: spaceId,
        wsBaseUrl: "ws://test",
        httpBaseUrl: "http://test",
        fetch: server.fetch,
        myId: () => memberId,
        fetchTicket: async () => null,
        keyring,
        historyPolicy: "static",
        createChannel: (_url, id) => server.channelFor(id),
        offline,
    });
}

const flush = () => new Promise((r) => setTimeout(r, 0));
async function until(cond: () => boolean, tries = 50) {
    for (let i = 0; i < tries && !cond(); i++) await flush();
}

describe("Space — offline caching + send queue", () => {
    it("caches inbound messages and replays them from cache offline", async () => {
        const server = new FakeSpaceServer();
        const spaceId = "off-cache".padEnd(40, "z");
        const aliceCache = new SpaceCache(manager());
        const bobCache = new SpaceCache(manager());
        const alice = await makeSpace("alice", spaceId, server, aliceCache);
        const bob = await makeSpace("bob", spaceId, server, bobCache);

        await alice.create();
        await bob.connect();
        await bob.keyring!.requestKey();
        await until(() => bob.keyring!.hasAnyKey());

        const live: any[] = [];
        bob.onMessage((e) => live.push(e));
        await alice.sendMessage({ text: "hi" }, { channel: "chat" });
        await until(() => live.length >= 1);

        // Live event carries the sender's clientId (cid header).
        expect(typeof live[0].clientId).toBe("string");
        expect(live[0].clientId.length).toBeGreaterThan(0);

        // Bob's cache holds the message and decodes it without the network.
        const cached = await bob.cachedMessages();
        expect(cached).toHaveLength(1);
        expect(cached[0].message.body).toEqual({ text: "hi" });

        // Alice optimistically cached her own send (pending until echo).
        const aliceCached = await alice.cachedMessages();
        expect(aliceCached).toHaveLength(1);
        expect(aliceCached[0].pending).toBe(true);
        expect(aliceCached[0].message.body).toEqual({ text: "hi" });
    });

    it("queues a send made while disconnected", async () => {
        const server = new FakeSpaceServer();
        const spaceId = "off-queue".padEnd(40, "z");
        const mgr = manager();
        const cache = new SpaceCache(mgr);
        const alice = await makeSpace("alice", spaceId, server, cache);
        // Mint a key but DON'T connect — alice is offline.
        await alice.keyring!.bootstrapNew();

        await alice.sendMessage({ text: "offline note" }, { channel: "chat" });

        // The send is durably queued for replay, and visible optimistically.
        expect(await mgr.queue.pending()).toBe(1);
        const cached = await alice.cachedMessages();
        expect(cached).toHaveLength(1);
        expect(cached[0].pending).toBe(true);
        expect(cached[0].message.body).toEqual({ text: "offline note" });
    });
});
