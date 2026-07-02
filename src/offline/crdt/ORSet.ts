/**
 * Tombstone helpers shared by the LWW CRDTs. We don't need a full
 * observed-remove set — every domain that deletes (kv keys, db rows) does so
 * by stamping a delete with an HLC and keeping that stamp around. The only
 * rule that matters is the causal one:
 *
 *   a delete at HLC `d` hides the value, but a *later* write at HLC `w > d`
 *   resurrects it; a *stale* write at `w <= d` is dropped.
 *
 * Keeping the delete HLC (rather than physically forgetting the key) is what
 * prevents a delayed offline write from "un-deleting" something a peer already
 * removed. Callers GC tombstones older than any possible offline window.
 */

import { compareHlc } from "../clock/HlcTimestamp";

/**
 * Does a write at `writeHlc` win against a tombstone at `tombstoneHlc`?
 * `true` ⇒ the write applies (resurrecting a deleted item if needed); `false`
 * ⇒ the tombstone still holds and the write is dropped. A missing tombstone
 * (`null`) means there's nothing suppressing the write.
 */
export function writeBeatsTombstone(writeHlc: string, tombstoneHlc: string | null): boolean {
    if (!tombstoneHlc) return true;
    return compareHlc(writeHlc, tombstoneHlc) > 0;
}

/**
 * Does a delete at `deleteHlc` win against the latest write at `writeHlc`?
 * `true` ⇒ the item is now tombstoned. Ties go to the delete (remove-wins) so
 * that a delete and a write stamped in the same instant resolve deterministically
 * toward removal.
 */
export function deleteBeatsWrite(deleteHlc: string, writeHlc: string | null): boolean {
    if (!writeHlc) return true;
    return compareHlc(deleteHlc, writeHlc) >= 0;
}
