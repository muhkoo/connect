/**
 * Wire types of the e2e-channels trust layer (spec 2026-09-27 §3.2, §3.5,
 * §4.2.4, §5.3.1). These shapes are signed and stored: never rename a field.
 *
 * Every string field holds the exact string that was transmitted; the
 * canonical encoders in `canonical.ts` sign those strings as they are.
 *
 * Ported from the accelerator's `src/trust/types.ts` (the server-only app
 * roster types are left out); the shared shapes must stay identical.
 */

export type Visibility = "private" | "public";
export type HistoryPolicy = "static" | "rotate";
export type MemberRole = "viewer" | "editor";
export type SvcMode = "addressed" | "all";
export type MlogOp =
  "genesis" | "add" | "role" | "remove" | "leave" | "join" | "link" | "unlink" | "redeem" | "svc" | "retire";

/** `legacyCommits` is `{}` for a new Space; values are b64url of 32 bytes, keys canonical decimal epochs. */
export interface GenesisBody {
  visibility: Visibility;
  policy: HistoryPolicy;
  appId: string;
  baseEpoch: number;
  legacyCommits: Record<string, string>;
}
export interface AddBody {
  member: string;
  memberIk: string;
  role: MemberRole;
}
export interface RoleBody {
  member: string;
  role: MemberRole;
}
export interface RemoveBody {
  member: string;
}
export type LeaveBody = Record<string, never>;
/** `via` is a linkId, or "" for no link. */
export interface JoinBody {
  via: string;
}
export interface LinkBody {
  linkId: string;
  role: MemberRole;
  standing: boolean;
  expiresAt: number;
  maxUses: number;
  linkEcdhPub: string;
  linkSignPub: string;
  keyCommits: Record<string, string>;
}
export interface UnlinkBody {
  linkId: string;
}
export interface RedeemBody {
  linkId: string;
}
export interface SvcBody {
  member: string;
  action: "add" | "remove";
  ecdhPub: string;
  ecdsaPub: string;
  mode: SvcMode;
  rosterSeq: number;
}
export interface RetireBody {
  member: string;
  reason: string;
}
export interface MlogBodies {
  genesis: GenesisBody;
  add: AddBody;
  role: RoleBody;
  remove: RemoveBody;
  leave: LeaveBody;
  join: JoinBody;
  link: LinkBody;
  unlink: UnlinkBody;
  redeem: RedeemBody;
  svc: SvcBody;
  retire: RetireBody;
}

interface EntryBase {
  v: 1;
  spaceId: string;
  /** 0 = genesis; −1 only in an enable intent (§5.3.3), never stored. */
  seq: number;
  /** hash of entry seq−1; "" at genesis and in an intent. */
  prev: string;
  /** Signer member id; "" in a server-written `retire`. */
  by: string;
  /** Signer IK (b64 or hex raw P-256), exactly as sent; "" in a `retire`. */
  ik: string;
  /** Signer clock, informational. */
  at: number;
  /** b64 P1363 ECDSA-P256-SHA256 by `ik` over entryBytes; "" only in a `retire`. */
  sig: string;
  /** Link-sign signature over entryBytes (`link`, `redeem`, `join` with `via`). */
  lsig?: string;
}
export type MembershipEntry<O extends MlogOp = MlogOp> = {
  [K in O]: EntryBase & { op: K; body: MlogBodies[K] };
}[O];
export type UnsignedEntry<O extends MlogOp = MlogOp> = {
  [K in O]: Omit<MembershipEntry<K>, "sig" | "lsig">;
}[O];
/** The `op` and `body` of an entry, still correlated (a `Pick` over the union would lose that). */
export type OpAndBody<O extends MlogOp = MlogOp> = {
  [K in O]: { op: K; body: MlogBodies[K] };
}[O];

export interface ChatKeyCert {
  v: 1;
  ik: string;
  ecdh: string;
  ecdsa: string;
  sig: string;
}
export interface EpochCommit {
  v: 1;
  spaceId: string;
  epoch: number;
  prevKeyed: number;
  keyCommit: string;
  headSeq: number;
  headHash: string;
  sole: boolean;
  by: string;
  ik: string;
  at: number;
  sig: string;
}
export interface MlogHead {
  seq: number;
  hash: string;
}
