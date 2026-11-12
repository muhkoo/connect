/**
 * `client.vectors` — vector search over the app's collections. A developer
 * defines a collection (text or vectors mode, filterable fields, access) in the
 * Muhkoo portal or CLI; this namespace reads and writes its entries:
 *
 *   const docs = client.vectors.collection('docs');
 *   const { mutationId } = await docs.upsert([
 *     { id: 'doc-1', text: 'How to reset your password…', data: { category: 'faq' } },
 *   ]);
 *   const state   = await docs.status(mutationId);   // 'pending' | 'done' | 'unknown'
 *   const matches = await docs.query({ text: 'forgot password', topK: 5, filter: { category: 'faq' } });
 *   const [entry] = await docs.get(['doc-1']);
 *   await docs.delete(['doc-1']);
 *
 * Writes are asynchronous: upsert and delete return a `mutationId` at once, and
 * entries usually become searchable within one to two minutes. `get` returns
 * only entries whose writes have finished, never ones still pending.
 *
 * Entries are server-readable: Muhkoo stores the text, vectors and data you send
 * so it can embed and search them. Don't put anything in a collection that the
 * platform must not see.
 *
 * Authorization is the app key ({@link HttpClient} stamps it on every request);
 * the app and environment come from the key. Server errors (`{ error, code }`)
 * reach callers as {@link HttpError}; the SDK does no validation of its own.
 */

import type { HttpClient } from "../HttpClient";
import type { Space } from "../../spaces/Space";

const READY_SENDER = "__muhkoo__";
const READY_SUBJECT = "muhkoo.vectors.ready";
const DEFAULT_WAIT_TIMEOUT_MS = 300_000;
const POLL_FIRST_MS = 250;
const POLL_MAX_MS = 4_000;
const POLL_CONNECTED_MS = 5_000;

/** A ready notice: the entries of one upsert call are now searchable. */
export interface VectorReadyEvent {
    collection: string;
    ids: string[];
    mutationId: string;
}

/**
 * A wait for a write ran out of time. The write itself was accepted; check
 * {@link VectorCollection.status} later with `mutationId`.
 */
export class VectorWaitTimeoutError extends Error {
    readonly mutationId: string;

    constructor(mutationId: string, timeoutMs: number) {
        super(`Timed out after ${timeoutMs} ms waiting for mutation ${mutationId}`);
        this.name = "VectorWaitTimeoutError";
        this.mutationId = mutationId;
    }
}

type WaitOptions = { space?: Space; timeoutMs?: number };
/** Subscribes a "this mutation is ready" callback; returns the unsubscribe. */
type ReadySubscribe = (onHit: () => void) => () => void;

function isReadyEvent(data: unknown): data is VectorReadyEvent {
    if (!data || typeof data !== "object") return false;
    const d = data as Record<string, unknown>;
    return (
        typeof d.collection === "string" &&
        typeof d.mutationId === "string" &&
        Array.isArray(d.ids) &&
        d.ids.every((id) => typeof id === "string")
    );
}

export type VectorAudience = "everyone" | "writer";
export type VectorNotify = false | { space?: string; audience?: VectorAudience };

export interface VectorEntryInput {
    id: string;
    text?: string;
    vector?: number[];
    data?: Record<string, unknown>;
    storeText?: boolean;
}

export interface VectorUpsertOptions {
    notify?: VectorNotify;
}

export interface VectorWriteResult {
    mutationId: string;
    count: number;
}

export interface VectorQueryInput {
    text?: string;
    vector?: number[];
    topK?: number;
    filter?: Record<string, unknown>;
    includeData?: boolean;
    includeText?: boolean;
}

export interface VectorMatch {
    id: string;
    score: number;
    data?: Record<string, unknown>;
    text?: string;
}

export interface VectorEntry {
    id: string;
    data: Record<string, unknown>;
    text?: string;
    vector?: number[];
}

export type VectorWriteState = "pending" | "done" | "unknown";

export interface VectorsNamespaceDeps {
    http: HttpClient;
}

/** A handle on one collection. Cheap to make; holds no state beyond its name. */
export class VectorCollection {
    private readonly base: string;

    constructor(private readonly http: HttpClient, readonly name: string) {
        this.base = `/api/vectors/${encodeURIComponent(name)}`;
    }

    /** Add or replace entries. Returns once accepted; see {@link status}. */
    upsert(entries: VectorEntryInput[], opts?: VectorUpsertOptions): Promise<VectorWriteResult> {
        const body: { entries: VectorEntryInput[]; notify?: VectorNotify } = { entries };
        if (opts?.notify !== undefined) body.notify = opts.notify;
        return this.http.post<VectorWriteResult>(`${this.base}/upsert`, body);
    }

    /** Nearest entries to a text or a vector. */
    async query(input: VectorQueryInput): Promise<VectorMatch[]> {
        const res = await this.http.post<{ matches: VectorMatch[] }>(`${this.base}/query`, input);
        return res.matches;
    }

    /** Entries by id. Writes still pending are not returned. */
    async get(ids: string[], opts?: { includeVector?: boolean }): Promise<VectorEntry[]> {
        const body: { ids: string[]; includeVector?: boolean } = { ids };
        if (opts?.includeVector !== undefined) body.includeVector = opts.includeVector;
        const res = await this.http.post<{ entries: VectorEntry[] }>(`${this.base}/get`, body);
        return res.entries;
    }

    /** Remove entries by id. Asynchronous, like {@link upsert}. */
    delete(ids: string[]): Promise<VectorWriteResult> {
        return this.http.post<VectorWriteResult>(`${this.base}/delete`, { ids });
    }

    /** The state of a write: `pending`, `done`, or `unknown` (never seen or expired). */
    async status(mutationId: string): Promise<VectorWriteState> {
        const res = await this.http.get<{ mutationId: string; state: VectorWriteState }>(
            `${this.base}/status?mutation=${encodeURIComponent(mutationId)}`,
        );
        return res.state;
    }

    /**
     * Listen on an open Space for this collection's ready notices. Only notices
     * the platform sent (sender `__muhkoo__`) reach `handler`; a member who
     * publishes the same subject is ignored. Needs an unlocked session, since a
     * Space without its keys emits no ephemeral events. Returns the unsubscribe.
     */
    onReady(space: Space, handler: (e: VectorReadyEvent) => void): () => void {
        return space.onEphemeral((e) => {
            if (e.from !== READY_SENDER || e.subject !== READY_SUBJECT) return;
            if (!isReadyEvent(e.data) || e.data.collection !== this.name) return;
            handler({ collection: e.data.collection, ids: e.data.ids, mutationId: e.data.mutationId });
        });
    }

    /**
     * Resolve once a write is searchable: on its ready notice (with `space`) or
     * when {@link status} answers `done`. Status is polled underneath either way,
     * because notices are best effort.
     *
     * The notice only arrives if `space` is a registered notice Space for the
     * environment (see {@link VectorsNamespace.setNotices}) and the write named
     * it in `notify.space` or it is the environment's `defaultSpace`. Any other
     * Space never receives the notice, and the wait falls back to polling,
     * usually finishing within a minute or two.
     *
     * Rejects with an `Error` ("Unknown mutation <id>") if status answers
     * `unknown`, and with {@link VectorWaitTimeoutError} after `timeoutMs`
     * (default 300,000 ms).
     */
    waitFor(mutationId: string, opts?: WaitOptions): Promise<void> {
        const space = opts?.space;
        const subscribe: ReadySubscribe | undefined = space
            ? (onHit) => this.onReady(space, (e) => { if (e.mutationId === mutationId) onHit(); })
            : undefined;
        return this.wait(mutationId, opts, subscribe);
    }

    /**
     * {@link upsert}, then {@link waitFor} its mutation. With `space`, listens
     * before sending, so a notice that beats the HTTP response still counts.
     * The notice reaches `space` only if it is a registered notice Space named
     * in `notify.space` or set as the environment's `defaultSpace`; naming an
     * unregistered Space fails the upsert with a 400
     * `notice_space_not_registered`. Otherwise the wait completes by polling.
     * An upsert error is rethrown at once.
     */
    async upsertAndWait(
        entries: VectorEntryInput[],
        opts?: VectorUpsertOptions & WaitOptions,
    ): Promise<VectorWriteResult> {
        const space = opts?.space;
        if (!space) {
            const result = await this.upsert(entries, opts);
            await this.wait(result.mutationId, opts, undefined);
            return result;
        }
        const seen = new Set<string>();
        let target: string | null = null;
        let hit: (() => void) | null = null;
        const unsubscribe = this.onReady(space, (e) => {
            if (target === null) seen.add(e.mutationId);
            else if (e.mutationId === target) hit?.();
        });
        try {
            const result = await this.upsert(entries, opts);
            target = result.mutationId;
            const already = seen.has(result.mutationId);
            seen.clear();
            const subscribe: ReadySubscribe = (onHit) => {
                hit = onHit;
                return () => { hit = null; };
            };
            if (!already) await this.wait(result.mutationId, opts, subscribe);
            return result;
        } finally {
            unsubscribe();
        }
    }

    private wait(mutationId: string, opts: WaitOptions | undefined, subscribe: ReadySubscribe | undefined): Promise<void> {
        const timeoutMs = opts?.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
        const space = opts?.space;
        return new Promise<void>((resolve, reject) => {
            let finished = false;
            let pollTimer: ReturnType<typeof setTimeout> | undefined;
            let backoff = POLL_FIRST_MS;
            const subscription: { off?: () => void } = {};

            const finish = (err?: Error) => {
                if (finished) return;
                finished = true;
                clearTimeout(deadline);
                if (pollTimer !== undefined) clearTimeout(pollTimer);
                subscription.off?.();
                if (err) reject(err); else resolve();
            };

            const schedule = () => {
                if (finished) return;
                let delay: number;
                if (space?.isConnected()) {
                    delay = POLL_CONNECTED_MS;
                } else {
                    delay = backoff;
                    backoff = Math.min(backoff * 2, POLL_MAX_MS);
                }
                pollTimer = setTimeout(poll, delay);
            };

            const poll = async () => {
                pollTimer = undefined;
                let state: VectorWriteState | null = null;
                try {
                    state = await this.status(mutationId);
                } catch {
                    state = null; // retried at the same cadence
                }
                if (finished) return;
                if (state === "done") finish();
                else if (state === "unknown") finish(new Error(`Unknown mutation ${mutationId}`));
                else schedule();
            };

            const deadline = setTimeout(() => finish(new VectorWaitTimeoutError(mutationId, timeoutMs)), timeoutMs);
            subscription.off = subscribe?.(() => finish());
            if (finished) { subscription.off?.(); return; }
            schedule();
        });
    }
}

export interface VectorFieldDefinition {
    name: string;
    type: "string" | "number" | "boolean";
}

export type VectorCollectionDefinition =
    | {
          mode: "text";
          model?: string;
          metric?: "cosine" | "euclidean" | "dot-product";
          fields?: VectorFieldDefinition[];
          access?: "app" | "backend";
      }
    | {
          mode: "vectors";
          dimensions: number;
          metric?: "cosine" | "euclidean" | "dot-product";
          fields?: VectorFieldDefinition[];
          access?: "app" | "backend";
      };

export interface VectorNotices {
    spaces: string[];
    defaultSpace: string | null;
}

export interface VectorEnvInfo {
    status: "creating" | "ready" | "failed" | "dropping";
    entries: number | null;
    notices: VectorNotices;
    error: string | null;
}

export interface VectorCollectionInfo {
    name: string;
    mode: "text" | "vectors";
    model: string | null;
    dimensions: number;
    metric: string;
    fields: VectorFieldDefinition[];
    access: "app" | "backend";
    createdAt: number;
    status: "creating" | "ready" | "failed" | "dropping";
    envs: { live: VectorEnvInfo; test: VectorEnvInfo };
}

/** A collection's creation failed; `info.envs.*.error` says why. */
export class VectorCollectionFailedError extends Error {
    readonly info: VectorCollectionInfo;

    constructor(info: VectorCollectionInfo) {
        const reason = info.envs?.live?.error ?? info.envs?.test?.error;
        super(`Collection ${info.name} failed${reason ? `: ${reason}` : ""}`);
        this.name = "VectorCollectionFailedError";
        this.info = info;
    }
}

const COLLECTION_POLL_MS = 2_000;
const DEFAULT_COLLECTION_TIMEOUT_MS = 600_000;

export class VectorsNamespace {
    constructor(private readonly deps: VectorsNamespaceDeps) {}

    /** A handle on the named collection, made fresh on each call. */
    collection(name: string): VectorCollection {
        return new VectorCollection(this.deps.http, name);
    }

    // Owner management. Authorized by the developer session (owner only, like
    // the database tables API), not the app key.

    /** The app's collections, sorted by name. */
    async listCollections(appId: string): Promise<VectorCollectionInfo[]> {
        const res = await this.deps.http.get<{ collections: VectorCollectionInfo[] }>(this.ownerPath(appId));
        return res.collections;
    }

    /** One collection. A missing or badly named one is 404 `collection_not_found`. */
    getCollection(appId: string, name: string): Promise<VectorCollectionInfo> {
        return this.deps.http.get<VectorCollectionInfo>(this.ownerPath(appId, name));
    }

    /**
     * Create a collection. Asynchronous: it answers with status `creating`; use
     * {@link waitForCollection} to wait for `ready`. Repeating it with the same
     * definition returns the existing collection; a different definition is
     * 409 `collection_exists`. Definitions never change: drop and recreate.
     */
    createCollection(appId: string, name: string, definition: VectorCollectionDefinition): Promise<VectorCollectionInfo> {
        return this.deps.http.put<VectorCollectionInfo>(this.ownerPath(appId, name), definition);
    }

    /**
     * Drop a collection and its entries in both environments. Asynchronous; the
     * collection shows status `dropping` until it is gone. Safe to repeat: a 503
     * `vectors_unavailable` means the drop couldn't start, and calling again is
     * the remedy.
     */
    async dropCollection(appId: string, name: string): Promise<void> {
        await this.deps.http.del(this.ownerPath(appId, name));
    }

    /** Set which Spaces receive ready notices for one environment. */
    setNotices(
        appId: string,
        name: string,
        env: "live" | "test",
        notices: VectorNotices,
    ): Promise<VectorNotices & { env: "live" | "test" }> {
        return this.deps.http.patch<VectorNotices & { env: "live" | "test" }>(
            `${this.ownerPath(appId, name)}/notices?env=${encodeURIComponent(env)}`,
            notices,
        );
    }

    /**
     * Poll {@link getCollection} every 2 s until status is `ready`. Rejects with
     * {@link VectorCollectionFailedError} on `failed`, and with
     * `Error("Timed out waiting for collection <name>")` after `timeoutMs`
     * (default 600,000 ms: creation waits for filter fields to settle).
     */
    waitForCollection(appId: string, name: string, opts?: { timeoutMs?: number }): Promise<VectorCollectionInfo> {
        const timeoutMs = opts?.timeoutMs ?? DEFAULT_COLLECTION_TIMEOUT_MS;
        return new Promise<VectorCollectionInfo>((resolve, reject) => {
            let finished = false;
            let pollTimer: ReturnType<typeof setTimeout> | undefined;
            const done = (fn: () => void) => {
                if (finished) return;
                finished = true;
                clearTimeout(deadline);
                if (pollTimer !== undefined) clearTimeout(pollTimer);
                fn();
            };
            const poll = async () => {
                pollTimer = undefined;
                let info: VectorCollectionInfo;
                try {
                    info = await this.getCollection(appId, name);
                } catch (err) {
                    done(() => reject(err));
                    return;
                }
                if (finished) return;
                if (info.status === "ready") done(() => resolve(info));
                else if (info.status === "failed") done(() => reject(new VectorCollectionFailedError(info)));
                else pollTimer = setTimeout(poll, COLLECTION_POLL_MS);
            };
            const deadline = setTimeout(
                () => done(() => reject(new Error(`Timed out waiting for collection ${name}`))),
                timeoutMs,
            );
            void poll();
        });
    }

    private ownerPath(appId: string, name?: string): string {
        const base = `/api/apps/${encodeURIComponent(appId)}/vectors/collections`;
        return name === undefined ? base : `${base}/${encodeURIComponent(name)}`;
    }
}
