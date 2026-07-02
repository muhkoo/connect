/**
 * `LWWMap` — a map of independent last-write-wins registers, one per column.
 * This is the conflict model for a `db` row: two devices that edit *different*
 * columns of the same row while offline both keep their edits (no lost update),
 * and two that edit the *same* column converge to the greater-HLC write. A row
 * delete is a causal tombstone (see {@link ./ORSet}); a later write to any
 * column resurrects the row with just the surviving columns.
 *
 * This mirrors, on the client, exactly what the accelerator's `_muhkoo_crdt`
 * sidecar does server-side — so a row materializes identically whether it was
 * merged locally (offline) or by the server on replay.
 */

import { compareHlc } from "../clock/HlcTimestamp";

export interface LwwMap {
    /** Per-column value of the winning write. */
    fields: Record<string, unknown>;
    /** Per-column HLC of the winning write. */
    columnHlc: Record<string, string>;
    /** Row-delete tombstone HLC, or `null` when the row was never deleted. */
    tombstone: string | null;
}

export function emptyMap(): LwwMap {
    return { fields: {}, columnHlc: {}, tombstone: null };
}

/** Apply a local column write (insert/update) at the given per-column HLCs. */
export function writeColumns(map: LwwMap, values: Record<string, unknown>, hlc: string): LwwMap {
    const next: LwwMap = {
        fields: { ...map.fields },
        columnHlc: { ...map.columnHlc },
        tombstone: map.tombstone,
    };
    for (const [col, value] of Object.entries(values)) {
        const prev = next.columnHlc[col];
        if (!prev || compareHlc(hlc, prev) > 0) {
            next.fields[col] = value;
            next.columnHlc[col] = hlc;
        }
    }
    return next;
}

/** Apply a row delete at `hlc` (causal tombstone). */
export function tombstoneRow(map: LwwMap, hlc: string): LwwMap {
    const tombstone = !map.tombstone || compareHlc(hlc, map.tombstone) > 0 ? hlc : map.tombstone;
    return { fields: { ...map.fields }, columnHlc: { ...map.columnHlc }, tombstone };
}

/** Merge two row states column-by-column. Pure; neither input is mutated. */
export function mergeMap(a: LwwMap, b: LwwMap): LwwMap {
    const cols = new Set([...Object.keys(a.columnHlc), ...Object.keys(b.columnHlc)]);
    const out = emptyMap();
    for (const col of cols) {
        const ah = a.columnHlc[col];
        const bh = b.columnHlc[col];
        const aWins = ah && (!bh || compareHlc(ah, bh) >= 0);
        const winner = aWins ? a : b;
        out.fields[col] = winner.fields[col];
        out.columnHlc[col] = winner.columnHlc[col];
    }
    out.tombstone =
        a.tombstone && b.tombstone
            ? compareHlc(a.tombstone, b.tombstone) >= 0
                ? a.tombstone
                : b.tombstone
            : (a.tombstone ?? b.tombstone);
    return out;
}

/**
 * Materialize the visible row from merged state, or `null` when the row is
 * deleted. A column is visible only when its write is causally newer than the
 * tombstone — so a delete hides every prior column, but a post-delete write to
 * a column brings the row back with just that column populated.
 */
export function materializeRow(map: LwwMap): Record<string, unknown> | null {
    const visible: Record<string, unknown> = {};
    let any = false;
    for (const [col, hlc] of Object.entries(map.columnHlc)) {
        if (!map.tombstone || compareHlc(hlc, map.tombstone) > 0) {
            visible[col] = map.fields[col];
            any = true;
        }
    }
    return any ? visible : null;
}
