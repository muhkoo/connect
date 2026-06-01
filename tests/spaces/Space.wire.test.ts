/**
 * Space integration test (connect side) — exercises the fan-out wire end to
 * end over an in-memory server: a sealed `sendMessage` is broadcast as a
 * `spaceMessage` frame, decoded by another member's `onMessage`, persisted,
 * and replayed via `history()` to a late joiner. No live websocket.
 *
 * in-memory fakes only — runs in the normal unit pass.
 * *.integration.test.ts-excluded — it uses only in-memory fakes, so it runs in
 * the normal unit pass.
 */

import { describe, it, expect } from "vitest";
import { Space, type SpaceChannelLike } from "../../src/spaces/Space";
import { SpaceKeyring, type KeyringTransport } from "../../src/spaces/SpaceKeyring";
import { exportEcdhPublicKey, exportEcdsaPublicKey, canonicalMessage, signSpaceMessage } from "../../src/spaces/SpaceCipher";
import { SpacePacketCipher } from "../../src/spaces/SpacePacketCipher";
import { KeyStore } from "../../src/crypto/KeyStore";
import { Message } from "../../src/messaging/Message";
import { Packet } from "../../src/messaging/Packet";
import type { WrappedKey, JoinRequest } from "../../src/spaces/types";

/**
 * In-memory stand-in for SharedSpaceDO: a websocket hub (channels + persisted
 * `spaceMessage` backlog + history) AND the keyring transport, tied together
 * the way the real DO ties its WS broadcast to its keyring HTTP endpoints.
 */
class FakeSpaceServer implements KeyringTransport {
    private channels = new Map<string, FakeChannel>();
    // ts (storage handle) → serialized {name, spaceMessage, timestamp} frame.
    private persisted = new Map<number, string>();
    private blobs = new Map<string, WrappedKey[]>();
    private members = new Map<string, { ecdh: string; ecdsa?: string }>();
    private pending: JoinRequest[] = [];
    private ts = 0;

    channelFor(myId: string): SpaceChannelLike {
        const ch = new FakeChannel(myId, this);
        return ch;
    }

    // -- websocket side (called by FakeChannel) ------------------------------

    register(myId: string, ch: FakeChannel): void {
        this.channels.set(myId, ch);
    }
    unregister(myId: string): void {
        this.channels.delete(myId);
    }

    handleFrame(fromId: string, frame: Record<string, unknown>): void {
        if (typeof frame.name === "string") {
            // Replay persisted backlog to the joining channel.
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
        if (frame.editSpaceMessage && typeof frame.editSpaceMessage === "object") {
            // Generic in-place edit by storage handle: replace the stored entry
            // (same ts → same position) and notify peers (mirrors SharedSpaceDO).
            const { ts, spaceMessage } = frame.editSpaceMessage as { ts: number; spaceMessage: string };
            if (this.persisted.has(ts)) {
                this.persisted.set(ts, JSON.stringify({ name: fromId, spaceMessage, timestamp: ts }));
                for (const [id, ch] of this.channels) if (id !== fromId) ch.deliver({ editSpaceMessage: { ts, spaceMessage } });
            }
            return;
        }
        if (frame.deleteSpaceMessage && typeof frame.deleteSpaceMessage === "object") {
            // Generic hard delete by storage handle.
            const { ts } = frame.deleteSpaceMessage as { ts: number };
            this.persisted.delete(ts);
            for (const [id, ch] of this.channels) if (id !== fromId) ch.deliver({ deleteSpaceMessage: { ts } });
            return;
        }
        if (frame.pub && typeof frame.pub === "object") {
            // Generic ephemeral relay: stamp the authenticated sender as `name`,
            // rebroadcast the `pub` payload verbatim, never persist (mirrors
            // SharedSpaceDO's `pub` handler).
            const out = { name: fromId, pub: frame.pub };
            for (const [id, ch] of this.channels) if (id !== fromId) ch.deliver(out);
            return;
        }
    }

    /** A header-injecting fetch stand-in serving GET /history. */
    fetch: typeof fetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/history")) {
            return new Response(JSON.stringify({ messages: Array.from(this.persisted.values()), nextCursor: null }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }
        return new Response("{}", { status: 200 });
    }) as typeof fetch;

    // -- keyring transport ---------------------------------------------------

    async postJoinRequest(req: JoinRequest): Promise<void> {
        this.pending = this.pending.filter((p) => p.memberId !== req.memberId);
        this.pending.push(req);
        this.members.set(req.memberId, { ecdh: req.identityEcdhPub, ecdsa: req.identityEcdsaPub });
        for (const [id, ch] of this.channels) if (id !== req.memberId) ch.deliver({ joinRequest: req });
    }
    async fetchBlobs(memberId: string): Promise<WrappedKey[]> {
        return [...(this.blobs.get(memberId) ?? [])];
    }
    async postWrappedKey(targetMemberId: string, wrapped: WrappedKey): Promise<void> {
        const list = this.blobs.get(targetMemberId) ?? [];
        list.push(wrapped);
        this.blobs.set(targetMemberId, list);
        const ch = this.channels.get(targetMemberId);
        ch?.deliver({ keyringReady: { epoch: wrapped.epoch, targetMemberId } });
    }
    async fetchPending(): Promise<JoinRequest[]> {
        return [...this.pending];
    }
    async fetchRoster() {
        return Array.from(this.members.entries()).map(([memberId, k]) => ({
            memberId, identityEcdhPub: k.ecdh, identityEcdsaPub: k.ecdsa,
        }));
    }
    async rotate(nextEpoch: number): Promise<{ epoch: number }> {
        return { epoch: nextEpoch };
    }
    async invite(): Promise<void> {}
    async fetchMetadata() {
        return null;
    }
}

class FakeChannel implements SpaceChannelLike {
    private listeners = new Map<string, Set<(e: CustomEvent) => void>>();
    private connected = false;
    constructor(private myId: string, private server: FakeSpaceServer) {}

    on(event: string, handler: (e: CustomEvent) => void): void {
        if (!this.listeners.has(event)) this.listeners.set(event, new Set());
        this.listeners.get(event)!.add(handler);
    }
    off(event: string, handler: (e: CustomEvent) => void): void {
        this.listeners.get(event)?.delete(handler);
    }
    async connect(): Promise<void> {
        this.connected = true;
        this.server.register(this.myId, this);
        this.fire("connected", undefined);
    }
    disconnect(): void {
        this.connected = false;
        this.server.unregister(this.myId);
    }
    isConnected(): boolean {
        return this.connected;
    }
    async announce(): Promise<void> {}
    async send(): Promise<number> {
        return 0;
    }
    sendRaw(frame: unknown): void {
        this.server.handleFrame(this.myId, frame as Record<string, unknown>);
    }
    /** Server pushes an inbound frame to this channel's consumers. */
    deliver(frame: unknown): void {
        this.fire("channel:raw_frame", frame);
    }
    private fire(event: string, detail: unknown): void {
        for (const h of this.listeners.get(event) ?? []) {
            h(new CustomEvent(event, { detail }));
        }
    }
}

async function makeSpace(
    memberId: string,
    spaceId: string,
    server: FakeSpaceServer,
): Promise<Space> {
    // Real KeyStore identity so sendMessage can sign (ECDSA) and peers can
    // verify via the published ECDSA key.
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
    });
}

const flush = () => new Promise((r) => setTimeout(r, 0));
/** Poll until `cond` holds (lets the async auto-admit chain settle). */
async function until(cond: () => boolean, tries = 50): Promise<void> {
    for (let i = 0; i < tries && !cond(); i++) await flush();
}

describe("Space — fan-out wire end to end", () => {
    it("seals, broadcasts, decodes live, and replays history", async () => {
        const server = new FakeSpaceServer();
        const spaceId = "space-pubkey-xyz".padEnd(40, "z"); // >32 → pubkey-shaped

        const alice = await makeSpace("alice", spaceId, server);
        const bob = await makeSpace("bob", spaceId, server);

        // Alice creates (mints epoch-0 key) and connects.
        await alice.create();

        // Bob connects and requests a key; Alice (online key-holder) auto-admits.
        await bob.connect();
        await bob.keyring!.requestKey();
        await until(() => bob.keyring!.hasAnyKey()); // joinRequest → auto-admit → keyringReady
        expect(bob.keyring!.hasAnyKey()).toBe(true);

        // Live delivery: Alice sends, Bob receives the decrypted Message.
        const received: any[] = [];
        bob.onMessage((e) => received.push(e));
        await alice.sendMessage({ text: "hello space" }, { channel: "chat" });
        await flush();

        expect(received).toHaveLength(1);
        expect(received[0].from).toBe("alice");
        expect(received[0].channel).toBe("chat");
        expect(received[0].message.body).toEqual({ text: "hello space" });

        // History replay: a late joiner with the key reads the persisted message.
        const carol = await makeSpace("carol", spaceId, server);
        await carol.connect();
        await carol.keyring!.requestKey();
        await until(() => carol.keyring!.hasAnyKey());
        expect(carol.keyring!.hasAnyKey()).toBe(true);

        const { messages } = await carol.history();
        expect(messages).toHaveLength(1);
        expect(messages[0].message.body).toEqual({ text: "hello space" });
    });

    it("drops a message whose sender is forged by another member", async () => {
        const server = new FakeSpaceServer();
        const spaceId = "forge".padEnd(40, "z");
        const alice = await makeSpace("alice", spaceId, server);
        const mallory = await makeSpace("mallory", spaceId, server);
        const carol = await makeSpace("carol", spaceId, server);

        await alice.create();                                  // alice registers (ecdsa in dir)
        for (const m of [mallory, carol]) {
            await m.connect();
            await m.keyring!.requestKey();
            await until(() => m.keyring!.hasAnyKey());
        }

        // Mallory holds the group key, so she can seal valid ciphertext — but
        // she signs with HER key while claiming source = "alice".
        const cipher = new SpacePacketCipher(mallory.keyring!);
        const headers = await cipher.seal(new Message({ text: "i am alice" }).serialize());
        const malloryPriv = KeyStore.getInstance().getAuthKeyPair("mallory")!.privateKey!;
        headers.sig = await signSpaceMessage(
            canonicalMessage({
                source: "alice", target: spaceId, subject: "chat",
                epoch: Number(headers.epoch), iv: String(headers.iv), ciphertext: String(headers.ciphertext),
            }),
            malloryPriv,
        );
        const forged = new Packet({ subject: "chat", source: "alice", target: spaceId, headers });

        const received: unknown[] = [];
        carol.onMessage((e) => received.push(e));
        mallory.sendRaw({ spaceMessage: forged.serialize() });
        await flush();
        await flush();

        // Carol drops it: the signature doesn't verify under alice's key.
        expect(received).toHaveLength(0);
    });
});

describe("Space — edit / delete / ephemeral protocol", () => {
    /** Bring alice (key-holder) + bob (admitted member) online and keyed. */
    async function twoMembers(spaceId: string) {
        const server = new FakeSpaceServer();
        const alice = await makeSpace("alice", spaceId, server);
        const bob = await makeSpace("bob", spaceId, server);
        await alice.create();
        await bob.connect();
        await bob.keyring!.requestKey();
        await until(() => bob.keyring!.hasAnyKey());
        return { server, alice, bob };
    }

    it("editMessage replaces the persisted content in place at the same handle", async () => {
        const spaceId = "edit".padEnd(40, "z");
        const { alice, bob } = await twoMembers(spaceId);

        const received: any[] = [];
        const edited: any[] = [];
        bob.onMessage((e) => received.push(e));
        bob.onMessageEdited((e) => edited.push(e));

        await alice.sendMessage("v1", { channel: "chat" });
        await until(() => received.length >= 1);
        const handle = received[0].handle;
        expect(handle).toBeGreaterThan(0);

        await alice.editMessage(handle, "v2", { channel: "chat" });
        await until(() => edited.length >= 1);

        // Edit surfaces on its own event, at the SAME handle, with new content.
        expect(edited[0].handle).toBe(handle);
        expect(edited[0].from).toBe("alice");
        expect(edited[0].message.body).toBe("v2");

        // History reflects the edit in place: one entry, new content, same handle.
        const { messages } = await bob.history();
        expect(messages).toHaveLength(1);
        expect(messages[0].handle).toBe(handle);
        expect(messages[0].message.body).toBe("v2");
    });

    it("deleteMessage hard-removes the persisted entry by handle", async () => {
        const spaceId = "del".padEnd(40, "z");
        const { alice, bob } = await twoMembers(spaceId);

        const received: any[] = [];
        const deleted: any[] = [];
        bob.onMessage((e) => received.push(e));
        bob.onMessageDeleted((e) => deleted.push(e));

        await alice.sendMessage("bye", { channel: "chat" });
        await until(() => received.length >= 1);
        const handle = received[0].handle;

        await alice.deleteMessage(handle);
        await until(() => deleted.length >= 1);

        expect(deleted[0].handle).toBe(handle);

        // Hard delete: gone from history entirely (no tombstone).
        const { messages } = await bob.history();
        expect(messages).toHaveLength(0);
    });

    it("ephemeral signals are delivered live with an authenticated sender, never persisted", async () => {
        const spaceId = "eph".padEnd(40, "z");
        const { alice, bob } = await twoMembers(spaceId);

        const got: any[] = [];
        bob.onEphemeral((e) => got.push(e));

        // Typing is just one app-level use of the generic ephemeral channel.
        alice.sendEphemeral("typing", { isTyping: true });
        await flush();

        expect(got).toHaveLength(1);
        expect(got[0]).toEqual({ from: "alice", subject: "typing", data: { isTyping: true } });

        // Ephemeral → never persisted: bob's history holds nothing.
        const { messages } = await bob.history();
        expect(messages).toHaveLength(0);
    });

    it("sendEphemeral no-ops when the space isn't connected", async () => {
        const spaceId = "noconn".padEnd(40, "z");
        const server = new FakeSpaceServer();
        const alice = await makeSpace("alice", spaceId, server);
        // Never connected → isConnected() is false → no frame leaves.
        expect(() => alice.sendEphemeral("typing", { isTyping: true })).not.toThrow();
    });
});
