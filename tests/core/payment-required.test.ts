/**
 * Refusals for payment (accelerator spec 2026-10-06-paid-accounts-and-past-due, B8). A 402 whose body
 * carries one of three codes is a `PaymentRequiredError`, wherever the SDK reads an accelerator
 * response. Every other error stays what it was.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { HttpClient, HttpError } from "../../src/core/HttpClient";
import { Client } from "../../src/core/Client";
import { SessionState } from "../../src/core/Session";
import { PaymentRequiredError, type PaymentRequiredCode } from "../../src/core/PaymentRequiredError";
import { ShardClient, type ShardByteCache } from "../../src/storage/transport/ShardClient";
import { SharedSpaceClient } from "../../src/storage/transport/SharedSpaceClient";
import { PersonalSpaceClient } from "../../src/personal/PersonalSpaceClient";
import type { FileManifest } from "../../src/storage/types";

const BASE_URL = "http://localhost:8787";
const PORTAL = "https://portal.staging.muhkoo.dev/upgrade?return=https%3A%2F%2Fcloud-drive.apps.staging.muhkoo.dev";
// The wire contract, spelled out: these strings are shared with the accelerator, the portal and Cloud Drive.
const CODES: PaymentRequiredCode[] = ["user_plan_required", "user_payment_past_due", "owner_payment_past_due"];

/** A response with `status` and `body`, sent as JSON unless it is a string. */
function reply(status: number, body: unknown): Response {
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

/** A fetch that answers every request with `status` and `body`. */
function answering(status: number, body: unknown): typeof fetch {
    return (async () => reply(status, body)) as unknown as typeof fetch;
}

/** What a promise rejected with, or "resolved". */
function failure(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(() => "resolved", (err: unknown) => err);
}

const http = (fetchFn: typeof fetch) => new HttpClient({ baseUrl: BASE_URL, getSessionToken: () => "tok", fetch: fetchFn });

describe("HttpClient — refusals for payment", () => {
    it.each(CODES)("throws PaymentRequiredError for a 402 with code %s, with the server's sentence and link", async (code) => {
        const body = { error: "Cloud Drive is for paid Muhkoo plans.", code, upgradeUrl: PORTAL };
        const err = await failure(http(answering(402, body)).post("/api/personal/c/kv/k", { value: 1 }));
        expect(err).toBeInstanceOf(PaymentRequiredError);
        expect(err).toBeInstanceOf(HttpError);
        expect(err).toMatchObject({ name: "PaymentRequiredError", status: 402, code, upgradeUrl: PORTAL, body });
        expect((err as Error).message).toBe("Cloud Drive is for paid Muhkoo plans.");
    });

    it.each([
        ["quotaExceeded", { error: "KV write quota exceeded for the free tier — upgrade to continue", quotaExceeded: true, metric: "kv_write", upgradeUrl: "/api/developer/billing/checkout" }],
        ["requiresPaidTier", { error: "Serverless functions require a paid plan", requiresPaidTier: true, tier: "free", upgradeUrl: "/api/developer/billing/checkout" }],
        ["freeTierFull", { error: "The free tier is full", freeTierFull: true }],
        ["a code it does not know", { error: "Refused", code: "some_future_code" }],
    ])("keeps a 402 with %s a plain HttpError", async (_label, body) => {
        const err = await failure(http(answering(402, body)).post("/api/db/notes", {}));
        expect(err).toBeInstanceOf(HttpError);
        expect(err).not.toBeInstanceOf(PaymentRequiredError);
        expect(err).toMatchObject({ status: 402, body, message: body.error });
    });

    it("maps only a 402: a 403 carrying a payment code stays a plain HttpError", async () => {
        const err = await failure(http(answering(403, { error: "Forbidden", code: "user_plan_required" })).get("/api/app/access"));
        expect(err).toBeInstanceOf(HttpError);
        expect(err).not.toBeInstanceOf(PaymentRequiredError);
        expect(err).toMatchObject({ status: 403 });
    });

    it("keeps a 402 without a JSON body a plain HttpError", async () => {
        const err = await failure(http(answering(402, "Payment Required")).post("/api/shards/x", {}));
        expect(err).toBeInstanceOf(HttpError);
        expect(err).not.toBeInstanceOf(PaymentRequiredError);
    });

    it.each([
        ["a relative path", "/api/developer/billing/checkout"],
        ["a script URL", "javascript:alert(1)"],
        ["a protocol-relative URL", "//portal.example/upgrade"],
        ["a number", 7],
    ])("leaves upgradeUrl unset when the server sends %s", async (_label, upgradeUrl) => {
        const err = await failure(http(answering(402, { error: "Upgrade", code: "user_plan_required", upgradeUrl })).post("/x", {}));
        expect(err).toBeInstanceOf(PaymentRequiredError);
        expect((err as PaymentRequiredError).upgradeUrl).toBeUndefined();
    });

    it("names the code when the server sends no sentence", async () => {
        const err = await failure(http(answering(402, { code: "owner_payment_past_due" })).post("/x", {}));
        expect(err).toBeInstanceOf(PaymentRequiredError);
        expect(err).toMatchObject({ code: "owner_payment_past_due", message: "Payment required (owner_payment_past_due)" });
    });
});

describe("client.vfs — a refusal for payment reaches the app as it came", () => {
    /** A drive whose accelerator refuses every new personal-KV key and every new Space, as a paid-only app does for a Free user. */
    async function refusingDrive(): Promise<Client> {
        const kv = new Map<string, unknown>();
        const refusal = { error: "Cloud Drive is for paid Muhkoo plans.", code: "user_plan_required", upgradeUrl: PORTAL };
        const fetchFn = (async (input: RequestInfo | URL) => {
            const url = new URL(String(input));
            const key = url.pathname.match(/^\/api\/personal\/[^/]+\/kv\/([^/]+)(\/get)?$/);
            if (key && key[2]) return reply(200, { value: kv.get(decodeURIComponent(key[1])) ?? null });
            if (key || url.pathname.endsWith("/metadata")) return reply(402, refusal);
            return reply(200, { ok: true });
        }) as typeof fetch;
        const client = new Client({ baseUrl: BASE_URL, apiKey: "mk_test_pk_x", fetch: fetchFn, offline: { enabled: false } });
        const session = (client as unknown as { session: SessionState }).session;
        await session.setSession({ token: "tok", username: "alice", commitment: "c-alice" });
        session.setSeed(new Uint8Array(32).fill(5));
        return client;
    }

    it("a new folder refused for payment throws PaymentRequiredError, not a VFS error", async () => {
        const err = await failure((await refusingDrive()).vfs.mkdir("/Drive"));
        expect(err).toBeInstanceOf(PaymentRequiredError);
        expect(err).toMatchObject({ code: "user_plan_required", upgradeUrl: PORTAL });
    });

    it("a first upload refused for payment (its content space) throws PaymentRequiredError", async () => {
        const err = await failure((await refusingDrive()).vfs.writeFile("/a.txt", "hi"));
        expect(err).toBeInstanceOf(PaymentRequiredError);
        expect(err).toMatchObject({ code: "user_plan_required" });
    });
});

describe("ShardClient — refusals for payment", () => {
    const HASH = "ab".repeat(32);

    it("throws PaymentRequiredError for a refused shard upload", async () => {
        const shards = new ShardClient({
            baseUrl: BASE_URL,
            fetch: answering(402, { error: "Cloud Drive is for paid Muhkoo plans.", code: "user_plan_required", upgradeUrl: PORTAL }),
        });
        const err = await failure(shards.putShard(HASH, new Uint8Array([1, 2, 3])));
        expect(err).toBeInstanceOf(PaymentRequiredError);
        expect(err).toMatchObject({ code: "user_plan_required", upgradeUrl: PORTAL, message: "Cloud Drive is for paid Muhkoo plans." });
    });

    it("keeps any other refused upload the plain Error it was", async () => {
        const shards = new ShardClient({ baseUrl: BASE_URL, fetch: answering(402, { error: "Storage quota exceeded", quotaExceeded: true }) });
        const err = await failure(shards.putShard(HASH, new Uint8Array([1])));
        expect(err).toBeInstanceOf(Error);
        expect(err).not.toBeInstanceOf(HttpError);
        expect((err as Error).message).toMatch(/^ShardClient\.putShard\([0-9a-f]+\) failed \(402\): /);
    });

    it("hands a background upload refused for payment to the offline queue, its bytes still cached", async () => {
        // A guard: this passed before PaymentRequiredError existed, because every
        // background failure is deferred. It pins that the new error is too.
        const bytes = new Map<string, Uint8Array>();
        const cache: ShardByteCache = { get: async (h) => bytes.get(h) ?? null, put: async (h, b) => void bytes.set(h, b) };
        const deferred: string[] = [];
        const shards = new ShardClient({
            baseUrl: BASE_URL,
            fetch: answering(402, { error: "Cloud Drive can't save changes right now.", code: "owner_payment_past_due" }),
            cache,
            backgroundUpload: true,
            deferUpload: async (h) => void deferred.push(h),
        });
        await shards.putShard(HASH, new Uint8Array([1, 2]));
        await vi.waitFor(() => expect(deferred).toEqual([HASH]));
        expect(bytes.get(HASH)).toEqual(new Uint8Array([1, 2]));
    });
});

describe("SharedSpaceClient — refusals for payment", () => {
    const MANIFEST = { id: "f1" } as unknown as FileManifest;

    it("throws PaymentRequiredError for a refused manifest write", async () => {
        const files = new SharedSpaceClient({
            baseUrl: BASE_URL,
            fetch: answering(402, { error: "Cloud Drive can't save changes right now.", code: "owner_payment_past_due" }),
        });
        const err = await failure(files.writeFileManifest("space-1", MANIFEST));
        expect(err).toBeInstanceOf(PaymentRequiredError);
        expect(err).toMatchObject({ code: "owner_payment_past_due" });
    });

    it("keeps any other refusal the plain Error it was", async () => {
        const files = new SharedSpaceClient({ baseUrl: BASE_URL, fetch: answering(402, { error: "Storage quota exceeded", quotaExceeded: true }) });
        const err = await failure(files.writeFileManifest("space-1", MANIFEST));
        expect(err).not.toBeInstanceOf(HttpError);
        expect((err as Error).message).toBe("SharedSpaceClient.writeFileManifest(f1): Storage quota exceeded");
    });
});

describe("PersonalSpaceClient — refusals for payment", () => {
    afterEach(() => vi.unstubAllGlobals());

    /** A client whose proof step is stubbed out (the proof is not under test), over `fetchFn`. */
    function personal(fetchFn: typeof fetch): PersonalSpaceClient {
        vi.stubGlobal("fetch", fetchFn);
        const client = new PersonalSpaceClient({
            baseUrl: BASE_URL,
            commitment: "1",
            secret: "2",
            salt: "3",
            ecdsaPub: "4",
            ecdsaPubHash: "5",
            circuits: { wasmUrl: "w", zkeyUrl: "z" } as never,
        });
        (client as unknown as { proveFreshChallenge: () => Promise<unknown> }).proveFreshChallenge = async () => ({
            challengeId: "ch",
            proof: {},
            publicSignals: [],
        });
        return client;
    }

    it("throws PaymentRequiredError for a refused put", async () => {
        const client = personal(answering(402, { error: "Cloud Drive is for paid Muhkoo plans.", code: "user_plan_required" }));
        const err = await failure(client.put("notes/n1", { text: "x" }));
        expect(err).toBeInstanceOf(PaymentRequiredError);
        expect(err).toMatchObject({ code: "user_plan_required" });
    });

    it("keeps any other refusal the plain Error it was", async () => {
        const client = personal(answering(402, { error: "KV write quota exceeded", quotaExceeded: true }));
        const err = await failure(client.put("notes/n1", { text: "x" }));
        expect(err).not.toBeInstanceOf(HttpError);
        expect((err as Error).message).toMatch(/^PersonalSpaceClient put\(notes\/n1\) failed \(402\): /);
    });
});
