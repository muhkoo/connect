import { entryBytes, entryHash } from "./canonical";
import { decodeRawP256, ikEquals, verifyP256 } from "./ik";
import type { MembershipEntry } from "./types";

export type Role = "owner" | "editor" | "viewer";
export interface LogMember { id: string; ik: string; role: Role; since: number }
export type ApplyResult = { ok: true } | { ok: false; integrity: string };

/** Ids the platform reserves; never a member (server brief §2.8). */
const RESERVED = /^(__keeper__$|__log__(:|$)|__agent__:|__fn__:|__link__:|__machine__:)/;
/**
 * Ops this client does not interpret yet: links and redeems arrive with the
 * link routes (step A0a), and log-enabled channels carry no agents or
 * functions, so `svc` and `retire` change nothing here.
 */
const UNSUPPORTED = new Set(["join", "link", "unlink", "redeem", "svc", "retire"]);

/**
 * A verified private membership log (design §3.5–§3.7). Pure: it fetches nothing.
 * An entry that chains correctly but fails its rule, signature or signer
 * binding is a no-op (SEC4). A chain break, a bad or missing genesis, a genesis
 * for another app, or an entry that cannot be encoded is integrity, and
 * nothing after it is applied. `apply` never throws on an entry a relay sends,
 * and it returns ok only once a genesis has been applied, so after an ok result
 * `head` is never null (a private log also has its `owner`).
 */
export class MembershipLog {
    private readonly byId = new Map<string, LogMember>();
    private readonly hashes = new Map<number, string>();
    private readonly invalidList: Array<{ seq: number; reason: string }> = [];
    private ownerId: string | null = null;
    private headVal: { seq: number; hash: string } | null = null;
    private humanRemovalSeq = -1;
    private publicLog = false;

    constructor(private readonly opts: { spaceId: string; appId: string }) {}

    get owner(): string | null { return this.ownerId; }
    get head(): { seq: number; hash: string } | null { return this.headVal; }
    get members(): LogMember[] { return [...this.byId.values()]; }
    get lastHumanRemovalSeq(): number { return this.humanRemovalSeq; }
    get invalid(): ReadonlyArray<{ seq: number; reason: string }> { return this.invalidList; }
    /** A public log: this client treats the Space as unlogged (a public genesis is step A0a). */
    get unsupported(): boolean { return this.publicLog; }
    member(id: string): LogMember | undefined { return this.byId.get(id); }
    isMember(id: string): boolean { return this.byId.has(id); }
    hashAt(seq: number): string | undefined { return this.hashes.get(seq); }

    async apply(entries: MembershipEntry[]): Promise<ApplyResult> {
        for (const e of entries) {
            if (typeof e !== "object" || e === null) return { ok: false, integrity: "malformed" };
            const expectSeq = (this.headVal?.seq ?? -1) + 1;
            if (e.seq !== expectSeq || e.prev !== (this.headVal?.hash ?? "") || e.spaceId !== this.opts.spaceId) {
                return { ok: false, integrity: "chain" };
            }
            const { sig, lsig: _lsig, ...unsigned } = e as MembershipEntry & { lsig?: string };
            let hash: string;
            try {
                hash = await entryHash(unsigned as never);
            } catch {
                // An unknown op, a non-integer `at`, a missing body or a bad epoch map:
                // an honest server never stores one, and its hash cannot be computed.
                return { ok: false, integrity: "malformed" };
            }
            if (e.seq === 0) {
                const bad = await this.checkGenesis(e, sig);
                if (bad) return { ok: false, integrity: bad };
            } else {
                const reason = await this.check(e, sig);
                if (reason) this.invalidList.push({ seq: e.seq, reason });
                else this.mutate(e);
            }
            this.headVal = { seq: e.seq, hash };
            this.hashes.set(e.seq, hash);
        }
        // A server that reports a head but sends no entries has withheld the genesis.
        if (!this.headVal) return { ok: false, integrity: "missing-genesis" };
        return { ok: true };
    }

    private async checkGenesis(e: MembershipEntry, sig: string): Promise<string | null> {
        if (e.op !== "genesis") return "chain";
        const b = e.body as { visibility?: string; appId?: string };
        if (!(await verifyP256(e.ik, sig, entryBytes(e as never)))) return "genesis";
        if (b.appId !== this.opts.appId) return "wrong-app";
        if (b.visibility !== "private") { this.publicLog = true; return null; }
        this.ownerId = e.by;
        this.byId.set(e.by, Object.freeze({ id: e.by, ik: e.ik, role: "owner", since: 0 }));
        return null;
    }

    private async check(e: MembershipEntry, sig: string): Promise<string | null> {
        if (this.publicLog) return "unsupported-op";
        if (e.op === "genesis") return "genesis-seq";
        if (UNSUPPORTED.has(e.op)) return "unsupported-op";
        const signer = this.byId.get(e.by);
        if (!signer) return "not-member";
        if (!ikEquals(signer.ik, e.ik)) return "identity-bound";
        if (!(await verifyP256(e.ik, sig, entryBytes(e as never)))) return "bad-signature";
        const b = e.body as { member?: string; memberIk?: string; role?: Role };
        switch (e.op) {
            case "add": {
                if (signer.role === "viewer") return "not-owner";
                if (signer.role === "editor" && b.role !== "viewer") return "editor-role";
                if (!b.member || RESERVED.test(b.member)) return "target-reserved";
                if (this.byId.has(b.member)) return "target-member";
                if (!decodeRawP256(b.memberIk)) return "bad-member-ik";
                if (b.role !== "viewer" && b.role !== "editor") return "malformed";
                return null;
            }
            case "role": {
                if (signer.role !== "owner") return "not-owner";
                if (!b.member || RESERVED.test(b.member)) return "target-reserved";
                if (b.member === this.ownerId) return "target-owner";
                if (!this.byId.has(b.member)) return "target-not-member";
                if (b.role !== "viewer" && b.role !== "editor") return "malformed";
                return null;
            }
            case "remove": {
                if (signer.role === "viewer") return "not-owner";
                if (!b.member || RESERVED.test(b.member)) return "target-reserved";
                if (b.member === this.ownerId) return "target-owner";
                const target = this.byId.get(b.member);
                if (!target) return "target-not-member";
                if (signer.role === "editor" && target.role === "editor") return "target-editor";
                return null;
            }
            case "leave":
                return e.by === this.ownerId ? "owner-leave" : null;
            default:
                return "unsupported-op";
        }
    }

    /**
     * Applies an entry `check` accepted. A member record is never changed in
     * place: a role change stores a new record, so a `LogMember` a caller
     * already holds keeps the state it was read at.
     */
    private mutate(e: MembershipEntry): void {
        const b = e.body as { member: string; memberIk: string; role: Role };
        switch (e.op) {
            case "add":
                this.byId.set(b.member, Object.freeze({ id: b.member, ik: b.memberIk, role: b.role, since: e.seq }));
                return;
            case "role":
                this.byId.set(b.member, Object.freeze({ ...this.byId.get(b.member)!, role: b.role }));
                return;
            case "remove":
                this.byId.delete(b.member);
                this.humanRemovalSeq = e.seq;
                return;
            case "leave":
                this.byId.delete(e.by);
                this.humanRemovalSeq = e.seq;
                return;
        }
    }
}
