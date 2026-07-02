import { describe, it, expect } from "vitest";
import { pack } from "../../src/offline/clock/HlcTimestamp";
import {
    mergeRegister,
    writeRegister,
    deleteRegister,
} from "../../src/offline/crdt/LWWRegister";
import {
    emptyMap,
    writeColumns,
    tombstoneRow,
    mergeMap,
    materializeRow,
} from "../../src/offline/crdt/LWWMap";
import { writeBeatsTombstone, deleteBeatsWrite } from "../../src/offline/crdt/ORSet";
import { mergeMessage, provisionalHandle, isProvisional } from "../../src/offline/crdt/MessageLog";

const h = (ms: number, c = 0, node = "n") => pack(ms, c, node);

describe("LWWRegister", () => {
    it("keeps the greater-HLC write and is commutative", () => {
        const a = writeRegister("old", h(1));
        const b = writeRegister("new", h(2));
        expect(mergeRegister(a, b).value).toBe("new");
        expect(mergeRegister(b, a).value).toBe("new"); // commutative
    });

    it("a newer delete tombstones the value", () => {
        const set = writeRegister("v", h(1));
        const del = deleteRegister(h(2));
        const merged = mergeRegister(set, del);
        expect(merged.deleted).toBe(true);
        expect(merged.value).toBeNull();
    });

    it("a stale write does not resurrect a newer delete", () => {
        const del = deleteRegister(h(2));
        const staleSet = writeRegister("zombie", h(1));
        expect(mergeRegister(del, staleSet).deleted).toBe(true);
    });
});

describe("LWWMap (db rows)", () => {
    it("merges disjoint column edits without loss", () => {
        // Two offline devices edit different columns of the same row.
        let deviceA = writeColumns(emptyMap(), { title: "A-title" }, h(1, 0, "a"));
        let deviceB = writeColumns(emptyMap(), { done: true }, h(1, 0, "b"));
        const merged = mergeMap(deviceA, deviceB);
        expect(materializeRow(merged)).toEqual({ title: "A-title", done: true });
    });

    it("resolves same-column conflict by HLC", () => {
        const older = writeColumns(emptyMap(), { title: "old" }, h(1));
        const newer = writeColumns(emptyMap(), { title: "new" }, h(2));
        expect(materializeRow(mergeMap(older, newer))).toEqual({ title: "new" });
        expect(materializeRow(mergeMap(newer, older))).toEqual({ title: "new" });
    });

    it("delete hides the row, later write resurrects only the new column", () => {
        let row = writeColumns(emptyMap(), { title: "t", done: false }, h(1));
        row = tombstoneRow(row, h(2));
        expect(materializeRow(row)).toBeNull();
        const resurrect = writeColumns(emptyMap(), { title: "back" }, h(3));
        expect(materializeRow(mergeMap(row, resurrect))).toEqual({ title: "back" });
    });

    it("a stale write after a delete stays hidden", () => {
        let row = tombstoneRow(writeColumns(emptyMap(), { x: 1 }, h(1)), h(3));
        const stale = writeColumns(emptyMap(), { x: 2 }, h(2));
        expect(materializeRow(mergeMap(row, stale))).toBeNull();
    });
});

describe("ORSet tombstone rules", () => {
    it("write beats older tombstone, loses to newer", () => {
        expect(writeBeatsTombstone(h(2), h(1))).toBe(true);
        expect(writeBeatsTombstone(h(1), h(2))).toBe(false);
        expect(writeBeatsTombstone(h(1), null)).toBe(true);
    });
    it("delete wins ties (remove-wins)", () => {
        expect(deleteBeatsWrite(h(1), h(1))).toBe(true);
        expect(deleteBeatsWrite(h(1), h(2))).toBe(false);
        expect(deleteBeatsWrite(h(2), null)).toBe(true);
    });
});

describe("MessageLog", () => {
    it("provisional handles sort after real ones", () => {
        const real = "0000000001716000000000"; // zero-padded server handle
        const prov = provisionalHandle("client-1");
        expect(real < prov).toBe(true);
        expect(isProvisional(prov)).toBe(true);
        expect(isProvisional(real)).toBe(false);
    });

    it("delete tombstones a message; edits resolve by HLC", () => {
        const base = { handle: "h1", packet: "sealed-0", op: "msg" as const };
        const edited = mergeMessage(base, { handle: "h1", packet: "sealed-1", op: "edit", hlc: h(2) });
        expect(edited.packet).toBe("sealed-1");
        const staleEdit = mergeMessage(edited, { handle: "h1", packet: "sealed-old", op: "edit", hlc: h(1) });
        expect(staleEdit.packet).toBe("sealed-1"); // stale edit ignored
        const deleted = mergeMessage(edited, { handle: "h1", packet: null, op: "delete" });
        expect(deleted.deleted).toBe(true);
        expect(deleted.packet).toBeNull();
    });
});
