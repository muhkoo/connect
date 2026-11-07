/**
 * Shared folders END-TO-END against a LIVE staging deployment (the release gate; every other shares suite uses fakes).
 *
 *   MUHKOO_BASE_URL=https://api.staging.muhkoo.dev E2E_STAGING=1 \
 *     npx vitest --run --project e2e tests/shares/shares.e2e.test.ts
 *
 * Refuses to run against anything but a staging host. Registers one owner account (kept in SMOKE_STATE, when set,
 * so a re-run logs in instead of registering again: staging allows 10 registrations per IP per hour) and one quiet
 * guest account per run. Writes a redacted request log to SMOKE_HTTP_LOG and per-scenario evidence to
 * SMOKE_EVIDENCE when those are set.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { Client } from "../../src/core/Client";
import { MemorySessionStore } from "../../src/core/Session";
import { memorySharesStore } from "../../src/core/namespaces/SharesNamespace";
import type { Share } from "../../src/shares/Share";
import { ShareClosedError, ShareFullError, SharePasswordError } from "../../src/shares/errors";

/**
 * SMOKE_SHORT_SPACE_IDS=1: a WORKAROUND, not the product path. The SDK's Space ids are base64url P-384 JWKs (~256
 * chars), but the accelerator's share routes accept at most 128 (`SHARE_SPACE_ID_RE`), so every real share create is
 * refused with 400. With this flag set, new Spaces get a 64-char base64url id instead (the id is never decoded back
 * into a key), so the scenarios past create can still be exercised. Off by default: the default run tests the real
 * path.
 */
vi.mock("../../src/spaces/SpaceCipher", async (importOriginal) => {
    const orig = await importOriginal<typeof import("../../src/spaces/SpaceCipher")>();
    if (process.env.SMOKE_SHORT_SPACE_IDS !== "1") return orig;
    return {
        ...orig,
        generateSpaceIdentity: async () => {
            const real = await orig.generateSpaceIdentity();
            const bytes = crypto.getRandomValues(new Uint8Array(45));
            const id = "smk" + Buffer.from(bytes).toString("base64url").slice(0, 61);
            return { ...real, id };
        },
    };
});

const BASE_URL = (process.env.MUHKOO_BASE_URL || "").replace(/\/+$/, "");
const IS_STAGING = /^https:\/\/api\.staging\.muhkoo\.dev$/.test(BASE_URL);
const RUN = process.env.E2E_STAGING === "1" && IS_STAGING;

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmUrl = path.resolve(here, "../../circuits/build/preimagePoK_js/preimagePoK.wasm");
const zkeyUrl = path.resolve(here, "../../circuits/build/preimagePoK_0001.zkey");
const circuitsPresent = fs.existsSync(wasmUrl) && fs.existsSync(zkeyUrl);

const STATE_FILE = process.env.SMOKE_STATE || "";
const HTTP_LOG = process.env.SMOKE_HTTP_LOG || "";
const EVIDENCE = process.env.SMOKE_EVIDENCE || "";

// ---------------------------------------------------------------------------------------------------------------
// Redacted logging
// ---------------------------------------------------------------------------------------------------------------

function redact(s: string): string {
    return s
        .replace(/mk_[A-Za-z0-9_]+/g, "mk_<redacted>")
        .replace(/("(?:token|sessionToken|session|deviceKey|password|phrase|mnemonic|plaintext|secret|wrapped\w*|seed)"\s*:\s*)"[^"]*"/gi, '$1"<redacted>"')
        .replace(/[A-Za-z0-9_-]{60,}/g, (m) => `${m.slice(0, 8)}…(${m.length})`);
}

const lines: string[] = [];
function log(line: string) {
    lines.push(line);
    if (HTTP_LOG) fs.appendFileSync(HTTP_LOG, line + "\n");
}

const evidence: Record<string, unknown[]> = {};
let current = "setup";
function note(what: string, data?: unknown) {
    (evidence[current] ??= []).push(data === undefined ? what : { what, data: JSON.parse(redact(JSON.stringify(data ?? null))) });
    log(`[${current}] NOTE ${what}${data === undefined ? "" : " " + redact(JSON.stringify(data)).slice(0, 600)}`);
}

function errInfo(err: unknown): Record<string, unknown> {
    const e = err as { name?: string; message?: string; status?: number; body?: unknown; successor?: string; refused?: number; limitBytes?: number; usedBytes?: number; cause?: unknown; recovery?: unknown };
    return {
        name: e?.name,
        message: redact(String(e?.message ?? err)).slice(0, 500),
        status: e?.status,
        body: e?.body === undefined ? undefined : JSON.parse(redact(JSON.stringify(e.body))),
        successor: e?.successor,
        refused: e?.refused,
        limitBytes: e?.limitBytes,
        usedBytes: e?.usedBytes,
        cause: e?.cause ? redact(String((e.cause as Error)?.message ?? e.cause)).slice(0, 300) : undefined,
        hasRecovery: !!e?.recovery,
    };
}

function loggingFetch(actor: string): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const method = init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET");
        const p = redact(url.replace(BASE_URL, ""));
        const t0 = Date.now();
        let res: Response;
        try {
            res = await fetch(input, init);
        } catch (err) {
            log(`[${current}] ${actor} ${method} ${p} -> NETWORK ERROR ${redact(String(err))}`);
            throw err;
        }
        let tail = "";
        if (res.status >= 400) {
            const text = await res.clone().text().catch(() => "");
            tail = " " + redact(text).slice(0, 400);
        }
        log(`[${current}] ${actor} ${method} ${p} -> ${res.status} (${Date.now() - t0}ms)${tail}`);
        return res;
    }) as typeof fetch;
}

// ---------------------------------------------------------------------------------------------------------------
// Clients and accounts
// ---------------------------------------------------------------------------------------------------------------

interface Actor {
    client: Client;
    sessions: MemorySessionStore;
    token: () => string;
}

function newActor(label: string, apiKey?: string): Actor {
    const sessions = new MemorySessionStore();
    const client = new Client({
        baseUrl: BASE_URL,
        apiKey,
        circuits: { wasmUrl, zkeyUrl },
        sessionStore: sessions,
        sharesStore: memorySharesStore(),
        fetch: loggingFetch(label),
        offline: { enabled: false },
    });
    return {
        client,
        sessions,
        token: () => {
            const s = sessions.load() as { token?: string } | null;
            if (!s?.token) throw new Error(`${label}: no session token`);
            return s.token;
        },
    };
}

interface SmokeState {
    owner?: { username: string; password: string };
    app?: { appId: string; pk: string };
}

function loadState(): SmokeState {
    if (!STATE_FILE) return {};
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as SmokeState;
    } catch {
        return {};
    }
}
function saveState(s: SmokeState) {
    if (STATE_FILE) fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
}

async function raw(method: string, p: string, headers: Record<string, string>, body?: unknown) {
    const res = await loggingFetch("raw")(`${BASE_URL}${p}`, {
        method,
        headers: { "Content-Type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: unknown = text;
    try {
        data = JSON.parse(text);
    } catch {
        /* text */
    }
    return { status: res.status, data };
}

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const MB = 1024 * 1024;

// ---------------------------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------------------------

describe.skipIf(!RUN || !circuitsPresent)("shared folders — staging e2e", () => {
    const state = loadState();
    const stamp = Date.now().toString(36);
    let pk = "";
    let owner: Actor;
    let ownerName = "";
    let guest: Actor;
    let guestName = "";
    let guestRecoveryCode = "";
    const publicPassword = `pw-one-${stamp}`;
    const newPassword = `pw-two-${stamp}`;
    let pub: Share;
    let priv: Share;
    let pubOriginalId = "";

    beforeAll(async () => {
        current = "setup";
        log(`=== run ${new Date().toISOString()} base=${BASE_URL}`);
        // Owner account: reuse from state, else register.
        if (!state.owner) {
            const username = `smk${stamp}`.slice(0, 32);
            const password = `Smoke-${crypto.randomUUID()}`;
            const boot = newActor("owner-boot");
            await boot.client.auth.zk.register({ username, password, email: null, login: true });
            state.owner = { username, password };
            saveState(state);
            note("registered owner", { username });
        }
        ownerName = state.owner.username;
        if (!state.app) {
            const boot = newActor("owner-boot");
            await boot.client.auth.zk.login(state.owner.username, state.owner.password);
            const bearer = { Authorization: `Bearer ${boot.token()}` };
            const b = await raw("POST", "/api/developer/bootstrap", bearer, { email: `${state.owner.username}@example.com` });
            note("developer bootstrap", { status: b.status });
            if (b.status >= 400 && b.status !== 409) throw new Error(`bootstrap failed ${b.status} ${redact(JSON.stringify(b.data))}`);
            const a = await raw("POST", "/api/apps", bearer, { slug: `smk${stamp}`.slice(0, 32) });
            if (a.status >= 400) throw new Error(`app create failed ${a.status} ${redact(JSON.stringify(a.data))}`);
            const d = a.data as { appId: string; keys: Array<{ env: string; type: string; plaintext: string }> };
            const key = d.keys.find((k) => k.env === "test" && k.type === "pk") ?? d.keys.find((k) => k.type === "pk");
            if (!key) throw new Error("no publishable key in app create response");
            state.app = { appId: d.appId, pk: key.plaintext };
            saveState(state);
            note("created app", { appId: d.appId, keyEnv: key.env });
        }
        pk = state.app.pk;
        owner = newActor("owner", pk);
        await owner.client.auth.zk.login(state.owner.username, state.owner.password);
        note("owner signed in", { username: ownerName, appId: state.app.appId });
    }, 300_000);

    afterAll(() => {
        if (EVIDENCE) fs.writeFileSync(EVIDENCE, JSON.stringify(evidence, null, 2));
    });

    it("1. owner creates a PUBLIC share (5 MB, password) and a PRIVATE share", async () => {
        current = "s1";
        pub = await owner.client.shares.create({ kind: "public", name: `Smoke Public ${stamp}`, limitBytes: 5 * MB, password: publicPassword });
        pubOriginalId = pub.spaceId;
        const pubInfo = await pub.info();
        note("public share", { spaceId: pub.spaceId, info: pubInfo });
        priv = await owner.client.shares.create({ kind: "private", name: `Smoke Private ${stamp}`, limitBytes: 5 * MB });
        const privInfo = await priv.info();
        note("private share", { spaceId: priv.spaceId, info: privInfo });
        expect(pubInfo.kind).toBe("public");
        expect(pubInfo.limitBytes).toBe(5 * MB);
        expect(privInfo.kind).toBe("private");
        const listed = await owner.client.shares.list();
        note("owner shares.list", listed);
        expect(listed.map((s) => s.spaceId)).toEqual(expect.arrayContaining([pub.spaceId, priv.spaceId]));
        const publicInfo = await raw("GET", `/api/shares/${pub.spaceId}/public`, { "X-Muhkoo-Key": pk });
        note("GET /public (app key only)", publicInfo);
        expect(publicInfo.status).toBe(200);
    }, 300_000);

    it("2. owner writes, lists, reads, renames, deletes files in the public share", async () => {
        current = "s2";
        await pub.write("hello.txt", enc("hello from the owner"), { type: "text/plain" });
        await pub.write("docs/notes.md", enc("# notes"), { type: "text/markdown" });
        await pub.write("tmp.txt", enc("to be deleted"));
        let root = await pub.list();
        note("list after writes", root);
        expect(root.map((e) => e.name)).toEqual(["docs", "hello.txt", "tmp.txt"]);
        expect(root.find((e) => e.name === "hello.txt")!.uploader).toBe(ownerName);
        expect(dec(await pub.read("hello.txt"))).toBe("hello from the owner");
        await pub.rename("docs/notes.md", "docs/renamed.md");
        expect((await pub.list("docs")).map((e) => e.name)).toEqual(["renamed.md"]);
        expect(dec(await pub.read("docs/renamed.md"))).toBe("# notes");
        await pub.delete("tmp.txt");
        root = await pub.list();
        note("list after rename+delete", root);
        expect(root.map((e) => e.name)).toEqual(["docs", "hello.txt"]);
        note("usage", await pub.usage());
    }, 300_000);

    it("3. a signed-out client joins with the password as a quiet guest", async () => {
        current = "s3";
        guest = newActor("guest", pk);
        let wrong: unknown = null;
        try {
            await guest.client.shares.joinWithPassword(pub.spaceId, { password: "definitely-wrong", name: "Sam" });
        } catch (err) {
            wrong = err;
        }
        note("wrong password error", errInfo(wrong));
        expect(wrong).toBeInstanceOf(SharePasswordError);

        const { share, recovery } = await guest.client.shares.joinWithPassword(pub.spaceId, { password: publicPassword, name: "Sam" });
        guestName = recovery?.username ?? "";
        guestRecoveryCode = recovery?.code ?? "";
        note("joined", { spaceId: share.spaceId, recoveryNonNull: !!recovery, guestUsername: guestName, codeWords: recovery?.phrase.split(" ").length });
        expect(recovery).not.toBeNull();
        expect(guestName).toMatch(/^g-/);
        const files = await share.list();
        note("guest list", files);
        expect(files.map((e) => e.name)).toEqual(expect.arrayContaining(["docs", "hello.txt"]));
        expect(dec(await share.read("hello.txt"))).toBe("hello from the owner");
        await share.write("from-sam.txt", enc("hi, Sam here"));
        const after = await share.list();
        const mine = after.find((e) => e.name === "from-sam.txt");
        note("guest's own file", mine);
        expect(mine?.uploader).toBe(guestName);
        expect(mine?.uploaderName).toBe("Sam");
        const info = await pub.info();
        note("share info after admit", { members: info.members, names: info.names });
        expect(info.members).toContain(guestName);
    }, 300_000);

    it("4. guest cannot delete the owner's file, can delete its own; owner can delete the guest's", async () => {
        current = "s4";
        const gShare = await guest.client.shares.open(pub.spaceId);
        let sdkErr: unknown = null;
        try {
            await gShare.delete("hello.txt");
        } catch (err) {
            sdkErr = err;
        }
        note("SDK delete of owner's file by guest", errInfo(sdkErr));
        expect(sdkErr).toBeTruthy();

        // The server must refuse too, not only the SDK's pre-check.
        const files = (await raw("GET", `/api/spaces/${pub.spaceId}/files`, { "X-Muhkoo-Key": pk, "X-Muhkoo-Session": guest.token() })).data as {
            files: Array<{ id: string; path?: string; name?: string; owner?: string | null }>;
        };
        note("raw GET /files as guest", files.files.map((f) => ({ id: f.id, path: f.path, owner: f.owner })));
        const hello = files.files.find((f) => (f.path ?? f.name ?? "").replace(/^\//, "") === "hello.txt");
        expect(hello).toBeTruthy();
        const rawDel = await raw("DELETE", `/api/spaces/${pub.spaceId}/files/${encodeURIComponent(hello!.id)}`, { "X-Muhkoo-Key": pk, "X-Muhkoo-Session": guest.token() });
        note("raw DELETE of owner's file by guest", rawDel);
        expect(rawDel.status).toBeGreaterThanOrEqual(400);
        expect((await pub.list()).map((e) => e.name)).toContain("hello.txt");

        await gShare.write("sam-temp.txt", enc("temporary"));
        await gShare.delete("sam-temp.txt");
        expect((await gShare.list()).map((e) => e.name)).not.toContain("sam-temp.txt");
        note("guest deleted its own sam-temp.txt");

        await gShare.write("sam-for-owner.txt", enc("owner will delete this"));
        await pub.delete("sam-for-owner.txt");
        const left = (await pub.list()).map((e) => e.name);
        note("after owner deleted guest file", left);
        expect(left).not.toContain("sam-for-owner.txt");
    }, 300_000);

    it("5. exceeding the 5 MB limit returns ShareFullError with refused", async () => {
        current = "s5";
        const big = new Uint8Array(6 * MB);
        for (let i = 0; i < big.length; i += 65536) crypto.getRandomValues(big.subarray(i, Math.min(i + 65536, big.length)));
        let err: unknown = null;
        try {
            await pub.writeMany([
                { path: "big.bin", data: big },
                { path: "after-big.txt", data: enc("never") },
            ]);
        } catch (e) {
            err = e;
        }
        note("writeMany over the limit", errInfo(err));
        note("usage after", await pub.usage());
        expect(err).toBeInstanceOf(ShareFullError);
        expect((err as ShareFullError).refused).toBe(2);
        expect((await pub.list()).map((e) => e.name)).not.toContain("big.bin");
    }, 300_000);

    it("6. owner invites the guest to the PRIVATE share and the guest opens it", async () => {
        current = "s6";
        await priv.write("private.txt", enc("members only"));
        await owner.client.shares.invite(priv.spaceId, guestName);
        note("invited", { username: guestName });
        const gPriv = await guest.client.shares.open(priv.spaceId);
        const files = await gPriv.list();
        note("guest lists private share", files);
        expect(files.map((e) => e.name)).toContain("private.txt");
        expect(dec(await gPriv.read("private.txt"))).toBe("members only");
        const gList = await guest.client.shares.list();
        note("guest shares.list", gList);
        expect(gList.map((s) => s.spaceId)).toEqual(expect.arrayContaining([pub.spaceId, priv.spaceId]));
    }, 300_000);

    it("7. changePassword moves the share; the guest re-admits as the same account and keeps its file", async () => {
        current = "s7";
        const before = await pub.list();
        const moved = await owner.client.shares.changePassword(pub.spaceId, newPassword);
        note("rotated", { from: pubOriginalId, to: moved.spaceId });
        expect(moved.spaceId).not.toBe(pubOriginalId);
        const oldInfo = await raw("GET", `/api/shares/${pubOriginalId}`, { "X-Muhkoo-Key": pk, "X-Muhkoo-Session": owner.token() });
        note("old share info", oldInfo);
        const after = await moved.list();
        note("files after rotation", after);
        expect(after.map((e) => [e.name, e.uploader])).toEqual(before.map((e) => [e.name, e.uploader]));
        const newInfo = await moved.info();
        note("new share info", { members: newInfo.members, names: newInfo.names, usedBytes: newInfo.usedBytes });
        pub = moved;

        let closed: unknown = null;
        try {
            await guest.client.shares.open(pubOriginalId);
        } catch (err) {
            closed = err;
        }
        note("guest open(old id)", errInfo(closed));
        expect(closed).toBeInstanceOf(ShareClosedError);
        expect((closed as ShareClosedError).successor).toBe(moved.spaceId);

        const { share, recovery } = await guest.client.shares.joinWithPassword(pubOriginalId, { password: newPassword, name: "Sam" });
        note("guest re-joined", { spaceId: share.spaceId, recoveryUsername: recovery?.username ?? null });
        expect(share.spaceId).toBe(moved.spaceId);
        const gFiles = await share.list();
        const mine = gFiles.find((e) => e.name === "from-sam.txt");
        note("guest's file after re-admit", mine);
        expect(mine?.uploader).toBe(guestName);
        expect(mine?.canChange).toBe(true);
        expect(dec(await share.read("from-sam.txt"))).toBe("hi, Sam here");
        await share.delete("from-sam.txt");
        expect((await moved.list()).map((e) => e.name)).not.toContain("from-sam.txt");
        note("guest deleted its own file in the successor");
    }, 300_000);

    it("8. shareFolder turns a personal VFS folder into a link listed under /Home/Shared", async () => {
        current = "s8";
        const dir = `/Smoke${stamp}/Folder`;
        await owner.client.vfs.writeFile(`${dir}/a.txt`, enc("alpha"), { type: "text/plain" });
        await owner.client.vfs.writeFile(`${dir}/b.txt`, enc("bravo"), { type: "text/plain" });
        note("wrote personal files", (await owner.client.vfs.list(dir)).map((e) => ({ name: e.name, kind: e.kind })));
        const share = await owner.client.shares.shareFolder(dir, { kind: "private", limitBytes: 5 * MB, name: `Smoke Folder ${stamp}` });
        note("shareFolder", { spaceId: share.spaceId });
        const link = await owner.client.vfs.readLink(dir);
        note("readLink", link);
        expect(link.spaceId).toBe(share.spaceId);
        expect((await owner.client.vfs.stat(dir)).kind).toBe("link");
        const shared = await owner.client.vfs.list("/Home/Shared");
        note("/Home/Shared", shared.map((e) => ({ name: e.name, kind: e.kind, path: e.path })));
        expect(shared.map((e) => e.name)).toContain(`Smoke Folder ${stamp}`);
        expect(dec(await owner.client.vfs.readFile(`${dir}/a.txt`))).toBe("alpha");
        expect(dec(await owner.client.vfs.readFile(`${dir}/b.txt`))).toBe("bravo");
        expect((await share.list()).map((e) => e.name)).toEqual(["a.txt", "b.txt"]);
        expect(dec(await owner.client.vfs.readFile(`/Home/Shared/Smoke Folder ${stamp}/b.txt`))).toBe("bravo");
    }, 300_000);

    it("9. restoreGuest(code) on a fresh client signs in as the same guest", async () => {
        current = "s9";
        expect(guestRecoveryCode).not.toBe("");
        const other = newActor("guest2", pk);
        const user = await other.client.shares.restoreGuest(guestRecoveryCode);
        note("restored", { username: user.username });
        expect(user.username).toBe(guestName);
        const s = await other.client.shares.open(priv.spaceId);
        expect((await s.list()).map((e) => e.name)).toContain("private.txt");
        note("restored guest opened the private share");
    }, 300_000);
});
