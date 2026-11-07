/**
 * The shares wire client: each method hits the accelerator's path and verb, `publicInfo` carries the app key and no
 * session, `admit` carries the signed-in session, and every share error code maps to its typed error.
 */
import { describe, it, expect } from "vitest";
import { HttpClient, HttpError } from "../../src/core/HttpClient";
import { PaymentRequiredError } from "../../src/core/PaymentRequiredError";
import {
    SharesClient,
    shareErrorFrom,
    ShareFullError,
    ShareClosedError,
    SharePasswordError,
    SharePasswordRateError,
    ShareMemberLimitError,
    ShareSpaceNotEmptyError,
    ShareSpaceNotReadyError,
    RotationMismatchError,
    RotationInProgressError,
    type ShareInfo,
} from "../../src/shares";
import { realSpaceId } from "./fakeShareServer";

const BASE = "http://localhost:8787";
const INFO: ShareInfo = {
    kind: "private",
    ownerUsername: "ann",
    limitBytes: null,
    usedBytes: 0,
    editPolicy: "own",
    name: "Trip",
    closed: null,
    members: ["ann"],
    names: { ann: "Ann" },
};

interface Call {
    method: string;
    path: string;
    headers: Headers;
    body: unknown;
}

function setup(status: number, body: unknown, extra: Record<string, string> = {}) {
    const calls: Call[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        calls.push({
            method: init?.method ?? "GET",
            path: url.pathname,
            headers: new Headers(init?.headers),
            body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        });
        return new Response(JSON.stringify(body), {
            status,
            headers: { "Content-Type": "application/json", ...extra },
        });
    }) as typeof fetch;
    const http = new HttpClient({ baseUrl: BASE, apiKey: "mk_test_pk_x", getSessionToken: () => "sess", fetch: fetchFn });
    return { shares: new SharesClient(http), calls };
}

/** Space ids the length the SDK makes them (256 characters). */
const ID = realSpaceId("a_b-1");
const NEW = realSpaceId("new1");
const OLD = realSpaceId("old1");

describe("SharesClient routes", () => {
    it("create POSTs /api/shares with the key and session", async () => {
        const { shares, calls } = setup(201, INFO);
        const body = { spaceId: ID, kind: "private" as const, name: "Trip", limitBytes: null, editPolicy: "own" as const };
        expect(await shares.create(body)).toEqual(INFO);
        expect(calls[0]).toMatchObject({ method: "POST", path: "/api/shares", body });
        expect(calls[0].headers.get("X-Muhkoo-Key")).toBe("mk_test_pk_x");
        expect(calls[0].headers.get("X-Muhkoo-Session")).toBe("sess");
    });

    it("list GETs /api/shares and unwraps { shares }", async () => {
        const rows = [{ spaceId: ID, kind: "public", owner: "ann", name: "N" }];
        const { shares, calls } = setup(200, { shares: rows });
        expect(await shares.list()).toEqual(rows);
        expect(calls[0]).toMatchObject({ method: "GET", path: "/api/shares" });
    });

    it("info GETs /api/shares/:id", async () => {
        const { shares, calls } = setup(200, INFO);
        expect(await shares.info(ID)).toEqual(INFO);
        expect(calls[0]).toMatchObject({ method: "GET", path: `/api/shares/${ID}` });
    });

    it("update PATCHes /api/shares/:id", async () => {
        const { shares, calls } = setup(200, INFO);
        await shares.update(ID, { limitBytes: 5, editPolicy: "any" });
        expect(calls[0]).toMatchObject({ method: "PATCH", path: `/api/shares/${ID}`, body: { limitBytes: 5, editPolicy: "any" } });
    });

    it("removeMember DELETEs /api/shares/:id/members/:u, encoding the username", async () => {
        const { shares, calls } = setup(200, { ok: true });
        await shares.removeMember(ID, "bo b");
        expect(calls[0]).toMatchObject({ method: "DELETE", path: `/api/shares/${ID}/members/bo%20b` });
    });

    it("adopt POSTs /api/shares/:new/adopt", async () => {
        const { shares, calls } = setup(200, INFO);
        await shares.adopt(NEW, { from: OLD, remove: ["bob"] });
        expect(calls[0]).toMatchObject({ method: "POST", path: `/api/shares/${NEW}/adopt`, body: { from: OLD, remove: ["bob"] } });
    });

    it("publicInfo GETs /api/shares/:id/public with the key and no session", async () => {
        const pub = { kind: "public", name: "N", ownerUsername: "ann", password: { salt: "s", iterations: 310000 }, closed: null };
        const { shares, calls } = setup(200, pub);
        expect(await shares.publicInfo(ID)).toEqual(pub);
        expect(calls[0]).toMatchObject({ method: "GET", path: `/api/shares/${ID}/public` });
        expect(calls[0].headers.get("X-Muhkoo-Key")).toBe("mk_test_pk_x");
        expect(calls[0].headers.get("X-Muhkoo-Session")).toBeNull();
    });

    it("admit POSTs /api/shares/:id/admit with the key and the session, and no guest header", async () => {
        const { shares, calls } = setup(200, { ok: true });
        const body = { proof: "p", name: "Gus" };
        await expect(shares.admit(ID, body)).resolves.toBeUndefined();
        expect(calls[0]).toMatchObject({ method: "POST", path: `/api/shares/${ID}/admit`, body });
        expect(calls[0].headers.get("X-Muhkoo-Key")).toBe("mk_test_pk_x");
        expect(calls[0].headers.get("X-Muhkoo-Session")).toBe("sess");
        expect(calls[0].headers.get("X-Muhkoo-Guest")).toBeNull();
    });
});

describe("share errors from a response", () => {
    it("throws the typed error from a method", async () => {
        const { shares } = setup(402, { code: "share_full", limitBytes: 10, usedBytes: 9 });
        await expect(shares.info("a")).rejects.toBeInstanceOf(ShareFullError);
    });

    it("keeps other refusals as HttpError / PaymentRequiredError", async () => {
        await expect(setup(404, { error: "nope" }).shares.info("a")).rejects.toBeInstanceOf(HttpError);
        const err = await setup(402, { code: "user_plan_required", error: "x" }).shares.create({
            spaceId: "a", kind: "public", name: "n", limitBytes: null, editPolicy: "own",
        }).catch((e) => e);
        expect(err).toBeInstanceOf(PaymentRequiredError);
    });

    it("reads Retry-After on an admit 429", async () => {
        const { shares } = setup(429, { code: "share_password_rate" }, { "Retry-After": "42" });
        const err = await shares.admit("a", { proof: "p", name: "G" }).catch((e) => e);
        expect(err).toBeInstanceOf(SharePasswordRateError);
        expect(err.retryAfterSeconds).toBe(42);
    });
});

describe("shareErrorFrom", () => {
    it("402 share_full", () => {
        const e = shareErrorFrom(402, { code: "share_full", limitBytes: 10, usedBytes: 9, refused: 3 }) as ShareFullError;
        expect(e).toBeInstanceOf(ShareFullError);
        expect(e).toBeInstanceOf(HttpError);
        expect(e).toMatchObject({ limitBytes: 10, usedBytes: 9, refused: 3, status: 402 });
    });
    it("402 share_full without refused", () => {
        const e = shareErrorFrom(402, { code: "share_full", limitBytes: 10, usedBytes: 9 }) as ShareFullError;
        expect(e.refused).toBe(0);
    });
    it("409 share_closed", () => {
        const e = shareErrorFrom(409, { code: "share_closed", successor: "new1" }) as ShareClosedError;
        expect(e).toBeInstanceOf(ShareClosedError);
        expect(e.successor).toBe("new1");
    });
    it("403 share_password", () => {
        expect(shareErrorFrom(403, { code: "share_password" })).toBeInstanceOf(SharePasswordError);
    });
    it("the rest of the contract table", () => {
        expect(shareErrorFrom(403, { code: "share_member_limit" })).toBeInstanceOf(ShareMemberLimitError);
        expect(shareErrorFrom(409, { code: "share_space_not_empty" })).toBeInstanceOf(ShareSpaceNotEmptyError);
        expect(shareErrorFrom(409, { code: "share_space_not_ready" })).toBeInstanceOf(ShareSpaceNotReadyError);
        expect(shareErrorFrom(409, { code: "rotation_mismatch" })).toBeInstanceOf(RotationMismatchError);
        const r = shareErrorFrom(409, { code: "rotation_in_progress", successor: "n" }) as RotationInProgressError;
        expect(r).toBeInstanceOf(RotationInProgressError);
        expect(r.successor).toBe("n");
        // Removed with the guest-key design: the server never sends these any more.
        for (const [st, code] of [[403, "guest_proof"], [403, "share_guest_limit"], [409, "guest_key_mismatch"]] as const) {
            expect(shareErrorFrom(st, { code })).toBeNull();
        }
        const p = shareErrorFrom(429, { code: "share_password_rate" }, 7) as SharePasswordRateError;
        expect(p).toBeInstanceOf(SharePasswordRateError);
        expect(p.retryAfterSeconds).toBe(7);
    });
    it("anything else is null, including a code on the wrong status and a string body", () => {
        expect(shareErrorFrom(500, { code: "share_full" })).toBeNull();
        expect(shareErrorFrom(402, { code: "user_plan_required" })).toBeNull();
        expect(shareErrorFrom(404, null)).toBeNull();
        expect(shareErrorFrom(409, "not json")).toBeNull();
        expect(shareErrorFrom(409, JSON.stringify({ code: "share_closed", successor: "x" }))).toBeInstanceOf(ShareClosedError);
    });
});
