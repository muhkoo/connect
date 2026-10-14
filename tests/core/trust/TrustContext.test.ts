import { describe, it, expect } from "vitest";
import { TrustContext } from "../../../src/core/trust/TrustContext";
import { spacePinKey } from "../../../src/core/trust/PinStore";
import { memoryTrustStore, type TrustStore } from "../../../src/core/trust/trustStore";
import { deriveIdentityFromSeed } from "../../../src/auth/identity";
import { exportPublicKeyBase64 } from "../../../src/auth/keys";
import { fakePersonalKv } from "./fakes";

const seed = new Uint8Array(32).fill(7);
const C = "c-alice";

/** A signed-in alice whose seed derives her registered IK, over a fake personal KV. */
async function makeContext(opts: { openStore?: () => Promise<TrustStore>; appTrust?: () => Promise<unknown> } = {}) {
    const ik = await exportPublicKeyBase64((await deriveIdentityFromSeed(seed)).ecdsaKeyPair.publicKey);
    const kv = fakePersonalKv();
    const gets: string[] = [];
    const http = {
        async post(path: string, body: never) {
            if (path === "/api/auth/identity") return { keys: { alice: ik } };
            return kv.http.post(path, body);
        },
        async get(path: string) {
            gets.push(path);
            return opts.appTrust ? opts.appTrust() : { appId: "app-1" };
        },
    };
    const session = { seed, identity: null, username: "alice", commitment: C };
    const ctx = new TrustContext({ http: http as never, session: session as never, openStore: opts.openStore });
    return { ctx, kv, gets };
}

describe("TrustContext (design §6.6, §6.9, §9.1)", () => {
    it("starts opening muhkoo.trust at construction; persistent is false until the open settles (KI1)", async () => {
        let opens = 0;
        let settle!: (s: TrustStore) => void;
        const openStore = () => {
            opens++;
            return new Promise<TrustStore>((r) => (settle = r));
        };
        const { ctx } = await makeContext({ openStore });
        expect(opens).toBe(1);
        expect(ctx.persistent).toBe(false);
        settle({ ...memoryTrustStore(), persistent: true });
        await ctx.store();
        expect(ctx.persistent).toBe(true);
        expect(opens).toBe(1);
    });
    it("an in-memory store reports persistent false once settled", async () => {
        const { ctx } = await makeContext({ openStore: async () => memoryTrustStore() });
        await ctx.store();
        expect(ctx.persistent).toBe(false);
    });
    it("resetSpacePins drops only that Space's genesis pin and log high-water mark", async () => {
        const store = memoryTrustStore();
        const { ctx } = await makeContext({ openStore: async () => store });
        const k1 = await spacePinKey("sp1");
        const k2 = await spacePinKey("sp2");
        await ctx.pins.pin("spaces", { [k1]: "H1", [k2]: "H2" });
        await store.put(`loghw:${C}:sp1`, { seq: 3 });
        await store.put(`loghw:${C}:sp2`, { seq: 4 });
        await ctx.resetSpacePins("sp1");
        expect(await ctx.pins.get("spaces", k1)).toBeUndefined();
        expect(await ctx.pins.get("spaces", k2)).toBe("H2");
        expect(await store.get(`loghw:${C}:sp1`)).toBeUndefined();
        expect(await store.get(`loghw:${C}:sp2`)).toEqual({ seq: 4 });
    });
    it("spacePinKey is \"s:\" + b64url(SHA-256(utf8(spaceId)))", async () => {
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("sp1")));
        const b64url = Buffer.from(digest).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
        expect(await spacePinKey("sp1")).toBe("s:" + b64url);
    });
    it("unpinUser forgets a member's pinned identity by lower-cased name (design §3.4)", async () => {
        const { ctx } = await makeContext({ openStore: async () => memoryTrustStore() });
        await ctx.pins.pin("identity", { bob: "FP-B", carol: "FP-C" });
        await ctx.unpinUser("Bob");
        expect(await ctx.pins.get("identity", "bob")).toBeUndefined();
        expect(await ctx.pins.get("identity", "carol")).toBe("FP-C");
    });
    it("appId is read from /api/app/trust once and cached; a failure is retried on the next call", async () => {
        let calls = 0;
        const appTrust = async () => {
            calls++;
            if (calls === 1) throw new Error("offline");
            if (calls === 2) return {};
            return { appId: "app-1" };
        };
        const { ctx, gets } = await makeContext({ openStore: async () => memoryTrustStore(), appTrust });
        await expect(ctx.appId()).rejects.toThrow("offline");
        await expect(ctx.appId()).rejects.toThrow("no appId");
        expect(await ctx.appId()).toBe("app-1");
        expect(await ctx.appId()).toBe("app-1");
        expect(gets).toEqual(["/api/app/trust", "/api/app/trust", "/api/app/trust"]);
    });
});
