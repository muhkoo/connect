/**
 * `Share` — one shared folder: a folder view over the share Space's file records and the file operations on it.
 *
 * The folder tree is built from each file record's `path` (`"a/c/d.jpg"`). An empty folder is a zero-byte record
 * of type {@link SHARE_DIR_TYPE}; a folder that holds files needs no record of its own.
 *
 * Files use the Space file store (`/api/spaces/:id/files`) and the Space's own shard route
 * (`PUT /api/spaces/:id/shards/:hash`), which is where a share's limit is enforced and its owner billed. The
 * server stamps each file's uploader on its first write and lists it as `owner`; renaming re-posts the same file
 * id, so the uploader never changes.
 *
 * Every call carries the app key and the signed-in user's session (with the client's stale-session recovery).
 */

import type { HttpClient } from "../core/HttpClient";
import { HttpError } from "../core/HttpError";
import { paymentRequiredFrom } from "../core/PaymentRequiredError";
import { FileStorage } from "../storage/FileStorage";
import { ShardClient } from "../storage/transport/ShardClient";
import type { FileManifest, FileStat } from "../storage/types";
import { generateId } from "../utilities";
import { ShareFullError, shareErrorFrom } from "./errors";
import type { ShareInfo } from "./types";

/** The MIME type of an empty-folder record. */
export const SHARE_DIR_TYPE = "inode/directory";

export interface ShareEntry {
    /** Full path inside the share, no leading slash (`"a/c/d.jpg"`). */
    path: string;
    name: string;
    kind: "file" | "dir";
    /** Bytes; for a folder, the total of the files under it. */
    size: number;
    /** Last modified (ms epoch); for a folder, the newest record under it. */
    mtime: number;
    /** Who uploaded it (a username). `""` for a legacy file with no recorded uploader, or a folder with no record of its own. */
    uploader: string;
    /** The uploader's display name from `ShareInfo.names`, else the username; `"Unknown"` for a legacy file. */
    uploaderName: string;
    /**
     * Whether the server would let the caller change or delete it (it mirrors the server's `canChangeFile`). For a
     * folder: whether every record under it is changeable, since deleting a folder deletes them all.
     */
    canChange: boolean;
}

export interface ShareOptions {
    /** The app's HTTP client (app key and the signed-in session). */
    http: HttpClient;
    spaceId: string;
    /** The signed-in caller's username. */
    me: string;
    /** A pre-compiled Reed-Solomon module, for runtimes without the bundled loader (Node tests, Workers). */
    rsWasmModule?: WebAssembly.Module;
}

/** A file for {@link Share.adopt}: content already stored, named by its manifest. */
export interface ShareAdoptFile {
    kind: "file";
    /** Path inside the share. */
    path: string;
    manifest: FileManifest;
    /** Unique among the items and stable across runs (the VFS file id): names the record when the manifest's id is taken. */
    key: string;
}

/** An item for {@link Share.adopt}: a file, or an empty folder. */
export type ShareAdoptItem = ShareAdoptFile | { kind: "folder"; path: string };

/** A listed file: the server adds `owner` on a share Space (null = a legacy file with no recorded uploader). */
type ShareFileStat = FileStat & { owner?: string | null };

export class Share {
    readonly spaceId: string;
    private readonly http: HttpClient;
    private readonly me: string;
    private readonly files: FileStorage;

    constructor(opts: ShareOptions) {
        this.spaceId = opts.spaceId;
        this.me = opts.me;
        this.http = opts.http;
        const shardFetch = this.shardFetch;
        const shards = new ShardClient({
            baseUrl: this.http.baseUrl,
            pathPrefix: `/api/spaces/${encodeURIComponent(this.spaceId)}/shards`,
            fetch: shardFetch,
            fetchWithRecovery: shardFetch,
            // The Space shard route takes one hash per request; there is no batch route on it.
            batchShards: false,
        });
        this.files = new FileStorage({ shards, rsWasmModule: opts.rsWasmModule });
    }

    /** The share record (`GET /api/shares/:id`). */
    info(): Promise<ShareInfo> {
        return this.json<ShareInfo>("GET", `/api/shares/${encodeURIComponent(this.spaceId)}`);
    }

    /** The entries directly inside `dir` (the root by default): folders first, then by name. */
    async list(dir = ""): Promise<ShareEntry[]> {
        const base = normalizePath(dir, true);
        const [records, info] = await Promise.all([this.records(), this.info()]);
        const prefix = base ? `${base}/` : "";
        const files = new Map<string, ShareFileStat>();
        const dirs = new Map<string, { own?: ShareFileStat; under: ShareFileStat[] }>();
        for (const r of records) {
            const p = storedPath(r);
            if (!p || p === base || !p.startsWith(prefix)) continue;
            const rest = p.slice(prefix.length);
            const slash = rest.indexOf("/");
            const childPath = prefix + (slash < 0 ? rest : rest.slice(0, slash));
            if (slash < 0 && r.type !== SHARE_DIR_TYPE) {
                const prev = files.get(childPath);
                if (!prev || r.createdAt > prev.createdAt) files.set(childPath, r);
                continue;
            }
            const d = dirs.get(childPath) ?? { under: [] };
            if (slash < 0) d.own = r;
            else d.under.push(r);
            dirs.set(childPath, d);
        }

        const out: ShareEntry[] = [];
        for (const [path, d] of dirs) {
            const all = d.own ? [d.own, ...d.under] : d.under;
            out.push({
                path,
                name: lastSegment(path),
                kind: "dir",
                size: d.under.reduce((n, r) => n + (r.type === SHARE_DIR_TYPE ? 0 : r.size), 0),
                mtime: all.reduce((m, r) => Math.max(m, r.lastModified ?? 0), 0),
                uploader: d.own ? (d.own.owner ?? "") : "",
                uploaderName: d.own ? uploaderName(d.own.owner ?? null, info) : "",
                canChange: all.every((r) => this.canChange(r.owner ?? null, info)),
            });
        }
        for (const [path, r] of files) {
            if (dirs.has(path)) continue;
            out.push(this.fileEntry(path, r, r.owner ?? null, info));
        }
        return out.sort((a, b) => (a.kind === b.kind ? compareNames(a.name, b.name) : a.kind === "dir" ? -1 : 1));
    }

    async read(path: string): Promise<Uint8Array> {
        const p = normalizePath(path);
        const rec = findFile(await this.records(), p);
        if (!rec) throw new Error(`Share.read: no such file: ${p}`);
        const { manifest } = await this.json<{ manifest: FileManifest }>("GET", `${this.filesBase()}/${encodeURIComponent(rec.id)}`);
        return (await this.files.readFileFromShards(manifest)).data;
    }

    /**
     * Upload `data` to `path`, replacing the file already there (same file id, so its uploader is kept; the server
     * refuses if the caller may not change it). `onProgress` gets the fraction done, 0 to 1.
     */
    async write(
        path: string,
        data: Blob | Uint8Array,
        opts: { type?: string; onProgress?: (n: number) => void } = {},
    ): Promise<ShareEntry> {
        const records = await this.records();
        const [entry] = await this.writeInto(records, [{ path, data, type: opts.type, onProgress: opts.onProgress }]);
        return entry;
    }

    /**
     * Upload several files in order. At the first `share_full` it stops and throws a {@link ShareFullError} whose
     * `refused` is the number of items not written (that one and every one after it).
     */
    async writeMany(items: Array<{ path: string; data: Blob | Uint8Array; type?: string }>): Promise<ShareEntry[]> {
        return this.writeInto(await this.records(), items);
    }

    /** Make an empty folder: a zero-byte record of type {@link SHARE_DIR_TYPE}. A folder already there is left alone. */
    async mkdir(path: string): Promise<void> {
        const p = normalizePath(path);
        const records = await this.records();
        refuseFileAncestor("mkdir", records, p);
        for (const r of records) {
            const rp = storedPath(r);
            if (rp === p && r.type !== SHARE_DIR_TYPE) throw new Error(`Share.mkdir: a file exists at ${p}`);
            if (rp === p || rp.startsWith(`${p}/`)) return;
        }
        const { manifest } = await this.files.writeFileToShards({
            data: new Uint8Array(0),
            metadata: { name: lastSegment(p), type: SHARE_DIR_TYPE, path: p, lastModified: Date.now() },
        });
        await this.postManifest(manifest);
    }

    /**
     * Delete a file, or a folder and every record under it. Nothing there is not an error. Every record is checked
     * first: if the caller may not change one of them, nothing is deleted.
     */
    async delete(path: string): Promise<void> {
        const p = normalizePath(path);
        const [records, info] = await Promise.all([this.records(), this.info()]);
        const doomed = under(records, p);
        this.refuseUnchangeable("delete", doomed, info);
        for (const r of doomed) {
            await this.json("DELETE", `${this.filesBase()}/${encodeURIComponent(r.id)}`);
        }
    }

    /**
     * Move a file or folder by rewriting each record's `path` in place (same file id), so uploaders are unchanged —
     * except a legacy file with no recorded uploader, which the server stamps to whoever rewrites it, i.e. the
     * renamer.
     *
     * Every record is checked first: if the caller may not change one of them, nothing moves. A folder moves one
     * record at a time; if that stops part-way (a network failure), the error names what already moved, and
     * calling the same `rename` again finishes the move.
     */
    async rename(from: string, to: string): Promise<void> {
        const f = normalizePath(from);
        const t = normalizePath(to);
        if (f === t) return;
        if (t.startsWith(`${f}/`)) throw new Error(`Share.rename: cannot move ${f} into itself`);
        const [records, info] = await Promise.all([this.records(), this.info()]);
        refuseFileAncestor("rename", records, t);
        const key = `${this.spaceId}\n${f}\n${t}`;
        const earlier = pendingRenames.get(key);
        const moving = under(records, f);
        const atTarget = under(records, t);
        // Records already under `to` are fine only when they are exactly ones an earlier attempt of this same
        // rename moved (same file ids): then this call continues it.
        const resuming = atTarget.length > 0 && !!earlier && atTarget.every((r) => earlier.has(r.id));
        if (atTarget.length > 0 && !resuming) throw new Error(`Share.rename: ${t} already exists`);
        if (moving.length === 0) {
            if (resuming) {
                pendingRenames.delete(key);
                return;
            }
            throw new Error(`Share.rename: no such file or folder: ${f}`);
        }
        this.refuseUnchangeable("rename", moving, info);

        const planned = earlier ?? new Set<string>();
        for (const r of moving) planned.add(r.id);
        pendingRenames.set(key, planned);
        const moved: string[] = atTarget.map(storedPath);
        for (const r of moving) {
            const next = t + storedPath(r).slice(f.length);
            try {
                const { manifest } = await this.json<{ manifest: FileManifest }>("GET", `${this.filesBase()}/${encodeURIComponent(r.id)}`);
                await this.postManifest({ ...manifest, path: next, name: lastSegment(next) });
            } catch (err) {
                if (moved.length === 0) throw err;
                throw new Error(
                    `Share.rename: stopped part-way; already moved: ${moved.join(", ")}. ` +
                        `Call rename("${f}", "${t}") again to finish.`,
                    { cause: err },
                );
            }
            moved.push(next);
        }
        pendingRenames.delete(key);
    }

    /**
     * Put files whose content is already stored into the share without uploading a byte: each file's existing
     * manifest is posted to the share's file store at `path` (shards are content-addressed and every Space reads
     * the same shard store; the server charges the share for the bytes it finds stored). For
     * `client.shares.shareFolder`, which owns the share; not a general upload path.
     *
     * Safe to run again over the same items: a file already in the share at its path with the id it was given
     * (the manifest's id, or `<manifest id>.<key>` when another file in the share has that one) is not posted
     * again, and a file that moved inside the folder since moves in the share. `onEach(item, posted, recordId)`
     * runs after each file is in the share, `posted` false when it was there already, `recordId` the id of the
     * record that holds it; an error from it stops the run. `beforePost(item, recordId)` runs just before each
     * record (a file's, or an empty folder's) is posted, so a caller can note what it is about to put in the share
     * before it is there; an error from it stops the run before that post. Empty folders become folder records
     * unless something is at or below their path already.
     *
     * At the first `share_full` it stops with a {@link ShareFullError} whose `refused` is the number of files
     * not put in the share.
     */
    async adopt(
        items: ShareAdoptItem[],
        onEach?: (item: ShareAdoptFile, posted: boolean, recordId: string) => Promise<void>,
        beforePost?: (item: ShareAdoptItem, recordId: string) => Promise<void>,
    ): Promise<void> {
        const records = await this.records();
        const taken = new Set(records.map((r) => r.id));
        const files = items.filter((it): it is ShareAdoptFile => it.kind === "file");
        const wanted = new Set(files.map((it) => normalizePath(it.path)));
        let done = 0;
        for (const it of items) {
            const p = normalizePath(it.path);
            if (it.kind === "folder") {
                if (under(records, p).length > 0) continue;
                const now = Date.now();
                const manifest: FileManifest = {
                    id: freshId(taken), name: lastSegment(p), size: 0, type: SHARE_DIR_TYPE, path: p,
                    lastModified: now, createdAt: now, chunks: [], version: 1,
                };
                await beforePost?.(it, manifest.id);
                await this.postManifest(manifest);
                taken.add(manifest.id);
                records.push({ ...manifestStat(manifest), owner: this.me });
                continue;
            }
            const ids = [it.manifest.id, `${it.manifest.id}.${it.key}`];
            const atPath = findFile(records, p);
            if (atPath && ids.includes(atPath.id)) {
                await onEach?.(it, false, atPath.id);
                done++;
                continue;
            }
            // Which record this file takes: the one at its path (replaced in place), else one of its own left at a
            // path no file of this run claims (an earlier run's, before the file was renamed), else a new one.
            const stale = records.find((r) => ids.includes(r.id) && r.type !== SHARE_DIR_TYPE && !wanted.has(storedPath(r)));
            const id = atPath?.id ?? stale?.id ?? (!taken.has(ids[0]) ? ids[0] : !taken.has(ids[1]) ? ids[1] : freshId(taken));
            const manifest: FileManifest = { ...it.manifest, id, path: p, name: lastSegment(p) };
            await beforePost?.(it, id);
            try {
                await this.postManifest(manifest);
            } catch (err) {
                if (err instanceof ShareFullError) {
                    throw new ShareFullError(err.message, err.limitBytes, err.usedBytes, files.length - done, err.body);
                }
                throw err;
            }
            taken.add(id);
            const stat: ShareFileStat = { ...manifestStat(manifest), owner: atPath?.owner ?? stale?.owner ?? this.me };
            const replaced = atPath ?? stale;
            if (replaced) records.splice(records.indexOf(replaced), 1, stat);
            else records.push(stat);
            await onEach?.(it, true, id);
            done++;
        }
    }

    /**
     * Delete the records with these ids that the caller uploaded and `keep` does not keep. For
     * `client.shares.shareFolder`, taking back what an earlier run of it put in the share that is no longer in the
     * folder; not a general delete. A record someone else uploaded (the server's stamped uploader is not the
     * caller) is never touched, nor is an id not in the share. Returns the ids deleted.
     */
    async removeAdopted(
        ids: Iterable<string>,
        keep: (record: { id: string; path: string; kind: "file" | "dir" }) => boolean = () => false,
    ): Promise<string[]> {
        const wanted = new Set(ids);
        if (wanted.size === 0) return [];
        const removed: string[] = [];
        for (const r of await this.records()) {
            if (!wanted.has(r.id) || r.owner !== this.me) continue;
            if (keep({ id: r.id, path: storedPath(r), kind: r.type === SHARE_DIR_TYPE ? "dir" : "file" })) continue;
            await this.json("DELETE", `${this.filesBase()}/${encodeURIComponent(r.id)}`);
            removed.push(r.id);
        }
        return removed;
    }

    /** Bytes stored and the limit (null = no limit). */
    async usage(): Promise<{ usedBytes: number; limitBytes: number | null }> {
        const { usedBytes, limitBytes } = await this.info();
        return { usedBytes, limitBytes };
    }

    // -------------------------------------------------------------------------

    private async writeInto(
        records: ShareFileStat[],
        items: Array<{ path: string; data: Blob | Uint8Array; type?: string; onProgress?: (n: number) => void }>,
    ): Promise<ShareEntry[]> {
        const paths = items.map((it) => normalizePath(it.path));
        const info = await this.info();
        const out: ShareEntry[] = [];
        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            const p = paths[i];
            refuseFileAncestor("write", records, p);
            const existing = findFile(records, p);
            if (!existing && under(records, p).length > 0) throw new Error(`Share.write: a folder exists at ${p}`);
            // Before uploading a byte: the server would refuse the manifest anyway.
            if (existing) this.refuseUnchangeable("write", [existing], info);
            try {
                const { manifest } = await this.files.writeFileToShards({
                    data: it.data,
                    metadata: {
                        name: lastSegment(p),
                        type: it.type || (it.data instanceof Uint8Array ? "" : it.data.type) || "application/octet-stream",
                        path: p,
                        lastModified: Date.now(),
                    },
                    fileId: existing?.id,
                    onProgress: it.onProgress ? (done, total) => it.onProgress!(total > 0 ? done / total : 1) : undefined,
                });
                await this.postManifest(manifest);
                // A legacy file (no recorded uploader) is claimed by its first writer, as the server stamps it.
                const owner = existing?.owner ?? this.me;
                const stat: ShareFileStat = { ...manifestStat(manifest), owner };
                if (existing) records.splice(records.indexOf(existing), 1, stat);
                else records.push(stat);
                out.push(this.fileEntry(p, stat, owner, info));
            } catch (err) {
                if (err instanceof ShareFullError) {
                    throw new ShareFullError(err.message, err.limitBytes, err.usedBytes, items.length - i, err.body);
                }
                throw err;
            }
        }
        return out;
    }

    private fileEntry(path: string, r: ShareFileStat, owner: string | null, info: ShareInfo): ShareEntry {
        return {
            path,
            name: lastSegment(path),
            kind: "file",
            size: r.size,
            mtime: r.lastModified,
            uploader: owner ?? "",
            uploaderName: uploaderName(owner, info),
            canChange: this.canChange(owner, info),
        };
    }

    /** A 403 naming the first of `records` the caller may not change, before anything is sent. */
    private refuseUnchangeable(op: string, records: ShareFileStat[], info: ShareInfo): void {
        const blocked = records.find((r) => !this.canChange(r.owner ?? null, info));
        if (blocked) {
            throw new HttpError(`Share.${op}: you can't change ${storedPath(blocked)} (uploaded by ${blocked.owner})`, 403);
        }
    }

    /** The server's `canChangeFile`, from the caller's side. */
    private canChange(owner: string | null, info: ShareInfo): boolean {
        if (owner === null || owner === this.me) return true;
        if (this.me === info.ownerUsername) return true;
        return info.kind === "private" && info.editPolicy === "any" && info.members.includes(this.me);
    }

    private async records(): Promise<ShareFileStat[]> {
        const res = await this.json<{ files?: ShareFileStat[] }>("GET", this.filesBase());
        return Array.isArray(res.files) ? res.files : [];
    }

    private async postManifest(manifest: FileManifest): Promise<void> {
        await this.json("POST", this.filesBase(), { manifest });
    }

    private filesBase(): string {
        return `/api/spaces/${encodeURIComponent(this.spaceId)}/files`;
    }

    /** The app's fetch with the session's stale-session recovery. Bodies here are strings or bytes, so a replay is safe. */
    private readonly send: typeof fetch = (input, init) => this.http.fetchWithRecovery(input, init);

    /** {@link send} for shard requests: a share refusal (full, closed) is thrown typed; anything else is left to `ShardClient`. */
    private readonly shardFetch: typeof fetch = async (input, init) => {
        const res = await this.send(input, init);
        if (res.ok || (res.status !== 402 && res.status !== 409)) return res;
        const body = await res.clone().json().catch(() => null);
        const typed = shareErrorFrom(res.status, body);
        if (typed) throw typed;
        return res;
    };

    private async json<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
        const init: RequestInit = { method };
        if (body !== undefined) {
            init.headers = { "Content-Type": "application/json" };
            init.body = JSON.stringify(body);
        }
        const res = await this.send(`${this.http.baseUrl}${path}`, init);
        let parsed: unknown = null;
        try {
            parsed = await res.json();
        } catch {
            // Non-JSON body: fall through with null.
        }
        if (res.ok) return parsed as T;
        const typed = shareErrorFrom(res.status, parsed);
        if (typed) throw typed;
        const msg =
            parsed && typeof parsed === "object" && "error" in parsed
                ? String((parsed as { error: unknown }).error)
                : `${res.status} ${res.statusText}`;
        throw paymentRequiredFrom(res.status, parsed) ?? new HttpError(msg, res.status, parsed);
    }
}

/**
 * A share path without leading or trailing slashes. Refuses empty, `.` and `..` segments. `allowRoot` lets `""`
 * (or `"/"`) through as the root.
 */
function normalizePath(path: string, allowRoot = false): string {
    const p = String(path).replace(/^\/+/, "").replace(/\/+$/, "");
    if (p === "") {
        if (allowRoot) return "";
        throw new Error("Invalid share path: empty");
    }
    for (const seg of p.split("/")) {
        if (seg === "" || seg === "." || seg === "..") throw new Error(`Invalid share path: ${path}`);
    }
    return p;
}

/** The name a file's uploader is shown by: their display name in the share, else their username. */
function uploaderName(owner: string | null, info: ShareInfo): string {
    if (owner === null) return "Unknown";
    const name = info.names?.[owner];
    return typeof name === "string" && name ? name : owner;
}

/** A record's path as stored, tolerating a leading slash or a record with only a name. */
function storedPath(r: { path?: string; name: string }): string {
    return (r.path ?? r.name ?? "").replace(/^\/+/, "").replace(/\/+$/, "");
}

function lastSegment(path: string): string {
    const i = path.lastIndexOf("/");
    return i < 0 ? path : path.slice(i + 1);
}

/** The newest non-folder record at exactly `path`. */
function findFile(records: ShareFileStat[], path: string): ShareFileStat | undefined {
    let best: ShareFileStat | undefined;
    for (const r of records) {
        if (r.type === SHARE_DIR_TYPE || storedPath(r) !== path) continue;
        if (!best || r.createdAt > best.createdAt) best = r;
    }
    return best;
}

/** Throw when a parent of `path` is a file: the new record would hide under it and vanish from `list`. */
function refuseFileAncestor(op: string, records: ShareFileStat[], path: string): void {
    const segs = path.split("/");
    for (let i = 1; i < segs.length; i++) {
        const parent = segs.slice(0, i).join("/");
        if (findFile(records, parent)) throw new Error(`Share.${op}: ${parent} is a file, not a folder`);
    }
}

/**
 * Folder renames in progress, by `spaceId\nfrom\nto` → the file ids being moved. Lets a retry of the same rename
 * continue after a failure part-way (see {@link Share.rename}). Module-level so a fresh `Share` for the same
 * share can resume too; it lasts as long as the page or process.
 */
const pendingRenames = new Map<string, Set<string>>();

/** Every record at `path` or below it. */
function under(records: ShareFileStat[], path: string): ShareFileStat[] {
    return records.filter((r) => {
        const rp = storedPath(r);
        return rp === path || rp.startsWith(`${path}/`);
    });
}

/** A random record id no record in `taken` has. */
function freshId(taken: ReadonlySet<string>): string {
    for (;;) {
        const id = generateId();
        if (!taken.has(id)) return id;
    }
}

function compareNames(a: string, b: string): number {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }) || (a < b ? -1 : a > b ? 1 : 0);
}

function manifestStat(m: FileManifest): FileStat {
    let shardCount = 0;
    for (const c of m.chunks) shardCount += c.shardHashes.length;
    return {
        id: m.id,
        name: m.name,
        size: m.size,
        type: m.type,
        path: m.path,
        lastModified: m.lastModified,
        createdAt: m.createdAt,
        chunkCount: m.chunks.length,
        shardCount,
    };
}
