/**
 * `HlcTimestamp` — a Hybrid Logical Clock reading, packed into a single
 * lexicographically-sortable string so the whole offline layer (and the
 * accelerator) can compare causality with one plain string comparison.
 *
 * An HLC fuses a physical wall-clock millisecond with a logical `counter`
 * (breaks ties inside the same millisecond and lets the clock advance past a
 * remote event without the wall clock moving) and a stable `nodeId` (a final,
 * deterministic tiebreak so two devices never produce an "equal but different"
 * stamp). See {@link ./HLC}.
 *
 * The packed form is `"{wall}:{counter}:{nodeId}"` with `wall` and `counter`
 * zero-padded to a FIXED width. Fixed width is what makes lexicographic order
 * equal to numeric order — `"0000000000123:..."` < `"0000000000124:..."`. The
 * server only ever compares these strings; it never has to parse them.
 */

/** Zero-padded width of the wall-clock field. 15 digits holds ms timestamps
 *  past the year 5000, so `Date.now()` (currently 13 digits) never overflows. */
export const WALL_DIGITS = 15;

/** Zero-padded width of the logical counter. 5 digits allows 100k events in a
 *  single wall-clock millisecond before the clock is forced forward — far more
 *  than any real burst. */
export const COUNTER_DIGITS = 5;

/** The smallest possible stamp — used as the "nothing stored yet" sentinel so a
 *  first real write always wins (`compareHlc(real, ZERO_HLC) > 0`). */
export const ZERO_HLC = pack(0, 0, "");

export interface HlcParts {
    /** Physical wall-clock time, milliseconds since the Unix epoch. */
    wall: number;
    /** Logical counter within `wall`. */
    counter: number;
    /** Stable per-install node id (tiebreak). */
    nodeId: string;
}

function padNum(n: number, width: number): string {
    const s = Math.max(0, Math.floor(n)).toString();
    return s.length >= width ? s : "0".repeat(width - s.length) + s;
}

/** Pack the three components into the sortable string form. */
export function pack(wall: number, counter: number, nodeId: string): string {
    return `${padNum(wall, WALL_DIGITS)}:${padNum(counter, COUNTER_DIGITS)}:${nodeId}`;
}

/** Pack from a {@link HlcParts}. */
export function packParts(parts: HlcParts): string {
    return pack(parts.wall, parts.counter, parts.nodeId);
}

/** Parse a packed stamp back into its components. Tolerates the empty/zero
 *  sentinel. Throws on a malformed string so corruption surfaces loudly. */
export function unpack(stamp: string): HlcParts {
    const idx1 = stamp.indexOf(":");
    const idx2 = stamp.indexOf(":", idx1 + 1);
    if (idx1 < 0 || idx2 < 0) {
        throw new Error(`malformed HLC timestamp: ${JSON.stringify(stamp)}`);
    }
    return {
        wall: Number(stamp.slice(0, idx1)),
        counter: Number(stamp.slice(idx1 + 1, idx2)),
        nodeId: stamp.slice(idx2 + 1),
    };
}

/**
 * Total order over packed HLC strings: negative if `a < b`, positive if
 * `a > b`, `0` only when they are byte-identical. Because the fields are
 * fixed-width and ordered (wall, counter, nodeId), a single string comparison
 * already yields causal order — this helper just normalizes the result to the
 * `-1 | 0 | 1` shape callers expect.
 */
export function compareHlc(a: string, b: string): number {
    if (a === b) return 0;
    return a < b ? -1 : 1;
}

/** Convenience: is `a` strictly newer than `b`? */
export function isNewer(a: string, b: string): boolean {
    return compareHlc(a, b) > 0;
}
