import { describe, it, expect, beforeEach } from "vitest";
import { PinStore, pad16 } from "../../../src/core/trust/PinStore";
import { memoryTrustStore, type TrustStore } from "../../../src/core/trust/trustStore";
import { testSigner, fakePersonalKv } from "./fakes";

const C = "12345";
let kv: ReturnType<typeof fakePersonalKv>;
let store: TrustStore;
let pins: PinStore;

beforeEach(async () => {
    kv = fakePersonalKv();
    store = memoryTrustStore();
    pins = new PinStore({ http: kv.http as never, commitment: () => C, signer: await testSigner(), store: async () => store });
});

describe("PinStore (SpecA §4.2 + CP9 + KI6; design §3.4)", () => {
    it("bootstraps empty, then writes counter 1 with a zero-padded hlc", async () => {
        expect(await pins.get("identity", "bob")).toBeUndefined();
        await pins.pin("identity", { bob: "FP1" });
        const d = kv.docs.get("muhkoo.pins/identity-v1")!;
        expect(d.hlc).toBe(pad16(1));
        expect((d.value as { counter: number }).counter).toBe(1);
        expect(await pins.get("identity", "bob")).toBe("FP1");
    });
    it("a different value for a pinned key is a conflict, never an overwrite", async () => {
        await pins.pin("identity", { bob: "FP1" });
        expect((await pins.pin("identity", { bob: "FP2" })).conflicts).toEqual(["bob"]);
        expect(await pins.get("identity", "bob")).toBe("FP1");
    });
    it("a rollback below the high-water mark is a hard fail", async () => {
        await pins.pin("identity", { a: "1" });
        const old = kv.docs.get("muhkoo.pins/identity-v1")!;
        await pins.pin("identity", { b: "2" });
        kv.docs.set("muhkoo.pins/identity-v1", old);
        await expect(pins.get("identity", "a")).rejects.toMatchObject({ code: "pins-rollback" });
    });
    it("a missing document with a mark is a hard fail (deletion)", async () => {
        await pins.pin("identity", { a: "1" });
        kv.docs.delete("muhkoo.pins/identity-v1");
        await expect(pins.get("identity", "a")).rejects.toMatchObject({ code: "pins-missing" });
    });
    it("a document whose signature fails is refused", async () => {
        await pins.pin("identity", { a: "1" });
        const d = kv.docs.get("muhkoo.pins/identity-v1")!;
        kv.docs.set("muhkoo.pins/identity-v1", { ...d, value: { ...(d.value as object), entries: { a: "9" } } });
        await expect(pins.get("identity", "a")).rejects.toMatchObject({ code: "pins-invalid" });
    });
    it("applied:false re-reads, merges and retries", async () => {
        await pins.pin("identity", { a: "1" });
        const other = new PinStore({ http: kv.http as never, commitment: () => C, signer: (pins as never as { deps: { signer: never } }).deps.signer, store: async () => memoryTrustStore() });
        let raced = false;
        kv.hooks.beforeSet = async () => {
            if (raced) return;
            raced = true;
            await other.pin("identity", { z: "26" });
        };
        await pins.pin("identity", { b: "2" });
        expect(await pins.get("identity", "z")).toBe("26");
        expect(await pins.get("identity", "b")).toBe("2");
    });
    it("stale once, re-read still below the mark → rollback (KI6)", async () => {
        await pins.pin("identity", { a: "1" }); // mark = 1
        kv.hooks.beforeGet = async () => { await store.put("pinhw:muhkoo.pins/identity-v1:" + C, 99); };
        await expect(pins.get("identity", "a")).rejects.toMatchObject({ code: "pins-rollback" });
    });
});
