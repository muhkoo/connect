/**
 * Wire types for shared folders. These mirror the accelerator's `/api/shares` JSON
 * (`ShareInfo` in the accelerator's `durable-objects/space/share.ts`).
 */

export type ShareKind = "public" | "private";

/** Who may change a file: `own` = its uploader and the owner; `any` = any member (private shares only). */
export type EditPolicy = "own" | "any";

export interface ShareInfo {
    kind: ShareKind;
    ownerUsername: string;
    /** Storage cap in bytes, or null for no cap. */
    limitBytes: number | null;
    usedBytes: number;
    editPolicy: EditPolicy;
    name: string;
    /** Set once the share was rotated into another Space; follow `successor`. */
    closed: { successor: string; at: number } | null;
    /** The member list (usernames). */
    members: string[];
    /**
     * Display names by username, for uploaders and admitted members: label files by their `owner` with it. After a
     * rotation it also holds uploaders not (yet) re-admitted, so it is not the member list.
     */
    names: Record<string, string>;
}

/** One row of `GET /api/shares`. */
export interface ShareSummary {
    spaceId: string;
    kind: ShareKind;
    owner: string;
    name: string;
}

/** The password verifier the server stores for a public share (`proof` is derived from it). */
export type PasswordVerifier = { salt: string; iterations: number; verifier: string };

/** `GET /api/shares/:spaceId/public`: what a guest needs before being admitted (app key only, no session). */
export interface SharePublicInfo {
    kind: "public";
    name: string;
    ownerUsername: string;
    password: { salt: string; iterations: number };
    closed: { successor: string; at: number } | null;
}

export interface CreateShareBody {
    spaceId: string;
    kind: ShareKind;
    name: string;
    limitBytes: number | null;
    editPolicy: EditPolicy;
    password?: PasswordVerifier;
}

/** `POST /api/shares/:spaceId/admit`, sent with the signed-in account's session. */
export interface ShareAdmitBody {
    /** `passwordProof(password, salt, iterations)` with the share's public salt and iterations. */
    proof: string;
    /** The display name shown next to this member's uploads: 1–40 characters after trimming, no control characters. */
    name: string;
}
