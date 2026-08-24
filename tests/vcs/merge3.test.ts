import { describe, it, expect } from "vitest";
import { merge3, merge3Text } from "../../src/vcs/merge3";

const L = (s: string) => (s === "" ? [] : s.split("\n"));

describe("merge3", () => {
    it("takes an edit only one side made", () => {
        const base = L("a\nb\nc");
        expect(merge3(base, L("a\nB\nc"), base).lines).toEqual(L("a\nB\nc"));
        expect(merge3(base, base, L("a\nb\nC")).lines).toEqual(L("a\nb\nC"));
    });

    it("combines edits the two sides made in different places", () => {
        // The everyday case: two people working on the same file, apart.
        const r = merge3(L("a\nb\nc\nd"), L("A\nb\nc\nd"), L("a\nb\nc\nD"));
        expect(r.lines).toEqual(L("A\nb\nc\nD"));
        expect(r.conflicts).toEqual([]);
    });

    it("does not conflict when both sides made the SAME change", () => {
        // Two people fixing the same typo is agreement, not a conflict.
        const r = merge3(L("a\ntpyo\nc"), L("a\ntypo\nc"), L("a\ntypo\nc"));
        expect(r.lines).toEqual(L("a\ntypo\nc"));
        expect(r.conflicts).toEqual([]);
    });

    it("conflicts when both sides changed the same line differently", () => {
        const r = merge3(L("a\nb\nc"), L("a\nOURS\nc"), L("a\nTHEIRS\nc"));
        expect(r.conflicts).toHaveLength(1);
        expect(r.conflicts[0]).toMatchObject({ ours: ["OURS"], theirs: ["THEIRS"] });
    });

    it("handles insertions at the start and end", () => {
        expect(merge3(L("b"), L("a\nb"), L("b\nc")).lines).toEqual(L("a\nb\nc"));
    });

    it("handles a deletion by one side", () => {
        expect(merge3(L("a\nb\nc"), L("a\nc"), L("a\nb\nc")).lines).toEqual(L("a\nc"));
    });

    it("merges into an empty base", () => {
        const r = merge3([], L("ours"), []);
        expect(r.lines).toEqual(L("ours"));
    });

    it("conflicts when both sides add different content to an empty file", () => {
        const r = merge3([], L("ours"), L("theirs"));
        expect(r.conflicts).toHaveLength(1);
    });
});

describe("merge3Text", () => {
    it("returns clean text when there is nothing to resolve", () => {
        const r = merge3Text("a\nb\nc", "A\nb\nc", "a\nb\nC");
        expect(r.text).toBe("A\nb\nC");
        expect(r.conflicted).toBe(false);
    });

    it("writes standard conflict markers, so resolving is ordinary editing", () => {
        const r = merge3Text("a\nb\nc", "a\nOURS\nc", "a\nTHEIRS\nc", { ours: "main", theirs: "feature" });
        expect(r.conflicted).toBe(true);
        expect(r.text).toBe(
            ["a", "<<<<<<< main", "OURS", "=======", "THEIRS", ">>>>>>> feature", "c"].join("\n"),
        );
    });

    it("preserves an unchanged file exactly", () => {
        const text = "line one\nline two\n";
        expect(merge3Text(text, text, text).text).toBe(text);
    });

    it("survives files that differ only by a trailing newline", () => {
        // A whole-file rewrite would be a miserable diff to review.
        const r = merge3Text("a\nb", "a\nb\n", "a\nb");
        expect(r.conflicted).toBe(false);
        expect(r.text).toBe("a\nb\n");
    });
});
