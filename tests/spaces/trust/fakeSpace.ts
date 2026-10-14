import { Space, type SpaceChannelLike } from "../../../src/spaces/Space";
import { SpaceKeyring, type KeyringTransport } from "../../../src/spaces/SpaceKeyring";
import { exportEcdhPublicKey, exportEcdsaPublicKey } from "../../../src/spaces/SpaceCipher";
import { BroadcastChannelEvents } from "../../../src/sessions/BroadcastChannel";
import { KeyStore } from "../../../src/crypto/KeyStore";
import { memoryTrustStore, type TrustStore } from "../../../src/core/trust/trustStore";
import { logCanWrapTo, type LogSync } from "../../../src/spaces/trust/LogSync";
import { mintKeyCert } from "../../../src/spaces/trust/chatCert";
import type { JoinRequest, RosterMember, WrappedKey } from "../../../src/spaces/types";
import { FakeLogServer } from "./fakeLogServer";
import { signerFor, syncFor, user, type SyncEnv, type TestUser } from "./chainHelper";

export const TRUSTED_SPACE_ID = "sp-trusted";

type Probe = () => Promise<number | "network">;

/** In-memory keyring routes: records every join request and wrap, with an assignable /pending. No authority checks. */
export class MemTransport implements KeyringTransport {
    joinRequests: JoinRequest[] = [];
    wraps: Array<{ target: string; wrapped: WrappedKey; from: string }> = [];
    /** What /keyring/pending answers; a test may assign it (a relay can list anyone). */
    pending: JoinRequest[] = [];
    rotations: number[] = [];
    /** How many times GET /keyring/state was asked. */
    probes = 0;
    private readonly blobs = new Map<string, WrappedKey[]>();

    constructor(private readonly probe?: Probe) {}

    async postJoinRequest(req: JoinRequest): Promise<void> {
        this.joinRequests.push(req);
        this.pending = this.pending.filter((p) => p.memberId !== req.memberId);
        this.pending.push(req);
    }
    async fetchBlobs(memberId: string): Promise<WrappedKey[]> {
        return [...(this.blobs.get(memberId) ?? [])];
    }
    async postWrappedKey(target: string, wrapped: WrappedKey, from: string): Promise<void> {
        this.wraps.push({ target, wrapped, from });
        this.blobs.set(target, [...(this.blobs.get(target) ?? []), wrapped]);
    }
    async fetchPending(): Promise<JoinRequest[]> {
        return [...this.pending];
    }
    /** Everyone who ever posted a join request: the server's roster keeps ex-members too. */
    async fetchRoster(): Promise<RosterMember[]> {
        const byId = new Map<string, RosterMember>();
        for (const r of this.joinRequests) {
            byId.set(r.memberId, { memberId: r.memberId, identityEcdhPub: r.identityEcdhPub, identityEcdsaPub: r.identityEcdsaPub });
        }
        return [...byId.values()];
    }
    async rotate(nextEpoch: number): Promise<{ epoch: number }> {
        this.rotations.push(nextEpoch);
        return { epoch: nextEpoch };
    }
    async invite(): Promise<void> {}
    async fetchMetadata() {
        return null;
    }
    /** GET /keyring/state: the `probe` option, else 404 (the route step I does not build yet). */
    async probeState(): Promise<number | "network"> {
        this.probes++;
        return this.probe ? this.probe() : 404;
    }
}

/** A websocket stand-in: frames and events are injected by the test; nothing goes over a network. */
export class FakeChannel implements SpaceChannelLike {
    resumes = 0;
    disconnected = false;
    readonly sent: unknown[] = [];
    private connected = false;
    private readonly listeners = new Map<string, Set<(e: CustomEvent) => void>>();

    constructor(readonly url: string, readonly myId: string) {}

    on(event: string, handler: (e: CustomEvent) => void): void {
        if (!this.listeners.has(event)) this.listeners.set(event, new Set());
        this.listeners.get(event)!.add(handler);
    }
    off(event: string, handler: (e: CustomEvent) => void): void {
        this.listeners.get(event)?.delete(handler);
    }
    /** Refuses once `disconnect()` has run: like WSTransport, it would dial its spent single-use ticket again. */
    async connect(): Promise<void> {
        if (this.disconnected) throw new Error(`FakeChannel: ${this.url} was already used; open a new channel`);
        this.connected = true;
        this.emit(BroadcastChannelEvents.CONNECTED, undefined);
    }
    /** Records the call; `disconnected` stays true once set. */
    disconnect(): void {
        this.connected = false;
        this.disconnected = true;
    }
    isConnected(): boolean {
        return this.connected;
    }
    async announce(): Promise<void> {}
    async send(): Promise<number> {
        return 0;
    }
    sendRaw(frame: unknown): void {
        this.sent.push(frame);
    }
    resume(): void {
        this.resumes++;
    }
    /** Delivers an inbound frame the way BroadcastChannel does (a RAW_FRAME event). */
    emitFrame(f: unknown): void {
        this.emit(BroadcastChannelEvents.RAW_FRAME, f);
    }
    emit(event: string, detail: unknown): void {
        for (const h of [...(this.listeners.get(event) ?? [])]) h(new CustomEvent(event, { detail }));
    }
}

/** The FakeChannel a Space opened (null before connect). */
export function channelOf(space: Space): FakeChannel {
    return space.raw as FakeChannel;
}

/** A fresh P-384 ECDH public key, exported the way a member's identityEcdhPub is. */
export async function someEcdhPub(): Promise<string> {
    const kp = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-384" }, true, ["deriveBits"])) as CryptoKeyPair;
    return exportEcdhPublicKey(kp.publicKey);
}

export interface TrustedSpaceFixture {
    space: Space;
    /** The LogSync behind `space`. */
    logSync: LogSync;
    server: FakeLogServer;
    transport: MemTransport;
    /** The identity directory every lookup reads (lower-case keys); a test may change an answer. */
    directory: Record<string, string>;
    store: TrustStore;
    env: SyncEnv;
    alice: TestUser;
    bob: TestUser;
    carol: TestUser;
    /** A LogSync for bob, as his own tab would hold it (add him before he appends). */
    bobSync: LogSync;
    /** Another Space on the same log, keyring routes and directory, opened as `name` (a joiner: no visibility). */
    openAs(name: string): Promise<Space>;
    /** How many WebSocket tickets `name`'s Spaces have fetched. */
    ticketsFor(name: string): number;
    /** The LogSync behind any Space this fixture opened. */
    logSyncOf(space: Space): LogSync;
}

/**
 * A real Space with a real SpaceKeyring and LogSync over in-memory routes.
 * alice, bob and carol are in the directory. Every user keeps one IK, one
 * personal KV (their pins) and one vault-backed chat-key pair for the whole
 * fixture, however many Spaces (tabs) they open; the trust store is shared,
 * and its keys are per commitment (`c-<name>`).
 */
export async function makeTrustedSpace(opts: { me: string; visibility: "private" | "public"; probe?: Probe }): Promise<TrustedSpaceFixture> {
    const [alice, bob, carol] = await Promise.all([user("alice"), user("bob"), user("carol")]);
    const users = new Map<string, TestUser>([["alice", alice], ["bob", bob], ["carol", carol]]);
    const server = new FakeLogServer();
    const store = memoryTrustStore();
    const directory: Record<string, string> = { alice: alice.ik, bob: bob.ik, carol: carol.ik };
    const env: SyncEnv = { spaceId: TRUSTED_SPACE_ID, server, store, directory, kvs: new Map() };
    const transport = new MemTransport(opts.probe);
    const tickets = new Map<string, number>();
    const syncs = new Map<Space, LogSync>();
    const ks = KeyStore.getInstance();
    // Chat keys from an earlier fixture in the same file are dropped, so each fixture starts clean.
    for (const n of users.keys()) ks.forget(n);

    const userFor = async (name: string): Promise<TestUser> => {
        let u = users.get(name);
        if (!u) {
            u = await user(name);
            users.set(name, u);
            directory[name.toLowerCase()] = u.ik;
        }
        return u;
    };

    const open = async (u: TestUser, visibility?: "private" | "public"): Promise<{ space: Space; logSync: LogSync }> => {
        if (!ks.isVaultBacked(u.name)) {
            ks.forget(u.name);
            await ks.generateOwnKeyPair(u.name);
            ks.markVaultBacked(u.name);
        }
        const ecdhPub = await exportEcdhPublicKey(ks.getKeyPair(u.name)!.publicKey);
        const ecdsaPub = await exportEcdsaPublicKey(ks.getAuthKeyPair(u.name)!.publicKey);
        const logSync = syncFor(u, env);
        const keyring = new SpaceKeyring({
            spaceId: TRUSTED_SPACE_ID,
            memberId: u.name,
            identityEcdhPub: ecdhPub,
            identityEcdsaPub: ecdsaPub,
            ownPrivateKey: () => ks.getKeyPair(u.name)?.privateKey ?? null,
            transport,
            historyPolicy: "static",
            keyCert: () => mintKeyCert(signerFor(u), u.name, ecdhPub, ecdsaPub),
            canWrapTo: logCanWrapTo(logSync),
        });
        const space = new Space({
            name: TRUSTED_SPACE_ID,
            wsBaseUrl: "ws://test",
            httpBaseUrl: "http://test",
            fetch: (async () => new Response("{}")) as typeof fetch,
            myId: () => u.name,
            fetchTicket: async () => {
                const n = (tickets.get(u.name) ?? 0) + 1;
                tickets.set(u.name, n);
                return `ticket-${u.name}-${n}`;
            },
            keyring,
            historyPolicy: "static",
            createChannel: (url, id) => new FakeChannel(url, id),
            logSync,
            visibility,
            appId: async () => "app1",
            probeState: () => transport.probeState(),
            hasSession: () => true,
        });
        syncs.set(space, logSync);
        return { space, logSync };
    };

    const me = await userFor(opts.me);
    const { space, logSync } = await open(me, opts.visibility);
    return {
        space,
        logSync,
        server,
        transport,
        directory,
        store,
        env,
        alice,
        bob,
        carol,
        bobSync: syncFor(bob, env),
        openAs: async (name) => (await open(await userFor(name))).space,
        ticketsFor: (name) => tickets.get(name) ?? 0,
        logSyncOf: (sp) => syncs.get(sp)!,
    };
}
