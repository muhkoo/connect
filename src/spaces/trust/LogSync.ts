import { KeyringHttpError } from "../KeyringClient";
import { log as logger, toBase64Url, utf8Encode } from "../../utilities";
import { entryBytes, entryHash } from "./canonical";
import { SpaceTrustError } from "./errors";
import { fingerprint, ikEquals } from "./ik";
import { MembershipLog, type LogMember, type Role } from "./MembershipLog";
import type { EpochCommit, MembershipEntry, MlogHead, UnsignedEntry } from "./types";

/** What LogSync needs from core (kept structural so spaces/ never imports core/). */
export interface LogSyncDeps {
    spaceId: string;
    me: () => string;
    appId: () => Promise<string>;
    commitment: () => string | null;
    transport: {
        fetchLog(since?: number, limit?: number): Promise<{ entries: MembershipEntry[]; head: MlogHead | null }>;
        postLogEntry(entry: MembershipEntry, ec?: EpochCommit): Promise<{ head: MlogHead }>;
    };
    signer: { sign(b: Uint8Array): Promise<string>; identityKeyRaw(): Promise<string> };
    directory: { lookup(username: string): Promise<string> };
    pins: {
        get(doc: "identity" | "spaces", key: string): Promise<string | undefined>;
        pin(doc: "identity" | "spaces", entries: Record<string, string>): Promise<{ conflicts: string[] }>;
    };
    store: () => Promise<{ get<T>(k: string): Promise<T | undefined>; put(k: string, v: unknown): Promise<void> }>;
}

export interface MemberView { id: string; role: Role; ik: string; fingerprint: string; identityChanged: boolean }
export type IntegrityState = { broken: false } | { broken: true; reason: string };
interface HighWater { seq: number; hash: string; humanRemovalSeq: number }

const MAX_APPEND_RETRIES = 3;
const SYNC_DEBOUNCE_MS = 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Must equal SpaceKeyring's KEEPER_MEMBER_ID (and the accelerator's); duplicated so this module does not import SpaceKeyring. */
const KEEPER_MEMBER_ID = "__keeper__";

/**
 * Who a client may wrap a Space key to (design §4.5.1): the keeper always; while
 * the log's integrity is broken, nobody else; on a log-enabled Space, current
 * log members only, whatever the server's roster or pending list still holds
 * after a remove; on a Space without a log, anyone, as before.
 */
export function logCanWrapTo(ls: LogSync): (memberId: string) => boolean {
    return (id) => id === KEEPER_MEMBER_ID || (!ls.integrity.broken && (!ls.logEnabled || ls.isMember(id)));
}

/**
 * One Space's membership log, as this client has verified it (design §3.6–§3.7).
 * Syncs the whole log from −1 on each call (slice logs are tiny, so no entry
 * cache), checks the head against the high-water mark kept in `muhkoo.trust`,
 * checks the genesis against the pins (TOFU against the directory the first
 * time), and pins every IK a verified `add` names (design §3.4).
 */
export class LogSync {
    private log: MembershipLog | null = null;
    private enabled = false;
    private integrityState: IntegrityState = { broken: false };
    private changed = new Set<string>();
    private fps = new Map<string, string>();
    private listeners = new Set<() => void>();
    private timer: ReturnType<typeof setTimeout> | null = null;
    private running: Promise<void> | null = null;
    private followUp: Promise<void> | null = null;

    constructor(private readonly deps: LogSyncDeps) {}

    get logEnabled(): boolean { return this.enabled; }
    get integrity(): IntegrityState { return this.integrityState; }
    get signer(): LogSyncDeps["signer"] { return this.deps.signer; }
    get directory(): LogSyncDeps["directory"] { return this.deps.directory; }
    member(id: string): LogMember | undefined { return this.log?.member(id); }
    isMember(id: string): boolean { return !!this.log?.isMember(id); }

    members(): MemberView[] {
        return (this.log?.members ?? []).map((m) => ({
            id: m.id, role: m.role, ik: m.ik,
            fingerprint: this.fps.get(m.id) ?? "",
            identityChanged: this.changed.has(m.id.toLowerCase()),
        }));
    }

    onChange(h: () => void): () => void {
        this.listeners.add(h);
        return () => this.listeners.delete(h);
    }

    /**
     * An `mlog` frame marks the log stale; sync once a burst of frames settles.
     * A failure is logged with its code and reported through `onChange`, never
     * thrown; integrity is left as it was, and the next frame or open retries.
     */
    scheduleSync(): void {
        if (this.timer) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.sync().catch((e: unknown) => {
                const code = e instanceof KeyringHttpError ? e.status : (e as { code?: unknown } | null)?.code;
                logger.warn("LogSync: background sync failed", {
                    spaceId: this.deps.spaceId,
                    code: code ?? "unknown",
                    message: e instanceof Error ? e.message : String(e),
                });
                this.emit();
            });
        }, SYNC_DEBOUNCE_MS);
    }

    private hwKey(): string {
        return `loghw:${this.deps.commitment()}:${this.deps.spaceId}`;
    }

    /** Whether this client holds a high-water mark for this Space, i.e. has verified its log before (design §3.7 item 3). */
    async hasHighWater(): Promise<boolean> {
        return (await (await this.deps.store()).get<HighWater>(this.hwKey())) !== undefined;
    }

    /**
     * Fetch and verify the whole log. Single-flight: a call made while a sync
     * runs does not start a second one alongside it. It waits for exactly one
     * follow-up run, which starts once the running one ends, so it sees whatever
     * prompted the call; every call made in the meantime shares that follow-up.
     */
    sync(): Promise<void> {
        if (this.followUp) return this.followUp;
        if (!this.running) return this.startSync();
        const followUp = this.running.catch(() => undefined).then(() => {
            this.followUp = null;
            return this.startSync();
        });
        this.followUp = followUp;
        return followUp;
    }

    private startSync(): Promise<void> {
        const run: Promise<void> = this.runSync().finally(() => {
            if (this.running === run) this.running = null;
        });
        this.running = run;
        return run;
    }

    private async runSync(): Promise<void> {
        const store = await this.deps.store();
        const hw = await store.get<HighWater>(this.hwKey()); // read BEFORE the request (design §3.7 item 3)
        const all: MembershipEntry[] = [];
        let since = -1;
        let head: MlogHead | null = null;
        for (let page = 0; page < 10_000; page++) {
            const r = await this.deps.transport.fetchLog(since, 500);
            head = r.head;
            const fresh = r.entries.filter((e) => e.seq > since);
            all.push(...fresh);
            if (!r.head || fresh.length === 0 || all[all.length - 1].seq >= r.head.seq) break;
            since = all[all.length - 1].seq;
        }
        if (!head) {
            this.log = null;
            this.enabled = false;
            this.integrityState = hw ? { broken: true, reason: "log-missing" } : { broken: false };
            this.emit();
            return;
        }
        // Only a Space that has a log needs the app id, so an unlogged Space never waits on it.
        const appId = await this.deps.appId();
        const log = new MembershipLog({ spaceId: this.deps.spaceId, appId });
        const res = await log.apply(all);
        if (log.unsupported) {
            // A public genesis is unlogged only where this client never recorded a private
            // chain: a mark or a genesis pin means the log this client verified was replaced.
            let swapped: IntegrityState = { broken: false };
            if (hw) swapped = { broken: true, reason: "fork" };
            else {
                const pinned = await this.deps.pins.get("spaces", await this.spacePinKey());
                if (pinned !== undefined && pinned !== log.hashAt(0)) swapped = { broken: true, reason: "genesis-pin" };
            }
            this.log = null;
            this.enabled = false;
            this.integrityState = swapped;
            this.emit();
            return;
        }
        let integrity: IntegrityState = res.ok ? { broken: false } : { broken: true, reason: res.integrity };
        if (!integrity.broken && hw) {
            if (log.head!.seq < hw.seq) integrity = { broken: true, reason: "rollback" };
            else if (log.hashAt(hw.seq) !== hw.hash) integrity = { broken: true, reason: "fork" };
        }
        // The view this client already holds is a high-water mark too: a lower head is never adopted.
        const prior = this.log?.head ?? null;
        const lower = prior !== null && (log.head?.seq ?? -1) < prior.seq;
        if (!integrity.broken && lower) integrity = { broken: true, reason: "rollback" };
        if (!integrity.broken) integrity = await this.checkGenesis(log);
        if (!integrity.broken) await this.pinMembers(log);
        if (!integrity.broken) {
            // Re-read: another tab may have recorded a newer head while this sync ran. The mark never goes down.
            const cur = await store.get<HighWater>(this.hwKey());
            if (!cur || cur.seq <= log.head!.seq) {
                await store.put(this.hwKey(), {
                    seq: log.head!.seq,
                    hash: log.head!.hash,
                    humanRemovalSeq: Math.max(hw?.humanRemovalSeq ?? -1, cur?.humanRemovalSeq ?? -1, log.lastHumanRemovalSeq),
                } satisfies HighWater);
            }
        }
        if (!lower) this.log = log;
        this.enabled = true;
        this.integrityState = integrity;
        this.emit();
    }

    /** Genesis trust (design §3.7 item 2): the pinned genesis hash, else TOFU with the owner's IK checked against the directory. */
    private async checkGenesis(log: MembershipLog): Promise<IntegrityState> {
        const owner = log.owner;
        // A signed genesis can still name no usable owner (`by` null or ""): an honest server never stores one.
        if (typeof owner !== "string" || owner === "") return { broken: true, reason: "malformed" };
        const ownerIk = log.member(owner)!.ik;
        const genesisHash = log.hashAt(0)!;
        const sKey = await this.spacePinKey();
        const pinned = await this.deps.pins.get("spaces", sKey);
        if (pinned !== undefined && pinned !== genesisHash) return { broken: true, reason: "genesis-pin" };
        if (pinned === undefined) {
            if (!ikEquals(await this.deps.directory.lookup(owner), ownerIk)) return { broken: true, reason: "owner-identity" };
            // A conflict here means another tab pinned a different genesis after our read.
            const { conflicts } = await this.deps.pins.pin("spaces", { [sKey]: genesisHash });
            if (conflicts.length) return { broken: true, reason: "genesis-pin" };
        }
        const { conflicts } = await this.deps.pins.pin("identity", { [owner.toLowerCase()]: await fingerprint(ownerIk) });
        return conflicts.length ? { broken: true, reason: "owner-identity" } : { broken: false };
    }

    /** "s:" + b64url(SHA-256(utf8(spaceId))), the spaces-v1 key; computed exactly as PinStore.spacePinKey, which this layer may not import. */
    private async spacePinKey(): Promise<string> {
        return "s:" + toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8Encode(this.deps.spaceId))));
    }

    /** Pin every IK a verified add names (design §3.4 row 2); a different pinned IK flags the member (identity-changed). */
    private async pinMembers(log: MembershipLog): Promise<void> {
        const entries: Record<string, string> = {};
        for (const m of log.members) {
            const fp = await fingerprint(m.ik);
            this.fps.set(m.id, fp);
            if (m.id !== log.owner) entries[m.id.toLowerCase()] = fp;
        }
        if (!Object.keys(entries).length) return;
        const { conflicts } = await this.deps.pins.pin("identity", entries);
        this.changed = new Set(conflicts);
    }

    /**
     * Sign and append one entry. On `409 Log moved`: re-sync, re-sign against the
     * new head and retry, at most 3 times with jitter (design §9.2 I9). Nothing is
     * signed while integrity is broken, including after a re-sync that breaks it.
     * Any other refusal → SpaceTrustError("log-refused") carrying the server's code and reason.
     * Once the server has stored the entry, its `{seq}` is returned even if the sync confirming it fails.
     */
    async append(
        op: MembershipEntry["op"],
        body: Record<string, unknown>,
        ec?: (hash: string, entry: UnsignedEntry) => Promise<EpochCommit>,
    ): Promise<{ seq: number }> {
        for (let attempt = 0; attempt <= MAX_APPEND_RETRIES; attempt++) {
            if (attempt > 0 || (op !== "genesis" && !this.log)) await this.sync();
            if (this.integrityState.broken) throw new SpaceTrustError("integrity", "This space's member list couldn't be verified. You can still read messages you already have; sending is paused.");
            const head = this.log?.head ?? null;
            const unsigned = {
                v: 1 as const,
                spaceId: this.deps.spaceId,
                seq: head ? head.seq + 1 : 0,
                prev: head?.hash ?? "",
                op,
                by: this.deps.me(),
                ik: await this.deps.signer.identityKeyRaw(),
                at: Date.now(),
                body,
            } as UnsignedEntry;
            const sig = await this.deps.signer.sign(entryBytes(unsigned));
            const entry = { ...unsigned, sig } as MembershipEntry;
            const commit = ec ? await ec(await entryHash(unsigned), unsigned) : undefined;
            let r: { head: MlogHead };
            try {
                r = await this.deps.transport.postLogEntry(entry, commit);
            } catch (e) {
                if (e instanceof KeyringHttpError && e.status === 409 && !e.body?.code) {
                    await sleep(50 + Math.floor(Math.random() * 200));
                    continue;
                }
                if (e instanceof KeyringHttpError) {
                    throw new SpaceTrustError("log-refused", String(e.body?.error ?? e.message), { status: e.status, ...(e.body ?? {}) });
                }
                throw e;
            }
            // The entry is stored: a failure of this sync is not a refusal, and the entry is never re-sent.
            // It is logged, a background sync applies the entry later, and the stored seq is still returned.
            try {
                await this.sync();
            } catch (e) {
                const code = e instanceof KeyringHttpError ? e.status : (e as { code?: unknown } | null)?.code;
                logger.warn("LogSync: the entry was stored, but the sync confirming it failed", {
                    spaceId: this.deps.spaceId,
                    seq: r.head.seq,
                    code: code ?? "unknown",
                    message: e instanceof Error ? e.message : String(e),
                });
                this.scheduleSync();
            }
            return { seq: r.head.seq };
        }
        throw new SpaceTrustError("log-conflict", "The member list changed while saving. Try again.");
    }

    private emit(): void {
        for (const h of this.listeners) {
            try { h(); } catch { /* a listener's failure never breaks sync */ }
        }
    }
}
