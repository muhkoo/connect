# BS — Refusals for Payment in the SDK Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give connect `client.app.access()` and `PaymentRequiredError`, keep offline writes the accelerator refuses for payment, let uploads and commits re-establish a stale session, and stop `client.vfs` creating its content space to take or drop a reference.

**Architecture:** One new error class, `PaymentRequiredError extends HttpError`, is built by one internal function, `paymentRequiredFrom(status, body)`, from a 402 whose body carries one of three codes. `HttpClient.request`, `ShardClient`, `SharedSpaceClient` and `PersonalSpaceClient` throw it where they threw `HttpError` or a plain `Error` before. `HttpError` moves to its own module so the two classes do not import each other. The offline queue keeps an entry refused with it, with everything after it, stops, and says so on `SYNC_ERROR`; it stamps each entry with its user's commitment and sends only the signed-in user's, so a kept write never goes out under the next user's session; `client.app.access()` asks `GET /api/app/access` and, on each "allowed", calls the new `client.offline.resume()`, which drains once if anything of the signed-in user's is queued. `ShardClient` sends its PUT through `HttpClient.fetchWithRecovery`, as `KeyringClient` already does, and every place that builds one passes it. The commit and release body moves out of `Space` into one helper, `commitManifest`, which `Space` and the `client.vfs` content adapter both call; the adapter no longer opens the content space to do it (the D12 mechanism).

**Tech Stack:** TypeScript (strict, ESNext), Vitest 4 (node environment, `fake-indexeddb`), rollup (the three builds and the two `.d.ts` files), npm pack for the tarball check.

**Spec:** `/Users/matt/GitHub/muhkoo/accelerator/docs/superpowers/specs/2026-10-06-paid-accounts-and-past-due-design.md` (decisions D1–D14 by Matt, 2026-10-06). This plan implements section B8 and the connect half of D12's mechanism, as resolved before planning. It is plan **BS**, one of five: A (Cloud Drive hosted sign-in) → B (accelerator platform) → B-portal and BS → C (Cloud Drive screens).

## Cross-plan contracts

The names, codes, routes and shapes below are shared with plans B, B-portal and C. They are copied from the spec's "Interfaces and contracts" and from the D12 resolution. Where the spec left a choice open, the choice made here is listed last.

**What BS consumes, from plan B (accelerator).** Nothing from plan A.
- `GET /api/app/access`, app key plus session, never gated, never metered → `200 { paidAccountsOnly: boolean, allowed: boolean, reason?: "user_plan_required" | "user_payment_past_due" | "owner_payment_past_due", upgradeUrl?: string }`. `upgradeUrl` is an absolute portal URL, set only for the two `user_*` reasons. 401 without a session.
- The 402 refusal: `{ "error": "<sentence>", "code": "user_plan_required" | "user_payment_past_due" | "owner_payment_past_due", "upgradeUrl"?: "<absolute portal URL>" }`. Today's quota 402s keep their relative `upgradeUrl` and carry no `code`.
- The 401 on a gated write without a valid session: `{ "error": "…", "code": "session_required" }`. BS treats it as any other 401: one silent re-authentication, then one retry.
- Unchanged and never gated: `POST /api/storage/commit` and `/api/storage/release` with body `{ hashes, bytes }`; reads; deletes.
- BS can be built and released before plan B is deployed. Against an older accelerator the mapping never fires, and `client.app.access()` throws `HttpError` 404.

**What BS produces, for plan C (Cloud Drive), and for B-portal if it moves the portal onto this connect.**
- `client.app.access(): Promise<AppAccess>`, with `interface AppAccess { paidAccountsOnly: boolean; allowed: boolean; reason?: PaymentRequiredCode; upgradeUrl?: string }`. Each answer with `allowed: true` also calls `client.offline.resume()`, without waiting for it.
- `class PaymentRequiredError extends HttpError`: `name` `"PaymentRequiredError"`, `status` `402`, `code: PaymentRequiredCode`, `upgradeUrl?: string`, `body` (the parsed JSON), `message` (the server's `error`, else `Payment required (<code>)`).
- `type PaymentRequiredCode = "user_plan_required" | "user_payment_past_due" | "owner_payment_past_due"`.
- All three exported from `@muhkoo/connect` (browser and Node builds); `PaymentRequiredError` and `PaymentRequiredCode` from the workers build too.
- Where it is thrown: the JSON helpers of `HttpClient`, so `client.kv`, `client.db`, the store under `client.vfs` and `client.vcs`, and `client.space.createSpace`; `ShardClient.putShard`, so `client.vfs.writeFile`, `client.storage.writeFile`, `Space.putFile` and room files; `SharedSpaceClient`; `PersonalSpaceClient`. `client.vfs` passes it through unwrapped (Task 1 pins this for `mkdir` and a first `writeFile`).
- The offline queue keeps an entry refused with it, emits `SYNC_ERROR` with `{ domain, method, error, code, dropped: false }`, and stops. `client.offline.resume(): Promise<void>` drains once if anything of the signed-in user's is queued. A queued entry is sent only under the session of the user who queued it (Choice 10): after a sign-out and a sign-in as someone else in the same tab (plan C's Review Focus 5), the first user's kept writes stay queued and are not sent.
- What a stopped drain looks like, and the staleness window, for plan C to take note of; neither changes a name above. The sync still emits `SYNC_COMPLETE` and sets the status to `online` while kept entries wait (`SyncEngine.ts:63-65`); only the `SYNC_ERROR` with `dropped: false` tells them apart, so an app must not call `access()` from a `SYNC_COMPLETE` handler. For about a minute after a payment, `access()` can answer allowed while the data path still refuses (spec Risks, Staleness); the drain that answer starts is refused again, and BS does not retry on a timer (D8: never in a loop), so the kept writes wait for the next reconnect or the next allowed answer. Plan C stops asking once allowed (its Decision 3); it can ask once more about a minute later while `client.offline.queue.waiting()` is not empty, or accept the wait.
- The D12 mechanism, connect half: `client.vfs`'s `retain` and `release` post `/api/storage/commit|release` directly, through `fetchWithRecovery`, and never create the content space or write `vfs/space`. `writeManifest`, `retainManifest`, a `client.vcs` checkout and a delete therefore make no `/api/spaces/*` request. The first `write` of new bytes still creates the space. Plan C's migration client relies on this.
- `ShardClientOptions.fetchWithRecovery?` and `SpaceDeps.fetchWithRecovery?`: optional, additive.
- Unchanged, and relied on by plan C's migration client: `HttpClient` sets `X-Muhkoo-Key` and `X-Muhkoo-Session` before it calls a custom `fetch` (`HttpClient.ts:128-141`), so a wrapper can remove the key for `/api/personal/` paths. BS does not touch that code.
- Release: none here. The connect release after 0.15.0-alpha.4 is a production step, on Matt's ask (see the last section). Until then plan C can check its staging build against this plan's tarball (Task 7, Step 7), as W1 Task 8 did.

**Choices made where the spec is ambiguous or silent.**
1. **D12's connect change lives in BS.** The D12 resolution says "plan B must contain: connect (ship it in the same release as B8)". BS is the only connect plan, so it is Task 5 here. Plan B should not also edit connect.
2. **The error's module.** `HttpError` moves, verbatim, to `src/core/HttpError.ts`, and `HttpClient.ts` re-exports it. `PaymentRequiredError` lives in `src/core/PaymentRequiredError.ts`. With both classes in `HttpClient.ts`, the module that maps 402s and the module that defines the subclass would import each other.
3. **`message`** is the server's `error` sentence, or `Payment required (<code>)` without one, at every site, so an app can show it.
4. **`upgradeUrl`** is kept only when it is an absolute `http(s)` URL with a host, on the error and on `AppAccess`. A relative path, a `javascript:` URL or a protocol-relative URL is dropped.
5. **`client.app.access()` reads a missing `allowed` as allowed** (fail open, as D4 does on the server, which enforces the gate whatever this says). It drops a `reason` that is not one of the three codes. It throws `HttpError` on any non-2xx, after the usual one re-authentication on a 401.
6. **"Tries again when `client.app.access()` reports allowed"** is `client.offline.resume()`: one drain per "allowed" answer, and none when nothing is queued, so an app that calls `access()` on every `focus` causes no "syncing" flicker and no request.
7. **The kept entry's event** reuses `SYNC_ERROR`, whose payload already has `dropped`, with `dropped: false` and the `code`. No app in the tree listens to `SYNC_ERROR` today (checked: cloud-drive, ide, web).
8. **Not mapped in v1:** the WebSocket refusal frame (`{ error, code: "owner_payment_past_due" }`, spec B2), `KeyringClient` (plain `Error`s; the D12 answer's Q8 suggests plan B gate `/keyring/wrap`), and `client.functions.invoke`, which returns the raw `Response`. Cloud Drive uses none of them.
9. **Not in this plan:** releasing a manifest whose commit landed but whose directory entry was refused (spec Risks, "Commit accepted, entry refused"). The spec leaves it to a later connect follow-up.
10. **A kept write waits for its own user. Accepted by Matt on 2026-10-08.** The queue is one IndexedDB store per origin, and every replayer builds its request from whoever is signed in when it runs. Kept after a refusal for payment, a write can outlive its user's session, and the next drain would send it as the next user to sign in on that device (Task 2 has the detail). The spec is silent. Chosen: `OutboundQueue.enqueue` stamps each entry with the signed-in commitment (an optional field, `QueueEntry.commitment?`), and a drain sends only the signed-in user's entries, leaving the others queued, untouched and in order. That keeps D8's "kept: not dropped". Not chosen: dropping kept entries at sign-out, which loses a write that the user's payment would let through, and is the opposite of D8; or putting the commitment inside `args`, which is each domain's own data and which the queue never reads. Entries an older SDK queued carry no stamp and are sent by any drain, as before.
11. **Background uploads refused for payment.** In background-upload mode `ShardClient` keeps sending the remaining shard PUTs of a file after the first refusal, each refused and then queued. It is bounded by the file's size, not a loop, and Cloud Drive does not use background uploads; no change in v1.

## Global Constraints

- **Code changes: connect only** (`/Users/matt/GitHub/muhkoo/connect`). The accelerator, portal and cloud-drive are only read. Nothing is deployed anywhere.
- **Commits:** Matt makes every commit. Each task ends in a **checkpoint**, never a commit. Never run `git add`, `git commit` or `git stash`, in any repo.
- **Formatting:** never run `prettier --write`. connect uses 4-space indentation and double quotes in `src/` and in every file this plan creates. Match the surrounding style by hand.
- **Public API, added on purpose (spec B8).** `api-surface.txt` gains exactly `T AppAccess`, `T AppNamespaceDeps`, `T PaymentRequiredCode`, `V AppNamespace` and `V PaymentRequiredError`; `api-surface.workers.txt` gains exactly `T PaymentRequiredCode` and `V PaymentRequiredError`. Nothing else appears or disappears. `paymentRequiredFrom`, `isPaymentRequiredCode`, `absoluteHttpUrl` and `commitManifest` stay internal: no barrel star-exports their modules.
- **Additive shape changes only:** `Client.app`, `OfflineManager.resume()`, `OutboundQueue.waiting()`, `QueueEntry.commitment?`, `ShardClientOptions.fetchWithRecovery?`, `SpaceDeps.fetchWithRecovery?`, and the `code` and `dropped: false` on a `SYNC_ERROR` for a kept entry. `HttpError` keeps its name, constructor and fields.
- **Wire contracts, verbatim from the spec:** the three code strings `user_plan_required`, `user_payment_past_due`, `owner_payment_past_due`; `GET /api/app/access`; the 402 body `{ error, code, upgradeUrl? }`; the commit and release body `{ hashes, bytes }`, which must not change (Task 5 pins it).
- **No persisted format change, except one optional field:** a queue entry gains `commitment?` (Task 2, Choice 10). Entries without it, written by an older SDK, are read and sent as before, and an older SDK ignores the field, so it needs no migration. The IndexedDB schema (`DB_VERSION`, stores, key paths), `vfs/space` and every `vfs/` key stay as they are.
- **Suites:** the full `yarn test:unit`, `yarn typecheck` (0 errors) and `npx eslint` on every file a task touches (no new warning) stay green after every task. That includes `tests/api/export-surface.test.ts`. `yarn typecheck` checks `src/` only: `tsconfig.json` excludes `tests` and `**/*.test.ts`, and Vitest strips types without checking them. So every "`tsc` exits 0" below is about `src/`, and the new tests' casts (`as never`, `as unknown as`) are not type-checked.
- **The tree is not clean, so compare against Task 0's snapshot, never against git.** connect already has about 100 modified or untracked files, among them `CHANGELOG.md`, `src/core/Client.ts`, `src/core/HttpClient.ts`, `src/offline/OutboundQueue.ts`, `src/spaces/Space.ts`, `src/storage/transport/ShardClient.ts` and `api-surface.txt`. Every checkpoint runs Task 0's `changed.sh`.
- **CHANGELOG:** edit only `## Unreleased`, which is empty today. 0.15.0-alpha.4 was published on 2026-10-06; everything from `## 0.15.0-alpha.4` down stays byte-identical.
- **No release, no publish.** `package.json` stays `0.15.0-alpha.4`. `npm run release` (connect or cli) is production and happens only when Matt asks for it in that message. Never `npm publish`.
- **Production and staging:** this plan deploys nothing. Production of any kind happens only on Matt's explicit ask, each time; a permission given earlier does not carry forward.
- **Credentials:** only Task 9's optional staging check needs any. The test account comes from the environment only, as `MUHKOO_USER` and `MUHKOO_PASSWORD`, never written to a file, a script or a logged command line. Never print a key or token.

## Review Focus

These are the inputs and conditions the spec implies but its listed tests do not exercise, most likely first. Each has its test in the owning task.

1. **A kept write under the device-wide drain lock.** In a browser the drain repeats its pass while the queue is not empty; a kept write leaves it not empty. Expect the drain to stop after one refusal, not to ask the server again at once and forever. Pinned in Task 2 by "does not loop when the drain holds the device-wide lock" (with a 2-second limit, so a loop fails instead of hanging).
2. **A delete queued behind a refused upload.** Expect the delete to wait, in order, and both to go once the app is allowed, each exactly once. Pinned in Task 2 by "keeps a refused upload and the delete queued after it, which waits behind it" and "sends them, in order, on the next drain once the server accepts them", and end to end in Task 6 by "sends a write the queue kept after a refusal for payment once the app is allowed again".
3. **A Free user's permanent delete in a drive that has no content space yet** (every unmigrated Cloud Drive user). Expect the release to go out without creating the space, which the gate would refuse. Pinned in Task 5 by "a delete lets go of its file without creating the content space".
4. **`client.app.access()` on every `focus` and `visibilitychange`.** Expect a drain only on "allowed" and only when something is queued, no "syncing" otherwise, and no unhandled rejection when that drain fails. Pinned in Task 6 by "asks the offline queue to send its kept writes each time the answer is allowed, and only then" and "answers even when sending the kept writes fails, and leaves no rejection unhandled", and in Task 2 by "does nothing when nothing is waiting".
5. **Two users on one device.** A Free user's write is kept; they sign out on the upgrade screen, and a paid account signs in in the same tab (plan C's Review Focus 5). Expect the first user's write to stay queued, not to be sent as the second user, and to go out when the first user is back. Pinned in Task 2 by "never sends one user's kept write under another user's session…", "does not loop over another user's writes…" and "does nothing when only another user's writes are waiting", and end to end in Task 6 by "never sends a kept write under the next user's session after a sign-out and sign-in in the same tab".
6. **A `reason` or `upgradeUrl` that is not what the contract says** (a code from a newer server, a relative path, a `javascript:` URL). Expect it never to reach an app's link or its screen choice. Pinned in Task 1 by "leaves upgradeUrl unset when the server sends …" and "keeps a 402 with a code it does not know a plain HttpError", and in Task 6 by "drops a reason it does not know and a link that is not an absolute http(s) URL".

## File Structure

| File | Task | Responsibility |
|---|---|---|
| scratchpad `bs-baseline/` (create, not in a repo) | 0 | The snapshot every checkpoint compares against, and `changed.sh` |
| `src/core/HttpError.ts` (create) | 1 | `HttpError`, moved verbatim from `HttpClient.ts` |
| `src/core/PaymentRequiredError.ts` (create) | 1 | `PaymentRequiredError`, `PaymentRequiredCode`, and the internal `paymentRequiredFrom`, `isPaymentRequiredCode`, `absoluteHttpUrl` |
| `src/core/HttpClient.ts` (modify) | 1 | Re-exports `HttpError`; `request` throws `PaymentRequiredError` for the three codes |
| `src/offline/OutboundQueue.ts`, `src/offline/OfflineManager.ts`, `src/offline/store/OfflineStore.ts` (modify) | 2 | Keep refused-for-payment entries and stop; send each entry only under its own user's session; `resume()` |
| `src/storage/transport/ShardClient.ts` (modify) | 3, 4 | Maps the 402 on both PUTs; sends PUTs through `fetchWithRecovery` |
| `src/storage/transport/SharedSpaceClient.ts`, `src/personal/PersonalSpaceClient.ts` (modify) | 3 | Map the 402 |
| `src/spaces/Space.ts` (modify) | 4, 5 | `SpaceDeps.fetchWithRecovery`; uploads and commits through it; commits through `commitManifest` |
| `src/core/namespaces/SpaceNamespace.ts`, `MessageNamespace.ts`, `FileNamespace.ts` (modify) | 4 | Pass `fetchWithRecovery` where they build a `Space` or a `ShardClient` |
| `src/storage/transport/storageCommit.ts` (create) | 5 | `commitManifest`: the commit and release request, shared |
| `src/core/Client.ts` (modify) | 4, 5, 6 | The replay's `ShardClient`; the VFS adapter's `retain` and `release`; `client.app` |
| `src/core/namespaces/AppNamespace.ts` (create) | 6 | `client.app.access()` |
| `src/api.ts`, `src/api.universal.ts`, `tests/api/export-surface.test.ts`, `api-surface.txt`, `api-surface.workers.txt` (modify) | 7 | The public surface |
| `CHANGELOG.md` (modify) | 8 | `## Unreleased` only |
| `tests/core/payment-required.test.ts` (create) | 1, 3 | The mapping at every site; `client.vfs` passes it through |
| `tests/offline/payment-refused.test.ts` (create) | 2 | The queue keeps, stops, does not loop, and sends each user's writes only under their session; `resume()` |
| `tests/storage/shard-session-recovery.test.ts` (create) | 4 | PUTs with a stale session, at every construction site |
| `tests/storage/storage-commit.test.ts` (create) | 5 | The commit body; `Space` commits with a stale session |
| `tests/client/vfs-references.test.ts` (create) | 5 | D12: references without the content space |
| `tests/client/app-access.test.ts` (create) | 6 | `client.app.access()` and the replay on "allowed" |

---

### Task 0: Re-base check and a snapshot of the working tree

connect's tree is not clean, and several files this plan edits already carry other uncommitted work. No checkpoint can ask git what BS changed, so each one compares against this snapshot.

`<scratchpad>` below means the executing session's scratchpad directory. Use its absolute path.

**Files:**
- Create, in the scratchpad only: `<scratchpad>/bs-baseline/`, holding `dirty.sha`, `CHANGELOG.md`, `released.before` and `changed.sh`.
- Nothing in any repo changes.

- [ ] **Step 1: Confirm the version this plan is based on.**

Run: `cd /Users/matt/GitHub/muhkoo/connect && node -p "require('./package.json').version" && npm view @muhkoo/connect dist-tags && grep -n -m 2 "^## " CHANGELOG.md && sed -n '/^## Unreleased/,/^## 0/p' CHANGELOG.md`

Expected:
- `0.15.0-alpha.4`, then `{ latest: '0.15.0-alpha.4', alpha: '0.15.0-alpha.4' }`;
- the first two headings are `15:## Unreleased` and `17:## 0.15.0-alpha.4 — Writes across tabs that can't overwrite each other (2026-10-06)`;
- nothing but one blank line between them: `## Unreleased` is empty.

If any of these differs, connect has moved on. Stop and re-base the plan before Task 1: Task 8's anchor and the Production section name `0.15.0-alpha.4`.

- [ ] **Step 2: Take the snapshot.** Run, as one block:

```bash
B=<scratchpad>/bs-baseline
mkdir -p "$B" && cd /Users/matt/GitHub/muhkoo/connect
git ls-files -m -o --exclude-standard -z | xargs -0 shasum -a 256 | sort -k 2 > "$B/dirty.sha"
cp CHANGELOG.md "$B/CHANGELOG.md"
sed -n '/^## 0\.15\.0-alpha\.4 /,$p' CHANGELOG.md > "$B/released.before"
ls src/core/HttpError.ts src/core/PaymentRequiredError.ts src/core/namespaces/AppNamespace.ts src/storage/transport/storageCommit.ts tests/core/payment-required.test.ts tests/storage/shard-session-recovery.test.ts tests/storage/storage-commit.test.ts tests/client/vfs-references.test.ts tests/offline/payment-refused.test.ts tests/client/app-access.test.ts 2>&1 | grep -c "No such file"
wc -l < "$B/dirty.sha"
```

Expected: `10`, because none of the files BS creates exists yet. Then about 103: 102 modified or untracked files on 2026-10-06, plus this plan.

- [ ] **Step 3: Write `<scratchpad>/bs-baseline/changed.sh`.**

```sh
#!/bin/sh
# What BS has changed in connect so far: every file whose content differs from
# the Task 0 snapshot (changed, created or removed since), then whether the
# released CHANGELOG sections are still byte-identical. Reads only.
B=$(cd "$(dirname "$0")" && pwd)
cd /Users/matt/GitHub/muhkoo/connect || exit 2
git ls-files -m -o --exclude-standard -z | xargs -0 shasum -a 256 | sort -k 2 > "$B/now.sha"
diff "$B/dirty.sha" "$B/now.sha" | sed -n 's/^[<>] [0-9a-f]*  //p' | sort -u
if sed -n '/^## 0\.15\.0-alpha\.4 /,$p' CHANGELOG.md | cmp -s - "$B/released.before"; then
    echo "released CHANGELOG sections: unchanged"
else
    echo "released CHANGELOG sections: CHANGED"
fi
```

Run: `sh <scratchpad>/bs-baseline/changed.sh`

Expected: one line, `released CHANGELOG sections: unchanged`, and no file names.

At every checkpoint below, `changed.sh` lists exactly the files the tasks so far have named, plus this plan file once its checkboxes are ticked. Any other file is a change BS did not plan: stop and report it. `released CHANGELOG sections: CHANGED` means a released section was edited: restore it from `<scratchpad>/bs-baseline/CHANGELOG.md` by hand, keeping the `## Unreleased` additions.

- [ ] **Step 4: Baseline of the suites.** Run: `cd /Users/matt/GitHub/muhkoo/connect && yarn test:unit 2>&1 | grep -E "Test Files|Tests " && yarn typecheck 2>&1 | tail -1`

Expected, on 2026-10-06: `82 passed (82)` and `1136 passed (1136)`, then `Done`. (`dist/` is present in the repo, so the 5 export-surface artifact tests run; without it they are skipped.) Record the numbers; later steps compare against them.

---

### Task 1: `PaymentRequiredError`, and the 402 mapping in `HttpClient`

**Files:**
- Create: `src/core/HttpError.ts`, `src/core/PaymentRequiredError.ts`
- Modify: `src/core/HttpClient.ts:21-23` (imports), `:82-92` (the `HttpError` class), `:227` (the throw in `request`)
- Test: `tests/core/payment-required.test.ts` (create)

**Interfaces:**
- Consumes: `HttpClient` and its `request` (`get`/`post`/`patch`/`del`), unchanged otherwise.
- Produces, used by Tasks 2, 3, 6 and 7:
  - `class HttpError extends Error { constructor(message: string, readonly status: number, readonly body?: unknown) }`, now in `src/core/HttpError.ts`, still exported from `src/core/HttpClient.ts`;
  - `type PaymentRequiredCode = "user_plan_required" | "user_payment_past_due" | "owner_payment_past_due"`;
  - `class PaymentRequiredError extends HttpError { readonly code: PaymentRequiredCode; readonly upgradeUrl?: string; constructor(message: string, code: PaymentRequiredCode, body?: unknown, upgradeUrl?: string) }`;
  - `function isPaymentRequiredCode(value: unknown): value is PaymentRequiredCode`;
  - `function absoluteHttpUrl(url: unknown): string | undefined`;
  - `function paymentRequiredFrom(status: number, body: unknown): PaymentRequiredError | null`. `body` is parsed JSON or raw text.

- [ ] **Step 1: Write the failing test.**

Create `tests/core/payment-required.test.ts`:

```ts
/**
 * Refusals for payment (accelerator spec 2026-10-06-paid-accounts-and-past-due, B8). A 402 whose body
 * carries one of three codes is a `PaymentRequiredError`, wherever the SDK reads an accelerator
 * response. Every other error stays what it was.
 */
import { describe, it, expect } from "vitest";
import { HttpClient, HttpError } from "../../src/core/HttpClient";
import { Client } from "../../src/core/Client";
import { SessionState } from "../../src/core/Session";
import { PaymentRequiredError, type PaymentRequiredCode } from "../../src/core/PaymentRequiredError";

const BASE_URL = "http://localhost:8787";
const PORTAL = "https://portal.staging.muhkoo.dev/upgrade?return=https%3A%2F%2Fcloud-drive.apps.staging.muhkoo.dev";
// The wire contract, spelled out: these strings are shared with the accelerator, the portal and Cloud Drive.
const CODES: PaymentRequiredCode[] = ["user_plan_required", "user_payment_past_due", "owner_payment_past_due"];

/** A response with `status` and `body`, sent as JSON unless it is a string. */
function reply(status: number, body: unknown): Response {
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

/** A fetch that answers every request with `status` and `body`. */
function answering(status: number, body: unknown): typeof fetch {
    return (async () => reply(status, body)) as unknown as typeof fetch;
}

/** What a promise rejected with, or "resolved". */
function failure(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(() => "resolved", (err: unknown) => err);
}

const http = (fetchFn: typeof fetch) => new HttpClient({ baseUrl: BASE_URL, getSessionToken: () => "tok", fetch: fetchFn });

describe("HttpClient — refusals for payment", () => {
    it.each(CODES)("throws PaymentRequiredError for a 402 with code %s, with the server's sentence and link", async (code) => {
        const body = { error: "Cloud Drive is for paid Muhkoo plans.", code, upgradeUrl: PORTAL };
        const err = await failure(http(answering(402, body)).post("/api/personal/c/kv/k", { value: 1 }));
        expect(err).toBeInstanceOf(PaymentRequiredError);
        expect(err).toBeInstanceOf(HttpError);
        expect(err).toMatchObject({ name: "PaymentRequiredError", status: 402, code, upgradeUrl: PORTAL, body });
        expect((err as Error).message).toBe("Cloud Drive is for paid Muhkoo plans.");
    });

    it.each([
        ["quotaExceeded", { error: "KV write quota exceeded for the free tier — upgrade to continue", quotaExceeded: true, metric: "kv_write", upgradeUrl: "/api/developer/billing/checkout" }],
        ["requiresPaidTier", { error: "Serverless functions require a paid plan", requiresPaidTier: true, tier: "free", upgradeUrl: "/api/developer/billing/checkout" }],
        ["freeTierFull", { error: "The free tier is full", freeTierFull: true }],
        ["a code it does not know", { error: "Refused", code: "some_future_code" }],
    ])("keeps a 402 with %s a plain HttpError", async (_label, body) => {
        const err = await failure(http(answering(402, body)).post("/api/db/notes", {}));
        expect(err).toBeInstanceOf(HttpError);
        expect(err).not.toBeInstanceOf(PaymentRequiredError);
        expect(err).toMatchObject({ status: 402, body, message: body.error });
    });

    it("maps only a 402: a 403 carrying a payment code stays a plain HttpError", async () => {
        const err = await failure(http(answering(403, { error: "Forbidden", code: "user_plan_required" })).get("/api/app/access"));
        expect(err).toBeInstanceOf(HttpError);
        expect(err).not.toBeInstanceOf(PaymentRequiredError);
        expect(err).toMatchObject({ status: 403 });
    });

    it("keeps a 402 without a JSON body a plain HttpError", async () => {
        const err = await failure(http(answering(402, "Payment Required")).post("/api/shards/x", {}));
        expect(err).toBeInstanceOf(HttpError);
        expect(err).not.toBeInstanceOf(PaymentRequiredError);
    });

    it.each([
        ["a relative path", "/api/developer/billing/checkout"],
        ["a script URL", "javascript:alert(1)"],
        ["a protocol-relative URL", "//portal.example/upgrade"],
        ["a number", 7],
    ])("leaves upgradeUrl unset when the server sends %s", async (_label, upgradeUrl) => {
        const err = await failure(http(answering(402, { error: "Upgrade", code: "user_plan_required", upgradeUrl })).post("/x", {}));
        expect(err).toBeInstanceOf(PaymentRequiredError);
        expect((err as PaymentRequiredError).upgradeUrl).toBeUndefined();
    });

    it("names the code when the server sends no sentence", async () => {
        const err = await failure(http(answering(402, { code: "owner_payment_past_due" })).post("/x", {}));
        expect(err).toBeInstanceOf(PaymentRequiredError);
        expect(err).toMatchObject({ code: "owner_payment_past_due", message: "Payment required (owner_payment_past_due)" });
    });
});

describe("client.vfs — a refusal for payment reaches the app as it came", () => {
    /** A drive whose accelerator refuses every new personal-KV key and every new Space, as a paid-only app does for a Free user. */
    async function refusingDrive(): Promise<Client> {
        const kv = new Map<string, unknown>();
        const refusal = { error: "Cloud Drive is for paid Muhkoo plans.", code: "user_plan_required", upgradeUrl: PORTAL };
        const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = new URL(String(input));
            const key = url.pathname.match(/^\/api\/personal\/[^/]+\/kv\/([^/]+)(\/get)?$/);
            if (key && key[2]) return reply(200, { value: kv.get(decodeURIComponent(key[1])) ?? null });
            if (key || url.pathname.endsWith("/metadata")) return reply(402, refusal);
            return reply(200, { ok: true });
        }) as typeof fetch;
        const client = new Client({ baseUrl: BASE_URL, apiKey: "mk_test_pk_x", fetch: fetchFn, offline: { enabled: false } });
        const session = (client as unknown as { session: SessionState }).session;
        await session.setSession({ token: "tok", username: "alice", commitment: "c-alice" });
        session.setSeed(new Uint8Array(32).fill(5));
        return client;
    }

    it("a new folder refused for payment throws PaymentRequiredError, not a VFS error", async () => {
        const err = await failure((await refusingDrive()).vfs.mkdir("/Drive"));
        expect(err).toBeInstanceOf(PaymentRequiredError);
        expect(err).toMatchObject({ code: "user_plan_required", upgradeUrl: PORTAL });
    });

    it("a first upload refused for payment (its content space) throws PaymentRequiredError", async () => {
        const err = await failure((await refusingDrive()).vfs.writeFile("/a.txt", "hi"));
        expect(err).toBeInstanceOf(PaymentRequiredError);
        expect(err).toMatchObject({ code: "user_plan_required" });
    });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `cd /Users/matt/GitHub/muhkoo/connect && npx vitest --run tests/core/payment-required.test.ts`

Expected: FAIL, the suite does not load: `Error: Cannot find module '../../src/core/PaymentRequiredError'`.

- [ ] **Step 3: Move `HttpError` to its own module.**

Create `src/core/HttpError.ts`:

```ts
/**
 * `HttpError` — thrown for any non-2xx accelerator response.
 *
 * In a module of its own so that `PaymentRequiredError` can extend it while
 * `HttpClient`, which throws both, imports `PaymentRequiredError`: with the
 * class in `HttpClient.ts`, the two modules would import each other, and
 * whichever loaded second would extend a class not yet defined. `HttpClient`
 * re-exports it, so `import { HttpError } from "./HttpClient"` still works.
 */

/** Thrown for any non-2xx accelerator response. Carries the HTTP status. */
export class HttpError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly body?: unknown,
    ) {
        super(message);
        this.name = "HttpError";
    }
}
```

- [ ] **Step 4: Create `PaymentRequiredError`.**

Create `src/core/PaymentRequiredError.ts`:

```ts
/**
 * `PaymentRequiredError` — a write the accelerator refused for payment
 * (accelerator spec 2026-10-06-paid-accounts-and-past-due, "Interfaces and
 * contracts").
 *
 * The accelerator answers such a write with a 402 whose body carries one of
 * three codes:
 *   - `user_plan_required`: the app takes paid Muhkoo plans only, and the
 *     signed-in user is on Free;
 *   - `user_payment_past_due`: the user's own Muhkoo payment is past due. Only
 *     first-party apps are told this; every other app is told
 *     `user_plan_required` instead;
 *   - `owner_payment_past_due`: the app owner's payment is past due, so the
 *     app stores nothing new for anyone.
 * Reads, sign-in and deletes still work in all three cases.
 *
 * Every other 402 — the Free-tier refusals that carry `quotaExceeded`,
 * `requiresPaidTier` or `freeTierFull` — has no `code`, and stays a plain
 * `HttpError`, as before.
 */

import { HttpError } from "./HttpError";

/** Why a write was refused for payment. A wire contract: these strings never change. */
export type PaymentRequiredCode = "user_plan_required" | "user_payment_past_due" | "owner_payment_past_due";

const CODES: ReadonlySet<string> = new Set<PaymentRequiredCode>([
    "user_plan_required",
    "user_payment_past_due",
    "owner_payment_past_due",
]);

/** True for one of the three {@link PaymentRequiredCode}s. */
export function isPaymentRequiredCode(value: unknown): value is PaymentRequiredCode {
    return typeof value === "string" && CODES.has(value);
}

/** `url` when it is an absolute http(s) URL, else undefined: an app may put it straight into a link. */
export function absoluteHttpUrl(url: unknown): string | undefined {
    return typeof url === "string" && /^https?:\/\/[^/]/i.test(url) ? url : undefined;
}

/** Thrown for a 402 whose body carries one of the three {@link PaymentRequiredCode}s. */
export class PaymentRequiredError extends HttpError {
    /** Why the write was refused. */
    readonly code: PaymentRequiredCode;
    /**
     * Where to send the user: the portal's upgrade page or its billing page,
     * as an absolute URL. Set only when the server sent an absolute http(s)
     * URL. The relative `upgradeUrl` of the Free-tier refusals is never here:
     * those are not this error.
     */
    readonly upgradeUrl?: string;

    constructor(message: string, code: PaymentRequiredCode, body?: unknown, upgradeUrl?: string) {
        super(message, 402, body);
        this.name = "PaymentRequiredError";
        this.code = code;
        if (upgradeUrl !== undefined) this.upgradeUrl = upgradeUrl;
    }
}

/**
 * The error to throw for a refused response: a {@link PaymentRequiredError}
 * for a 402 whose body carries one of the three codes, and null for anything
 * else, so the caller throws what it threw before. `body` is the parsed JSON,
 * or the raw text of the response, which is parsed here.
 */
export function paymentRequiredFrom(status: number, body: unknown): PaymentRequiredError | null {
    if (status !== 402) return null;
    let parsed = body;
    if (typeof parsed === "string") {
        try {
            parsed = JSON.parse(parsed);
        } catch {
            return null;
        }
    }
    if (!parsed || typeof parsed !== "object") return null;
    const { code, error, upgradeUrl } = parsed as { code?: unknown; error?: unknown; upgradeUrl?: unknown };
    if (!isPaymentRequiredCode(code)) return null;
    const message = typeof error === "string" && error ? error : `Payment required (${code})`;
    return new PaymentRequiredError(message, code, parsed, absoluteHttpUrl(upgradeUrl));
}
```

- [ ] **Step 5: Map the 402 in `HttpClient`.**

In `src/core/HttpClient.ts`, replace:

```ts
 */

export interface HttpClientOptions {
```

with:

```ts
 */

import { HttpError } from "./HttpError";
import { paymentRequiredFrom } from "./PaymentRequiredError";

export interface HttpClientOptions {
```

In `src/core/HttpClient.ts`, replace:

```ts
/** Thrown for any non-2xx accelerator response. Carries the HTTP status. */
export class HttpError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly body?: unknown,
    ) {
        super(message);
        this.name = "HttpError";
    }
}
```

with:

```ts
// Moved to its own module so `PaymentRequiredError` can extend it; re-exported
// here so every existing import of it from this module keeps working.
export { HttpError } from "./HttpError";
```

In `src/core/HttpClient.ts`, replace:

```ts
            throw new HttpError(msg, res.status, parsed);
```

with:

```ts
            // A refusal for payment is its own class, so an app can tell it from
            // any other 4xx; every other error is the HttpError it always was.
            throw paymentRequiredFrom(res.status, parsed) ?? new HttpError(msg, res.status, parsed);
```

- [ ] **Step 6: Run the test to verify it passes.**

Run: `cd /Users/matt/GitHub/muhkoo/connect && npx vitest --run tests/core/payment-required.test.ts`

Expected: PASS, `16 passed (16)`.

- [ ] **Step 7: Regression suites, types and lint.**

Run: `cd /Users/matt/GitHub/muhkoo/connect && yarn test:unit 2>&1 | grep -E "Test Files|Tests " && yarn typecheck && npx eslint src/core/HttpClient.ts src/core/HttpError.ts src/core/PaymentRequiredError.ts`

Expected: every test file passes (one more file and 16 more tests than Task 0, Step 4), `tsc` exits 0, eslint prints nothing.

- [ ] **Step 8: Mutation check.**
  - Before mutating anything, copy each file named below to the scratchpad.
  - Apply each mutation alone, run `npx vitest --run tests/core/payment-required.test.ts -t "<pattern>"`, and confirm that at least the named tests fail.
  - Restore the file from the scratchpad copy after each one, and confirm with `cmp`. Do not use `git stash` or `git checkout`.

| Mutation | `-t` pattern | Tests that must fail (at least) |
|---|---|---|
| `HttpClient.ts`: `throw new HttpError(msg, res.status, parsed);` again | `HttpClient\|client.vfs` | the three "throws PaymentRequiredError for a 402 with code …", "leaves upgradeUrl unset …" (4), "names the code …", and both `client.vfs` tests |
| `PaymentRequiredError.ts`: drop `if (status !== 402) return null;` | `maps only a 402` | "maps only a 402: a 403 carrying a payment code stays a plain HttpError" |
| `absoluteHttpUrl` returns any string | `leaves upgradeUrl unset` | the relative path, script URL and protocol-relative cases |

Verified on a scratch copy on 2026-10-06: all three killed.

- [ ] **Step 9: Checkpoint for Matt (no commit).**

Run: `sh <scratchpad>/bs-baseline/changed.sh`

Expected: exactly `src/core/HttpClient.ts`, `src/core/HttpError.ts`, `src/core/PaymentRequiredError.ts` and `tests/core/payment-required.test.ts`, then `released CHANGELOG sections: unchanged`. Report the RED, GREEN and mutation results. Do not stage, commit or stash.

---

### Task 2: The offline queue keeps writes refused for payment, for the user who made them

`OutboundQueue.isPermanent` drops every 4xx (`OutboundQueue.ts:145-152`), and a `PaymentRequiredError` is a 402. The drain now keeps an entry refused with it, keeps every entry after it, stops, and emits `SYNC_ERROR` with `dropped: false`. Under the device-wide lock the drain repeats its pass while the queue is not empty (`:104-106`); a kept entry ends that loop too, or it would ask the server again forever. `OfflineManager.resume()` drains once if anything is waiting; Task 6 calls it.

**Why this task comes straight after Task 1.** Task 3 makes `ShardClient` and `SharedSpaceClient` throw `PaymentRequiredError` where they threw a plain `Error`. The queue keeps a plain `Error` as transient, but today's `isPermanent` drops a 4xx `HttpError`, and `PaymentRequiredError` is one. With Task 3 first, every checkpoint until this task would drop a replayed shard upload refused for payment, which the tree before BS keeps (spec Risks: "`file` entries are already kept, because `ShardClient` throws a plain `Error`"). This task needs only Task 1's class.

**A kept entry is sent only under its own user's session (Choice 10).** The queue is one IndexedDB store for the whole origin (`muhkoo.offline`, `store/schema.ts:14`), `zk.logout()` clears only the session (`AuthNamespace.ts:700-702`), and the `kv`, `db` and `space` replayers build their request from whoever is signed in when they run (`KvNamespace.ts:89-94`, `DbNamespace.ts:185-199`, `SpaceNamespace.ts:99-107`). Before BS, a refused entry was dropped at the first drain. Kept, it waits as long as the refusal lasts, and the next drain after another user signs in on the same device would send it under their session: user A's `kv` write would land in user B's space, as A's ciphertext, or as A's plaintext for an `encrypt: false` value or a db row, and a fixed key would overwrite B's value. Plan C's Review Focus 5 (sign out on the upgrade screen, then sign in as a paid account in the same tab) is exactly that sequence. So `OutboundQueue.enqueue` now stamps each entry with the commitment of the user signed in, and a drain sends only that user's entries. Another user's stay queued, untouched and in order, until that user signs in on this device again. Entries without the stamp, queued by an older SDK, are sent by any drain, as before. This also closes the same window for entries kept after a transient failure, which before BS was brief.

A drain stopped by a refusal for payment resolves rather than rejects, so `SyncEngine` still runs its catch-up tasks, which are reads and still allowed. It also emits `SYNC_COMPLETE` and sets the status back to `online` (`SyncEngine.ts:63-65`) while the kept entries wait; only the `SYNC_ERROR` with `dropped: false` tells the two apart. Task 8's CHANGELOG says so.

**Files:**
- Modify: `src/offline/store/OfflineStore.ts:27-29` (`QueueEntry.commitment?`)
- Modify: `src/offline/OutboundQueue.ts:12-14` (header), `:28` (import), `:67-75` (`enqueue` stamps; `waiting`), `:96-113` (`drainOnce`; `runDrain`'s signature and its first lines), `:127-128` (the catch), `:138-143` (the end of `runDrain`), `:147-148` (`isPermanent`'s comment)
- Modify: `src/offline/OfflineManager.ts:114-115` (`resume`, before `ready`)
- Test: `tests/offline/payment-refused.test.ts` (create)

**Interfaces:**
- Consumes: `PaymentRequiredError` (Task 1).
- Produces, used by Task 6: `OfflineManager.resume(): Promise<void>`; `OutboundQueue.waiting(): Promise<QueueEntry[]>` (the entries a drain would send now: the signed-in user's, and unstamped ones); `QueueEntry.commitment?: string` (additive; `QueueEntry` is a public type, and `api-surface.txt` lists names only, so it does not change). Internal: `OutboundQueue.runDrain(): Promise<boolean>` (false when a payment refusal stopped the pass).

- [ ] **Step 1: Write the failing tests.**

Create `tests/offline/payment-refused.test.ts`:

```ts
/**
 * Queued writes the accelerator refuses for payment (accelerator spec
 * 2026-10-06-paid-accounts-and-past-due, D8 and B8). Kept, in order, with everything queued after them,
 * until the next reconnect or until `client.app.access()` reports the app allowed. Never dropped, never
 * retried in a loop, and never sent under another user's session.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { IndexedDbStore } from "../../src/offline/store/IndexedDbStore";
import { OutboundQueue, type TryLock } from "../../src/offline/OutboundQueue";
import { OfflineManager } from "../../src/offline/OfflineManager";
import { SessionState } from "../../src/core/Session";
import { HttpError } from "../../src/core/HttpClient";
import { PaymentRequiredError } from "../../src/core/PaymentRequiredError";
import { pack } from "../../src/offline/clock/HlcTimestamp";
import { EventCore, EventCoreEvents } from "../../src/events/EventCore";
import type { QueueEntry } from "../../src/offline/store/OfflineStore";

beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
});

function entry(n: number, domain: QueueEntry["domain"] = "kv", method = "set") {
    return { hlc: pack(n, 0, "n"), clientId: `c${n}`, domain, method, args: { n } };
}

const refused = () => new PaymentRequiredError("Cloud Drive is for paid Muhkoo plans.", "user_plan_required");
const nOf = (e: QueueEntry) => (e.args as { n: number }).n;

/** Web Locks' `ifAvailable`, as one browser's tabs share it. */
function deviceLocks(): TryLock {
    const held = new Set<string>();
    return async (name, fn) => {
        if (held.has(name)) return false;
        held.add(name);
        try {
            await fn();
            return true;
        } finally {
            held.delete(name);
        }
    };
}

/** Every SYNC_ERROR emitted while `fn` runs. */
async function syncErrors(fn: () => Promise<void>): Promise<unknown[]> {
    const seen: unknown[] = [];
    const on = (e: CustomEvent) => seen.push(e.detail);
    EventCore.on(EventCoreEvents.SYNC_ERROR, on);
    try {
        await fn();
    } finally {
        EventCore.off(EventCoreEvents.SYNC_ERROR, on);
    }
    return seen;
}

describe("offline queue — writes refused for payment", () => {
    it("keeps a write refused for payment and every write after it, in order, and stops there", async () => {
        const queue = new OutboundQueue(new IndexedDbStore());
        const tried: number[] = [];
        queue.register("kv", async (e) => {
            tried.push(nOf(e));
            if (nOf(e) === 2) throw refused();
        });
        for (const n of [1, 2, 3]) await queue.enqueue(entry(n));

        await queue.drain();   // resolves: a refusal for payment is not the drain failing

        expect(tried).toEqual([1, 2]);                  // 3 waits behind 2
        expect(await queue.pending()).toBe(2);
    });

    it("tells the app the write is waiting, not that it was dropped", async () => {
        const queue = new OutboundQueue(new IndexedDbStore());
        queue.register("kv", async () => {
            throw refused();
        });
        await queue.enqueue(entry(1));

        const errors = await syncErrors(() => queue.drain());

        expect(errors).toEqual([
            { domain: "kv", method: "set", error: "Cloud Drive is for paid Muhkoo plans.", code: "user_plan_required", dropped: false },
        ]);
    });

    it("sends them, in order, on the next drain once the server accepts them", async () => {
        const queue = new OutboundQueue(new IndexedDbStore());
        let paid = false;
        const sent: number[] = [];
        queue.register("kv", async (e) => {
            if (!paid) throw refused();
            sent.push(nOf(e));
        });
        for (const n of [1, 2, 3]) await queue.enqueue(entry(n));
        await queue.drain();
        expect(sent).toEqual([]);

        paid = true;
        await queue.drain();

        expect(sent).toEqual([1, 2, 3]);
        expect(await queue.pending()).toBe(0);
    });

    it("keeps a refused upload and the delete queued after it, which waits behind it", async () => {
        // Head of line: the delete would be allowed, but it is not sent before the upload ahead of it.
        const queue = new OutboundQueue(new IndexedDbStore());
        const deletes: number[] = [];
        queue.register("file", async () => {
            throw new PaymentRequiredError("Cloud Drive can't save changes right now.", "owner_payment_past_due");
        });
        queue.register("db", async (e) => void deletes.push(nOf(e)));
        await queue.enqueue(entry(1, "file", "putShard"));
        await queue.enqueue(entry(2, "db", "delete"));

        await queue.drain();

        expect(deletes).toEqual([]);
        expect(await queue.pending()).toBe(2);
    });

    it("does not loop when the drain holds the device-wide lock", async () => {
        // Under the lock, a drain goes round again while the queue is not empty, for writes another tab
        // queued meanwhile. A kept write leaves it not empty, so the drain must stop at the kept write
        // instead of asking the server again at once, and again, without end.
        const queue = new OutboundQueue(new IndexedDbStore(), { tryLock: deviceLocks(), commitment: () => "c1" });
        let tries = 0;
        queue.register("kv", async () => {
            tries++;
            throw refused();
        });
        await queue.enqueue(entry(1));

        await queue.drain();

        expect(tries).toBe(1);
        expect(await queue.pending()).toBe(1);
    }, 2_000);

    it("still drops a write refused with any other 402, as before", async () => {
        // A guard: Free-tier quota refusals carry no code and are permanent, as they always were.
        const queue = new OutboundQueue(new IndexedDbStore());
        const sent: number[] = [];
        queue.register("kv", async (e) => {
            if (nOf(e) === 1) throw new HttpError("KV write quota exceeded", 402, { quotaExceeded: true });
            sent.push(nOf(e));
        });
        await queue.enqueue(entry(1));
        await queue.enqueue(entry(2));

        const errors = await syncErrors(() => queue.drain());

        expect(sent).toEqual([2]);
        expect(await queue.pending()).toBe(0);
        expect(errors).toEqual([expect.objectContaining({ domain: "kv", dropped: true })]);
    });
});

describe("offline queue — two users on one device", () => {
    // Every tab of an origin shares one queue, and a replayer builds its request from whoever is signed in
    // when it runs. A write kept for payment waits as long as the refusal lasts, so it must never go out
    // under the next user's session: it would land in their space, and a fixed key would overwrite theirs.

    it("never sends one user's kept write under another user's session, and sends it once its user is back", async () => {
        let who = "c-alice";
        const queue = new OutboundQueue(new IndexedDbStore(), { commitment: () => who });
        let paid = false;
        const sent: string[] = [];
        queue.register("kv", async (e) => {
            if (!paid) throw refused();
            sent.push(`${nOf(e)} as ${who}`);
        });
        await queue.enqueue(entry(1));      // alice's
        await queue.drain();                // refused for payment: kept

        who = "c-bob";                      // alice signs out; bob, on a paid plan, signs in
        paid = true;
        await queue.enqueue(entry(2));      // bob's
        await queue.drain();

        expect(sent).toEqual(["2 as c-bob"]);
        expect(await queue.pending()).toBe(1);          // alice's, untouched
        expect(await queue.waiting()).toEqual([]);      // nothing of bob's

        who = "c-alice";                    // alice signs in again
        await queue.drain();

        expect(sent).toEqual(["2 as c-bob", "1 as c-alice"]);
        expect(await queue.pending()).toBe(0);
    });

    it("does not loop over another user's writes when the drain holds the device-wide lock", async () => {
        // Under the lock, a drain goes round again while writes remain. Another user's never leave, so a
        // drain that counted them would ask for the queue again at once, and again, without end.
        let who = "c-alice";
        const queue = new OutboundQueue(new IndexedDbStore(), { tryLock: deviceLocks(), commitment: () => who });
        let tries = 0;
        queue.register("kv", async () => void tries++);
        await queue.enqueue(entry(1));      // alice's, queued while offline
        who = "c-bob";

        await queue.drain();

        expect(tries).toBe(0);
        expect(await queue.pending()).toBe(1);
    }, 2_000);

    it("still sends an entry an older SDK queued without saying whose it is", async () => {
        // A guard: entries queued before this version carry no commitment, and replay as they always did.
        const store = new IndexedDbStore();
        await store.enqueue(entry(1));      // straight into the store, as an older SDK wrote it
        const queue = new OutboundQueue(store, { commitment: () => "c-bob" });
        const sent: number[] = [];
        queue.register("kv", async (e) => void sent.push(nOf(e)));

        await queue.drain();

        expect(sent).toEqual([1]);
        expect(await queue.pending()).toBe(0);
    });
});

describe("OfflineManager.resume — after client.app.access() reports the app allowed", () => {
    async function unlocked(): Promise<SessionState> {
        const session = new SessionState();
        await session.setSession({ token: "t", username: "alice", commitment: "c1" });
        session.setIdentity({} as never);
        return session;
    }

    it("sends the writes kept after a refusal for payment, once", async () => {
        const manager = new OfflineManager({ store: new IndexedDbStore(), session: await unlocked(), enabled: true });
        let paid = false;
        const sent: number[] = [];
        manager.registerReplayer("kv", async (e) => {
            if (!paid) throw refused();
            sent.push(nOf(e));
        });
        try {
            await manager.enqueue(entry(1));
            await manager.queue.drain();
            paid = true;

            await manager.resume();

            expect(sent).toEqual([1]);
            expect(await manager.queue.pending()).toBe(0);
        } finally {
            manager.dispose();
        }
    });

    it("does nothing when nothing is waiting: no drain, so no 'syncing' for the app to show", async () => {
        const manager = new OfflineManager({ store: new IndexedDbStore(), session: await unlocked(), enabled: true });
        const run = vi.spyOn(manager.sync, "run");
        const states: string[] = [];
        manager.onStatusChange((s) => states.push(s));
        try {
            await manager.resume();
            expect(run).not.toHaveBeenCalled();
            expect(states).toEqual([]);
        } finally {
            manager.dispose();
        }
    });

    it("does nothing when only another user's writes are waiting", async () => {
        const session = await unlocked();
        const manager = new OfflineManager({ store: new IndexedDbStore(), session, enabled: true });
        const run = vi.spyOn(manager.sync, "run");
        try {
            await manager.enqueue(entry(1));                                                 // alice's
            await session.setSession({ token: "t2", username: "bob", commitment: "c2" });   // bob signs in
            await manager.resume();
            expect(run).not.toHaveBeenCalled();
            expect(await manager.queue.pending()).toBe(1);
        } finally {
            manager.dispose();
        }
    });

    it("sends nothing while the session is locked; the writes stay queued", async () => {
        const session = new SessionState();
        await session.setSession({ token: "t", username: "alice", commitment: "c1" });   // no identity: locked
        const manager = new OfflineManager({ store: new IndexedDbStore(), session, enabled: true });
        const sent: number[] = [];
        manager.registerReplayer("kv", async (e) => void sent.push(nOf(e)));
        try {
            await manager.enqueue(entry(1));
            await manager.resume();
            expect(sent).toEqual([]);
            expect(await manager.queue.pending()).toBe(1);
        } finally {
            manager.dispose();
        }
    });
});
```

- [ ] **Step 2: Run them to verify they fail.**

Run: `cd /Users/matt/GitHub/muhkoo/connect && npx vitest --run tests/offline/payment-refused.test.ts`

Expected: FAIL, `11 failed | 2 passed (13)`. The queue drops the refused entries (`expected [ 1, 2, 3 ] to deeply equal [ 1, 2 ]`, `expected +0 to be 1`), a drain under the lock sends another user's write (`expected 1 to be +0`), and `manager.resume is not a function`. "still drops a write refused with any other 402, as before" and "still sends an entry an older SDK queued without saying whose it is" pass: they are guards.

- [ ] **Step 3: Keep, stop, do not loop, and send each user's writes only under their session.**

In `src/offline/store/OfflineStore.ts`, replace:

```ts
    /** Serializable arguments captured at enqueue time. */
    args: unknown;
}
```

with:

```ts
    /** Serializable arguments captured at enqueue time. */
    args: unknown;
    /**
     * Whose write it is: the commitment of the user signed in when it was
     * queued, stamped by `OutboundQueue.enqueue`. A drain sends only the
     * signed-in user's entries, because every replayer builds its request
     * from the session signed in when it runs. Absent on entries an older
     * SDK queued, which any drain sends, as before.
     */
    commitment?: string;
}
```

In `src/offline/OutboundQueue.ts`, replace:

```ts
 *   - permanent failure (4xx, or a Space whose member list refuses this user)
 *     → drop it and surface a `SYNC_ERROR` (a write the server will never
 *     accept must not wedge the queue forever);
```

with:

```ts
 *   - refused for payment (`PaymentRequiredError`: the app takes paid plans
 *     only, or someone's payment is past due) → keep it and everything after
 *     it, stop, and surface a `SYNC_ERROR` with `dropped: false`. The server
 *     accepts it once the user or the app owner pays, so it waits for the next
 *     reconnect, or for `client.app.access()` to report the app allowed;
 *   - permanent failure (any other 4xx, or a Space whose member list refuses
 *     this user) → drop it and surface a `SYNC_ERROR` (a write the server will
 *     never accept must not wedge the queue forever);
```

In `src/offline/OutboundQueue.ts`, replace:

```ts
import { HttpError } from "../core/HttpClient";
```

with:

```ts
import { HttpError } from "../core/HttpClient";
import { PaymentRequiredError } from "../core/PaymentRequiredError";
```

In `src/offline/OutboundQueue.ts`, replace:

```ts
    /** Record a mutation for later replay; resolves with its assigned seq. */
    enqueue(entry: Omit<QueueEntry, "seq">): Promise<number> {
        return this.store.enqueue(entry);
    }

    /** Number of writes still awaiting sync. */
    async pending(): Promise<number> {
        return (await this.store.queued()).length;
    }
```

with:

```ts
    /**
     * Record a mutation for later replay; resolves with its assigned seq.
     * Stamped with the signed-in user's commitment, so that it is only ever
     * sent under their session (see {@link waiting}).
     */
    enqueue(entry: Omit<QueueEntry, "seq">): Promise<number> {
        const who = entry.commitment ?? this.opts.commitment?.();
        return this.store.enqueue(who ? { ...entry, commitment: who } : entry);
    }

    /** Number of writes still awaiting sync, every user's. */
    async pending(): Promise<number> {
        return (await this.store.queued()).length;
    }

    /**
     * The writes a drain would send now, in order: the signed-in user's, and
     * any an older SDK queued without saying whose they are. Every tab of an
     * origin shares this queue, and every replayer builds its request from
     * the session signed in when it runs, so another user's write sent now
     * would land in this user's space, or overwrite their data. It stays
     * queued, as it is, until its own user signs in on this device again.
     */
    async waiting(): Promise<QueueEntry[]> {
        return (await this.store.queued()).filter((entry) => this.sendable(entry));
    }

    /** True for an entry this drain may send: the signed-in user's, or one with no user. */
    private sendable(entry: QueueEntry): boolean {
        return !entry.commitment || entry.commitment === this.opts.commitment?.();
    }
```

In `src/offline/OutboundQueue.ts`, replace:

```ts
    private async drainOnce(): Promise<void> {
        const who = this.opts.commitment?.();
        if (!this.opts.tryLock || !who) return this.runDrain();
        await this.opts.tryLock(`muhkoo:offline-drain:${who}`, async () => {
            // A tab that found this one draining skipped its own drain, and
            // what it queued after this pass read the queue was left to this
            // tab. So drain until a pass leaves nothing; a transient failure
            // still stops it, by throwing.
            do {
                await this.runDrain();
            } while ((await this.store.queued()).length > 0);
        });
    }

    private async runDrain(): Promise<void> {
        const entries = await this.store.queued();
        for (const entry of entries) {
            const replayer = this.replayers.get(entry.domain);
```

with:

```ts
    private async drainOnce(): Promise<void> {
        const who = this.opts.commitment?.();
        if (!this.opts.tryLock || !who) {
            await this.runDrain();
            return;
        }
        await this.opts.tryLock(`muhkoo:offline-drain:${who}`, async () => {
            // A tab that found this one draining skipped its own drain, and
            // what it queued after this pass read the queue was left to this
            // tab. So drain until a pass leaves nothing of this user's; a
            // transient failure still stops it, by throwing. So does a write
            // refused for payment, which stays queued: another pass would
            // only be refused again, at once and without end. Another user's
            // writes never leave, so counting them would loop for ever too.
            do {
                if (!(await this.runDrain())) return;
            } while ((await this.waiting()).length > 0);
        });
    }

    /**
     * One pass over the queue. False when a write refused for payment stopped
     * it, which leaves that write and everything after it queued.
     */
    private async runDrain(): Promise<boolean> {
        const entries = await this.store.queued();
        for (const entry of entries) {
            // Another user's write, theirs to send under their own session.
            // Asked per entry, so a sign-out in the middle of a pass stops
            // the rest of it going out under the next user's session.
            if (!this.sendable(entry)) continue;
            const replayer = this.replayers.get(entry.domain);
```

In `src/offline/OutboundQueue.ts`, replace:

```ts
            } catch (err) {
                if (isPermanent(err)) {
```

with:

```ts
            } catch (err) {
                // Asked before `isPermanent`, which would drop it as a 4xx.
                if (err instanceof PaymentRequiredError) {
                    // The user's plan, or a payment past due: the server will
                    // accept this write once that changes. Keep it, and keep
                    // every write after it in order; a delete queued after an
                    // upload never goes first. Stop rather than send the rest,
                    // which the server would refuse for the same reason.
                    EventCore.emit(EventCoreEvents.SYNC_ERROR, {
                        domain: entry.domain,
                        method: entry.method,
                        error: err.message,
                        code: err.code,
                        dropped: false,
                    });
                    return false;
                }
                if (isPermanent(err)) {
```

In `src/offline/OutboundQueue.ts`, replace:

```ts
                // Transient (offline again, 5xx) — keep the entry, stop here.
                throw err;
            }
        }
    }
}
```

with:

```ts
                // Transient (offline again, 5xx) — keep the entry, stop here.
                throw err;
            }
        }
        return true;
    }
}
```

In `src/offline/OutboundQueue.ts`, replace:

```ts
 *  their frames. Anything else, a locked session included, is worth retrying
 *  on the next reconnect. */
```

with:

```ts
 *  their frames. Anything else, a locked session included, is worth retrying
 *  on the next reconnect. A refusal for payment is a 4xx that is not
 *  permanent; `runDrain` keeps it before asking this. */
```

- [ ] **Step 4: `OfflineManager.resume()`.**

In `src/offline/OfflineManager.ts`, replace:

```ts
    /** Resolve once the clock + node id are loaded. */
    ready(): Promise<void> {
```

with:

```ts
    /**
     * Replay the queue now, as a reconnect does, if anything is waiting in it.
     * `client.app.access()` calls this each time it reports the app allowed,
     * so writes kept after a refusal for payment go out once the user or the
     * app owner has paid, without waiting for the next reconnect. One drain per
     * call, never on a timer. With nothing of the signed-in user's queued it
     * does not drain at all, so the app sees no "syncing".
     */
    async resume(): Promise<void> {
        if (!this.enabled) return;
        if ((await this.queue.waiting()).length === 0) return;
        await this.sync.run();
    }

    /** Resolve once the clock + node id are loaded. */
    ready(): Promise<void> {
```

- [ ] **Step 5: Run the tests to verify they pass.**

Run: `cd /Users/matt/GitHub/muhkoo/connect && npx vitest --run tests/offline`

Expected: PASS, every file, `tests/offline/sync.test.ts` and `tests/offline/tabs.test.ts` included; `tests/offline/payment-refused.test.ts` is `13 passed (13)`. Run that file 5 times in a row; it must pass every time.

- [ ] **Step 6: Regression suites, types and lint.**

Run: `cd /Users/matt/GitHub/muhkoo/connect && yarn test:unit 2>&1 | grep -E "Test Files|Tests " && yarn typecheck && npx eslint src/offline/OutboundQueue.ts src/offline/OfflineManager.ts src/offline/store/OfflineStore.ts`

Expected: every test file passes, `tsc` exits 0, eslint prints nothing.

- [ ] **Step 7: Mutation check** (same procedure as Task 1, Step 8; test file `tests/offline/payment-refused.test.ts`).

| Mutation | `-t` pattern | Tests that must fail (at least) |
|---|---|---|
| `if (err instanceof PaymentRequiredError && false) {` | `writes refused for payment` | the five keep tests |
| `drainOnce`: `await this.runDrain();` in place of `if (!(await this.runDrain())) return;` | `does not loop when` | "does not loop when the drain holds the device-wide lock", by its 2-second limit |
| `dropped: true,` in the new emit | `tells the app` | that test |
| `resume`: drop `if ((await this.queue.waiting()).length === 0) return;` | `does nothing when nothing is waiting` | that test |
| `enqueue`: `return this.store.enqueue(entry);` (no stamp) | `two users` | "never sends one user's kept write under another user's session…", "does not loop over another user's writes…" |
| `sendable`: `return true;` | `two users\|another user` | the same two, and "does nothing when only another user's writes are waiting" |
| `sendable`: `return entry.commitment === this.opts.commitment?.();` | `older SDK` | "still sends an entry an older SDK queued…" |
| `drainOnce`: `while ((await this.store.queued()).length > 0)` in place of `while ((await this.waiting()).length > 0)` | `does not loop over` | that test, by its 2-second limit |
| `resume`: `(await this.queue.pending()) === 0` in place of `(await this.queue.waiting()).length === 0` | `only another user` | "does nothing when only another user's writes are waiting" |

Verified on a scratch copy: all nine killed.

- [ ] **Step 8: Checkpoint for Matt (no commit).**

Run: `sh <scratchpad>/bs-baseline/changed.sh`

Expected: Task 1's four files, plus `src/offline/OfflineManager.ts`, `src/offline/OutboundQueue.ts`, `src/offline/store/OfflineStore.ts` and `tests/offline/payment-refused.test.ts`, then `released CHANGELOG sections: unchanged`. Do not stage, commit or stash.

---

### Task 3: The mapping in the clients that read responses themselves

`ShardClient`, `SharedSpaceClient` and `PersonalSpaceClient` call `fetch` directly and threw plain `Error`s (`ShardClient.ts:260`, `:310`). Each now throws `PaymentRequiredError` for the three codes, and exactly the `Error` it threw before for anything else.

`PersonalSpaceClient` sends no app key, so it should never meet these codes; it is mapped because the spec names it, for callers that use it on its own.

The offline queue kept a replayed shard upload that failed with the plain `Error`, as transient. A 4xx `HttpError` it drops, and `PaymentRequiredError` is one; Task 2 already keeps it, which is why Task 2 comes first.

**Files:**
- Modify: `src/storage/transport/ShardClient.ts:22` (import), `:260-262` (the `putShard` throw), `:310-315` (the `uploadToOrigin` throw)
- Modify: `src/storage/transport/SharedSpaceClient.ts:23` (import), `:104-105` (`parseOrThrow`)
- Modify: `src/personal/PersonalSpaceClient.ts:27` (import), `:121-129` (`parseOrThrow`)
- Test: `tests/core/payment-required.test.ts` (modify: two import lines, and three `describe`s appended)

**Interfaces:**
- Consumes: `paymentRequiredFrom(status, body)` from Task 1.
- Produces: no new names. `ShardClient.putShard` and its background upload, `SharedSpaceClient`'s four methods and `PersonalSpaceClient`'s five reject with `PaymentRequiredError` for the three codes.

- [ ] **Step 1: Write the failing tests.**

In `tests/core/payment-required.test.ts`, replace:

```ts
import { describe, it, expect } from "vitest";
```

with:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
```

In `tests/core/payment-required.test.ts`, replace:

```ts
import { PaymentRequiredError, type PaymentRequiredCode } from "../../src/core/PaymentRequiredError";
```

with:

```ts
import { PaymentRequiredError, type PaymentRequiredCode } from "../../src/core/PaymentRequiredError";
import { ShardClient, type ShardByteCache } from "../../src/storage/transport/ShardClient";
import { SharedSpaceClient } from "../../src/storage/transport/SharedSpaceClient";
import { PersonalSpaceClient } from "../../src/personal/PersonalSpaceClient";
import type { FileManifest } from "../../src/storage/types";
```

Append to the end of `tests/core/payment-required.test.ts`:

```ts

describe("ShardClient — refusals for payment", () => {
    const HASH = "ab".repeat(32);

    it("throws PaymentRequiredError for a refused shard upload", async () => {
        const shards = new ShardClient({
            baseUrl: BASE_URL,
            fetch: answering(402, { error: "Cloud Drive is for paid Muhkoo plans.", code: "user_plan_required", upgradeUrl: PORTAL }),
        });
        const err = await failure(shards.putShard(HASH, new Uint8Array([1, 2, 3])));
        expect(err).toBeInstanceOf(PaymentRequiredError);
        expect(err).toMatchObject({ code: "user_plan_required", upgradeUrl: PORTAL, message: "Cloud Drive is for paid Muhkoo plans." });
    });

    it("keeps any other refused upload the plain Error it was", async () => {
        const shards = new ShardClient({ baseUrl: BASE_URL, fetch: answering(402, { error: "Storage quota exceeded", quotaExceeded: true }) });
        const err = await failure(shards.putShard(HASH, new Uint8Array([1])));
        expect(err).toBeInstanceOf(Error);
        expect(err).not.toBeInstanceOf(HttpError);
        expect((err as Error).message).toMatch(/^ShardClient\.putShard\([0-9a-f]+\) failed \(402\): /);
    });

    it("hands a background upload refused for payment to the offline queue, its bytes still cached", async () => {
        // A guard: this passed before PaymentRequiredError existed, because every
        // background failure is deferred. It pins that the new error is too.
        const bytes = new Map<string, Uint8Array>();
        const cache: ShardByteCache = { get: async (h) => bytes.get(h) ?? null, put: async (h, b) => void bytes.set(h, b) };
        const deferred: string[] = [];
        const shards = new ShardClient({
            baseUrl: BASE_URL,
            fetch: answering(402, { error: "Cloud Drive can't save changes right now.", code: "owner_payment_past_due" }),
            cache,
            backgroundUpload: true,
            deferUpload: async (h) => void deferred.push(h),
        });
        await shards.putShard(HASH, new Uint8Array([1, 2]));
        await vi.waitFor(() => expect(deferred).toEqual([HASH]));
        expect(bytes.get(HASH)).toEqual(new Uint8Array([1, 2]));
    });
});

describe("SharedSpaceClient — refusals for payment", () => {
    const MANIFEST = { id: "f1" } as unknown as FileManifest;

    it("throws PaymentRequiredError for a refused manifest write", async () => {
        const files = new SharedSpaceClient({
            baseUrl: BASE_URL,
            fetch: answering(402, { error: "Cloud Drive can't save changes right now.", code: "owner_payment_past_due" }),
        });
        const err = await failure(files.writeFileManifest("space-1", MANIFEST));
        expect(err).toBeInstanceOf(PaymentRequiredError);
        expect(err).toMatchObject({ code: "owner_payment_past_due" });
    });

    it("keeps any other refusal the plain Error it was", async () => {
        const files = new SharedSpaceClient({ baseUrl: BASE_URL, fetch: answering(402, { error: "Storage quota exceeded", quotaExceeded: true }) });
        const err = await failure(files.writeFileManifest("space-1", MANIFEST));
        expect(err).not.toBeInstanceOf(HttpError);
        expect((err as Error).message).toBe("SharedSpaceClient.writeFileManifest(f1): Storage quota exceeded");
    });
});

describe("PersonalSpaceClient — refusals for payment", () => {
    afterEach(() => vi.unstubAllGlobals());

    /** A client whose proof step is stubbed out (the proof is not under test), over `fetchFn`. */
    function personal(fetchFn: typeof fetch): PersonalSpaceClient {
        vi.stubGlobal("fetch", fetchFn);
        const client = new PersonalSpaceClient({
            baseUrl: BASE_URL,
            commitment: "1",
            secret: "2",
            salt: "3",
            ecdsaPub: "4",
            ecdsaPubHash: "5",
            circuits: { wasmUrl: "w", zkeyUrl: "z" } as never,
        });
        (client as unknown as { proveFreshChallenge: () => Promise<unknown> }).proveFreshChallenge = async () => ({
            challengeId: "ch",
            proof: {},
            publicSignals: [],
        });
        return client;
    }

    it("throws PaymentRequiredError for a refused put", async () => {
        const client = personal(answering(402, { error: "Cloud Drive is for paid Muhkoo plans.", code: "user_plan_required" }));
        const err = await failure(client.put("notes/n1", { text: "x" }));
        expect(err).toBeInstanceOf(PaymentRequiredError);
        expect(err).toMatchObject({ code: "user_plan_required" });
    });

    it("keeps any other refusal the plain Error it was", async () => {
        const client = personal(answering(402, { error: "KV write quota exceeded", quotaExceeded: true }));
        const err = await failure(client.put("notes/n1", { text: "x" }));
        expect(err).not.toBeInstanceOf(HttpError);
        expect((err as Error).message).toMatch(/^PersonalSpaceClient put\(notes\/n1\) failed \(402\): /);
    });
});
```

- [ ] **Step 2: Run them to verify the new ones fail.**

Run: `cd /Users/matt/GitHub/muhkoo/connect && npx vitest --run tests/core/payment-required.test.ts`

Expected: FAIL, `3 failed | 20 passed (23)`: "throws PaymentRequiredError for a refused shard upload", "… for a refused manifest write" and "… for a refused put". The "plain Error it was" tests and the background-upload guard pass already.

- [ ] **Step 3: Map the 402 in `ShardClient`.**

In `src/storage/transport/ShardClient.ts`, replace:

```ts
import { toHex } from "../../utilities/bytes";
```

with:

```ts
import { toHex } from "../../utilities/bytes";
import { paymentRequiredFrom } from "../../core/PaymentRequiredError";
```

In `src/storage/transport/ShardClient.ts`, replace:

```ts
            throw new Error(`ShardClient.putShard(${hash}) failed (${response.status}): ${text}`);
        }
        let dedup = false;
```

with:

```ts
            // Refused for payment: its own class, which the offline queue keeps
            // and an app can tell from any other failure.
            throw paymentRequiredFrom(response.status, text)
                ?? new Error(`ShardClient.putShard(${hash}) failed (${response.status}): ${text}`);
        }
        let dedup = false;
```

In `src/storage/transport/ShardClient.ts`, replace:

```ts
            throw new Error(`ShardClient.putShard(${hash}) failed (${response.status}): ${text}`);
        }
    }

    /**
     * Fetch a shard by hash.
```

with:

```ts
            throw paymentRequiredFrom(response.status, text)
                ?? new Error(`ShardClient.putShard(${hash}) failed (${response.status}): ${text}`);
        }
    }

    /**
     * Fetch a shard by hash.
```

- [ ] **Step 4: Map it in `SharedSpaceClient`.**

In `src/storage/transport/SharedSpaceClient.ts`, replace:

```ts
import type { FileManifest, FileStat } from "../types";
```

with:

```ts
import type { FileManifest, FileStat } from "../types";
import { paymentRequiredFrom } from "../../core/PaymentRequiredError";
```

In `src/storage/transport/SharedSpaceClient.ts`, replace:

```ts
    if (!response.ok) {
        const msg =
```

with:

```ts
    if (!response.ok) {
        // A manifest write refused for payment (a gated Space write): its own class.
        const refused = paymentRequiredFrom(response.status, parsed);
        if (refused) throw refused;
        const msg =
```

- [ ] **Step 5: Map it in `PersonalSpaceClient`.**

In `src/personal/PersonalSpaceClient.ts`, replace:

```ts
import { resolveArtifact, type CircuitIntegrity } from "../auth/circuitIntegrity";
```

with:

```ts
import { resolveArtifact, type CircuitIntegrity } from "../auth/circuitIntegrity";
import { paymentRequiredFrom } from "../core/PaymentRequiredError";
```

In `src/personal/PersonalSpaceClient.ts`, replace:

```ts
    if (!response.ok) {
        let detail = "";
        try {
            const text = await response.text();
            detail = text ? `: ${text}` : "";
        } catch {
            // ignore — we'll just use the status code
        }
        throw new Error(`PersonalSpaceClient ${label} failed (${response.status})${detail}`);
```

with:

```ts
    if (!response.ok) {
        let text = "";
        try {
            text = await response.text();
        } catch {
            // ignore — we'll just use the status code
        }
        // A put refused for payment: its own class. Every other failure is the
        // plain Error it always was.
        const refused = paymentRequiredFrom(response.status, text);
        if (refused) throw refused;
        const detail = text ? `: ${text}` : "";
        throw new Error(`PersonalSpaceClient ${label} failed (${response.status})${detail}`);
```

- [ ] **Step 6: Run the tests to verify they pass.**

Run: `cd /Users/matt/GitHub/muhkoo/connect && npx vitest --run tests/core/payment-required.test.ts`

Expected: PASS, `23 passed (23)`.

- [ ] **Step 7: Regression suites, types and lint.**

Run: `cd /Users/matt/GitHub/muhkoo/connect && yarn test:unit 2>&1 | grep -E "Test Files|Tests " && yarn typecheck && npx eslint src/storage/transport/ShardClient.ts src/storage/transport/SharedSpaceClient.ts src/personal/PersonalSpaceClient.ts`

Expected: every test file passes, `tsc` exits 0, eslint prints nothing.

- [ ] **Step 8: Mutation check** (same procedure as Task 1, Step 8).

| Mutation | `-t` pattern | Tests that must fail (at least) |
|---|---|---|
| `ShardClient.putShard`: `throw new Error(…)` again (drop the comment and the `paymentRequiredFrom(…) ??`) | `ShardClient` | "throws PaymentRequiredError for a refused shard upload" |
| `SharedSpaceClient`: drop `if (refused) throw refused;` | `SharedSpaceClient` | "throws PaymentRequiredError for a refused manifest write" |
| `PersonalSpaceClient`: drop `if (refused) throw refused;` | `PersonalSpaceClient` | "throws PaymentRequiredError for a refused put" |

The mapping in `uploadToOrigin` has no failing mutation: the background path hands every failure to `deferUpload`, whatever its class. It is kept so both PUTs throw the same errors, as the spec names both lines. Verified on a scratch copy: the three mutations above killed.

- [ ] **Step 9: Checkpoint for Matt (no commit).**

Run: `sh <scratchpad>/bs-baseline/changed.sh`

Expected: the files of Tasks 1–2, plus `src/personal/PersonalSpaceClient.ts`, `src/storage/transport/ShardClient.ts` and `src/storage/transport/SharedSpaceClient.ts`, then `released CHANGELOG sections: unchanged`. Report RED, GREEN and mutations. Do not stage, commit or stash.

---

### Task 4: Uploads re-establish a stale session

On a paid-only app, plan B refuses a shard PUT without a valid session with `401 session_required` (spec B5 step 1). `ShardClient` got the raw `http.fetch`, which passes a 401 straight back (`SpaceNamespace.ts:308`, `:363`; `Space.ts:956-964`; `FileNamespace.ts:166-172`; `Client.ts:464-468`). A paid user with a tab older than 24 hours would get a hard upload failure. `ShardClient` now takes an optional `fetchWithRecovery`, as `KeyringClient` does, and uses it for both PUTs; every place that builds one passes `http.fetchWithRecovery`. Reads keep the plain fetch.

**Files:**
- Modify: `src/storage/transport/ShardClient.ts:118-120` (options), `:175-176` (fields), `:199-200` (constructor), `:243-244` (the `putShard` PUT), `:303-304` (the `uploadToOrigin` PUT)
- Modify: `src/spaces/Space.ts:156-158` (`SpaceDeps`), `:958-959` (`fileStorage`)
- Modify: `src/core/namespaces/SpaceNamespace.ts:308-309` (files-only build), `:363-364` (messaging build)
- Modify: `src/core/namespaces/MessageNamespace.ts:155-156` (`room`)
- Modify: `src/core/namespaces/FileNamespace.ts:168-169` (`shards`)
- Modify: `src/core/Client.ts:467-468` (the replay's `ShardClient`)
- Test: `tests/storage/shard-session-recovery.test.ts` (create)

**Interfaces:**
- Consumes: `HttpClient.fetchWithRecovery: typeof fetch` (existing, `HttpClient.ts:162-169`).
- Produces, used by Task 5: `SpaceDeps.fetchWithRecovery?: typeof fetch`; and `ShardClientOptions.fetchWithRecovery?: typeof fetch`.

- [ ] **Step 1: Write the failing tests.**

Create `tests/storage/shard-session-recovery.test.ts`:

```ts
/**
 * A shard upload made with a stale session (accelerator spec 2026-10-06-paid-accounts-and-past-due, B5
 * and B8). On a paid-only app the accelerator refuses a PUT without a valid session with
 * `401 session_required`. A tab left open for over a day holds such a session, so every upload path
 * re-establishes the session once and sends the PUT again, as `HttpClient`'s own requests always have.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { HttpClient } from "../../src/core/HttpClient";
import { Client } from "../../src/core/Client";
import { SessionState } from "../../src/core/Session";
import { ShardClient, type ShardByteCache } from "../../src/storage/transport/ShardClient";
import { SpaceNamespace } from "../../src/core/namespaces/SpaceNamespace";
import { MessageNamespace } from "../../src/core/namespaces/MessageNamespace";
import { StorageNamespace } from "../../src/core/namespaces/FileNamespace";
import { KvNamespace } from "../../src/core/namespaces/KvNamespace";
import { ChatKeyVault, type ChatKeyStore } from "../../src/core/ChatKeyVault";
import { IndexedDbStore } from "../../src/offline/store/IndexedDbStore";
import { pack } from "../../src/offline/clock/HlcTimestamp";
import type { WrappedPayload } from "../../src/crypto/PassphraseWrap";

const BASE_URL = "http://test";
const HASH = "cd".repeat(32);

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * An accelerator that refuses a shard PUT made with the stale token, `401 session_required`, as a
 * paid-only app does, and accepts everything else. A re-authentication swaps the token for a fresh one.
 * `puts` records the token each PUT carried.
 */
function staleSession() {
    const session = { username: "alice", seed: new Uint8Array(32).fill(7), commitment: "c-alice", token: "stale" };
    const puts: Array<string | null> = [];
    const onUnauthorized = vi.fn(async () => {
        session.token = "fresh";
        return true;
    });
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const token = new Headers(init?.headers).get("X-Muhkoo-Session");
        if ((init?.method ?? "GET") === "PUT" && url.includes("/api/shards/")) {
            puts.push(token);
            if (token !== "fresh") return json({ error: "A signed-in session is required", code: "session_required" }, 401);
            return json({ ok: true, dedup: false });
        }
        return json({ ok: true });
    }) as typeof fetch;
    const http = new HttpClient({ baseUrl: BASE_URL, getSessionToken: () => session.token, fetch: fetchFn, onUnauthorized });
    return { session, http, puts, onUnauthorized };
}

/** Every PUT sent with the stale token was sent again with the fresh one, after one re-authentication at least. */
function expectRecovered(puts: Array<string | null>, onUnauthorized: { mock: { calls: unknown[] } }) {
    expect(onUnauthorized.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(puts.filter((t) => t === "stale").length).toBeGreaterThanOrEqual(1);
    expect(puts.filter((t) => t === "fresh").length).toBe(puts.filter((t) => t === "stale").length);
}

describe("ShardClient — a PUT with a stale session", () => {
    it("re-establishes the session once and sends the PUT again", async () => {
        const { http, puts, onUnauthorized } = staleSession();
        const shards = new ShardClient({ baseUrl: BASE_URL, fetch: http.fetch, fetchWithRecovery: http.fetchWithRecovery });
        await expect(shards.putShard(HASH, new Uint8Array([1, 2, 3]))).resolves.toEqual({ dedup: false });
        expect(puts).toEqual(["stale", "fresh"]);
        expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });

    it("tries once: a PUT still refused after re-authentication fails", async () => {
        const { http, puts, onUnauthorized } = staleSession();
        onUnauthorized.mockImplementation(async () => true);   // "recovered", but the token stays stale
        const shards = new ShardClient({ baseUrl: BASE_URL, fetch: http.fetch, fetchWithRecovery: http.fetchWithRecovery });
        await expect(shards.putShard(HASH, new Uint8Array([1]))).rejects.toThrow(/failed \(401\)/);
        expect(puts).toEqual(["stale", "stale"]);
        expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });

    it("re-establishes the session for a background upload too, which then lands rather than waiting in the queue", async () => {
        const { http, puts } = staleSession();
        const bytes = new Map<string, Uint8Array>();
        const cache: ShardByteCache = { get: async (h) => bytes.get(h) ?? null, put: async (h, b) => void bytes.set(h, b) };
        const deferred: string[] = [];
        const shards = new ShardClient({
            baseUrl: BASE_URL,
            fetch: http.fetch,
            fetchWithRecovery: http.fetchWithRecovery,
            cache,
            backgroundUpload: true,
            deferUpload: async (h) => void deferred.push(h),
        });
        await shards.putShard(HASH, new Uint8Array([4, 5]));
        await vi.waitFor(() => expect(puts).toEqual(["stale", "fresh"]));
        expect(deferred).toEqual([]);
    });

    it("reads keep the plain fetch: a read never re-authenticates", async () => {
        const { http, onUnauthorized } = staleSession();
        const shards = new ShardClient({ baseUrl: BASE_URL, fetch: http.fetch, fetchWithRecovery: http.fetchWithRecovery });
        await shards.hasShard(HASH);
        expect(onUnauthorized).not.toHaveBeenCalled();
    });
});

describe("every upload path re-establishes a stale session", () => {
    const FILE = new Uint8Array(Array.from({ length: 64 }, (_, i) => i));

    it("a files-only Space (client.vfs's content space)", async () => {
        const { http, session, puts, onUnauthorized } = staleSession();
        const ns = new SpaceNamespace({ http, session: session as never, wsBaseUrl: "ws://test" });
        const space = await ns.get("space-files", "static", { messaging: false });
        await space.putFile(FILE, { name: "a.bin", type: "application/octet-stream" });
        expectRecovered(puts, onUnauthorized);
    });

    it("a Space with messaging", async () => {
        const { http, session, puts, onUnauthorized } = staleSession();
        let blob: WrappedPayload | null = null;
        const store: ChatKeyStore = { async get() { return blob; }, async put(_k, v) { blob = v; } };
        const ns = new SpaceNamespace({ http, session: session as never, wsBaseUrl: "ws://test", chatKeys: new ChatKeyVault(store) });
        const space = await ns.get("space-chat");
        await space.putFile(FILE, { name: "a.bin", type: "application/octet-stream" });
        expectRecovered(puts, onUnauthorized);
    });

    it("a room (client.message.room)", async () => {
        const { http, session, puts, onUnauthorized } = staleSession();
        const messages = new MessageNamespace({ http, session: session as never, wsBaseUrl: "ws://test" });
        await messages.room("general").putFile(FILE, { name: "a.bin", type: "application/octet-stream" });
        expectRecovered(puts, onUnauthorized);
    });

    it("client.storage.writeFile", async () => {
        const { http, session, puts, onUnauthorized } = staleSession();
        const kv = new KvNamespace({ http, session: session as never, wsBaseUrl: "ws://test" });
        const storage = new StorageNamespace({ http, baseUrl: BASE_URL, kv });
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});   // the discovery mirror needs an identity
        try {
            await storage.writeFile({ spaceId: "space-1", data: FILE, metadata: { name: "a.bin", type: "application/octet-stream" } });
        } finally {
            warn.mockRestore();
        }
        expectRecovered(puts, onUnauthorized);
    });
});

describe("the offline queue's replay of a deferred upload", () => {
    beforeEach(() => {
        globalThis.indexedDB = new IDBFactory();
        // The Cache API, in memory: the replay reads the deferred bytes from it.
        const cached = new Map<string, Uint8Array>();
        vi.stubGlobal("caches", {
            open: async () => ({
                match: async (key: string) => (cached.has(key) ? new Response(cached.get(key) as BodyInit) : undefined),
                put: async (key: string, res: Response) => void cached.set(key, new Uint8Array(await res.arrayBuffer())),
            }),
        });
    });
    afterEach(() => vi.unstubAllGlobals());

    it("re-establishes the session and sends the upload, rather than leaving it queued", async () => {
        const puts: Array<string | null> = [];
        const client = new Client({
            baseUrl: BASE_URL,
            apiKey: "mk_test_pk_x",
            offline: { enabled: true, store: new IndexedDbStore() },
            fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
                const sent = new Headers(init?.headers).get("X-Muhkoo-Session");
                if ((init?.method ?? "GET") === "PUT" && String(input).includes("/api/shards/")) {
                    puts.push(sent);
                    if (sent !== "fresh") return json({ error: "A signed-in session is required", code: "session_required" }, 401);
                    return json({ ok: true, dedup: false });
                }
                return json({ ok: true });
            }) as typeof fetch,
        });
        const session = (client as unknown as { session: SessionState }).session;
        await session.setSession({ token: "stale", username: "alice", commitment: "c-alice" });
        vi.spyOn(client.auth.zk, "recover").mockImplementation(async () => {
            await session.setSession({ token: "fresh", username: "alice", commitment: "c-alice" });
            return true;
        });
        try {
            await client.offline.fileCache!.put(HASH, new Uint8Array([9, 9]));
            await client.offline.enqueue({ hlc: pack(1, 0, "n"), clientId: "c1", domain: "file", method: "putShard", args: { hash: HASH } });

            await client.offline.queue.drain();

            expect(puts).toEqual(["stale", "fresh"]);
            expect(await client.offline.queue.pending()).toBe(0);
        } finally {
            client.offline.dispose();
        }
    });
});
```

- [ ] **Step 2: Run them to verify they fail.**

Run: `cd /Users/matt/GitHub/muhkoo/connect && npx vitest --run tests/storage/shard-session-recovery.test.ts`

Expected: FAIL, `8 failed | 1 passed (9)`. Each upload fails with `ShardClient.putShard(…) failed (401): {"error":"A signed-in session is required","code":"session_required"}`, or its `puts` is `[ 'stale' ]`. "reads keep the plain fetch" passes already.

- [ ] **Step 3: `ShardClient` sends PUTs through `fetchWithRecovery`.**

In `src/storage/transport/ShardClient.ts`, replace:

```ts
     * Provided so callers can inject retries / auth / instrumentation.
     */
    fetch?: typeof fetch;
```

with:

```ts
     * Provided so callers can inject retries / auth / instrumentation.
     */
    fetch?: typeof fetch;
    /**
     * The same fetch with the client's silent re-authentication
     * (`HttpClient.fetchWithRecovery`), used for uploads only. A paid-only
     * app refuses a PUT made with a dead session with `401 session_required`;
     * through this, the session is re-established once and the PUT sent
     * again, which is safe because its bytes can be sent twice. Reads keep
     * {@link fetch}. Defaults to {@link fetch}.
     */
    fetchWithRecovery?: typeof fetch;
```

In `src/storage/transport/ShardClient.ts`, replace:

```ts
    private readonly fetchFn: typeof fetch;
    private readonly cache?: ShardByteCache;
```

with:

```ts
    private readonly fetchFn: typeof fetch;
    /** What a PUT goes through: {@link ShardClientOptions.fetchWithRecovery} when given, else {@link fetchFn}. */
    private readonly putFn: typeof fetch;
    private readonly cache?: ShardByteCache;
```

In `src/storage/transport/ShardClient.ts`, replace:

```ts
        this.fetchFn = f.bind(globalThis);
        this.cache = opts.cache;
```

with:

```ts
        this.fetchFn = f.bind(globalThis);
        this.putFn = opts.fetchWithRecovery ?? this.fetchFn;
        this.cache = opts.cache;
```

In `src/storage/transport/ShardClient.ts`, replace:

```ts
            response = await this.fetchFn(url, {
                method: "PUT",
```

with:

```ts
            response = await this.putFn(url, {
                method: "PUT",
```

In `src/storage/transport/ShardClient.ts`, replace:

```ts
        const response = await this.fetchFn(url, {
            method: "PUT",
```

with:

```ts
        const response = await this.putFn(url, {
            method: "PUT",
```

- [ ] **Step 4: `Space` takes it and hands it to its `ShardClient`.**

In `src/spaces/Space.ts`, replace:

```ts
    /** Header-injecting fetch from the client's HttpClient. */
    fetch: typeof fetch;
    /** Resolves the user id used for the ratchet / member id (signed-in username). */
```

with:

```ts
    /** Header-injecting fetch from the client's HttpClient. */
    fetch: typeof fetch;
    /**
     * The same fetch with the client's silent 401 recovery (`HttpClient.fetchWithRecovery`). File uploads
     * use it, so a PUT made with a dead session re-establishes the session once instead of failing.
     * Defaults to {@link fetch}.
     */
    fetchWithRecovery?: typeof fetch;
    /** Resolves the user id used for the ratchet / member id (signed-in username). */
```

In `src/spaces/Space.ts`, replace:

```ts
            pathPrefix: "/api/shards",
            fetch: this.deps.fetch,
```

with:

```ts
            pathPrefix: "/api/shards",
            fetch: this.deps.fetch,
            fetchWithRecovery: this.deps.fetchWithRecovery,
```

- [ ] **Step 5: Every construction site passes it.**

In `src/core/namespaces/SpaceNamespace.ts`, replace:

```ts
                fetch: this.deps.http.fetch,
                myId: () => memberId,
```

with:

```ts
                fetch: this.deps.http.fetch,
                fetchWithRecovery: this.deps.http.fetchWithRecovery,
                myId: () => memberId,
```

In `src/core/namespaces/SpaceNamespace.ts`, replace:

```ts
            fetch: this.deps.http.fetch,
            myId: () => memberId,
```

with:

```ts
            fetch: this.deps.http.fetch,
            fetchWithRecovery: this.deps.http.fetchWithRecovery,
            myId: () => memberId,
```

In `src/core/namespaces/MessageNamespace.ts`, replace:

```ts
            fetch: this.deps.http.fetch,
            myId: () => this.myId(),
```

with:

```ts
            fetch: this.deps.http.fetch,
            fetchWithRecovery: this.deps.http.fetchWithRecovery,
            myId: () => this.myId(),
```

In `src/core/namespaces/FileNamespace.ts`, replace:

```ts
                pathPrefix: "/api/shards",
                fetch: this.deps.http.fetch,
```

with:

```ts
                pathPrefix: "/api/shards",
                fetch: this.deps.http.fetch,
                fetchWithRecovery: this.deps.http.fetchWithRecovery,
```

In `src/core/Client.ts`, replace:

```ts
                fetch: this.http.fetch,
                cache: this.offline.fileCache,
```

with:

```ts
                fetch: this.http.fetch,
                fetchWithRecovery: this.http.fetchWithRecovery,
                cache: this.offline.fileCache,
```

- [ ] **Step 6: Run the tests to verify they pass.**

Run: `cd /Users/matt/GitHub/muhkoo/connect && npx vitest --run tests/storage/shard-session-recovery.test.ts`

Expected: PASS, `9 passed (9)`.

- [ ] **Step 7: Regression suites, types and lint.**

Run: `cd /Users/matt/GitHub/muhkoo/connect && yarn test:unit 2>&1 | grep -E "Test Files|Tests " && yarn typecheck && npx eslint src/storage/transport/ShardClient.ts src/core/namespaces/SpaceNamespace.ts src/core/namespaces/MessageNamespace.ts src/core/namespaces/FileNamespace.ts src/core/Client.ts && npx eslint src/spaces/Space.ts`

Expected: every test file passes, `tsc` exits 0. The first eslint prints nothing. The second prints one warning, `Unused eslint-disable directive (no problems were reported from 'no-constant-condition')`, which was there before (`Space.ts:778` today; it moves down as lines are added above it), and nothing else.

- [ ] **Step 8: Mutation check** (same procedure as Task 1, Step 8; test file `tests/storage/shard-session-recovery.test.ts`).

| Mutation | `-t` pattern | Tests that must fail (at least) |
|---|---|---|
| `ShardClient`: `this.putFn = this.fetchFn;` | `a PUT with a stale session` | "re-establishes the session once…", "tries once…", "…background upload too…" |
| `uploadToOrigin`: `this.fetchFn(url, {` again | `background upload too` | that test |
| `Space.fileStorage`: drop its `fetchWithRecovery` line | `every upload path` | the two Space tests and the room test |
| `SpaceNamespace` files-only build: drop its `fetchWithRecovery` line | `a files-only Space` | that test |
| `SpaceNamespace` messaging build: drop its `fetchWithRecovery` line | `a Space with messaging` | that test |
| `MessageNamespace.room`: drop its `fetchWithRecovery` line | `a room` | that test |
| `FileNamespace.shards`: drop its `fetchWithRecovery` line | `client.storage.writeFile` | that test |
| `Client` replay: drop its `fetchWithRecovery` line | `rather than leaving it queued` | that test |

Verified on a scratch copy: all eight killed.

- [ ] **Step 9: Checkpoint for Matt (no commit).**

Run: `sh <scratchpad>/bs-baseline/changed.sh`

Expected: the files of Tasks 1–3, plus `src/core/Client.ts`, `src/core/namespaces/FileNamespace.ts`, `src/core/namespaces/MessageNamespace.ts`, `src/core/namespaces/SpaceNamespace.ts`, `src/spaces/Space.ts` and `tests/storage/shard-session-recovery.test.ts`, then `released CHANGELOG sections: unchanged`. Do not stage, commit or stash.

---

### Task 5: One commit helper; `client.vfs` references without the content space (D12)

Two changes share one helper. The commit and release body and its three tries move out of `Space.commitShards` (`Space.ts:931-949`) into `commitManifest`, unchanged on the wire, so the accelerator's reference ledger keys stay the same.
- `Space` calls it through `fetchWithRecovery`, so a commit made with a stale session (`storage.ts:181-184` refuses it with 401) is re-established once instead of being tried three times with the same token, then dropped with a warning.
- A 401 that survives that recovery ends the tries at once. Through `fetchWithRecovery`, each try that gets a 401 runs the recovery again (`HttpClient.ts:162-169`), so without the stop a session that cannot be recovered would cost three `auth.zk.recover()` attempts and three `onSessionExpired` calls per commit or release, where today there are none.
- The `client.vfs` content adapter's `retain` and `release` (`Client.ts:379-384`) call it directly, through `this.http.fetchWithRecovery`, instead of `resolveContentSpace()`. Taking or dropping a reference no longer creates the content space. That creation needs the app key and is gated for a Free user (D12 resolution, table row "content-space creation"), so without this Cloud Drive's migration fails for every Free user, and a read-only user's permanent delete releases nothing. `write` keeps creating the space lazily.

**Files:**
- Create: `src/storage/transport/storageCommit.ts`
- Modify: `src/spaces/Space.ts:25` (import), `:931-949` (`commitShards`)
- Modify: `src/core/Client.ts:59` (import), `:379-384` (the adapter's `release` and `retain`)
- Test: `tests/storage/storage-commit.test.ts` (create), `tests/client/vfs-references.test.ts` (create)

**Interfaces:**
- Consumes: `SpaceDeps.fetchWithRecovery?` (Task 4); `HttpClient.fetchWithRecovery`.
- Produces: `async function commitManifest(fetchFn: typeof fetch, httpBaseUrl: string, manifest: FileManifest, action: "commit" | "release"): Promise<void>`, internal. Plan C relies on the behaviour: `vfs.writeManifest`, `vfs.retainManifest`, `vfs.delete` and a `vcs` checkout make no `/api/spaces/*` request and write no `vfs/space`.

- [ ] **Step 1: Write the failing tests.**

Create `tests/storage/storage-commit.test.ts`:

```ts
/**
 * `POST /api/storage/commit` and `/release` (accelerator spec 2026-10-06-paid-accounts-and-past-due, B8
 * and the D12 mechanism). One helper sends them for `Space` and for `client.vfs`. Its body is a wire
 * contract: the accelerator keys its reference ledger on it, so a commit sent in another shape would take
 * a second reference instead of finding the first.
 */
import { describe, it, expect, vi } from "vitest";
import { HttpClient } from "../../src/core/HttpClient";
import { SpaceNamespace } from "../../src/core/namespaces/SpaceNamespace";
import { commitManifest } from "../../src/storage/transport/storageCommit";
import type { FileManifest } from "../../src/storage/types";

const BASE_URL = "http://test";

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const MANIFEST = {
    id: "m1",
    name: "a.txt",
    size: 5,
    type: "text/plain",
    lastModified: 0,
    createdAt: 0,
    version: 1,
    chunks: [
        { shardHashes: ["h1", "h2"] },
        { shardHashes: ["h3"] },
    ],
} as unknown as FileManifest;

describe("commitManifest — the wire", () => {
    it.each(["commit", "release"] as const)("POSTs /api/storage/%s with { hashes, bytes } and nothing else", async (action) => {
        const sent: Array<{ url: string; method?: string; body: unknown }> = [];
        const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
            sent.push({ url: String(input), method: init?.method, body: init?.body });
            return json({ ok: true });
        }) as typeof fetch;

        await commitManifest(fetchFn, BASE_URL, MANIFEST, action);

        expect(sent).toEqual([
            { url: `${BASE_URL}/api/storage/${action}`, method: "POST", body: '{"hashes":["h1","h2","h3"],"bytes":5}' },
        ]);
    });

    it("sends nothing for a manifest with no shards", async () => {
        const fetchFn = vi.fn(async () => json({ ok: true }));
        await commitManifest(fetchFn as never, BASE_URL, { ...MANIFEST, chunks: [] } as FileManifest, "commit");
        expect(fetchFn).not.toHaveBeenCalled();
    });
});

describe("Space — a commit or release with a stale session", () => {
    /** Shard PUTs are accepted with any session, as today; commit and release refuse the stale one with 401. */
    function staleCommits() {
        const session = { username: "alice", seed: new Uint8Array(32).fill(7), commitment: "c-alice", token: "stale" };
        const commits: Array<{ action: string; token: string | null }> = [];
        const onUnauthorized = vi.fn(async () => {
            session.token = "fresh";
            return true;
        });
        const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const token = new Headers(init?.headers).get("X-Muhkoo-Session");
            const action = url.match(/\/api\/storage\/(commit|release)$/)?.[1];
            if (action) {
                commits.push({ action, token });
                if (token !== "fresh") return json({ error: "A signed-in session is required" }, 401);
            }
            return json({ ok: true, dedup: false });
        }) as typeof fetch;
        const http = new HttpClient({ baseUrl: BASE_URL, getSessionToken: () => session.token, fetch: fetchFn, onUnauthorized });
        const ns = new SpaceNamespace({ http, session: session as never, wsBaseUrl: "ws://test" });
        return { ns, commits, onUnauthorized };
    }

    it("re-establishes the session once and commits a new file, without the three blind retries", async () => {
        const { ns, commits, onUnauthorized } = staleCommits();
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
            const space = await ns.get("space-files", "static", { messaging: false });
            await space.putFile(new Uint8Array([1, 2, 3, 4]), { name: "a.bin", type: "application/octet-stream" });
            expect(commits).toEqual([
                { action: "commit", token: "stale" },
                { action: "commit", token: "fresh" },
            ]);
            expect(onUnauthorized).toHaveBeenCalledTimes(1);
            expect(warn).not.toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });

    it("re-establishes the session once and releases a file", async () => {
        const { ns, commits } = staleCommits();
        const space = await ns.get("space-files", "static", { messaging: false });
        await space.releaseFile(MANIFEST);
        expect(commits).toEqual([
            { action: "release", token: "stale" },
            { action: "release", token: "fresh" },
        ]);
    });

    it("gives up after one 401 that re-establishing the session did not fix", async () => {
        // Each further try would ask for a new session again, and tell the app again that it expired.
        const { ns, commits, onUnauthorized } = staleCommits();
        onUnauthorized.mockImplementation(async () => false);   // the session cannot be re-established
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
            const space = await ns.get("space-files", "static", { messaging: false });
            await space.releaseFile(MANIFEST);
            expect(commits).toEqual([{ action: "release", token: "stale" }]);
            expect(onUnauthorized).toHaveBeenCalledTimes(1);
            expect(warn).toHaveBeenCalledTimes(1);
        } finally {
            warn.mockRestore();
        }
    });
});
```

Create `tests/client/vfs-references.test.ts`:

```ts
/**
 * `client.vfs` takes and drops references without the content space (accelerator spec
 * 2026-10-06-paid-accounts-and-past-due, D12). Taking a reference (`writeManifest`, `retainManifest`,
 * a checkout, Cloud Drive's move of pre-VFS files) and dropping one (a delete) name only shards, so they
 * need no Space. Before, they opened the content space, and created it for a user who had never written
 * a VFS file. On a paid-only app that creation is a write the gate refuses for a Free user, so Cloud
 * Drive's migration failed for them, and so did a permanent delete's release.
 */
import { describe, it, expect, vi } from "vitest";
import { Client } from "../../src/core/Client";
import { SessionState } from "../../src/core/Session";
import { SpaceNamespace } from "../../src/core/namespaces/SpaceNamespace";
import { HttpClient } from "../../src/core/HttpClient";
import type { FileManifest } from "../../src/storage/types";

const BASE_URL = "http://test";

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * The accelerator's personal KV in a map, plus every other route answering `{ ok: true }`. `requests`
 * lists `METHOD /path` for every request; `bodies` holds each storage commit or release body.
 */
function accelerator() {
    const kv = new Map<string, unknown>();
    const requests: string[] = [];
    const bodies: Array<{ action: string; body: unknown }> = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        requests.push(`${method} ${url.pathname}`);
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        const key = url.pathname.match(/^\/api\/personal\/[^/]+\/kv\/([^/]+)(\/get)?$/);
        if (key) {
            const name = decodeURIComponent(key[1]);
            if (key[2]) return json({ key: name, value: kv.get(name) ?? null });
            if (method === "DELETE") return json({ ok: true, existed: kv.delete(name) });
            kv.set(name, body.value);
            return json({ ok: true });
        }
        if (/^\/api\/personal\/[^/]+\/list$/.test(url.pathname)) {
            const prefix: string = body.prefix ?? "";
            return json({ keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).sort(), cursor: null });
        }
        const storage = url.pathname.match(/^\/api\/storage\/(commit|release)$/);
        if (storage) bodies.push({ action: storage[1], body });
        return json({ ok: true, dedup: false });
    }) as typeof fetch;
    return { kv, requests, bodies, fetchFn };
}

/** A signed-in, unlocked Client over `fetchFn`. */
async function signedIn(fetchFn: typeof fetch): Promise<Client> {
    const client = new Client({ baseUrl: BASE_URL, apiKey: "mk_test_pk_x", fetch: fetchFn, offline: { enabled: false } });
    const session = (client as unknown as { session: SessionState }).session;
    await session.setSession({ token: "tok", username: "alice", commitment: "c-alice" });
    session.setSeed(new Uint8Array(32).fill(3));
    return client;
}

/** A real manifest, as an earlier upload left it: written through a files-only Space over a server that accepts it. */
async function uploadedManifest(): Promise<FileManifest> {
    const http = new HttpClient({ baseUrl: BASE_URL, fetch: (async () => json({ ok: true, dedup: false })) as typeof fetch });
    const ns = new SpaceNamespace({ http, session: { username: "alice", seed: null, commitment: "c-alice", token: "tok" } as never, wsBaseUrl: "ws://test" });
    const space = await ns.get("earlier-space", "static", { messaging: false });
    return (await space.putFile(new Uint8Array([104, 105]), { name: "old.txt", type: "text/plain" })).manifest;
}

const spaceRequests = (requests: string[]) => requests.filter((r) => r.includes("/api/spaces"));
const hashesOf = (m: FileManifest) => m.chunks.flatMap((c) => c.shardHashes);

describe("client.vfs — references without the content space", () => {
    it("writeManifest takes its reference without creating the content space", async () => {
        const server = accelerator();
        const client = await signedIn(server.fetchFn);
        const manifest = await uploadedManifest();

        await client.vfs.writeManifest("/Drive/old.txt", manifest, manifest.size);

        expect(spaceRequests(server.requests)).toEqual([]);
        expect(server.kv.has("vfs/space")).toBe(false);
        expect(server.bodies).toEqual([{ action: "commit", body: { hashes: hashesOf(manifest), bytes: manifest.size } }]);
        expect((await client.vfs.statManifest("/Drive/old.txt")).manifest).toEqual(manifest);
    });

    it("retainManifest takes its reference without creating the content space", async () => {
        const server = accelerator();
        const client = await signedIn(server.fetchFn);
        const manifest = await uploadedManifest();

        await client.vfs.retainManifest(manifest);

        expect(spaceRequests(server.requests)).toEqual([]);
        expect(server.kv.has("vfs/space")).toBe(false);
        expect(server.bodies).toEqual([{ action: "commit", body: { hashes: hashesOf(manifest), bytes: manifest.size } }]);
    });

    it("a delete lets go of its file without creating the content space", async () => {
        // The file's record is there, as a migration or an earlier version left it, but no content space
        // is: a fresh Client, so nothing about a space is cached in it.
        const server = accelerator();
        const manifest = await uploadedManifest();
        await (await signedIn(server.fetchFn)).vfs.writeManifest("/Drive/old.txt", manifest, manifest.size);
        server.kv.delete("vfs/space");
        server.requests.length = 0;
        server.bodies.length = 0;
        const client = await signedIn(server.fetchFn);

        await client.vfs.delete("/Drive/old.txt");

        expect(spaceRequests(server.requests)).toEqual([]);
        expect(server.kv.has("vfs/space")).toBe(false);
        expect(server.bodies).toEqual([{ action: "release", body: { hashes: hashesOf(manifest), bytes: manifest.size } }]);
    });

    it("takes a reference through a stale session by re-establishing it once", async () => {
        const server = accelerator();
        const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const stale = new Headers(init?.headers).get("X-Muhkoo-Session") !== "fresh";
            if (stale && String(input).endsWith("/api/storage/commit")) return json({ error: "A signed-in session is required" }, 401);
            return server.fetchFn(input, init);
        }) as typeof fetch;
        const client = await signedIn(fetchFn);
        const session = (client as unknown as { session: SessionState }).session;
        const recover = vi.spyOn(client.auth.zk, "recover").mockImplementation(async () => {
            await session.setSession({ token: "fresh", username: "alice", commitment: "c-alice" });
            return true;
        });
        const manifest = await uploadedManifest();

        await client.vfs.retainManifest(manifest);

        expect(recover).toHaveBeenCalledTimes(1);
        expect(server.bodies).toEqual([{ action: "commit", body: { hashes: hashesOf(manifest), bytes: manifest.size } }]);
    });

    it("the first write of new bytes still creates the content space, once", async () => {
        // A guard: it passes before and after this change, which must not move the space's creation.
        const server = accelerator();
        const client = await signedIn(server.fetchFn);

        await client.vfs.writeFile("/Drive/a.txt", "hello");
        await client.vfs.writeFile("/Drive/b.txt", "world");

        const created = server.requests.filter((r) => /^POST \/api\/spaces\/[^/]+\/metadata$/.test(r));
        expect(created).toHaveLength(1);
        expect(typeof server.kv.get("vfs/space")).toBe("string");
        expect(server.bodies.map((b) => b.action)).toEqual(["commit", "commit"]);
    });
});
```

- [ ] **Step 2: Run them to verify they fail.**

Run: `cd /Users/matt/GitHub/muhkoo/connect && npx vitest --run tests/storage/storage-commit.test.ts tests/client/vfs-references.test.ts`

Expected: FAIL.
- `storage-commit.test.ts` does not load: `Cannot find module '../../src/storage/transport/storageCommit'`.
- `vfs-references.test.ts`: `4 failed | 1 passed (5)`. Three fail on a `POST /api/spaces/<id>/metadata` in `spaceRequests`; "takes a reference through a stale session…" fails because `recover` was never called (it takes about 2.4 seconds: the three blind tries). "the first write of new bytes still creates the content space, once" passes: it is a guard that this change must not move the space's creation.

- [ ] **Step 3: Create the helper.**

Create `src/storage/transport/storageCommit.ts`:

```ts
/**
 * `POST /api/storage/commit` and `/api/storage/release`: take or drop a
 * reference to a manifest's shards.
 *
 * The commit is what meters a file's bytes to the app and reference-counts
 * its shards, so garbage collection keeps them; the release drops that
 * reference. The body is `{ hashes, bytes }` and nothing else. The accelerator
 * keys its reference ledger on the caller, the app, the bytes and the sorted
 * hashes, so this body must not change: a commit sent in another shape would
 * take a second reference instead of finding the first.
 *
 * Shared by `Space` (`putFile`, `commitFile`, `releaseFile`) and by
 * `client.vfs`, which takes and drops references here directly. A reference
 * names only shards and needs no Space; opening the content space to take one
 * created that space for a user who had never written a file, which a
 * paid-only app refuses for a Free user (accelerator spec
 * 2026-10-06-paid-accounts-and-past-due, D12).
 *
 * Internal: not re-exported from any barrel.
 */

import type { FileManifest } from "../types";

/**
 * Commit or release `manifest`'s shards through `fetchFn`, which should be
 * `HttpClient.fetchWithRecovery`, so a dead session is re-established once
 * rather than refused three times. Best-effort: tries three times, or once
 * for a 401, then warns and returns, without failing the caller's write.
 */
export async function commitManifest(
    fetchFn: typeof fetch,
    httpBaseUrl: string,
    manifest: FileManifest,
    action: "commit" | "release",
): Promise<void> {
    const hashes = manifest.chunks.flatMap((c) => c.shardHashes);
    if (hashes.length === 0) return;
    const body = JSON.stringify({ hashes, bytes: manifest.size });
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const res = await fetchFn(`${httpBaseUrl}/api/storage/${action}`, {
                method: "POST", headers: { "Content-Type": "application/json" }, body,
            });
            if (res.ok) return;
            // A 401 that `fetchFn`'s recovery could not fix. Another try
            // would only run that recovery again (`auth.zk.recover()`, and
            // `onSessionExpired` for the app) and be refused again.
            if (res.status === 401) break;
        } catch { /* retry */ }
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
    // Best-effort: a missed commit leaves the shards to orphan-GC (still not
    // durable-unmetered long-term); a missed release just delays GC. Reconciled
    // by the platform sweep. Don't fail the caller's write on a metering hiccup.
    console.warn(`[muhkoo] storage ${action} did not confirm for ${hashes.length} shard(s)`);
}
```

- [ ] **Step 4: `Space` commits through it, with recovery.**

In `src/spaces/Space.ts`, replace:

```ts
import { ShardClient, type ShardByteCache, type PeerBlockSource } from "../storage/transport/ShardClient";
```

with:

```ts
import { ShardClient, type ShardByteCache, type PeerBlockSource } from "../storage/transport/ShardClient";
import { commitManifest } from "../storage/transport/storageCommit";
```

In `src/spaces/Space.ts`, replace:

```ts
    /** Commit/release a manifest's shards with the accelerator (metering + refcount). */
    private async commitShards(manifest: FileManifest, action: "commit" | "release"): Promise<void> {
        const hashes = manifest.chunks.flatMap((c) => c.shardHashes);
        if (hashes.length === 0) return;
        const body = JSON.stringify({ hashes, bytes: manifest.size });
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const res = await this.deps.fetch(`${this.deps.httpBaseUrl}/api/storage/${action}`, {
                    method: "POST", headers: { "Content-Type": "application/json" }, body,
                });
                if (res.ok) return;
            } catch { /* retry */ }
            await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        }
        // Best-effort: a missed commit leaves the shards to orphan-GC (still not
        // durable-unmetered long-term); a missed release just delays GC. Reconciled
        // by the platform sweep. Don't fail the caller's write on a metering hiccup.
        console.warn(`[muhkoo] storage ${action} did not confirm for ${hashes.length} shard(s)`);
    }
```

with:

```ts
    /** Commit/release a manifest's shards with the accelerator (metering + refcount). */
    private async commitShards(manifest: FileManifest, action: "commit" | "release"): Promise<void> {
        // Through the client's 401 recovery when there is one: the commit refuses
        // a dead session with 401, and three tries with the same token only
        // delayed the warning.
        await commitManifest(this.deps.fetchWithRecovery ?? this.deps.fetch, this.deps.httpBaseUrl, manifest, action);
    }
```

- [ ] **Step 5: The VFS adapter takes and drops references without the content space.**

In `src/core/Client.ts`, replace:

```ts
import { ShardClient } from "../storage/transport/ShardClient";
```

with:

```ts
import { ShardClient } from "../storage/transport/ShardClient";
import { commitManifest } from "../storage/transport/storageCommit";
```

In `src/core/Client.ts`, replace:

```ts
                release: async (manifest) => {
                    await (await resolveContentSpace()).releaseFile(manifest);
                },
                retain: async (manifest) => {
                    await (await resolveContentSpace()).commitFile(manifest);
                },
```

with:

```ts
                // A reference names only shards, so taking or dropping one needs
                // no Space. Opening the content space here created it for a user
                // who had never written a file: a checkout, a copy, a delete, or
                // Cloud Drive's move of its pre-VFS files. A paid-only app refuses
                // that creation for a Free user (accelerator spec
                // 2026-10-06-paid-accounts-and-past-due, D12). Same body as
                // `Space.commitFile`, so it is the same reference.
                release: (manifest) => commitManifest(this.http.fetchWithRecovery, this.baseUrl, manifest, "release"),
                retain: (manifest) => commitManifest(this.http.fetchWithRecovery, this.baseUrl, manifest, "commit"),
```

- [ ] **Step 6: Run the tests to verify they pass.**

Run: `cd /Users/matt/GitHub/muhkoo/connect && npx vitest --run tests/storage/storage-commit.test.ts tests/client/vfs-references.test.ts tests/spaces tests/vfs tests/vcs`

Expected: PASS, every file. `tests/spaces/Space.locked.test.ts` › "client.vfs reaches its content Space with the chat-key vault down" still passes: its release now goes straight to `/api/storage/release`. Its name speaks of the content Space; leave it as it is (not this plan's file).

- [ ] **Step 7: Regression suites, types and lint.**

Run: `cd /Users/matt/GitHub/muhkoo/connect && yarn test:unit 2>&1 | grep -E "Test Files|Tests " && yarn typecheck && npx eslint src/storage/transport/storageCommit.ts src/core/Client.ts`

Expected: every test file passes, `tsc` exits 0, eslint prints nothing.

- [ ] **Step 8: Mutation check** (same procedure as Task 1, Step 8).

| Mutation | Test file, `-t` pattern | Tests that must fail (at least) |
|---|---|---|
| `storageCommit.ts`: `JSON.stringify({ hashes, bytes: manifest.size, action })` | `storage-commit`, `the wire` | both "POSTs /api/storage/… with { hashes, bytes } and nothing else" |
| `Space.commitShards`: `commitManifest(this.deps.fetch, …` | `storage-commit`, `stale session` | the three Space tests |
| `storageCommit.ts`: drop `if (res.status === 401) break;` | `storage-commit`, `gives up after one 401` | that test |
| `Client` `retain`: `async (manifest) => { await (await resolveContentSpace()).commitFile(manifest); }` | `vfs-references`, `Manifest takes its reference` | "writeManifest …", "retainManifest …" |
| `Client` `release`: `async (manifest) => { await (await resolveContentSpace()).releaseFile(manifest); }` | `vfs-references`, `a delete lets go` | that test |
| `Client` `retain`: `commitManifest(this.http.fetch, …` | `vfs-references`, `stale session` | "takes a reference through a stale session…" |

Verified on a scratch copy: all six killed.

- [ ] **Step 9: Checkpoint for Matt (no commit).**

Run: `sh <scratchpad>/bs-baseline/changed.sh`

Expected: the files of Tasks 1–4, plus `src/storage/transport/storageCommit.ts`, `tests/client/vfs-references.test.ts` and `tests/storage/storage-commit.test.ts`, then `released CHANGELOG sections: unchanged`. Do not stage, commit or stash.

---

### Task 6: `client.app.access()`

A new `app` namespace on `Client` (spec B8). `access()` is `GET /api/app/access` through `HttpClient.get`, so it carries the app key and the session and takes the usual one re-authentication on a 401. It reads the answer defensively (Cross-plan contracts, choices 4 and 5). On each `allowed: true` it calls `client.offline.resume()` and does not wait for it; a failure there is caught, and the queue tries again at the next reconnect.

**Files:**
- Create: `src/core/namespaces/AppNamespace.ts`
- Modify: `src/core/Client.ts:38` (import), `:185-186` (the `app` field), `:458` (construction)
- Test: `tests/client/app-access.test.ts` (create)

**Interfaces:**
- Consumes: `isPaymentRequiredCode`, `absoluteHttpUrl`, `PaymentRequiredCode` (Task 1); `OfflineManager.resume()` (Task 2); `HttpClient.get`.
- Produces, used by Task 7 and by plan C:
  - `interface AppAccess { paidAccountsOnly: boolean; allowed: boolean; reason?: PaymentRequiredCode; upgradeUrl?: string }`;
  - `interface AppNamespaceDeps { http: HttpClient; onAllowed?: () => Promise<void> }`;
  - `class AppNamespace { constructor(deps: AppNamespaceDeps); access(): Promise<AppAccess> }`;
  - `Client.app: AppNamespace`.

- [ ] **Step 1: Write the failing tests.**

Create `tests/client/app-access.test.ts`:

```ts
/**
 * `client.app.access()` (accelerator spec 2026-10-06-paid-accounts-and-past-due, B6 and B8): whether the
 * signed-in user may add data in this app, over `GET /api/app/access`, and the replay of the writes the
 * offline queue kept after a refusal for payment once the answer is "allowed".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { Client } from "../../src/core/Client";
import { HttpError } from "../../src/core/HttpClient";
import { SessionState } from "../../src/core/Session";
import { PaymentRequiredError } from "../../src/core/PaymentRequiredError";
import { IndexedDbStore } from "../../src/offline/store/IndexedDbStore";
import { pack } from "../../src/offline/clock/HlcTimestamp";

const BASE_URL = "http://test";
const UPGRADE = "https://portal.staging.muhkoo.dev/upgrade?return=https%3A%2F%2Fcloud-drive.apps.staging.muhkoo.dev";

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
});

/** A signed-in Client whose accelerator answers `GET /api/app/access` from `answers`, in turn. */
async function signedIn(answers: Array<{ status?: number; body: unknown }>, offline = false) {
    const asked: Array<{ method: string; url: string; key: string | null; session: string | null }> = [];
    let i = 0;
    const client = new Client({
        baseUrl: BASE_URL,
        apiKey: "mk_test_pk_x",
        offline: offline ? { enabled: true, store: new IndexedDbStore() } : { enabled: false },
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
            const headers = new Headers(init?.headers);
            asked.push({
                method: init?.method ?? "GET",
                url: String(input),
                key: headers.get("X-Muhkoo-Key"),
                session: headers.get("X-Muhkoo-Session"),
            });
            const answer = answers[Math.min(i++, answers.length - 1)];
            return json(answer.body, answer.status ?? 200);
        }) as typeof fetch,
    });
    const session = (client as unknown as { session: SessionState }).session;
    await session.setSession({ token: "tok", username: "alice", commitment: "c-alice" });
    return { client, session, asked };
}

describe("client.app.access()", () => {
    it("asks GET /api/app/access with the app key and the session, and returns the answer", async () => {
        const answer = { paidAccountsOnly: true, allowed: false, reason: "user_plan_required", upgradeUrl: UPGRADE };
        const { client, asked } = await signedIn([{ body: answer }]);

        expect(await client.app.access()).toEqual(answer);
        expect(asked).toEqual([{ method: "GET", url: `${BASE_URL}/api/app/access`, key: "mk_test_pk_x", session: "tok" }]);
    });

    it.each([
        [{ paidAccountsOnly: true, allowed: true }],
        [{ paidAccountsOnly: false, allowed: true }],
        [{ paidAccountsOnly: false, allowed: false, reason: "owner_payment_past_due" }],
        [{ paidAccountsOnly: true, allowed: false, reason: "user_payment_past_due", upgradeUrl: "https://portal.muhkoo.dev/billing" }],
    ])("returns %o as it came", async (answer) => {
        const { client } = await signedIn([{ body: answer }]);
        expect(await client.app.access()).toEqual(answer);
    });

    it("drops a reason it does not know and a link that is not an absolute http(s) URL", async () => {
        const { client } = await signedIn([{ body: { paidAccountsOnly: true, allowed: false, reason: "some_future_code", upgradeUrl: "javascript:alert(1)" } }]);
        expect(await client.app.access()).toEqual({ paidAccountsOnly: true, allowed: false });
    });

    it("reads an answer without `allowed` as allowed: the server enforces the gate whatever this says", async () => {
        const { client } = await signedIn([{ body: { paidAccountsOnly: true } }]);
        expect(await client.app.access()).toEqual({ paidAccountsOnly: true, allowed: true });
    });

    it("re-establishes a stale session once, as every request does", async () => {
        const { client, asked } = await signedIn([
            { status: 401, body: { error: "Session expired" } },
            { body: { paidAccountsOnly: true, allowed: true } },
        ]);
        const recover = vi.spyOn(client.auth.zk, "recover").mockResolvedValue(true);

        expect(await client.app.access()).toEqual({ paidAccountsOnly: true, allowed: true });
        expect(recover).toHaveBeenCalledTimes(1);
        expect(asked).toHaveLength(2);
    });

    it("throws HttpError against an accelerator older than the route", async () => {
        const { client } = await signedIn([{ status: 404, body: { error: "Not found" } }]);
        const err = await client.app.access().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(HttpError);
        expect(err).not.toBeInstanceOf(PaymentRequiredError);
        expect(err).toMatchObject({ status: 404 });
    });

    it("asks the offline queue to send its kept writes each time the answer is allowed, and only then", async () => {
        const { client } = await signedIn([
            { body: { paidAccountsOnly: true, allowed: false, reason: "user_plan_required", upgradeUrl: UPGRADE } },
            { body: { paidAccountsOnly: true, allowed: false, reason: "user_plan_required", upgradeUrl: UPGRADE } },
            { body: { paidAccountsOnly: true, allowed: true } },
            { body: { paidAccountsOnly: true, allowed: true } },
        ]);
        const resume = vi.spyOn(client.offline, "resume").mockResolvedValue();

        await client.app.access();
        await client.app.access();
        expect(resume).not.toHaveBeenCalled();

        await client.app.access();
        expect(resume).toHaveBeenCalledTimes(1);
        await client.app.access();
        expect(resume).toHaveBeenCalledTimes(2);
    });

    it("answers even when sending the kept writes fails, and leaves no rejection unhandled", async () => {
        const { client } = await signedIn([{ body: { paidAccountsOnly: true, allowed: true } }]);
        // A plain function, not a spy: a spy handles the promises it returns, which would hide a missing catch.
        client.offline.resume = () => Promise.reject(new TypeError("Failed to fetch"));
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => void unhandled.push(reason);
        process.on("unhandledRejection", onUnhandled);
        try {
            expect(await client.app.access()).toEqual({ paidAccountsOnly: true, allowed: true });
            await new Promise((resolve) => setTimeout(resolve, 10));   // let an unhandled rejection surface
        } finally {
            process.off("unhandledRejection", onUnhandled);
        }
        expect(unhandled).toEqual([]);
    });

    it("sends a write the queue kept after a refusal for payment once the app is allowed again", async () => {
        const { client, session } = await signedIn([{ body: { paidAccountsOnly: true, allowed: true } }], true);
        session.setIdentity({} as never);
        let paid = false;
        const sent: number[] = [];
        client.offline.registerReplayer("kv", async (e) => {
            if (!paid) throw new PaymentRequiredError("Cloud Drive is for paid Muhkoo plans.", "user_plan_required");
            sent.push((e.args as { n: number }).n);
        });
        try {
            await client.offline.enqueue({ hlc: pack(1, 0, "n"), clientId: "c1", domain: "kv", method: "set", args: { n: 1 } });
            await client.offline.queue.drain();
            expect(await client.offline.queue.pending()).toBe(1);

            paid = true;
            await client.app.access();

            await vi.waitFor(async () => expect(await client.offline.queue.pending()).toBe(0));
            expect(sent).toEqual([1]);
        } finally {
            client.offline.dispose();
        }
    });

    it("never sends a kept write under the next user's session after a sign-out and sign-in in the same tab", async () => {
        // Plan C's upgrade screen: a Free user's write is kept, they sign out, a paid account signs in.
        const { client, session } = await signedIn([{ body: { paidAccountsOnly: true, allowed: true } }], true);
        session.setIdentity({} as never);
        let paid = false;
        const sentAs: Array<string | null> = [];
        client.offline.registerReplayer("kv", async () => {
            if (!paid) throw new PaymentRequiredError("Cloud Drive is for paid Muhkoo plans.", "user_plan_required");
            sentAs.push(session.commitment);
        });
        try {
            await client.offline.enqueue({ hlc: pack(1, 0, "n"), clientId: "c1", domain: "kv", method: "set", args: { n: 1 } });
            await client.offline.queue.drain();                   // alice's write, refused for payment: kept

            await client.auth.zk.logout();
            await session.setSession({ token: "tok-bob", username: "bob", commitment: "c-bob" });
            session.setIdentity({} as never);
            paid = true;
            await client.app.access();
            await client.offline.resume();                        // let whatever access() started finish

            expect(sentAs).toEqual([]);
            expect(await client.offline.queue.pending()).toBe(1);

            await client.auth.zk.logout();                        // alice comes back
            await session.setSession({ token: "tok", username: "alice", commitment: "c-alice" });
            session.setIdentity({} as never);
            await client.app.access();

            await vi.waitFor(async () => expect(await client.offline.queue.pending()).toBe(0));
            expect(sentAs).toEqual(["c-alice"]);
        } finally {
            client.offline.dispose();
        }
    });
});
```

- [ ] **Step 2: Run them to verify they fail.**

Run: `cd /Users/matt/GitHub/muhkoo/connect && npx vitest --run tests/client/app-access.test.ts`

Expected: FAIL, `13 failed (13)`, with `TypeError: Cannot read properties of undefined (reading 'access')`.

- [ ] **Step 3: Create the namespace.**

Create `src/core/namespaces/AppNamespace.ts`:

```ts
/**
 * `client.app` — what the signed-in user may do in this app (accelerator spec
 * 2026-10-06-paid-accounts-and-past-due, B6 and B8).
 *
 * An app's owner can turn on "Paid Muhkoo accounts only" in the portal. The
 * accelerator then refuses a Free user's writes that add data, with a 402 the
 * SDK throws as `PaymentRequiredError`. Reads, sign-in and deletes still work.
 * The same refusal reaches every user of an app whose owner's payment is past
 * due, whether or not the setting is on.
 *
 * `access()` asks up front, so an app can show the right screen before the
 * first refusal.
 */

import type { HttpClient } from "../HttpClient";
import { absoluteHttpUrl, isPaymentRequiredCode, type PaymentRequiredCode } from "../PaymentRequiredError";

/** The answer of `GET /api/app/access`. */
export interface AppAccess {
    /** The owner has turned on "Paid Muhkoo accounts only" for this app. */
    paidAccountsOnly: boolean;
    /** The signed-in user may add data in this app now. */
    allowed: boolean;
    /**
     * Why not: the code a refused write carries. Read only when `allowed` is
     * false, and only when it is one of the three codes.
     */
    reason?: PaymentRequiredCode;
    /**
     * Where to send the user, as an absolute URL: the portal's upgrade page
     * for `user_plan_required`, with a way back to this app when the request
     * came from one of its registered redirect URIs, or its billing page for
     * `user_payment_past_due`. The accelerator sends it only for those two
     * reasons: the user can do nothing about the owner's payment. Read only
     * when `allowed` is false, and only when it is an absolute http(s) URL.
     */
    upgradeUrl?: string;
}

export interface AppNamespaceDeps {
    http: HttpClient;
    /**
     * Called each time `access()` answers `allowed: true`. The Client sends
     * the writes its offline queue kept after a refusal for payment
     * (`OfflineManager.resume`). Must not throw; a rejection is ignored.
     */
    onAllowed?: () => Promise<void>;
}

export class AppNamespace {
    constructor(private readonly deps: AppNamespaceDeps) {}

    /**
     * Whether the signed-in user may add data in this app and, if not, why
     * and where to send them. Needs the app key and a session; a stale session
     * is re-established once, as for every request. The route is never
     * refused for payment. Throws `HttpError` for anything else, among them a
     * 401 without a session and a 404 from an accelerator older than the
     * route.
     *
     * Each `allowed: true` also sends any writes the offline queue kept after
     * a refusal for payment, without waiting for them. Call it after sign-in,
     * and again when the user comes back from the portal.
     */
    async access(): Promise<AppAccess> {
        const body = await this.deps.http.get<Record<string, unknown> | null>("/api/app/access");
        const access: AppAccess = {
            paidAccountsOnly: body?.paidAccountsOnly === true,
            // Fail open on a malformed answer: the server enforces the gate
            // whatever this says, so a wrong "allowed" costs a refused write,
            // and a wrong "not allowed" would lock the user out for nothing.
            allowed: body?.allowed !== false,
        };
        if (!access.allowed) {
            if (isPaymentRequiredCode(body?.reason)) access.reason = body.reason;
            const upgradeUrl = absoluteHttpUrl(body?.upgradeUrl);
            if (upgradeUrl) access.upgradeUrl = upgradeUrl;
        } else if (this.deps.onAllowed) {
            this.deps.onAllowed().catch(() => {
                // A drain that fails stays queued for the next reconnect.
            });
        }
        return access;
    }
}

export default AppNamespace;
```

- [ ] **Step 4: Wire it into `Client`.**

In `src/core/Client.ts`, replace:

```ts
import { AccessTokensNamespace } from "./namespaces/AccessTokensNamespace";
```

with:

```ts
import { AccessTokensNamespace } from "./namespaces/AccessTokensNamespace";
import { AppNamespace } from "./namespaces/AppNamespace";
```

In `src/core/Client.ts`, replace:

```ts
    /** Access tokens — `client.accessTokens.create(appId, …)`, etc. */
    readonly accessTokens: AccessTokensNamespace;
```

with:

```ts
    /** Access tokens — `client.accessTokens.create(appId, …)`, etc. */
    readonly accessTokens: AccessTokensNamespace;
    /** This app — `client.app.access()`: may the signed-in user add data here? */
    readonly app: AppNamespace;
```

In `src/core/Client.ts`, replace:

```ts
        this.accessTokens = new AccessTokensNamespace({ http: this.http });
```

with:

```ts
        this.accessTokens = new AccessTokensNamespace({ http: this.http });
        // Each "allowed" sends what the offline queue kept after a refusal for
        // payment, without waiting for the next reconnect.
        this.app = new AppNamespace({ http: this.http, onAllowed: () => this.offline.resume() });
```

- [ ] **Step 5: Run the tests to verify they pass.**

Run: `cd /Users/matt/GitHub/muhkoo/connect && npx vitest --run tests/client/app-access.test.ts`

Expected: PASS, `13 passed (13)`.

- [ ] **Step 6: Regression suites, types and lint.**

Run: `cd /Users/matt/GitHub/muhkoo/connect && yarn test:unit 2>&1 | grep -E "Test Files|Tests " && yarn typecheck && npx eslint src/core/namespaces/AppNamespace.ts src/core/Client.ts`

Expected: every test file passes, `tsc` exits 0, eslint prints nothing. `tests/api/export-surface.test.ts` still passes: nothing is exported yet (Task 7).

- [ ] **Step 7: Mutation check** (same procedure as Task 1, Step 8; test file `tests/client/app-access.test.ts`).

| Mutation | `-t` pattern | Tests that must fail (at least) |
|---|---|---|
| `} else if (this.deps.onAllowed && false) {` | `kept writes\|kept after` | "asks the offline queue … and only then", "sends a write the queue kept …" |
| call `onAllowed` before the `if (!access.allowed)`, whatever the answer | `only then` | that test |
| `void this.deps.onAllowed();` in place of the `.catch(…)` | `answers even when` | that test (its `unhandledRejection` listener sees the rejection) |
| `allowed: body?.allowed === true,` | `without .allowed.` | "reads an answer without `allowed` as allowed…" |
| `Client`: `new AppNamespace({ http: this.http })` | `kept writes\|kept after` | the same two as the first row |
| `OutboundQueue.sendable` (Task 2): `return true;` | `next user` | "never sends a kept write under the next user's session…" |

The "answers even when" test replaces `client.offline.resume` with a plain function, not a `vi.spyOn`: a spy attaches handlers to the promises it returns, which hides a missing `catch` (found while planning). Verified on a scratch copy: all six killed.

- [ ] **Step 8: Checkpoint for Matt (no commit).**

Run: `sh <scratchpad>/bs-baseline/changed.sh`

Expected: the files of Tasks 1–5, plus `src/core/namespaces/AppNamespace.ts` and `tests/client/app-access.test.ts`, then `released CHANGELOG sections: unchanged`. Do not stage, commit or stash.

---

### Task 7: The public surface

This is a deliberate public-API addition (spec B8). The new names are pinned in the required-symbol floor first, which fails; then exported; then the two snapshots are regenerated and their diff checked line by line.

`src/api.universal.ts` names the two exports instead of star-exporting the module, so its internal helpers stay off every surface. The module imports only `src/core/HttpError.ts`, which imports nothing, so the workers build's import closure gains no package (the export-surface "no-snarkjs closure" test checks it).

**Files:**
- Modify: `tests/api/export-surface.test.ts:196-198` (`REQUIRED_VALUES`), `:210-212` (`REQUIRED_TYPES`)
- Modify: `src/api.universal.ts:54`, `src/api.ts:74`
- Modify (regenerated, never by hand): `api-surface.txt`, `api-surface.workers.txt`

**Interfaces:**
- Consumes: `PaymentRequiredError`, `PaymentRequiredCode` (Task 1); `AppNamespace`, `AppAccess`, `AppNamespaceDeps` (Task 6).
- Produces: the public names listed in Global Constraints.

- [ ] **Step 1: Pin the new names in the required-symbol floor.**

In `tests/api/export-surface.test.ts`, replace:

```ts
    'AccessTokensNamespace',
    'HostedAuth',
    'HttpClient',
```

with:

```ts
    'AccessTokensNamespace',
    'AppNamespace',
    'HostedAuth',
    'HttpClient',
    'PaymentRequiredError',
```

In `tests/api/export-surface.test.ts`, replace:

```ts
    'VfsStat',
    'AuthUser',
];
```

with:

```ts
    'VfsStat',
    'AuthUser',
    'AppAccess',
    'PaymentRequiredCode',
];
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `cd /Users/matt/GitHub/muhkoo/connect && npx vitest --run tests/api/export-surface.test.ts`

Expected, with `dist/` present (Task 0, Step 4): FAIL, `2 failed | 14 passed (16)`.
- "keeps every headline symbol on the surface of src/browser/index.ts": `REGRESSION — these documented exports vanished from src/browser/index.ts:` listing `AppAccess`, `AppNamespace`, `PaymentRequiredCode`, `PaymentRequiredError`.
- "keeps every headline symbol in dist/connect.d.ts": `REGRESSION — these documented exports are absent from dist/connect.d.ts:`, the same four. `dist/` is the build from before BS; this test keeps failing until Step 6 rebuilds it.

Without `dist/`, the second test and the 4 other artifact tests are skipped: `1 failed | 10 passed | 5 skipped (16)`.

- [ ] **Step 3: Export them.**

In `src/api.universal.ts`, replace:

```ts
// Universal Groth16 verification. Drives bn128.wasm directly, with no snarkjs /
```

with:

```ts
// A write the accelerator refused for payment: a 402 carrying one of three
// codes. Server-side callers of the accelerator, Workers among them, meet it
// too. Its module imports only `./core/HttpError`, which imports nothing, so it
// adds no package to the Workers closure. Named, not starred: the module's
// helpers are internal.
export { PaymentRequiredError } from "./core/PaymentRequiredError";
export type { PaymentRequiredCode } from "./core/PaymentRequiredError";

// Universal Groth16 verification. Drives bn128.wasm directly, with no snarkjs /
```

In `src/api.ts`, replace:

```ts
export * from "./core/namespaces/AccessTokensNamespace";
```

with:

```ts
export * from "./core/namespaces/AccessTokensNamespace";
export * from "./core/namespaces/AppNamespace";
```

- [ ] **Step 4: Run it to see the snapshots differ.**

Run: `cd /Users/matt/GitHub/muhkoo/connect && npx vitest --run tests/api/export-surface.test.ts`

Expected: FAIL, `3 failed | 13 passed (16)`: "matches api-surface.workers.txt", "matches api-surface.txt", and "keeps every headline symbol in dist/connect.d.ts" still (Step 2). "keeps every headline symbol on the surface of src/browser/index.ts", "has no TS2308/TS2323/TS2484 anywhere in the program" and the workers closure tests pass. (Without `dist/`: `2 failed | 9 passed | 5 skipped (16)`.)

- [ ] **Step 5: Regenerate the snapshots and read the diff.**

Run, as one block:

```bash
cd /Users/matt/GitHub/muhkoo/connect
cp api-surface.txt <scratchpad>/api-surface.before.txt && cp api-surface.workers.txt <scratchpad>/api-surface.workers.before.txt
UPDATE_API_SURFACE=1 npx vitest --run tests/api/export-surface.test.ts 2>&1 | grep -E "Tests "
diff <scratchpad>/api-surface.before.txt api-surface.txt; diff <scratchpad>/api-surface.workers.before.txt api-surface.workers.txt
```

Expected: `1 failed | 15 passed (16)` from the vitest run (the `dist/connect.d.ts` floor test again, until Step 6; without `dist/`, `11 passed | 5 skipped (16)`), then these diff lines, and nothing else:

```text
27a28,29
> T AppAccess
> T AppNamespaceDeps
151a154
> T PaymentRequiredCode
238a242
> V AppNamespace
313a318
> V PaymentRequiredError
37a38
> T PaymentRequiredCode
69a71
> V PaymentRequiredError
```

The line numbers are those of 2026-10-06; only the added names matter. Any removed line, or any other added line, is an unplanned public-API change: stop and report it.

- [ ] **Step 6: Build, and check the shipped artifacts.**

Run: `cd /Users/matt/GitHub/muhkoo/connect && yarn build 2>&1 | tail -2 && REQUIRE_BUILD_ARTIFACTS=1 npx vitest --run tests/api/export-surface.test.ts 2>&1 | grep -E "Tests " && node scripts/check-dts.mjs && grep -n "export const VERSION" src/version.ts`

Expected:
- `yarn build` ends with `Done`. It rewrites `dist/`, which git ignores. Its `sync-version` step finds `src/version.ts` already at `0.15.0-alpha.4` and leaves it as it is (`src/version.ts` carries other uncommitted work, so `git diff` cannot tell; the checkpoint's `changed.sh` can, and must not list it).
- `16 passed (16)`: the artifact tests run, and pass.
- `check-dts: OK — …`.
- `…:export const VERSION = "0.15.0-alpha.4";`.

- [ ] **Step 7: Smoke-test the tarball under all three export conditions.**

Run, as one block:

```bash
S=<scratchpad>/bs-smoke
mkdir -p "$S" && cd /Users/matt/GitHub/muhkoo/connect && npm pack --pack-destination <scratchpad> 2>&1 | tail -1
cd "$S" && echo '{"name":"bs-smoke","type":"module","private":true}' > package.json
npm install --no-save --no-audit --no-fund <scratchpad>/muhkoo-connect-0.15.0-alpha.4.tgz 2>&1 | tail -1
cat > smoke.mjs <<'EOF'
const m = await import("@muhkoo/connect");
const e = new m.PaymentRequiredError("x", "user_plan_required");
console.log(JSON.stringify({
    PaymentRequiredError: typeof m.PaymentRequiredError,
    isHttpError: typeof m.HttpError === "function" ? e instanceof m.HttpError : "no HttpError export",
    code: e.code,
    status: e.status,
    AppNamespace: typeof m.AppNamespace,
    access: typeof m.Client === "function" ? typeof new m.Client({ offline: { enabled: false } }).app?.access : "no Client export",
}));
EOF
node smoke.mjs; node --conditions=browser smoke.mjs; node --conditions=workerd smoke.mjs
```

Expected: `muhkoo-connect-0.15.0-alpha.4.tgz`, then three lines:

```text
{"PaymentRequiredError":"function","isHttpError":true,"code":"user_plan_required","status":402,"AppNamespace":"function","access":"function"}
{"PaymentRequiredError":"function","isHttpError":true,"code":"user_plan_required","status":402,"AppNamespace":"function","access":"function"}
{"PaymentRequiredError":"function","isHttpError":"no HttpError export","code":"user_plan_required","status":402,"AppNamespace":"undefined","access":"no Client export"}
```

The tarball carries the version already published, so only its content tells it apart from the registry's alpha.4. It is for checks only, never for publishing.

- [ ] **Step 8: Checkpoint for Matt (no commit).**

Run: `sh <scratchpad>/bs-baseline/changed.sh`

Expected: the files of Tasks 1–6, plus `api-surface.txt`, `api-surface.workers.txt`, `src/api.ts`, `src/api.universal.ts` and `tests/api/export-surface.test.ts`, then `released CHANGELOG sections: unchanged`. Report the two snapshot diffs in full. Do not stage, commit or stash.

---

### Task 8: CHANGELOG, and the docs follow-up

The CHANGELOG says what changed for an app, in `### Added`, `### Changed` and `### Fixed`, under `## Unreleased`. It also documents two risks the spec assigns to it: older SDKs drop refused offline writes, and a background upload refused for payment can lose its bytes to cache eviction (spec Risks). And it tells an app two things about kept writes: a sync stopped by one still ends in `SYNC_COMPLETE`, and for about a minute after a payment `client.app.access()` can say allowed while the server still refuses (spec Risks, Staleness).

**Files:**
- Modify: `CHANGELOG.md:15-17` (`## Unreleased`, empty today)

**Interfaces:** none.

- [ ] **Step 1: Write the `## Unreleased` section.**

In `CHANGELOG.md`, replace:

```markdown
## Unreleased

## 0.15.0-alpha.4 — Writes across tabs that can't overwrite each other (2026-10-06)
```

with:

```markdown
## Unreleased

### Added

- **`client.app.access()`: may the signed-in user add data in this app?** An app's owner can now turn on "Paid
  Muhkoo accounts only" in the portal. The accelerator then refuses a Free user's writes that add data in that app.
  It also refuses them for every user of an app whose owner's payment is past due. Reads, sign-in and deletes still
  work. `client.app.access()` asks `GET /api/app/access` and returns `{ paidAccountsOnly, allowed, reason?,
  upgradeUrl? }`: `reason` is the code a refused write carries, and `upgradeUrl` the portal page to send the user to.
  Call it after sign-in, and again when the user comes back from the portal. Against an accelerator without the route,
  it throws `HttpError` with status 404.
- **`PaymentRequiredError`, a subclass of `HttpError`, for a write refused for payment.** It is thrown for a 402 whose
  body carries one of three codes, in `err.code`:
  - `user_plan_required`: the app takes paid Muhkoo plans only, and the user is on Free;
  - `user_payment_past_due`: the user's own payment is past due. Only first-party apps are told this; other apps get
    `user_plan_required`;
  - `owner_payment_past_due`: the app owner's payment is past due.

  `err.upgradeUrl` is the portal page to send the user to, when the server sends an absolute URL. Every other 402, such
  as the Free tier's quota refusals, stays a plain `HttpError`. It comes from `client.kv`, `client.db`, `client.vfs`,
  `client.space.createSpace`, file uploads (`client.storage`, a Space's or a room's files), and from the lower-level
  `ShardClient`, `SharedSpaceClient` and `PersonalSpaceClient`. It does not come from a refusal sent over a Space's live
  socket, from a Space's keyring requests (admitting a member, which still fail with a plain `Error`), or from
  `client.functions.invoke`, which returns the raw `Response`. It is exported from all three builds.
- **`client.offline.resume()`** sends what the offline queue holds for the signed-in user now, as a reconnect does, if
  it holds anything. `client.app.access()` calls it each time it answers `allowed`. `client.offline.queue.waiting()`
  lists those writes; `pending()` still counts every user's.

### Changed

- **`client.vfs` no longer creates its content space to take or drop a reference to a file.** `writeManifest`,
  `retainManifest`, a `client.vcs` checkout and a delete now commit or release the file's shards directly. The request
  is the same as before, so it is the same reference. Before, each one opened the content space first, and created it
  for a user who had never uploaded through `client.vfs`. A paid-only app refuses that for a Free user: their deletes
  left the file's bytes stored and billed, and Cloud Drive could not move their old files. The first upload of new
  bytes still creates the space.
- **`ShardClientOptions` and `SpaceDeps` take an optional `fetchWithRecovery`.** `Client` fills it in. Code that builds
  these objects itself can leave it out and keeps the previous behaviour.

### Fixed

- **Queued writes refused for payment are kept.** The offline queue used to drop any queued write the server refused
  with a 4xx. A write refused with `PaymentRequiredError` is now kept, with every write queued after it, in order, and
  the queue stops there. It tries again on the next reconnect, or when `client.app.access()` answers `allowed`, and
  never in a loop. Until then, writes queued after it wait too, deletes included. A `SYNC_ERROR` event says so, with
  `code` and `dropped: false`. Other 4xx refusals are still dropped, as before.
  - The sync still ends with `SYNC_COMPLETE`, and the status goes back to `online`, while those writes wait: only the
    `SYNC_ERROR` with `dropped: false` tells the two apart. Do not call `client.app.access()` from a `SYNC_COMPLETE`
    handler: each `allowed` answer starts another sync, so the two would call each other.
  - For about a minute after a payment, `client.app.access()` can answer `allowed` while the server still refuses the
    write. The sync it starts is then refused again, and the write waits for the next reconnect or the next `allowed`
    answer. Ask again a minute later if writes are still waiting (`client.offline.queue.waiting()`).
  - Earlier versions drop these writes. The accelerator now refuses writes in any app whose owner's payment is past
    due, on paid tiers too, which never got a 402 before. Apps that queue writes offline should move to this version.
  - A background upload (`Space.putFile` with `backgroundUpload`) refused for payment is queued, as before. Its bytes
    live only in the browser's cache until it lands. If the browser evicts them, the replay drops the entry, and the
    file's manifest names shards the server never received.
- **A queued write is sent only under the session of the user who made it.** Every tab of an origin shares one offline
  queue, and a replayed write is sent as whoever is signed in. A write left queued when its user signed out could be
  sent, on the next sync, into the space of the next user to sign in on that device, and a write to a fixed key could
  overwrite theirs. Each queued write now records whose it is, and a sync sends only the signed-in user's; another
  user's waits, untouched, until they sign in on that device again. Writes queued by an earlier version record no user
  and are sent as before.
- **A file upload or commit made with a stale session now re-establishes the session, once.** Shard uploads and the
  commit after them go through the same silent re-authentication as every other request. Before, a 401 came straight
  back: an upload failed with a plain `Error`, and a commit tried three times with the same session, then gave up with
  a warning and took no reference to the file's shards. A commit whose session cannot be re-established now gives up
  after that one try. A paid-only app refuses an upload made without a valid session (`401 session_required`), so in
  a tab left open for over a day every upload would fail. Reads are unchanged.

## 0.15.0-alpha.4 — Writes across tabs that can't overwrite each other (2026-10-06)
```

- [ ] **Step 2: Check the released sections are untouched.**

Run: `sh <scratchpad>/bs-baseline/changed.sh`

Expected: the files of Tasks 1–7, plus `CHANGELOG.md`, then `released CHANGELOG sections: unchanged`.

- [ ] **Step 3: Record the docs follow-up. Edit nothing outside connect's CHANGELOG.** The docs change when Matt asks for it, and deploying them is a separate ask. Put this list in the task report:
  - **Docs site** (`/Users/matt/GitHub/muhkoo/docs`, the canonical reference): a `client.app` page with `access()` and `AppAccess`; `PaymentRequiredError` and its three codes on the errors page, with the advice to switch screens by `code`, and where it is not thrown (the live socket, keyring requests, `functions.invoke`); the offline page: kept writes, `SYNC_ERROR` with `dropped: false`, `client.offline.resume()` and `queue.waiting()`, head-of-line waiting, writes sent only under their own user's session, that a stopped sync still ends in `SYNC_COMPLETE` (never call `access()` from it), and the one-minute window after a payment; the VFS page: references no longer create the content space.
  - **Public changelog surface:** the website's updates section, as the CHANGELOG rule for docs work says.
  - **connect's own prose:** `README.md` and `API_REFERENCE.md` (the new namespace and error), and in `CLAUDE.md` the namespace list and the Exports note's count, `workerd` → `dist/connect.workers.d.ts` (29 values…), which becomes 30 with `PaymentRequiredError`. These files carry other uncommitted work, so this plan leaves them alone.
  - **The CLI:** nothing to change; `muhkoo vcs checkout` and `vfs import` benefit from Task 5 once the CLI moves to the new connect.

- [ ] **Step 4: Checkpoint for Matt (no commit).** Report the CHANGELOG section as written and the follow-up list. Do not stage, commit or stash.

---

### Task 9: Final verification

**Files:** nothing changes, except `dist/` (ignored) and scratchpad files.

- [ ] **Step 1: The whole suite, three times.**

Run: `cd /Users/matt/GitHub/muhkoo/connect && for i in 1 2 3; do yarn test:unit 2>&1 | grep -E "Test Files|Tests "; done`

Expected each time: every file passes, with 6 more files and 69 more tests than Task 0, Step 4: on 2026-10-06, `88 passed (88)` and `1205 passed (1205)`.

- [ ] **Step 2: Types, lint and the publish gate's checks.**

Run: `cd /Users/matt/GitHub/muhkoo/connect && yarn typecheck && yarn lint 2>&1 | tail -2 && node scripts/sync-version.mjs --check && node scripts/check-dts.mjs`

Expected: `tsc` exits 0. `yarn lint` reports `✖ 9 problems (0 errors, 9 warnings)`, the same nine as before BS, all in files BS does not touch except the old `Space.ts` directive. Then `sync-version: OK — src/version.ts is 0.15.0-alpha.4.` and `check-dts: OK — …`. This is what `prepublishOnly` runs; nothing is published.

- [ ] **Step 3: Rebuild and re-run Task 7's artifact and tarball checks** (Task 7, Steps 6 and 7) on the final tree. Expected: the same results.

- [ ] **Step 4: Optional, a live check against plan B's staging accelerator.** Only when plan B is on staging and Matt has exported a staging test account. Read-only, except one refused write when the app is not allowed.
  - Check the route is deployed. Run: `curl -s -o /dev/null -w '%{http_code}\n' -H "X-Muhkoo-Key: $(grep '^VITE_MUHKOO_KEY=' /Users/matt/GitHub/muhkoo/cloud-drive/.env.staging | cut -d= -f2-)" "$(grep '^VITE_WORKER_URL=' /Users/matt/GitHub/muhkoo/cloud-drive/.env.staging | cut -d= -f2-)/api/app/access"`. Expected: `401` (the route wants a session). A `404` means plan B is not on staging: skip this step and say so in the report. The key is Cloud Drive's publishable key, read inline and never printed.
  - Check `[ -n "$MUHKOO_USER" ] && [ -n "$MUHKOO_PASSWORD" ] && echo set`. If not set, skip this step and say so; it is not a blocker.
  - In `<scratchpad>/bs-smoke` (Task 7, Step 7), run `npm install --no-save --no-audit --no-fund snarkjs@^0.7.6` (sign-in proves in Node), then create `<scratchpad>/bs-smoke/staging-access.mjs`:

```js
// Signs in to staging as the test account, asks client.app.access(), and, when the
// answer is "not allowed", checks that a new personal-KV key is refused with the same
// code. A key the server accepts after all is deleted again. Prints no key, token or
// password.
import { Client, PaymentRequiredError } from "@muhkoo/connect";
const { MUHKOO_USER, MUHKOO_PASSWORD, BS_KEY, BS_BASE } = process.env;
if (!MUHKOO_USER || !MUHKOO_PASSWORD || !BS_KEY || !BS_BASE) {
    console.error("missing MUHKOO_USER, MUHKOO_PASSWORD, BS_KEY or BS_BASE");
    process.exit(2);
}
const client = new Client({ apiKey: BS_KEY, baseUrl: BS_BASE, offline: { enabled: false } });
await client.auth.zk.login(MUHKOO_USER, MUHKOO_PASSWORD);
const out = { access: await client.app.access() };
if (!out.access.allowed) {
    const id = String(Date.now());
    const err = await client.kv.set("bs-probe", id, 1, { encrypt: false }).then(() => null, (e) => e);
    if (err === null) {
        // Accepted: the access answer and the data path can disagree for about a
        // minute (spec Risks, Staleness). Deletes are never refused, so take it back.
        await client.kv.delete("bs-probe", id);
        out.refusal = "accepted, then deleted";
    } else {
        out.refusal = err instanceof PaymentRequiredError
            ? { code: err.code, status: err.status, sameAsReason: err.code === out.access.reason, hasUpgradeUrl: Boolean(err.upgradeUrl) }
            : String(err);
    }
}
console.log(JSON.stringify(out));
await client.auth.zk.logout();
```

  - Run: `cd <scratchpad>/bs-smoke && BS_KEY=$(grep '^VITE_MUHKOO_KEY=' /Users/matt/GitHub/muhkoo/cloud-drive/.env.staging | cut -d= -f2-) BS_BASE=$(grep '^VITE_WORKER_URL=' /Users/matt/GitHub/muhkoo/cloud-drive/.env.staging | cut -d= -f2-) node staging-access.mjs`
  - Expected: one JSON line. `access` has a boolean `paidAccountsOnly` and a boolean `allowed`. If `allowed` is false, `access.reason` is one of the three codes and `refusal` is `{ code: <the same code>, status: 402, sameAsReason: true, … }`. Whether the staging app has the setting on is plan B's and plan C's business; report what came back. `refusal: "accepted, then deleted"` means the access answer and the data path disagreed (spec Risks, Staleness), and the probe key is gone: wait a minute and run it once more, and if it repeats, report it as a contract break. Any other shape is a cross-plan contract break: stop and report it.

- [ ] **Step 5: Final checkpoint for Matt (no commit).**

Run: `sh <scratchpad>/bs-baseline/changed.sh`

Expected, exactly:

```text
CHANGELOG.md
api-surface.txt
api-surface.workers.txt
src/api.ts
src/api.universal.ts
src/core/Client.ts
src/core/HttpClient.ts
src/core/HttpError.ts
src/core/PaymentRequiredError.ts
src/core/namespaces/AppNamespace.ts
src/core/namespaces/FileNamespace.ts
src/core/namespaces/MessageNamespace.ts
src/core/namespaces/SpaceNamespace.ts
src/offline/OfflineManager.ts
src/offline/OutboundQueue.ts
src/offline/store/OfflineStore.ts
src/personal/PersonalSpaceClient.ts
src/spaces/Space.ts
src/storage/transport/ShardClient.ts
src/storage/transport/SharedSpaceClient.ts
src/storage/transport/storageCommit.ts
tests/api/export-surface.test.ts
tests/client/app-access.test.ts
tests/client/vfs-references.test.ts
tests/core/payment-required.test.ts
tests/offline/payment-refused.test.ts
tests/storage/shard-session-recovery.test.ts
tests/storage/storage-commit.test.ts
released CHANGELOG sections: unchanged
```

plus this plan file if its checkboxes were ticked. Write the report as the final message, not to a file: the RED, GREEN and mutation results per task, the snapshot diffs, the tarball lines, Step 4's result or why it was skipped, and the docs follow-up list. Nothing was committed, published or deployed.

---

## Production (only on Matt's ask)

Each item happens only when Matt asks for it in that message, and each needs its own ask. An earlier "yes" does not carry over.

1. **Release connect.**
   - Before it: plan B is on staging and Task 9, Step 4 came back as expected, or Matt accepts releasing without that check. Nothing in BS needs plan B in production: against an older accelerator the mapping never fires and `client.app.access()` throws `HttpError` 404.
   - Choice 10 (a kept write waits for its own user; the alternatives were dropping kept entries at sign-out, or asking per entry at drain time) was accepted by Matt on 2026-10-08. Task 2 builds the choice as planned.
   - Check what is published first: `npm view @muhkoo/connect dist-tags`, and the newest released heading in `CHANGELOG.md`. On 2026-10-06 both are `0.15.0-alpha.4`, so BS is `0.15.0-alpha.5`. Use the next version above whatever they say then: npm refuses to publish a version twice.
   - Check the tree holds no unreleased work besides BS: a release publishes the working tree, not a commit. Before the bump, run, as one block:

     ```bash
     cd /Users/matt/GitHub/muhkoo/connect && git ls-files -m -o --exclude-standard src | node -e '
     const fs = require("fs");
     const v = require("./package.json").version;
     const t = Date.parse(JSON.parse(require("child_process").execSync("npm view @muhkoo/connect time --json"))[v]);
     console.log(`published ${v}: ${new Date(t).toISOString()}`);
     for (const f of fs.readFileSync(0, "utf8").split("\n").filter(Boolean))
         if (!fs.existsSync(f) || fs.statSync(f).mtimeMs > t) console.log(f);'
     ```

     Expected: the `published` line, then exactly the 18 `src/` files of Task 9, Step 5's list: every dirty `src/` file not touched since the last publish went out in it. Any other file is work that is not BS and was never released: stop and ask Matt. (Checked 2026-10-08: no dirty `src/` file was newer than 0.15.0-alpha.4's publish, 2026-10-07T04:42Z.) If the scratchpad still holds Task 0's snapshot, `changed.sh` must also list only Task 9, Step 5's files, this plan, and nothing else.
   - Bump `package.json` `version` to it.
   - Run `yarn build`. It re-stamps `src/version.ts`: bumping `package.json` alone ships an SDK that misreports itself.
   - In `CHANGELOG.md`, turn `## Unreleased` into `## 0.15.0-alpha.5 — Refusals for payment, and queued writes kept (<date>)`, add the line `Published with \`npm run release\`: both \`alpha\` and \`latest\` point at it.` under it, and put a new, empty `## Unreleased` above it.
   - Run `npm run release`, never a bare `npm publish`. It moves `latest`, which 13 apps resolve.
2. **Move the apps onto it.** Plan C moves Cloud Drive; it consumes `client.app.access()`, `PaymentRequiredError` and Task 5's references. Cloud Drive pins `0.15.0-alpha.3` today, so it also crosses alpha.4: W1's Production item 3 applies first (handle `VfsConflictError` from a delete in `src/lib/trash.ts`). The IDE and the other apps gain the kept-writes fix by moving too; each move is a staging deploy first, then production on a further ask.
3. **Release the CLI** (`/Users/matt/GitHub/muhkoo/cli`): bump `@muhkoo/connect`, then `npm run release` there. Optional; `vcs checkout` and `vfs import` stop creating a content space only to take references.
4. **Docs site** (`/Users/matt/GitHub/muhkoo/docs`): Task 8, Step 3's list, and the public changelog entry. Deploying the docs is a separate ask.
