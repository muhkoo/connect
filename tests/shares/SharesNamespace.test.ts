/**
 * `client.shares` against an in-memory accelerator that applies the server contract as built
 * (accelerator `docs/superpowers/plans/2026-11-06-shared-folders-server-contract.md`):
 *
 * - a share Space is created like a public Space (no membership-log genesis), `/metadata` first, the keeper seeded,
 *   then `POST /api/shares` (409 `share_space_not_ready` without metadata);
 * - guests are ordinary accounts: `GET /public` for the salt, then a signed-in `POST /admit { proof, name }`;
 * - rotation is `POST /api/shares/:new/adopt { from, password?, remove? }`; with a new password only the owner is
 *   carried.
 *
 * The share Space's keyring is a real `SpaceKeyring` over `MemTransport`, so the keeper seed is a real wrap.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { HttpClient } from "../../src/core/HttpClient";
import { AuthHttpError } from "../../src/auth/AuthClient";
import { DeviceRevokedError } from "../../src/core/namespaces/AuthNamespace";
import { SpaceKeyring, KEEPER_MEMBER_ID } from "../../src/spaces/SpaceKeyring";
import {
    SharesNamespace,
    memorySharesStore,
    guestRecoveryCode,
    guestRecoveryOf,
    parseGuestRecoveryCode,
    type GuestDeviceLogin,
    type SharesLocalStore,
    type ShareGuestAuth,
    type ShareSpaceHandle,
} from "../../src/core/namespaces/SharesNamespace";
import {
    GuestLoginConflictError,
    InvalidRecoveryCodeError,
    RotationIncompleteError,
    ShareClosedError,
    SharePasswordError,
    type PasswordVerifier,
    type ShareKind,
} from "../../src/shares";
import { Share } from "../../src/shares/Share";
import { MemTransport, someEcdhPub } from "../spaces/trust/fakeSpace";
import { realSpaceId, SERVER_SHARE_SPACE_ID } from "./fakeShareServer";

const BASE = "http://fake.test";
const PHRASE = "abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire across act action actor actress actual";

interface Call {
    method: string;
    path: string;
    body: unknown;
    session: string | null;
}

interface FakeShare {
    kind: ShareKind;
    name: string;
    ownerUsername: string;
    limitBytes: number | null;
    editPolicy: "own" | "any";
    password?: PasswordVerifier;
    closed: { successor: string; at: number } | null;
    members: Set<string>;
    names: Record<string, string>;
    /** File ids in the share (what an adopt copies, page by page). */
    files: string[];
    adoptedFrom?: string;
    /** The rotation settings fixed at the claim (verifier + sorted removal list). */
    settings?: string;
}

function b64ToBytes(s: string): Uint8Array {
    const bin = atob(s);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function sha256b64(bytes: Uint8Array): Promise<string> {
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
    return btoa(String.fromCharCode(...d));
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** The accelerator's `/api/shares` + the keyring routes the namespace touches. */
class FakeServer {
    readonly calls: Call[] = [];
    readonly metadata = new Set<string>();
    readonly shares = new Map<string, FakeShare>();
    readonly links = new Map<string, string>(); // token → spaceId
    keeperPub: string | null = null;
    /**
     * Make the next `times` adopt calls fail after copying `afterFiles` files in that call: a 503, or (network) a
     * dropped connection. What was copied stays copied, as on the server.
     */
    failAdopt: { times: number; afterFiles: number; network?: boolean } | null = null;
    /** The next `failInfo` calls of `GET /api/shares/:id` answer 503. */
    failInfo = 0;

    readonly fetch: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        const headers = new Headers(init?.headers);
        const session = headers.get("X-Muhkoo-Session");
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        this.calls.push({ method, path: url.pathname, body, session });
        return this.route(method, url.pathname, body, session);
    };

    log(): string[] {
        return this.calls.map((c) => `${c.method} ${c.path}`);
    }

    private async route(method: string, path: string, body: any, session: string | null): Promise<Response> {
        let m: RegExpMatchArray | null;
        if ((m = path.match(/^\/api\/spaces\/([^/]+)\/metadata$/)) && method === "POST") {
            if (this.shares.has(m[1])) return json({ error: "Space is a share" }, 409);
            this.metadata.add(m[1]);
            return json({ ok: true });
        }
        if (path === "/api/app/keeper") return this.keeperPub ? json({ pubkey: this.keeperPub }) : json({ error: "no keeper" }, 404);
        if (path === "/api/shares" && method === "POST") {
            if (!session) return json({ code: "session_required" }, 401);
            if (!SERVER_SHARE_SPACE_ID.test(body.spaceId)) return json({ error: "spaceId must be 1-300 letters, digits, '-' or '_'" }, 400);
            if (!this.metadata.has(body.spaceId)) return json({ code: "share_space_not_ready", error: "not ready" }, 409);
            if (this.shares.has(body.spaceId)) return json({ error: "already a share" }, 409);
            this.shares.set(body.spaceId, {
                kind: body.kind, name: body.name, ownerUsername: session, limitBytes: body.limitBytes,
                editPolicy: body.editPolicy, password: body.password, closed: null, members: new Set(), names: {}, files: [],
            });
            return json(this.info(body.spaceId), 201);
        }
        if (path === "/api/shares" && method === "GET") {
            const rows = [...this.shares.entries()]
                .filter(([, s]) => !s.closed && (s.ownerUsername === session || s.members.has(session ?? "")))
                .map(([spaceId, s]) => ({ spaceId, kind: s.kind, owner: s.ownerUsername, name: s.name }));
            return json({ shares: rows });
        }
        if ((m = path.match(/^\/api\/shares\/([^/]+)\/public$/))) {
            const s = this.shares.get(m[1]);
            if (!s || s.kind !== "public") return json({ error: "Not found" }, 404);
            return json({
                kind: "public", name: s.name, ownerUsername: s.ownerUsername,
                password: { salt: s.password!.salt, iterations: s.password!.iterations }, closed: s.closed,
            });
        }
        if ((m = path.match(/^\/api\/shares\/([^/]+)\/admit$/)) && method === "POST") {
            if (!session) return json({ code: "session_required" }, 401);
            const s = this.shares.get(m[1]);
            if (!s || s.kind !== "public") return json({ error: "Not found" }, 404);
            if ((await sha256b64(b64ToBytes(body.proof))) !== s.password!.verifier) {
                return json({ code: "share_password", error: "Wrong password" }, 403);
            }
            if (s.closed) return json({ code: "share_closed", successor: s.closed.successor }, 409);
            if (session !== s.ownerUsername) s.members.add(session);
            s.names[session] = body.name;
            return json({ ok: true });
        }
        if ((m = path.match(/^\/api\/shares\/([^/]+)\/adopt$/)) && method === "POST") {
            const fresh = m[1];
            if (!SERVER_SHARE_SPACE_ID.test(fresh)) return json({ error: "Invalid space ID" }, 404);
            if (!SERVER_SHARE_SPACE_ID.test(body.from)) return json({ error: "from must be 1-300 letters, digits, '-' or '_'" }, 400);
            const old = this.shares.get(body.from);
            if (!old || old.ownerUsername !== session) return json({ error: "Not the owner" }, 403);
            if (!this.metadata.has(fresh)) return json({ code: "share_space_not_ready" }, 409);
            const settings = JSON.stringify({ p: body.password ?? null, r: [...(body.remove ?? [])].sort() });
            let rec = this.shares.get(fresh);
            if (!rec) {
                // The claim: closes the old share at once, before any file is copied.
                if (old.closed) return json({ code: "rotation_in_progress", successor: old.closed.successor }, 409);
                const remove = new Set<string>(body.remove ?? []);
                const members = body.password ? new Set<string>() : new Set([...old.members].filter((u) => !remove.has(u)));
                rec = {
                    ...old, password: body.password ?? old.password, closed: null, members, names: { ...old.names }, files: [],
                    adoptedFrom: body.from, settings,
                };
                this.shares.set(fresh, rec);
                old.closed = { successor: fresh, at: 1 };
            } else if (rec.adoptedFrom !== body.from || rec.settings !== settings) {
                return json({ code: "rotation_mismatch" }, 409);
            }
            let copied = 0;
            for (const f of old.files) {
                if (rec.files.includes(f)) continue;
                if (this.failAdopt && this.failAdopt.times > 0 && copied >= this.failAdopt.afterFiles) {
                    this.failAdopt.times--;
                    if (this.failAdopt.network) throw new TypeError("fetch failed");
                    return json({ error: "Service unavailable" }, 503);
                }
                rec.files.push(f);
                copied++;
            }
            return json(this.info(fresh));
        }
        if ((m = path.match(/^\/api\/shares\/([^/]+)$/))) {
            if (this.failInfo > 0) {
                this.failInfo--;
                return json({ error: "Service unavailable" }, 503);
            }
            const s = this.shares.get(m[1]);
            if (!s) return json({ error: "Not found" }, 404);
            if (session !== s.ownerUsername && !s.members.has(session ?? "")) return json({ error: "Not a member" }, 403);
            if (method === "PATCH") {
                if (session !== s.ownerUsername) return json({ error: "Owner only" }, 403);
                if ("limitBytes" in body) s.limitBytes = body.limitBytes;
                if ("editPolicy" in body) s.editPolicy = body.editPolicy;
            }
            return json(this.info(m[1]));
        }
        if ((m = path.match(/^\/api\/spaces\/([^/]+)\/keyring\/(invite|link)$/)) && method === "POST") {
            const s = this.shares.get(m[1]);
            if (!s || s.ownerUsername !== session) return json({ error: "Owner only" }, 403);
            if (m[2] === "invite") {
                s.members.add(body.username);
                return json({ ok: true });
            }
            const token = `tok_${this.links.size + 1}`;
            this.links.set(token, m[1]);
            return json({ token, role: body.role });
        }
        return json({ error: `no route ${method} ${path}` }, 404);
    }

    info(spaceId: string) {
        const s = this.shares.get(spaceId)!;
        return {
            kind: s.kind, ownerUsername: s.ownerUsername, limitBytes: s.limitBytes, usedBytes: 0, editPolicy: s.editPolicy,
            name: s.name, closed: s.closed, members: [...s.members], names: { ...s.names },
        };
    }

    /** What `redeem` does server-side: the link's holder becomes a member. */
    redeem(spaceId: string, token: string, username: string): void {
        if (this.links.get(token) !== spaceId) throw new Error("bad link");
        this.shares.get(spaceId)!.members.add(username);
    }
}

/** Who this device is signed in as (the fake session token is the username). */
interface Device {
    me: string | null;
    /** Whether the session holds its seed (a session restored after a reload does not). */
    unlocked: boolean;
}

class FakeAuth implements ShareGuestAuth {
    registered: Array<{ username: string; password: string }> = [];
    takenOnce = new Set<string>();
    takeNext = 0;
    deviceLabels: string[] = [];
    /** How many of the next calls fail (before doing anything). */
    phraseFailures = 0;
    deviceFailures = 0;
    revokedCalls: Array<{ by: string | null; factorId: string }> = [];
    deviceLogins: Array<{ username: string; factorId: string; deviceKey: string }> = [];
    revoked = new Set<string>();
    recovered: Array<{ username: string; phrase: string }> = [];
    phrases = 0;
    constructor(private readonly device: Device) {}

    async register(p: { username: string; password: string }) {
        if (this.takeNext > 0) {
            this.takeNext--;
            throw new AuthHttpError("register", 409, undefined, "Username already exists");
        }
        this.registered.push(p);
        this.device.me = p.username;
        this.device.unlocked = true;
        return { username: p.username, commitment: "1" };
    }
    unlocks: string[] = [];
    private requireUnlocked() {
        if (!this.device.me || !this.device.unlocked) throw new Error("Sign in first.");
    }
    async enrollDevice(label: string) {
        this.requireUnlocked();
        if (this.deviceFailures > 0) {
            this.deviceFailures--;
            throw new Error("vault unavailable");
        }
        this.deviceLabels.push(label);
        return { factorId: `device:${this.deviceLabels.length}`, deviceKey: `key-${this.device.me}` };
    }
    async loginWithDevice(username: string, factorId: string, deviceKey: string) {
        if (this.revoked.has(factorId)) throw new DeviceRevokedError();
        this.deviceLogins.push({ username, factorId, deviceKey });
        this.device.me = username;
        this.device.unlocked = true;
        return { username, commitment: "1" };
    }
    async unlockWithDevice(username: string, factorId: string) {
        if (this.revoked.has(factorId)) throw new DeviceRevokedError();
        if (username !== this.device.me) throw new Error("not this account");
        this.unlocks.push(factorId);
        this.device.unlocked = true;
    }
    async revokeDevice(factorId: string) {
        this.requireUnlocked();
        this.revokedCalls.push({ by: this.device.me, factorId });
        this.revoked.add(factorId);
        return true;
    }
    async enrollRecoveryPhrase() {
        this.requireUnlocked();
        if (this.phraseFailures > 0) {
            this.phraseFailures--;
            throw new Error("vault unavailable");
        }
        this.phrases++;
        return PHRASE;
    }
    async recoverWithPhrase(username: string, phrase: string) {
        if (phrase !== PHRASE) throw new Error("This recovery phrase does not match the account.");
        this.recovered.push({ username, phrase });
        this.device.me = username;
        this.device.unlocked = true;
        return { username, commitment: "1" };
    }
}

let spaceCounter = 0;

/** `client.space` for shares: creates Spaces with a real keyring over MemTransport; records every handle. */
class FakeSpaces {
    readonly transports = new Map<string, MemTransport>();
    readonly createOpts: unknown[] = [];
    readonly joinRequests: Array<{ spaceId: string; member: string }> = [];
    readonly redeemed: Array<{ spaceId: string; token: string }> = [];
    disconnects = 0;
    constructor(
        private readonly server: FakeServer,
        private readonly http: () => HttpClient,
        private readonly device: Device,
    ) {}

    async createSpace(opts: unknown): Promise<ShareSpaceHandle> {
        this.createOpts.push(opts);
        // Unique across devices and as long as a real Space id (256 characters), so a cap on ids cannot hide.
        const id = realSpaceId(`space_${++spaceCounter}`);
        // What SpaceNamespace.createSpace sends first.
        await this.http().post(`/api/spaces/${id}/metadata`, { spacePubKey: id, historyPolicy: "static", visibility: "public" });
        const transport = this.transportFor(id);
        const keyring = new SpaceKeyring({
            spaceId: id, memberId: this.device.me!, identityEcdhPub: "unused", ownPrivateKey: () => null,
            transport, historyPolicy: "static",
        });
        await keyring.bootstrapNew();
        return { id, keyring, disconnect: () => void this.disconnects++ };
    }

    async get(spaceId: string): Promise<ShareSpaceHandle> {
        const me = this.device.me!;
        let keys = 0;
        return {
            id: spaceId,
            keyring: {
                admit: async () => {},
                loadFromCache: async () => false,
                hasAnyKey: () => keys > 0,
                requestKey: async () => void this.joinRequests.push({ spaceId, member: me }),
                // The keeper wraps on the join request: the next pull finds a key.
                pullKeys: async () => (this.joinRequests.some((j) => j.spaceId === spaceId && j.member === me) ? ++keys : 0),
            },
            disconnect: () => void this.disconnects++,
        };
    }

    async joinByInvite(spaceId: string, token: string): Promise<ShareSpaceHandle> {
        this.server.redeem(spaceId, token, this.device.me!);
        this.redeemed.push({ spaceId, token });
        return { id: spaceId, disconnect: () => void this.disconnects++ };
    }

    transportFor(id: string): MemTransport {
        let t = this.transports.get(id);
        if (!t) {
            t = new MemTransport();
            const server = this.server;
            const orig = t.postWrappedKey.bind(t);
            // Record the keeper seed in the server's call log, so its order against the HTTP calls is visible.
            t.postWrappedKey = async (target, wrapped, from) => {
                server.calls.push({ method: "WRAP", path: `/api/spaces/${id}/keyring/wrap→${target}`, body: wrapped, session: from });
                return orig(target, wrapped, from);
            };
            this.transports.set(id, t);
        }
        return t;
    }
}

interface Env {
    server: FakeServer;
    device: Device;
    auth: FakeAuth;
    spaces: FakeSpaces;
    store: SharesLocalStore;
    shares: SharesNamespace;
}

async function savedLogin(store: SharesLocalStore): Promise<GuestDeviceLogin | null> {
    const raw = await store.get("guest/login");
    return raw ? JSON.parse(raw) : null;
}

/** One device (browser): its session, auth, spaces and guest-login store, against a shared server. */
function deviceOn(
    server: FakeServer,
    me: string | null,
    store: SharesLocalStore = memorySharesStore(),
    opts: { locked?: boolean } = {},
): Env {
    const device: Device = { me, unlocked: me !== null && !opts.locked };
    const http = new HttpClient({ baseUrl: BASE, apiKey: "mk_test_pk_x", getSessionToken: () => device.me, fetch: server.fetch });
    const auth = new FakeAuth(device);
    const spaces = new FakeSpaces(server, () => http, device);
    const shares = new SharesNamespace({
        http,
        me: () => device.me,
        unlocked: () => device.unlocked,
        spaces,
        auth,
        store,
        inviteBase: () => "https://drive.example/",
        retryDelayMs: 0,
    });
    return { server, device, auth, spaces, store, shares };
}

let server: FakeServer;
beforeEach(async () => {
    server = new FakeServer();
    server.keeperPub = await someEcdhPub();
});

describe("create", () => {
    it("public: metadata, then the keeper seed, then POST /api/shares with a verifier; the password is never sent", async () => {
        const ann = deviceOn(server, "ann");
        const share = await ann.shares.create({ kind: "public", name: "Wedding", limitBytes: 1000, password: "correct horse" });

        expect(share).toBeInstanceOf(Share);
        const id = share.spaceId;
        expect(server.log()).toEqual([
            "GET /api/app/keeper",
            `POST /api/spaces/${id}/metadata`,
            `WRAP /api/spaces/${id}/keyring/wrap→${KEEPER_MEMBER_ID}`,
            "POST /api/shares",
        ]);
        const post = server.calls.find((c) => c.path === "/api/shares")!;
        expect(post.body).toMatchObject({ spaceId: id, kind: "public", name: "Wedding", limitBytes: 1000, editPolicy: "own" });
        const pw = (post.body as { password: PasswordVerifier }).password;
        expect(pw).toMatchObject({ iterations: 310_000 });
        expect(typeof pw.salt).toBe("string");
        expect(typeof pw.verifier).toBe("string");
        for (const c of server.calls) expect(JSON.stringify(c.body ?? "")).not.toContain("correct horse");
        // Created the way a public Space is: never `private: true` (that writes a membership-log genesis).
        expect(ann.spaces.createOpts).toEqual([{ historyPolicy: "static" }]);
        // The socket the creation opened is closed again.
        expect(ann.spaces.disconnects).toBe(1);
    });

    it("private: seeds the keeper and sends no password", async () => {
        const ann = deviceOn(server, "ann");
        const share = await ann.shares.create({ kind: "private", name: "Family", limitBytes: null, editPolicy: "any" });
        const keeperWraps = ann.spaces.transportFor(share.spaceId).wraps.filter((w) => w.target === KEEPER_MEMBER_ID);
        expect(keeperWraps).toHaveLength(1);
        expect(keeperWraps[0].wrapped.epoch).toBe(0);
        const post = server.calls.find((c) => c.path === "/api/shares")!;
        expect(post.body).toEqual({ spaceId: share.spaceId, kind: "private", name: "Family", limitBytes: null, editPolicy: "any" });
    });

    it("refuses a public share without a password and a private one with one, before creating anything", async () => {
        const ann = deviceOn(server, "ann");
        await expect(ann.shares.create({ kind: "public", name: "W", limitBytes: 1 })).rejects.toThrow(/password/);
        await expect(ann.shares.create({ kind: "private", name: "F", limitBytes: null, password: "x" })).rejects.toThrow(/password/);
        expect(server.calls).toHaveLength(0);
    });

    it("fails without a keeper, before POST /api/shares", async () => {
        server.keeperPub = null;
        const ann = deviceOn(server, "ann");
        await expect(ann.shares.create({ kind: "private", name: "F", limitBytes: null })).rejects.toThrow(/keeper/i);
        expect(server.log()).not.toContain("POST /api/shares");
        // Checked before the Space is made: no orphan Space.
        expect(ann.spaces.createOpts).toEqual([]);
        expect(server.metadata.size).toBe(0);
    });
});

describe("joinWithPassword", () => {
    async function publicShare(password = "pw-1") {
        const ann = deviceOn(server, "ann");
        const share = await ann.shares.create({ kind: "public", name: "Wedding", limitBytes: 10_000, password });
        return { ann, spaceId: share.spaceId };
    }

    it("signed out: quietly creates a guest account, admits it, joins the keyring and returns the recovery", async () => {
        const { spaceId } = await publicShare();
        const gus = deviceOn(server, null);
        gus.auth.takeNext = 1; // the first generated username is taken

        const { share, recovery } = await gus.shares.joinWithPassword(spaceId, { password: "pw-1", name: "  Gus  " });

        expect(gus.auth.registered).toHaveLength(1);
        const { username, password } = gus.auth.registered[0];
        expect(username).toMatch(/^g-[a-z2-7]{12}$/);
        // 32 random bytes, base64url, never the share password and never returned.
        expect(password).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(JSON.stringify(recovery)).not.toContain(password);
        expect(gus.auth.deviceLabels).toEqual(["Shared folder guest"]);
        expect(await savedLogin(gus.store)).toEqual({ username, factorId: "device:1", deviceKey: `key-${username}` });
        expect(await gus.store.get("guest/setup")).toBeNull(); // setup finished
        expect(recovery).toEqual({ username, phrase: PHRASE, code: guestRecoveryCode(username, PHRASE) });

        expect(share.spaceId).toBe(spaceId);
        const admit = server.calls.find((c) => c.path === `/api/shares/${spaceId}/admit`)!;
        expect(admit.session).toBe(username);
        expect(admit.body).toEqual({ proof: expect.any(String), name: "Gus" });
        expect(JSON.stringify(admit.body)).not.toContain("pw-1");
        expect(gus.spaces.joinRequests).toEqual([{ spaceId, member: username }]);
        expect(server.info(spaceId).names[username]).toBe("Gus");
    });

    it("a returning device signs in with its stored device login; no new account, no recovery", async () => {
        const { spaceId } = await publicShare();
        const store = memorySharesStore();
        await store.set("guest/login", JSON.stringify({ username: "g-aaaaaaaaaaaa", factorId: "device:9", deviceKey: "k" }));
        const gus = deviceOn(server, null, store);

        const { recovery } = await gus.shares.joinWithPassword(spaceId, { password: "pw-1", name: "Gus" });

        expect(recovery).toBeNull();
        expect(gus.auth.registered).toHaveLength(0);
        expect(gus.auth.deviceLogins).toEqual([{ username: "g-aaaaaaaaaaaa", factorId: "device:9", deviceKey: "k" }]);
        expect(server.calls.find((c) => c.path.endsWith("/admit"))!.session).toBe("g-aaaaaaaaaaaa");
    });

    it("a revoked stored device login is dropped and a fresh guest account made", async () => {
        const { spaceId } = await publicShare();
        const store = memorySharesStore();
        await store.set("guest/login", JSON.stringify({ username: "g-aaaaaaaaaaaa", factorId: "device:gone", deviceKey: "k" }));
        const gus = deviceOn(server, null, store);
        gus.auth.revoked.add("device:gone");

        const { recovery } = await gus.shares.joinWithPassword(spaceId, { password: "pw-1", name: "Gus" });
        expect(recovery).not.toBeNull();
        expect((await savedLogin(store))!.username).toBe(recovery!.username);
    });

    it("someone signed in is just admitted", async () => {
        const { spaceId } = await publicShare();
        const bob = deviceOn(server, "bob");
        const { share, recovery } = await bob.shares.joinWithPassword(spaceId, { password: "pw-1", name: "Bob" });
        expect(recovery).toBeNull();
        expect(bob.auth.registered).toHaveLength(0);
        expect(share.spaceId).toBe(spaceId);
        expect(server.info(spaceId).members).toContain("bob");
    });

    it("a wrong password is SharePasswordError carrying the new account's recovery; it is returned until acknowledged", async () => {
        const { spaceId } = await publicShare();
        const gus = deviceOn(server, null);
        const err = await gus.shares.joinWithPassword(spaceId, { password: "nope", name: "Gus" }).catch((e) => e);
        expect(err).toBeInstanceOf(SharePasswordError);
        const username = gus.auth.registered[0].username;
        expect(guestRecoveryOf(err)).toEqual({ username, phrase: PHRASE, code: guestRecoveryCode(username, PHRASE) });

        const { recovery } = await gus.shares.joinWithPassword(spaceId, { password: "pw-1", name: "Gus" });
        expect(recovery?.username).toBe(username);
        expect(gus.auth.registered).toHaveLength(1);
        // Still there until the app says it was shown.
        expect((await gus.shares.joinWithPassword(spaceId, { password: "pw-1", name: "Gus" })).recovery?.username).toBe(username);
        expect((await gus.shares.pendingRecovery())?.code).toBe(guestRecoveryCode(username, PHRASE));
        await gus.shares.acknowledgeRecovery();
        expect((await gus.shares.joinWithPassword(spaceId, { password: "pw-1", name: "Gus" })).recovery).toBeNull();
        expect(await gus.shares.pendingRecovery()).toBeNull();
        // An error now carries none.
        expect(guestRecoveryOf(await gus.shares.joinWithPassword(spaceId, { password: "nope", name: "Gus" }).catch((e) => e))).toBeNull();
    });

    it("a bad name or a share that is not public fails before any account is made", async () => {
        const { spaceId } = await publicShare();
        const gus = deviceOn(server, null);
        await expect(gus.shares.joinWithPassword(spaceId, { password: "pw-1", name: "   " })).rejects.toThrow(/name/i);
        await expect(gus.shares.joinWithPassword(spaceId, { password: "pw-1", name: "x".repeat(41) })).rejects.toThrow(/name/i);
        await expect(gus.shares.joinWithPassword(spaceId, { password: "pw-1", name: "a\u0007b" })).rejects.toThrow(/name/i);
        await expect(gus.shares.joinWithPassword("nope", { password: "pw-1", name: "Gus" })).rejects.toMatchObject({ status: 404 });
        expect(gus.auth.registered).toHaveLength(0);
    });

    it("follows closed.successor to the current share (Review Focus 4)", async () => {
        const { ann, spaceId: first } = await publicShare("pw-1");
        const second = (await ann.shares.removeMember(first, "nobody")).spaceId;
        const third = (await ann.shares.changePassword(second, "pw-3")).spaceId;

        const gus = deviceOn(server, null);
        const { share } = await gus.shares.joinWithPassword(first, { password: "pw-3", name: "Gus" });
        expect(share.spaceId).toBe(third);
        expect(server.info(third).members).toContain(gus.device.me);
        expect(server.calls.filter((c) => c.path.endsWith("/admit")).map((c) => c.path)).toEqual([`/api/shares/${third}/admit`]);
    });

    it("gives up after 16 successor hops", async () => {
        const { ann, spaceId } = await publicShare();
        let id = spaceId;
        for (let i = 0; i < 17; i++) id = (await ann.shares.removeMember(id, "nobody")).spaceId;
        const bob = deviceOn(server, "bob");
        await expect(bob.shares.joinWithPassword(spaceId, { password: "pw-1", name: "Bob" })).rejects.toThrow(/16/);
    });
});

describe("rotation", () => {
    it("changePassword: a new Space with its keeper, adopt with a new verifier, the new share returned", async () => {
        const ann = deviceOn(server, "ann");
        const old = await ann.shares.create({ kind: "public", name: "W", limitBytes: 100, password: "pw-1" });
        const before = server.calls.length;

        const next = await ann.shares.changePassword(old.spaceId, "pw-2");

        expect(next).toBeInstanceOf(Share);
        expect(next.spaceId).not.toBe(old.spaceId);
        const calls = server.calls.slice(before);
        expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
            `GET /api/shares/${old.spaceId}`, // where the share is now (it may have moved)
            "GET /api/app/keeper",
            `POST /api/spaces/${next.spaceId}/metadata`,
            `WRAP /api/spaces/${next.spaceId}/keyring/wrap→${KEEPER_MEMBER_ID}`,
            `POST /api/shares/${next.spaceId}/adopt`,
        ]);
        const adopt = calls[4].body as { from: string; password: PasswordVerifier; remove?: string[] };
        expect(adopt.from).toBe(old.spaceId);
        expect(adopt.remove).toBeUndefined();
        expect(adopt.password.verifier).not.toBe(server.shares.get(old.spaceId)!.password!.verifier);
        for (const c of calls) expect(JSON.stringify(c.body ?? "")).not.toContain("pw-2");
        expect(ann.spaces.createOpts).toEqual([{ historyPolicy: "static" }, { historyPolicy: "static" }]);
        // Never the keyring rotate route.
        expect(server.log().some((l) => l.includes("/keyring/rotate"))).toBe(false);
    });

    it("after a password change a guest re-admits with the new password as the same account; open() says where it moved", async () => {
        const ann = deviceOn(server, "ann");
        const old = await ann.shares.create({ kind: "public", name: "W", limitBytes: 100, password: "pw-1" });
        const gus = deviceOn(server, null);
        const { recovery } = await gus.shares.joinWithPassword(old.spaceId, { password: "pw-1", name: "Gus" });
        const next = await ann.shares.changePassword(old.spaceId, "pw-2");

        const err = await gus.shares.open(old.spaceId).catch((e) => e);
        expect(err).toBeInstanceOf(ShareClosedError);
        expect(err.successor).toBe(next.spaceId);

        await expect(gus.shares.joinWithPassword(old.spaceId, { password: "pw-1", name: "Gus" })).rejects.toBeInstanceOf(SharePasswordError);
        const again = await gus.shares.joinWithPassword(old.spaceId, { password: "pw-2", name: "Gus" });
        expect(again.share.spaceId).toBe(next.spaceId);
        expect(again.recovery?.username).toBe(recovery!.username); // not acknowledged yet
        expect(gus.auth.registered).toHaveLength(1);
        expect(server.info(next.spaceId).members).toEqual([recovery!.username]);
        expect(server.info(next.spaceId).names[recovery!.username]).toBe("Gus");
    });

    it("removeMember: adopt with remove: [username]; others are carried and open() follows to the new share", async () => {
        const ann = deviceOn(server, "ann");
        const old = await ann.shares.create({ kind: "private", name: "F", limitBytes: null });
        await ann.shares.invite(old.spaceId, "bob");
        await ann.shares.invite(old.spaceId, "cat");

        const next = await ann.shares.removeMember(old.spaceId, "bob");

        const adopt = server.calls.find((c) => c.path === `/api/shares/${next.spaceId}/adopt`)!;
        expect(adopt.body).toEqual({ from: old.spaceId, remove: ["bob"] });
        expect(server.info(next.spaceId).members).toEqual(["cat"]);
        const cat = deviceOn(server, "cat");
        const opened = await cat.shares.open(old.spaceId);
        expect(opened.spaceId).toBe(next.spaceId);
        expect(cat.spaces.joinRequests).toEqual([{ spaceId: next.spaceId, member: "cat" }]);
        await expect(deviceOn(server, "bob").shares.open(old.spaceId)).rejects.toBeInstanceOf(ShareClosedError);
    });

    it("removeMember on a public share can change the password too", async () => {
        const ann = deviceOn(server, "ann");
        const old = await ann.shares.create({ kind: "public", name: "W", limitBytes: 100, password: "pw-1" });
        const next = await ann.shares.removeMember(old.spaceId, "gus", { password: "pw-2" });
        const adopt = server.calls.find((c) => c.path === `/api/shares/${next.spaceId}/adopt`)!.body as Record<string, unknown>;
        expect(adopt).toMatchObject({ from: old.spaceId, remove: ["gus"], password: { iterations: 310_000 } });
    });

    it("with no rotation pending, rotating a share that already moved (completely) rotates its current successor", async () => {
        const ann = deviceOn(server, "ann");
        const a = await ann.shares.create({ kind: "private", name: "F", limitBytes: null });
        const b = await ann.shares.removeMember(a.spaceId, "x");
        const c = await ann.shares.removeMember(a.spaceId, "y");
        expect(server.calls.find((x) => x.path === `/api/shares/${c.spaceId}/adopt`)!.body).toMatchObject({ from: b.spaceId });
    });
});

describe("open, list, settings and invites", () => {
    it("open: the owner opens their share as `me` (a join request is harmless when keys are held)", async () => {
        const ann = deviceOn(server, "ann");
        const created = await ann.shares.create({ kind: "private", name: "F", limitBytes: null });
        const share = await ann.shares.open(created.spaceId);
        expect(share.spaceId).toBe(created.spaceId);
        expect(ann.spaces.joinRequests).toEqual([{ spaceId: created.spaceId, member: "ann" }]);
        expect(await ann.shares.list()).toEqual([{ spaceId: created.spaceId, kind: "private", owner: "ann", name: "F" }]);
    });

    it("open needs someone signed in", async () => {
        await expect(deviceOn(server, null).shares.open("x")).rejects.toThrow(/sign in/i);
    });

    it("setLimit and setEditPolicy PATCH the share", async () => {
        const ann = deviceOn(server, "ann");
        const { spaceId } = await ann.shares.create({ kind: "private", name: "F", limitBytes: null });
        expect((await ann.shares.setLimit(spaceId, 500)).limitBytes).toBe(500);
        expect((await ann.shares.setEditPolicy(spaceId, "any")).editPolicy).toBe("any");
        const patches = server.calls.filter((c) => c.method === "PATCH").map((c) => c.body);
        expect(patches).toEqual([{ limitBytes: 500 }, { editPolicy: "any" }]);
    });

    it("invite by username: /keyring/invite, then the invitee's open() sends its join request", async () => {
        const ann = deviceOn(server, "ann");
        const { spaceId } = await ann.shares.create({ kind: "private", name: "F", limitBytes: null });
        await ann.shares.invite(spaceId, "bob");
        expect(server.calls.at(-1)).toMatchObject({ method: "POST", path: `/api/spaces/${spaceId}/keyring/invite`, body: { username: "bob" } });

        const bob = deviceOn(server, "bob");
        expect((await bob.shares.open(spaceId)).spaceId).toBe(spaceId);
        expect(bob.spaces.joinRequests).toEqual([{ spaceId, member: "bob" }]);
    });

    it("inviteLink mints an editor link and builds its URL; joinWithInvite redeems it and opens the share", async () => {
        const ann = deviceOn(server, "ann");
        const { spaceId } = await ann.shares.create({ kind: "private", name: "F", limitBytes: null });
        const { url, token } = await ann.shares.inviteLink(spaceId);
        expect(server.calls.at(-1)).toMatchObject({ path: `/api/spaces/${spaceId}/keyring/link`, body: { role: "editor" } });
        expect(url).toBe(`https://drive.example/#/join/${spaceId}/${token}`);
        expect(await ann.shares.inviteLink(spaceId, { baseUrl: "https://x.test/app" })).toMatchObject({
            url: expect.stringMatching(new RegExp(`^https://x\\.test/app#/join/${spaceId}/tok_2$`)),
        });

        const bob = deviceOn(server, "bob");
        const share = await bob.shares.joinWithInvite(url);
        expect(share.spaceId).toBe(spaceId);
        expect(bob.spaces.redeemed).toEqual([{ spaceId, token }]);
        expect(server.info(spaceId).members).toContain("bob");
        await expect(bob.shares.joinWithInvite("https://drive.example/#/elsewhere")).rejects.toThrow(/invite link/i);
        // The link carries a real-length Space id; one the server would refuse is no invite link.
        expect(spaceId).toHaveLength(256);
        for (const bad of ["A".repeat(301), `${spaceId.slice(0, 100)}:x`]) {
            await expect(bob.shares.joinWithInvite(`https://drive.example/#/join/${bad}/${token}`), bad).rejects.toThrow(/invite link/i);
        }
        await expect(deviceOn(server, null).shares.joinWithInvite(url)).rejects.toThrow(/sign in/i);
    });
});

describe("guest recovery", () => {
    it("the code is <username>:<words joined by ->, and parses back case-insensitively with spaces or dashes", () => {
        const code = guestRecoveryCode("g-abcdefghijkl", "alpha beta gamma");
        expect(code).toBe("g-abcdefghijkl:alpha-beta-gamma");
        expect(parseGuestRecoveryCode(code)).toEqual({ username: "g-abcdefghijkl", phrase: "alpha beta gamma" });
        expect(parseGuestRecoveryCode("  G-ABCDEFGHIJKL : Alpha  BETA-gamma ")).toEqual({
            username: "g-abcdefghijkl",
            phrase: "alpha beta gamma",
        });
        expect(() => parseGuestRecoveryCode("no-colon-here")).toThrow(InvalidRecoveryCodeError);
        expect(() => parseGuestRecoveryCode("g-abc:")).toThrow(InvalidRecoveryCodeError);
    });

    it("restoreGuest signs in with the phrase and remembers this device for next time", async () => {
        const gus = deviceOn(server, null);
        const user = await gus.shares.restoreGuest(`G-ABCDEFGHIJKL:${PHRASE.toUpperCase().replace(/ /g, "-")}`);
        expect(user.username).toBe("g-abcdefghijkl");
        expect(gus.auth.recovered).toEqual([{ username: "g-abcdefghijkl", phrase: PHRASE }]);
        expect(await savedLogin(gus.store)).toMatchObject({ username: "g-abcdefghijkl", factorId: "device:1" });
    });
});

describe("rotation that fails part-way (review fix 1)", () => {
    async function ownerWithFiles(store: SharesLocalStore = memorySharesStore()) {
        const ann = deviceOn(server, "ann", store);
        const old = await ann.shares.create({ kind: "public", name: "W", limitBytes: 100, password: "pw-1" });
        server.shares.get(old.spaceId)!.files.push("f1", "f2", "f3", "f4", "f5");
        return { ann, old: old.spaceId };
    }

    it("a mid-copy failure is retried in the same call, into the SAME new Space, with every file", async () => {
        const { ann, old } = await ownerWithFiles();
        server.failAdopt = { times: 1, afterFiles: 2 };
        const next = await ann.shares.changePassword(old, "pw-2");

        expect(server.shares.get(next.spaceId)!.files).toEqual(["f1", "f2", "f3", "f4", "f5"]);
        const adopts = server.calls.filter((c) => c.path.endsWith("/adopt"));
        expect(adopts.map((c) => c.path)).toEqual([`/api/shares/${next.spaceId}/adopt`, `/api/shares/${next.spaceId}/adopt`]);
        expect(adopts[0].body).toEqual(adopts[1].body); // the same verifier object both times
        expect(ann.spaces.createOpts).toHaveLength(2); // the share's Space and ONE new Space
        expect(await ann.store.get("rotations")).toBeNull();
    });

    it("left unfinished: RotationIncompleteError; the next same call finishes it into the same Space", async () => {
        const { ann, old } = await ownerWithFiles();
        server.failAdopt = { times: 3, afterFiles: 1, network: true };
        const err = await ann.shares.changePassword(old, "pw-2").catch((e) => e);
        expect(err).toBeInstanceOf(RotationIncompleteError);
        expect(err.from).toBe(old);
        const half = err.newSpaceId as string;
        expect(server.shares.get(half)!.files.length).toBeLessThan(5);
        expect(server.shares.get(old)!.closed?.successor).toBe(half);

        const next = await ann.shares.changePassword(old, "pw-2");
        expect(next.spaceId).toBe(half);
        expect(server.shares.get(half)!.files).toEqual(["f1", "f2", "f3", "f4", "f5"]);
        expect(ann.spaces.createOpts).toHaveLength(2);
        expect(await ann.store.get("rotations")).toBeNull();
        // The verifier is the first call's: the new password works.
        const bob = deviceOn(server, "bob");
        expect((await bob.shares.joinWithPassword(old, { password: "pw-2", name: "Bob" })).share.spaceId).toBe(half);
    });

    it("resumes after a reload (a fresh namespace on the same store), from the old id or the half-filled one", async () => {
        const store = memorySharesStore();
        const { old } = await ownerWithFiles(store);
        server.failAdopt = { times: 3, afterFiles: 1 }; // 3 tries × 1 file < 5 files
        const err = await deviceOn(server, "ann", store).shares.removeMember(old, "gus").catch((e) => e);
        expect(err).toBeInstanceOf(RotationIncompleteError);

        const reloaded = deviceOn(server, "ann", store);
        const next = await reloaded.shares.resumeRotation(err.newSpaceId);
        expect(next?.spaceId).toBe(err.newSpaceId);
        expect(server.shares.get(err.newSpaceId)!.files).toHaveLength(5);
        expect(reloaded.spaces.createOpts).toEqual([]);
        expect(await reloaded.shares.resumeRotation(old)).toBeNull();
    });

    it("no new rotation starts while one is pending: it is refused if the pending one still fails", async () => {
        const { ann, old } = await ownerWithFiles();
        server.failAdopt = { times: 3, afterFiles: 1 }; // 3 tries × 1 file < 5 files
        const first = await ann.shares.changePassword(old, "pw-2").catch((e) => e);
        expect(first).toBeInstanceOf(RotationIncompleteError);

        server.failAdopt = { times: 6, afterFiles: 0 }; // both calls below fail all three tries
        // Asked of the old id and of the half-filled successor: both resume the pending one, which fails again.
        for (const id of [old, first.newSpaceId]) {
            const again = await ann.shares.removeMember(id, "gus").catch((e) => e);
            expect(again).toBeInstanceOf(RotationIncompleteError);
            expect(again.newSpaceId).toBe(first.newSpaceId);
        }
        expect(ann.spaces.createOpts).toHaveLength(2);
        expect(server.calls.filter((c) => c.path.endsWith("/adopt")).every((c) => c.path === `/api/shares/${first.newSpaceId}/adopt`)).toBe(true);
    });

    it("a different rotation asked while one is pending first finishes the pending one, then rotates from it", async () => {
        const { ann, old } = await ownerWithFiles();
        server.failAdopt = { times: 3, afterFiles: 1 }; // 3 tries × 1 file < 5 files
        const first = await ann.shares.changePassword(old, "pw-2").catch((e) => e);

        const next = await ann.shares.removeMember(old, "gus");
        expect(server.shares.get(first.newSpaceId)!.files).toHaveLength(5);
        expect(server.shares.get(first.newSpaceId)!.closed?.successor).toBe(next.spaceId);
        expect(server.calls.at(-1)!.body).toEqual({ from: first.newSpaceId, remove: ["gus"] });
        expect(server.shares.get(next.spaceId)!.files).toHaveLength(5);
    });

    it("a rotation another device won (rotation_in_progress) is forgotten, not retried", async () => {
        const { ann, old } = await ownerWithFiles();
        server.failAdopt = { times: 3, afterFiles: 0 };
        const first = await ann.shares.changePassword(old, "pw-2").catch((e) => e);
        // Simulate the other device's claim replacing ours.
        server.shares.get(old)!.closed = { successor: "elsewhere", at: 2 };
        server.shares.delete(first.newSpaceId);
        server.failAdopt = null;
        await expect(ann.shares.resumeRotation(old)).rejects.toMatchObject({ name: "RotationInProgressError" });
        expect(await ann.store.get("rotations")).toBeNull();
    });
});

describe("guest setup that fails part-way (review fixes 2, 3)", () => {
    async function publicShare() {
        const ann = deviceOn(server, "ann");
        return (await ann.shares.create({ kind: "public", name: "W", limitBytes: 100, password: "pw-1" })).spaceId;
    }

    it("each step is retried once", async () => {
        const spaceId = await publicShare();
        const gus = deviceOn(server, null);
        gus.auth.phraseFailures = 1;
        gus.auth.deviceFailures = 1;
        const { recovery } = await gus.shares.joinWithPassword(spaceId, { password: "pw-1", name: "Gus" });
        expect(recovery?.phrase).toBe(PHRASE);
        expect(await savedLogin(gus.store)).not.toBeNull();
        expect(await gus.store.get("guest/setup")).toBeNull();
    });

    it("a device step that keeps failing throws with the recovery attached; the next join finishes the setup", async () => {
        const spaceId = await publicShare();
        const gus = deviceOn(server, null);
        gus.auth.deviceFailures = 2;
        const err = await gus.shares.joinWithPassword(spaceId, { password: "pw-1", name: "Gus" }).catch((e) => e);
        const username = gus.auth.registered[0].username;
        expect(guestRecoveryOf(err)?.username).toBe(username);
        expect(await savedLogin(gus.store)).toBeNull();
        expect(JSON.parse((await gus.store.get("guest/setup"))!)).toEqual({ username, phrase: true, device: false });

        const { recovery } = await gus.shares.joinWithPassword(spaceId, { password: "pw-1", name: "Gus" });
        expect(recovery?.username).toBe(username);
        expect(gus.auth.registered).toHaveLength(1);
        expect(await savedLogin(gus.store)).toMatchObject({ username });
        expect(await gus.store.get("guest/setup")).toBeNull();
    });

    it("a phrase step that keeps failing leaves the marker; open() finishes it later", async () => {
        const spaceId = await publicShare();
        const gus = deviceOn(server, null);
        gus.auth.phraseFailures = 2;
        await expect(gus.shares.joinWithPassword(spaceId, { password: "pw-1", name: "Gus" })).rejects.toThrow(/vault/);
        const username = gus.auth.registered[0].username;
        expect(JSON.parse((await gus.store.get("guest/setup"))!)).toMatchObject({ username, phrase: false });

        await gus.shares.joinWithPassword(spaceId, { password: "pw-1", name: "Gus" }).catch(() => {});
        await gus.shares.open(spaceId);
        expect(await gus.store.get("guest/setup")).toBeNull();
        expect(await savedLogin(gus.store)).toMatchObject({ username });
    });

    it("a device login the store cannot keep is reported, and the marker stays so a later visit retries", async () => {
        const spaceId = await publicShare();
        const inner = memorySharesStore();
        const full: SharesLocalStore = {
            get: inner.get,
            delete: inner.delete,
            set: async (k, v) => {
                if (k === "guest/login") throw new Error("QuotaExceededError");
                return inner.set(k, v);
            },
        };
        const gus = deviceOn(server, null, full);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const { recovery } = await gus.shares.joinWithPassword(spaceId, { password: "pw-1", name: "Gus" });
        expect(recovery).not.toBeNull();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("guest device login"), expect.any(Error));
        warn.mockRestore();
        expect(JSON.parse((await inner.get("guest/setup"))!)).toMatchObject({ phrase: true, device: false });
    });

    it("the recovery survives a reload until acknowledged", async () => {
        const spaceId = await publicShare();
        const store = memorySharesStore();
        const first = deviceOn(server, null, store);
        const { recovery } = await first.shares.joinWithPassword(spaceId, { password: "pw-1", name: "Gus" });

        const reloaded = deviceOn(server, null, store); // signed out: the device login signs in
        const again = await reloaded.shares.joinWithPassword(spaceId, { password: "pw-1", name: "Gus" });
        expect(again.recovery).toEqual(recovery);
        expect(await reloaded.shares.pendingRecovery()).toEqual(recovery);
        await reloaded.shares.acknowledgeRecovery();
        expect(await deviceOn(server, "x", store).shares.pendingRecovery()).toBeNull();
    });
});

describe("restoreGuest with another guest kept on this device (review fix 4)", () => {
    it("refuses with GuestLoginConflictError unless replace, which revokes the old device factor", async () => {
        const store = memorySharesStore();
        await store.set("guest/login", JSON.stringify({ username: "g-oldoldoldold", factorId: "device:old", deviceKey: "k" }));
        const gus = deviceOn(server, null, store);
        const code = guestRecoveryCode("g-newnewnewnew", PHRASE);

        const err = await gus.shares.restoreGuest(code).catch((e) => e);
        expect(err).toBeInstanceOf(GuestLoginConflictError);
        expect(err.existing).toBe("g-oldoldoldold");
        expect(gus.auth.recovered).toEqual([]);

        const user = await gus.shares.restoreGuest(code, { replace: true });
        expect(user.username).toBe("g-newnewnewnew");
        expect(gus.auth.revokedCalls).toEqual([{ by: "g-oldoldoldold", factorId: "device:old" }]);
        expect(await savedLogin(store)).toMatchObject({ username: "g-newnewnewnew" });
        // Revoked only after the new guest was restored and kept; signed in as the new guest at the end.
        expect(gus.auth.recovered).toEqual([{ username: "g-newnewnewnew", phrase: PHRASE }]);
        expect(gus.device).toEqual({ me: "g-newnewnewnew", unlocked: true });
    });

    it("the same guest restoring again is not a conflict", async () => {
        const store = memorySharesStore();
        await store.set("guest/login", JSON.stringify({ username: "g-abcdefghijkl", factorId: "device:x", deviceKey: "k" }));
        const gus = deviceOn(server, null, store);
        await expect(gus.shares.restoreGuest(guestRecoveryCode("g-abcdefghijkl", PHRASE))).resolves.toMatchObject({ username: "g-abcdefghijkl" });
    });
});

describe("review fix round 2", () => {
    async function publicShare() {
        const ann = deviceOn(server, "ann");
        return (await ann.shares.create({ kind: "public", name: "W", limitBytes: 100, password: "pw-1" })).spaceId;
    }

    it("A: a restored-but-locked guest session is unlocked with the device login, re-shows the recovery and finishes setup", async () => {
        const spaceId = await publicShare();
        const store = memorySharesStore();
        const first = deviceOn(server, null, store);
        await first.shares.joinWithPassword(spaceId, { password: "pw-1", name: "Gus" });
        const username = first.auth.registered[0].username;
        // A setup step left unfinished (as when its marker update could not be kept).
        await store.set("guest/setup", JSON.stringify({ username, phrase: false, device: true }));
        const phrasesBefore = first.auth.phrases;

        // Reload: the session token is restored, the seed is not.
        const reloaded = deviceOn(server, username, store, { locked: true });
        expect(await reloaded.shares.pendingRecovery()).toEqual({ username, phrase: PHRASE, code: guestRecoveryCode(username, PHRASE) });
        expect(reloaded.auth.unlocks).toEqual(["device:1"]);

        const again = deviceOn(server, username, store, { locked: true });
        const { recovery } = await again.shares.joinWithPassword(spaceId, { password: "pw-1", name: "Gus" });
        expect(recovery?.username).toBe(username);
        expect(again.auth.unlocks).toEqual(["device:1"]);
        expect(again.auth.phrases).toBeGreaterThan(0); // the phrase step ran, unlocked
        expect(phrasesBefore).toBe(1);
        expect(await store.get("guest/setup")).toBeNull();
    });

    it("A: if the recovery flag cannot be kept, the instance still returns the recovery of the account it just made", async () => {
        const spaceId = await publicShare();
        const inner = memorySharesStore();
        const store: SharesLocalStore = {
            get: inner.get,
            delete: inner.delete,
            set: async (k, v) => {
                if (k === "guest/recovery") throw new Error("QuotaExceededError");
                return inner.set(k, v);
            },
        };
        const gus = deviceOn(server, null, store);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const { recovery } = await gus.shares.joinWithPassword(spaceId, { password: "pw-1", name: "Gus" });
        warn.mockRestore();
        expect(recovery?.username).toBe(gus.auth.registered[0].username);
        await gus.shares.acknowledgeRecovery();
        expect(await gus.shares.pendingRecovery()).toBeNull();
    });

    it("B: a wrong code with replace: true leaves the old guest's login, setup and recovery intact", async () => {
        const store = memorySharesStore();
        const login = JSON.stringify({ username: "g-oldoldoldold", factorId: "device:old", deviceKey: "k" });
        const setup = JSON.stringify({ username: "g-oldoldoldold", phrase: true, device: false });
        const flag = JSON.stringify({ username: "g-oldoldoldold" });
        await store.set("guest/login", login);
        await store.set("guest/setup", setup);
        await store.set("guest/recovery", flag);
        const gus = deviceOn(server, null, store);

        await expect(gus.shares.restoreGuest("g-newnewnewnew:wrong-words-here", { replace: true })).rejects.toThrow(/does not match/);
        expect(gus.auth.revokedCalls).toEqual([]);
        expect(await store.get("guest/login")).toBe(login);
        expect(await store.get("guest/setup")).toBe(setup);
        expect(await store.get("guest/recovery")).toBe(flag);
    });

    it("C: an error while looking for a pending rotation is not 'none pending'", async () => {
        const ann = deviceOn(server, "ann");
        const old = await ann.shares.create({ kind: "public", name: "W", limitBytes: 100, password: "pw-1" });
        server.shares.get(old.spaceId)!.files.push("f1", "f2", "f3");
        server.failAdopt = { times: 3, afterFiles: 0 };
        const first = await ann.shares.changePassword(old.spaceId, "pw-2").catch((e) => e);
        expect(first).toBeInstanceOf(RotationIncompleteError);

        // Some earlier id of the share, whose walk to the pending rotation hits a transient error.
        server.failInfo = 1;
        const created = ann.spaces.createOpts.length;
        const pendingFrom = first.from as string;
        // Make the call from a Space before `from`: fake an older share closed into it.
        server.shares.set("older", { ...server.shares.get(pendingFrom)!, closed: { successor: pendingFrom, at: 0 } });
        await expect(ann.shares.removeMember("older", "gus")).rejects.toMatchObject({ status: 503 });
        expect(ann.spaces.createOpts.length).toBe(created);
    });

    it("D: abandonRotation forgets a pending rotation; a later rotation starts afresh", async () => {
        const ann = deviceOn(server, "ann");
        const old = await ann.shares.create({ kind: "private", name: "F", limitBytes: null });
        server.failAdopt = { times: 3, afterFiles: 0 };
        server.shares.get(old.spaceId)!.files.push("f1");
        const first = await ann.shares.removeMember(old.spaceId, "gus").catch((e) => e);
        expect(await ann.shares.abandonRotation(first.newSpaceId)).toBe(true);
        expect(await ann.store.get("rotations")).toBeNull();
        expect(await ann.shares.abandonRotation(old.spaceId)).toBe(false);
    });

    it("D: an existing guest's unfinished setup step warns but does not block a later join", async () => {
        const spaceId = await publicShare();
        const store = memorySharesStore();
        const gus = deviceOn(server, null, store);
        gus.auth.deviceFailures = 2;
        await gus.shares.joinWithPassword(spaceId, { password: "pw-1", name: "Gus" }).catch(() => {});

        gus.auth.deviceFailures = 2; // still failing on the later visit
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const { share } = await gus.shares.joinWithPassword(spaceId, { password: "pw-1", name: "Gus" });
        expect(share.spaceId).toBe(spaceId);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("setup"), expect.any(String));
        // The logged value never carries the recovery code (the error does).
        for (const args of warn.mock.calls) {
            for (const a of args) {
                expect(String(a)).not.toContain(PHRASE.split(" ")[0]);
                expect((a as { recovery?: unknown })?.recovery).toBeUndefined();
            }
        }
        warn.mockRestore();
        expect(JSON.parse((await store.get("guest/setup"))!)).toMatchObject({ device: false });
    });

    it("final review minor 2: open() logs a failed setup step without the recovery the error carries", async () => {
        const spaceId = await publicShare();
        const gus = deviceOn(server, null);
        gus.auth.deviceFailures = 2;
        const err = await gus.shares.joinWithPassword(spaceId, { password: "pw-1", name: "Gus" }).catch((e) => e);
        expect(guestRecoveryOf(err)?.phrase).toBe(PHRASE);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        gus.auth.deviceFailures = 2;
        await gus.shares.joinWithPassword(spaceId, { password: "pw-1", name: "Gus" }); // a member now; setup still unfinished
        warn.mockClear();

        gus.auth.deviceFailures = 2;
        await gus.shares.open(spaceId);
        const logged = warn.mock.calls.filter((c) => String(c[0]).includes("setup"));
        warn.mockRestore();
        expect(logged).toHaveLength(1);
        for (const a of logged[0]) {
            expect(typeof a).toBe("string");
            expect(String(a)).not.toContain(PHRASE.split(" ")[0]);
        }
    });
});
