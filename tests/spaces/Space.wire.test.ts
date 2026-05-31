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
import { exportEcdhPublicKey } from "../../src/spaces/SpaceCipher";
import type { WrappedKey, JoinRequest } from "../../src/spaces/types";

/**
 * In-memory stand-in for SharedSpaceDO: a websocket hub (channels + persisted
 * `spaceMessage` backlog + history) AND the keyring transport, tied together
 * the way the real DO ties its WS broadcast to its keyring HTTP endpoints.
 */
class FakeSpaceServer implements KeyringTransport {
    private channels = new Map<string, FakeChannel>();
    private persisted: string[] = []; // serialized {spaceMessage,...} frames
    private blobs = new Map<string, WrappedKey[]>();
    private members = new Map<string, string>();
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
            for (const raw of this.persisted) ch?.deliver(JSON.parse(raw));
            return;
        }
        if (typeof frame.spaceMessage === "string") {
            const ts = Math.max(++this.ts, Date.now());
            const out = { name: fromId, spaceMessage: frame.spaceMessage, timestamp: ts };
            this.persisted.push(JSON.stringify(out));
            for (const [id, ch] of this.channels) if (id !== fromId) ch.deliver(out);
            return;
        }
    }

    /** A header-injecting fetch stand-in serving GET /history. */
    fetch: typeof fetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/history")) {
            return new Response(JSON.stringify({ messages: this.persisted, nextCursor: null }), {
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
        this.members.set(req.memberId, req.identityEcdhPub);
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
    async fetchRoster(): Promise<Array<{ memberId: string; identityEcdhPub: string }>> {
        return Array.from(this.members.entries()).map(([memberId, identityEcdhPub]) => ({ memberId, identityEcdhPub }));
    }
    async rotate(nextEpoch: number): Promise<{ epoch: number }> {
        return { epoch: nextEpoch };
    }
    async fetchMetadata() {
        return null;
    }
}

class FakeChannel implements SpaceChannelLike {
    private listeners = new Map<string, Set<(e: CustomEvent) => void>>();
    constructor(private myId: string, private server: FakeSpaceServer) {}

    on(event: string, handler: (e: CustomEvent) => void): void {
        if (!this.listeners.has(event)) this.listeners.set(event, new Set());
        this.listeners.get(event)!.add(handler);
    }
    off(event: string, handler: (e: CustomEvent) => void): void {
        this.listeners.get(event)?.delete(handler);
    }
    async connect(): Promise<void> {
        this.server.register(this.myId, this);
        this.fire("connected", undefined);
    }
    disconnect(): void {
        this.server.unregister(this.myId);
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

async function makeIdentity(): Promise<{ pub: string; priv: CryptoKey }> {
    const kp = (await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-384" },
        true,
        ["deriveBits"],
    )) as CryptoKeyPair;
    return { pub: await exportEcdhPublicKey(kp.publicKey), priv: kp.privateKey };
}

function makeSpace(
    memberId: string,
    spaceId: string,
    server: FakeSpaceServer,
    identity: { pub: string; priv: CryptoKey },
): Space {
    const keyring = new SpaceKeyring({
        spaceId,
        memberId,
        identityEcdhPub: identity.pub,
        ownPrivateKey: () => identity.priv,
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
        const aliceId = await makeIdentity();
        const bobId = await makeIdentity();

        const alice = makeSpace("alice", spaceId, server, aliceId);
        const bob = makeSpace("bob", spaceId, server, bobId);

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
        const carolId = await makeIdentity();
        const carol = makeSpace("carol", spaceId, server, carolId);
        await carol.connect();
        await carol.keyring!.requestKey();
        await until(() => carol.keyring!.hasAnyKey());
        expect(carol.keyring!.hasAnyKey()).toBe(true);

        const { messages } = await carol.history();
        expect(messages).toHaveLength(1);
        expect(messages[0].message.body).toEqual({ text: "hello space" });
    });
});
