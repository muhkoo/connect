/**
 * `client.shares` — shared folders. A share is a Space the server keeps private, with a storage limit its owner pays
 * for, a file store whose uploaders are stamped server-side, and (for a public share) a password that admits
 * whoever knows it. The app's keeper holds each share's group key, so shares are not end-to-end encrypted.
 *
 *   const share = await client.shares.create({ kind: "public", name: "Wedding", limitBytes: 20e9, password });
 *   const { share, recovery } = await client.shares.joinWithPassword(spaceId, { password, name: "Gus" });
 *
 * Every member, a public share's guests included, is an ordinary Muhkoo account. Someone who opens a public share
 * signed out gets one quietly: a generated username and a random password they never see, a device login kept on
 * this device, and a recovery code ({@link GuestRecovery}) that signs them in elsewhere.
 *
 * Wire contract: the accelerator's `docs/superpowers/plans/2026-11-06-shared-folders-server-contract.md`. In short:
 * a share Space is created the way a public Space is (no membership-log genesis), `/metadata` first, the app keeper
 * seeded, then `POST /api/shares`; a rotation (new password, removed member) is a new Space adopted with
 * `POST /api/shares/:new/adopt`, never `/keyring/rotate`. An adopt that fails part-way is finished by repeating it
 * with the same new Space and the same settings, so a pending rotation is kept in the local store until it is done.
 */

import type { HttpClient } from "../HttpClient";
import { HttpError } from "../HttpError";
import type { AuthUser } from "./AuthNamespace";
import { DeviceRevokedError } from "./AuthNamespace";
import { KEEPER_MEMBER_ID } from "../../spaces/SpaceKeyring";
import { KeyringClient } from "../../spaces/KeyringClient";
import { Share, type ShareAdoptItem } from "../../shares/Share";
import { SharesClient } from "../../shares/SharesClient";
import {
    GuestLoginConflictError,
    InvalidRecoveryCodeError,
    RotationInProgressError,
    RotationIncompleteError,
    ShareClosedError,
    ShareFullError,
} from "../../shares/errors";
import { newPasswordVerifier, passwordProof } from "../../shares/password";
import { SHARE_SPACE_ID_PATTERN } from "../../shares/spaceId";
import type { EditPolicy, PasswordVerifier, ShareInfo, ShareKind, SharePublicInfo, ShareSummary } from "../../shares/types";
import type { FileManifest } from "../../storage/types";
import { VfsConflictError } from "../../vfs/types";
import { onSharingDropped, shareRotated, sharingFor, type SharingAccess, type SharingMoved, type SharingPlan } from "../../vfs/sharingAccess";

/** How many `closed.successor` links are followed before giving up (a rotation loop, or a very busy share). */
export const MAX_SHARE_SUCCESSOR_HOPS = 16;

/** The default label of the device login a quietly-created guest account keeps on this device (`deviceLabel` sets another). */
export const SHARE_GUEST_DEVICE_LABEL = "Shared folder guest";

/** What signs the same guest in on another device. Show it until the app calls `shares.acknowledgeRecovery()`. */
export interface GuestRecovery {
    username: string;
    /** The account's recovery phrase (24 words, space-separated). */
    phrase: string;
    /** `username` and `phrase` as one string to type or put in a QR code: see {@link guestRecoveryCode}. */
    code: string;
}

/** A device login for a guest account, kept on the device so the next visit signs in without asking. */
export interface GuestDeviceLogin {
    username: string;
    factorId: string;
    /** Opens the account's seed while the device factor exists: keep it as private as a session token. */
    deviceKey: string;
}

/**
 * Where `client.shares` keeps its per-device state: the guest device login, an unfinished guest setup, whether the
 * guest's recovery code is still to be shown, and unfinished rotations. String values; `set` may throw (a full or
 * blocked storage), `get` should answer null rather than throw.
 */
export interface SharesLocalStore {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
}

/** A store that lasts as long as the process (Node, Workers, tests). */
export function memorySharesStore(): SharesLocalStore {
    const m = new Map<string, string>();
    return {
        get: async (k) => m.get(k) ?? null,
        set: async (k, v) => void m.set(k, v),
        delete: async (k) => void m.delete(k),
    };
}

/**
 * The default store: `localStorage` under `prefix` where there is one (browsers, the same place the session token
 * lives), else memory. One per app: the Client keys it by the app key and the accelerator.
 */
export function defaultSharesStore(prefix: string): SharesLocalStore {
    const ls = localStorageOrNull();
    if (!ls) return memorySharesStore();
    return {
        get: async (k) => {
            try {
                return ls.getItem(prefix + k);
            } catch {
                return null;
            }
        },
        set: async (k, v) => ls.setItem(prefix + k, v),
        delete: async (k) => {
            try {
                ls.removeItem(prefix + k);
            } catch {
                /* nothing to clear */
            }
        },
    };
}

function localStorageOrNull(): Storage | null {
    try {
        const ls = (globalThis as { localStorage?: Storage }).localStorage;
        return ls && typeof ls.getItem === "function" ? ls : null;
    } catch {
        return null;
    }
}

/** `<username>:<phrase words joined by "-">`, e.g. `g-abcdefghijkl:alpha-beta-…`. */
export function guestRecoveryCode(username: string, phrase: string): string {
    return `${username}:${phrase.trim().split(/\s+/).join("-")}`;
}

/** Read a {@link guestRecoveryCode}: case-insensitive, words separated by spaces or dashes. */
export function parseGuestRecoveryCode(code: string): { username: string; phrase: string } {
    const at = typeof code === "string" ? code.indexOf(":") : -1;
    const username = at < 0 ? "" : code.slice(0, at).trim().toLowerCase();
    const words = at < 0 ? [] : code.slice(at + 1).trim().toLowerCase().split(/[\s-]+/).filter(Boolean);
    if (!username || words.length === 0) throw new InvalidRecoveryCodeError();
    return { username, phrase: words.join(" ") };
}

/**
 * The guest recovery an error from `client.shares` carries, or null. Any error thrown after a guest account exists
 * carries it while it has not been acknowledged, so the app can always show the code.
 */
export function guestRecoveryOf(err: unknown): GuestRecovery | null {
    const r = (err as { recovery?: unknown } | null)?.recovery;
    return r && typeof r === "object" && typeof (r as GuestRecovery).code === "string" ? (r as GuestRecovery) : null;
}

/** The account calls `client.shares` needs for a quiet guest account: `client.auth.zk` has them all. */
export interface ShareGuestAuth {
    register(params: { username: string; password: string }): Promise<AuthUser>;
    enrollDevice(label: string): Promise<{ factorId: string; deviceKey: string }>;
    loginWithDevice(username: string, factorId: string, deviceKey: string): Promise<AuthUser>;
    /** Recover the seed of the signed-in account from a device login (no new session). */
    unlockWithDevice(username: string, factorId: string, deviceKey: string): Promise<void>;
    revokeDevice(factorId: string): Promise<boolean>;
    /** Deterministic from the account seed: calling it again gives the same phrase. */
    enrollRecoveryPhrase(): Promise<string>;
    recoverWithPhrase(username: string, phrase: string): Promise<AuthUser>;
}

/** The keyring calls `client.shares` makes on a share Space (a {@link SpaceKeyring} has them). */
export interface ShareSpaceKeyring {
    admit(memberId: string, identityEcdhPub: string): Promise<void>;
    loadFromCache(): Promise<boolean>;
    hasAnyKey(): boolean;
    requestKey(): Promise<void>;
    pullKeys(): Promise<number>;
}

/** A share Space handle (a {@link Space} is one). */
export interface ShareSpaceHandle {
    readonly id: string;
    /** Absent while the session is locked. */
    readonly keyring?: ShareSpaceKeyring;
    disconnect(): void;
}

/** The Space calls `client.shares` makes: `client.space` has them all. */
export interface ShareSpaces {
    createSpace(opts: { historyPolicy: "static" }): Promise<ShareSpaceHandle>;
    get(spaceId: string): Promise<ShareSpaceHandle>;
    joinByInvite(spaceId: string, token: string): Promise<ShareSpaceHandle>;
}

export interface SharesNamespaceDeps {
    /** The app's HTTP client (app key and the signed-in session). */
    http: HttpClient;
    /** The signed-in username, or null when no one is signed in. */
    me: () => string | null;
    /**
     * Whether the signed-in session holds its seed. A session restored after a reload has a token but no seed
     * (locked): a guest's device login unlocks it.
     */
    unlocked: () => boolean;
    spaces: ShareSpaces;
    auth: ShareGuestAuth;
    store: SharesLocalStore;
    /** The page invite links point at; default: the current page in a browser. */
    inviteBase?: () => string | null;
    /** The wait before the n-th retry of an adopt is `n × retryDelayMs` (default 500). */
    retryDelayMs?: number;
    /** A pre-compiled Reed-Solomon module, for runtimes without the bundled loader (Node tests, Workers). */
    rsWasmModule?: WebAssembly.Module;
}

/** {@link SharesNamespace.shareFolder}'s settings for the new share (ignored when an earlier run made it already). */
export interface ShareFolderOptions {
    kind: ShareKind;
    /** Storage cap in bytes, or null for none. A folder bigger than this is refused before anything changes. */
    limitBytes: number | null;
    editPolicy?: EditPolicy;
    /** Required for a public share, refused for a private one. */
    password?: string;
    /** Default: the folder's name. */
    name?: string;
}

export interface CreateShareOptions {
    kind: ShareKind;
    name: string;
    /** Storage cap in bytes, or null for none. */
    limitBytes: number | null;
    /** Default `"own"`: members change only their own files (the owner can always change anything). */
    editPolicy?: EditPolicy;
    /** Required for a public share, refused for a private one. Never sent: only a salted verifier is. */
    password?: string;
}

/** Moved files whose personal reference is still to be let go of, once the folder at `path` is a link. */
interface PendingRelease {
    path: string;
    /** The id the swap wrote the link with: only that link proves the swap happened. */
    linkId: string;
    files: Array<{ fileId: string; manifest: FileManifest }>;
}

/**
 * A rotation claimed but not yet finished, as kept in the store. Retried with exactly these values.
 *
 * NOTE: `password` is the NEW password's verifier (salt, iterations, verifier - never the password), and it sits in
 * the local store (`localStorage` in a browser) from the moment the rotation is claimed until it completes or is
 * abandoned (`abandonRotation`). A retry must send the very same verifier, so it cannot be dropped earlier. It is
 * kept on purpose after a `rotation_mismatch` refusal too: that answer means the server holds a claim with other
 * settings, and forgetting ours would let a new rotation start from a half-filled Space; `abandonRotation` is the
 * explicit way out.
 */
interface PendingRotation {
    from: string;
    newSpaceId: string;
    password?: PasswordVerifier;
    remove?: string[];
}

/** A guest account whose setup (recovery phrase, device login) is not finished. */
interface GuestSetup {
    username: string;
    phrase: boolean;
    device: boolean;
}

type RotationRequest = { password?: string; remove?: string[] };

const K_LOGIN = "guest/login";
const K_SETUP = "guest/setup";
const K_RECOVERY = "guest/recovery";
const K_ROTATIONS = "rotations";
/**
 * Per share `shareFolder` filled: `{ path, files }`, the moved files whose personal reference is still to be let go
 * of once the folder at `path` is a link to that share. Written before the swap, drained after it.
 */
const K_PENDING = "share-folder/pending/";
/**
 * Per share `shareFolder` is filling: the ids of the records it has put in the share, so that a later run can take
 * back out what is no longer in the folder. `<prefix><spaceId>` holds `{ chunks }`, and `<prefix><spaceId>/<i>`
 * each chunk (an array of at most POSTED_CHUNK ids), so noting one more id rewrites one small chunk, not the list.
 * Written before each record is posted; moved along when the share is rotated; dropped once the folder is a link.
 */
const K_POSTED = "share-folder/posted/";
const POSTED_CHUNK = 100;
/** How many files are let go of between saves of that list. */
const RELEASED_SAVE_EVERY = 25;
/** How many times `shareFolder` reads the folder again when it changed while being shared. */
const SHARE_FOLDER_TRIES = 3;

/** How many times a just-sent join request is followed by a key pull before `open` stops waiting for the keeper. */
const KEY_PULLS = 4;
const KEY_PULL_GAP_MS = 250;
/** Attempts of one adopt call before it is left pending (network errors and 5xx only). */
const ADOPT_TRIES = 3;
/** How many generated guest usernames are tried before a "taken" refusal is passed on. */
const GUEST_USERNAME_TRIES = 5;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const INVITE_LINK = new RegExp(`#/join/(${SHARE_SPACE_ID_PATTERN})/([^/?#]+)$`);

export class SharesNamespace {
    /** The `/api/shares` wire client, for calls this namespace does not wrap. */
    readonly api: SharesClient;
    /** The recovery phrase as last derived, so it is not re-derived on every call. */
    private recoveryCache: GuestRecovery | null = null;

    constructor(private readonly deps: SharesNamespaceDeps) {
        this.api = new SharesClient(deps.http);
        // A folder that was being shared was deleted: its pending releases (if any) are void, and so is the list
        // of what that run put in the share.
        onSharingDropped(this, (spaceId) => {
            void this.deps.store.delete(K_PENDING + spaceId).catch(() => {});
            void PostedLog.clear(this.deps.store, spaceId).catch(() => {});
        });
    }

    /**
     * Make a share. The Space is created as a public Space would be (no membership-log genesis: the server refuses a
     * log-enabled Space), the app keeper is given its group key so members can join with the owner offline, then
     * `POST /api/shares` makes it a share (and private, server-side). A public share sends a salted verifier, never
     * the password.
     */
    async create(opts: CreateShareOptions): Promise<Share> {
        if (opts.kind === "public" && !opts.password) throw new Error("A public share needs a password.");
        if (opts.kind === "private" && opts.password !== undefined) throw new Error("A private share has no password.");
        this.requireMe();
        const password = opts.kind === "public" ? await newPasswordVerifier(opts.password!) : undefined;
        const spaceId = await this.newSeededSpace();
        await this.api.create({
            spaceId,
            kind: opts.kind,
            name: opts.name,
            limitBytes: opts.limitBytes,
            editPolicy: opts.editPolicy ?? "own",
            ...(password ? { password } : {}),
        });
        return this.shareFor(spaceId);
    }

    /**
     * Share a folder of the user's own (`client.vfs`): its files move into a new share, without uploading a byte,
     * and the folder becomes a link to the share, so the user's tree looks the same. Returns the share.
     *
     * 1. The folder's size is checked against `limitBytes` first: over it, {@link ShareFullError} and nothing
     *    has changed.
     * 2. The share is made (named after the folder unless `name` is given) and the folder is marked as going
     *    to it, so a run that stops part-way resumes into the same share.
     * 3. Each file's existing manifest is posted to the share at its path inside the folder.
     * 4. Only then is the folder replaced by the link, and only after that is each file's personal reference let
     *    go of. Until then the owner is billed for both copies. Earlier versions of the files are not carried
     *    into the share; they are let go of here too.
     *
     * Nothing in the folder is removed, and nothing let go of, before step 4; an interrupted run (a closed tab, a
     * network failure) is finished by calling `shareFolder` again on the same path: it reuses the share (following
     * it if it was rotated) and skips files already in it. The options are then ignored. A file saved into the
     * folder while it is being shared is moved too. A file (or empty folder) moved out of the folder or deleted
     * from it meanwhile - during the run, or between an interrupted run and the one that finishes it - is taken
     * back out of the share before the folder becomes a link, so the share never holds what the folder no longer
     * does; a file moved out keeps its personal copy. Only records this flow put in the share are taken back
     * (their ids are kept on this device, under the share, until the folder is a link): a file another member
     * uploaded meanwhile is never touched. That list is kept per device: a run finished on another device (or after
     * this device's storage was cleared) cannot take back what the stopped run posted. The take-back runs before
     * anything is posted, so what it frees counts toward the share's limit. If the run stopped after the link was in place, calling it again (or
     * opening the share) lets go of what was left.
     *
     * Refused with `VfsConflictError` for what is not a folder of the user's own, `/` and `/Home`, a folder that
     * holds a link (a share cannot hold another) or an entry this SDK version cannot read.
     */
    async shareFolder(path: string, opts: ShareFolderOptions): Promise<Share> {
        const vfs = sharingFor(this);
        if (!vfs) throw new Error("client.shares.shareFolder needs client.vfs.");
        if (opts.kind === "public" && !opts.password) throw new Error("A public share needs a password.");
        if (opts.kind === "private" && opts.password !== undefined) throw new Error("A private share has no password.");
        this.requireMe();
        // Already a link: an earlier run that stopped after the swap. Finish letting go, and that is all.
        const linked = await vfs.readLink(path).catch(() => null);
        if (linked && (await this.drainPending(linked.spaceId))) return this.shareFor(linked.spaceId);
        for (let attempt = 1; ; attempt++) {
            const plan = await vfs.sharingPlan(path);
            const spaceId = await this.shareForFolder(vfs, path, plan, opts);
            const share = this.shareFor(spaceId);
            const posted = await PostedLog.load(this.deps.store, spaceId);
            // Before posting anything: what an earlier run (or attempt) put in the share that the folder no longer
            // holds. First, so that the space it takes cannot make this run's posts fail as `share_full`. A record
            // `adopt` may reuse for a planned file (one of its ids, or the record at its path) is kept for now.
            const candidates = new Set(plan.files.flatMap((f) => [f.manifest.id, `${f.manifest.id}.${f.fileId}`]));
            const filePaths = new Set(plan.files.map((f) => trimSlashes(f.path)));
            await this.takeBackRemoved(share, plan, posted, (r) => candidates.has(r.id) || filePaths.has(r.path));
            const holding = await this.moveIntoShare(share, plan, posted);
            // And after: a kept record `adopt` did not end up using for any planned file (before the swap).
            await this.takeBackRemoved(share, plan, posted, (r) => holding.has(r.id));
            const moved: SharingMoved = {
                files: new Map(plan.files.map((f) => [f.fileId, f.manifest.id])),
                emptyDirs: new Set(plan.folders.map((f) => f.dirId)),
            };
            // The id the link is written with. A link at `path` with this id is proof the swap happened; any other
            // link there (one the user made with `vfs.link` after deleting the folder) is not, and drains nothing.
            const linkId = newLinkId();
            // Kept before the swap, so a run that stops right after it still lets go of these later.
            //
            // NOTE: this is the PLAN's list. If the run stops after the link is written but before the list is
            // rewritten below to what the swap actually removed, a later drain releases from this one. It differs
            // only when a folder record was kept because another device wrote into it at that same moment (see
            // `finishSharing`): then the files of that record are released although the kept record still names
            // them. Their bytes stay stored for the platform's retention period; only a crash at exactly this
            // point, together with such a write, gets there.
            await this.savePending(spaceId, {
                path: plan.path,
                linkId,
                files: plan.files.map((f) => ({ fileId: f.fileId, manifest: f.manifest })),
            });
            let finished;
            try {
                finished = await vfs.finishSharing(path, plan.dirId, spaceId, moved, linkId);
            } catch (err) {
                // The swap did not happen (no link with our id): this attempt's list is void.
                const at = await vfs.readLink(plan.path).catch(() => null);
                if (at?.linkId !== linkId) await this.deps.store.delete(K_PENDING + spaceId).catch(() => {});
                // The folder changed meanwhile (a file saved, moved out or deleted): read it again.
                if (err instanceof VfsConflictError && attempt < SHARE_FOLDER_TRIES) continue;
                throw err;
            }
            // Exactly what left the tree: a record another device wrote into was kept, with its files.
            const pending: PendingRelease = { path: plan.path, linkId, files: finished.detached };
            await this.savePending(spaceId, pending);
            if (finished.kept.length > 0) {
                console.warn("[client.shares] shareFolder left folder records that changed elsewhere in place:", finished.kept);
            }
            // The folder is a link: the share's records are the folder now, nothing left to take back.
            await posted.clear().catch(() => {});
            await this.drainPending(spaceId, pending);
            return share;
        }
    }

    /** The shares the signed-in user owns or belongs to, for this app. */
    list(): Promise<ShareSummary[]> {
        return this.api.list();
    }

    /**
     * Open a share as the signed-in user, following `closed.successor` to the current Space, and make sure this
     * member has the group key (a join request the keeper answers). When the share moved to a Space this user is
     * not a member of (a public share's password changed), throws {@link ShareClosedError} with that Space as
     * `successor`: ask for the new password and call {@link joinWithPassword}.
     *
     * A guest's recovery code still to be shown is not returned here: read {@link pendingRecovery}.
     */
    async open(spaceId: string): Promise<Share> {
        const me = this.requireMe();
        await this.unlockSavedGuest();
        // A guest account left half set up by an earlier visit: finish it, without failing the open.
        await this.finishGuestSetup(me, SHARE_GUEST_DEVICE_LABEL).catch((err) => {
            // Never the error itself: it carries the guest's recovery code (see `withRecovery`).
            console.warn("[client.shares] finishing the guest account setup failed (will retry):", errorText(err));
        });
        const current = await this.current(spaceId);
        await this.joinKeys(current);
        // A shareFolder of this share that stopped after its link was in place: let go of what it left.
        await this.drainPending(spaceId).catch(() => false);
        return this.shareFor(current);
    }

    /**
     * Join a public share with its password. If no one is signed in, the device login kept from an earlier visit
     * signs in; failing that, a guest account is made quietly. `recovery` is the guest's recovery code while the app
     * has not called {@link acknowledgeRecovery}: show it, then acknowledge. Any error thrown once the account
     * exists carries it too ({@link guestRecoveryOf}).
     *
     * Follows `closed.successor`, so an old link still reaches the current share. Throws {@link SharePasswordError}
     * on a wrong password, {@link SharePasswordRateError} after too many, {@link ShareMemberLimitError} when full.
     */
    async joinWithPassword(
        spaceId: string,
        opts: { password: string; name: string; deviceLabel?: string },
    ): Promise<{ share: Share; recovery: GuestRecovery | null }> {
        const name = displayName(opts.name);
        let { id, info } = await this.currentPublic(spaceId, 0);
        await this.ensureSignedIn(opts.deviceLabel ?? SHARE_GUEST_DEVICE_LABEL);
        try {
            let hops = 0;
            for (;;) {
                const proof = await passwordProof(opts.password, info.password.salt, info.password.iterations);
                try {
                    await this.api.admit(id, { proof, name });
                    break;
                } catch (err) {
                    // Rotated between reading the salt and admitting: start again on the successor.
                    if (!(err instanceof ShareClosedError) || !err.successor || hops >= MAX_SHARE_SUCCESSOR_HOPS) throw err;
                    hops++;
                    ({ id, info } = await this.currentPublic(err.successor, hops));
                }
            }
            await this.joinKeys(id);
        } catch (err) {
            throw await this.withRecovery(err);
        }
        return { share: this.shareFor(id), recovery: await this.pendingRecovery() };
    }

    /**
     * The signed-in guest's recovery code if the app has not yet acknowledged showing it, else null. Survives a
     * reload: the phrase is derived again from the account (never stored), so it needs the session unlocked.
     */
    async pendingRecovery(): Promise<GuestRecovery | null> {
        const me = this.deps.me();
        if (!me) return null;
        if (this.recoveryCache?.username === me) return this.recoveryCache; // also covers a flag that could not be kept
        const flag = await this.readJson<{ username: string }>(K_RECOVERY);
        if (flag?.username !== me) return null;
        await this.unlockSavedGuest();
        try {
            const phrase = await this.deps.auth.enrollRecoveryPhrase();
            this.recoveryCache = { username: me, phrase, code: guestRecoveryCode(me, phrase) };
            return this.recoveryCache;
        } catch {
            return null;
        }
    }

    /** The guest has saved their recovery code: stop returning it. */
    async acknowledgeRecovery(): Promise<void> {
        this.recoveryCache = null;
        await this.deps.store.delete(K_RECOVERY);
    }

    /**
     * Sign a guest in on this device from their recovery code ({@link guestRecoveryCode}), and keep a device login
     * so the next visit signs in by itself. If another guest's login is kept on this device, throws
     * {@link GuestLoginConflictError} unless `replace: true`; replacing revokes that login's device factor where it
     * can.
     */
    async restoreGuest(code: string, opts: { replace?: boolean; deviceLabel?: string } = {}): Promise<AuthUser> {
        const { username, phrase } = parseGuestRecoveryCode(code);
        const existing = await this.readJson<GuestDeviceLogin>(K_LOGIN);
        const replacing = existing && existing.username !== username ? existing : null;
        if (replacing && !opts.replace) throw new GuestLoginConflictError(replacing.username);
        // The new guest first: a mistyped code must leave the old guest's login untouched.
        const user = await this.deps.auth.recoverWithPhrase(username, phrase);
        const { factorId, deviceKey } = await this.deps.auth.enrollDevice(opts.deviceLabel ?? SHARE_GUEST_DEVICE_LABEL);
        const login: GuestDeviceLogin = { username: user.username, factorId, deviceKey };
        const saved = await this.trySave(K_LOGIN, login, "the guest device login");
        if (replacing) {
            await this.revokeReplacedLogin(replacing, login);
            if (!saved) await this.deleteIfFor(K_LOGIN, replacing.username);
            await this.deleteIfFor(K_SETUP, replacing.username);
            await this.deleteIfFor(K_RECOVERY, replacing.username);
            if (this.recoveryCache?.username === replacing.username) this.recoveryCache = null;
        }
        return user;
    }

    /** Set the storage cap (bytes, or null for none). Owner only. */
    setLimit(spaceId: string, limitBytes: number | null): Promise<ShareInfo> {
        return this.api.update(spaceId, { limitBytes });
    }

    /** Who may change a file in a private share: `"own"` (uploader and owner) or `"any"` member. Owner only. */
    setEditPolicy(spaceId: string, policy: EditPolicy): Promise<ShareInfo> {
        return this.api.update(spaceId, { editPolicy: policy });
    }

    /** Invite an account by username (owner only). They join by opening the share ({@link open}). */
    async invite(spaceId: string, username: string): Promise<void> {
        await this.keyring(spaceId).invite(username);
    }

    /**
     * Mint an invite link (owner only): `<base>#/join/<spaceId>/<token>`, where `base` is `opts.baseUrl` or the
     * current page. The URL is also what an in-person invite's QR code holds. Whoever opens it signs in and calls
     * {@link joinWithInvite}.
     */
    async inviteLink(spaceId: string, opts: { baseUrl?: string } = {}): Promise<{ url: string; token: string }> {
        const base = opts.baseUrl ?? this.deps.inviteBase?.() ?? currentPage();
        if (!base) throw new Error("inviteLink: pass baseUrl (there is no current page to link to).");
        const { token } = await this.keyring(spaceId).createInviteLink({ role: "editor" });
        return { url: `${base.replace(/#.*$/, "")}#/join/${spaceId}/${encodeURIComponent(token)}`, token };
    }

    /** Join a private share from an invite link ({@link inviteLink}) as the signed-in user. */
    async joinWithInvite(url: string): Promise<Share> {
        const m = url.trim().match(INVITE_LINK);
        if (!m) throw new Error("That is not a share invite link.");
        this.requireMe();
        const spaceId = m[1];
        const space = await this.deps.spaces.joinByInvite(spaceId, decodeURIComponent(m[2]));
        space.disconnect();
        return this.open(spaceId);
    }

    /**
     * Change a public share's password. The share moves to a new Space (its files and settings come along; nothing
     * is uploaded again) and only the owner is carried: everyone else is admitted again with the new password, as
     * the same account, keeping their files and name. Returns the new share.
     *
     * Throws {@link RotationIncompleteError} if the move did not finish; calling this again (or
     * {@link resumeRotation}) finishes it into the same Space.
     */
    changePassword(spaceId: string, password: string): Promise<Share> {
        if (!password) return Promise.reject(new Error("A public share needs a password."));
        return this.rotate(spaceId, { password });
    }

    /**
     * Remove a member for good: the share moves to a new Space without them (nothing is uploaded again). On a
     * public share pass a new `password` too, or they can be admitted again with the old one. Returns the new share.
     * An unfinished move is handled as in {@link changePassword}.
     */
    removeMember(spaceId: string, username: string, opts: { password?: string } = {}): Promise<Share> {
        return this.rotate(spaceId, { remove: [username], ...(opts.password ? { password: opts.password } : {}) });
    }

    /**
     * Finish a rotation of this share that an earlier call (on this device, perhaps before a reload) left unfinished.
     * Returns the new share, or null when none is pending. Throws {@link RotationIncompleteError} if it still fails.
     */
    async resumeRotation(spaceId: string): Promise<Share | null> {
        this.requireMe();
        const pending = await this.pendingRotationFor(spaceId);
        return pending ? this.finishRotation(pending) : null;
    }

    /**
     * Forget this share's unfinished rotation without finishing it. Only for a rotation you know can never complete
     * (its new Space is gone or refused): files the server had not yet copied stay in the closed original Space, and
     * the next rotation starts from wherever the share now points. Returns whether one was pending.
     */
    async abandonRotation(spaceId: string): Promise<boolean> {
        const pending = await this.pendingRotationFor(spaceId);
        if (!pending) return false;
        await this.dropRotation(pending.from);
        return true;
    }

    // -- rotation -------------------------------------------------------------

    private async rotate(spaceId: string, request: RotationRequest): Promise<Share> {
        this.requireMe();
        // A rotation of this share left unfinished comes first: a new one started from its half-filled successor
        // would strand the files not yet copied in the closed original. Looked up before and after resolving
        // `from`, so a Space the walk reached some other way is caught too.
        let pending = await this.pendingRotationFor(spaceId);
        let start = spaceId;
        let from: string;
        for (let round = 0; ; round++) {
            if (pending) {
                const share = await this.finishRotation(pending);
                if (await sameRotation(pending, request)) return share;
                start = share.spaceId;
            }
            from = await this.current(start);
            const all = await this.loadRotations();
            pending = all[from] ?? Object.values(all).find((r) => r.newSpaceId === from) ?? null;
            if (!pending) break;
            if (round >= MAX_SHARE_SUCCESSOR_HOPS) throw tooManyHops();
        }
        const password = request.password ? await newPasswordVerifier(request.password) : undefined;
        const newSpaceId = await this.newSeededSpace();
        const rotation: PendingRotation = {
            from,
            newSpaceId,
            ...(password ? { password } : {}),
            ...(request.remove ? { remove: [...request.remove] } : {}),
        };
        // Kept before the adopt is sent: a retry must repeat exactly this Space and these settings.
        await this.saveRotation(rotation);
        return this.finishRotation(rotation);
    }

    /** Send the adopt (with retries on network errors and 5xx); forget the rotation once done or dead. */
    private async finishRotation(p: PendingRotation): Promise<Share> {
        const body = {
            from: p.from,
            ...(p.password ? { password: p.password } : {}),
            ...(p.remove ? { remove: p.remove } : {}),
        };
        let last: unknown;
        for (let attempt = 1; attempt <= ADOPT_TRIES; attempt++) {
            try {
                await this.api.adopt(p.newSpaceId, body);
                // `from` is closed now: a VFS that kept it open (a link, /Home/Shared) opens the new Space instead.
                shareRotated(this, p.from, p.newSpaceId);
                await this.dropRotation(p.from);
                return this.shareFor(p.newSpaceId);
            } catch (err) {
                if (!retryable(err)) {
                    // Another rotation won, or the claim was refused outright: this one can never finish.
                    if (err instanceof RotationInProgressError || (err instanceof HttpError && (err.status === 403 || err.status === 404))) {
                        await this.dropRotation(p.from);
                    }
                    throw err;
                }
                last = err;
                if (attempt < ADOPT_TRIES) await delay((this.deps.retryDelayMs ?? 500) * attempt);
            }
        }
        throw new RotationIncompleteError(p.from, p.newSpaceId, last);
    }

    /** The unfinished rotation `spaceId` belongs to: as its `from`, its new Space, or a Space before its `from`. */
    private async pendingRotationFor(spaceId: string): Promise<PendingRotation | null> {
        const all = await this.loadRotations();
        const list = Object.values(all);
        if (list.length === 0) return null;
        const hit = (id: string) => all[id] ?? list.find((r) => r.newSpaceId === id) ?? null;
        let id = spaceId;
        for (let hops = 0; hops <= MAX_SHARE_SUCCESSOR_HOPS; hops++) {
            const h = hit(id);
            if (h) return h;
            // An error here is not "none pending": guessing wrong would start a rotation from a half-filled Space.
            const info = await this.api.info(id);
            if (!info.closed) return null;
            id = info.closed.successor;
        }
        return null;
    }

    private async loadRotations(): Promise<Record<string, PendingRotation>> {
        return (await this.readJson<Record<string, PendingRotation>>(K_ROTATIONS)) ?? {};
    }

    private async saveRotation(p: PendingRotation): Promise<void> {
        const all = await this.loadRotations();
        all[p.from] = p;
        await this.deps.store.set(K_ROTATIONS, JSON.stringify(all));
    }

    private async dropRotation(from: string): Promise<void> {
        const all = await this.loadRotations();
        if (!(from in all)) return;
        delete all[from];
        try {
            if (Object.keys(all).length === 0) await this.deps.store.delete(K_ROTATIONS);
            else await this.deps.store.set(K_ROTATIONS, JSON.stringify(all));
        } catch (err) {
            console.warn("[client.shares] could not forget a finished rotation:", err);
        }
    }

    // -- sharing a folder -----------------------------------------------------

    /**
     * The share `plan`'s folder is going to: the one an earlier run marked it with (its successor if it was
     * rotated), else a new one, made only once the folder is known to fit and then marked on the folder.
     */
    private async shareForFolder(vfs: SharingAccess, path: string, plan: SharingPlan, opts: ShareFolderOptions): Promise<string> {
        if (plan.sharing) {
            let current: string | null = null;
            try {
                current = await this.current(plan.sharing.spaceId);
            } catch (err) {
                // The share is gone: start again with a new one. Its files are still in the folder.
                if (!(err instanceof HttpError) || err.status !== 404 || err instanceof ShareClosedError) throw err;
            }
            if (current) {
                const info = await this.api.info(current);
                refuseOverLimit(plan, info.limitBytes, info.usedBytes);
                if (current !== plan.sharing.spaceId) {
                    // Rotated: its records (same ids) are in the new Space, and so is what this flow posted.
                    await PostedLog.move(this.deps.store, plan.sharing.spaceId, current);
                    await vfs.markSharing(path, plan.dirId, current);
                }
                return current;
            }
            await PostedLog.clear(this.deps.store, plan.sharing.spaceId).catch(() => {});
        }
        refuseOverLimit(plan, opts.limitBytes, 0);
        const share = await this.create({
            kind: opts.kind,
            name: opts.name ?? plan.name,
            limitBytes: opts.limitBytes,
            editPolicy: opts.editPolicy,
            password: opts.password,
        });
        await vfs.markSharing(path, plan.dirId, share.spaceId);
        return share.spaceId;
    }

    /**
     * Post every file of `plan` to `share`, and its empty folders. Nothing of the user's is let go of here. Each
     * record's id is noted in `posted` before it is posted. Returns the ids of the records that hold `plan`'s files.
     */
    private async moveIntoShare(share: Share, plan: SharingPlan, posted: PostedLog): Promise<Set<string>> {
        const items: ShareAdoptItem[] = [
            ...plan.folders.map((f): ShareAdoptItem => ({ kind: "folder", path: f.path })),
            ...plan.files.map((f): ShareAdoptItem => ({ kind: "file", path: f.path, manifest: f.manifest, key: f.fileId })),
        ];
        const holding = new Set<string>();
        await share.adopt(
            items,
            async (_item, _posted, recordId) => void holding.add(recordId),
            (_item, recordId) => posted.add(recordId),
        );
        return holding;
    }

    /**
     * Delete from `share` each record this flow posted (`posted`) that `plan` no longer has: a file record
     * `keepFile` does not keep (deleted or moved out of the folder, or left at an old path), an empty-folder record
     * whose path is no longer a folder in `plan`. Only the caller's own uploads, and only ids in `posted`, are touched.
     */
    private async takeBackRemoved(
        share: Share,
        plan: SharingPlan,
        posted: PostedLog,
        keepFile: (r: { id: string; path: string }) => boolean,
    ): Promise<void> {
        const earlier = posted.ids();
        if (earlier.size === 0) return;
        const folders = new Set<string>();
        for (const p of [...plan.folders.map((f) => f.path), ...plan.files.map((f) => f.path)]) {
            const segs = p.replace(/^\/+|\/+$/g, "").split("/");
            // Every folder on the way to a planned entry (a folder record there is harmless), and a planned folder.
            for (let i = 1; i < segs.length; i++) folders.add(segs.slice(0, i).join("/"));
        }
        for (const f of plan.folders) folders.add(f.path.replace(/^\/+|\/+$/g, ""));
        const removed = await share.removeAdopted(earlier, (r) => (r.kind === "file" ? keepFile(r) : folders.has(r.path)));
        if (removed.length > 0) {
            const gone = new Set(removed);
            await posted.replace([...earlier].filter((id) => !gone.has(id)));
        }
    }

    private async savePending(spaceId: string, pending: PendingRelease): Promise<void> {
        if (pending.files.length === 0) await this.deps.store.delete(K_PENDING + spaceId).catch(() => {});
        else await this.trySave(K_PENDING + spaceId, pending, "which moved files are still to be let go of");
    }

    /**
     * Let go of the personal reference of each file a `shareFolder` into `spaceId` moved out of the tree - only
     * once the folder it kept is confirmed to be a link to `spaceId` (until then the folder's entries still name
     * that content, and their references keep it stored). Each file once; the list shrinks as it goes, so a
     * repeat never releases one twice. A failed release stays listed for next time: a leak (billed twice) is the
     * worst case, never a loss. True when there was a list for `spaceId` and the swap was confirmed. `known`: the
     * list as this run has it (the stored copy may not have been saved).
     */
    private async drainPending(spaceId: string, known?: PendingRelease): Promise<boolean> {
        const vfs = sharingFor(this);
        const pending = known ?? (await this.readJson<PendingRelease>(K_PENDING + spaceId));
        if (!vfs || !pending || typeof pending.path !== "string" || typeof pending.linkId !== "string" || !Array.isArray(pending.files)) {
            return false;
        }
        // Only the very link the swap wrote: a link to the same share made some other way proves nothing.
        const link = await vfs.readLink(pending.path).catch(() => null);
        if (link?.spaceId !== spaceId || link.linkId !== pending.linkId) return false;
        const left = [...pending.files];
        const failed: PendingRelease["files"] = [];
        let unsaved = 0;
        try {
            while (left.length > 0) {
                const f = left[0];
                try {
                    await vfs.releaseManifest(f.manifest);
                } catch (err) {
                    console.warn("[client.shares] could not let go of a moved file's personal copy (will retry):", err);
                    failed.push(f);
                }
                left.shift();
                if (++unsaved >= RELEASED_SAVE_EVERY) {
                    unsaved = 0;
                    await this.savePending(spaceId, { ...pending, files: [...failed, ...left] });
                }
            }
        } finally {
            await this.savePending(spaceId, { ...pending, files: [...failed, ...left] });
        }
        return true;
    }

    // -- Spaces and keys ------------------------------------------------------

    /**
     * Create a share Space and seed its keeper; returns its id. The keeper's key is read first, so an app without a
     * keeper leaves no Space behind. Created with the default (public) visibility: a private Space gets a
     * membership-log genesis, which a share refuses. The socket the creation opens is closed again: a `Share` works
     * over HTTP.
     */
    private async newSeededSpace(): Promise<string> {
        const pubkey = await this.keeperPubkey();
        if (!pubkey) throw new Error("This app has no keeper, so its shares could not be joined while you are away.");
        const space = await this.deps.spaces.createSpace({ historyPolicy: "static" });
        try {
            if (!space.keyring) throw new Error("Sign in first: a share's group key needs your identity.");
            await space.keyring.admit(KEEPER_MEMBER_ID, pubkey);
            return space.id;
        } finally {
            space.disconnect();
        }
    }

    /** The app keeper's ECDH public key, or null when the app has none (404). */
    private async keeperPubkey(): Promise<string | null> {
        try {
            const { pubkey } = await this.deps.http.get<{ pubkey?: string }>("/api/app/keeper");
            return pubkey || null;
        } catch (err) {
            if (err instanceof HttpError && err.status === 404) return null;
            throw err;
        }
    }

    /** The share's current Space: `spaceId` or where its `closed.successor` chain ends. */
    private async current(spaceId: string): Promise<string> {
        let id = spaceId;
        for (let hops = 0; ; hops++) {
            let info: ShareInfo;
            try {
                info = await this.api.info(id);
            } catch (err) {
                // Moved somewhere this user is not a member of (a new password): say where, so the app can ask.
                if (id !== spaceId && err instanceof HttpError && (err.status === 403 || err.status === 404)) {
                    throw new ShareClosedError("This share moved; join it again with its new password.", id, err.body);
                }
                throw err;
            }
            if (!info.closed) return id;
            if (hops >= MAX_SHARE_SUCCESSOR_HOPS) throw tooManyHops();
            id = info.closed.successor;
        }
    }

    /** A public share's current Space and its pre-admission info (salt, iterations), from `GET /public`. */
    private async currentPublic(spaceId: string, startHops: number): Promise<{ id: string; info: SharePublicInfo }> {
        let id = spaceId;
        for (let hops = startHops; ; hops++) {
            const info = await this.api.publicInfo(id);
            if (!info.closed) return { id, info };
            if (hops >= MAX_SHARE_SUCCESSOR_HOPS) throw tooManyHops();
            id = info.closed.successor;
        }
    }

    /**
     * Make sure the signed-in member holds the share's group key: a key from this device's cache, else a join
     * request (the keeper wraps the key for a member as it lands) and a few pulls. A locked session (no identity)
     * skips this: the share's files do not need the group key. A key that has not arrived yet is not an error.
     */
    private async joinKeys(spaceId: string): Promise<void> {
        const space = await this.deps.spaces.get(spaceId);
        try {
            const keyring = space.keyring;
            if (!keyring) return;
            if ((await keyring.loadFromCache().catch(() => false)) || keyring.hasAnyKey()) return;
            await keyring.requestKey();
            for (let i = 0; i < KEY_PULLS; i++) {
                if ((await keyring.pullKeys().catch(() => 0)) > 0) return;
                if (i < KEY_PULLS - 1) await delay(KEY_PULL_GAP_MS);
            }
        } finally {
            space.disconnect();
        }
    }

    // -- guest accounts -------------------------------------------------------

    /** Signed in already; else this device's guest login; else a new guest account. Finishes a half-done setup. */
    private async ensureSignedIn(deviceLabel: string): Promise<void> {
        if (!this.deps.me()) {
            const saved = await this.readJson<GuestDeviceLogin>(K_LOGIN);
            if (saved) {
                try {
                    await this.deps.auth.loginWithDevice(saved.username, saved.factorId, saved.deviceKey);
                } catch (err) {
                    if (!(err instanceof DeviceRevokedError)) throw err;
                    await this.deps.store.delete(K_LOGIN);
                }
            }
        }
        const me = this.deps.me();
        if (!me) return this.createGuestAccount(deviceLabel);
        await this.unlockSavedGuest();
        // A later visit of an existing account: an unfinished setup step must not block the join.
        await this.finishGuestSetup(me, deviceLabel).catch((err) => {
            // Never the error itself: it carries the guest's recovery code (see `withRecovery`).
            console.warn("[client.shares] finishing the guest account setup failed (will retry):", errorText(err));
        });
    }

    private async createGuestAccount(deviceLabel: string): Promise<void> {
        const { auth } = this.deps;
        // The guest never sees or types this: the device login and the recovery phrase are how they come back.
        const password = base64url(crypto.getRandomValues(new Uint8Array(32)));
        let username = "";
        for (let attempt = 1; ; attempt++) {
            username = `g-${randomBase32(12)}`;
            try {
                await auth.register({ username, password });
                break;
            } catch (err) {
                if ((err as { status?: unknown })?.status !== 409 || attempt >= GUEST_USERNAME_TRIES) throw err;
            }
        }
        // The account exists from here on: mark what is left to do, so a later visit can finish it.
        await this.trySave(K_SETUP, { username, phrase: false, device: false } satisfies GuestSetup, "the guest setup marker");
        await this.trySave(K_RECOVERY, { username }, "the guest recovery flag");
        await this.finishGuestSetup(username, deviceLabel);
    }

    /**
     * Finish the steps of a guest account's setup that are not done: the recovery phrase first (so it can always be
     * shown), then the device login. Each is tried twice. An error carries the recovery when the phrase is known.
     */
    private async finishGuestSetup(username: string, deviceLabel: string): Promise<void> {
        const setup = await this.readJson<GuestSetup>(K_SETUP);
        if (!setup || setup.username !== username) return;
        const { auth } = this.deps;
        try {
            if (!setup.phrase) {
                const phrase = await twice(() => auth.enrollRecoveryPhrase());
                this.recoveryCache = { username, phrase, code: guestRecoveryCode(username, phrase) };
                setup.phrase = true;
                await this.trySave(K_SETUP, setup, "the guest setup marker");
            }
            if (!setup.device) {
                const { factorId, deviceKey } = await twice(() => auth.enrollDevice(deviceLabel));
                if (await this.trySave(K_LOGIN, { username, factorId, deviceKey } satisfies GuestDeviceLogin, "the guest device login")) {
                    setup.device = true;
                }
            }
            if (setup.phrase && setup.device) await this.deps.store.delete(K_SETUP);
            else await this.trySave(K_SETUP, setup, "the guest setup marker");
        } catch (err) {
            throw await this.withRecovery(err);
        }
    }

    /**
     * Best-effort revoke of a replaced guest login's device factor. Revoking needs that account's session, so this
     * signs in as it briefly and then back in as `current` (the guest just restored), whose login is fresh.
     */
    private async revokeReplacedLogin(old: GuestDeviceLogin, current: GuestDeviceLogin): Promise<void> {
        try {
            await this.deps.auth.loginWithDevice(old.username, old.factorId, old.deviceKey);
            await this.deps.auth.revokeDevice(old.factorId);
        } catch (err) {
            if (!(err instanceof DeviceRevokedError)) {
                console.warn("[client.shares] could not revoke the replaced guest login's device factor:", err);
            }
        }
        if (this.deps.me() !== current.username || !this.deps.unlocked()) {
            await this.deps.auth.loginWithDevice(current.username, current.factorId, current.deviceKey);
        }
    }

    /** Delete `key` if its JSON value names `username`. */
    private async deleteIfFor(key: string, username: string): Promise<void> {
        const v = await this.readJson<{ username?: string }>(key);
        if (v?.username === username) await this.deps.store.delete(key);
    }

    /**
     * A session restored without its seed (after a reload) that belongs to this device's guest login: unlock it
     * with the device login, so the setup can be finished and the recovery phrase derived. A revoked login is
     * forgotten; any other failure is warned and leaves the session locked.
     */
    private async unlockSavedGuest(): Promise<void> {
        const me = this.deps.me();
        if (!me || this.deps.unlocked()) return;
        const saved = await this.readJson<GuestDeviceLogin>(K_LOGIN);
        if (saved?.username !== me) return;
        try {
            await this.deps.auth.unlockWithDevice(saved.username, saved.factorId, saved.deviceKey);
        } catch (err) {
            if (err instanceof DeviceRevokedError) await this.deps.store.delete(K_LOGIN);
            else console.warn("[client.shares] could not unlock the guest account with its device login:", err);
        }
    }

    /** `err` with the signed-in guest's unacknowledged recovery attached as `recovery` (see {@link guestRecoveryOf}). */
    private async withRecovery(err: unknown): Promise<unknown> {
        if (!err || typeof err !== "object" || guestRecoveryOf(err)) return err;
        const recovery = await this.pendingRecovery().catch(() => null);
        if (recovery) {
            try {
                Object.defineProperty(err, "recovery", { value: recovery, enumerable: false, configurable: true });
            } catch {
                /* a frozen error: nothing to attach to */
            }
        }
        return err;
    }

    // -- helpers --------------------------------------------------------------

    private async readJson<T>(key: string): Promise<T | null> {
        try {
            const raw = await this.deps.store.get(key);
            return raw ? (JSON.parse(raw) as T) : null;
        } catch {
            return null;
        }
    }

    /** Store `value`; a storage failure is reported (warned) and answered with false, not thrown. */
    private async trySave(key: string, value: unknown, what: string): Promise<boolean> {
        try {
            await this.deps.store.set(key, JSON.stringify(value));
            return true;
        } catch (err) {
            console.warn(`[client.shares] could not keep ${what} on this device:`, err);
            return false;
        }
    }

    private keyring(spaceId: string): KeyringClient {
        return new KeyringClient({
            spaceId,
            httpBaseUrl: this.deps.http.baseUrl,
            fetch: this.deps.http.fetch,
            fetchWithRecovery: this.deps.http.fetchWithRecovery,
        });
    }

    private shareFor(spaceId: string): Share {
        return new Share({ http: this.deps.http, spaceId, me: this.requireMe(), rsWasmModule: this.deps.rsWasmModule });
    }

    private requireMe(): string {
        const me = this.deps.me();
        if (!me) throw new Error("client.shares: sign in first.");
        return me;
    }
}

/**
 * The ids of the records a `shareFolder` run put in one share, as kept in the local store (see {@link K_POSTED}).
 * A failure to keep an id is thrown: the record is then not posted, since a record not noted could not be taken
 * back if its file left the folder before the run is finished.
 */
class PostedLog {
    private constructor(
        private readonly store: SharesLocalStore,
        private spaceId: string,
        private chunks: string[][],
    ) {}

    static async load(store: SharesLocalStore, spaceId: string): Promise<PostedLog> {
        return new PostedLog(store, spaceId, await PostedLog.read(store, spaceId));
    }

    /** Move the list kept for `from` to `to` (a rotated share keeps its record ids). */
    static async move(store: SharesLocalStore, from: string, to: string): Promise<void> {
        const chunks = await PostedLog.read(store, from);
        if (chunks.length === 0) return;
        const log = new PostedLog(store, to, chunks);
        await log.replace(chunks.flat());
        await PostedLog.clear(store, from);
    }

    static async clear(store: SharesLocalStore, spaceId: string): Promise<void> {
        const n = await PostedLog.count(store, spaceId);
        for (let i = 0; i < n; i++) await store.delete(`${K_POSTED}${spaceId}/${i}`);
        await store.delete(K_POSTED + spaceId);
    }

    ids(): Set<string> {
        return new Set(this.chunks.flat());
    }

    async add(id: string): Promise<void> {
        if (this.chunks.some((c) => c.includes(id))) return;
        let last = this.chunks[this.chunks.length - 1];
        if (!last || last.length >= POSTED_CHUNK) {
            last = [];
            this.chunks.push(last);
            await this.store.set(`${K_POSTED}${this.spaceId}/${this.chunks.length - 1}`, JSON.stringify(last.concat(id)));
            await this.store.set(K_POSTED + this.spaceId, JSON.stringify({ chunks: this.chunks.length }));
        } else {
            await this.store.set(`${K_POSTED}${this.spaceId}/${this.chunks.length - 1}`, JSON.stringify(last.concat(id)));
        }
        last.push(id);
    }

    async replace(ids: string[]): Promise<void> {
        const before = this.chunks.length;
        const chunks: string[][] = [];
        for (let i = 0; i < ids.length; i += POSTED_CHUNK) chunks.push(ids.slice(i, i + POSTED_CHUNK));
        for (let i = 0; i < chunks.length; i++) await this.store.set(`${K_POSTED}${this.spaceId}/${i}`, JSON.stringify(chunks[i]));
        await this.store.set(K_POSTED + this.spaceId, JSON.stringify({ chunks: chunks.length }));
        for (let i = chunks.length; i < before; i++) await this.store.delete(`${K_POSTED}${this.spaceId}/${i}`);
        this.chunks = chunks;
    }

    async clear(): Promise<void> {
        await PostedLog.clear(this.store, this.spaceId);
        this.chunks = [];
    }

    private static async count(store: SharesLocalStore, spaceId: string): Promise<number> {
        try {
            const meta = JSON.parse((await store.get(K_POSTED + spaceId)) ?? "null") as { chunks?: unknown } | null;
            const n = meta?.chunks;
            return typeof n === "number" && Number.isInteger(n) && n > 0 && n < 1_000_000 ? n : 0;
        } catch {
            return 0;
        }
    }

    private static async read(store: SharesLocalStore, spaceId: string): Promise<string[][]> {
        const n = await PostedLog.count(store, spaceId);
        const chunks: string[][] = [];
        for (let i = 0; i < n; i++) {
            let chunk: unknown = null;
            try {
                chunk = JSON.parse((await store.get(`${K_POSTED}${spaceId}/${i}`)) ?? "null");
            } catch {
                /* unreadable: treated as empty */
            }
            chunks.push(Array.isArray(chunk) ? chunk.filter((x): x is string => typeof x === "string") : []);
        }
        return chunks;
    }
}

/** Whether a rotation request asks for exactly what `p` does (same removal list; the password `p` verifies). */
async function sameRotation(p: PendingRotation, req: RotationRequest): Promise<boolean> {
    const a = [...(p.remove ?? [])].sort();
    const b = [...(req.remove ?? [])].sort();
    if (a.length !== b.length || a.some((u, i) => u !== b[i])) return false;
    if (!req.password) return !p.password;
    if (!p.password) return false;
    const proof = await passwordProof(req.password, p.password.salt, p.password.iterations);
    const bytes = Uint8Array.from(atob(proof), (c) => c.charCodeAt(0));
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
    return btoa(String.fromCharCode(...digest)) === p.password.verifier;
}

/**
 * An error as text for a log line: its name and message only. An error from `client.shares` may carry a guest's
 * recovery code as `recovery`, and a logged error object shows its properties (a browser console shows even
 * non-enumerable ones), so the object itself is never logged.
 */
function errorText(err: unknown): string {
    if (err instanceof Error) return `${err.name}: ${err.message}`;
    return typeof err === "string" ? err : "unknown error";
}

function trimSlashes(p: string): string {
    return p.replace(/^\/+|\/+$/g, "");
}

/** Network failures and server errors are worth repeating; a 4xx answer is not. */
function retryable(err: unknown): boolean {
    return !(err instanceof HttpError) || err.status >= 500;
}

async function twice<T>(fn: () => Promise<T>): Promise<T> {
    try {
        return await fn();
    } catch {
        return fn();
    }
}

/** The admission `name` rule (server: 1–40 characters after trimming, no C0/DEL characters). */
function displayName(raw: string): string {
    const name = (raw ?? "").trim();
    // eslint-disable-next-line no-control-regex
    if (name.length < 1 || name.length > 40 || /[\u0000-\u001f\u007f]/.test(name)) {
        throw new Error("A name must be 1 to 40 characters, with no control characters.");
    }
    return name;
}

/** Throw {@link ShareFullError} when `plan`'s folder would not fit under `limitBytes`. */
function refuseOverLimit(plan: SharingPlan, limitBytes: number | null, usedBytes: number): void {
    if (limitBytes === null || plan.bytes <= limitBytes) return;
    throw new ShareFullError(
        `${plan.path} holds ${plan.bytes} bytes, more than the share's limit of ${limitBytes}; nothing was moved.`,
        limitBytes,
        usedBytes,
        plan.files.length,
    );
}

/** A random VFS entry id (`[A-Za-z0-9_-]`, 22 characters) for the link a swap writes. */
function newLinkId(): string {
    return base64url(crypto.getRandomValues(new Uint8Array(16)));
}

function tooManyHops(): Error {
    return new Error(`This share moved more than ${MAX_SHARE_SUCCESSOR_HOPS} times; open its newest link instead.`);
}

function currentPage(): string | null {
    const loc = (globalThis as { location?: { origin?: string; pathname?: string } }).location;
    return loc?.origin && loc.origin !== "null" ? `${loc.origin}${loc.pathname ?? "/"}` : null;
}

function randomBase32(n: number): string {
    // 32 divides 256, so masking a random byte is unbiased.
    return Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => BASE32[b & 31]).join("");
}

function base64url(bytes: Uint8Array): string {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}
