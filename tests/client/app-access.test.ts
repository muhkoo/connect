/**
 * `client.app.access()` (accelerator spec 2026-10-06-paid-accounts-and-past-due, B6 and B8): whether the
 * signed-in user may add data in this app, over `GET /api/app/access`, and the replay of the writes the
 * offline queue kept after a refusal for payment once the answer is "allowed".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { Client } from "../../src/core/Client";
import { HttpError } from "../../src/core/HttpClient";
import { SessionState } from "../../src/core/Session";
import { PaymentRequiredError } from "../../src/core/PaymentRequiredError";
import { IndexedDbStore } from "../../src/offline/store/IndexedDbStore";
import { pack } from "../../src/offline/clock/HlcTimestamp";

const BASE_URL = "http://test";
const UPGRADE = "https://portal.staging.muhkoo.dev/upgrade?return=https%3A%2F%2Fcloud-drive.apps.staging.muhkoo.dev";

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
});

/** A signed-in Client whose accelerator answers `GET /api/app/access` from `answers`, in turn. */
async function signedIn(answers: Array<{ status?: number; body: unknown }>, offline = false) {
    const asked: Array<{ method: string; url: string; key: string | null; session: string | null }> = [];
    let i = 0;
    const client = new Client({
        baseUrl: BASE_URL,
        apiKey: "mk_test_pk_x",
        offline: offline ? { enabled: true, store: new IndexedDbStore() } : { enabled: false },
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
            const headers = new Headers(init?.headers);
            asked.push({
                method: init?.method ?? "GET",
                url: String(input),
                key: headers.get("X-Muhkoo-Key"),
                session: headers.get("X-Muhkoo-Session"),
            });
            const answer = answers[Math.min(i++, answers.length - 1)];
            return json(answer.body, answer.status ?? 200);
        }) as typeof fetch,
    });
    const session = (client as unknown as { session: SessionState }).session;
    await session.setSession({ token: "tok", username: "alice", commitment: "c-alice" });
    return { client, session, asked };
}

describe("client.app.access()", () => {
    it("asks GET /api/app/access with the app key and the session, and returns the answer", async () => {
        const answer = { paidAccountsOnly: true, allowed: false, reason: "user_plan_required", upgradeUrl: UPGRADE };
        const { client, asked } = await signedIn([{ body: answer }]);

        expect(await client.app.access()).toEqual(answer);
        expect(asked).toEqual([{ method: "GET", url: `${BASE_URL}/api/app/access`, key: "mk_test_pk_x", session: "tok" }]);
    });

    it.each([
        [{ paidAccountsOnly: true, allowed: true }],
        [{ paidAccountsOnly: false, allowed: true }],
        [{ paidAccountsOnly: false, allowed: false, reason: "owner_payment_past_due" }],
        [{ paidAccountsOnly: true, allowed: false, reason: "user_payment_past_due", upgradeUrl: "https://portal.muhkoo.dev/billing" }],
    ])("returns %o as it came", async (answer) => {
        const { client } = await signedIn([{ body: answer }]);
        expect(await client.app.access()).toEqual(answer);
    });

    it("drops a reason it does not know and a link that is not an absolute http(s) URL", async () => {
        const { client } = await signedIn([{ body: { paidAccountsOnly: true, allowed: false, reason: "some_future_code", upgradeUrl: "javascript:alert(1)" } }]);
        expect(await client.app.access()).toEqual({ paidAccountsOnly: true, allowed: false });
    });

    it("reads an answer without `allowed` as allowed: the server enforces the gate whatever this says", async () => {
        const { client } = await signedIn([{ body: { paidAccountsOnly: true } }]);
        expect(await client.app.access()).toEqual({ paidAccountsOnly: true, allowed: true });
    });

    it("re-establishes a stale session once, as every request does", async () => {
        const { client, asked } = await signedIn([
            { status: 401, body: { error: "Session expired" } },
            { body: { paidAccountsOnly: true, allowed: true } },
        ]);
        const recover = vi.spyOn(client.auth.zk, "recover").mockResolvedValue(true);

        expect(await client.app.access()).toEqual({ paidAccountsOnly: true, allowed: true });
        expect(recover).toHaveBeenCalledTimes(1);
        expect(asked).toHaveLength(2);
    });

    it("throws HttpError against an accelerator older than the route", async () => {
        const { client } = await signedIn([{ status: 404, body: { error: "Not found" } }]);
        const err = await client.app.access().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(HttpError);
        expect(err).not.toBeInstanceOf(PaymentRequiredError);
        expect(err).toMatchObject({ status: 404 });
    });

    it("asks the offline queue to send its kept writes each time the answer is allowed, and only then", async () => {
        const { client } = await signedIn([
            { body: { paidAccountsOnly: true, allowed: false, reason: "user_plan_required", upgradeUrl: UPGRADE } },
            { body: { paidAccountsOnly: true, allowed: false, reason: "user_plan_required", upgradeUrl: UPGRADE } },
            { body: { paidAccountsOnly: true, allowed: true } },
            { body: { paidAccountsOnly: true, allowed: true } },
        ]);
        const resume = vi.spyOn(client.offline, "resume").mockResolvedValue();

        await client.app.access();
        await client.app.access();
        expect(resume).not.toHaveBeenCalled();

        await client.app.access();
        expect(resume).toHaveBeenCalledTimes(1);
        await client.app.access();
        expect(resume).toHaveBeenCalledTimes(2);
    });

    it("answers even when sending the kept writes fails, and leaves no rejection unhandled", async () => {
        const { client } = await signedIn([{ body: { paidAccountsOnly: true, allowed: true } }]);
        // A plain function, not a spy: a spy handles the promises it returns, which would hide a missing catch.
        client.offline.resume = () => Promise.reject(new TypeError("Failed to fetch"));
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => void unhandled.push(reason);
        process.on("unhandledRejection", onUnhandled);
        try {
            expect(await client.app.access()).toEqual({ paidAccountsOnly: true, allowed: true });
            await new Promise((resolve) => setTimeout(resolve, 10));   // let an unhandled rejection surface
        } finally {
            process.off("unhandledRejection", onUnhandled);
        }
        expect(unhandled).toEqual([]);
    });

    it("sends a write the queue kept after a refusal for payment once the app is allowed again", async () => {
        const { client, session } = await signedIn([{ body: { paidAccountsOnly: true, allowed: true } }], true);
        session.setIdentity({} as never);
        let paid = false;
        const sent: number[] = [];
        client.offline.registerReplayer("kv", async (e) => {
            if (!paid) throw new PaymentRequiredError("Cloud Drive is for paid Muhkoo plans.", "user_plan_required");
            sent.push((e.args as { n: number }).n);
        });
        try {
            await client.offline.enqueue({ hlc: pack(1, 0, "n"), clientId: "c1", domain: "kv", method: "set", args: { n: 1 } });
            await client.offline.queue.drain();
            expect(await client.offline.queue.pending()).toBe(1);

            paid = true;
            await client.app.access();

            await vi.waitFor(async () => expect(await client.offline.queue.pending()).toBe(0));
            expect(sent).toEqual([1]);
        } finally {
            client.offline.dispose();
        }
    });

    it("never sends a kept write under the next user's session after a sign-out and sign-in in the same tab", async () => {
        // Plan C's upgrade screen: a Free user's write is kept, they sign out, a paid account signs in.
        const { client, session } = await signedIn([{ body: { paidAccountsOnly: true, allowed: true } }], true);
        session.setIdentity({} as never);
        let paid = false;
        const sentAs: Array<string | null> = [];
        client.offline.registerReplayer("kv", async () => {
            if (!paid) throw new PaymentRequiredError("Cloud Drive is for paid Muhkoo plans.", "user_plan_required");
            sentAs.push(session.commitment);
        });
        try {
            await client.offline.enqueue({ hlc: pack(1, 0, "n"), clientId: "c1", domain: "kv", method: "set", args: { n: 1 } });
            await client.offline.queue.drain();                   // alice's write, refused for payment: kept

            await client.auth.zk.logout();
            await session.setSession({ token: "tok-bob", username: "bob", commitment: "c-bob" });
            session.setIdentity({} as never);
            paid = true;
            await client.app.access();
            await client.offline.resume();                        // let whatever access() started finish

            expect(sentAs).toEqual([]);
            expect(await client.offline.queue.pending()).toBe(1);

            await client.auth.zk.logout();                        // alice comes back
            await session.setSession({ token: "tok", username: "alice", commitment: "c-alice" });
            session.setIdentity({} as never);
            await client.app.access();

            await vi.waitFor(async () => expect(await client.offline.queue.pending()).toBe(0));
            expect(sentAs).toEqual(["c-alice"]);
        } finally {
            client.offline.dispose();
        }
    });
});

describe("AppNamespace onAllowed that throws", () => {
    it("still resolves the allowed answer when onAllowed throws synchronously", async () => {
        const { AppNamespace } = await import("../../src/core/namespaces/AppNamespace");
        const http = { get: async () => ({ paidAccountsOnly: false, allowed: true }) } as unknown as import("../../src/core/HttpClient").HttpClient;
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const app = new AppNamespace({
            http,
            onAllowed: (() => {
                throw new Error("boom");
            }) as () => Promise<void>,
        });
        expect(await app.access()).toEqual({ paidAccountsOnly: false, allowed: true });
        await Promise.resolve();
        await Promise.resolve();
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });
});
