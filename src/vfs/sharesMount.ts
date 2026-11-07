/**
 * The shares mount: how the VFS serves `/Home/Shared` and paths through a link.
 *
 * A share is its own Space with its own file records, not a subtree of anyone's personal tree. So nothing here
 * reads or writes a directory record: every path below `/Home/Shared/<name>`, or below a link, becomes a call on
 * that share's `Share` (list, read, write, mkdir, delete, rename), and a share's tree comes back as `VfsStat`s.
 * `VfsNamespace` decides which paths come here (see `VfsNamespace.route`); this file never touches the personal
 * store, so nothing a share does can reach the user's own files.
 *
 * `/Home/Shared` itself is built from the server's membership records (`shares.list()`), never stored.
 */

import type { Share, ShareEntry } from "../shares/Share";
import type { ShareSummary } from "../shares/types";
import { HttpError } from "../core/HttpError";
import { ShareClosedError } from "../shares/errors";
import { VfsConflictError, VfsLimitError, VfsNotFoundError, type VfsStat } from "./types";
import { assertValidName, basename, contentTypeFor, isSafeName, isUnder, MAX_NAME_BYTES, printable, segments } from "./paths";
import { MAX_DEPTH } from "./bounds";

/** The system folder at the top of every tree, and the folder in it that lists shares. */
export const HOME = "Home";
export const SHARED = "Shared";
export const HOME_PATH = `/${HOME}`;
export const SHARED_PATH = `/${HOME}/${SHARED}`;

/** The name a user's own `/Home/Shared` is shown under, since `/Home/Shared` lists shares. */
export const SHARED_YOURS = "Shared (yours)";

/** What a link's target may be: a share's Space id, which goes into a URL. The rule is `shares/spaceId`'s. */
export { SHARE_SPACE_ID as SPACE_ID } from "../shares/spaceId";

/** The part of a `Share` the VFS uses. `info` is read to make sure a share kept open has not been closed. */
export type MountedShare = Pick<Share, "spaceId" | "info" | "list" | "read" | "write" | "mkdir" | "delete" | "rename">;

/** Where the shares come from: `client.shares`. */
export interface SharesSource {
    list(): Promise<ShareSummary[]>;
    open(spaceId: string): Promise<MountedShare>;
    /** The signed-in username, so that the user's own shares get the plain names. Null when unknown. */
    me?: () => string | null;
}

/** A path inside one share. */
export interface ShareRoute {
    kind: "share";
    spaceId: string;
    /** The path the share's root was reached by: `/Home/Shared/<name>`, or a link's path. */
    at: string;
    /** The path inside the share, no leading slash; "" for its root. */
    rest: string;
    /** The whole path as the caller gave it, resolved. */
    path: string;
}

/** The refusal for a move or copy whose two ends are not in the same share, or not both in the user's own tree. */
export function acrossBoundary(): VfsConflictError {
    return new VfsConflictError("move across a share boundary");
}

/**
 * Each share with the name it is listed under in `/Home/Shared`: its own name, made fit to be a path segment.
 * When two shares have the same name, the later one gets ` (<owner>)`, then ` (2)`, ` (3)` and so on.
 *
 * "Later" is a fixed order, never the server's: the shares `me` owns first, then by owner username, then by
 * name, and the Space id only to break a tie. A path is remembered (by a mount, a script, a bookmark), and the
 * server lists by Space id, which changes when a share is rotated (a password change, a removed member) - so
 * listing order would let a remembered `/Home/Shared/Party/...` write into a different share after a rotation.
 * Owner and name do not change on rotation. Two shares with the SAME owner AND the same name are told apart
 * only by Space id, so those two can still swap names after one of them is rotated.
 */
export function shareNames(shares: ShareSummary[], me: string | null = null): Array<{ name: string; share: ShareSummary }> {
    const taken = new Set<string>();
    const seen = new Set<string>();
    const out: Array<{ name: string; share: ShareSummary }> = [];
    // Code-unit order, not localeCompare: the browser and the CLI must agree on it.
    const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    const ordered = [...shares].sort(
        (a, b) =>
            Number(a.owner !== me) - Number(b.owner !== me) ||
            cmp(a.owner, b.owner) ||
            cmp(a.name, b.name) ||
            cmp(a.spaceId, b.spaceId),
    );
    for (const share of ordered) {
        if (seen.has(share.spaceId)) continue;
        seen.add(share.spaceId);
        const base = segmentOf(share.name, "Shared folder");
        let name = base;
        if (taken.has(name)) name = withSuffix(base, ` (${segmentOf(share.owner, "someone")})`);
        for (let n = 2; taken.has(name); n++) name = withSuffix(base, ` (${n})`);
        taken.add(name);
        out.push({ name, share });
    }
    return out;
}

/** `value` as one path segment: no separators or control characters, never `.` or `..`, at most 255 bytes. */
function segmentOf(value: string, fallback: string): string {
    const cleaned = String(value ?? "")
        .replace(/[\\/]/g, "-")
        // eslint-disable-next-line no-control-regex -- stripping control characters is the point
        .replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, "")
        .trim();
    const name = withSuffix(cleaned, "");
    return isSafeName(name) ? name : fallback;
}

/** `base + suffix`, cutting `base` so the whole is at most MAX_NAME_BYTES. */
function withSuffix(base: string, suffix: string): string {
    const bytes = (s: string) => new TextEncoder().encode(s).length;
    let cut = base;
    while (cut && bytes(cut + suffix) > MAX_NAME_BYTES) cut = Array.from(cut).slice(0, -1).join("");
    return cut + suffix;
}

/** A read error from a share: a share the caller cannot reach reads as not there (the server's 403 / 404). */
function readError(err: unknown, path: string): unknown {
    if (err instanceof HttpError && (err.status === 403 || err.status === 404)) return new VfsNotFoundError(path);
    return err;
}

/**
 * A write error from a share. `Share` refuses a path clash (a file where a folder is wanted, or the reverse) with
 * a plain `Error`; that is the VFS's conflict. Everything else - a share that is full or closed, a file the
 * caller may not change - is passed on as it is.
 */
function writeError(err: unknown, path: string): unknown {
    if (err instanceof HttpError && err.status === 404) return new VfsNotFoundError(path);
    if (err instanceof Error && err.constructor === Error && err.message.startsWith("Share.")) {
        return new VfsConflictError(err.message.replace(/^Share\.\w+: /, ""));
    }
    return err;
}

const dirStat = (path: string, mtime = 0): VfsStat => ({ path, name: basename(path), kind: "dir", size: 0, mtime, versions: 0 });

/** One share's entry as a VFS stat, at its path under `at`. */
function toStat(at: string, entry: ShareEntry): VfsStat {
    return {
        path: `${at}/${entry.path}`,
        name: entry.name,
        kind: entry.kind,
        size: entry.size,
        mtime: entry.mtime,
        versions: 0,
    };
}

/** How long a listing of `/Home/Shared` is trusted for resolving names, before it is asked for again. */
const INDEX_TTL_MS = 30_000;

/**
 * How long an opened share is used before it is checked again for having been closed. A rotation (a new password,
 * a removed member) closes a share's Space and moves it to a new one. The server still answers reads on the closed
 * one, so a share kept open would go on reading a Space that no longer changes. A rotation run by this client
 * evicts it at once (see `forget`), and a write refused as closed reopens it; this bounds a rotation run elsewhere.
 */
const OPEN_TTL_MS = 30_000;

/** A share as opened, by the Space id a path reached it with (a link's target may be an older Space of it). */
interface Opened {
    share: Promise<MountedShare>;
    /** When it was last checked as open. */
    checkedAt: number;
    /** The Space it resolved to (its newest), once known. */
    spaceId: string | null;
}

/** Refuse a share whose Space is closed, as a write to it would be refused. */
async function assertOpen(share: MountedShare): Promise<MountedShare> {
    const info = await share.info();
    if (info.closed) throw new ShareClosedError("This share moved to a new Space.", info.closed.successor);
    return share;
}

export class SharesMount {
    private index: { at: number; names: Promise<Array<{ name: string; share: ShareSummary }>> } | null = null;
    private readonly opened = new Map<string, Opened>();

    constructor(
        private readonly source: SharesSource | undefined,
        private readonly warn: (message: string) => void,
        private readonly limits: { entries: number; pathChars: number },
    ) {}

    /** Forget every listing and opened share: for a change of identity. */
    clear(): void {
        this.index = null;
        this.opened.clear();
    }

    /**
     * Forget the share opened as `spaceId`, or opened as an older Space and resolved to it, and the names in
     * `/Home/Shared` (a rotated share is listed under its new Space id). The next use opens it again, which follows
     * the closed Space to its successor.
     */
    forget(spaceId: string): void {
        this.index = null;
        for (const [key, o] of [...this.opened]) {
            if (key === spaceId || o.spaceId === spaceId) this.opened.delete(key);
        }
    }

    /**
     * Run `op` on the share `r` is in; if the share turns out to be closed (rotated since it was opened), forget it
     * and run `op` once more, on the share opened again - its successor.
     */
    private async retryClosed<T>(r: ShareRoute, op: () => Promise<T>): Promise<T> {
        try {
            return await op();
        } catch (err) {
            if (!(err instanceof ShareClosedError)) throw err;
            this.forget(r.spaceId);
            return op();
        }
    }

    /** The shares under `/Home/Shared`, by name. `fresh` asks the server again. */
    named(fresh = false): Promise<Array<{ name: string; share: ShareSummary }>> {
        if (!this.source) return Promise.resolve([]);
        if (fresh || !this.index || Date.now() - this.index.at > INDEX_TTL_MS) {
            const me = this.source.me?.() ?? null;
            const names = this.source.list().then((shares) => shareNames(shares, me));
            const index = { at: Date.now(), names };
            this.index = index;
            names.catch(() => {
                if (this.index === index) this.index = null;
            });
        }
        return this.index.names;
    }

    /** The share listed as `name` in `/Home/Shared`, or null. A name not found is looked up again once. */
    async byName(name: string): Promise<ShareSummary | null> {
        const find = (all: Array<{ name: string; share: ShareSummary }>) => all.find((n) => n.name === name)?.share ?? null;
        return find(await this.named()) ?? find(await this.named(true));
    }

    /** The shares under `/Home/Shared`, asked for afresh, in listing order: by name, as any folder lists. */
    async sortedNames(): Promise<Array<{ name: string; share: ShareSummary }>> {
        return [...(await this.named(true))].sort((a, b) => a.name.localeCompare(b.name));
    }

    /** `/Home/Shared`'s listing. */
    async listShared(): Promise<VfsStat[]> {
        return (await this.sortedNames()).map(({ name }) => dirStat(`${SHARED_PATH}/${name}`));
    }

    private open(spaceId: string, at: string): Promise<MountedShare> {
        const source = this.source;
        if (!source) {
            return Promise.reject(new VfsConflictError(`${printable(at, 1024)} is a link to a shared folder, and shares are not available here`));
        }
        const now = Date.now();
        let entry = this.opened.get(spaceId);
        if (entry && now - entry.checkedAt > OPEN_TTL_MS) {
            // Kept open a while: make sure it has not been closed since (a reader would not be told).
            const prev = entry;
            entry = { share: prev.share.then(assertOpen), checkedAt: now, spaceId: prev.spaceId };
        } else if (!entry) {
            const opening = source.open(spaceId).then(assertOpen);
            const fresh: Opened = { share: opening, checkedAt: now, spaceId: null };
            opening.then((share) => void (fresh.spaceId = share.spaceId), () => {});
            entry = fresh;
        } else {
            return entry.share;
        }
        const settled = entry;
        this.opened.set(spaceId, settled);
        settled.share.catch(() => {
            if (this.opened.get(spaceId) === settled) this.opened.delete(spaceId);
        });
        return settled.share;
    }

    /** The share, with a share the caller cannot reach reading as not found. */
    private async reach(r: ShareRoute): Promise<MountedShare> {
        try {
            return await this.open(r.spaceId, r.at);
        } catch (err) {
            throw readError(err, r.path);
        }
    }

    /** The listing of folder `rest` in the share, names this VFS cannot use left out. */
    private async entries(share: MountedShare, rest: string, path: string): Promise<ShareEntry[]> {
        let listed: ShareEntry[];
        try {
            listed = await share.list(rest);
        } catch (err) {
            throw readError(err, path);
        }
        const usable = listed.filter((e) => isSafeName(e.name));
        if (usable.length < listed.length) {
            const n = listed.length - usable.length;
            this.warn(`ignoring ${n} entr${n === 1 ? "y" : "ies"} with an unusable name in ${printable(path, 1024)}`);
        }
        return usable;
    }

    /** What is at `r`, or null. The share's root is a folder. */
    private async find(r: ShareRoute): Promise<{ share: MountedShare; stat: VfsStat } | null> {
        const share = await this.reach(r);
        if (!r.rest) return { share, stat: dirStat(r.at) };
        const parent = r.rest.includes("/") ? r.rest.slice(0, r.rest.lastIndexOf("/")) : "";
        const name = basename(r.path);
        const found = (await this.entries(share, parent, r.path)).find((e) => e.name === name);
        return found ? { share, stat: { ...toStat(r.at, found), path: r.path } } : null;
    }

    async stat(r: ShareRoute): Promise<VfsStat> {
        const found = await this.retryClosed(r, () => this.find(r));
        if (!found) throw new VfsNotFoundError(r.path);
        return found.stat;
    }

    async exists(r: ShareRoute): Promise<boolean> {
        try {
            return (await this.retryClosed(r, () => this.find(r))) !== null;
        } catch (err) {
            if (err instanceof VfsNotFoundError) return false;
            throw err;
        }
    }

    /** A folder's entries; the root's when `rest` is "". */
    list(r: ShareRoute): Promise<VfsStat[]> {
        return this.retryClosed(r, () => this.listOnce(r));
    }

    private async listOnce(r: ShareRoute): Promise<VfsStat[]> {
        const share = await this.reach(r);
        if (r.rest) {
            const found = await this.find(r);
            if (!found) throw new VfsNotFoundError(r.path);
            if (found.stat.kind !== "dir") throw new VfsConflictError(`${r.path} is not a directory`);
        }
        return (await this.entries(share, r.rest, r.path)).map((e) => ({ ...toStat(r.at, e), path: `${r.path}/${e.name}` }));
    }

    read(r: ShareRoute): Promise<Uint8Array> {
        return this.retryClosed(r, () => this.readOnce(r));
    }

    private async readOnce(r: ShareRoute): Promise<Uint8Array> {
        const found = await this.find(r);
        if (!found) throw new VfsNotFoundError(r.path);
        if (found.stat.kind !== "file") throw new VfsConflictError(`${r.path} is a directory`);
        try {
            return await found.share.read(r.rest);
        } catch (err) {
            throw readError(err, r.path);
        }
    }

    write(
        r: ShareRoute,
        data: Uint8Array | string | Blob,
        opts: { type?: string; onProgress?: (done: number, total: number) => void },
    ): Promise<VfsStat> {
        return this.retryClosed(r, () => this.writeOnce(r, data, opts));
    }

    private async writeOnce(
        r: ShareRoute,
        data: Uint8Array | string | Blob,
        opts: { type?: string; onProgress?: (done: number, total: number) => void },
    ): Promise<VfsStat> {
        if (!r.rest) throw new VfsConflictError(`${r.path} is a directory`);
        for (const name of segments(r.rest)) assertValidName(name);
        const found = await this.find(r);
        if (found?.stat.kind === "dir") throw new VfsConflictError(`${r.path} is a directory`);
        const share = found?.share ?? (await this.reach(r));
        const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
        const total = bytes instanceof Uint8Array ? bytes.length : bytes.size;
        const onProgress = opts.onProgress;
        try {
            const entry = await share.write(r.rest, bytes, {
                type: opts.type ?? contentTypeFor(basename(r.path)),
                onProgress: onProgress ? (n) => onProgress(Math.round(n * total), total) : undefined,
            });
            return { ...toStat(r.at, entry), path: r.path };
        } catch (err) {
            throw writeError(err, r.path);
        }
    }

    mkdir(r: ShareRoute, recursive: boolean): Promise<void> {
        return this.retryClosed(r, () => this.mkdirOnce(r, recursive));
    }

    private async mkdirOnce(r: ShareRoute, recursive: boolean): Promise<void> {
        const found = await this.find(r);
        if (found) {
            if (found.stat.kind !== "dir") throw new VfsConflictError(`${r.path} is a file`);
            if (!recursive) throw new VfsConflictError(`${r.path} already exists`);
            return;
        }
        for (const name of segments(r.rest)) assertValidName(name);
        if (!recursive && r.rest.includes("/")) {
            const parent = { ...r, rest: r.rest.slice(0, r.rest.lastIndexOf("/")), path: r.path.slice(0, r.path.lastIndexOf("/")) };
            const above = await this.find(parent);
            if (!above || above.stat.kind !== "dir") throw new VfsNotFoundError(parent.path);
        }
        try {
            await (await this.reach(r)).mkdir(r.rest);
        } catch (err) {
            throw writeError(err, r.path);
        }
    }

    delete(r: ShareRoute, recursive: boolean): Promise<void> {
        return this.retryClosed(r, () => this.deleteOnce(r, recursive));
    }

    private async deleteOnce(r: ShareRoute, recursive: boolean): Promise<void> {
        if (!r.rest) {
            throw new VfsConflictError(`${r.path} is a shared folder; it is removed from its settings, not deleted from here`);
        }
        const found = await this.find(r);
        if (!found) throw new VfsNotFoundError(r.path);
        if (found.stat.kind === "dir" && !recursive && (await this.entries(found.share, r.rest, r.path)).length) {
            throw new VfsConflictError(`${r.path} is not empty`);
        }
        try {
            await found.share.delete(r.rest);
        } catch (err) {
            throw writeError(err, r.path);
        }
    }

    /** A move inside one share. The caller has checked that both ends are in the same one. */
    rename(from: ShareRoute, to: ShareRoute): Promise<void> {
        return this.retryClosed(from, () => this.renameOnce(from, to));
    }

    private async renameOnce(from: ShareRoute, to: ShareRoute): Promise<void> {
        if (!from.rest) throw new VfsConflictError(`${from.path} is a shared folder; it is renamed from its settings`);
        if (!to.rest) throw new VfsConflictError(`${to.path} already exists`);
        if (from.rest === to.rest) return;
        if (isUnder(`/${to.rest}`, `/${from.rest}`)) throw new VfsConflictError(`cannot move ${from.path} into itself`);
        for (const name of segments(to.rest)) assertValidName(name);
        const found = await this.find(from);
        if (!found) throw new VfsNotFoundError(from.path);
        if (await this.find(to)) throw new VfsConflictError(`${to.path} already exists`);
        try {
            await found.share.rename(from.rest, to.rest);
        } catch (err) {
            throw writeError(err, to.path);
        }
    }

    /** A copy inside one share: the bytes are read and written again (a share has no content handles to share). */
    async copy(from: ShareRoute, to: ShareRoute): Promise<VfsStat> {
        if (!to.rest) throw new VfsConflictError(`${to.path} already exists`);
        if (from.rest === to.rest) throw new VfsConflictError(`${to.path} already exists`);
        if (isUnder(`/${to.rest}`, `/${from.rest}`)) throw new VfsConflictError(`cannot copy ${from.path} into itself`);
        // The reads and writes below each reopen a share found closed; these first checks do too.
        const found = await this.retryClosed(from, () => this.find(from));
        if (!found) throw new VfsNotFoundError(from.path);
        if (await this.retryClosed(to, () => this.find(to))) throw new VfsConflictError(`${to.path} already exists`);
        if (found.stat.kind === "file") return this.write(to, await this.read(from), {});
        const under = (stat: VfsStat): ShareRoute => {
            const tail = stat.path.slice(from.path.length);
            return { ...to, rest: `${to.rest}${tail}`, path: `${to.path}${tail}` };
        };
        const all: VfsStat[] = [];
        await this.each(from, (stat) => void all.push(stat));
        await this.mkdir(to, true);
        for (const stat of all) {
            if (stat.kind === "dir") await this.mkdir(under(stat), true);
            else await this.write(under(stat), await this.read({ ...from, rest: from.rest + stat.path.slice(from.path.length), path: stat.path }), {});
        }
        return dirStat(to.path);
    }

    /**
     * Every entry under `r`, depth-first, each folder just before what is in it - as `VfsNamespace.eachEntry`
     * walks the user's own tree, with the same ceilings. One listing request per folder.
     */
    async each(r: ShareRoute, visit: (stat: VfsStat, manifest: null) => void): Promise<void> {
        // Reopened here if found closed; not part-way through, where `visit` has already seen entries.
        const found = await this.retryClosed(r, () => this.find(r));
        if (!found) throw new VfsNotFoundError(r.path);
        if (found.stat.kind !== "dir") throw new VfsConflictError(`${r.path} is not a directory`);
        let budget = this.limits.entries;
        let chars = this.limits.pathChars;
        const walk = async (rest: string, at: string): Promise<void> => {
            const entries = await this.entries(found.share, rest, at);
            budget -= entries.length;
            if (budget < 0) throw new VfsLimitError("entries", this.limits.entries, r.path, at);
            for (const e of entries) {
                const path = `${at}/${e.name}`;
                chars -= path.length;
                if (chars < 0) throw new VfsLimitError("pathChars", this.limits.pathChars, r.path, at);
                visit({ ...toStat(r.at, e), path }, null);
                if (e.kind !== "dir") continue;
                if (segments(path).length > MAX_DEPTH) throw new VfsLimitError("depth", MAX_DEPTH, r.path, path);
                await walk(e.path, path);
            }
        };
        await walk(r.rest, r.path);
    }
}
