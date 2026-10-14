import { HttpError, type HttpClient } from "../HttpClient";
import { concatBytes, dec, lp, lpStr } from "../../spaces/trust/lp";
import { verifyP256 } from "../../spaces/trust/ik";
import { toBase64Url, utf8Encode } from "../../utilities";
import { SpaceTrustError } from "./errors";
import type { IdentitySigner } from "./IdentitySigner";
import type { TrustStore } from "./trustStore";

export type PinDocName = "identity" | "spaces";

/** Reserved personal-KV keys and signing labels (SpecA §4.2; design §3.4, §6.6a). Frozen formats. */
const DOCS: Record<PinDocName, { key: string; label: string }> = {
    identity: { key: "muhkoo.pins/identity-v1", label: "muhkoo-pinmap-v1" },
    spaces: { key: "muhkoo.pins/spaces-v1", label: "muhkoo-spacepins-v1" },
};

export interface PinDoc {
    v: 1;
    ownerCommitment: string;
    counter: number;
    entries: Record<string, string>;
    sig: string;
}

/** `hlc` for a pin write: dec(counter) zero-padded to 16 digits, because the server compares strings (CP9). */
export const pad16 = (n: number): string => dec(n).padStart(16, "0");

/** LP(label) ‖ LP(ownerCommitment) ‖ LP(dec(counter)) ‖ LP(concat over keys sorted (code units) of LP(k) ‖ LP(v)). */
export function pinDocBytes(label: string, ownerCommitment: string, counter: number, entries: Record<string, string>): Uint8Array {
    const keys = Object.keys(entries).sort();
    return concatBytes(
        lpStr(label),
        lpStr(ownerCommitment),
        lpStr(dec(counter)),
        lp(concatBytes(...keys.map((k) => concatBytes(lpStr(k), lpStr(entries[k]))))),
    );
}

/** The `spaces-v1` key for a Space's genesis pin: "s:" + b64url(SHA-256(utf8(spaceId))). */
export async function spacePinKey(spaceId: string): Promise<string> {
    return "s:" + toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8Encode(spaceId))));
}

export interface PinStoreDeps {
    http: Pick<HttpClient, "post">;
    commitment: () => string | null;
    signer: IdentitySigner;
    store: () => Promise<TrustStore>;
}

export class PinStore {
    constructor(private readonly deps: PinStoreDeps) {}

    private commitment(): string {
        const c = this.deps.commitment();
        if (!c) throw new SpaceTrustError("pins-invalid", "Sign in first.");
        return c;
    }

    private markKey(doc: PinDocName): string {
        return `pinhw:${DOCS[doc].key}:${this.commitment()}`;
    }

    private kvPath(doc: PinDocName, suffix = ""): string {
        return `/api/personal/${encodeURIComponent(this.commitment())}/kv/${encodeURIComponent(DOCS[doc].key)}${suffix}`;
    }

    private async fetchDoc(doc: PinDocName): Promise<PinDoc | null> {
        try {
            const res = await this.deps.http.post<{ value?: PinDoc | null }>(this.kvPath(doc, "/get"), {});
            return res?.value ?? null;
        } catch (e) {
            if (e instanceof HttpError && e.status === 404) return null;
            throw new SpaceTrustError("pins-stale", "Couldn't verify members right now; retrying.");
        }
    }

    private async verify(doc: PinDocName, d: PinDoc): Promise<void> {
        const ok =
            d && d.v === 1 && d.ownerCommitment === this.commitment() &&
            Number.isSafeInteger(d.counter) && d.counter >= 1 &&
            d.entries && typeof d.entries === "object" &&
            Object.values(d.entries).every((v) => typeof v === "string") &&
            (await verifyP256(await this.deps.signer.identityKeyRaw(), d.sig, pinDocBytes(DOCS[doc].label, d.ownerCommitment, d.counter, d.entries)));
        if (!ok) throw new SpaceTrustError("pins-invalid", "Your saved trust records could not be verified.");
    }

    /** The current verified document; an empty bootstrap at counter 0 when none exists and no mark does either. */
    async read(doc: PinDocName): Promise<PinDoc> {
        const store = await this.deps.store();
        for (let attempt = 0; attempt < 2; attempt++) {
            const before = await store.get<number>(this.markKey(doc));
            const d = await this.fetchDoc(doc);
            const now = await store.get<number>(this.markKey(doc));
            if (!d) {
                if (before !== undefined) throw new SpaceTrustError("pins-missing", "Your saved trust records are missing.");
                return { v: 1, ownerCommitment: this.commitment(), counter: 0, entries: {}, sig: "" };
            }
            await this.verify(doc, d);
            if (before !== undefined && d.counter < before) throw new SpaceTrustError("pins-rollback", "Your saved trust records were rolled back.");
            if (now !== undefined && d.counter < now) continue; // stale, not a rollback (KI6): re-read once
            await store.put(this.markKey(doc), Math.max(d.counter, now ?? 0));
            return d;
        }
        throw new SpaceTrustError("pins-stale", "Couldn't verify members right now; retrying.");
    }

    async get(doc: PinDocName, key: string): Promise<string | undefined> {
        return (await this.read(doc)).entries[key];
    }

    /** Pin new keys. A key already pinned to a different value is reported, never overwritten (design §3.4). */
    async pin(doc: PinDocName, entries: Record<string, string>): Promise<{ conflicts: string[] }> {
        return this.mutate(doc, (cur) => {
            const next = { ...cur };
            const conflicts: string[] = [];
            for (const [k, v] of Object.entries(entries)) {
                if (next[k] === undefined) next[k] = v;
                else if (next[k] !== v) conflicts.push(k);
            }
            return { next, conflicts };
        });
    }

    async unpin(doc: PinDocName, keys: string[]): Promise<void> {
        await this.mutate(doc, (cur) => {
            const next = { ...cur };
            for (const k of keys) delete next[k];
            return { next, conflicts: [] };
        });
    }

    /** User-confirmed recovery (design §9.1 "Your saved trust records are missing."): forget the high-water mark. */
    async resetMark(doc: PinDocName): Promise<void> {
        await (await this.deps.store()).del(this.markKey(doc));
    }

    private async mutate(
        doc: PinDocName,
        change: (entries: Record<string, string>) => { next: Record<string, string>; conflicts: string[] },
    ): Promise<{ conflicts: string[] }> {
        const store = await this.deps.store();
        for (let attempt = 0; attempt <= 3; attempt++) {
            const cur = await this.read(doc);
            const { next, conflicts } = change(cur.entries);
            const same = Object.keys(next).length === Object.keys(cur.entries).length &&
                Object.entries(next).every(([k, v]) => cur.entries[k] === v);
            if (same) return { conflicts };
            const counter = cur.counter + 1;
            const c = this.commitment();
            const sig = await this.deps.signer.sign(pinDocBytes(DOCS[doc].label, c, counter, next));
            const value: PinDoc = { v: 1, ownerCommitment: c, counter, entries: next, sig };
            const res = await this.deps.http.post<{ applied?: boolean }>(this.kvPath(doc), { value, hlc: pad16(counter) });
            if (res?.applied === false) continue; // a concurrent writer won: re-read, merge, retry
            await store.put(this.markKey(doc), counter);
            return { conflicts };
        }
        throw new SpaceTrustError("pins-write-failed", "Couldn't save trust records right now.");
    }
}
