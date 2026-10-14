/**
 * How `client.vfs` orders writes of one directory record between the tabs of
 * an app on one device. Internal: nothing re-exports this module, and it is
 * not public API.
 *
 * The personal space keeps whichever write of a key arrives last, so two tabs
 * that each edit a copy of a folder and write it lose one tab's edit. A
 * coordinator gives every namespace on the device one lock per record, held
 * from the decision to write until the write has landed or failed, and a
 * count of each record's writes, which a writer stores before it lets go of
 * the lock and the next holder reads to tell whether its copy is current.
 * It also tells the others which record was written, as a hint: that can
 * reach them after the next holder has decided, or never. And it gives
 * each file or folder being moved or deleted a lock, which a move or delete
 * of it elsewhere takes only if it is free, and refuses otherwise (see
 * `holdMoving`). `Client` builds one
 * from Web Locks and a BroadcastChannel in a browser tab (see
 * `core/crossTab.ts`); without one, writes are ordered within one namespace
 * only, as they always were.
 */
export interface VfsCoordinator {
    /**
     * Run `fn` holding the device-wide lock for record `id`, and settle as it
     * does. Where the runtime refuses the lock to this document, as it then
     * does to every tab of the app, `fn` runs without it.
     */
    lock<T>(id: string, fn: () => Promise<T>): Promise<T>;
    /** Tell every other namespace that this one has just written record `id`. Called while holding its lock. */
    announce(id: string): void;
    /**
     * Call `handler` with the id of each record another namespace announces -
     * or with null when announcements may have been missed, because this one
     * has only just started hearing them, or now hears them for someone else,
     * so that every record held must be taken as written elsewhere. Returns a
     * function that stops it.
     */
    onAnnounce(handler: (id: string | null) => void): () => void;
    /**
     * Make sure announcements for whoever is signed in now are being heard.
     * Cheap; called before every read of a record from the store, so that
     * nothing is read before this namespace can hear of a later write of it.
     */
    listen(): void;
    /**
     * How often each record in `ids` has been written by any namespace on
     * the device, for whoever is signed in: one counter each, in order, read
     * at one moment from storage every tab of the app shares (IndexedDB, in
     * a browser). Null where it cannot be told: the storage cannot be read,
     * or does not answer within a few seconds, or a write of the record has
     * begun and not been counted (see `begin`). Never rejects.
     *
     * A copy of a record fetched after its counter was read holds every
     * write the counter counts. Read again once its holder has taken a lock
     * that another tab held while it wrote the record - the record's own, or
     * a move lock - a counter that has not moved says no other tab has
     * written it since: unlike an announcement, a count is stored before
     * the writer lets go of its locks. See `VfsNamespace.sendLocked`.
     */
    counters(ids: readonly string[]): Promise<Array<string | null>>;
    /**
     * Called holding record `id`'s lock, before deciding whether a copy of it
     * is current: its counter as the last tab to write it left it - one whose
     * write began and was never counted, which no copy holds, included. And
     * from then, stored with it, a mark that a write of it has begun, which
     * `counters` reports as null until `bump`: a tab that goes, or cannot
     * count its write, in between leaves every tab reading the record again.
     * Null when the storage could not be read and marked within a few
     * seconds. Never rejects.
     */
    begin(id: string): Promise<string | null>;
    /**
     * Called holding record `id`'s lock, after `begin`, once the write has
     * landed or failed, or nothing was written after all: count it, and
     * resolve to the record's new counter once that is stored - so before
     * the lock is let go of. Null when it could not be stored within a few
     * seconds. Never rejects.
     */
    bump(id: string): Promise<string | null>;
    /**
     * Hold the lock that says entry `id` - a file or a folder, by its id in
     * the tree - is being moved or deleted on this device, if no one holds
     * it. Never waits: resolves to null when another holder has it, in this
     * tab or another, and otherwise to the function that lets go of it. A
     * tab that dies lets go of everything it held. With no one signed in it
     * holds nothing, and resolves to a function that does nothing; so too
     * where the runtime refuses the lock to this document, as it then does
     * to every tab of the app.
     *
     * `shared` holds a folder's lock as a place on the way to where a move
     * is putting something. Any number of shared holders hold it at once,
     * in any tab; a holder that is not shared cannot have it while they do,
     * nor they while it does.
     *
     * A move marks its entry before it puts it in its second place, and a
     * mark cannot tell a move still writing from one that was interrupted.
     * Another tab took the first for the second: it finished the move too,
     * naming the entry in two places, or let go of what the move was about
     * to put somewhere else. So a move holds this from before it marks until
     * it has taken the entry from where it was, a delete holds it for all it
     * is deleting, and either refuses when it cannot have it. A move also
     * holds the folder it is moving into, and every folder above that one,
     * shared, for as long: a move into a folder that another tab was
     * deleting put what it moved in a record the delete then purged. See
     * `VfsNamespace.rename` and `VfsNamespace.delete`.
     */
    holdMoving(id: string, shared?: boolean): Promise<(() => void) | null>;
}
