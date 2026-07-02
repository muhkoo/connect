import { describe, it, expect } from "vitest";
import {
    FrameType,
    decode,
    encodeWant,
    encodeHave,
    encodeCancel,
    encodeBlock,
} from "../../src/p2p/worker/protocol";

const HASH = "a".repeat(64); // 32-byte hex

describe("p2p protocol codec", () => {
    it("round-trips WANT/HAVE/CANCEL (header only)", () => {
        for (const [enc, type] of [
            [encodeWant, FrameType.WANT],
            [encodeHave, FrameType.HAVE],
            [encodeCancel, FrameType.CANCEL],
        ] as const) {
            const f = decode(enc(HASH));
            expect(f.type).toBe(type);
            expect(f.hash).toBe(HASH);
            expect(f.payload).toBeUndefined();
        }
    });

    it("round-trips a BLOCK with its payload intact", () => {
        const payload = new Uint8Array([1, 2, 3, 250, 0, 99]);
        const f = decode(encodeBlock(HASH, payload));
        expect(f.type).toBe(FrameType.BLOCK);
        expect(f.hash).toBe(HASH);
        expect(f.payload).toEqual(payload);
    });

    it("BLOCK payload is copied (not aliasing the frame buffer)", () => {
        const payload = new Uint8Array([9, 9, 9]);
        const frame = encodeBlock(HASH, payload);
        const f = decode(frame);
        frame.fill(0); // scribble the source frame
        expect(f.payload).toEqual(new Uint8Array([9, 9, 9]));
    });

    it("rejects a too-short frame and a bad hash length", () => {
        expect(() => decode(new Uint8Array(5))).toThrow();
        expect(() => encodeWant("deadbeef")).toThrow(); // not 32 bytes
    });
});
