/**
 * Three-way line merge.
 *
 * Given a common ancestor and two descendants, produce the combined text — or
 * report the regions where both sides changed the same lines differently.
 *
 * The server cannot do any of this: it holds ciphertext and cannot compare
 * versions, so merging is entirely a client concern and has to be exact here.
 */

export interface MergeRegionConflict {
    /** 1-based line where the conflict begins in the merged output. */
    line: number;
    ours: string[];
    theirs: string[];
}

export interface Merge3Result {
    lines: string[];
    conflicts: MergeRegionConflict[];
}

/**
 * Longest common subsequence, as a list of matched index pairs.
 *
 * Classic dynamic programming. Fine for source files; a file with hundreds of
 * thousands of lines would want a smarter algorithm, and would also be a strange
 * thing to merge.
 */
function lcs(a: string[], b: string[]): Array<[number, number]> {
    const n = a.length;
    const m = b.length;
    const table: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
        }
    }
    const pairs: Array<[number, number]> = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) {
            pairs.push([i, j]);
            i++;
            j++;
        } else if (table[i + 1][j] >= table[i][j + 1]) i++;
        else j++;
    }
    return pairs;
}

/**
 * Lines of `base` that BOTH sides left untouched.
 *
 * These are the anchors the merge is built around: between two consecutive
 * anchors, each side has some (possibly empty) replacement, and comparing those
 * replacements is the entire decision.
 */
function stableAnchors(base: string[], ours: string[], theirs: string[]): Array<[number, number, number]> {
    const ourMatch = new Map(lcs(base, ours));
    const theirMatch = new Map(lcs(base, theirs));
    const anchors: Array<[number, number, number]> = [];
    for (let b = 0; b < base.length; b++) {
        const o = ourMatch.get(b);
        const t = theirMatch.get(b);
        if (o !== undefined && t !== undefined) anchors.push([b, o, t]);
    }
    return anchors;
}

const same = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Merge `ours` and `theirs` over their common ancestor `base`.
 *
 * A region where only one side changed takes that side. A region where both
 * made the SAME change takes it once — two people fixing the same typo is not a
 * conflict. Only genuinely divergent edits conflict.
 */
export function merge3(base: string[], ours: string[], theirs: string[]): Merge3Result {
    const anchors = stableAnchors(base, ours, theirs);
    const out: string[] = [];
    const conflicts: MergeRegionConflict[] = [];

    let b = 0;
    let o = 0;
    let t = 0;

    const settle = (ourSlice: string[], theirSlice: string[], baseSlice: string[]): void => {
        if (same(ourSlice, theirSlice)) {
            out.push(...ourSlice);                 // identical edits, or no edit
        } else if (same(ourSlice, baseSlice)) {
            out.push(...theirSlice);               // only they changed it
        } else if (same(theirSlice, baseSlice)) {
            out.push(...ourSlice);                 // only we changed it
        } else {
            conflicts.push({ line: out.length + 1, ours: ourSlice, theirs: theirSlice });
            out.push(...ourSlice);                 // markers are added by the caller
        }
    };

    for (const [ab, ao, at] of anchors) {
        settle(ours.slice(o, ao), theirs.slice(t, at), base.slice(b, ab));
        out.push(base[ab]);
        b = ab + 1;
        o = ao + 1;
        t = at + 1;
    }
    settle(ours.slice(o), theirs.slice(t), base.slice(b));

    return { lines: out, conflicts };
}

/**
 * Merge to text, writing conflict markers where the sides diverged.
 *
 * Markers rather than a bespoke format: they are what every developer already
 * knows how to resolve, and resolving becomes ordinary editing.
 */
export function merge3Text(
    base: string,
    ours: string,
    theirs: string,
    labels: { ours: string; theirs: string } = { ours: "ours", theirs: "theirs" },
): { text: string; conflicted: boolean } {
    const split = (s: string) => (s === "" ? [] : s.split("\n"));
    const anchors = stableAnchors(split(base), split(ours), split(theirs));
    const B = split(base);
    const O = split(ours);
    const T = split(theirs);

    const out: string[] = [];
    let conflicted = false;
    let b = 0;
    let o = 0;
    let t = 0;

    const settle = (ourSlice: string[], theirSlice: string[], baseSlice: string[]): void => {
        if (same(ourSlice, theirSlice)) out.push(...ourSlice);
        else if (same(ourSlice, baseSlice)) out.push(...theirSlice);
        else if (same(theirSlice, baseSlice)) out.push(...ourSlice);
        else {
            conflicted = true;
            out.push(`<<<<<<< ${labels.ours}`, ...ourSlice, "=======", ...theirSlice, `>>>>>>> ${labels.theirs}`);
        }
    };

    for (const [ab, ao, at] of anchors) {
        settle(O.slice(o, ao), T.slice(t, at), B.slice(b, ab));
        out.push(B[ab]);
        b = ab + 1;
        o = ao + 1;
        t = at + 1;
    }
    settle(O.slice(o), T.slice(t), B.slice(b));

    return { text: out.join("\n"), conflicted };
}
