import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { lpStr, dec, concatBytes } from "../../../src/spaces/trust/lp";
import { certBytes, ecBytes, entryBytes, entryHash, epochMapBytes, keyCommit, opBytes, LABEL_MLOG } from "../../../src/spaces/trust/canonical";
import { verifyP256 } from "../../../src/spaces/trust/ik";

const fx = JSON.parse(readFileSync(new URL("../../fixtures/mlog-v1.json", import.meta.url), "utf8"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unsign = (e: Record<string, unknown>) => { const { sig: _s, lsig: _l, ...u } = e; return u as never; };

describe("canonical encoders match the accelerator fixture byte-for-byte (design §6.10, D21)", () => {
    it("labels", () => { expect(LABEL_MLOG).toBe(fx.labels.mlog); });
    it("LP primitives", () => {
        for (const v of fx.primitives.lp) expect(hex(lpStr(v.str))).toBe(v.hex);
        for (const v of fx.primitives.dec) expect(dec(v.n)).toBe(v.str);
        for (const v of fx.primitives.epochMap) expect(hex(epochMapBytes(v.map))).toBe(v.hex);
    });
    for (const chain of ["private", "public"] as const) {
        it(`${chain} chain: opBytes, entryBytes and hashes`, async () => {
            for (const rec of fx.chains[chain].entries) {
                expect(hex(opBytes(rec.entry)), rec.name).toBe(rec.opBytesHex);
                expect(hex(entryBytes(unsign(rec.entry))), rec.name).toBe(rec.bytesHex);
                expect(await entryHash(unsign(rec.entry)), rec.name).toBe(rec.hash);
            }
        });
    }
    it("signatures in the fixture verify over entryBytes (P1363, IK as sent)", async () => {
        const g = fx.chains.private.entries[0].entry;
        expect(await verifyP256(g.ik, g.sig, entryBytes(unsign(g)))).toBe(true);
    });
    it("epoch commit bytes", () => {
        const { sig: _s, ...ec } = fx.epochCommit.ec;
        expect(hex(ecBytes(ec))).toBe(fx.epochCommit.bytesHex);
    });
    it("chat-key cert bytes lower-case the member id", () => {
        expect(hex(certBytes(fx.keyCert.memberId, fx.keyCert.cert))).toBe(fx.keyCert.bytesHex);
    });
    it("keyCommit vectors", async () => {
        for (const v of fx.keyCommits) {
            expect(await keyCommit(v.epoch, Buffer.from(v.keyHex, "hex"), v.spaceId)).toBe(v.keyCommit);
        }
    });
    it("LP is injective: (a, bc) differs from (ab, c)", () => {
        expect(hex(concatBytes(lpStr("a"), lpStr("bc")))).not.toBe(hex(concatBytes(lpStr("ab"), lpStr("c"))));
    });
    it("the hash ignores sig", async () => {
        const e = fx.chains.private.entries[0].entry;
        expect(await entryHash(unsign({ ...e, sig: "AAAA" }))).toBe(await entryHash(unsign(e)));
    });
});
