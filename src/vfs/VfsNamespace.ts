/**
 * `client.vfs` — a real filesystem over Muhkoo primitives.
 *
 * Metadata is a graph of encrypted directory records in the user's personal
 * space; file content is chunked, encrypted and stored in the global
 * content-addressed shard store, referenced by manifest. See `types.ts` for
 * why directories carry stable random ids and why each key lives in its parent.
 *
 * ## Consistency
 *
 * Every mutation is a read-modify-write of exactly ONE directory record, so a
 * write cannot leave the tree half-updated: either the parent names the new
 * child or it does not. A VFS write sends no HLC and the personal space has
 * no compare-and-swap: of two writes of one key it keeps whichever arrives
 * last.
 *
 * Within ONE namespace, writes of a record are sent one at a time, in the
 * order they were made - edits made while one is in flight go out together
 * in the next (see `queue`) - and a read that has to fetch a record waits for
 * its write in flight (see `writing`). Every edit of a record is made to one
 * in-memory copy of it, and that copy is what is written (see `mutate`).
 *
 * Between the tabs of an app on one device, a coordinator (`VfsCoordinator`;
 * `Client` wires one in a browser tab) gives each record one lock, and a tab
 * reads a record another tab has written again before its next write of it
 * (see `sendLocked`). Between devices - or a browser and the CLI - two writes
 * of the same directory are still last-writer-wins, and the other edit is
 * lost: that takes a compare-and-swap at the server. Orphaned records (a
 * directory whose parent entry lost the race) are unreachable rather than
 * corrupting - they cost storage until a sweep, the trade this shape makes in
 * exchange for single-record writes.
 */

import type { FileManifest } from "../storage/types";
import {
    dirKey,
    historyKey,
    ROOT_ID,
    VfsConflictError,
    VfsCorruptRecordError,
    VfsLimitError,
    VfsLockedError,
    VfsNotFoundError,
    type DirEntry,
    type DirNode,
    type Entry,
    type FileEntry,
    type HistoryRecord,
    type VfsStat,
    type VfsStore,
} from "./types";
import {
    deriveRootKey, fromBase64, newDirKey, newId, openSealed, seal, SealedRecordError, toBase64,
} from "./recordCipher";
import {
    assertValidName, basename, contentTypeFor, dirname, isSafeName, isUnder, join, printable, resolveFrom, segments,
} from "./paths";
import { globToRegExp } from "./glob";
import {
    DEFAULT_MAX_ENTRIES, DEFAULT_MAX_PATH_CHARS, MAX_DEPTH, MAX_TIME, nextTurn, WALK_CONCURRENCY, YIELD_EVERY,
} from "./bounds";
import type { VfsCoordinator } from "./coordinator";

/**
 * The slice of content storage the VFS needs.
 *
 * Narrow on purpose: the VFS knows how to name and arrange things, not how to
 * shard them. The adapter in `Client` resolves the content space and calls
 * `client.storage.writeFile` unchanged — the file still lands in a real Space
 * with a real gated manifest, and the VFS just keeps the handle somewhere
 * better than a flat mirror.
 */
export interface VfsContentStore {
    write(
        data: Uint8Array | Blob,
        meta: { name: string; type: string },
        opts?: { onProgress?: (done: number, total: number) => void },
    ): Promise<{ manifest: FileManifest; size: number }>;
    read(manifest: FileManifest): Promise<Uint8Array>;
    /**
     * Drop a reference to a manifest's shards.
     *
     * Shards are content-addressed and reference-counted, so deleting a file is
     * not enough to reclaim the bytes — without this, every version ever
     * written stays on disk and billed forever. Best-effort: a failure here
     * leaks storage but must not block the delete.
     */
    release(manifest: FileManifest): Promise<void>;
    /**
     * Take an ADDITIONAL reference to shards that already exist.
     *
     * Needed when a manifest gains a second owner without new bytes being
     * written — copying a file. Without it the copy holds a handle to shards
     * with a refcount of one, and deleting the original frees the bytes out
     * from under it.
     */
    retain(manifest: FileManifest): Promise<void>;
}

export interface VfsNamespaceDeps {
    store: VfsStore;
    /**
     * Subscribe to the personal space's raw change feed, if the runtime has one.
     * Optional so the VFS works headlessly (a CLI, a test) with no socket.
     */
    subscribe?: (handler: (frame: unknown) => void) => () => void;
    content: VfsContentStore;
    /** The in-memory master seed, or null when locked. Read per call — it can change. */
    seed: () => Uint8Array | null;
    /** Versions retained per file. */
    historyLimit?: number;
    /**
     * Ceilings for the operations that visit a whole subtree - `walk` (and so
     * `glob`) and `copy`. `entries` is the most entries one call may visit;
     * `pathChars` the most characters of path text, summed over every path it
     * visits. The defaults are far past any real project; tests lower them so
     * a hostile tree hits them in milliseconds. `Client` does not pass these,
     * so `client.vfs` always has the defaults.
     */
    limits?: { entries?: number; pathChars?: number };
    /**
     * Orders writes of a record with the other tabs of this app on the
     * device. `Client` passes one in a browser tab; without it - Node, a
     * test, a runtime with no Web Locks - writes are ordered within this
     * namespace only. See `VfsCoordinator`.
     */
    coordinator?: VfsCoordinator;
}

/** A directory record plus the key it was opened with. */
interface OpenDir {
    id: string;
    key: Uint8Array;
    /** The path it was first opened through, for messages. A moved subtree can have two. */
    path?: string;
    /**
     * The record, holding only the entries this version can read AND whose
     * names are usable. Everything that reads `node.entries` may take both
     * for granted.
     */
    node: DirNode;
    /**
     * Every other entry, by name - kept OUT of `node` so no read path can trip
     * over them, and written back by `mutate` so no write drops them. See
     * `readableEntry` and `isSafeName`.
     */
    hidden: Record<string, unknown>;
    /** The cache generation it was read under. See `VfsNamespace.generation`. */
    gen: number;
    /**
     * Where `hearing` stood when this copy was read from the store, or last
     * written to it: it holds every write of its record another tab
     * announced before then. See `VfsNamespace.current`.
     */
    seen: number;
    /**
     * With a coordinator, the record's write counter: read before this copy
     * was fetched, never after, or as this tab's last write of it left it.
     * The copy holds every write the counter counts, so under the lock, a
     * counter that has not moved since says it is current. Null when it
     * could not be told, and always without a coordinator. See
     * `VfsNamespace.sendLocked`.
     */
    counter: string | null;
}

/** An edit of one directory record. See `VfsNamespace.mutate`. */
type Edit = (node: DirNode, record: OpenDir) => boolean | void;

/** One call's edit, as `mutate` was given it, kept so it can be made again. See `VfsNamespace.replay`. */
interface Ticket {
    edit: Edit;
}

/** The edits of one record that go out in one write. See `VfsNamespace.queue`. */
interface Batch {
    /** The record they were made to: its one copy. */
    copy: OpenDir;
    /** Every edit it carries, in the order they were made. */
    edits: Ticket[];
    /** Edits that no longer applied when made again to the record as another tab left it, with what each threw. */
    refused: Map<Ticket, unknown>;
    /** Settles once the write has landed or failed - for every edit it carries. */
    write: Promise<void>;
}

/** Refuse a directory at `path` if it would be deeper than MAX_DEPTH from the root. */
function assertWritableDepth(path: string): void {
    const parts = segments(path);
    if (parts.length <= MAX_DEPTH) return;
    throw new VfsLimitError("depth", MAX_DEPTH, path, `/${parts.slice(0, MAX_DEPTH + 1).join("/")}`, "writing");
}


const DEFAULT_HISTORY_LIMIT = 20;

/** A directory's entries in listing order - see `VfsNamespace.children`. */
type Listing = Array<{ name: string; kind: Entry["kind"]; entry: Entry }>;

/** One directory on a walk's current path: its listing, and how far through it the walk is. */
interface WalkFrame {
    id: string;
    path: string;
    children: Listing;
    /** The next child the walk will visit. */
    next: number;
}

/**
 * The one pool of record fetches a walk has, `limit` wide.
 *
 * The walk itself visits one directory at a time, so it never holds more than
 * its current path. What keeps a real tree from being listed one round trip at
 * a time is reading ahead: every record the walk opens, and every record read
 * ahead, is scanned ONCE for subdirectories not yet fetched, and those are
 * fetched while the walk works. The most recently opened record is scanned
 * first, which is roughly the order a depth-first walk wants them in.
 *
 * What it holds is per distinct RECORD - a record scanned, a read that failed
 * - never per visit, so a record a fan-out reaches a million times costs it
 * one entry. The walk's own reads come out of the same pool, and go first:
 * when every slot is reading ahead, the walk takes the next one to come free.
 * A successful read lands in the namespace's record cache, which is where the
 * walk looks when it gets there.
 */
class ReadAhead {
    private inFlight = 0;
    private stopped = false;
    /** The walk, waiting for a slot. It reads one directory at a time, so there is only ever one. */
    private waiting: (() => void) | null = null;
    /** Records whose subdirectories are still to be looked at, the most recently opened last. */
    private readonly toScan: Array<{ path: string; children: Listing; next: number }> = [];
    /** Every record scanned so far, so none is scanned twice. */
    private readonly scanned = new Set<string>();
    /**
     * Reads ahead that failed. The cache forgets a failed read so that one
     * blip does not poison a directory for the session; kept here, the walk
     * reports the failure when it gets there instead of asking again.
     */
    private readonly failed = new Map<string, Promise<OpenDir>>();

    constructor(
        private readonly limit: number,
        private readonly list: (dir: OpenDir) => Listing,
        private readonly cached: (id: string) => boolean,
        private readonly fetch: (entry: DirEntry, path: string) => Promise<OpenDir>,
    ) {}

    /** A record the walk has opened. `children` is its listing, when the walk already has one. */
    scan(dir: OpenDir, path: string, children?: Listing): void {
        this.queue(dir, path, children);
        this.fill();
    }

    /** The walk is over, however it ended: start nothing more. */
    stop(): void {
        this.stopped = true;
        this.toScan.length = 0;
    }

    /** The record the walk needs now: read ahead already, or fetched in the next free slot. */
    async open(entry: DirEntry, path: string): Promise<OpenDir> {
        const failed = this.failed.get(entry.id);
        if (failed) return failed;
        if (this.cached(entry.id)) return this.fetch(entry, path);
        if (this.inFlight < this.limit) return this.start(entry, path);
        // Every slot is reading ahead. The next one to come free is handed to
        // the walk rather than to more reading ahead.
        await new Promise<void>((resolve) => (this.waiting = resolve));
        if (!this.cached(entry.id)) return this.start(entry, path, true);
        // Read ahead in the meantime after all: give the slot back.
        this.inFlight--;
        this.fill();
        return this.fetch(entry, path);
    }

    private queue(dir: OpenDir, path: string, children?: Listing): void {
        if (this.stopped || this.scanned.has(dir.id)) return;
        this.scanned.add(dir.id);
        this.toScan.push({ path, children: children ?? this.list(dir), next: 0 });
    }

    /** `held`: the slot was handed over, and is already counted. */
    private start(entry: DirEntry, path: string, held = false): Promise<OpenDir> {
        if (!held) this.inFlight++;
        const pending = this.fetch(entry, path);
        pending.then(
            (dir) => {
                this.queue(dir, path);
                this.release();
            },
            () => {
                this.failed.set(entry.id, pending);
                this.release();
            },
        );
        return pending;
    }

    private release(): void {
        const walk = this.waiting;
        if (walk) {
            this.waiting = null;
            walk();   // the slot passes to the walk, still counted
            return;
        }
        this.inFlight--;
        this.fill();
    }

    private fill(): void {
        while (!this.stopped && this.inFlight < this.limit) {
            const top = this.toScan[this.toScan.length - 1];
            if (!top) return;
            if (top.next >= top.children.length) {
                this.toScan.pop();
                continue;
            }
            const { name, entry } = top.children[top.next++];
            if (entry.kind !== "dir" || this.cached(entry.id) || this.failed.has(entry.id)) continue;
            void this.start(entry, join(top.path, name));
        }
    }
}

/**
 * What the tree names, from `references`: directory record ids, each file id
 * with a directory that holds it, and each id a marked entry has with every
 * directory that holds one - see `DirEntry.moving`.
 */
interface NamedElsewhere {
    dirs: Set<string>;
    files: Map<string, OpenDir>;
    marked: Map<string, OpenDir[]>;
}

/** Files leaving the tree, by id: every entry that names each, with the directory it is in. */
type Leaving = Map<string, Array<{ dir: OpenDir; entry: FileEntry }>>;

/**
 * What a recursive delete read in each directory it is about to purge: by
 * directory id, the id of every entry it named then, and whether an entry
 * with that id was marked as half of a move. See `VfsNamespace.currentSubtree`.
 */
type SubtreeShape = Map<string, Map<string, boolean>>;

/** An entry without its move mark. See `DirEntry.moving`. */
function unmarked<T extends Entry>(entry: T): T {
    const { moving: _moving, ...rest } = entry;
    return rest as T;
}

/**
 * A directory and every directory above it, linked upward - so going down a
 * level adds one link instead of copying a set of everything above.
 */
interface Ancestry {
    id: string;
    up: Ancestry | null;
}

function hasAncestor(chain: Ancestry | null, id: string): boolean {
    for (let at = chain; at; at = at.up) if (at.id === id) return true;
    return false;
}

/**
 * The length of `join(dir, name)`, without building it.
 *
 * Only for a name that passed isSafeName, which join cannot rewrite. Lets a
 * walk charge for a directory's paths BEFORE it makes any of them.
 */
function childPathLength(dir: string, name: string): number {
    return (dir === "/" ? 1 : dir.length + 1) + name.length;
}

/**
 * `join(dir, name)`, for the same names: what join would return, without
 * splitting and re-joining the whole path for every entry of a walk.
 */
function childPath(dir: string, name: string): string {
    return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

/**
 * The most places one directory may appear in a tree that is being copied.
 *
 * A copy writes a record per directory VISITED, and a record can name the same
 * directory any number of times: three records - one naming a second 300
 * times, that one naming a third 300 times - are 90,000 sealed writes, each a
 * round trip, all inside the entry budget. In a real tree a directory is in
 * one place, or in two after a move that was interrupted between attaching
 * and detaching; four allows for one of those inside another.
 */
const MAX_SHARED = 4;

/** One copy's budget and mode. See `copy`. */
interface CopyRun {
    /** The path being copied, for errors. */
    from: string;
    /** Where it is being copied to, for errors about the destination. */
    to: string;
    /** False for the dry run that proves the copy fits before it writes anything. */
    write: boolean;
    entries: number;
    pathChars: number;
    /** How many times each source directory id has been reached so far. */
    reached: Map<string, number>;
    /** Entries visited since the event loop last had a turn. */
    sinceTurn: number;
    /** The cache generation the copy began under. See `VfsNamespace.generation`. */
    gen: number;
}

/**
 * An entry map with no prototype.
 *
 * Every `DirNode.entries` must be one of these. An ordinary object - which is
 * what JSON.parse and `{}` both produce - answers `entries["constructor"]` with
 * the inherited Object constructor, a phantom entry no listing ever shows, and
 * treats `entries["__proto__"] = entry` as a prototype change rather than a new
 * key, so JSON.stringify drops it and a write that reported success stored
 * nothing. Those are real folder and file names; the map has to hold them
 * rather than the names being refused.
 */
function emptyEntries(): Record<string, Entry> {
    return Object.create(null) as Record<string, Entry>;
}

/**
 * Look a name up among a directory's OWN entries.
 *
 * Belt and braces alongside the null-prototype map: a node built somewhere that
 * forgot `emptyEntries()` still cannot resolve a name to something inherited.
 */
function entryIn(node: DirNode, name: string): Entry | undefined {
    return Object.hasOwn(node.entries, name) ? node.entries[name] : undefined;
}

/**
 * Refuse to put anything at `name` in `dir` when an entry this version cannot
 * read is already there.
 *
 * For every operation that refuses an existing destination - rename, copy,
 * mkdir, including the parents writeFile creates. A hidden entry is not a free
 * name: it may be a newer SDK's, and replacing it would erase it with no word
 * to anyone. writeFile and writeManifest DO replace one, because putting their
 * file at that exact name is what they were asked to do, and a recursive
 * delete of that exact name removes one.
 */
function assertNotHidden(dir: OpenDir, name: string, path: string): void {
    if (Object.hasOwn(dir.hidden, name)) {
        throw new VfsConflictError(`${printable(path, 1024)} already exists, but this version cannot read it; a recursive delete removes it`);
    }
}

/**
 * Is `now` still the entry an operation read at a name before it waited on
 * something? The same kind and id, and for a file the same version; a move
 * mark set or cleared in between does not count. Absent both times is the same.
 * Where a decision rests on the mark, `markedMeanwhile` checks that as well.
 */
function sameEntry(before: Entry | undefined, now: Entry | undefined): boolean {
    if (!before || !now) return before === now;
    if (before.kind !== now.kind || before.id !== now.id) return false;
    return before.kind === "dir" || (now.kind === "file" && now.manifest.id === before.manifest.id);
}

/**
 * Has a move marked the entry at a name since an operation read it there
 * unmarked? Then a move of it is under way - see `DirEntry.moving` - and it is
 * about to be named in a second place, which a decision made from the unmarked
 * read did not allow for.
 */
function markedMeanwhile(before: Entry, now: Entry): boolean {
    return now.moving === true && before.moving !== true;
}

/** Refuse a write because another write changed `path` while this one waited. See `VfsNamespace.mutate`. */
function changedMeanwhile(path: string): VfsConflictError {
    return new VfsConflictError(`${path} was changed by another write while this one was in progress; nothing was written over it`);
}

/**
 * Refuse an operation on `path` because this namespace is moving it - or,
 * `inside`, something in it. See `VfsNamespace.inMotion`.
 */
function beingMoved(path: string, inside = false): VfsConflictError {
    const what = inside ? `something in ${path} is` : `${path} is`;
    return new VfsConflictError(`${what} being moved; nothing was changed - try again once the move has finished`);
}

/**
 * Refuse an operation on `path` because a move or a delete of it - or,
 * `inside`, of it or of something in it - holds its move lock on this
 * device: in another tab of the app, or in this one. See
 * `VfsCoordinator.holdMoving`.
 */
function heldElsewhere(path: string, inside = false): VfsConflictError {
    const what = inside ? `${path}, or something in it, is` : `${path} is`;
    return new VfsConflictError(`${what} being moved or deleted in this app, in this tab or another; nothing was changed - try again once that has finished`);
}

/** A JSON object, as opposed to null, an array or a scalar. */
function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Numbers from a record, made into numbers. The record may not be something
 * this SDK wrote, and these go straight to callers typed as numbers - the CLI
 * formats `mtime` with `new Date(mtime).toISOString()`, which throws on
 * "yesterday", on an object and on 1e300. Anything else reads as 0.
 */
const asTime = (value: unknown): number =>
    typeof value === "number" && Math.abs(value) <= MAX_TIME ? value : 0;
const asCount = (value: unknown): number => (Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : 0);

/** Open a sealed value with the first of `keys` that opens it, or say why none did. */
async function openWithAny(
    raw: unknown,
    keys: Uint8Array[],
): Promise<{ value: unknown; key: Uint8Array } | { problem: string }> {
    let problem = "there is no key to open it with";
    for (const key of keys) {
        try {
            return { value: await openSealed(key, raw), key };
        } catch (err) {
            if (!(err instanceof SealedRecordError)) throw err;
            problem = err.message;
        }
    }
    return { problem };
}

/**
 * How deeply a value in a directory record may nest objects and arrays.
 *
 * Far past anything this SDK writes - an entry, its manifest, its chunks and
 * their fields are five levels - and far short of where JSON.stringify's
 * recursion gives out. JSON.parse has no such limit, so a record can hold a
 * value that parses and can never be written back.
 */
const MAX_NESTING = 32;

/** Does `value` nest objects or arrays more than `max` levels deep? Not recursive: that is the point. */
function nestedDeeperThan(value: unknown, max: number): boolean {
    const pending: Array<[unknown, number]> = [[value, 1]];
    for (let next = pending.pop(); next; next = pending.pop()) {
        const [at, depth] = next;
        if (typeof at !== "object" || at === null) continue;
        if (depth > max) return true;
        for (const child of Object.values(at)) if (typeof child === "object" && child !== null) pending.push([child, depth + 1]);
    }
    return false;
}

/**
 * A decrypted history record as this version reads it, and how many versions
 * it left out.
 *
 * Checked like a directory record, and for the same reasons: anything holding
 * the seed can write one. A version is kept only with a manifest that has an
 * id - `history` lists versions and `restore` takes one by its place in that
 * list, so the two must leave out the same ones - and nothing nested past
 * MAX_NESTING is kept, because the record is written back on every save and
 * JSON.stringify cannot write it. Anything else is an empty history, as it
 * always was.
 */
function readableHistory(value: unknown): { record: HistoryRecord; dropped: number } {
    if (!isObject(value) || !Array.isArray(value.versions)) return { record: { v: 1, versions: [] }, dropped: 0 };
    // No prototype, as for a directory record's fields.
    const record: Record<string, unknown> = Object.create(null);
    for (const [field, fieldValue] of Object.entries(value)) {
        if (field !== "versions" && !nestedDeeperThan(fieldValue, MAX_NESTING)) record[field] = fieldValue;
    }
    const versions = value.versions.filter((version) =>
        isObject(version) && isObject(version.manifest) && typeof version.manifest.id === "string" &&
        !nestedDeeperThan(version, MAX_NESTING));
    record.versions = versions;
    return { record: record as unknown as HistoryRecord, dropped: value.versions.length - versions.length };
}

/**
 * Why a decrypted directory record cannot be read, or null when it can.
 *
 * `unseal` returns whatever JSON.parse produced, and the record may have been
 * written by anything holding the seed, or by a newer version of this SDK. An
 * unknown `v` is refused outright rather than read on a best-effort basis:
 * reading it as v1 and writing it back would silently downgrade it.
 */
function recordProblem(value: unknown): string | null {
    if (!isObject(value)) return "it is not an object";
    if (value.v !== 1) {
        const v = typeof value.v === "number" || typeof value.v === "string"
            ? printable(String(value.v), 32)
            : typeof value.v;
        return `it has format version ${v}, and this version reads only 1`;
    }
    if (!isObject(value.entries)) return "its entries are missing or not a map";
    return null;
}

/**
 * What an entry id looks like: `newId()` mints 22 characters of unpadded
 * base64 with `+` and `/` dropped, and the root's id is "root". A little
 * looser than that, never looser than a store key can carry.
 *
 * The id is not just a label. `dirKey(id)` and `historyKey(id)` are store
 * keys, and Client's store puts the key in a URL: a lone surrogate made
 * encodeURIComponent throw, and an id past the Durable Object's 2048-byte key
 * limit got a 500 - from every walk above the entry, and from every attempt
 * to delete it, for good.
 */
const ENTRY_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Is this an entry this version knows how to follow?
 *
 * Every entry needs an id this SDK could have minted - see ENTRY_ID. A file
 * needs a manifest with an id of its own - version control tells versions
 * apart by it, and skips an entry without one, so the working tree must skip
 * it too or the two disagree about what is there. A directory needs a key
 * that is really an AES-256 key, because every walk decodes it and a bad one
 * would throw from somewhere far less helpful. Anything else - an unknown
 * kind, a missing field, a bare scalar - is not an error in the RECORD, only
 * in that one entry, and hiding one entry is the same outcome as someone
 * deleting it.
 */
function readableEntry(value: unknown): value is Entry {
    if (!isObject(value) || typeof value.id !== "string" || !ENTRY_ID.test(value.id)) return false;
    if (value.kind === "file") return isObject(value.manifest) && typeof value.manifest.id === "string";
    if (value.kind !== "dir" || typeof value.key !== "string") return false;
    try {
        return fromBase64(value.key).length === 32;
    } catch {
        return false;   // not base64 at all
    }
}

/**
 * Every entry a directory references that this version can FOLLOW - the
 * visible ones, plus any set aside only because its NAME is unusable.
 *
 * For sweep and purge, which must account for everything a record points at
 * rather than show it: an entry hidden for its name is still a directory whose
 * records are reachable, or a file whose content the directory owns.
 */
function followable(dir: OpenDir): Array<[name: string | null, entry: Entry]> {
    const out: Array<[string | null, Entry]> = Object.entries(dir.node.entries);
    // A null name: the entry is followed, but no path is ever built from it.
    for (const value of Object.values(dir.hidden)) if (readableEntry(value)) out.push([null, value]);
    return out;
}

/** How many of a directory's hidden entries this version cannot follow at all. */
function unfollowable(dir: OpenDir): number {
    return Object.values(dir.hidden).filter((value) => !readableEntry(value)).length;
}

/** The id of every entry `dir` follows, and whether an entry with that id is marked: `SubtreeShape`'s view of it. */
function namedIn(dir: OpenDir): Map<string, boolean> {
    const named = new Map<string, boolean>();
    for (const [, entry] of followable(dir)) named.set(entry.id, named.get(entry.id) === true || entry.moving === true);
    return named;
}

export class VfsNamespace {
    private rootKey: Uint8Array | null = null;
    /**
     * Decrypted directory records, by id.
     *
     * The file tree re-lists constantly while typing, and every miss is a
     * network round trip plus a decrypt. Invalidated precisely on write rather
     * than by TTL — a stale directory listing shows files that are not there.
     *
     * What a cached read resolves to is also THE copy of that record: the one
     * every edit of it is made to, and the one written. See `mutate`.
     */
    private cache = new Map<string, Promise<OpenDir>>();
    /**
     * Bumped by `clearCache`, which is for a change of identity.
     *
     * A read or write begun before it can finish after it, and what it read
     * or wrote belongs to whoever was signed in before. So every record
     * carries the generation it was read under, and none goes into the cache,
     * or is edited as the cache's copy, under another.
     */
    private generation = 0;
    /**
     * The record each promise in `cache` resolved to, and each write in
     * `writing` is sending: what `editable` finds without waiting.
     */
    private readonly copyOf = new WeakMap<Promise<unknown>, OpenDir>();
    /**
     * The write of each directory record still in flight, by id.
     *
     * Two writes of one record must land in the order they were made. The
     * personal space has no compare-and-swap: of two writes of one key that
     * are in flight together it keeps whichever request finishes last, and
     * that is often the one sent first. Then the earlier write, sealed before
     * the later edit was made, undoes it. That is how a file deleted forever
     * from the Trash, while the move that put it there was still being
     * written, came back. So each write waits for the one before it, and a
     * read that has to fetch the record waits for its write too: see
     * `openDirById`.
     */
    private readonly writing = new Map<string, Promise<void>>();
    /**
     * Every entry this namespace is moving right now, by id.
     *
     * A move between two directories marks the entry before it puts it in
     * the second (see `rename`), and a mark is all a later operation can
     * see. It cannot tell a move still writing from one that was
     * interrupted, and was taken for the second: a delete that began after
     * a move had marked a folder looked for the folder's other half, found
     * none yet, and purged it while the move was putting it in its new
     * place; a second move of a file finished the "interrupted" move and
     * left it named in two places. So a move holds its entry here until it
     * has taken it from where it was, and `rename` and `delete` refuse an
     * entry that is here - or, for a delete, a folder holding one. A delete
     * holds what it deletes the same way: see `deleting`.
     *
     * This set is one namespace's. With a coordinator, a move also holds
     * the entry's move lock for every tab on the device, for as long as the
     * entry is here: see `VfsCoordinator.holdMoving`.
     */
    private readonly inMotion = new Set<string>();
    /**
     * What each delete under way in this namespace is deleting, by entry id,
     * one set per delete: its target from the moment it has found the target
     * not in `inMotion`, and everything it read below the target once it has
     * read it. Each delete lets go of its own set when it is done.
     *
     * A delete waits after it has read what it will let go of: on more
     * reads, and on a read of the whole tree for the other half of a move.
     * A move of any of it that started meanwhile could put it in its new
     * place, fail to take it from the old, and end, all before the delete's
     * detach. Ended, it was no longer in `inMotion`; and an entry that was
     * marked already showed no change. So the delete let go of what the
     * move had just named somewhere else. Now `rename` refuses an entry that
     * is here, or one on a way from the root that passes through a folder
     * that is: everything below a delete's target, read yet or not.
     */
    private readonly deleting = new Set<ReadonlySet<string>>();
    /**
     * The write of each record that has not gone out yet, by id: the one
     * the next edit of that record joins. See `queue`.
     */
    private readonly waiting = new Map<string, Batch>();
    /**
     * Announcements heard from other tabs, counted. `heardAt` is the count
     * at the last one for each record, `missedAt` the count when some may
     * have been missed. A copy read after both holds every write announced:
     * see `current`.
     */
    private hearing = 0;
    private missedAt = 0;
    private readonly heardAt = new Map<string, number>();
    /**
     * Each record a write of which this namespace marked as begun and could
     * not count, and has said so, until one is counted. And whether it has
     * said that a write it could not mark or count may be lost, which it
     * says only once. See `notCounted`.
     */
    private readonly uncounted = new Set<string>();
    private lossWarned = false;
    /**
     * The copy of each record this namespace is writing under the record's
     * lock, by id, from when it has decided what to write until it has
     * counted the write, or failed to. Its counter reads as unknown
     * meanwhile, as this write has begun and is not counted yet, but the
     * copy holds every write of the record another tab has counted, and no
     * other tab can make one until this one lets go of the lock. See
     * `dropStale`.
     */
    private readonly locked = new Map<string, OpenDir>();

    /**
     * Each directory a `createDir` here has named whose write has not landed
     * yet, by entry id: a promise that settles - and never rejects - once
     * that write has landed or failed. See `mkdir`.
     */
    private readonly naming = new Map<string, Promise<void>>();
    private readonly historyLimit: number;
    private readonly maxEntries: number;
    private readonly maxPathChars: number;

    constructor(private readonly deps: VfsNamespaceDeps) {
        this.historyLimit = deps.historyLimit ?? DEFAULT_HISTORY_LIMIT;
        this.maxEntries = deps.limits?.entries ?? DEFAULT_MAX_ENTRIES;
        this.maxPathChars = deps.limits?.pathChars ?? DEFAULT_MAX_PATH_CHARS;
        // Another tab's write of a record leaves this tab's copy of it out of date: see `heard`.
        deps.coordinator?.onAnnounce((id) => this.heard(id));
    }

    /**
     * The working directory relative paths resolve against.
     *
     * Kept here rather than left to each caller so that a CLI, a script and the
     * SDK all agree on what "here" means — the alternative is every consumer
     * re-implementing `cd`, and disagreeing about `..`.
     */
    private _cwd = "/";

    /** The current working directory. Always absolute. */
    get cwd(): string {
        return this._cwd;
    }

    /**
     * Change the working directory.
     *
     * Verifies the target is a real directory, so a typo fails here — where the
     * message can name the path — rather than turning every later relative path
     * into a confusing "does not exist".
     */
    async cd(path: string): Promise<string> {
        const target = this.resolve(path);
        if (target !== "/") {
            const found = await this.find(target);
            if (!found) throw new VfsNotFoundError(target);
            if (found.entry.kind !== "dir") throw new VfsConflictError(`${target} is not a directory`);
        }
        this._cwd = target;
        return target;
    }

    /** Resolve a path against the working directory. Absolute paths pass through. */
    resolve(path: string): string {
        return resolveFrom(this._cwd, path);
    }

    /** True when the master seed is held, so the root key can be derived. */
    get unlocked(): boolean {
        return this.deps.seed() !== null;
    }

    /**
     * Drop every cached record.
     *
     * Call after signing in as someone else — the cache is keyed by directory
     * id with no notion of whose filesystem it came from, and serving one
     * identity's directories to another would be the worst possible bug here.
     */
    clearCache(): void {
        // Whatever is still being read or written for the identity before
        // stays out of the cache from here on: see `generation`.
        this.generation++;
        this.cache.clear();
        this.heardAt.clear();
        this.rootKey = null;
        this._cwd = "/";   // a different identity's tree has different directories
    }

    /**
     * Call `handler` when this filesystem changes somewhere else — another tab,
     * another machine, the CLI.
     *
     * Deliberately a NOTIFICATION, not a diff: the frame names a record id, and
     * a record id is not a path (paths are resolved by walking, and the walk is
     * what the change may have invalidated). So the cache is dropped and the
     * caller re-reads whatever it is actually showing. Trying to translate a
     * record id back into a path would mean maintaining a reverse index that
     * could itself go stale.
     *
     * Returns an unsubscribe function. A runtime with no socket (a CLI) gets a
     * no-op rather than an error — watching is an optimisation, never required
     * for correctness.
     */
    watch(handler: () => void): () => void {
        if (!this.deps.subscribe) return () => {};
        return this.deps.subscribe((raw) => {
            let frame: { _t?: string; key?: string };
            try {
                frame = typeof raw === "string" ? JSON.parse(raw) : (raw as typeof frame);
            } catch {
                return;
            }
            if (frame?._t !== "change" || typeof frame.key !== "string") return;
            if (!frame.key.startsWith("vfs/")) return;   // someone else's data on the shared feed

            // Drop only the record that changed.
            //
            // Clearing everything looked cheap and is not: our own writes echo
            // back, so a sync that writes a few hundred files emptied the cache
            // a few hundred times, and every path resolution in flight went back
            // to the network for the root and every directory below it. The key
            // names the record, so there is no need to guess.
            const id = frame.key.startsWith("vfs/d/") ? frame.key.slice("vfs/d/".length) : null;
            if (id) this.cache.delete(id);
            else this.cache.clear();   // a shape we do not recognise: be safe
            handler();
        });
    }

    // ---- reads --------------------------------------------------------------

    async exists(path: string): Promise<boolean> {
        // The root has no entry of its own, so `find` cannot see it — and
        // answering false here told `vfs mount` at "/" that the whole remote
        // tree was missing on every pass. It always exists once the filesystem
        // can be opened; opening it is also what makes a locked VFS throw
        // rather than reassure.
        if (this.resolve(path) === "/") {
            await this.root();
            return true;
        }
        return (await this.find(path)) !== null;
    }

    async stat(path: string): Promise<VfsStat> {
        // The root, as `exists` sees it: a directory, there whenever the
        // filesystem can be opened. The two used to disagree about it.
        if (this.resolve(path) === "/") {
            const root = await this.root();
            return { path: "/", name: "", kind: "dir", size: 0, mtime: asTime(root.node.mtime), versions: 0 };
        }
        const found = await this.find(path);
        if (!found) throw new VfsNotFoundError(this.resolve(path));
        return toStat(this.resolve(path), found.name, found.entry);
    }

    /** Immediate children of a directory. One record fetch. */
    async list(path = "."): Promise<VfsStat[]> {
        const dir = await this.openDir(path);
        const base = this.resolve(path);
        return this.children(dir).map(({ name, entry }) => toStat(join(base, name), name, entry));
    }

    /**
     * A directory's entries in listing order: directories first, then by name.
     * Shared by `list` and `walk`, so a walk's output order is exactly the order
     * of the listings it is made of.
     */
    private children(dir: OpenDir): Array<{ name: string; kind: Entry["kind"]; entry: Entry }> {
        // No name check here: `readRecord` has already set every unusable name
        // aside, once per record. Checking here instead ran a regex, an encode
        // and a warning per entry on EVERY visit - and a walk may visit one
        // record a great many times - while charging none of it to the budget.
        return Object.entries(dir.node.entries)
            .map(([name, entry]) => ({ name, kind: entry.kind, entry }))
            .sort(byDirsThenName);
    }

    private warn(message: string): void {
        // Kept quiet by default in a browser console that the user cannot act
        // on, but never silent: a dropped entry is a real difference between
        // what is stored and what is shown.
        console.warn(`[muhkoo/vfs] ${message}`);
    }

    /**
     * Every file path under a prefix, depth-first.
     *
     * Deliberately separate from `list`: this walks the whole subtree, which is
     * one fetch per directory. Fine for a project, wrong as a default.
     *
     * Throws VfsLimitError past the entry budget or the depth ceiling, and
     * VfsCorruptRecordError for a directory it cannot read, rather than
     * returning part of the tree. Skips (with a warning) a directory that is
     * one of its own ancestors.
     */
    async walk(path = "."): Promise<string[]> {
        return (await this.walkEntries(path)).filter((e) => e.kind === "file").map((e) => e.path);
    }

    /**
     * Every entry under a prefix - directories as well as files - depth-first,
     * each directory just before its contents. `walk` is this with the
     * directories filtered out, so the two can never disagree about what is in
     * a tree; version control uses this one because a commit records empty
     * directories too.
     */
    async walkEntries(path = "."): Promise<VfsStat[]> {
        const out: VfsStat[] = [];
        await this.eachEntry(path, (stat) => void out.push(stat));
        return out;
    }

    /**
     * `walkEntries` without the list: `visit` is called with each entry in
     * the same order, and for a file with its manifest - the handle
     * `statManifest` gives, without resolving the path all over again, which
     * on a deep tree cost far more than the walk itself. Null for a directory.
     *
     * For a caller that does not need every entry at once. Version control
     * compares the working tree with a commit as it goes, where holding the
     * whole walk beside the whole commit, and a map of one beside a map of
     * the other, ran a 512MB heap out of memory inside the default budgets.
     * The same guards and budgets as `walk`, which is built on this.
     */
    async eachEntry(path: string, visit: (stat: VfsStat, manifest: FileManifest | null) => void): Promise<void> {
        /**
         * One directory at a time, depth-first, with the records it is about to
         * need fetched ahead of it.
         *
         * Everything a walk holds is its current path - and `walkEntries`
         * its output, which is why a caller comparing as it goes uses this
         * instead. It used to list sibling directories concurrently, each one fanning out into
         * its own children the same way, eight at a time PER DIRECTORY - so
         * eight per level, multiplying down the tree. Records are cached by id,
         * so on a planted fan-out nothing ever waited, and every visit up to
         * the entry budget was in flight at once, each with its own copy of
         * the ancestor set: 29 records inside both default budgets ran a 3GB
         * heap out of memory. The budgets count OUTPUT; only the shape of the
         * traversal bounds what is held while producing it.
         *
         * Round trips still overlap. Walking directories one after another
         * cost the sum of their latencies - 1-2.1s against a real project
         * before a single file had been read - so ReadAhead keeps up to
         * WALK_CONCURRENCY fetches going for the directories the walk will
         * reach next, and the walk's own reads come out of the same pool.
         *
         * Directories are opened by the id and key their parent holds, not by
         * re-resolving each path from the root, which is what lets the cycle
         * guard below work on IDENTITY. It used to be a set of paths, and a
         * record whose two entries both point back at itself produces a fresh
         * path at every level - /loop/a, /loop/b, /loop/a/a - so it never fired
         * and 2^64 visits ran the process out of memory.
         */
        const start = this.resolve(path);
        const opened = await this.openChain(start);
        if (!opened) throw new VfsNotFoundError(start);

        // Bounded here, not by the cycle guard, which cannot see a tree that
        // fans out without ever looping - in entries, and in the characters of
        // the paths those entries become, since that is what the result holds.
        let budget = this.maxEntries;
        let chars = this.maxPathChars;
        // Directories already reported as cycles. A fan-out can reach one
        // record hundreds of thousands of times, and a warning per visit is a
        // line per path in the user's terminal.
        const reported = new Set<string>();
        // The id of every directory from the root down to the one being
        // listed. It starts with the chain above `start`, so a pointer back
        // above where the walk began is a cycle too, and a subtree's walk
        // agrees with the same subtree in a walk of the root. Added to and
        // taken from as the walk goes down and back up; never copied.
        const onPath = new Set(opened.chain);
        const stack: WalkFrame[] = [];
        const ahead = new ReadAhead(
            WALK_CONCURRENCY,
            (dir) => this.children(dir),
            (id) => this.cache.has(id),
            (entry, at) => this.openDirById(entry.id, fromBase64(entry.key), at),
        );

        /** Charge for a directory's listing, and make it the walk's current one. True when it is time to yield. */
        const enter = (dir: OpenDir, dirPath: string): boolean => {
            const children = this.children(dir);
            const turn = Math.floor(budget / YIELD_EVERY);
            budget -= children.length;
            if (budget < 0) throw new VfsLimitError("entries", this.maxEntries, start, dirPath);
            // Charged before any of these paths is built.
            for (const { name } of children) chars -= childPathLength(dirPath, name);
            if (chars < 0) throw new VfsLimitError("pathChars", this.maxPathChars, start, dirPath);
            stack.push({ id: dir.id, path: dirPath, children, next: 0 });
            ahead.scan(dir, dirPath, children);
            return Math.floor(budget / YIELD_EVERY) !== turn;
        };

        try {
            // One continuation, so a yield parks the whole walk and not one
            // branch of it while the rest carry on.
            if (enter(opened.dir, start)) await nextTurn();
            while (stack.length) {
                const frame = stack[stack.length - 1];
                if (frame.next === frame.children.length) {
                    stack.pop();
                    // The bottom frame is `start`, which is part of the chain.
                    if (stack.length) onPath.delete(frame.id);
                    continue;
                }
                const { name, entry } = frame.children[frame.next++];
                const at = childPath(frame.path, name);
                if (entry.kind !== "dir") {
                    visit(toStat(at, name, entry), entry.manifest);
                    continue;
                }
                // A directory that is one of ITS OWN ancestors is a true cycle:
                // everything in it is already on this branch. Only the path
                // above this entry counts - not every directory seen so far -
                // because rename() deliberately leaves a moved subtree reachable
                // from two parents, and both paths must keep appearing.
                if (onPath.has(entry.id)) {
                    if (!reported.has(entry.id)) {
                        reported.add(entry.id);
                        this.warn(`skipping ${at}: it is one of its own ancestors (the tree contains a cycle)`);
                    }
                    continue;
                }
                // Thrown, not truncated: a sync reads a missing path as a
                // deleted one. The frames are the levels below `start`.
                if (stack.length > MAX_DEPTH) throw new VfsLimitError("depth", MAX_DEPTH, start, at);
                const child = await ahead.open(entry, at);
                visit(toStat(at, name, entry), null);
                onPath.add(entry.id);
                if (enter(child, at)) await nextTurn();
            }
        } finally {
            // However it ended. A walk that failed must not leave fetches
            // running in the background after the caller has moved on.
            ahead.stop();
        }
    }

    async readFile(path: string): Promise<Uint8Array> {
        const entry = await this.expectFile(path);
        return this.deps.content.read(entry.manifest);
    }

    async readText(path: string): Promise<string> {
        return new TextDecoder().decode(await this.readFile(path));
    }

    /**
     * A file's manifest — the handle itself, without reading the bytes.
     *
     * Version control records manifests rather than content, so a commit costs
     * a hash and a reference, not a copy.
     */
    async statManifest(path: string): Promise<{ manifest: FileManifest; size: number }> {
        const entry = await this.expectFile(path);
        return { manifest: entry.manifest, size: entry.size };
    }

    /**
     * Read content by its manifest, wherever it came from.
     *
     * A merge needs the COMMON ANCESTOR's version of a file, which by definition
     * is not in the working tree any more. The manifest is the whole capability,
     * so no path lookup is involved.
     */
    async readByManifest(manifest: FileManifest): Promise<Uint8Array> {
        return this.deps.content.read(manifest);
    }

    /**
     * Pin content that something other than the working tree depends on.
     *
     * A commit references a manifest, so it is an OWNER of that content — without
     * a reference of its own, deleting the file from the working tree would free
     * shards the history still needs, and checking out an older commit would find
     * the content gone. (It did, in test.)
     */
    async retainManifest(manifest: FileManifest): Promise<void> {
        await this.deps.content.retain(manifest);
    }

    /**
     * Point a path at content that already exists.
     *
     * This is how a checkout restores a file: the bytes are in the shard store
     * already, so nothing is uploaded or downloaded — only the directory record
     * changes. Takes a reference, because a second path now depends on those
     * shards.
     */
    async writeManifest(path: string, manifest: FileManifest, size: number): Promise<VfsStat> {
        const target = this.resolve(path);
        const name = basename(target);
        assertValidName(name);
        await this.mkdir(dirname(target), { recursive: true });

        const parent = await this.openDir(dirname(target));
        if (entryIn(parent.node, name)?.kind === "dir") throw new VfsConflictError(`${target} is a directory`);

        await this.deps.content.retain(manifest);
        let entry!: FileEntry;
        await this.mutate(parent, (node) => {
            // Whatever is at the name now, after the wait above, is what
            // this replaces - and what it takes the id and history from.
            const prior = entryIn(node, name);
            if (prior?.kind === "dir") throw new VfsConflictError(`${target} is a directory`);
            entry = {
                kind: "file",
                id: prior?.id ?? newId(),
                manifest,
                size,
                mtime: Date.now(),
                versions: asCount(prior?.versions),
                // Still half of an interrupted move, if it was: see DirEntry.moving.
                ...(prior?.moving === true ? { moving: true as const } : {}),
            };
            node.entries[name] = entry;
        });
        return toStat(target, name, entry);
    }

    // ---- writes -------------------------------------------------------------

    /**
     * Create a directory. `recursive` creates missing parents and tolerates an
     * existing target, matching `mkdir -p`.
     */
    async mkdir(path: string, opts: { recursive?: boolean } = {}): Promise<void> {
        const target = this.resolve(path);
        if (target === "/") return;
        // Before anything is created. This is also the whole of the check for
        // writeFile and writeManifest: a file may sit in the deepest
        // directory, and they create its parent through here.
        assertWritableDepth(target);
        const parts = segments(target);

        let current = "/";
        for (let i = 0; i < parts.length; i++) {
            const name = parts[i];
            const isLast = i === parts.length - 1;
            const next = join(current, name);
            let dir = await this.openDir(current);
            let existing = entryIn(dir.node, name);
            // Named by a mkdir here whose write has not landed. Until it has,
            // the name is a promise, not a fact: with a coordinator, that edit
            // is made again under the lock to the folder as another tab left
            // it, and comes to nothing when that tab named a directory there
            // first - and whatever was saved meanwhile into the one named
            // here is in a directory nothing names. A failed write drops it
            // too. So wait for the write, and look again.
            let unwritten = existing && this.naming.get(existing.id);
            while (unwritten) {
                await unwritten;
                dir = await this.openDir(current);
                existing = entryIn(dir.node, name);
                unwritten = existing && this.naming.get(existing.id);
            }
            if (!existing) assertNotHidden(dir, name, next);

            if (existing) {
                if (existing.kind === "file") throw new VfsConflictError(`${next} is a file`);
                if (isLast && !opts.recursive) throw new VfsConflictError(`${next} already exists`);
            } else {
                if (!isLast && !opts.recursive) throw new VfsNotFoundError(current);
                await this.createDir(current, name, next, opts.recursive === true);
            }
            current = next;
        }
    }

    /**
     * Refuse now what creating these directories with `mkdir -p` would refuse
     * part way: one deeper than MAX_DEPTH, or a name on the way held by an
     * entry this version cannot read. Writes nothing.
     *
     * For an operation that removes things before it writes - a checkout -
     * so that a refusal comes before anything is gone. A FILE in the way is
     * not refused: such an operation removes those first.
     */
    async assertCreatable(dirs: Iterable<string>): Promise<void> {
        let checked = 0;
        for (const target of new Set([...dirs].map((dir) => this.resolve(dir)))) {
            assertWritableDepth(target);
            let dir = await this.root();
            let at = "/";
            for (const name of segments(target)) {
                at = join(at, name);
                const entry = entryIn(dir.node, name);
                if (!entry) {
                    assertNotHidden(dir, name, at);
                    break;   // everything below it is to be created
                }
                if (entry.kind !== "dir") break;
                dir = await this.openDirById(entry.id, fromBase64(entry.key), at);
            }
            // Once the tree has been walked every record is cached, and nothing
            // here waits on anything.
            if (++checked % YIELD_EVERY === 0) await nextTurn();
        }
    }

    /**
     * Write a file, creating parent directories as needed.
     *
     * The previous version is pushed onto the file's history record before the
     * directory entry is replaced, so an interrupted write can lose the new
     * version but never the old one.
     */
    async writeFile(
        path: string,
        data: Uint8Array | string | Blob,
        opts: { type?: string; onProgress?: (done: number, total: number) => void } = {},
    ): Promise<VfsStat> {
        const target = this.resolve(path);
        const name = basename(target);
        assertValidName(name);
        const parentPath = dirname(target);
        await this.mkdir(parentPath, { recursive: true });

        const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
        const { manifest, size } = await this.deps.content.write(
            bytes,
            { name, type: opts.type ?? contentTypeFor(name) },
            { onProgress: opts.onProgress },
        );

        const parent = await this.openDir(parentPath);
        const prior = entryIn(parent.node, name);
        if (prior?.kind === "dir") throw new VfsConflictError(`${target} is a directory`);

        const id = prior?.id ?? newId();
        let versions = asCount(prior?.versions);
        if (prior) versions = await this.pushHistory(parent, name, prior as FileEntry, target, manifest);

        let entry!: FileEntry;
        await this.mutate(parent, (node) => {
            // The version just pushed onto the history was `prior`. If
            // another write has replaced or removed it since, it is not the
            // version this one overwrites, and writing on regardless would
            // lose that write - from the file, and from its history.
            const now = entryIn(node, name);
            if (now?.kind === "dir") throw new VfsConflictError(`${target} is a directory`);
            if (!sameEntry(prior, now)) throw changedMeanwhile(target);
            entry = {
                kind: "file", id, manifest, size, mtime: Date.now(), versions,
                // Still half of an interrupted move, if it was: see DirEntry.moving.
                ...(now?.moving === true ? { moving: true as const } : {}),
            };
            node.entries[name] = entry;
        });
        return toStat(target, name, entry);
    }

    /**
     * Delete a file, or a directory when `recursive`.
     *
     * `keepContent` removes the entry WITHOUT releasing its shards - or, for
     * a directory, the shards of anything in it. A checkout needs that: the
     * file is leaving the working tree, but commits still reference the same
     * manifest, and releasing would free content history depends on.
     */
    async delete(path: string, opts: { recursive?: boolean; keepContent?: boolean } = {}): Promise<void> {
        const target = this.resolve(path);
        if (target === "/") throw new VfsConflictError("the root directory cannot be deleted");
        const name = basename(target);
        const opened = await this.openChain(dirname(target));
        if (!opened) throw new VfsNotFoundError(dirname(target));
        const parent = opened.dir;
        const entry = entryIn(parent.node, name);
        if (!entry) {
            if (!Object.hasOwn(parent.hidden, name)) throw new VfsNotFoundError(target);
            // An entry this version cannot read, asked for by its exact name.
            // It may be a newer version's, and what it holds cannot be known,
            // so only a recursive delete removes it - and only detaches it,
            // letting go of nothing: a leak is the safe way to be wrong. The
            // way to clear a name that mkdir, rename, copy and a checkout
            // refuse, short of deleting everything around it.
            const where = printable(target, 1024);
            if (!opts.recursive) throw new VfsConflictError(`${where} cannot be read by this version; a recursive delete removes it`);
            await this.mutate(parent, (_node, record) => void delete record.hidden[name]);
            this.warn(`removed ${where} without clearing out what it held: this version cannot read it`);
            return;
        }
        // Being moved by this namespace: it is marked already, or about to be,
        // and on its way to a second place. Letting go of it here would let
        // go of what the move puts there. See `inMotion`.
        if (this.inMotion.has(entry.id)) throw beingMoved(target);
        // And from here until it is done, a move of it, or of anything below
        // it, that begins in this namespace is refused. See `deleting`.
        const claim = new Set([entry.id]);
        this.deleting.add(claim);
        // On this device, the move locks of the target and of everything read
        // below it. See below.
        let release: (() => void) | null = null;
        try {
            // Every directory above the target, the root first. None of them is
            // part of what is being deleted, whatever an entry below says.
            const above = new Set(opened.chain);

            // Three steps, in this order: read everything the delete will touch,
            // detach the entry, then let go of what it held.
            //
            // Letting go came first once, and the entry was detached last. Any
            // failure in between - a network error, most simply - left the entry
            // in place with some of its content already released, and the obvious
            // next step, trying again, released that content a SECOND time.
            // Content is reference-counted and shared by copies, so that freed
            // bytes another file still used. Now a failure before the detach has
            // changed nothing, and nothing after it can fail: releasing is
            // best-effort, and a leak is the safe way to be wrong.
            let doomed: OpenDir[] = [];
            // What each of them named when it was read, for the check before the detach.
            let shape: SubtreeShape = new Map();
            // Every id found below the target: claimed once it has all been read,
            // re-checked against `inMotion` at the detach and, with a coordinator,
            // whose move locks it holds. See below.
            let ids: Set<string> = new Set();
            // Whether any of it is half of an interrupted move. See below.
            let moving = entry.kind === "file" && entry.moving === true;
            if (entry.kind === "dir" && above.has(entry.id)) {
                // The entry IS a pointer to a directory above it - the root, or
                // this entry's own parent. Removing the pointer is what was asked
                // for; clearing out what it points at would delete everything
                // around the target, the target included.
                if (!opts.recursive) throw new VfsConflictError(`${target} is not empty`);
                this.warn(`detaching ${target} without clearing it out: it is a directory above it in the tree`);
            } else if (entry.kind === "dir") {
                const child = await this.openDirById(entry.id, fromBase64(entry.key), target).catch((err) => {
                    // An unreadable directory must still be removable, or the user
                    // is stuck with an error they can do nothing about. Its subtree
                    // cannot be enumerated, so it is detached rather than purged and
                    // whatever it holds is left for sweep(). Only when asked for
                    // recursively: without that we cannot know it is empty.
                    if (!(err instanceof VfsCorruptRecordError) || !opts.recursive) throw err;
                    this.warn(`detaching ${target} without clearing it out: its record cannot be read`);
                    return null;
                });
                if (child) {
                    // Entries this version cannot read still count: calling the
                    // directory empty would delete them along with it.
                    const empty = !Object.keys(child.node.entries).length && !Object.keys(child.hidden).length;
                    if (!empty && !opts.recursive) throw new VfsConflictError(`${target} is not empty`);
                    const found = await this.subtree(child, target, above);
                    // Something in it is being moved by this namespace: the same
                    // as the target being moved, a level down.
                    for (const id of found.ids) if (this.inMotion.has(id)) throw beingMoved(target, true);
                    for (const id of found.ids) claim.add(id);
                    doomed = found.dirs;
                    shape = found.shape;
                    ids = found.ids;
                    moving = entry.moving === true || found.moving;
                }
            }

            // On this device, the move lock of the target and of everything read
            // below it, held from here until what they held has been let go of.
            // A move in another tab holds the lock of what it moves until it has
            // taken it from where it was. A delete that found it marked looked
            // for its other half before the move had put it there, found none,
            // and let go of what the move then named in its new place; one that
            // was writing the parent let a move of something below start, and
            // then purged it. Held here, a move of any of it that is under way
            // refuses this delete, and none can start until it is done. What it
            // does not cover - anything named below since it was read - the check
            // in the edit refuses. See `VfsCoordinator.holdMoving`.
            //
            // Taken before the look for the other half of a move below, not
            // after it: a move in another tab that began during that look could
            // put the entry in its new place, fail to take it from the old, and
            // let go of its lock, all before this took it - and what it named
            // was let go of here. Not before the reads above, which find what is
            // below. A move in another tab that begins during them still holds
            // its lock here if it is under way, and this delete is refused;
            // ended, it came before the look and the checks below, which read
            // again what it wrote. See below.
            const coordinator = this.deps.coordinator;
            // What the look and the checks below must read again.
            let stale: ReadonlySet<string> = new Set();
            if (coordinator) {
                release = await this.holdAll(coordinator, [entry.id, ...ids]);
                if (!release) throw heldElsewhere(target, ids.size > 0);
                // A move that let go of its lock just before this took it had
                // counted its writes by then, though this tab may not have heard
                // of them: what was read above that another tab has written
                // since is read again - every record cached, for the look, which
                // reads the whole tree. A move that took a file out of a folder
                // read above, from this tab's old copy, had that file let go of
                // with the folder; one that went from the other half of a move
                // to a folder this tab's old copy did not show it in had the
                // content it took with it let go of. See `dropStale`.
                //
                // And the way to the target, looked up before anything else.
                // A delete in another tab of a folder on it had let go of the
                // target's lock, which it held, only once it had counted its
                // write of the folder above the one it deleted - but it purged
                // that one, and all below, which counts nothing. Gone on from
                // the old copies, this wrote the purged parent back and let go
                // of what the target held a second time, while a copy of it, or
                // a commit, still named that content. So what on the way has
                // been written since it was read is read again, and the way is
                // looked up again, as a move's way to where it goes is: it must
                // lead to the same entry, through the same folders, not marked
                // since.
                //
                // Looked up again even when nothing on it is out of date now:
                // a write of this tab's own may have read a folder on it again,
                // under that folder's lock, after the look above, and counted
                // its write. That copy is current by now, and no longer what the
                // look saw.
                const read = doomed.map((dir) => dir.id);
                stale = await this.dropStale(coordinator, [...opened.chain, ...(moving ? this.cache.keys() : []), ...read]);
                const again = await this.openChain(dirname(target));
                if (!again) throw new VfsNotFoundError(dirname(target));
                if (again.chain.some((id, i) => id !== opened.chain[i])) throw changedMeanwhile(dirname(target));
                const now = entryIn(again.dir.node, name);
                if (!now) throw new VfsNotFoundError(target);
                if (!sameEntry(entry, now) || markedMeanwhile(entry, now)) throw changedMeanwhile(target);
            }

            // A move between two directories that was interrupted leaves what it
            // moved named in both, and letting go of it here would take it from
            // the other copy: the directory record purged with every file in it,
            // or a file's content and history released. Only a marked entry can
            // be one of those (see `rename`), so only then is the whole tree
            // read, once, to find out what is still named elsewhere. Still before
            // anything changes: a failure here leaves the tree as it was.
            const elsewhere = moving ? await this.namedElsewhere(parent.id, name) : undefined;

            // The check in the edit below looks at each record to be purged as it
            // is then, which needs it to hand: a change reported meanwhile may
            // have dropped one from the cache, and so may the counters above.
            // Read again, it is still checked against what was read before.
            for (const dir of doomed) if (stale.has(dir.id) || !this.editable(dir)) await this.reopen(dir);

            let purging = doomed;
            await this.mutate(parent, (node) => {
                // What is let go of below is what `entry` held. Gone since, it
                // was let go of already; replaced, the name holds something this
                // delete has not read. Marked since, a move of it has begun, and
                // what it holds is about to be named somewhere `elsewhere` did
                // not see - if it was looked for at all.
                const now = entryIn(node, name);
                if (!now) throw new VfsNotFoundError(target);
                if (!sameEntry(entry, now) || markedMeanwhile(entry, now)) throw changedMeanwhile(target);
                // Marked already when this delete read it, a move that has since
                // taken the entry - or something below it - would not mark it a
                // second time, so `markedMeanwhile` and `currentSubtree` would not
                // see it either. `inMotion` is live, not a snapshot, so it still
                // does: re-checked here, at the last moment before the detach.
                // Since `deleting`, a move here cannot begin on any of it once
                // this delete has claimed it, so these are a second guard.
                if (this.inMotion.has(entry.id)) throw beingMoved(target);
                for (const id of ids) if (this.inMotion.has(id)) throw beingMoved(target, true);
                // And what is purged is what the records below hold now - unless
                // something in them has been moved, or begun to move, since they
                // were read; or, with a coordinator, named there since, as its
                // move lock is not held. See `currentSubtree`.
                const current = this.currentSubtree(doomed, shape, coordinator ? ids : undefined);
                if (!current) throw changedMeanwhile(target);
                purging = current;
                delete node.entries[name];
            });

            if (elsewhere === null) {
                // Part of the tree cannot be read, so it is unknown whether the
                // other copy is in it. Keeping what may be its contents costs
                // storage until a sweep; letting go of them could lose them.
                this.warn(`detached ${target} but kept what it held: a move of it was interrupted, and part of the tree cannot be read to find the other copy`);
                return;
            }
            if (entry.kind === "dir") await this.purge(purging, elsewhere, opts.keepContent);
            else await this.letGo(new Map([[entry.id, [{ dir: parent, entry }]]]), elsewhere, opts.keepContent);
            if (elsewhere && entry.moving === true) await this.settle(entry.id, elsewhere);
        } finally {
            release?.();
            this.deleting.delete(claim);
        }
    }

    /**
     * Move or rename. Works across directories, which is the same operation:
     * detach the entry from one parent and attach it to another.
     *
     * A directory move is O(1) regardless of how much is inside it — the
     * subtree records are not touched at all, because nothing in them records
     * its own path. Except a move to a DEEPER place, which reads the subtree
     * first: what is below must still be inside MAX_DEPTH once it is moved.
     */
    async rename(from: string, to: string): Promise<void> {
        const src = this.resolve(from);
        const dst = this.resolve(to);
        if (src === dst) return;
        if (src === "/") throw new VfsConflictError("the root directory cannot be moved");
        if (isUnder(dst, src)) throw new VfsConflictError(`cannot move ${src} into itself`);

        const srcName = basename(src);
        const dstName = basename(dst);
        assertValidName(dstName);

        const source = await this.openChain(dirname(src));
        if (!source) throw new VfsNotFoundError(dirname(src));
        const srcParent = source.dir;
        const entry = entryIn(srcParent.node, srcName);
        if (!entry) throw new VfsNotFoundError(src);
        // Another move of it is under way here. Its mark cannot tell that
        // move from an interrupted one, and finishing it as one named the
        // entry in two places. Held from here, before the first wait, so two
        // moves begun together cannot both get past this. See `inMotion`.
        if (this.inMotion.has(entry.id)) throw beingMoved(src);
        // A delete here has begun on it, or on a folder on its way from the
        // root. Moved now, it could be put in its new place just before the
        // delete let go of what it holds. Not the root, which no delete is
        // of: one claims it only through an entry below that names it, and
        // lets go of nothing of it. In the same step as the check above, as
        // a delete makes its claim in the same step as its own. See
        // `deleting`.
        const lineage = [entry.id, ...source.chain.slice(1)];
        if ([...this.deleting].some((claim) => lineage.some((id) => claim.has(id)))) throw heldElsewhere(src);
        this.inMotion.add(entry.id);

        // Each record is re-opened before it is written: creating the
        // destination's parents below may have written to the source's.
        const edit = (path: string, change: (node: DirNode, record: OpenDir) => boolean | void) =>
            this.openDir(path).then((dir) => this.mutate(dir, change));
        let unmarkLanded = false;
        // The same for every tab of the app on this device: the entry's move
        // lock, held for as long as it is in `inMotion`. Another tab's move
        // or delete of it holds it, and taking that move's mark for an
        // interrupted one named the entry in two places, or purged it. See
        // `VfsCoordinator.holdMoving`.
        let release: (() => void) | null = null;
        // And the locks of the folders on the way to where it goes, shared,
        // for as long. See below.
        let into: (() => void) | null = null;
        try {
            const coordinator = this.deps.coordinator;
            if (coordinator) {
                release = await coordinator.holdMoving(entry.id);
                if (!release) throw heldElsewhere(src);
                // The look above was at this tab's copies of the folders on the
                // way to the entry. A delete in another tab of the entry, or of
                // a folder on that way, may have finished before this took the
                // lock, which the delete held: it had counted its writes by
                // then, though this tab may not have heard of them. Moved
                // regardless, the entry was marked in a record the delete had
                // purged, and named in its new place with its content let go
                // of. So whatever on the way another tab has written since it
                // was read is read again, and the entry looked for again.
                if ((await this.dropStale(coordinator, source.chain)).size) {
                    const again = await this.openChain(dirname(src));
                    if (!again) throw new VfsNotFoundError(dirname(src));
                    if (again.chain.some((id, i) => id !== source.chain[i])) throw changedMeanwhile(dirname(src));
                    const now = entryIn(again.dir.node, srcName);
                    if (!now) throw new VfsNotFoundError(src);
                    if (!sameEntry(entry, now) || markedMeanwhile(entry, now)) throw changedMeanwhile(src);
                }
            }
            if (entry.kind === "dir") {
                assertWritableDepth(dst);
                if (segments(dst).length > segments(src).length) await this.assertFitsAt(src, dst);
            }
            await this.mkdir(dirname(dst), { recursive: true });
            const way = await this.openChain(dirname(dst));
            if (!way) throw new VfsNotFoundError(dirname(dst));
            let dstParent = way.dir;
            if (coordinator && dstParent.id !== ROOT_ID) {
                // The folder it goes into, and every folder above that one
                // but the root, held shared: other moves into any of them
                // share them, and a delete of one - which holds the lock of
                // its target and of everything it read below - holds it
                // alone. A move into a folder that another tab was deleting
                // put what it moved in a record the delete then purged: in no
                // listing, its content kept. Not that folder alone: it may be
                // new since the delete read the tree - made by the `mkdir`
                // above, or by another tab - and the delete does not hold a
                // lock it did not read. Its target's is on the way here. The
                // root is never deleted.
                into = await this.holdAll(coordinator, way.chain.slice(1), true);
                if (!into) throw heldElsewhere(dirname(dst));
                // A delete of one of them may have finished since they were
                // looked up, and counted its write of the folder above before
                // it let go of their locks, though this tab may not have
                // heard of it: read again whatever on the way another tab has
                // written since it was read, and look again. Gone, or another
                // folder anywhere on the way, the move stops here, before its
                // mark.
                await this.dropStale(coordinator, way.chain);
                const again = await this.openChain(dirname(dst));
                if (!again) throw new VfsNotFoundError(dirname(dst));
                if (again.chain.some((id, i) => id !== way.chain[i])) throw changedMeanwhile(dirname(dst));
                dstParent = again.dir;
            }
            if (entryIn(dstParent.node, dstName)) throw new VfsConflictError(`${dst} already exists`);
            assertNotHidden(dstParent, dstName, dst);

            // Both ends were looked at before the waits above, and another write
            // may have changed either since: replaced the entry being moved, or
            // put something at the destination. Moving on regardless would write
            // the old entry over the new one, or this one over the other. Or
            // marked the entry: another move of it has begun. Taking it as well
            // would name it in two places, and each move would unmark its own.
            const take = (node: DirNode): Entry => {
                const now = entryIn(node, srcName);
                if (!now || !sameEntry(entry, now) || markedMeanwhile(entry, now)) throw changedMeanwhile(src);
                return now;
            };
            const free = (node: DirNode, record: OpenDir) => {
                if (entryIn(node, dstName)) throw new VfsConflictError(`${dst} already exists`);
                assertNotHidden(record, dstName, dst);
            };

            if (dstParent.id === srcParent.id) {
                // One record, so one write: the move happens entirely or not at all.
                await edit(dirname(src), (node, record) => {
                    const moved = take(node);
                    free(node, record);
                    delete node.entries[srcName];
                    node.entries[dstName] = { ...moved, mtime: Date.now() };
                });
                return;
            }

            // Two records, attached before detaching: interrupted, the entry is
            // in both rather than in neither. Both copies are marked for as long
            // as that can be so, because they share everything below them, and a
            // delete of either would otherwise let go of the other's contents.
            // An entry already marked is half of an earlier interrupted move, and
            // keeps its mark.
            const marked = entry.moving === true;
            let moved = entry;
            if (!marked) {
                await edit(dirname(src), (node) => {
                    moved = take(node);
                    node.entries[srcName] = { ...moved, moving: true };
                });
            }
            // Whether the edit below has put the entry at the destination: set
            // as its last step, after every check, each time it runs.
            let attached = false;
            try {
                await edit(dirname(dst), (node, record) => {
                    attached = false;
                    free(node, record);
                    node.entries[dstName] = { ...moved, moving: true, mtime: Date.now() };
                    attached = true;
                });
            } catch (err) {
                // Refused before it put anything at the destination - another
                // write took the name first - so the entry is still in one
                // place only, and the mark this move put on it would stay for
                // good: on a file, every version that falls off its history
                // kept; on either, every delete of it reading the whole tree.
                // Not when the write failed instead: the destination may hold
                // the entry by now, and the mark is what keeps a delete of
                // either copy from letting go of the other's. Best-effort.
                if (!marked && !attached) {
                    await edit(dirname(src), (node) => {
                        const now = entryIn(node, srcName);
                        if (now?.id !== entry.id || now.moving !== true) return false;
                        node.entries[srcName] = unmarked(now);
                        return true;
                    }).catch(() => {});
                }
                throw err;
            }
            // A file's history is sealed with its directory's key, and from here
            // on the directory that opens it is this one.
            if (entry.kind === "file") await this.rekeyHistory(entry.id, [srcParent.key], dstParent.key);
            await edit(dirname(src), (node) => {
                // Gone already leaves nothing to detach, and nothing to write.
                // Replaced, it is not this entry to take away: the move stops
                // here, in both places. Not `take`: the entry is marked by now,
                // by this move or the earlier one it finishes.
                const now = entryIn(node, srcName);
                if (!now) return false;
                if (!sameEntry(entry, now)) throw changedMeanwhile(src);
                delete node.entries[srcName];
                // Explicit, as in `createDir` and `settle`: noImplicitReturns.
                return true;
            });
            unmarkLanded = !marked;
        } finally {
            // Named in one place from here, the destination. A delete of it
            // there goes ahead as for an entry an interrupted move left marked
            // - which the Trash's "delete forever" relies on while the mark is
            // still being cleared.
            this.inMotion.delete(entry.id);
            release?.();
            into?.();
        }
        if (unmarkLanded) {
            await edit(dirname(dst), (node) => {
                const landed = entryIn(node, dstName);
                if (landed?.id === entry.id) node.entries[dstName] = unmarked(landed);
            });
        }
    }

    /**
     * Refuse to move the directory at `src` to `dst` when something in it
     * would then be deeper than MAX_DEPTH from the root. Writes nothing.
     *
     * Measured only moving deeper, because it reads the whole subtree: one
     * move of a 40-deep tree under a 30-deep directory was accepted when only
     * the moved directory was measured, and every walk of the root threw from
     * then on. A part that cannot be read cannot be measured, and does not
     * stop the move - that record stops every walk above it already.
     */
    private async assertFitsAt(src: string, dst: string): Promise<void> {
        const room = MAX_DEPTH - segments(dst).length;
        try {
            await this.eachEntry(src, ({ kind, path }) => {
                if (kind !== "dir") return;
                const below = path.slice(src.length);
                if (below.split("/").length - 1 <= room) return;
                throw new VfsLimitError("depth", MAX_DEPTH, dst, dst + below, "writing");
            });
        } catch (err) {
            if (!(err instanceof VfsCorruptRecordError)) throw err;
        }
    }

    /**
     * Copy a file or a directory tree.
     *
     * Copying a FILE moves no bytes: content is immutable and content-addressed,
     * so the new entry simply points at the same manifest. A 200 MB asset
     * duplicates in one small metadata write, and the shard store already holds
     * exactly one copy of it.
     *
     * The copy gets a NEW file id, so it does not inherit or share history —
     * two paths sharing an id would mean saving one silently pushed a version
     * onto the other.
     */
    async copy(from: string, to: string): Promise<VfsStat> {
        const src = this.resolve(from);
        const dst = this.resolve(to);
        if (src === "/") throw new VfsConflictError("the root directory cannot be copied");
        if (src === dst) throw new VfsConflictError(`${dst} already exists`);
        if (isUnder(dst, src)) throw new VfsConflictError(`cannot copy ${src} into itself`);

        const found = await this.find(src);
        if (!found) throw new VfsNotFoundError(src);

        const dstName = basename(dst);
        assertValidName(dstName);
        await this.mkdir(dirname(dst), { recursive: true });
        const dstParent = await this.openDir(dirname(dst));
        if (entryIn(dstParent.node, dstName)) throw new VfsConflictError(`${dst} already exists`);
        assertNotHidden(dstParent, dstName, dst);

        // Twice over: a dry run first, which fetches and checks everything the
        // copy will visit - cycles, depth, both budgets, unreadable records -
        // and writes nothing. A copy that is going to fail then fails before
        // its first write, instead of after up to a whole budget's worth of
        // records and references, all left unreachable. The records are
        // cached by then, so the real pass costs writes, not fetches.
        const gen = this.generation;
        const run = (write: boolean): CopyRun => ({
            from: src, to: dst, write, entries: this.maxEntries, pathChars: this.maxPathChars, reached: new Map(), sinceTurn: 0, gen,
        });
        const depth = segments(dst).length;
        await this.cloneEntry(found.entry, src, run(false), null, depth);
        const copied = await this.cloneEntry(found.entry, src, run(true), null, depth);
        await this.mutate(dstParent, (node, record) => {
            // Looked at before the copy was made, which takes as long as the
            // tree is big: another write may have taken the name since.
            if (entryIn(node, dstName)) throw new VfsConflictError(`${dst} already exists`);
            assertNotHidden(record, dstName, dst);
            node.entries[dstName] = copied;
        });
        return toStat(dst, dstName, copied);
    }

    /**
     * Paths matching a glob, relative to the whole filesystem.
     *
     * Matching happens on the client over a walk of the tree, so the cost is one
     * record fetch per directory — cheap for a project, and worth knowing before
     * pointing it at the root of a large filesystem. Use `walk` when the prefix
     * already narrows it.
     */
    async glob(pattern: string, opts: { from?: string } = {}): Promise<string[]> {
        const re = globToRegExp(this.resolve(pattern));
        return (await this.walk(opts.from ?? ".")).filter((path) => re.test(path));
    }

    /**
     * Delete metadata records no longer reachable from the root.
     *
     * These accumulate because every write touches exactly one record: if two
     * devices edit the same directory - or two tabs, where there is no
     * coordinator - the personal space keeps whichever put arrives last (a
     * VFS write sends no HLC, and the space applies puts of one key in arrival
     * order), which can leave a child whose parent entry lost the race. The
     * per-record queue and the coordinator order writes within one device
     * only. Unreachable is harmless —
     * it is invisible and undecryptable-by-nobody — but it costs storage, so
     * this reclaims it.
     *
     * Deliberately explicit, never automatic: a sweep racing another tab's
     * in-flight write could delete a record that is about to be referenced.
     * Run it when the filesystem is idle.
     */
    async sweep(opts: { force?: boolean } = {}): Promise<{ removed: string[] }> {
        // With a coordinator: what another tab has written since this tab
        // read it is read again, not followed in an old copy that may not
        // name what it now names - which would then be deleted here.
        const coordinator = this.deps.coordinator;
        if (coordinator) await this.dropStale(coordinator, [...this.cache.keys()]);
        const root = await this.root();
        // A record that cannot be read throws out of here, before anything is
        // deleted: with part of the tree unknown, "unreachable" is a guess.
        // Behind a name no path can reach, though, an unreadable record is one
        // the user cannot delete either: it is counted with the entries this
        // version cannot read - refused below unless forced - and, forced, kept
        // and not followed. `references` follows entries hidden only for their
        // NAME: what they point at is still referenced, and so not an orphan.
        const named = await this.references();
        const reachable = new Set([
            ...[...named.dirs].map(dirKey),
            ...[...named.files.keys()].map(historyKey),
        ]);
        const unreadable = named.unknown;

        // The same caution for an ENTRY this version cannot read: a newer
        // SDK's entry may be the only thing keeping some record reachable, and
        // there is no way to follow it from here.
        if (unreadable && !opts.force) {
            throw new VfsConflictError(
                `refusing to sweep: ${unreadable} entr${unreadable === 1 ? "y" : "ies"} in this filesystem ` +
                    "cannot be read by this version, so what they reference is unknown; " +
                    "upgrade, or sweep with force to go ahead anyway",
            );
        }

        // Only ever consider OUR records: the personal space is shared with
        // chat keys, space keys and the legacy file mirror, and a sweep that
        // reached beyond its own namespace would be a data-loss bug. The store
        // is asked for `vfs/` only; the regex stays, because `vfs/space` is
        // under `vfs/` too and a store may ignore the prefix.
        const mine = (await this.deps.store.list("vfs/")).filter((k) => /^vfs\/[dh]\//.test(k));
        const orphans = mine.filter((k) => !reachable.has(k));

        // A root that read as EMPTY while orphans exist is the shape of a failed
        // load, not of a fresh filesystem — deleting here would wipe a tree we
        // merely failed to reach. Refuse unless the caller insists.
        const rootEmpty = Object.keys(root.node.entries).length === 0;
        if (rootEmpty && orphans.length && !opts.force) {
            throw new VfsConflictError(
                `refusing to sweep ${orphans.length} record(s) with an empty root — ` +
                    "this looks like a failed load rather than an empty filesystem; sweep with force if it really is empty",
            );
        }

        for (const key of orphans) await this.deps.store.delete(key).catch(() => {});
        return { removed: orphans };
    }

    // ---- history ------------------------------------------------------------

    /** Prior versions of a file, newest first. One record fetch. */
    async history(path: string): Promise<Array<{ size: number; mtime: number }>> {
        const target = this.resolve(path);
        const entry = await this.expectFile(target);
        const { record } = await this.readHistory(await this.openDir(dirname(target)), basename(target), entry, target);
        return record.versions.map(({ size, mtime }) => ({ size: asCount(size), mtime: asTime(mtime) }));
    }

    /**
     * Restore a prior version, where 0 is the most recent one.
     *
     * The current version is pushed onto history first, so restoring is itself
     * undoable rather than a one-way door.
     */
    async restore(path: string, index = 0): Promise<VfsStat> {
        const target = this.resolve(path);
        const name = basename(target);
        const parent = await this.openDir(dirname(target));
        const entry = entryIn(parent.node, name);
        if (!entry || entry.kind !== "file") throw new VfsNotFoundError(target);

        const { record } = await this.readHistory(parent, name, entry, target);
        const version = record.versions[index];
        if (!version) throw new VfsNotFoundError(`${target} version ${index}`);

        const versions = await this.pushHistory(parent, name, entry, target, version.manifest);
        let restored!: FileEntry;
        await this.mutate(parent, (node) => {
            // As for writeFile: the version pushed onto the history was `entry`.
            const now = entryIn(node, name);
            if (!sameEntry(entry, now)) throw changedMeanwhile(target);
            restored = {
                kind: "file",
                id: entry.id,
                manifest: version.manifest,
                size: asCount(version.size),
                mtime: Date.now(),
                versions,
                ...(now?.moving === true ? { moving: true as const } : {}),
            };
            node.entries[name] = restored;
        });
        return toStat(target, name, restored);
    }

    // ---- internals ----------------------------------------------------------

    private async expectFile(path: string): Promise<FileEntry> {
        const found = await this.find(path);
        if (!found) throw new VfsNotFoundError(this.resolve(path));
        if (found.entry.kind !== "file") throw new VfsConflictError(`${this.resolve(path)} is a directory`);
        return found.entry;
    }

    /** Resolve a path to its entry, or null. Root has no entry of its own. */
    private async find(path: string): Promise<{ name: string; entry: Entry } | null> {
        const target = this.resolve(path);
        if (target === "/") return null;
        const parent = await this.openDirOrNull(dirname(target));
        if (!parent) return null;
        const name = basename(target);
        const entry = entryIn(parent.node, name);
        return entry ? { name, entry } : null;
    }

    private async root(): Promise<OpenDir> {
        const seed = this.deps.seed();
        if (!seed) throw new VfsLockedError();
        if (!this.rootKey) {
            const gen = this.generation;
            const key = await deriveRootKey(seed);
            // Derived from the seed of whoever was signed in before a
            // clearCache: start again, with the seed of whoever is now.
            if (gen !== this.generation) return this.root();
            this.rootKey = key;
        }
        return this.openDirById(ROOT_ID, this.rootKey, "/");
    }

    /** Open a directory by path, creating nothing. Throws if it is missing. */
    private async openDir(path: string): Promise<OpenDir> {
        const dir = await this.openDirOrNull(path);
        if (!dir) throw new VfsNotFoundError(this.resolve(path));
        return dir;
    }

    private async openDirOrNull(path: string): Promise<OpenDir | null> {
        return (await this.openChain(path))?.dir ?? null;
    }

    /** Open a directory by path, along with the id of every directory on the way to it. */
    private async openChain(path: string): Promise<{ dir: OpenDir; chain: string[] } | null> {
        let dir = await this.root();
        const chain = [dir.id];
        let at = "/";
        for (const name of segments(this.resolve(path))) {
            const entry: Entry | undefined = entryIn(dir.node, name);
            if (!entry || entry.kind !== "dir") return null;
            at = join(at, name);
            dir = await this.openDirById(entry.id, fromBase64(entry.key), at);
            chain.push(dir.id);
        }
        return { dir, chain };
    }

    /**
     * `path` is only for error messages. The cache is keyed by id, so when two
     * paths reach one record - a move interrupted between attach and detach -
     * the error names whichever asked first.
     */
    private openDirById(id: string, key: Uint8Array, path?: string): Promise<OpenDir> {
        const hit = this.cache.get(id);
        if (hit) return hit;
        // Before anything is read, so that from here on this namespace hears
        // of any later write of the record by another tab. Starting to hear -
        // for the first time, or for someone else - clears the cache (see
        // `heard`), which is why it comes before this read is cached.
        this.deps.coordinator?.listen();

        // The PROMISE goes in the cache, not the resolved value.
        //
        // Reading a project means resolving hundreds of paths that share the
        // same handful of directories. Caching only the settled value leaves
        // every concurrent reader to miss and fire its own request for the same
        // record — which is how loading one project turned into thousands of
        // identical `vfs/d/<id>` fetches, most of them in flight at once.
        const gen = this.generation;
        // Reads `pending` only after its first `await`: before that, the const is not yet initialised.
        const load = async (): Promise<OpenDir> => {
            // Not while a write of this record is still in flight: see
            // `writing`. Our own writes echo back over the personal-space
            // socket, and `watch` drops the record each one names, so a read
            // can miss with the write still on its way - and the store would
            // answer with the copy from BEFORE it. An edit made to that copy
            // is queued behind the write, and then stored over it. So wait
            // for the latest write queued, which waits on every one before it,
            // to land or fail - and then for any queued while this read
            // waited, since the one it waited for may have failed with that
            // one still on its way. A record with no write in flight is
            // fetched at once.
            let awaited: Promise<void> | undefined;
            for (let inFlight = this.writing.get(id); inFlight && inFlight !== awaited; inFlight = this.writing.get(id)) {
                awaited = inFlight;
                await inFlight.catch(() => {});
            }
            // Not after a clearCache, though: the cache now is the next
            // identity's, and this read only answers whoever asked for it.
            if (awaited && gen === this.generation) {
                // A write that landed put the record it wrote back in the
                // cache, and the next edit of this directory is made to that.
                // Answer with it rather than fetch a second copy: two copies
                // of one record, each edited and written, undo each other's
                // edits. When the cache holds nothing else - the write failed,
                // or a change since has dropped the record - ask the store.
                const now = this.cache.get(id);
                if (now && now !== pending) return now;
                // Empty, when the write failed: it dropped what the cache held,
                // and after an echo that was this very read. Put it back before
                // asking the store, so a read that comes in meanwhile shares
                // this copy instead of fetching a second one.
                if (!now) this.cache.set(id, pending);
            }
            return this.fetchRecord(id, key, gen, path);
        };
        const pending = load().catch((err) => {
            // A failed read must not be remembered, or one blip poisons the
            // directory for the life of the session.
            if (this.cache.get(id) === pending) this.cache.delete(id);
            throw err;
        });
        // Registered before anyone else can wait on it, so it is known by
        // the time any of them goes on to edit the record: see `editable`.
        pending.then((dir) => void this.copyOf.set(pending, dir), () => {});

        this.cache.set(id, pending);
        return pending;
    }

    /**
     * Fetch record `id` from the store and open it. Whatever another tab
     * announced before the fetch began is in what it returns (see
     * `current`), and so is every write its counter counts: read here, or
     * given as `counter` (see `OpenDir.counter`).
     */
    private async fetchRecord(id: string, key: Uint8Array, gen: number, path?: string, counter?: string | null): Promise<OpenDir> {
        const seen = this.hearing;
        // Before the fetch, never after it. A write that lands in between
        // then only makes this copy look out of date, which costs a read;
        // read after, the counter could count a write the answer missed.
        // Without a coordinator there is none, and nothing is awaited: a read
        // in Node takes the turns it always took.
        if (counter === undefined) counter = this.deps.coordinator ? await this.counterOf(id) : null;
        const raw = await this.deps.store.get(dirKey(id));
        // An absent record is an EMPTY directory, not an error: the root
        // exists before anything has been written to it, and a directory is
        // created by its parent naming it rather than by its own record
        // appearing.
        if (raw === null || raw === undefined) {
            const node: DirNode = { v: 1, entries: emptyEntries(), mtime: Date.now() };
            return { id, key, path, node, hidden: Object.create(null), gen, seen, counter } satisfies OpenDir;
        }
        // Present but unopenable is NOT absent. `unseal` folds the two
        // together, which suits a record that can simply be rebuilt; a
        // directory cannot, because rebuilding it means sealing an empty
        // one over whatever is really there. And it is not a raw
        // DOMException either: the typed error is what delete, purge and
        // sweep know how to step around, and it names the record.
        let value: unknown;
        try {
            value = await openSealed(key, raw);
        } catch (err) {
            if (err instanceof SealedRecordError) throw new VfsCorruptRecordError(id, path, err.message);
            throw err;
        }
        return this.readRecord(id, key, value, gen, seen, counter, path);
    }

    /** Record `id`'s write counter now: see `OpenDir.counter`. */
    private async counterOf(id: string): Promise<string | null> {
        const coordinator = this.deps.coordinator;
        if (!coordinator) return null;
        const [counter] = await coordinator.counters([id]).catch(() => [null]);
        return counter ?? null;
    }

    /**
     * Turn a decrypted record into an OpenDir, or throw.
     *
     * The record is THROWN on, never read as empty, when its shape is wrong -
     * see VfsCorruptRecordError. An individual entry of the wrong shape is set
     * aside in `hidden` instead: out of every read, but kept for the write.
     */
    private readRecord(
        id: string,
        key: Uint8Array,
        value: unknown,
        gen: number,
        seen: number,
        counter: string | null,
        path?: string,
    ): OpenDir {
        const problem = recordProblem(value);
        if (problem) throw new VfsCorruptRecordError(id, path, problem);
        const { entries: stored, ...fields } = value as DirNode & { entries: Record<string, unknown> };

        // Anything nested past MAX_NESTING is dropped outright, not kept to be
        // written back: JSON.stringify cannot write it, and every write to
        // this directory - even deleting a sibling - would throw.
        let dropped = 0;
        // No prototype, like the entry map: a field named `__proto__` is a
        // field to keep, not a prototype to set.
        const top: Record<string, unknown> = Object.create(null);
        for (const [field, fieldValue] of Object.entries(fields)) {
            if (nestedDeeperThan(fieldValue, MAX_NESTING)) dropped++;
            else top[field] = fieldValue;
        }
        const entries = emptyEntries();
        const hidden: Record<string, unknown> = Object.create(null);
        let unnamed = 0;
        let unreadable = 0;
        for (const [name, entry] of Object.entries(stored)) {
            if (nestedDeeperThan(entry, MAX_NESTING)) {
                dropped++;
                continue;
            }
            // The NAME is validated here, where it is read, as well as the
            // entry. A directory record is sealed under a key derivable from
            // the master seed, so its contents are not necessarily something
            // this SDK wrote, and the write-side check never sees them. An
            // unusable name is set aside rather than thrown on: one bad entry
            // must not make the whole directory unlistable, and callers walk
            // what is left straight into filesystem paths.
            if (!isSafeName(name)) unnamed++;
            else if (!readableEntry(entry)) unreadable++;
            else {
                entries[name] = entry;
                continue;
            }
            hidden[name] = entry;
        }
        if (unnamed || unreadable || dropped) {
            // Once per record fetched, however often a walk comes back to it.
            // Names are left out: they are exactly the ones not fit to print.
            const count = (n: number) => `${n} entr${n === 1 ? "y" : "ies"}`;
            const what = [
                unnamed && `${count(unnamed)} with an unusable name`,
                unreadable && `${count(unreadable)} this version cannot read`,
                dropped && `${dropped} value${dropped === 1 ? "" : "s"} nested too deeply to keep`,
            ].filter(Boolean).join(" and ");
            this.warn(`ignoring ${what} in ${path ?? `record ${printable(id, 40)}`}`);
        }
        // A v1 record's unknown top-level fields survive a write too.
        return { id, key, path, node: { ...(top as Omit<DirNode, "entries">), entries }, hidden, gen, seen, counter };
    }

    /**
     * Apply an edit to a directory record and persist it.
     *
     * `dir` says which record - its id, key and path - and nothing more. The
     * edit is made to THE copy of that record (see `editable`), which `dir`
     * may no longer be, and that copy is what is written. Editing whichever
     * copy the caller held let two copies of one record exist at once: an
     * overwrite held its directory across storing the old version's
     * history, a write of the directory failed meanwhile and dropped it from
     * the cache, and a save that then read a second copy and stored it,
     * successfully, was undone when the overwrite stored the first.
     *
     * So `edit` must take what it writes from the record it is given, not
     * from anything read off `dir` before an await - and re-check whatever it
     * relies on from then, throwing if another write changed it, before it
     * changes anything. Returning false writes nothing after all.
     *
     * The write that carries the edit may carry others, made while an
     * earlier write of the record was in flight (see `queue`): it lands, or
     * fails, for all of them at once.
     *
     * With a coordinator, the edit may be made a second time, to the record
     * as another tab left it, and refused then (see `replay`): an edit must
     * check everything before it changes anything, and whatever it sets
     * outside `node` and `record` must be safe to set again, since each run
     * overwrites the last.
     */
    private async mutate(dir: OpenDir, edit: Edit): Promise<void> {
        // At once when the copy is to hand, which it almost always is, so
        // that what the caller checked just before is still true when the
        // edit is made.
        const target = this.editable(dir) ?? await this.reopen(dir);
        if (edit(target.node, target) === false) return;
        this.touch(target);
        const ticket: Ticket = { edit };
        const batch = this.queue(target, ticket);
        const { write } = batch;
        try {
            await write;
        } catch (err) {
            // The edit above was made in place, on the very object the cache
            // holds. Left there after a failed write, the cache would show a
            // change the store never took - a deleted file gone from every
            // listing while it is still stored, and a retry told it does not
            // exist. Drop it, so the next read asks the store.
            //
            // Unless a later write of this record is already queued. It
            // seals the record as it stands when it is sent, this edit
            // included, so the cache shows what is about to be stored, and
            // dropping it would only send readers to the store for an older
            // copy. If that write fails too, it drops the cache itself.
            //
            // Nor from a cache cleared since: that is the next identity's.
            if (this.writing.get(target.id) === write && target.gen === this.generation) this.cache.delete(target.id);
            throw err;
        } finally {
            if (this.writing.get(target.id) === write) this.writing.delete(target.id);
        }
        this.adopt(target);
        // Made again to the record as another tab left it, it no longer
        // applied - see `replay` - and nothing of it was written.
        if (batch.refused.has(ticket)) throw batch.refused.get(ticket);
    }

    /**
     * The copy of `dir`'s record that edits are made to, if there is one
     * without waiting: the one the cache holds, once read.
     *
     * Failing that, the one a write in flight is sending. The record was
     * dropped from the cache - a change was reported, our own write's echo
     * among them - and a read that came in since is waiting for that write,
     * to answer with this very copy if it lands (see `openDirById`); if it
     * fails, the write an edit now queues behind it carries the copy instead.
     *
     * Undefined when the record is not cached and nothing is writing it, or
     * it is still being read: `reopen` waits for that. A record read before
     * `clearCache` is edited as it is, as it always was. It is not the copy of
     * anything the cache holds now, and must not be handed the next identity's.
     */
    private editable(dir: OpenDir): OpenDir | undefined {
        if (dir.gen !== this.generation) return dir;
        const cached = this.cache.get(dir.id);
        const write = this.writing.get(dir.id);
        const copy = (cached && this.copyOf.get(cached)) ?? (write && this.copyOf.get(write));
        return copy?.gen === this.generation ? copy : undefined;
    }

    /**
     * Read `dir`'s record - the cached read, or a fetch made once any write of
     * it in flight has settled - and then find the copy edits are made to.
     */
    private async reopen(dir: OpenDir): Promise<OpenDir> {
        for (;;) {
            await this.openDirById(dir.id, dir.key, dir.path);
            // What that read answered with, unless a change has dropped it
            // from the cache again since: then read it again.
            const copy = this.editable(dir);
            if (copy) return copy;
        }
    }

    /** Make `dir` the cached copy of its record - unless the cache has been cleared since it was read. */
    private adopt(dir: OpenDir): void {
        if (dir.gen !== this.generation) return;
        const cached = Promise.resolve(dir);
        this.copyOf.set(cached, dir);
        this.cache.set(dir.id, cached);
    }

    /** After an edit of `copy`: its time, and any entry it cannot read that the edit replaced. */
    private touch(copy: OpenDir): void {
        copy.node.mtime = Date.now();
        // A write to a hidden entry's exact name replaces it: that name now
        // means what this version wrote. Forgetting the old one here is also
        // what stops a later delete of the replacement from resurrecting it.
        for (const name of Object.keys(copy.hidden)) {
            if (Object.hasOwn(copy.node.entries, name)) delete copy.hidden[name];
        }
    }

    /**
     * The write that will carry the edit just made to `copy`.
     *
     * Writes of a record go out one at a time, each once the one before it
     * has landed or failed (see `writing`), and each seals the record as it
     * stands when it goes out. So a write still waiting carries every edit
     * made while it waits, and an edit made then joins it instead of
     * queueing a write of its own: a burst of edits of one directory while a
     * write of it is in flight costs two writes, not one per edit. Each is a
     * billed write; a 20-file upload into one folder cost twenty.
     */
    private queue(copy: OpenDir, ticket: Ticket): Batch {
        const open = this.waiting.get(copy.id);
        if (open?.copy === copy) {
            open.edits.push(ticket);
            return open;
        }
        const before = this.writing.get(copy.id);
        const batch = { copy, edits: [ticket], refused: new Map() } as Omit<Batch, "write"> as Batch;
        this.waiting.set(copy.id, batch);
        // Not sent until any earlier write of this record has landed: see
        // `writing`. Whether that one worked or not, this one still goes.
        const send = () => this.send(batch);
        batch.write = before ? before.then(send, send) : send();
        this.copyOf.set(batch.write, copy);
        this.writing.set(copy.id, batch.write);
        return batch;
    }

    /**
     * Send `batch`: from here on, an edit of its record goes in the next
     * write. With a coordinator, holding the lock every tab of the device
     * takes to write this record - see `sendLocked`.
     */
    private send(batch: Batch): Promise<void> {
        const coordinator = this.deps.coordinator;
        if (!coordinator) {
            this.close(batch);
            return this.writeRecord(batch.copy);
        }
        // Closed under the lock once it is sealed (see `sendLocked`), and
        // here too, for a lock never granted or a re-read that failed: left
        // open, a later edit of the same copy would join a write that has
        // already failed, and fail with it.
        return coordinator.lock(batch.copy.id, () => this.sendLocked(batch, coordinator)).finally(() => this.close(batch));
    }

    /** Stop `batch` taking more edits, as it is sealed. */
    private close(batch: Batch): void {
        if (this.waiting.get(batch.copy.id) === batch) this.waiting.delete(batch.copy.id);
    }

    /**
     * Send `batch` while no other tab can write its record.
     *
     * If another tab wrote the record since this copy was read, the copy is
     * out of date, and writing it would undo that tab's write. So it is read
     * again, here, under the lock, and every edit the batch carries is made
     * again to what was read (see `replay`). A copy no other tab has written
     * over is sent as it is: one tab on its own costs no extra request.
     *
     * Which it is, the record's write counter says (see
     * `VfsCoordinator.counters`). Read once the lock is granted, it counts
     * every write of the record another tab made, because each counts its
     * write, and waits for the count to be stored, before it lets go of the
     * lock. If it has moved since the copy was read, or cannot be told, the
     * copy is read again. Whether this tab has heard of another tab's write
     * does not decide it: an announcement can reach this tab after the
     * lock does, or never. One it has heard of can only add a read.
     *
     * The write is counted once it has landed or failed - one that failed
     * may have landed even so - and the other tabs are then told of it,
     * all before the lock is let go of.
     */
    private async sendLocked(batch: Batch, coordinator: VfsCoordinator): Promise<void> {
        const { copy } = batch;
        // Hearing for whoever is signed in now, before deciding: starting to
        // hear - or hearing someone else - marks every copy out of date.
        coordinator.listen();
        const now = await coordinator.begin(copy.id).catch(() => null);
        // Whether `copy` is, from here, the record as this tab leaves it.
        let decided = false;
        let sent = false;
        try {
            const current = now !== null && copy.counter === now && this.current(copy);
            const fresh = copy.gen === this.generation && !current
                ? await this.fetchRecord(copy.id, copy.key, copy.gen, copy.path, null)
                : null;
            // Nothing waits from here to the seal, so no edit can come in between.
            this.close(batch);
            decided = true;
            this.locked.set(copy.id, copy);
            if (fresh && !this.replay(batch, fresh)) return;
            sent = true;
            await this.writeRecord(copy);
            copy.seen = this.hearing;
        } finally {
            const counted = await coordinator.bump(copy.id).catch(() => null);
            // Not when the read above failed: the copy is what it was, and
            // the counter it held is out of date now.
            if (decided) copy.counter = counted;
            if (this.locked.get(copy.id) === copy) this.locked.delete(copy.id);
            if (counted === null) this.notCounted(copy, now !== null);
            else this.uncounted.delete(copy.id);
            if (sent) coordinator.announce(copy.id);
        }
    }

    /**
     * Say that a write of `copy`'s record could not be counted.
     *
     * `marked`: `VfsCoordinator.begin` stored its mark, which stays until a
     * count can be stored, so every tab reads the record again before it
     * writes it. Said once for each record, until a write of it is counted.
     *
     * Not marked, a tab whose IndexedDB works may take its copy for current
     * and write it over this write. Said once for this namespace, whatever
     * the record: where IndexedDB cannot be used at all, no write of any
     * folder is counted, and a warning for each said nothing new. And only
     * where another tab can count its writes can one be lost, which the
     * warning says: where no tab can, every tab reads each folder again.
     */
    private notCounted(copy: OpenDir, marked: boolean): void {
        const where = copy.path ?? `record ${printable(copy.id, 40)}`;
        if (!marked) {
            if (this.lossWarned) return;
            this.lossWarned = true;
            this.warn(
                `a write of ${where} by this tab could not be counted in IndexedDB, where this app's other tabs look before writing a folder. Such a write may be lost only if another tab of this app can count its writes: that tab may write the folder without reading it again. Said once per Client, for every write of a folder that cannot be counted`,
            );
            return;
        }
        if (this.uncounted.has(copy.id)) return;
        this.uncounted.add(copy.id);
        this.warn(`a write of ${where} by this tab could not be counted in IndexedDB; until one can be, every tab of this app reads ${where} again before writing it`);
    }

    /**
     * Make every edit in `batch` again, in order, to `fresh` - the record as
     * another tab left it - and make that the copy. An edit that no longer
     * applies throws, as it would have the first time, and is left out; its
     * caller gets what it threw. Every edit checks before it changes
     * anything (see `mutate`), so one that throws has changed nothing. True
     * when what is left changes the record, and so needs writing.
     */
    private replay(batch: Batch, fresh: OpenDir): boolean {
        const { copy } = batch;
        copy.node = fresh.node;
        copy.hidden = fresh.hidden;
        copy.seen = fresh.seen;
        copy.counter = fresh.counter;
        let changed = false;
        for (const ticket of batch.edits) {
            try {
                if (ticket.edit(copy.node, copy) !== false) changed = true;
            } catch (err) {
                batch.refused.set(ticket, err);
            }
        }
        if (changed) this.touch(copy);
        return changed;
    }

    /**
     * Another tab wrote record `id` - or, null, this namespace may have
     * missed some announcements. What the cache holds is read again when
     * next asked for, as a change frame from the personal space would have
     * it, and a copy read before then is read again before the next write
     * of its record (see `current`). A hint, not a guarantee: an
     * announcement can reach this tab after the next lock does, or never.
     * What decides whether a copy may be written over, or relied on under a
     * move's or a delete's locks, is the record's counter: see `sendLocked`
     * and `dropStale`.
     */
    private heard(id: string | null): void {
        const at = ++this.hearing;
        if (id === null) {
            this.missedAt = at;
            this.cache.clear();
            return;
        }
        this.heardAt.set(id, at);
        this.cache.delete(id);
    }

    /**
     * Does `copy` hold every write of its record another tab has announced
     * that this one has heard of? See `heard`. Only ever a reason to read it
     * again, never to take it for current: see `sendLocked`.
     */
    private current(copy: OpenDir): boolean {
        return copy.seen >= Math.max(this.missedAt, this.heardAt.get(copy.id) ?? 0);
    }

    /**
     * Drop from the cache every copy of a record in `ids` that may not hold
     * every write of it another tab has made: its counter has moved since
     * the copy was read, or cannot be told, or the copy is still being read.
     * Returns every id whose copy here is not known to be current - those,
     * and those not cached - so that the next read of each fetches it again,
     * once any write of it in flight here has landed or failed. Not a copy
     * this tab is writing under its lock (see `locked`): its counter reads
     * as unknown only because that write is not counted yet, and dropped,
     * the next read would wait for the write.
     *
     * The counters are read in one go, after the caller has taken the locks
     * it relies on: another tab counts each write of a record before it lets
     * go of the locks it held while writing it, the record's own and any
     * move lock, so what it wrote before letting go of one of them is
     * counted by then. Its announcements may not have reached this tab yet,
     * or ever. See `sendLocked`.
     */
    private async dropStale(coordinator: VfsCoordinator, ids: Iterable<string>): Promise<Set<string>> {
        const asked = [...new Set(ids)];
        const now = asked.length ? await coordinator.counters(asked).catch(() => asked.map(() => null)) : [];
        const stale = new Set<string>();
        asked.forEach((id, i) => {
            const cached = this.cache.get(id);
            const copy = cached && this.copyOf.get(cached);
            if (copy && copy.gen === this.generation && copy.counter !== null && copy.counter === now[i]) return;
            if (copy && copy.gen === this.generation && this.locked.get(id) === copy) return;
            if (cached) this.cache.delete(id);
            stale.add(id);
        });
        return stale;
    }

    /**
     * Seal a directory record as it stands NOW and put it in the store.
     *
     * Read at the moment of sending, not when the edit was made, so a write
     * that waited behind another carries every edit made to the record by
     * then, its own included.
     */
    private async writeRecord(dir: OpenDir): Promise<void> {
        const stored = Object.keys(dir.hidden).length
            ? { ...dir.node, entries: Object.assign(Object.create(null), dir.hidden, dir.node.entries) }
            : dir.node;
        let sealed: Awaited<ReturnType<typeof seal>>;
        try {
            sealed = await seal(dir.key, stored);
        } catch (err) {
            // JSON.stringify's own failures: a value too deeply nested to
            // write. Reading drops those from a stored record, so this is
            // what the write itself was given.
            if (!(err instanceof RangeError || err instanceof TypeError)) throw err;
            const where = dir.path ?? `the directory stored as record ${printable(dir.id, 40)}`;
            throw new VfsConflictError(`cannot write to ${where}: it would hold a value nested too deeply to store`);
        }
        await this.deps.store.put(dirKey(dir.id), sealed);
    }

    /** For `mkdir`: name a new, empty directory `path` in the one at `parentPath`. */
    private async createDir(parentPath: string, name: string, path: string, recursive: boolean): Promise<void> {
        assertValidName(name);
        const parent = await this.openDir(parentPath);
        const entry: DirEntry = { kind: "dir", id: newId(), key: toBase64(newDirKey()), mtime: Date.now() };
        // The directory the edit below last found there, if any.
        let there: Entry | undefined;
        const named = this.mutate(parent, (node, record) => {
            // mkdir looked before the wait above. A directory made there
            // since, by another `mkdir -p` of the same path - files saved
            // at once into a new folder - is kept, not replaced: whatever
            // was saved into it would go with it.
            const now = entryIn(node, name);
            there = now;
            if (now?.kind === "dir" && recursive) return false;
            if (now) throw new VfsConflictError(`${path} ${now.kind === "dir" ? "already exists" : "is a file"}`);
            assertNotHidden(record, name, path);
            node.entries[name] = entry;
            return true;
        });
        // Set before anyone can find the entry in the cached parent - `mutate`
        // makes the edit at once, or after a re-read - so a mkdir that finds
        // it there waits for this write. See `naming`.
        this.naming.set(entry.id, named.then(() => {}, () => {}).then(() => void this.naming.delete(entry.id)));
        await named;
        // The directory kept instead may be one another mkdir here named,
        // its write not landed yet: wait for that too, as `mkdir` does.
        const kept = there && this.naming.get(there.id);
        if (kept) await kept;
    }

    /**
     * Every directory record in a subtree, each once, opened - and nothing
     * changed. The first half of a recursive delete; see `delete`.
     *
     * Once per id, so a record that references another inside the subtree
     * cannot recurse forever, and a subtree reachable twice is not released
     * twice. And never a directory in `above` - the root and everything else
     * on the way down to the target - nor the root by any route. Deduplicating
     * alone let an entry naming the root pull the whole filesystem into the
     * delete, the root record included; a walk shows the same pointer as a
     * cycle and skips it, so this skips it too.
     *
     * `moving` says whether anything in it is marked as half of an
     * interrupted move, which is what makes a delete look for the other half.
     *
     * `ids` is every entry id in it, and `shape` what each record named when
     * it was read: see `currentSubtree`.
     */
    private async subtree(
        top: OpenDir,
        target: string,
        above: ReadonlySet<string>,
    ): Promise<{ dirs: OpenDir[]; moving: boolean; ids: Set<string>; shape: SubtreeShape }> {
        const found = new Map<string, OpenDir>([[top.id, top]]);
        const pending = [top];
        // Every entry id in it, and what each record named as it was read.
        const ids = new Set<string>();
        const shape: SubtreeShape = new Map();
        let spared = 0;
        let moving = false;
        for (let dir = pending.pop(); dir; dir = pending.pop()) {
            shape.set(dir.id, namedIn(dir));
            for (const [, entry] of followable(dir)) {
                ids.add(entry.id);
                if (entry.moving === true) moving = true;
                if (entry.kind !== "dir" || found.has(entry.id)) continue;
                if (entry.id === ROOT_ID || above.has(entry.id)) {
                    spared++;
                    continue;
                }
                const child = await this.openDirById(entry.id, fromBase64(entry.key)).catch((err) => {
                    // The caller asked for this whole subtree to go. One part
                    // of it being unreadable is no reason to refuse the rest:
                    // skip that part and leave it to sweep(). Any OTHER failure
                    // stops the delete here, before anything has been released.
                    if (!(err instanceof VfsCorruptRecordError)) throw err;
                    this.warn("skipping an unreadable directory while deleting its parent");
                    return null;
                });
                if (!child) continue;
                found.set(child.id, child);
                pending.push(child);
            }
        }
        if (spared) {
            // Counted, not named: the entry may be one whose name is not fit to print.
            const what = spared === 1 ? "a directory that is" : `${spared} directories that are`;
            this.warn(`leaving ${what} above ${target} in the tree alone while deleting it`);
        }
        return { dirs: [...found.values()], moving, ids, shape };
    }

    /**
     * The records a recursive delete read, as they are now - or null when
     * one has changed since in a way that purging it would get wrong.
     *
     * The delete decided what to let go of, and whether to look for the
     * other half of a move, from what it read; then it waited, on reads and
     * on the write of its parent. A record that is no longer named by the
     * record it was read in has been moved out, and is not this delete's to
     * purge; an entry marked since it was read is being moved, and is about
     * to be named somewhere the delete never looked. Purging either purged
     * the folder a move had just put somewhere else. Anything else - a file
     * saved into one of them, or moved out - is purged as it now stands,
     * which is why the copies to purge are what this returns.
     *
     * Synchronous, for an edit. A record whose copy is not to hand counts as
     * changed.
     *
     * `held`, with a coordinator, is every entry whose move lock the delete
     * holds. An entry named since the records were read - saved or moved in
     * - is not among them, so nothing stops another tab moving it out while
     * the delete writes the parent, and purging it then let go of what that
     * move had put somewhere else. So with `held`, that counts as changed
     * too, and the delete is tried again from the start.
     */
    private currentSubtree(dirs: OpenDir[], shape: SubtreeShape, held?: ReadonlySet<string>): OpenDir[] | null {
        const doomed = new Set(dirs.map((dir) => dir.id));
        const current: OpenDir[] = [];
        for (const dir of dirs) {
            const now = this.editable(dir);
            if (!now) return null;
            const read = shape.get(dir.id) ?? new Map<string, boolean>();
            const named = namedIn(now);
            for (const [id, marked] of named) if (marked && read.get(id) !== true) return null;
            for (const id of read.keys()) if (doomed.has(id) && !named.has(id)) return null;
            if (held) for (const id of named.keys()) if (!held.has(id)) return null;
            current.push(now);
        }
        return current;
    }

    /**
     * Hold the move lock of every entry in `ids` - see
     * `VfsCoordinator.holdMoving` - or of none: null when another holder has
     * any of them, and then nothing is held. Otherwise the function that
     * lets go of them all. Asked for all at once: none of them waits.
     * `shared` holds them as the folders a move goes into.
     */
    private async holdAll(coordinator: VfsCoordinator, ids: Iterable<string>, shared = false): Promise<(() => void) | null> {
        const tries = await Promise.allSettled([...new Set(ids)].map((id) => coordinator.holdMoving(id, shared)));
        const held = tries.flatMap((tried) => (tried.status === "fulfilled" && tried.value ? [tried.value] : []));
        const release = () => {
            for (const letGo of held) letGo();
        };
        const failed = tries.find((tried): tried is PromiseRejectedResult => tried.status === "rejected");
        if (failed) {
            release();
            throw failed.reason;
        }
        if (held.length < tries.length) {
            release();
            return null;
        }
        return release;
    }

    /**
     * Delete these records and let go of every file in them. The second half
     * of a recursive delete, run only once the subtree is detached. Cannot
     * throw: every step is best-effort, because unreachable is not fatal.
     *
     * With `elsewhere` - what the rest of the tree still names, read because
     * something here is half of an interrupted move - a record still named
     * elsewhere is kept, and so is a file.
     */
    private async purge(dirs: OpenDir[], elsewhere: NamedElsewhere | undefined, keepContent = false): Promise<void> {
        const gone = dirs.filter((dir) => !elsewhere?.dirs.has(dir.id));
        // By file id: two entries with one id are one file, holding one
        // reference to its content, however many directories name it.
        const files: Leaving = new Map();
        for (const dir of gone) {
            for (const [, entry] of followable(dir)) {
                if (entry.kind !== "file") continue;
                let copies = files.get(entry.id);
                if (!copies) files.set(entry.id, (copies = []));
                copies.push({ dir, entry });
            }
        }
        await this.letGo(files, elsewhere, keepContent);
        for (const dir of gone) {
            this.cache.delete(dir.id);
            await this.deps.store.delete(dirKey(dir.id)).catch(() => {});
        }
        if (!elsewhere) return;
        for (const dir of gone) {
            for (const [, entry] of followable(dir)) if (entry.moving === true) await this.settle(entry.id, elsewhere);
        }
    }

    /**
     * Unmark what is left of an interrupted move once a delete has removed
     * the other copy. Marked, a file keeps every version that falls off its
     * history, because the other copy might hold it - for good, once there
     * is no other copy - and every delete of the entry, or of a directory
     * above it, reads the whole tree. Only when exactly one marked copy is
     * left: more, and they are still shared. Best-effort, like everything
     * after a detach; failing, it stays marked, which costs only that.
     */
    private async settle(id: string, elsewhere: NamedElsewhere): Promise<void> {
        const holding = elsewhere.marked.get(id);
        if (holding?.length !== 1) return;
        try {
            // Opened again: this delete may have written to it since the tree was read.
            const dir = await this.openDirById(holding[0].id, holding[0].key);
            const name = Object.keys(dir.node.entries).find((n) => dir.node.entries[n].id === id && dir.node.entries[n].moving === true);
            if (name === undefined) return;
            await this.mutate(dir, (node) => {
                const now = entryIn(node, name);
                if (now?.id !== id || now.moving !== true) return false;
                node.entries[name] = unmarked(now);
                return true;
            });
        } catch {
            // It stays marked.
        }
    }

    /**
     * Let go of files that are leaving the tree: each one's content, every
     * version its history holds, and the history record. Best-effort, like
     * everything after a detach.
     *
     * A file id still named elsewhere is one file with two names, left by an
     * interrupted move: its content and history belong to the name that is
     * staying, and all that changes hands is the key its history opens with.
     * `keepContent` keeps every file's content and drops only its history
     * record, as a checkout needs.
     */
    private async letGo(files: Leaving, elsewhere: NamedElsewhere | undefined, keepContent = false): Promise<void> {
        for (const [id, copies] of files) {
            const keys = copies.map(({ dir }) => dir.key);
            const staying = elsewhere?.files.get(id);
            if (staying) await this.rekeyHistory(id, keys, staying.key).catch(() => {});
            else if (keepContent) await this.deps.store.delete(historyKey(id)).catch(() => {});
            else await this.releaseFile(id, copies);
        }
    }

    /**
     * What the tree still names with one entry left out: every directory
     * record, and every file id with a directory that holds it. Null when
     * part of the tree cannot be read or followed, so the answer is unknown.
     */
    private async namedElsewhere(dir: string, name: string): Promise<NamedElsewhere | null> {
        try {
            const named = await this.references({ dir, name });
            return named.unknown ? null : named;
        } catch (err) {
            if (err instanceof VfsCorruptRecordError) return null;
            throw err;
        }
    }

    /**
     * Everything reachable from the root: every directory record's id and
     * key, and every file id with a directory that names it - following the
     * entries hidden only for their name, which still reference what they
     * point at. `skip` leaves one entry out: one about to be detached.
     *
     * Fetches up to WALK_CONCURRENCY records at once, each record once
     * however often it is named. Throws VfsCorruptRecordError for a record a
     * path reaches that cannot be read, unless `lenient`. `unknown` counts
     * what could not be followed at all: an entry this version cannot read,
     * and a record behind an unusable name that does not open - which no path
     * can reach, and so no recursive delete can remove - or, `lenient`, any
     * record that does not open.
     */
    private async references(
        skip?: { dir: string; name: string },
        opts: { lenient?: boolean } = {},
    ): Promise<NamedElsewhere & { keys: Uint8Array[]; unknown: number }> {
        const root = await this.root();
        const dirs = new Set<string>([root.id]);
        const keys: Uint8Array[] = [];
        const files = new Map<string, OpenDir>();
        const marked = new Map<string, OpenDir[]>();
        let unknown = 0;
        let sinceTurn = 0;
        const pending: Array<{ entry: DirEntry; path: string | undefined; named: boolean }> = [];
        const scan = (dir: OpenDir, path: string | undefined) => {
            keys.push(dir.key);
            unknown += unfollowable(dir);
            for (const [name, entry] of followable(dir)) {
                if (skip && dir.id === skip.dir && name === skip.name) continue;
                sinceTurn++;
                if (entry.moving === true) {
                    let holding = marked.get(entry.id);
                    if (!holding) marked.set(entry.id, (holding = []));
                    holding.push(dir);
                }
                if (entry.kind === "file") {
                    if (!files.has(entry.id)) files.set(entry.id, dir);
                } else if (!dirs.has(entry.id)) {
                    dirs.add(entry.id);
                    // No path is ever built from an unusable name.
                    const at = name === null || path === undefined ? undefined : join(path, name);
                    pending.push({ entry, path: at, named: name !== null });
                }
            }
        };
        scan(root, "/");

        const inFlight = new Set<Promise<void>>();
        let failure: { err: unknown } | null = null;
        let next = 0;
        while (!failure && (next < pending.length || inFlight.size)) {
            while (next < pending.length && inFlight.size < WALK_CONCURRENCY) {
                const { entry, path, named } = pending[next++];
                const task: Promise<void> = this.openDirById(entry.id, fromBase64(entry.key), path)
                    .then(
                        (child) => scan(child, path),
                        (err) => {
                            // Behind a name no path can reach, an unreadable
                            // record is one more thing whose references are
                            // unknown, and not followed.
                            if ((opts.lenient || !named) && err instanceof VfsCorruptRecordError) unknown++;
                            else failure ??= { err };
                        },
                    )
                    .finally(() => inFlight.delete(task));
                inFlight.add(task);
            }
            await Promise.race(inFlight);
            // Once records are cached nothing here waits: let the rest of the
            // program run, as a walk does.
            if (sinceTurn >= YIELD_EVERY) {
                sinceTurn = 0;
                await nextTurn();
            }
        }
        if (failure) throw (failure as { err: unknown }).err;
        return { dirs, keys, files, marked, unknown };
    }

    /**
     * Deep-copy an entry. Files reuse their manifest (no bytes move); each
     * directory gets a fresh id and key, so the copy is independent of the
     * original — writing into one must never appear in the other.
     *
     * `at` is the entry's SOURCE path, and `depth` how many directories deep
     * from the root the copy of it will be. With `run.write` false this is the
     * dry run: every check, no reference taken and no record stored.
     */
    private async cloneEntry(
        entry: Entry,
        at: string,
        run: CopyRun,
        ancestors: Ancestry | null,
        depth: number,
    ): Promise<Entry> {
        if (entry.kind === "file") {
            // Same bytes, second owner: take a reference so deleting either one
            // leaves the other readable.
            if (run.write) await this.deps.content.retain(entry.manifest);
            return { kind: "file", id: newId(), manifest: entry.manifest, size: entry.size, mtime: Date.now(), versions: 0 };
        }
        // The most expensive walker to leave unguarded: it mints a NEW id, key
        // and stored record at every level, so a cyclic tree does not merely
        // hang - it writes records to the store, and to the user's bill, in an
        // unbounded loop.
        //
        // Separate guards, because they catch different shapes. A directory
        // that is one of its own ANCESTORS is a cycle. Depth is counted per
        // branch, at the destination, from the root, as for any write - the
        // old guard compared the total number of directories seen against the
        // depth limit, and so refused any ordinary tree with more than 64. The budgets, shared by the whole copy, bound a tree
        // that fans out into the same subtree without ever looping; they are
        // the walk's ceilings, so a tree too big to walk is not copied into a
        // second one. And a directory reached in more than MAX_SHARED places
        // is refused outright, because below the budgets that fan-out still
        // turns a few records into a vast number of writes. A subtree
        // reachable twice is copied twice, as it should be.
        if (hasAncestor(ancestors, entry.id)) {
            throw new VfsConflictError("refusing to copy a directory that contains a cycle");
        }
        if (depth > MAX_DEPTH) {
            // About the destination, like any write refused for depth: the
            // source is fine where it is, so it is neither named nor offered
            // up for deleting.
            throw new VfsLimitError("depth", MAX_DEPTH, run.to, run.to + at.slice(run.from.length), "writing");
        }
        const reached = (run.reached.get(entry.id) ?? 0) + 1;
        if (reached > MAX_SHARED) throw new VfsLimitError("shared", MAX_SHARED, run.from, at, "copying");
        run.reached.set(entry.id, reached);
        const source = await this.openDirById(entry.id, fromBase64(entry.key), at);
        // Only visible entries: an unusable name or an unreadable entry is not
        // carried into a fresh record. `readRecord` has set both aside already.
        const children = Object.entries(source.node.entries);
        run.entries -= children.length;
        if (run.entries < 0) throw new VfsLimitError("entries", this.maxEntries, run.from, at, "copying");
        for (const [name] of children) run.pathChars -= childPathLength(at, name);
        if (run.pathChars < 0) throw new VfsLimitError("pathChars", this.maxPathChars, run.from, at, "copying");
        // The dry run, with every record cached, waits on nothing - like a
        // walk, it lets the rest of the program run every so often.
        run.sinceTurn += children.length;
        if (run.sinceTurn >= YIELD_EVERY) {
            run.sinceTurn = 0;
            await nextTurn();
        }

        const inner: Ancestry = { id: entry.id, up: ancestors };
        const clone: DirEntry = { kind: "dir", id: newId(), key: toBase64(newDirKey()), mtime: Date.now() };
        const node: DirNode = { v: 1, entries: emptyEntries(), mtime: Date.now() };
        for (const [name, child] of children) {
            node.entries[name] = await this.cloneEntry(child, join(at, name), run, inner, depth + 1);
        }
        if (!run.write) return clone;
        const counter = this.deps.coordinator ? await this.counterOf(clone.id) : null;
        const open: OpenDir = {
            id: clone.id, key: fromBase64(clone.key), node, hidden: Object.create(null), gen: run.gen, seen: this.hearing, counter,
        };
        await this.deps.store.put(dirKey(open.id), await seal(open.key, node));
        this.adopt(open);
        return clone;
    }

    /**
     * Let go of one file's bytes: its content, every version its history
     * retains, and the history record itself.
     *
     * Each distinct manifest once. `copies` is every entry naming the file -
     * two after an interrupted move, which may by now hold different
     * versions - and `restore` puts a version back without taking a second
     * reference, so its manifest is in the entry and in the history both.
     * Releasing per mention released one reference twice, and so freed bytes
     * a copy elsewhere, holding its own reference, still needed.
     */
    private async releaseFile(id: string, copies: Array<{ dir: OpenDir; entry: FileEntry }>): Promise<void> {
        const record = await this.openHistory(id, copies.map(({ dir }) => dir.key)).catch(() => null);
        const manifests = new Map<string, FileManifest>();
        const versions = readableHistory(record?.value).record.versions;
        for (const manifest of [...copies.map(({ entry }) => entry.manifest), ...versions.map((version) => version.manifest)]) {
            if (!manifests.has(manifest.id)) manifests.set(manifest.id, manifest);
        }
        for (const manifest of manifests.values()) await this.deps.content.release(manifest).catch(() => {});
        await this.deps.store.delete(historyKey(id)).catch(() => {});
    }

    /**
     * A file's history record, opened with the first of `keys` that opens
     * it, and that key. Null when there is none, or none of them does.
     */
    private async openHistory(id: string, keys: Uint8Array[]): Promise<{ value: unknown; key: Uint8Array } | null> {
        const raw = await this.deps.store.get(historyKey(id));
        if (raw === null || raw === undefined) return null;
        const opened = await openWithAny(raw, keys);
        return "problem" in opened ? null : opened;
    }

    /**
     * Seal a file's history with the key of the directory that holds it now.
     *
     * A history record is sealed with its directory's key, so a file moved
     * to another directory carried a history its new directory could not
     * open: every read of it, and every write to the file, failed from then
     * on. Nothing to do when there is no history, when it opens with `to`
     * already, or when none of the keys opens it.
     */
    private async rekeyHistory(id: string, from: Uint8Array[], to: Uint8Array): Promise<void> {
        const opened = await this.openHistory(id, [to, ...from]);
        if (!opened || opened.key === to) return;
        await this.deps.store.put(historyKey(id), await seal(to, readableHistory(opened.value).record));
    }

    /**
     * The history of the file `entry` names as `name` in `parent`, and the
     * key to seal it with from now on.
     *
     * A history is sealed with its directory's key - usually. The two halves
     * of an interrupted move share one history, sealed with ONE of their
     * directories' keys, and a file moved between directories by a version
     * before `rename` re-sealed it still has its old directory's. So when the
     * directory's own key does not open it, every key in the tree is tried,
     * the other half's first: a read of the whole tree, and only then. It
     * need not be read in full, or understood - an entry this version cannot
     * follow may hide a key, but a key that opens the record is proof
     * enough. Found, it is re-sealed with this directory's key, so the search
     * is made once - except for half of a move, which keeps the key that
     * opened it and so keeps working for both halves.
     *
     * No record, or a value that is not a sealed record at all, is an empty
     * history, as it always was. One that no key opens is thrown on, with a
     * message rather than a bare decryption error: writing an empty history
     * over it would lose every version it holds.
     */
    private async readHistory(
        parent: OpenDir,
        name: string,
        entry: FileEntry,
        path: string,
    ): Promise<{ record: HistoryRecord; key: Uint8Array }> {
        const raw = await this.deps.store.get(historyKey(entry.id));
        if (!isObject(raw) || typeof raw.iv !== "string" || typeof raw.ct !== "string") {
            return { record: { v: 1, versions: [] }, key: parent.key };
        }
        let opened = await openWithAny(raw, [parent.key]);
        let found = false;
        if ("problem" in opened) {
            const named = await this.references({ dir: parent.id, name }, { lenient: true });
            const other = named.files.get(entry.id)?.key;
            const keys = named.keys.filter((key) => key !== parent.key && key !== other);
            const retry = await openWithAny(raw, other ? [other, ...keys] : keys);
            if ("problem" in retry) {
                throw new VfsConflictError(
                    `the version history of ${path} cannot be read: ${opened.problem}. ` +
                        "Nothing has been changed; a copy of the file starts a history of its own",
                );
            }
            opened = retry;
            found = true;
        }
        const { record, dropped } = readableHistory(opened.value);
        if (dropped) this.warn(`ignoring ${dropped} version${dropped === 1 ? "" : "s"} of ${path} this version cannot read`);
        if (!found || entry.moving === true) return { record, key: opened.key };
        // Best-effort: failing, the next read searches again.
        await this.deps.store.put(historyKey(entry.id), await seal(parent.key, record)).catch(() => {});
        return { record, key: parent.key };
    }

    /**
     * Push `entry` onto its history record. Returns the new version count.
     * `next` is the manifest the entry will hold once the caller has written
     * it.
     */
    private async pushHistory(
        parent: OpenDir,
        name: string,
        entry: FileEntry,
        path: string,
        next: FileManifest,
    ): Promise<number> {
        const { record, key } = await this.readHistory(parent, name, entry, path);
        record.versions.unshift({ manifest: entry.manifest, size: entry.size, mtime: entry.mtime });
        // Bounded, because this is a single stored value. Unchanged chunks are
        // deduped by the content-addressed shard store, so the cost of keeping
        // versions is this record's own growth — which is what the cap bounds.
        const evicted = record.versions.slice(this.historyLimit);
        record.versions = record.versions.slice(0, this.historyLimit);
        // A version that falls off the end is unreachable — release its shards
        // or the cap bounds the record's size while the storage grows forever.
        //
        // Unless something still names it. `restore` puts a version back
        // without a reference of its own, so a file holds ONE reference per
        // distinct manifest however often its entry and history name it - see
        // `releaseFile`. Releasing per mention freed the version a restore
        // was bringing back, when it was the one pushed off the end, and a
        // version the history still listed, when an older mention of it went.
        // Half of an interrupted move lets go of nothing here: the other half
        // shares this history, its entry may hold any of these, and finding it
        // means reading the whole tree. A leak is the safe way to be wrong.
        if (entry.moving !== true) {
            const named = new Set([next.id, ...record.versions.map((version) => version.manifest.id)]);
            for (const { manifest } of evicted) {
                if (named.has(manifest.id)) continue;
                named.add(manifest.id);   // and each once
                await this.deps.content.release(manifest).catch(() => {});
            }
        }
        await this.deps.store.put(historyKey(entry.id), await seal(key, record));
        return record.versions.length;
    }
}

function toStat(path: string, name: string, entry: Entry): VfsStat {
    return {
        path,
        name,
        kind: entry.kind,
        size: entry.kind === "file" ? asCount(entry.size) : 0,
        mtime: asTime(entry.mtime),
        versions: entry.kind === "file" ? asCount(entry.versions) : 0,
    };
}

/** Directories first, then alphabetical — what every file explorer does. */
function byDirsThenName(a: { kind: Entry["kind"]; name: string }, b: { kind: Entry["kind"]; name: string }): number {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
}
