import { KeyringHttpError } from "../../../src/spaces/KeyringClient";
import { entryHash } from "../../../src/spaces/trust/canonical";
import type { EpochCommit, MembershipEntry } from "../../../src/spaces/trust/types";

/** In-memory /keyring/log: CAS on seq/prev, paging and a scriptable conflict. No authority checks: the client's own rules are under test. */
export class FakeLogServer {
    entries: MembershipEntry[] = [];
    commits: EpochCommit[] = [];
    head: { seq: number; hash: string } | null = null;
    pageLimit = 500;
    gets = 0;
    beforePost: (() => Promise<void>) | null = null;
    status: number | null = null; // force an HTTP status on GET

    async fetchLog(since = -1, limit = 500) {
        this.gets++;
        if (this.status) throw new KeyringHttpError(this.status, { error: "forced" }, "GET /keyring/log");
        const page = this.entries.filter((e) => e.seq > since).slice(0, Math.min(limit, this.pageLimit));
        return { entries: page, head: this.head };
    }

    async postLogEntry(entry: MembershipEntry, ec?: EpochCommit) {
        await this.beforePost?.();
        const expSeq = (this.head?.seq ?? -1) + 1;
        if (entry.seq !== expSeq || entry.prev !== (this.head?.hash ?? "")) {
            throw new KeyringHttpError(409, { error: "Log moved", head: this.head }, "POST /keyring/log");
        }
        const { sig: _s, ...u } = entry;
        this.entries.push(entry);
        if (ec) this.commits.push(ec);
        const head = { seq: entry.seq, hash: await entryHash(u as never) };
        this.head = head;
        return { ok: true as const, head };
    }

    /** Server-side rollback or fork, for integrity tests: keeps seq ≤ toSeq, and the head becomes the new last entry. */
    async truncate(toSeq: number) {
        this.entries = this.entries.filter((e) => e.seq <= toSeq);
        const last = this.entries[this.entries.length - 1];
        if (toSeq < 0 || !last) {
            this.head = null;
            return;
        }
        const { sig: _s, ...u } = last;
        this.head = { seq: last.seq, hash: await entryHash(u as never) };
    }
}
