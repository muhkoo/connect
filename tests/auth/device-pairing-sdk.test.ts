/**
 * TV device pairing — SDK surface (`client.auth.hosted.*`) + the device's
 * at-rest identity store. Pure unit tests: fake fetch, fake storage, injected
 * sleep. No network, no timers, no snarkjs.
 *
 * What these prove:
 *   - the wire shapes sent to `/api/auth/device*` match the spec, including the
 *     ECDSA possession proof over the exact signing input;
 *   - the verification code shown by BOTH sides is derived LOCALLY — a lying
 *     server can't make the two screens agree;
 *   - the poll loop implements the interval + `slow_down` + jitter + expiry
 *     semantics of spec §9, and never hot-loops;
 *   - a protocol verdict (denied / budget exhausted) is never swallowed by the
 *     transport-retry arm;
 *   - approval posts CIPHERTEXT ONLY, and the device is the only party that can
 *     open it;
 *   - the mandatory commitment check (§10.8) and the re-pair account pin
 *     (§10.2) both fail closed;
 *   - `deviceStore` round-trips a seed, wipes completely, prefers a native
 *     Keystore bridge when present, and degrades instead of throwing when
 *     neither backend exists.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// `generateAuthProof` is the ONLY thing standing between these tests and a real
// Groth16 prove (snarkjs + a wasm/zkey fetch). Everything else in the module —
// notably `buildCommitment`, which the §10.8 check depends on — stays real, so
// the commitment assertions below are genuine.
vi.mock("../../src/auth/proof", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../src/auth/proof")>();
    return {
        ...actual,
        generateAuthProof: vi.fn(async (args: {
            secretHex: string; saltHex: string; ecdsaPubHex: string; nonceHex: string;
        }) => ({
            proof: { pi_a: ["1"], pi_b: [["1"]], pi_c: ["1"], protocol: "groth16", curve: "bn128" },
            publicSignals: ["1", "2", "3"],
            commitment: await actual.buildCommitment(args.secretHex, args.saltHex, args.ecdsaPubHex),
            nonceField: "1",
            ecdsaPubHash: "2",
        })),
    };
});

import {
    HostedAuth,
    DevicePairingError,
    ReauthRequiredError,
    canonicalUserCode,
    formatUserCode,
    type DevicePairingSession,
} from "../../src/core/namespaces/HostedAuth";
import {
    configureDeviceStore,
    persistDeviceIdentity,
    loadDeviceIdentity,
    clearDeviceIdentity,
    hasDeviceIdentity,
    deviceIdentityKey,
    deviceFingerprint,
    deviceIdentityIsEphemeral,
    DeviceStoreUnavailableError,
    DEVICE_IDENTITY_STORAGE_KEY,
    type DeviceBlobStore,
    type DeviceKeyVault,
} from "../../src/auth/deviceStore";
import { unsealSeedFromDevice, pairingVerificationCode } from "../../src/auth/hostedHandoff";
import { deriveIdentityFromSeed } from "../../src/auth/identity";
import { buildCommitment } from "../../src/auth/proof";
import { exportPublicKeyHex } from "../../src/auth/keys";
import { SessionState } from "../../src/core/Session";

const API = "https://api.test";
const AUTH = "https://auth.test";

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"));

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** localStorage stand-in. */
function memBlobs(): DeviceBlobStore & { map: Map<string, string> } {
    const map = new Map<string, string>();
    return {
        map,
        get: (k) => (map.has(k) ? map.get(k)! : null),
        set: (k, v) => void map.set(k, v),
        remove: (k) => void map.delete(k),
    };
}

/**
 * IndexedDB stand-in. Holds `CryptoKey`s by reference — a real IndexedDB
 * structured-clones them, which no in-process shim reproduces, and the identity
 * of the object is all this store's callers depend on.
 */
function memKeys(): DeviceKeyVault & { map: Map<string, unknown> } {
    const map = new Map<string, unknown>();
    return {
        map,
        get: async (id) => (map.has(id) ? map.get(id)! : null),
        put: async (id, v) => void map.set(id, v),
        destroy: async () => void map.clear(),
    };
}

interface RecordedCall {
    method: string;
    path: string;
    headers: Record<string, string>;
    rawBody?: string;
    body?: any;
}

type Route = (call: RecordedCall) => { status?: number; body?: unknown; headers?: Record<string, string> };

function makeFetch(routes: Record<string, Route | Route[]>) {
    const calls: RecordedCall[] = [];
    const cursors: Record<string, number> = {};
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = (init?.method ?? "GET").toUpperCase();
        const rawBody = typeof init?.body === "string" ? init.body : undefined;
        const call: RecordedCall = {
            method,
            path: url.pathname,
            headers: (init?.headers ?? {}) as Record<string, string>,
            rawBody,
            body: rawBody ? JSON.parse(rawBody) : undefined,
        };
        calls.push(call);

        const key = `${method} ${url.pathname}`;
        const entry = routes[key];
        if (!entry) throw new Error(`no fake route for ${key}`);
        const route = Array.isArray(entry)
            ? entry[Math.min(cursors[key] = (cursors[key] ?? -1) + 1, entry.length - 1)]
            : entry;
        const { status = 200, body = {}, headers = {} } = route(call);
        return new Response(JSON.stringify(body), {
            status,
            headers: { "Content-Type": "application/json", ...headers },
        });
    }) as typeof fetch;
    return { fetchFn, calls };
}

/** Just enough `AuthClient` for the paths under test — including `baseUrl`,
 *  which is how `HostedAuth` resolves the accelerator origin today. */
function fakeAuthClient() {
    return {
        baseUrl: API,
        getChallenge: vi.fn(async (username: string) => ({
            challengeId: "chal-1", nonce: "ab".repeat(16), commitment: "0",
        })),
        authenticate: vi.fn(async (_req: unknown) => ({ token: "tv-session-token", username: "matt" })),
    };
}

interface Harness {
    hosted: HostedAuth;
    session: SessionState;
    auth: ReturnType<typeof fakeAuthClient>;
    calls: RecordedCall[];
    sleeps: number[];
}

function harness(routes: Record<string, Route | Route[]>, opts: { sleeps?: number[] } = {}): Harness {
    const { fetchFn, calls } = makeFetch(routes);
    const session = new SessionState();
    const auth = fakeAuthClient();
    const sleeps = opts.sleeps ?? [];
    const hosted = new HostedAuth({
        auth: auth as any,
        session,
        authBaseUrl: AUTH,
        fetch: fetchFn,
        sleep: async (ms: number, signal?: AbortSignal) => {
            sleeps.push(ms);
            if (signal?.aborted) throw new DevicePairingError("aborted");
        },
    });
    return { hosted, session, auth, calls, sleeps };
}

/** The canonical `POST /device/code` success body. */
function codeBody(over: Record<string, unknown> = {}) {
    return {
        device_code: "S0RRRC0zTVhS.7f3a",
        user_code: "K7QD-3MXR",
        verification_uri: `${AUTH}/link`,
        verification_uri_complete: `${AUTH}/link?code=K7QD-3MXR`,
        // Deliberately WRONG: the SDK must ignore the server's copy.
        verification_code: "ZZZZ-ZZZZ",
        expires_in: 600,
        interval: 5,
        ...over,
    };
}

beforeEach(() => {
    configureDeviceStore({ keys: memKeys(), blobs: memBlobs() });
});

// ---------------------------------------------------------------------------

describe("user_code canonicalization (spec §4.2)", () => {
    it("uppercases and strips whitespace and dashes", () => {
        expect(canonicalUserCode(" k7qd-3mxr ")).toBe("K7QD3MXR");
        expect(canonicalUserCode("K7Q D3M XR")).toBe("K7QD3MXR");
        expect(formatUserCode(canonicalUserCode("k7qd3mxr"))).toBe("K7QD-3MXR");
    });

    it("rejects excluded glyphs rather than guessing O→0 / I→1", () => {
        for (const bad of ["K7QD3MXO", "K7QD3MXI", "K7QD3MXL", "K7QD3MXU", "K7QD3MX0", "K7QD3MX1"]) {
            expect(() => canonicalUserCode(bad)).toThrow(DevicePairingError);
        }
    });

    it("rejects the wrong length", () => {
        expect(() => canonicalUserCode("K7QD3MX")).toThrow(/8 characters/);
        expect(() => canonicalUserCode("K7QD3MXRR")).toThrow(DevicePairingError);
    });
});

describe("startDevicePairing", () => {
    it("sends the spec's request shape with a verifiable possession proof", async () => {
        const h = harness({ "POST /api/auth/device/code": () => ({ body: codeBody() }) });
        const before = Date.now();
        const session = await h.hosted.startDevicePairing({ appId: "9f3c1a7b8d2e4f60", label: "Living Room TV" });

        expect(h.calls).toHaveLength(1);
        const call = h.calls[0];
        expect(call.path).toBe("/api/auth/device/code");
        expect(call.method).toBe("POST");
        // Exactly the fields §6.1 names — no more, no fewer.
        expect(Object.keys(call.body).sort()).toEqual([
            "app_id", "device_identity_key", "device_label", "device_public_key",
            "device_signature", "issued_at",
        ]);
        expect(call.body.app_id).toBe("9f3c1a7b8d2e4f60");
        expect(call.body.device_label).toBe("Living Room TV");
        expect(call.body.issued_at).toBeGreaterThanOrEqual(before);
        // 65-byte uncompressed SEC1 points.
        expect(unb64(call.body.device_public_key)).toHaveLength(65);
        expect(unb64(call.body.device_public_key)[0]).toBe(0x04);
        expect(unb64(call.body.device_identity_key)).toHaveLength(65);
        // Unauthenticated endpoint — no session header.
        expect(call.headers["X-Muhkoo-Session"]).toBeUndefined();

        // The signature must verify under the advertised identity key, over the
        // exact §4.4 signing input.
        const idKey = await crypto.subtle.importKey(
            "raw", unb64(call.body.device_identity_key), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"],
        );
        const input = `muhkoo-device-pair-v1|${call.body.app_id}|${call.body.device_public_key}|${call.body.issued_at}`;
        expect(await crypto.subtle.verify(
            { name: "ECDSA", hash: "SHA-256" }, idKey,
            unb64(call.body.device_signature), new TextEncoder().encode(input),
        )).toBe(true);
        // ...and not over a different one.
        expect(await crypto.subtle.verify(
            { name: "ECDSA", hash: "SHA-256" }, idKey,
            unb64(call.body.device_signature), new TextEncoder().encode(input + "x"),
        )).toBe(false);

        expect(session.userCode).toBe("K7QD-3MXR");
        expect(session.interval).toBe(5);
        expect(session.expiresAt).toBeGreaterThan(before + 599_000);
    });

    it("derives the verification code LOCALLY and ignores the server's copy", async () => {
        const h = harness({ "POST /api/auth/device/code": () => ({ body: codeBody() }) });
        const session = await h.hosted.startDevicePairing({ appId: "abc12345" });
        expect(session.verificationCode).not.toBe("ZZZZ-ZZZZ");
        expect(session.verificationCode).toBe(await pairingVerificationCode(session.devicePublicKeyB64));
        expect(session.verificationCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    });

    it("falls back to a UA-derived label and builds the QR URI when the server omits it", async () => {
        const h = harness({
            "POST /api/auth/device/code": () => ({
                body: codeBody({ verification_uri: undefined, verification_uri_complete: undefined }),
            }),
        });
        const session = await h.hosted.startDevicePairing({ appId: "abc12345" });
        expect(h.calls[0].body.device_label).toBe("TV");
        expect(session.verificationUri).toBe(`${AUTH}/link`);
        expect(session.verificationUriComplete).toBe(`${AUTH}/link?code=K7QD-3MXR`);
    });

    it("surfaces a server error as a typed DevicePairingError carrying the machine code", async () => {
        const h = harness({
            "POST /api/auth/device/code": () => ({
                status: 429, body: { error: "rate_limited", message: "Slow down." }, headers: { "Retry-After": "42" },
            }),
        });
        await expect(h.hosted.startDevicePairing({ appId: "abc12345" })).rejects.toMatchObject({
            name: "DevicePairingError", reason: "rate_limited", code: "rate_limited", status: 429, retryAfter: 42,
            message: "Slow down.",
        });
    });
});

describe("accelerator origin resolution", () => {
    async function originFor(deps: Partial<ConstructorParameters<typeof HostedAuth>[0]>) {
        const seen: string[] = [];
        const fetchFn = (async (input: RequestInfo | URL) => {
            seen.push(String(input));
            return new Response(JSON.stringify(codeBody()), {
                status: 200, headers: { "Content-Type": "application/json" },
            });
        }) as typeof fetch;
        const hosted = new HostedAuth({
            auth: { baseUrl: API } as any,
            session: new SessionState(),
            authBaseUrl: AUTH,
            fetch: fetchFn,
            ...deps,
        } as any);
        await hosted.startDevicePairing({ appId: "abc12345" });
        return seen[0];
    }

    it("prefers an explicit apiBaseUrl (trailing slash tolerated)", async () => {
        expect(await originFor({ apiBaseUrl: "https://api.staging.muhkoo.dev/" }))
            .toBe("https://api.staging.muhkoo.dev/api/auth/device/code");
    });

    it("falls back to the AuthClient's base URL — which is what Client wires today", async () => {
        expect(await originFor({})).toBe(`${API}/api/auth/device/code`);
    });

    it("last resort: maps the auth SPA host to the API host, never a hard-coded prod default", async () => {
        expect(await originFor({ auth: {} as any, authBaseUrl: "https://auth.staging.muhkoo.dev" }))
            .toBe("https://api.staging.muhkoo.dev/api/auth/device/code");
    });
});

describe("pollDevicePairing status mapping (spec §6.2)", () => {
    async function start(pollRoutes: Route | Route[]) {
        const h = harness({
            "POST /api/auth/device/code": () => ({ body: codeBody() }),
            "POST /api/auth/device/token": pollRoutes,
        });
        const session = await h.hosted.startDevicePairing({ appId: "abc12345" });
        return { h, session };
    }

    it("pending", async () => {
        const { h, session } = await start(() => ({ body: { status: "pending", interval: 5, expires_in: 431 } }));
        await expect(h.hosted.pollDevicePairing(session)).resolves.toEqual({
            status: "pending", interval: 5, expiresIn: 431,
        });
        expect(h.calls[1].body).toEqual({ device_code: session.deviceCode });
    });

    it("slow_down (429) carries the new interval and Retry-After", async () => {
        const { h, session } = await start(() => ({
            status: 429, body: { error: "slow_down", message: "Too fast.", interval: 10 },
            headers: { "Retry-After": "10" },
        }));
        await expect(h.hosted.pollDevicePairing(session)).resolves.toEqual({
            status: "slow_down", interval: 10, retryAfter: 10,
        });
    });

    it("expired_token (401) → expired, access_denied (403) → denied", async () => {
        const a = await start(() => ({ status: 401, body: { error: "expired_token", message: "gone" } }));
        await expect(a.h.hosted.pollDevicePairing(a.session)).resolves.toEqual({ status: "expired" });
        const b = await start(() => ({ status: 403, body: { error: "access_denied", message: "no" } }));
        await expect(b.h.hosted.pollDevicePairing(b.session)).resolves.toEqual({ status: "denied" });
    });

    it("too_many_requests (429) is terminal, not a status", async () => {
        const { h, session } = await start(() => ({
            status: 429, body: { error: "too_many_requests", message: "budget gone" },
        }));
        await expect(h.hosted.pollDevicePairing(session)).rejects.toMatchObject({
            reason: "rate_limited", code: "too_many_requests",
        });
    });

    it("refuses to poll a cancelled session", async () => {
        const { h, session } = await start(() => ({ body: { status: "pending" } }));
        h.hosted.cancelDevicePairing(session);
        expect(session.deviceCode).toBe("");
        await expect(h.hosted.pollDevicePairing(session)).rejects.toMatchObject({ reason: "aborted" });
    });
});

describe("waitForDevicePairing backoff (spec §9)", () => {
    // The injected sleep is instantaneous, so wall-clock time never advances and
    // the loop would spin until `expiresAt` in real seconds. Drive a VIRTUAL
    // clock instead: every simulated sleep moves `Date.now()` forward by exactly
    // the amount slept, which is also what makes the expiry assertions exact.
    let clock: ReturnType<typeof vi.spyOn> | null = null;
    afterEach(() => { clock?.mockRestore(); clock = null; });

    async function startWait(pollRoutes: Route[]) {
        const sleeps: number[] = [];
        const origin = Date.now();
        let offset = 0;
        clock = vi.spyOn(Date, "now").mockImplementation(() => origin + offset);

        const { fetchFn, calls } = makeFetch({
            "POST /api/auth/device/code": () => ({ body: codeBody() }),
            "POST /api/auth/device/token": pollRoutes,
        });
        const session0 = new SessionState();
        const hosted = new HostedAuth({
            auth: fakeAuthClient() as any,
            session: session0,
            authBaseUrl: AUTH,
            fetch: fetchFn,
            sleep: async (ms: number, signal?: AbortSignal) => {
                sleeps.push(ms);
                offset += ms;
                if (signal?.aborted) throw new DevicePairingError("aborted");
            },
        });
        const session = await hosted.startDevicePairing({ appId: "abc12345" });
        return { h: { hosted, calls }, session, sleeps };
    }

    const pending = (interval: number): Route => () => ({ body: { status: "pending", interval, expires_in: 500 } });
    const slowDown = (interval: number, retryAfter: number): Route => () => ({
        status: 429, body: { error: "slow_down", interval }, headers: { "Retry-After": String(retryAfter) },
    });

    it("waits ~interval seconds between polls, with ±10 % jitter", async () => {
        const { h, session, sleeps } = await startWait([
            pending(5), pending(5), pending(5), () => ({ status: 403, body: { error: "access_denied" } }),
        ]);
        await expect(h.hosted.waitForDevicePairing(session)).rejects.toMatchObject({ reason: "denied" });
        expect(sleeps).toHaveLength(4);
        for (const ms of sleeps) {
            expect(ms).toBeGreaterThanOrEqual(4_500);
            expect(ms).toBeLessThanOrEqual(5_500);
        }
        // Jitter must actually vary — a fixed cadence would let a rack of TVs
        // rebooted together stay in lockstep forever.
        expect(new Set(sleeps).size).toBeGreaterThan(1);
    });

    it("adopts the server's interval on pending — the server is authoritative", async () => {
        const { h, session, sleeps } = await startWait([
            pending(5), pending(20), () => ({ status: 403, body: { error: "access_denied" } }),
        ]);
        await expect(h.hosted.waitForDevicePairing(session)).rejects.toMatchObject({ reason: "denied" });
        expect(sleeps[1]).toBeGreaterThanOrEqual(4_500);
        expect(sleeps[1]).toBeLessThanOrEqual(5_500);
        expect(sleeps[2]).toBeGreaterThanOrEqual(18_000);
        expect(sleeps[2]).toBeLessThanOrEqual(22_000);
    });

    it("on slow_down takes max(serverInterval, own+5, retryAfter)", async () => {
        // Server says 6, client's own+5 is 10, Retry-After says 25 → 25 wins.
        const { h, session, sleeps } = await startWait([
            slowDown(6, 25), () => ({ status: 403, body: { error: "access_denied" } }),
        ]);
        await expect(h.hosted.waitForDevicePairing(session)).rejects.toMatchObject({ reason: "denied" });
        expect(sleeps[1]).toBeGreaterThanOrEqual(22_500);
        expect(sleeps[1]).toBeLessThanOrEqual(27_500);
    });

    it("on slow_down never drops below own+5 even if the server lowballs", async () => {
        const { h, session, sleeps } = await startWait([
            slowDown(1, 1), () => ({ status: 403, body: { error: "access_denied" } }),
        ]);
        await expect(h.hosted.waitForDevicePairing(session)).rejects.toMatchObject({ reason: "denied" });
        expect(sleeps[1]).toBeGreaterThanOrEqual(9_000); // 5 + 5, minus jitter
        expect(sleeps[1]).toBeLessThanOrEqual(11_000);
    });

    it("never sleeps past expiry, and stops without waiting for the server to say so", async () => {
        const { h, session, sleeps } = await startWait([pending(5)]);
        session.expiresAt = Date.now() + 1_200;
        await expect(h.hosted.waitForDevicePairing(session)).rejects.toMatchObject({ reason: "expired" });
        expect(sleeps[0]).toBeLessThanOrEqual(1_200);
        // Exactly one poll happened, then the deadline passed.
        expect(h.calls.filter((c) => c.path === "/api/auth/device/token")).toHaveLength(1);
    });

    it("does not poll at all once already expired", async () => {
        const { h, session, sleeps } = await startWait([pending(5)]);
        session.expiresAt = Date.now() - 1;
        await expect(h.hosted.waitForDevicePairing(session)).rejects.toMatchObject({ reason: "expired" });
        expect(sleeps).toHaveLength(0);
        expect(h.calls).toHaveLength(1); // just the start call
    });

    it("backs off exponentially on transport failure, then gives up as `network`", async () => {
        const sleeps: number[] = [];
        let attempts = 0;
        const { fetchFn, calls } = makeFetch({
            "POST /api/auth/device/code": () => ({ body: codeBody() }),
        });
        const failing = (async (input: RequestInfo | URL, init?: RequestInit) => {
            if (String(input).endsWith("/device/token")) {
                attempts++;
                throw new TypeError("Failed to fetch");
            }
            return fetchFn(input, init);
        }) as typeof fetch;

        const hosted = new HostedAuth({
            auth: fakeAuthClient() as any,
            session: new SessionState(),
            authBaseUrl: AUTH,
            fetch: failing,
            sleep: async (ms: number) => void sleeps.push(ms),
        });
        const session = await hosted.startDevicePairing({ appId: "abc12345" });

        await expect(hosted.waitForDevicePairing(session)).rejects.toMatchObject({ reason: "network" });
        expect(attempts).toBe(6); // 5 tolerated, the 6th gives up
        expect(calls).toHaveLength(1);
        // 5 → 10 → 20 → 30 (capped) → 30
        const secs = sleeps.map((ms) => ms / 1000);
        const near = (actual: number, target: number) => {
            expect(actual).toBeGreaterThanOrEqual(target * 0.9);
            expect(actual).toBeLessThanOrEqual(target * 1.1);
        };
        near(secs[0], 5);
        near(secs[1], 10);
        near(secs[2], 20);
        near(secs[3], 30);
        near(secs[4], 30); // capped at MAX_BACKOFF_INTERVAL_S, not 40/80/...
        expect(Math.max(...secs)).toBeLessThanOrEqual(33);
    });

    it("does NOT retry a protocol verdict as if it were a transport failure", async () => {
        const { h, session } = await startWait([
            () => ({ status: 429, body: { error: "too_many_requests" } }),
            () => ({ body: { status: "pending", interval: 5 } }),
        ]);
        await expect(h.hosted.waitForDevicePairing(session)).rejects.toMatchObject({
            reason: "rate_limited", code: "too_many_requests",
        });
        expect(h.calls.filter((c) => c.path === "/api/auth/device/token")).toHaveLength(1);
    });

    it("aborts on signal", async () => {
        const controller = new AbortController();
        const { h, session } = await startWait([() => ({ body: { status: "pending", interval: 5 } })]);
        controller.abort();
        await expect(h.hosted.waitForDevicePairing(session, { signal: controller.signal }))
            .rejects.toMatchObject({ reason: "aborted" });
    });

    it("reports remaining time through onTick", async () => {
        const ticks: Array<[number, number]> = [];
        const { h, session } = await startWait([
            () => ({ body: { status: "pending", interval: 5 } }),
            () => ({ status: 403, body: { error: "access_denied" } }),
        ]);
        await expect(h.hosted.waitForDevicePairing(session, {
            onTick: (remaining, interval) => ticks.push([remaining, interval]),
        })).rejects.toMatchObject({ reason: "denied" });
        expect(ticks).toHaveLength(2);
        expect(ticks[0][1]).toBe(5);
        expect(ticks[0][0]).toBeGreaterThan(ticks[1][0] - 10);
    });
});

describe("approval (hosted-page side)", () => {
    const SEED = new Uint8Array(32).fill(7);

    async function approver(routes: Record<string, Route | Route[]>) {
        const h = harness(routes);
        await h.session.setSession({ token: "approver-session", username: "matt", commitment: "1439" });
        h.session.setSeed(SEED);
        return h;
    }

    it("lookup recomputes the verification code locally and never trusts the server's", async () => {
        const device = await import("../../src/auth/hostedHandoff").then((m) => m.generateDevicePairingKeypair());
        const h = await approver({
            "POST /api/auth/device/lookup": () => ({
                body: {
                    user_code: "K7QD-3MXR",
                    device_public_key: device.publicKeyB64,
                    verification_code: "LIED-CODE",
                    device_fingerprint: "3n1Q",
                    device_label: "Living Room TV",
                    app_id: "9f3c1a7b8d2e4f60",
                    app_label: "muhkoo-theater",
                    is_known_device: false,
                    requires_reauth: true,
                    expires_in: 402,
                },
            }),
        });

        const req = await h.hosted.lookupDevicePairing("k7qd 3mxr");
        expect(h.calls[0].body).toEqual({ user_code: "K7QD-3MXR" });
        expect(h.calls[0].headers["X-Muhkoo-Session"]).toBe("approver-session");
        expect(h.calls[0].headers["Authorization"]).toBeUndefined();
        expect(req.verificationCode).not.toBe("LIED-CODE");
        expect(req.verificationCode).toBe(await pairingVerificationCode(device.publicKeyB64));
        expect(req.isKnownDevice).toBe(false);
        expect(req.requiresReauth).toBe(true);
        expect(req.appLabel).toBe("muhkoo-theater");
    });

    it("posts ciphertext only — the seed is never on the wire, and only the device can open it", async () => {
        const device = await import("../../src/auth/hostedHandoff").then((m) => m.generateDevicePairingKeypair());
        const h = await approver({
            "POST /api/auth/device/approve": () => ({ body: { ok: true, device_id: "3n1Q" } }),
        });

        const res = await h.hosted.approveDevicePairing({
            userCode: "K7QD-3MXR",
            devicePublicKeyB64: device.publicKeyB64,
            verificationCode: "P9RT-K2WD",
            deviceFingerprint: "3n1Q",
            deviceLabel: "Living Room TV",
            appId: "9f3c1a7b8d2e4f60",
            appLabel: "muhkoo-theater",
            isKnownDevice: false,
            requiresReauth: true,
            expiresAt: Date.now() + 400_000,
        }, { label: "Mum's TV" });

        expect(res).toEqual({ deviceId: "3n1Q" });
        const call = h.calls[0];
        expect(Object.keys(call.body).sort()).toEqual(["device_label", "device_public_key", "sealed_keys", "user_code"]);
        expect(call.body.user_code).toBe("K7QD-3MXR");
        expect(call.body.device_public_key).toBe(device.publicKeyB64);
        expect(call.body.device_label).toBe("Mum's TV");

        // No seed material anywhere in the serialized request.
        expect(call.rawBody).not.toContain(b64(SEED));
        expect(call.rawBody).not.toContain(Buffer.from(SEED).toString("hex"));

        // A well-formed v2 envelope, openable ONLY by the device.
        const envelope = JSON.parse(Buffer.from(call.body.sealed_keys, "base64").toString());
        expect(envelope.v).toBe(2);
        expect(envelope).toHaveProperty("epk");
        expect(envelope).toHaveProperty("iv");
        expect(envelope).toHaveProperty("ct");
        const opened = await unsealSeedFromDevice(call.body.sealed_keys, device.privateKey, device.publicKeyB64);
        expect(Buffer.from(opened).equals(Buffer.from(SEED))).toBe(true);
        const other = await import("../../src/auth/hostedHandoff").then((m) => m.generateDevicePairingKeypair());
        await expect(unsealSeedFromDevice(call.body.sealed_keys, other.privateKey, other.publicKeyB64))
            .rejects.toBeTruthy();
    });

    it("refuses to approve without an unlocked seed", async () => {
        const h = harness({});
        await h.session.setSession({ token: "t", username: "matt", commitment: "1" });
        await expect(h.hosted.approveDevicePairing({ devicePublicKeyB64: "x", userCode: "K7QD-3MXR" } as any))
            .rejects.toThrow(/Authenticate the user/);
    });

    it("maps 401 reauth_required to ReauthRequiredError with its ages", async () => {
        const device = await import("../../src/auth/hostedHandoff").then((m) => m.generateDevicePairingKeypair());
        const h = await approver({
            "POST /api/auth/device/approve": () => ({
                status: 401,
                body: {
                    error: "reauth_required", message: "Confirm it's you.",
                    auth_age_seconds: 900, max_age_seconds: 300,
                },
            }),
        });
        const err = await h.hosted.approveDevicePairing({
            userCode: "K7QD-3MXR", devicePublicKeyB64: device.publicKeyB64,
        } as any).catch((e) => e);
        expect(err).toBeInstanceOf(ReauthRequiredError);
        expect(err).toMatchObject({ reason: "reauth_required", authAgeSeconds: 900, maxAgeSeconds: 300 });
    });

    it("surfaces consent_required with its version so the page can re-agree", async () => {
        const device = await import("../../src/auth/hostedHandoff").then((m) => m.generateDevicePairingKeypair());
        const h = await approver({
            "POST /api/auth/device/approve": () => ({
                status: 409, body: { error: "consent_required", message: "Accept the terms.", version: "2026-06-01" },
            }),
        });
        const err = await h.hosted.approveDevicePairing({
            userCode: "K7QD-3MXR", devicePublicKeyB64: device.publicKeyB64,
        } as any).catch((e) => e);
        expect(err).toMatchObject({ code: "consent_required", status: 409 });
        expect(err.details.version).toBe("2026-06-01");
    });

    it("deny sends only the code, with no re-auth and no consent gate", async () => {
        const h = await approver({ "POST /api/auth/device/deny": () => ({ body: { ok: true } }) });
        await h.hosted.denyDevicePairing("k7qd-3mxr");
        expect(h.calls[0].path).toBe("/api/auth/device/deny");
        expect(h.calls[0].body).toEqual({ user_code: "K7QD-3MXR" });
    });

    it("rejects a malformed code before it reaches the network", async () => {
        const h = await approver({});
        await expect(h.hosted.denyDevicePairing("nope")).rejects.toMatchObject({ reason: "invalid_user_code" });
        await expect(h.hosted.lookupDevicePairing("K7QD3MX0")).rejects.toMatchObject({ reason: "invalid_user_code" });
        expect(h.calls).toHaveLength(0);
    });
});

describe("paired-device management", () => {
    it("lists and revokes", async () => {
        const h = harness({
            "GET /api/auth/devices": () => ({
                body: {
                    devices: [{
                        id: "3n1Q", label: "Living Room TV", app_id: "9f3c",
                        paired_at: 1784900000000, last_seen_at: 1785000000000, active_session: true,
                    }],
                },
            }),
            "DELETE /api/auth/devices": () => ({ body: { deleted: true } }),
        });
        await h.session.setSession({ token: "s", username: "matt", commitment: "1" });

        expect(await h.hosted.listPairedDevices()).toEqual([{
            id: "3n1Q", label: "Living Room TV", appId: "9f3c",
            pairedAt: 1784900000000, lastSeenAt: 1785000000000, activeSession: true,
        }]);
        expect(h.calls[0].body).toBeUndefined();

        await h.hosted.revokePairedDevice("3n1Q");
        expect(h.calls[1].method).toBe("DELETE");
        expect(h.calls[1].body).toEqual({ id: "3n1Q" });
    });

    it("requires a session", async () => {
        const h = harness({});
        await expect(h.hosted.listPairedDevices()).rejects.toMatchObject({ code: "unauthorized" });
    });
});

describe("adopting an approved pairing", () => {
    /** Start a pairing, then answer the next poll with an `approved` payload
     *  sealed to the device's real key. */
    async function approvedRun(over: { commitment?: string; seed?: Uint8Array } = {}) {
        const seed = over.seed ?? crypto.getRandomValues(new Uint8Array(32));
        const identity = await deriveIdentityFromSeed(seed);
        const commitment = await buildCommitment(
            identity.secretHex, identity.saltHex, await exportPublicKeyHex(identity.ecdsaKeyPair.publicKey),
        );
        const { sealSeedToDevice } = await import("../../src/auth/hostedHandoff");

        // Sealed lazily: the approver can only seal once the device's public key
        // exists, which is exactly the ordering of the real flow.
        let sealed = "";
        const h = harness({
            "POST /api/auth/device/code": () => ({ body: codeBody() }),
            "POST /api/auth/device/token": () => ({
                body: {
                    status: "approved",
                    sealed_keys: sealed,
                    username: "matt",
                    commitment: over.commitment ?? commitment,
                    device_fingerprint: "3n1Q",
                },
            }),
            "PUT /api/auth/devices": () => ({ body: { ok: true } }),
        });
        const session: DevicePairingSession = await h.hosted.startDevicePairing({ appId: "abc12345" });
        sealed = await sealSeedToDevice(seed, session.devicePublicKeyB64);
        return { h, session, seed, commitment };
    }

    it("unseals, verifies the commitment, mints its OWN session, checks in and persists", async () => {
        const { h, session, seed, commitment } = await approvedRun();
        const result = await h.hosted.pollDevicePairing(session);

        expect(result).toEqual({ status: "approved", user: { username: "matt", commitment } });

        // Its own session — not the approver's token relayed back.
        expect(h.auth.getChallenge).toHaveBeenCalledWith("matt");
        expect(h.auth.authenticate.mock.calls[0][0].rememberMe).toBe(true);
        expect(h.session.token).toBe("tv-session-token");
        expect(h.session.commitment).toBe(commitment);
        expect(h.session.isUnlocked).toBe(true);

        // PUT /api/auth/devices with a fresh possession proof over the touch input.
        const touch = h.calls.find((c) => c.path === "/api/auth/devices")!;
        expect(touch.method).toBe("PUT");
        expect(Object.keys(touch.body).sort()).toEqual(["device_signature", "fingerprint", "issued_at"]);
        expect(touch.headers["X-Muhkoo-Session"]).toBe("tv-session-token");
        expect(touch.body.fingerprint).toBe(await deviceFingerprint());
        const idKey = await deviceIdentityKey();
        const raw = new Uint8Array(await crypto.subtle.exportKey("raw", idKey.publicKey));
        const verifyKey = await crypto.subtle.importKey("raw", raw, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
        expect(await crypto.subtle.verify(
            { name: "ECDSA", hash: "SHA-256" }, verifyKey, unb64(touch.body.device_signature),
            new TextEncoder().encode(`muhkoo-device-touch-v1|${touch.body.fingerprint}|${touch.body.issued_at}`),
        )).toBe(true);

        // Persisted for the cold start.
        const stored = await loadDeviceIdentity();
        expect(stored!.username).toBe("matt");
        expect(stored!.commitment).toBe(commitment);
        expect(Buffer.from(stored!.seed).equals(Buffer.from(seed))).toBe(true);
        expect(await hasDeviceIdentity()).toBe(true);
    });

    it("aborts when the derived commitment doesn't match the server's (spec §10.8)", async () => {
        const { h, session } = await approvedRun({ commitment: "999999" });
        await expect(h.hosted.pollDevicePairing(session)).rejects.toMatchObject({
            reason: "commitment_mismatch",
        });
        // Nothing was adopted: no session, nothing persisted.
        expect(h.session.token).toBeNull();
        expect(await loadDeviceIdentity()).toBeNull();
        expect(h.auth.authenticate).not.toHaveBeenCalled();
    });

    it("aborts when the envelope can't be opened by this device", async () => {
        const other = await import("../../src/auth/hostedHandoff").then((m) => m.generateDevicePairingKeypair());
        const { sealSeedToDevice } = await import("../../src/auth/hostedHandoff");
        const sealed = await sealSeedToDevice(new Uint8Array(32).fill(3), other.publicKeyB64);
        const h = harness({
            "POST /api/auth/device/code": () => ({ body: codeBody() }),
            "POST /api/auth/device/token": () => ({
                body: { status: "approved", sealed_keys: sealed, username: "matt", commitment: "1" },
            }),
        });
        const session = await h.hosted.startDevicePairing({ appId: "abc12345" });
        await expect(h.hosted.pollDevicePairing(session)).rejects.toMatchObject({ reason: "commitment_mismatch" });
    });

    it("fails closed when the device was previously paired to a different account (§10.2)", async () => {
        await persistDeviceIdentity({
            username: "someone-else", commitment: "111", seed: new Uint8Array(32).fill(9), pairedAt: 1,
        });
        const { h, session } = await approvedRun();
        await expect(h.hosted.pollDevicePairing(session)).rejects.toMatchObject({ reason: "account_mismatch" });
        // The previous identity is untouched — it is not clobbered by a refusal.
        expect((await loadDeviceIdentity())!.username).toBe("someone-else");
    });

    it("still signs in when persistence is impossible — it just won't resume", async () => {
        configureDeviceStore({ keys: null, blobs: null });
        const { h, session, commitment } = await approvedRun();
        await expect(h.hosted.pollDevicePairing(session)).resolves.toEqual({
            status: "approved", user: { username: "matt", commitment },
        });
        expect(h.session.token).toBe("tv-session-token");
        expect(await hasDeviceIdentity()).toBe(false);
    });
});

describe("resume / forget", () => {
    it("resumes from persisted state and checks in", async () => {
        const seed = crypto.getRandomValues(new Uint8Array(32));
        const identity = await deriveIdentityFromSeed(seed);
        const commitment = await buildCommitment(
            identity.secretHex, identity.saltHex, await exportPublicKeyHex(identity.ecdsaKeyPair.publicKey),
        );
        await persistDeviceIdentity({ username: "matt", commitment, seed, pairedAt: 123 });

        const h = harness({ "PUT /api/auth/devices": () => ({ body: { ok: true } }) });
        await expect(h.hosted.hasDeviceSession()).resolves.toBe(true);
        await expect(h.hosted.resumeDeviceSession()).resolves.toEqual({ username: "matt", commitment });
        expect(h.session.token).toBe("tv-session-token");
        expect(h.auth.authenticate.mock.calls[0][0].rememberMe).toBe(true);
        expect(h.calls.some((c) => c.path === "/api/auth/devices" && c.method === "PUT")).toBe(true);
    });

    it("returns null with nothing persisted", async () => {
        const h = harness({});
        await expect(h.hosted.hasDeviceSession()).resolves.toBe(false);
        await expect(h.hosted.resumeDeviceSession()).resolves.toBeNull();
    });

    it("returns null (rather than authenticating) when the blob doesn't derive its own pin", async () => {
        await persistDeviceIdentity({
            username: "matt", commitment: "not-the-real-one", seed: new Uint8Array(32).fill(4), pairedAt: 1,
        });
        const h = harness({});
        await expect(h.hosted.resumeDeviceSession()).resolves.toBeNull();
        expect(h.auth.authenticate).not.toHaveBeenCalled();
    });

    it("forget wipes the blob, the key store and the session", async () => {
        const keys = memKeys();
        const blobs = memBlobs();
        configureDeviceStore({ keys, blobs });
        await deviceIdentityKey();
        await persistDeviceIdentity({
            username: "matt", commitment: "1", seed: new Uint8Array(32).fill(1), pairedAt: 1,
        });
        expect(blobs.map.size).toBe(1);
        expect(keys.map.size).toBeGreaterThan(0);

        const h = harness({});
        await h.session.setSession({ token: "t", username: "matt", commitment: "1" });
        await h.hosted.forgetDeviceSession();

        expect(blobs.map.size).toBe(0);
        expect(keys.map.size).toBe(0); // the wrapping key must not outlive the blob
        expect(h.session.token).toBeNull();
        await expect(loadDeviceIdentity()).resolves.toBeNull();
    });
});

describe("deviceStore", () => {
    it("round-trips an identity through ciphertext + a non-extractable key", async () => {
        const blobs = memBlobs();
        const keys = memKeys();
        configureDeviceStore({ keys, blobs });

        const seed = crypto.getRandomValues(new Uint8Array(32));
        await persistDeviceIdentity({ username: "matt", commitment: "1439", seed, pairedAt: 42 });

        const raw = blobs.map.get(DEVICE_IDENTITY_STORAGE_KEY)!;
        const envelope = JSON.parse(raw);
        expect(envelope.v).toBe(1);
        expect(envelope.iv).toBeTruthy();
        expect(envelope.ct).toBeTruthy();
        // The blob alone is useless: no plaintext seed, no username.
        expect(raw).not.toContain(b64(seed));
        expect(raw).not.toContain("matt");

        // The wrapping key is stored as a live, NON-EXTRACTABLE CryptoKey.
        const wrap = keys.map.get("wrap") as CryptoKey;
        expect(wrap.extractable).toBe(false);
        await expect(crypto.subtle.exportKey("raw", wrap)).rejects.toBeTruthy();

        const loaded = await loadDeviceIdentity();
        expect(loaded).toEqual({ username: "matt", commitment: "1439", seed, pairedAt: 42 });
    });

    it("returns null when the key store was wiped but the blob survived", async () => {
        const blobs = memBlobs();
        const keys = memKeys();
        configureDeviceStore({ keys, blobs });
        await persistDeviceIdentity({
            username: "matt", commitment: "1", seed: new Uint8Array(32).fill(2), pairedAt: 1,
        });
        keys.map.clear();
        configureDeviceStore({ keys, blobs }); // drop the memo, same backends
        await expect(loadDeviceIdentity()).resolves.toBeNull();
    });

    it("prefers a native Keystore bridge when the shell provides one", async () => {
        const blobs = memBlobs();
        const keys = memKeys();
        const wrapped = new Map<string, string>();
        let wraps = 0;
        configureDeviceStore({
            keys, blobs,
            keystore: {
                wrap: async (plain) => { wraps++; const h = `ks:${wraps}`; wrapped.set(h, plain); return h; },
                unwrap: async (c) => wrapped.get(c)!,
            },
        });

        const seed = crypto.getRandomValues(new Uint8Array(32));
        await persistDeviceIdentity({ username: "matt", commitment: "9", seed, pairedAt: 7 });
        expect(wraps).toBe(1);
        const envelope = JSON.parse(blobs.map.get(DEVICE_IDENTITY_STORAGE_KEY)!);
        expect(envelope.ks).toBe(1);
        expect(envelope.iv).toBeUndefined();
        expect(keys.map.has("wrap")).toBe(false); // no WebCrypto key was created

        await expect(loadDeviceIdentity()).resolves.toEqual({
            username: "matt", commitment: "9", seed, pairedAt: 7,
        });

        // A keystore-sealed blob is unopenable without the bridge.
        configureDeviceStore({ keys, blobs, keystore: null });
        await expect(loadDeviceIdentity()).resolves.toBeNull();
    });

    it("degrades instead of throwing when neither backend exists (SSR / Workers)", async () => {
        configureDeviceStore({ keys: null, blobs: null });
        await expect(loadDeviceIdentity()).resolves.toBeNull();
        await expect(hasDeviceIdentity()).resolves.toBe(false);
        await expect(clearDeviceIdentity()).resolves.toBeUndefined();
        await expect(persistDeviceIdentity({
            username: "m", commitment: "1", seed: new Uint8Array(32), pairedAt: 0,
        })).rejects.toBeInstanceOf(DeviceStoreUnavailableError);

        // Pairing still has to work — the keypair just lives in memory.
        const pair = await deviceIdentityKey();
        expect(deviceIdentityIsEphemeral()).toBe(true);
        expect(pair.privateKey.extractable).toBe(false);
        expect(await deviceIdentityKey()).toBe(pair); // memoized for the process
    });

    it("keeps one persistent identity key and a 43-char base64url fingerprint", async () => {
        const keys = memKeys();
        configureDeviceStore({ keys, blobs: memBlobs() });
        const first = await deviceIdentityKey();
        expect(deviceIdentityIsEphemeral()).toBe(false);
        const fp = await deviceFingerprint();
        expect(fp).toHaveLength(43);
        expect(fp).toMatch(/^[A-Za-z0-9_-]+$/);

        // A fresh process (memo dropped) with the same store returns the same key.
        configureDeviceStore({ keys, blobs: memBlobs() });
        expect(await deviceIdentityKey()).toBe(first);
        expect(await deviceFingerprint()).toBe(fp);

        // ...and the fingerprint really is SHA-256 over the raw public point.
        const raw = new Uint8Array(await crypto.subtle.exportKey("raw", first.publicKey));
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
        expect(fp).toBe(b64(digest).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));

        // A new store yields a NEW device — which is what makes a wiped device
        // correctly look unknown to the approver.
        configureDeviceStore({ keys: memKeys(), blobs: memBlobs() });
        expect(await deviceFingerprint()).not.toBe(fp);
    });

    it("refuses a seed that isn't 32 bytes", async () => {
        configureDeviceStore({ keys: memKeys(), blobs: memBlobs() });
        await expect(persistDeviceIdentity({
            username: "m", commitment: "1", seed: new Uint8Array(16), pairedAt: 0,
        })).rejects.toThrow(/32-byte seed/);
    });

    it("ignores a corrupt blob rather than throwing", async () => {
        const blobs = memBlobs();
        configureDeviceStore({ keys: memKeys(), blobs });
        blobs.map.set(DEVICE_IDENTITY_STORAGE_KEY, "{not json");
        await expect(loadDeviceIdentity()).resolves.toBeNull();
        blobs.map.set(DEVICE_IDENTITY_STORAGE_KEY, JSON.stringify({ v: 2, ct: "x" }));
        await expect(loadDeviceIdentity()).resolves.toBeNull();
    });
});
