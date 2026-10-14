import { entryBytes, entryHash } from "../../../src/spaces/trust/canonical";
import { LogSync, type LogSyncDeps } from "../../../src/spaces/trust/LogSync";
import type { MembershipEntry } from "../../../src/spaces/trust/types";
import { PinStore } from "../../../src/core/trust/PinStore";
import type { TrustStore } from "../../../src/core/trust/trustStore";
import { toBase64 } from "../../../src/utilities";
import { fakePersonalKv } from "../../core/trust/fakes";

export interface TestUser { name: string; ik: string; kp: CryptoKeyPair }

export async function user(name: string): Promise<TestUser> {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    return { name, kp, ik: toBase64(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey))) };
}

/** The user's IK behind the IdentitySigner shape. */
export function signerFor(u: TestUser) {
    return {
        identityKeyRaw: async () => u.ik,
        sign: async (b: Uint8Array) => toBase64(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, u.kp.privateKey, b))),
    };
}

/**
 * What every LogSync in one test shares. `directory` is the live record each
 * lookup reads, so a test can change an answer. `kvs` holds one personal KV per
 * user for the whole test: a user's pins live in one place, however many
 * LogSyncs (tabs) that user opens.
 */
export interface SyncEnv {
    spaceId: string;
    server: LogSyncDeps["transport"];
    store: TrustStore;
    directory: Record<string, string>;
    kvs: Map<string, ReturnType<typeof fakePersonalKv>>;
}

/** A LogSync for `u` over `env`, with `c-<name>` as the user's commitment and "app1" as the app. */
export function syncFor(u: TestUser, env: SyncEnv): LogSync {
    const signer = signerFor(u);
    let kv = env.kvs.get(u.name);
    if (!kv) {
        kv = fakePersonalKv();
        env.kvs.set(u.name, kv);
    }
    const pins = new PinStore({ http: kv.http as never, commitment: () => `c-${u.name}`, signer, store: async () => env.store });
    return new LogSync({
        spaceId: env.spaceId,
        me: () => u.name,
        appId: async () => "app1",
        commitment: () => `c-${u.name}`,
        transport: env.server,
        signer,
        directory: { lookup: async (n: string) => env.directory[n.toLowerCase()] } as never,
        pins,
        store: async () => env.store,
    });
}

/** Builds a correctly chained, correctly signed log; `signAs` lets a test sign with the wrong key. */
export class Chain {
    readonly entries: MembershipEntry[] = [];
    private lastHash = "";
    constructor(readonly spaceId: string) {}
    async push(u: TestUser, op: MembershipEntry["op"], body: Record<string, unknown>, opts: { signAs?: TestUser; ik?: string } = {}): Promise<MembershipEntry> {
        const unsigned = {
            v: 1 as const, spaceId: this.spaceId, seq: this.entries.length, prev: this.lastHash,
            op, by: u.name, ik: opts.ik ?? u.ik, at: 1_790_000_000_000 + this.entries.length, body,
        };
        const signer = opts.signAs ?? u;
        const sig = toBase64(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signer.kp.privateKey, entryBytes(unsigned as never))));
        const entry = { ...unsigned, sig } as MembershipEntry;
        this.entries.push(entry);
        this.lastHash = await entryHash(unsigned as never);
        return entry;
    }
    genesis(owner: TestUser, appId = "app1") {
        return this.push(owner, "genesis", { visibility: "private", policy: "static", appId, baseEpoch: -1, legacyCommits: {} });
    }
}
