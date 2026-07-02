/**
 * `LWWRegister` — a last-write-wins register CRDT, the conflict model for a
 * `kv` value and for an app-state snapshot. A register holds a single value
 * stamped with the {@link HlcTimestamp} of the write that produced it. Two
 * concurrent writes converge to the one with the greater HLC; the loser is
 * discarded. A delete is just a write that sets `deleted` (a tombstone), so a
 * stale write that arrives after a newer delete can't resurrect the value.
 *
 * Because the HLC total-orders every write deterministically (down to a nodeId
 * tiebreak), every replica that has seen the same set of writes lands on the
 * same value — that's the convergence guarantee.
 */

import { compareHlc, ZERO_HLC } from "../clock/HlcTimestamp";

export interface LwwRegister<T> {
    /** The current value, or `null` when tombstoned / never written. */
    value: T | null;
    /** HLC of the write that produced this state. */
    hlc: string;
    /** True when the latest write was a delete. */
    deleted: boolean;
}

/** An empty register that loses to any real write. */
export function emptyRegister<T>(): LwwRegister<T> {
    return { value: null, hlc: ZERO_HLC, deleted: true };
}

/**
 * Merge two register states, returning the winner (greater HLC). Pure: neither
 * input is mutated. Used identically on the inbound change feed and on
 * sync-replay reconciliation so there's exactly one definition of "who wins".
 */
export function mergeRegister<T>(a: LwwRegister<T>, b: LwwRegister<T>): LwwRegister<T> {
    return compareHlc(a.hlc, b.hlc) >= 0 ? a : b;
}

/** Build the register produced by a `set`. */
export function writeRegister<T>(value: T, hlc: string): LwwRegister<T> {
    return { value, hlc, deleted: false };
}

/** Build the register produced by a `delete` (a tombstone at `hlc`). */
export function deleteRegister<T>(hlc: string): LwwRegister<T> {
    return { value: null, hlc, deleted: true };
}
