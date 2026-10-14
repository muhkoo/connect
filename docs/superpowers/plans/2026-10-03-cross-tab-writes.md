# W1 — Correct Writes Across Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `client.vfs` directory writes, moves and deletes, the offline outbound queue and HLC stamps correct across the tabs of an app on one device, after first closing the in-tab move/delete data-loss races that the device-wide lock will wrap.

**Architecture:** Inside one `VfsNamespace`, a move registers the entry it is moving, so a second move or a delete is refused instead of mistaking the in-progress move for an interrupted one. A recursive delete re-checks every record it is about to purge, inside its parent edit. Edits of one record still apply at once to its single in-memory copy. They then join one pending write per record, which is the coalescing. When a coordinator is present, that write goes out under a Web Lock per record. Under the lock, the copy is read again and every pending edit is replayed onto it only when another tab has written that record since the copy was read. A write counter per record, kept in IndexedDB and stored before the lock is let go of, says so (Task 9, Decision 3). An announcement on a BroadcastChannel is only a hint: it can add a re-read, never spare one. The offline queue drains under an `ifAvailable` Web Lock, and each tab stamps HLCs with `<deviceId>.<tabSuffix>`. A move and a delete also hold a Web Lock per entry they move or delete, taken with `ifAvailable`, so another tab's move or delete of that entry is refused instead of taking a move under way for an interrupted one. A move also holds, in shared mode, the lock of the folder it moves into and of every folder above that one but the root: moves into one folder go ahead together, and a move into a folder and a delete of that folder, or of a folder above it, refuse each other. A delete also claims what it deletes within its namespace from its first check, so a move of any of it is refused there, in Node too (Task 7b). Browser wiring lives in one new module, `src/core/crossTab.ts`. Node, Workers and tests get no coordinator unless a test passes a fake, so they keep today's behaviour across tabs. Where a browser refuses Web Locks or the channel, the coordinator holds no lock or hears nothing, and each IndexedDB call gives up after 3 seconds (Decision 11).

**Tech Stack:** TypeScript (strict, ESNext), Vitest 4 (node environment, `fake-indexeddb`), Web Locks API, the Web `BroadcastChannel`, IndexedDB (Task 9), Playwright 1.62 (from `../ide/node_modules`) driving Brave for the browser check.

**Spec:** `/Users/matt/GitHub/muhkoo/connect/docs/superpowers/specs/2026-10-03-cross-tab-writes-design.md` (approved by Matt, binding). Decisions 1 and 2 below depart from it. Matt signed both off on 2026-10-03, together with three of the known gaps in Decision 9: the hung PUT, a skipping tab's early `SYNC_COMPLETE`, and history records that stay last-writer-wins (recorded in Task 3, Step 0). Task 7's per-entry move lock is not in the spec: Matt asked for it in W1 the same day, as Decision 9 then sketched it. On 2026-10-04 he signed off how Task 7 holds it (Decision 10), what that changes within one tab, and what it leaves open (Decision 9, "What the lock does not close"), with one change: a move also holds the lock of the folder it moves into, shared, so that a move into a folder another tab is deleting is refused (Decision 10). Building that change took details he has not seen. Among them, a move also holds every folder above the one it moves into: that folder alone left a move into a new folder, inside one being deleted, in no listing. Task 7, Step 0 records what he answered apart from what was worked out after, the controller ruled on the second list (ledger W-8), and Task 7, Step 16 reports it to him with W1's results. Task 1 comes from the Task 19 reviews: `/Users/matt/GitHub/muhkoo/cloud-drive/.superpowers/sdd/2026-10-02-drive-on-vfs/task-19-report.md`, `task-19-review-r0.md`, `task-19-review-r1.md`, `task-19-review-r2.md`.

**Since execution (2026-10-04/05).** The built code differs from the task steps below in places. Decision 3 now departs from the spec too: a write counter in IndexedDB, not the announcement, decides whether a copy is current (Task 9). Four tasks were added during execution: 7b and 9 change code, and 8b and 8c repeat Task 8's Brave checks on later builds. The final review's fixes changed `crossTab.ts`. The controller ruled on all of them (ledger W-9 to W-14); Matt has not signed them off. The task steps are left as they were planned. Where they differ from the code, the code and Decision 11 are right. The ledger is `/Users/matt/GitHub/muhkoo/connect/.superpowers/sdd/2026-10-03-cross-tab-writes/progress.md`.

## Global Constraints

- **Code changes:** connect only (`/Users/matt/GitHub/muhkoo/connect`). No accelerator change: the accelerator is only read (Task 5). Task 8 also swaps Cloud Drive's `node_modules` for a while, restores it, and deploys Cloud Drive to **staging**. Tasks 8b and 8c repeat that on later builds. Nothing in Cloud Drive's source changes.
- **Commits:** Matt makes every commit. Each task ends in a **checkpoint**, never a commit. Never run `git add`, `git commit` or `git stash`, in any repo.
- **Formatting:** never run `prettier --write`. connect uses 4-space indentation and double quotes in `src/` and `tests/vfs`. Match the surrounding style by hand.
- **No new public name.** No new name may appear in `api-surface.txt`. `src/api.ts` does `export * from "./vfs/VfsNamespace"`, so every new type in `VfsNamespace.ts` stays un-exported. The new interface lives in `src/vfs/coordinator.ts`, which nothing re-exports.
  - The public *shape* still changes, additively. Exported types gain optional members: `VfsNamespaceDeps.coordinator?`, `OfflineManagerDeps.locks?`, and an optional second constructor argument to the exported `OutboundQueue`. Their types (`VfsCoordinator`, `TryLock`, `OutboundQueueOptions`) are not exported by name, but they appear in `dist/connect.d.ts`. export-surface still passes. Task 6's CHANGELOG step says so, under `### Changed`.
  - Task 7 adds a required member, `holdMoving(id, shared?)`, to `VfsCoordinator`. No released version has `VfsCoordinator`, so nothing outside connect implements it. Every implementation in this plan gets it: `vfsCoordinator`, which `tsc` checks, and the test fakes and the scratchpad `one-tab.ts`, which it does not, because `tsconfig.json` excludes `tests/`.
  - Task 9 adds three more required members the same way: `counters(ids)`, `begin(id)` and `bump(id)`. As built, `VfsCoordinator` has eight: `lock`, `announce`, `onAnnounce`, `listen`, `counters`, `begin`, `bump` and `holdMoving`. `vfsCoordinator` also takes a `countWaitMs` option, for tests (final review).
- **No record or wire format change.** Sealed directory records, history records, `vfs/` keys and HLC packing (`"{wall}:{counter}:{nodeId}"`) stay as they are. `OpenDir.seen` and `OpenDir.counter` (Task 9) are in memory only.
  - Task 9 adds one IndexedDB database on the device, `muhkoo.vfs`, which never leaves it. Its version stays 1 for good: a new store goes in a new database (final review, Minor 7).
- **Lock, channel and storage names (verbatim from the spec, except the move lock and the write counts):**
  - lock `muhkoo:vfs:<commitment>:<recordId>`;
  - channel `muhkoo:vfs:<commitment>`;
  - message `{ id, writer: tabId }`;
  - drain lock `navigator.locks.request("muhkoo:offline-drain:<commitment>", { ifAvailable: true })`;
  - HLC node id `<deviceId>.<tabSuffix>`. The suffix is random and in memory only, and the persisted HLC state stays shared;
  - move lock `muhkoo:vfs:<commitment>:moving:<entryId>`, always requested with `ifAvailable` (Task 7). It is not in the spec: Matt added it on 2026-10-03. A move also requests, with `mode: "shared"`, the move lock of the folder it moves into and of every folder above that one except the root, each by its entry id. Matt added the folder it moves into on 2026-10-04. The folders above it, and leaving out the root, were worked out after his answer (Decision 10); the controller ruled on them (ledger W-8), and Task 7, Step 16 reports them to him.
  - write counts (Task 9; not in the spec): IndexedDB database `muhkoo.vfs`, store `counts`, key `[commitment, recordId]`, value a count, plus a `created` key holding a random id. A counter reads `<created>:<count>`.
- **`globalThis.BroadcastChannel`, always named in full.** connect's own `src/sessions/BroadcastChannel.ts` class shadows the global name.
- **Where there is no lock, keep today's behaviour.** Node before 24.5 (no `navigator.locks`), Node 24.5+ (its locks are process-local), Workers, old WebViews and any runtime without `window` all get no coordinator and no drain lock.
  - As built, three in-namespace changes apply there too: Task 1's refusals, Task 3's wait for a new folder to be named (ledger W-3) and Task 7b's delete claim (W-10). The CHANGELOG says so.
  - A browser that has Web Locks and refuses them to the document (a `SecurityError`: an opaque origin, or a site whose data is blocked) keeps its coordinator, but takes no lock, and its drain runs unlocked (final review I-1). Refused a channel, it hears nothing. Its counts are still tried (W-13).
- **Suites:** `tests/vfs`, `tests/vcs`, `tests/offline` and the full `yarn test:unit` stay green after every task. That includes `tests/api/export-surface.test.ts`.
- **The tree is not clean, so compare against Task 0's snapshot, never against git.** Before W1 touches anything, connect already has 46 modified files (+7063, −567) and about 25 untracked paths. `CHANGELOG.md`, `src/vfs/VfsNamespace.ts`, `src/core/Client.ts`, `src/offline/OutboundQueue.ts` and the untracked `tests/vfs/write-order.test.ts` are among them. `git status` and `git diff` cannot say what W1 changed, so every checkpoint runs Task 0's `changed.sh` instead.
- **CHANGELOG:** edit only `## Unreleased`.
  - 0.15.0-alpha.3 was published (`npm run release`, 2026-10-03 19:48) after this plan's first draft. So `## Unreleased` starts empty, with no `### Changed` and no `### Fixed`. Task 1 creates `### Fixed`, and Task 2 creates `### Changed` above it.
  - Everything from `## 0.15.0-alpha.3` down is released and stays byte-identical. That includes the alpha.3 bullets this plan supersedes: a correction is a new Unreleased bullet, never an edit of a released one. `changed.sh` checks it.
- **Browser checks are staging only.** The checks run in Brave, driven by Playwright, against Cloud Drive staging at `https://cloud-drive.apps.staging.muhkoo.dev`, with two tabs at a time (Tasks 8, 8b and 8c).
  - The staging test account comes from the environment only, as `MUHKOO_USER` and `MUHKOO_PASSWORD`. It is never written to a file, a script or a logged command line. If either is unset, stop and ask Matt.
- **Production happens only on Matt's ask.** Nothing is published (`npm run release` of connect or cli) and nothing is deployed to production unless Matt asks for it in that message. A permission given earlier does not carry forward. See the last section.

## Review Focus

1. **A move to the Trash in one tab overlapping a save into the same folder in another tab.** Expect both to be kept: the saved file in the folder, and the moved file in the Trash with its content intact. Pinned in Task 3, by "keeps a file saved in one tab while another tab moves a file out of that folder".
2. **A save that cannot get its folder's lock in time, or whose re-read under the lock fails.** Expect it to fail with nothing written and nothing shown in the listing, and a retry to work. Pinned in:
   - Task 3, by "fails a save whose folder's lock cannot be had…" and "fails a save whose re-read under the lock fails…";
   - Task 6, by "gives up waiting for a lock another tab has held too long".
3. **Two tabs saving the same new file name at the same moment.** Expect one to land and the other to be refused with `VfsConflictError`, and never a silent overwrite. Pinned in Task 3, by "refuses a save of a name another tab saved first…". When the refused save shares its write with other saves, only it fails and the others are stored: "refuses only the save that no longer applies…".
4. **Two tabs saving files into a new folder of the same name at the same moment**, as when each uploads a folder. Expect every file in the one folder that ends up named, and none in a folder that nothing names. Pinned in Task 3, by "keeps every file when two tabs each save files into a new folder of the same name at once".
5. **Signing in as another user in a tab that has already written.** Expect locks, write counts and announcements to follow the new user, nothing from the old user's tabs to be heard, and the tab to say it may have missed writes. Pinned in Task 6, by "follows a change of user…", and for the counts in Task 9, by "shares one user's counts between that user's tabs, not with another user's, and follows a change of user".
6. **A tab that drains the offline queue while, or after, another tab drains it.** Expect each entry replayed exactly once, and nothing left behind. Pinned in Task 4, by "replays each queued write once…" and "replays what a tab queued while another tab was draining…".
   - "drains, after another tab's drain stopped on a failure, only what is left" is only a guard. It passes before and after Task 4, because entries are removed only once replayed. Under the lock, it pins only that a failed drain's error still reaches its caller.
7. **A move in one tab while another tab moves, renames or deletes the same file or folder**, as when two tabs move one file to the Trash at once, or one tab restores a file that the other deletes forever. Expect the second operation to fail with `VfsConflictError` and change nothing, and the file to end up in exactly one place with its content intact. Pinned in Task 7, by "refuses a second move, in another tab…" and "refuses to delete, in another tab, a file the first tab is still moving…". Checked in Brave by Task 8's `w1-two-tab-moves.mjs`, and again on Task 9's build by Task 8b.
   - A move of something a delete has begun on, in the same namespace, is refused from the delete's first check, in Node too (Task 7b). Pinned by "refuses a move of a file a delete of it has begun, while the delete looks for the other half of a move…" and its folder variants.
8. **A move in one tab into a folder that another tab is deleting**, as when one tab deletes a folder for good while another moves a file into it, or into a new folder inside it. Expect whichever comes second to fail and change nothing, and nothing moved to end up in a record that no folder names.
   - It fails with `VfsConflictError` while the other holds the folder's lock, or the lock of a folder above it.
   - A move that found the folder before a delete of it finished, and gets its lock after, fails with `VfsNotFoundError` naming the folder. That is the second look (Decision 10), and it is correct.
   - Two moves into one folder at once must both work. Two moves in two tabs that would each put a folder below the other must not both go ahead.
   - Pinned in Task 7, by "refuses a move into a folder another tab is deleting…", "refuses a move into a folder it makes inside a folder another tab is deleting", "refuses to delete a folder another tab is moving something into…", "refuses a move into a folder another tab deleted after the move found it…" (the `VfsNotFoundError`), "lets two tabs move files into one folder at the same time" and "refuses one of two moves, in two tabs, that would each put a folder below the other". The shared lock is checked in Brave by Task 8's M3.
9. **A tab that hears another tab's announcement late, or never** (Task 9, Decision 3). Expect nothing lost: a write reads its folder again when the folder's counter has moved, and every move and delete check reads counters once it holds its locks.
   - The three cross-tab describes run twice, with prompt announcements and with every announcement held back (" (announcements late)").
   - Pinned in "VFS — two tabs that hear of each other's writes late, or never", among others by "keeps both files when two tabs save into one folder, though neither hears of the other's save", "refuses a move into a folder inside one another tab deleted after the move found it, though it never heard of the delete" and "lets go of nothing another tab moved out of a folder before this tab deleted it, though it never heard of the move". Checked in Brave by Task 8b.
10. **A browser that refuses Web Locks, a BroadcastChannel or IndexedDB, or an IndexedDB that never answers** (final review I-1 and I-2). Expect `client.vfs` to keep working: no lock where Web Locks are refused, nothing heard where the channel is, and every IndexedDB call given up on after 3 seconds as "read again". Pinned in `tests/core/crossTab.test.ts`, by "writes, moves and deletes without the locks where the browser refuses Web Locks, and asks no more", "passes on any other refusal of a lock…", "gives up on an IndexedDB transaction that does not complete, telling nothing, and lets go of the lock", and the three tests in "cross-tab coordination — client.vfs where the browser will not coordinate". Not yet checked in a real browser: Task 8c's best-effort blocked-storage check (W-14).

## Decisions this plan makes where the spec is silent or ambiguous, the places it departs from it (1, 2 and, since Task 9, 3), and its additions (10, and 11 for what execution changed)

**Signed off by Matt, 2026-10-03:** Decisions 1 and 2, and three of Decision 9's known gaps: the hung PUT, the drain's early `SYNC_COMPLETE`, and history records. He also asked for the cross-tab move fix to be in W1, as the sketch then in Decision 9 put it: a lock per moving entry, which `rename` and `delete` take with `ifAvailable`, refusing when another tab holds it. That is Task 7.

**Signed off by Matt, 2026-10-04:** Decision 10 (how Task 7 holds the lock, and the outcomes it changes within one tab) and the list under "What the lock does not close" in Decision 9, with one change he asked for: a move also holds the lock of the folder it moves into, shared, and a delete keeps taking that folder's lock exclusively (Decision 10). Recorded in Task 7, Step 0. Building that change showed that the folder alone does not take moves off the first item of that list, so a move also holds every folder above it but the root (Decision 10). With that, moves are off it; saves stay on it. That and the other details worked out after his answer are not signed off. The controller ruled on them (ledger W-8); Task 7, Step 16 lists them for him.

**Ruled by the controller during execution, 2026-10-04/05, not signed off by Matt:** Task 7b (ledger W-10), Task 9 and the new Decision 3 (W-11), Task 8b's verdict (W-12), the final review's fixes and what was parked after it (the ledger's "Final review" entries, and W-13), and Task 8c (W-14). Decision 11 lists them. Nothing ships before Matt asks.

1. **When the edit runs relative to the lock.**
   - The spec says the lock covers "the read, the edit, the send and waiting for the write to settle". Applied literally, every in-tab edit would wait for the previous write. That breaks Task 13/19's synchronous check-then-edit (two saves of one new path become an overwrite), the existing tests that list an edit while its write is held, and §2 coalescing.
   - So the edit is applied at once, as today. Under the lock, if another tab has written the record since the copy was read, the record is read again and every pending edit of the batch is **replayed** onto it, and that replay is what gets sealed. The edit that is written is therefore always made under the lock whenever another tab has written.
     - As planned, an announcement heard said another tab had written. Since Task 9, the record's write counter does (Decision 3).
   - A replayed edit that no longer applies rejects only its own caller. The rest of the batch is still written. Pinned by "refuses only the save that no longer applies…".
   - **The price of applying at once: until its write lands, an edit is a promise, not a fact.** Another operation in the same tab can see it, and act on a DIFFERENT record, before the replay decides it. `mkdir -p` is the case that loses data:
     - Tabs A and B each upload a folder "Photos", with files, into `/d` at once. A's write of `/d` lands first, naming Photos→X.
     - In B, the first save names Photos→Y in B's copy of `/d`, and waits for `/d`'s lock. A second save finds Y named, writes its file into Y's record (that lock is free), and resolves.
     - Under the lock, B reads `/d` again and finds Photos→X, so the replayed `createDir` names nothing. The second file is in a folder that nothing names, and its save has already succeeded.
     - The same follows when B's write of `/d` is refused, times out waiting for the lock, or fails.
   - So a directory named by a `createDir` whose write has not landed is not followed. `mkdir` waits for that write and looks again, and so does a `createDir` whose edit found such a directory already there (Task 3, Step 10).
     - Every path that creates a parent comes through `mkdir`: `writeFile`, `writeManifest`, `rename` and `copy`. A copy writes its records before it names them.
     - This also closes the older, in-tab form of the hole: a failed write of `/d` no longer leaves later saves in an unnamed folder.
   - Signed off by Matt, 2026-10-03 (recorded in Task 3, Step 0).
2. **The send timeout becomes a bound on the lock wait.**
   - The spec's Risks table asks for "a send timeout so a hung PUT releases the lock". Releasing the lock while a PUT is still in flight lets the next tab write, and the late PUT then lands over it, which is the very loss W1 exists to prevent.
   - So `LOCK_WAIT_MS = 30_000` bounds only the **wait** for the lock: a tab that waits that long gives up with `VfsConflictError` and writes nothing. A held lock is released only when its write settles.
   - **What this leaves undone that the spec counted on:**
     - Nothing bounds a hung PUT. `HttpClient` has no timeout, so a PUT that stalls holds that folder's device-wide lock until it fails or the tab closes. Meanwhile every other tab's save into that folder fails with `VfsConflictError` after 30 seconds.
     - The spec said the timeout "also addresses Task 13's 'a hung put holds later writes'", within one tab. It does not, and that stays as it is.
     - Both are in Decision 9 and in the CHANGELOG. A real fix is a request timeout with a known outcome (did the PUT land?), which is only safe with W2's compare-and-swap.
   - Task 6 pins the chosen behaviour with "passes on what the write itself throws… and a write longer than the wait is not cut short". Signed off by Matt with Decision 1, 2026-10-03.
3. **What decides whether a copy is current: a write counter, not the announcement.** Changed during execution by Task 9 (ledger W-11). This departs from the spec, whose design re-reads only when an announcement has marked the copy stale.
   - **As planned (Tasks 3 to 7).** The spec assumes a tab hears an announcement before it is granted the lock its sender released. The plan yielded one task (`nextTurn()`) after the grant, before deciding whether to re-read, and logged `[muhkoo/vfs] … may be lost` when an announcement arrived after the seal. Task 8's browser checks failed on that line.
   - **Why it changed: measured in Brave.** Task 8's order probe (`w1-task8/order-probe.mjs`, on the staging origin) found the two reach the next holder separately, in no set order:
     - the announcement had not arrived at the grant in 66 of 100 and 139 of 200 hand-offs;
     - it had still not arrived after one turn in 8 of 100 and 12 of 200: about 6%;
     - so a tab took its copy for current and wrote it over the other tab's write. Uploads lost a file in 3 of 4 runs, and the Trash moves check (M3) in 2 of 4. Task 8 was BLOCKED.
   - **As built (Task 9).** Each record has a write counter in IndexedDB (`muhkoo.vfs`, store `counts`, key `[commitment, recordId]`), shared by every tab of the origin. It works as a seqlock:
     - `begin(id)`, under the record's lock, returns the count as the last writer left it, and makes it odd: a write is under way. A tab that dies mid-write, or cannot count its write, leaves it odd, and every tab then reads the record again until a write of it is counted.
     - `bump(id)` makes it even once the write has landed or failed. The lock is let go of only after that transaction has completed.
     - `counters(ids)` reads any number in one readonly transaction, and reports an odd count as null. A copy's counter is read **before** its fetch.
     - Under the lock, a copy is current only if `begin`'s counter equals the copy's, and no announcement of that record has been heard since the copy was read. Otherwise it is read again, and the batch's edits are made again to what was read.
     - A counter reads `<created>:<count>`. `created` is a random id stored when the database was made, so cleared site data cannot bring an old count round again.
   - **The announcement is a hint.** It still drops cached copies and keeps listings fresh, and it can add a re-read. It never makes a copy count as current. The `nextTurn()` after the grant and the "heard of only after … may be lost" warning are gone. A warning now appears only when a write could not be counted (`notCounted`).
   - **Every check that trusted "nothing was heard" now reads counters once it holds its locks** (`dropStale`): the delete's checks, its search for the other half of a move, and its second look at the way to its target; the move's look at the way to its source, and its second look at the way to its destination; `sweep`. The Task 9 report's table lists each place, with its fix round's row 12.
   - **Null means "read again".** IndexedDB missing, refused, failing, or not answering within 3 seconds (`COUNT_WAIT_MS`, final review I-2) all give null. Where IndexedDB cannot be used at all, every locked write reads its folder again first.
   - **Cost:** two local IndexedDB transactions per locked write, one readonly read before each record fetch, one or two per move, and one per delete and per `sweep`. No network request. Without a coordinator nothing is read or stored.
   - **Verified in Brave on staging by Task 8b** (W-12): uploads 6 of 6 runs (528 of 528 files), moves 6 of 6 counted runs, no `[muhkoo/vfs]` warning, while the order probe still found 3 of 100 announcements late after one turn.
   - **What remains:** a write one tab could not count, while another tab's counts work (Decision 9).
4. **`onAnnounce(null)` and `listen()`.**
   - The channel can open only once someone is signed in, and reads can come before the first write.
   - So the interface gains `listen()`, called before every fetch of a record: in `openDirById` before it reads, and in `sendLocked` before it decides whether to read again. It also lets the coordinator call `handler(null)` to mean "you may have missed announcements", which happens when it starts hearing or switches user. On `null` the namespace clears its cache and treats every pending copy as out of date.
   - Since Task 9, both only add re-reads. The counters decide (Decision 3).
   - The spec's `lock(name, fn)` takes the record id. The browser coordinator builds the full lock name from it.
5. **Where the coordinator is wired.** Only in a browser tab: `window` is defined and both Web Locks and `BroadcastChannel` exist. Node 24.5+ has process-local `navigator.locks`, but it still keeps today's behaviour.
   - IndexedDB is not required (Task 9). Without it, no count can be told, and every locked write reads its folder again first.
   - Since the final review (I-1): a browser can have both and still refuse them to a document, with a `SecurityError`, in an opaque origin or on a site whose data the user has blocked. The coordinator stays wired. Refused Web Locks, `lock` runs the write without a lock, `holdMoving` resolves to a function that does nothing, `drainLock` runs the drain, and none of them asks again. Refused a channel, the tab hears nothing. Any other refusal still propagates. The refused tab still tries its counts, so where IndexedDB is refused too, it reads each folder again before writing it (W-13).
6. **In-tab move/delete (Task 1) refuses rather than waits.** Waiting would deadlock Task 19's approved test "refuses to delete a folder that a move marked while the delete was reading it".
   - The in-motion window ends after the source is detached, before the destination is unmarked. That keeps the Trash's "delete forever while the move is still writing" working (the existing write-order test).
   - Task 7 applies the same rule across tabs, over the same window (Decision 10).
   - Task 7b adds the other direction within one namespace: a delete claims what it deletes, and a move of any of it is refused, not waited for (Decision 10).
7. **The drain lock is per commitment, as specified, although the IndexedDB queue is per origin.** Two different users signed in to two tabs of one origin still each drain it. This is pre-existing, and it is noted, not fixed.
   - A tab that finds the lock held skips its drain (the spec's `ifAvailable`). Whatever it queued after the holder read the queue would then wait for the next reconnect. So the holder drains until a pass leaves nothing (Task 4).
   - Still open: the skipping tab's `SyncEngine` goes on to its catch-up, emits `SYNC_COMPLETE` and marks itself synced before the holder's replays have landed. Waiting for the lock instead of skipping would fix that, but it departs from the spec's `ifAvailable`. It is one of Decision 9's known gaps, which Matt signed off: not done in W1.
8. **HLC on a new device.** Two tabs that boot at the same moment on a fresh device can store different device ids, because the last `put` wins. Their node ids are still distinct, which is all correctness needs.
9. **Residual races that W1 does not fix.** On 2026-10-03 Matt signed off the last three items below: the hung PUT, the drain and history records. The list he saw then also held the three cross-tab move races, and he asked for those to be fixed in W1: that is Task 7 (Decision 10). The list under "What the lock does not close" was written while building Task 7. Matt signed it off on 2026-10-04, asking for moves to come off its first item (Decision 10).
   - Found after his answer, while building his change, and not yet put to him (Task 7, Step 16 lists them):
     - the folder a move goes into was not enough to take moves off that item;
     - what a late announcement leaves when it reaches a move's or a delete's check. Closed by Task 9 (below);
     - the item on a move's last write;
     - two moves that each go into what the other is moving;
     - the item on Node and the CLI making a cycle.
   - The controller ruled on these (ledger W-8). Task 8 then showed that W-8's item 6, "late announcement silent at these checks", was wrong in practice (Decision 3).
   - The CHANGELOG lists each item a user can see that W1 leaves across tabs. Two are listed only here:
     - the record a move's last write can leave behind, which a sweep removes;
     - the cycle that two moves at once can make in Node and the CLI, which is not new in W1 and is not about tabs. W-8 keeps it out of the CHANGELOG, as a follow-up for Matt.

     A late announcement was a third, until Task 9 closed it.
   - **Moves across tabs, after Task 7.** `inMotion` (Task 1) is per namespace. Task 7 adds a lock per entry that every tab of the device shares, and that closes the three races this list held:
     - a second move of an entry in tab B, while tab A is moving it, took A's mark for an interrupted move and finished it, naming the entry in two places;
     - a delete of it in tab B, or a recursive delete of a folder holding it, looked for the other half before A's attach had landed, found none, and let go of the content, or purged the folder that A then named in its new place;
     - a recursive delete in one tab could purge a folder that a move in another tab took out of it, if the move landed inside the delete's own write.
     - Task 7b closes one more, found in Task 1's re-review: a move that began, in the same namespace or in another tab, while a delete was searching the tree for the other half of a move (`namedElsewhere`). It could be named in its new place with its content let go of (Decision 10).

     What the lock does not close:
     - **A save into a folder that another tab is deleting at that moment:** a `writeFile`, `writeManifest` or `mkdir` into it, or a `copy` into it. A storage leak, not a loss.
       - A save holds no move lock. The delete did not read what it puts in that folder.
       - It can resolve the folder before the delete's write of its parent lands. If its write into the folder then lands after the delete has checked that folder, what it put there ends up named only inside the deleted folder, out of the tree.
       - The tree then looks as if the save had landed just before the delete, and the delete had taken it with the folder. The difference is storage: the saved file's content stays in use, where the delete would have let go of it. `sweep` removes records nothing names, never content, so it does not free it either (final review, Minor 3).
       - Since Task 9 it also covers a save made just after another tab's delete that this tab has not heard of. `mkdir` trusts the old cached parent, and a purge counts nothing, so the save's locked write finds the purged folder's counter unchanged (Task 9 report, "What remains" 3). The CHANGELOG says so.
       - Confirmed in review on 2026-10-03: tab B's `writeFile("/a/d/g.txt")` resolves while tab A's write of `/` without `/a` is held, A's delete succeeds, `g.txt` is in no listing, and its content is still stored.
       - Within one tab it cannot happen. The delete's detach is made at once to the one copy of the parent, so the save's `mkdir` makes a new folder instead (checked in the same review).
       - Moves did the same until 2026-10-04. It was found while building Task 7 and confirmed against its first code in a scratch copy: the move and the delete both succeeded, and the moved folder was in no listing. Matt then asked for the fix this item proposed, for moves only: a move holds the lock of the folder it moves into, in shared mode (Decision 10).
       - That folder alone was not enough (found in review on 2026-10-04, in a scratch copy). A folder that is new since the delete read the tree is not among the entries whose locks the delete holds, and a move into it still ended up in no listing. That holds whether the move's own `mkdir -p` made the folder inside the one being deleted, or another tab's save did.
       - So a move holds every folder on the way to the one it moves into, which takes in the delete's target whatever the delete read (Decision 10). That takes what a move moves off this item.
       - One thing stays: the move takes those locks after its own `mkdir -p`. A move refused there keeps any folders that `mkdir -p` made, empty. Inside a folder being deleted, such a folder can be a record nothing names, until a sweep removes it. It holds nothing, so nothing is lost (checked in review on 2026-10-04, in a scratch copy).
       - A save would close it for saves only by doing the same: holding every folder on its path, not only its parent. Holding the parent alone leaves the same gap as it did for moves. Not in W1.
     - **A late announcement at a move's or a delete's check. Closed by Task 9, 2026-10-04** (Decision 3).
       - As planned, a delete's check of what it read, and a move's second look at the way to its destination, each yielded one turn after taking its locks, and then relied on having heard the other tab's announcements. Missed by a move's second look, the move landed in the record the delete purged: in no listing, its content kept. Missed by a delete's check, the delete purged what a move had just named somewhere else, and let go of its content. Both were checked on 2026-10-04 in a scratch copy, with one tab's incoming announcements held back. Neither logged anything.
       - W-8 accepted that. Task 8 then measured late announcements in Brave, about 6% of hand-offs even after one turn, and lost files through them.
       - Now each check reads the counters of what it relies on once it holds its locks (`dropStale`), and yields no turn. Task 9 also found and closed three more places that trusted old copies: the move's look at the way to its source (a real loss), `sweep`, and a delete of a folder its own tab still has a write of waiting. Its fix round added the delete's second look at the way to its target, which lost content with prompt announcements too. Pinned by the late-only describe (Review Focus 9).
       - **What remains of it:**
         - **A write one tab could not count, while another tab's counts work.** Its IndexedDB failed, or, since the 3-second limit, opens too slowly (ledger NB-1). The other tab's counter has not moved, so it trusts its copy unless it has heard the announcement, and can write over that write. The writing tab warns ("… this write may be lost"), and the CHANGELOG lists it. Where IndexedDB fails in every tab, every tab reads again and nothing is lost (tested). NB-1 ships as is; keeping a slow open pending, and timing out only the caller's wait, is flagged to Matt as a small pre-release refinement.
         - **Minor 8 of the final review, a W2 follow-up.** An interrupted move left something named in two places. A delete of one is walking the tree for the other (`namedElsewhere`) when a move in another tab moves a folder that holds the other. The walk can read an old cached copy, miss the other half, and let go of content it still names. Probed and real in both modes (`<scratchpad>/w1-finalfix/probe/minor8.test.ts`), disclosed in the CHANGELOG, not new with W1. A likely fix: once the walk is done, read the counters of every record it read, and walk again if any has moved.
     - **A frozen tab** in the middle of a move keeps the entry's lock, and its share of the locks of the folder the entry is going into and of every folder above that one, as when the browser freezes a background tab. Until it resumes or closes, other tabs' moves and deletes of that entry fail with `VfsConflictError`, and so do moves and deletes of those folders.
     - **A delete of the folder a move has just put something in, while the move clears its mark there.** A move lets go of its locks once it has taken the entry from where it was (Decision 6). Clearing the mark at the destination is its last write, after that. A delete of that folder in another tab at that moment takes the entry with it, as if the move had finished first. Both succeed. The move's late write can then leave the folder's record stored with nothing naming it, one small record, until a sweep removes it; what it names has been let go of. Found while amending Task 7 on 2026-10-04, in a scratch copy. Holding the destination's locks until the mark is cleared would close it. The cost: a delete, move or rename of that folder, or of a folder above it, is refused for one more write.
     - **Two tabs deleting overlapping folders at the same moment** can both fail, each holding some of the locks the other asked for. Trying again works.
     - **Two moves that each go into what the other is moving**, as `/x` into `/d` while `/d` goes into `/x`, can both fail in the same way, in two tabs or in one. Each holds its own entry's lock and asks for the other's, shared. Checked on 2026-10-04, both failed in three runs out of three, in two tabs and in one. It changes nothing, and trying again works. Had both gone ahead, each folder would have ended up inside the other, out of the tree (Decision 10).
     - **Other devices, the CLI, and a client in a Web Worker,** which has Web Locks but gets no coordinator (final review, Minor 5). The lock is per device. W2's compare-and-swap does not fix moves either.
     - **Within one namespace with no coordinator (Node, the CLI), two moves at once that each put a folder below the other.** An example is `/x` into `/d/e` while `/d` goes into `/x/y`. Both move part of the way, one or both fail with `VfsNotFoundError`, and both folders, with everything in them, end up in no listing. It was found on 2026-10-04 in a scratch copy. It is not new in W1, it is not about tabs, and it is not fixed in W1. In a browser the move locks refuse one of the two, in one tab or two (Decision 10).
   - **Found during execution, and parked after the final review (ledger, 2026-10-05).** None loses data beyond the two items under "What remains of it" above.
     - **A browser that refuses Web Locks keeps its coordinator** (W-13). Where IndexedDB is refused too, each folder write reads its folder again first, one GET, and each folder logs a "may be lost" warning once that cannot come true (Minor 11). That is safer if one tab is refused and another is not.
     - **An IndexedDB that hangs** costs each folder read up to 3 seconds more, and each write up to 6, for as long as it hangs. One that is slow rather than hung can cost about 12 seconds a write (NB-2).
     - **CHANGELOG wording, to fix at release prep** (NB-2, NB-3): that slow-IndexedDB cost; and, where Web Locks are refused, that the same-tab refusals do not happen and a folder write costs an extra GET.
     - **A hung replay** keeps the drain lock, so the other tabs leave the queue to it until that request fails or its tab closes (Minor 6). Before W1 only its own tab's drain stalled. In the CHANGELOG.
     - **Apps that take only `VfsNotFoundError` from a delete as "already gone"** (Minor 9). The IDE and Cloud Drive must also handle `VfsConflictError` before they move to this version: see the Production section.
     - **Left as they are** (Minors 11 to 13): the warning above; the lock-wait error does not name the folder; fixed sleeps and duplicate helpers in the tests.
     - **Also from Task 9.** A tab that dies after `begin` leaves its record marked, and every tab reads that record again until a write of it is counted: a read, never data. A delete of an entry this version cannot read (the `hidden` branch) edits its parent with no lock and no second look, so it can write a purged parent back: it leaks storage and lets go of nothing. A `copy` from an old cached source can copy a file another tab has just deleted, as before W1.
   - **A hung PUT** holds its folder's lock until it fails (Decision 2). Within one tab, it still holds every later write of that record.
   - **The drain:** a tab that skipped reports `SYNC_COMPLETE` before the other tab's replays land (Decision 7).
   - **History records** (`vfs/h/…`) stay last-writer-wins across tabs.
10. **How Task 7 holds the move locks.** Matt asked for this lock in W1 on 2026-10-03; the spec does not have it. He signed this decision off on 2026-10-04, with one change: a move also holds the folder it moves into, shared (below, and Task 7, Step 0). The details of that change were worked out after his answer and have not been put to him: that a move holds every folder above that one too, when the locks are taken and that the root's never is, the second look at the way to the folder, and the three outcomes it changes within one tab (the fourth to the sixth below). The controller ruled on them (ledger W-8), and they are reported to him with Task 7's results (Step 16). During execution, Task 7b changed when a delete takes its locks and added a claim within the namespace (ledger W-10), and Task 9 changed what the second looks rely on (W-11). The controller ruled on both; they are marked below.
    - **One lock per entry id,** `muhkoo:vfs:<commitment>:moving:<entryId>`, always requested with `ifAvailable`. It is held exclusively, except by a move holding the folders on the way to where it moves (below). Nothing waits for one, so there is no lock order to keep, and no deadlock, including with the record locks that a move or a delete waits for while it holds one. The shared hold keeps this true: it is requested with `ifAvailable` too.
    - **A move holds its entry's lock for exactly its `inMotion` window** (Decision 6). Every `rename` takes it, a rename within one folder too: that one would also take the entry, mark and all, from under another tab's move.
      - **Since Task 9, it then looks again at the way to its source.** It reads the counters of that way (`dropStale`). If any has moved, it looks the entry up again: gone, it fails with `VfsNotFoundError`; another folder on the way, or the entry replaced or newly marked, with `VfsConflictError`. Without it, a move from a folder that another tab had just deleted, unheard, marked its entry in the purged record and named it at the destination with its content let go of. Task 9 found that loss.
    - **A move also holds the folder it moves into, and every folder above that one but the root, in shared mode, for the same window.** Matt asked for the folder it moves into on 2026-10-04. The folders above it were added after: see "Not the folder alone" below. Each is that folder's own move lock, by its entry id: there is no new lock name.
      - Moves into one folder share it, in any tab, so two of them at once both go ahead. So do moves into two folders on one way, such as `/p` and `/p/q`.
      - A delete already holds its target's lock exclusively, and the lock of every entry it read below its target. So a move into a folder that a delete holds, or into a folder below one, is refused with `VfsConflictError` and moves nothing. Folders its own `mkdir -p` made before it asked for the locks stay, empty (Decision 9). A delete of a folder that a move is putting something into, or of a folder above it, is refused the same way. This takes moves off the first item of Decision 9's "What the lock does not close".
      - **Not the folder alone.** Holding only the folder it moves into left the same race open whenever that folder was new since the delete read the tree. A delete holds only what it read. It does not hold the lock of a folder that the move's own `mkdir -p` made inside the one being deleted, nor of one another tab saved there. A move into such a folder still put what it moved where no listing reached. That was found in review on 2026-10-04 and confirmed in a scratch copy, both ways. The delete's target, though, is on the way to any folder inside it. Holding the whole way refuses the move whatever the delete read. Pinned by "refuses a move into a folder it makes inside a folder another tab is deleting".
      - **It also refuses one of two moves that would each put a folder below the other**, in two tabs or in one. An example is `/x` into `/d/e` while `/d` goes into `/x/y`. Each holds its entry's lock, and the other asks for it, shared, as a folder on its way. Held to the folder it moves into alone, neither refused the other. Both moved, and the second then failed with `VfsNotFoundError` once it had landed. `/x` ended up inside `/d` and `/d` inside `/x`, and the root named neither (checked on 2026-10-04). Pinned by "refuses one of two moves, in two tabs, that would each put a folder below the other".
      - They are taken once the folder is known, after `mkdir` has made it if it was missing, and before the move's mark. They are asked for all at once, as a delete asks for its locks (`holdAll`). They are let go of with the entry's.
      - A rename within one folder holds that folder and the folders above it too, as it writes into it just as a move into it does.
      - No move takes the root's lock. The root cannot be deleted, and the only delete that holds its lock is one below a cycle that points at it (see the cost below).
      - **A delete can finish between the move finding the folder and the move taking the locks**, which are then free. So once the move holds them, it reads the counters of the way (`dropStale`, since Task 9; as planned, it yielded one turn) and looks the folder up again by its path. It goes on only if it finds the same folder on the same way, with every folder on it the same.
        - If the folder is gone, it fails with `VfsNotFoundError`. If another folder is in its place, or anywhere on the way, it fails with `VfsConflictError` ("was changed by another write").
        - Either way this comes before the move's mark, so it has moved nothing. Folders its own `mkdir -p` made stay, empty.
        - Without it, the move marked its entry, found the folder gone at its next write, and wrote again to take the mark off. It kept the mark if that write failed.
        - As planned, the look relied on having heard the delete's write of the folder above, like the delete's own check, and a late announcement let the move land in a purged record (Decision 9). Since Task 9 it does not: the delete counted that write before it let go of the locks, so the folder's counter has moved, and the look reads it again (Decision 3).
      - **The same name, shared, rather than a lock of its own.** A second name would not refuse anything more. A delete would have to take it too, for every folder it read, which doubles its requests. It would only spare the cost below.
      - **Cost:** a move, rename or delete of a folder is refused, in any tab, while something is being moved into it or into any folder below it. For a delete that is the point. For a move or rename it is only a cost: without the lock nothing is lost, as the fourth and sixth outcomes below show. A move holds these folders only for its own few writes, and trying again works. A move also asks for one lock per folder on its way, at most 64 (`MAX_DEPTH`).
    - **A delete takes the lock of its target and of every entry it read below it,** after its reads and, since Task 7b, **before** its search for an interrupted move's other half (`namedElsewhere`). It holds them until it has let go of everything.
      - As planned, it took them after the search: taken before it, Task 1's "refuses to delete a folder when something in it was marked for a move while the delete read the tree" timed out on the coordinator path (checked on 2026-10-03).
      - Task 7b moved them before the search (ledger W-10). Taken after it, a move in another tab that began during the search could put the entry in its new place, fail to take it from the old, and let go of its lock before the delete took it; the delete then let go of what that move had just named. Task 7b rewrote that Task 1 test so its move comes from a second namespace on the same store. The one-tab path shows no new failure.
      - Not before the reads, which find what is below. A move in another tab that begins during them still holds its lock if it is under way, and the delete is refused. If it has ended, it came before the search and the checks, which read again what it wrote: by counters, since Task 9.
      - Since Task 9, once it holds the locks, the delete reads the counters of the way to its target, of what it read below, and, when it will search, of every cached record (`dropStale`). Since Task 9's fix round, it then always looks the way up again: the same folders, the same entry, not marked since. Otherwise it fails with `VfsNotFoundError` or `VfsConflictError` before anything changes.
      - Let go of once the parent is written, instead of after the purge, a tab that had not yet heard of the delete could move something out of records being purged. A test pins this.
    - **The delete's check (`currentSubtree`) gains one rule with a coordinator:** a record below that names an entry the delete did not read refuses the delete, because that entry's lock is not held. Without it, a file saved into the folder after the read could be moved out by another tab mid-purge, and the purge let go of its content. A test pins this.
    - **A delete also claims what it deletes, within its namespace, in every runtime** (Task 7b, ledger W-10).
      - In the same synchronous step as its first check (`inMotion`), it adds a claim to `deleting`: its target's id at once, and every id it read below the target once its reads end. It lets go of the claim in its `finally`.
      - `rename` refuses, with the "being moved or deleted" message (`heldElsewhere`), when any claim holds its entry or any folder but the root on the way to its source. So a move that begins in the same namespace while a delete reads or searches is refused at its start, in Node and the CLI too. Before, it could be named in its new place, fail to take the entry from the old, and end, all before the delete's detach, which then let go of what it had just named.
      - The ids read below catch the other half of an interrupted move, moved by its other name, which a check of the way cannot see. They are claimed only once the reads end. A move of it by that name that begins during the reads is not refused at its start, and loses nothing (Task 7b report, "Residual windows").
      - Task 1's two re-checks in the detach edit (its fix round, I-1) can no longer be reached: no move in the namespace can begin on what a delete has claimed. They stay, as a second guard. Task 7's mutation row 13 survives by design.
      - Two of Task 1's fix-round tests were rewritten to the new outcome: the second move is refused, and the delete goes ahead. Five Task 1 tests now make their move from a second namespace on the same store, so the delete's own checks stay under test.
      - **Cost:** one more refusal in one namespace: a move or rename of something a delete has begun on, or of anything below it.
    - **Cost:** a recursive delete requests one lock per entry it read, all at once. The requests are local, but a folder of thousands of entries means thousands of them.
      - That includes an entry below that points back at a folder above the target, or at the root. `subtree` (Task 1) records its id before it skips following it. So for the length of such a delete, a move of that folder, or into it unless it is the root, is refused in any tab. It is a needless refusal, never a loss, and it needs a cycle in the tree. `rename` and `copy` refuse to make one. The exception is two moves at once that each put a folder below the other: the move locks refuse one of them, but Node and the CLI have no move locks (Decision 9). Noted, not changed.
    - **A tab asks again for a move lock it has just let go of only once the browser has let go of it too** (Task 7, Step 11). The browser lets go only after the lock callback's promise settles. Without the wait, a move or a delete made straight after another of the same entry in one tab could be refused by that tab's own lock. With shared holds, one tab can let go of two holds of a folder at once, so it waits for every such release under way.
    - **In a browser, the locks also apply within one tab.** That changes six outcomes in one tab, none of them a loss. Matt signed off the first three. The fourth to the sixth come from his change and have not been put to him (Task 7, Step 16). As built, the first is no longer the lock's: since Task 7b the delete's claim refuses that rename from the delete's first check, in every runtime, and the CHANGELOG lists it with Task 1's items. Task 9's fix round adds a seventh, last below. Where the browser refuses Web Locks, the refusals that come from a held lock ("being moved or deleted") do not happen; the coordinator's checks, the third and seventh, still run (ledger NB-3, W-13):
      - a rename, in the same tab, of something a delete is deleting fails with `VfsConflictError` ("being moved or deleted") if it reaches the lock after the delete took its locks and before the delete detached the entry. After the detach it fails with `VfsNotFoundError`, as before. If the detach comes while the rename is still waiting for the lock's answer, Task 1's re-check (its fix round, I-1) refuses the delete as well, with "is being moved"; the rename is then refused, or goes ahead if its request is answered after the delete let go. Nothing is lost either way (checked on 2026-10-04, against the real post-Task-6 tree with Task 7 applied, in a scratch copy);
      - of two deletes of one file or folder at once, the second fails with `VfsConflictError` ("being moved or deleted"), not `VfsNotFoundError`. For a folder this is Task 7, Step 13. For a file it was checked against Task 7's code on 2026-10-03;
      - a recursive delete racing a save into the folder fails with `VfsConflictError` ("was changed by another write"), where Task 1 purged the saved file with the rest;
      - a move or rename of a folder, or of a folder above it, while a move into it is still writing fails with `VfsConflictError` ("being moved or deleted"). Task 1 let it go ahead, and the move into the folder then failed with `VfsNotFoundError` after it had landed, its entry left marked. That was checked against Task 7's code on 2026-10-04, for the folder itself, and again for a folder above it;
      - a move into a folder, or into a folder below it, that a delete in the same tab has taken its locks for, and not yet detached, fails with `VfsConflictError` ("being moved or deleted"). Task 1 let it go into a new folder of that name, made once the delete had detached the old one. That was checked the same day, into the folder itself;
      - a move into a folder, or into a folder below it, that a move or rename in the same tab is still moving fails with `VfsConflictError` ("being moved or deleted"). This is the fourth outcome the other way round. Task 1 let both go ahead, and what was moved in ended up in the folder at its new place: `/a/f.txt` moved into `/d` while `/d` moved into `/z` ended up at `/z/d/f.txt`. Checked on 2026-10-04, into the folder itself and into a folder below it;
      - since Task 9's fix round, a delete of a file or folder while a move or rename in the same tab moves a folder on its way fails with `VfsNotFoundError` or `VfsConflictError` and deletes nothing. That is the delete's second look at its way. Node still deletes the file from its new place. Disclosed in the CHANGELOG by the final review's fixes (Task 9 r1 N-1).

      Node and the CLI keep Task 1's behaviour, plus Task 7b's claim. Apps that branch on these error names need to know: see Task 7, Step 15 and the Production section.
11. **What execution changed, 2026-10-04/05.** The task steps below are left as they were planned. This is what was built differently, or added, and why. The controller ruled on each item (ledger W-9 to W-14); Matt has not signed them off. Each task's brief, report and reviews are in `/Users/matt/GitHub/muhkoo/connect/.superpowers/sdd/2026-10-03-cross-tab-writes/`.
    - **Task 7, re-based first (W-9).** Its anchors quoted `delete` from before Task 1's fix round (I-1), and one of its blocks would have reverted that fix. It was re-based onto the real post-Task-6 code before it ran, keeping both I-1 re-checks.
    - **Task 7b: the delete's claim, and its locks before the search (W-10).** It closes a content-loss race that Task 1's re-review found and the re-base raised again: a move begun during a delete's `namedElsewhere` search. See Decision 10. Files: `task-7b-brief.md`, `task-7b-report.md`.
    - **Task 8: BLOCKED.** connect, the race probe and the CLI passed, and Cloud Drive staging served the W1 build. But Brave lost files: uploads in 3 of 4 runs, the Trash moves check (M3) in 2 of 4. Its order probe measured why: the announcement can reach a tab after the next lock grant, about 6% of the time even after one turn (Decision 3). The move lock itself worked: M1 and M2 were refused, and M3 shared the Trash's lock.
    - **Task 9: a write counter in IndexedDB (W-11).** Freshness is ordered by a per-record count, bumped before the lock is let go of and read under it; the announcement is a hint. See Decision 3. It also folded in Task 7b's CHANGELOG fixes. After its fix round: unit 1118; `tests/vfs/cross-tab.test.ts` runs 37 tests with prompt announcements and 51 with late ones. Files: `task-9-brief.md`, `task-9-report.md`.
    - **Task 8b: the Brave checks again, on Task 9's build (W-12).** Uploads 6 of 6 runs (528 of 528 files) and moves 6 of 6 counted runs, with no `[muhkoo/vfs]` warning. One more moves run failed at sign-in, on the staging account's limit of 20 sign-ins in 5 minutes, before any move; its folder read back intact. Cloud Drive staging was deployed as release `rel_9b055529853a`.
    - **The final whole-change review, 2026-10-05.** No Critical. Two Important findings, both fixed (snapshot 6a3fd8b to 7e5f4d8); a scoped re-review found nothing open.
      - **I-1: Web Locks or the BroadcastChannel refused.** Where the browser refused them (a `SecurityError`: a sandboxed or opaque-origin iframe, or blocked site data), every folder write failed, and every read too when the channel constructor threw. Now a refusal before the grant means no lock, and is remembered: `lock` runs the write unlocked, `holdMoving` resolves to `() => {}`, and `drainLock` runs the drain. The channel constructor is in a try/catch, so a refused tab hears nothing. See Decision 5 and W-13.
      - **I-2: IndexedDB calls had no time limit.** A hung open was kept for ever and held the locks. Now each IndexedDB open and each transaction gives up after 3 seconds (`COUNT_WAIT_MS`) and resolves to null, which means "read again". An open given up on is not kept, and is closed if it opens later. A transaction given up on is not aborted.
      - **CHANGELOG fixes:** the coalescing headline now says "far fewer writes", not "at most two"; "trying again deletes it, though it can take more than one try"; the save residual's wording; and the same-tab delete outcome that was not disclosed (Decision 10). Also Minors 5, 6, 7 and 10.
      - **Gates after the fixes:** unit 1127; the five W1 test files 173 of 173, five times; the one-tab path 471 of 474, the three failures being Task 7's by design; CLI 498.
      - What was parked after it is in Decision 9.
    - **Task 8c: one more Brave pass, on the final build (W-14).** The fixes changed `crossTab.ts` after Task 8b, so: at least 3 upload runs and 3 paced moves runs, and a best-effort check with blocked site data. Green on 2026-10-05 (release `rel_15fde287f20d`): uploads 3/3, paced moves 3/3, no `[muhkoo/vfs]` warning. With cookies blocked for the staging origin, Brave refused Web Locks and IndexedDB, and the blocked tab still made a folder, uploaded, renamed and moved to the Trash with no error; the pre-fix build failed its first folder there. The BroadcastChannel side of the fallback rests on the unit tests: a cookie block does not refuse the channel.
    - **Where the task steps no longer match the code.** Tasks 3 to 7 build the announcement check: the `nextTurn()` after the grant, and the "… may be lost" warning that Task 8's scripts fail on (`lateHeard`). Task 9 removed both. Task 7's steps take the delete's locks after its search; Task 7b moved them before it. The test counts in the task steps are as planned; the final ones are above.

## File Structure

| File | Task | Responsibility |
|---|---|---|
| scratchpad `w1-baseline/` (create, not in a repo) | 0 | The snapshot every checkpoint compares against, and `changed.sh` |
| `src/vfs/VfsNamespace.ts` (modify) | 1, 2, 3, 7, 7b, 9, final review | In-motion set, subtree re-check, coalesced batches, the coordinator path (re-read and replay under the lock, decided by the write counter since Task 9: `begin`/`bump` in `sendLocked`, `dropStale` after every move's and delete's locks), `mkdir` waiting for a name not yet written, the move locks in `rename` and `delete`, including the shared locks of the folders on a move's way, and the delete's claim (`deleting`, Task 7b) |
| `src/vfs/coordinator.ts` (create) | 3, 7, 9, final review | The internal `VfsCoordinator` interface; Task 7 adds `holdMoving(id, shared?)`, Task 9 adds `counters(ids)`, `begin(id)` and `bump(id)`, and the final review's fixes document the refusals and time limits. Not re-exported. |
| `src/offline/OutboundQueue.ts` (modify) | 4 | `TryLock` and `OutboundQueueOptions`; the drain under the device lock, until a pass leaves nothing |
| `src/offline/OfflineManager.ts` (modify) | 4, 5 | Passes the drain lock in; one HLC node id per tab |
| `src/core/crossTab.ts` (create) | 6, 7, 9, final review | Browser-only Web Locks, BroadcastChannel and IndexedDB: `vfsCoordinator` (with `holdMoving` from Task 7, and the write counts in IndexedDB `muhkoo.vfs`, `writeCounts`, from Task 9), `drainLock`. From the final review: the fallback where the browser refuses Web Locks or the channel (`refusesLocks`), and the 3-second limit on each IndexedDB call (`COUNT_WAIT_MS`) |
| `src/core/Client.ts` (modify) | 6 | Wires both in |
| `tests/vfs/write-order.test.ts` (modify) | 1, 2, 7b | In-tab move/delete; coalescing; the delete's claim (Task 7b) |
| `tests/vfs/cross-tab.test.ts` (create) | 3, 7, 7b, 9 | Two namespaces over one store with a fake coordinator; moves and deletes across them (Task 7). Since Task 9 the fake counts writes, and the cross-tab describes run twice, with prompt and with late announcements, plus a late-only describe and one for a tab that cannot count |
| `tests/offline/tabs.test.ts` (create) | 4, 5 | Two managers over one IndexedDB: drain once, nothing left behind; distinct node ids |
| `tests/core/crossTab.test.ts` (create) | 6, 7, 9, final review | The browser coordinator, against a fake `navigator.locks` and Node's real `BroadcastChannel`, and its move locks (Task 7); its write counts on `fake-indexeddb` (Task 9); refusals and IndexedDB time limits, end to end with a `VfsNamespace` too (final review) |
| `tests/client/tabs.test.ts` (create) | 6 | `Client` wires both only in a browser tab |
| `CHANGELOG.md` (modify) | 1, 2, 4, 5, 6, 7, 7b, 9, final review | `## Unreleased` only, which starts empty |
| scratchpad `one-tab.ts`, `vitest.one-tab.config.mts` (create, not in a repo) | 3, 7, 9 | The existing suites run once on the coordinator path; Task 7 adds `holdMoving` to `one-tab.ts`, and Task 9 in-memory `counters`, `begin` and `bump` |
| scratchpad `w1-two-tabs.mjs` (create, not in a repo) | 8, 8b, 8c | The two-tab upload check in Brave. Task 8b ran its variant `w1-task8/w1-two-tabs.diag.mjs` |
| scratchpad `w1-two-tab-moves.mjs` (create, not in a repo) | 8, 8b, 8c | The two-tab move and delete check in Brave, two moves into one folder included. Task 8 found a script defect; Task 8b ran the fixed variant `w1-task8/w1-two-tab-moves.loaded.mjs`, paced by `paced.mjs` |
| scratchpad `w1-task8/order-probe.mjs` (create, not in a repo) | 8, 8b | Measures whether a BroadcastChannel message reaches the next Web Lock holder before its grant (Decision 3) |

---

### Task 0: Re-base check and a snapshot of the working tree

connect's tree is not clean. Before W1 touches anything, `git diff --stat` already shows 46 files changed (+7063, −567), and there are about 25 untracked paths. Several of the files W1 edits are among them. No checkpoint can ask git what W1 changed, so each one compares against this snapshot instead.

`<scratchpad>` below means the executing session's scratchpad directory. Use its absolute path.

**Files:**
- Create, in the scratchpad only: `<scratchpad>/w1-baseline/`, holding `dirty.sha`, `CHANGELOG.md`, `released.before` and `changed.sh`.
- Nothing in any repo changes.

- [ ] **Step 1: Confirm the version this plan is based on.**

Run: `cd /Users/matt/GitHub/muhkoo/connect && node -p "require('./package.json').version" && npm view @muhkoo/connect dist-tags && grep -n -m 2 "^## " CHANGELOG.md && sed -n '/^## Unreleased/,/^## 0/p' CHANGELOG.md`

Expected:
- `0.15.0-alpha.3`, then `{ latest: '0.15.0-alpha.3', alpha: '0.15.0-alpha.3' }`;
- the first two headings are `## Unreleased` and `## 0.15.0-alpha.3 — …(2026-10-03)`;
- nothing but blank lines between them: `## Unreleased` is empty.

If any of these differs, connect has moved on again. Stop and re-base the plan before Task 1: every `0.15.0-alpha.3` and `alpha.4` below, and the CHANGELOG steps.

- [ ] **Step 2: Take the snapshot.** Run, as one block:

```bash
B=<scratchpad>/w1-baseline
mkdir -p "$B" && cd /Users/matt/GitHub/muhkoo/connect
git ls-files -m -o --exclude-standard -z | xargs -0 shasum -a 256 | sort -k 2 > "$B/dirty.sha"
cp CHANGELOG.md "$B/CHANGELOG.md"
sed -n '/^## 0\.15\.0-alpha\.3 /,$p' CHANGELOG.md > "$B/released.before"
ls src/vfs/coordinator.ts src/core/crossTab.ts tests/vfs/cross-tab.test.ts tests/offline/tabs.test.ts tests/core/crossTab.test.ts tests/client/tabs.test.ts 2>&1 | grep -c "No such file"
```

Expected: `6`, because none of the files W1 creates exists yet. `dirty.sha` has about 95 lines.

- [ ] **Step 3: Write `<scratchpad>/w1-baseline/changed.sh`.**

```sh
#!/bin/sh
# What W1 has changed in connect so far: every file whose content differs from
# the Task 0 snapshot (changed, created or removed since), then whether the
# released CHANGELOG sections are still byte-identical. Reads only.
B=$(cd "$(dirname "$0")" && pwd)
cd /Users/matt/GitHub/muhkoo/connect || exit 2
git ls-files -m -o --exclude-standard -z | xargs -0 shasum -a 256 | sort -k 2 > "$B/now.sha"
diff "$B/dirty.sha" "$B/now.sha" | sed -n 's/^[<>] [0-9a-f]*  //p' | sort -u
if sed -n '/^## 0\.15\.0-alpha\.3 /,$p' CHANGELOG.md | cmp -s - "$B/released.before"; then
    echo "released CHANGELOG sections: unchanged"
else
    echo "released CHANGELOG sections: CHANGED"
fi
```

Run: `sh <scratchpad>/w1-baseline/changed.sh`

Expected: one line, `released CHANGELOG sections: unchanged`, and no file names.

At every checkpoint below, `changed.sh` should list exactly the files the tasks so far have named. It also lists this plan file if its checkboxes have been ticked. Any other file is a change W1 did not plan: stop and report it. `released CHANGELOG sections: CHANGED` means a released section was edited: restore it from `<scratchpad>/w1-baseline/CHANGELOG.md` by hand, keeping the `## Unreleased` additions.

---

### Task 1: In-tab move/delete coordination

> **Executed 2026-10-04, with a fix round the steps below do not show.** Review finding I-1: `delete` checked `inMotion` only before its awaits. Fix round 1 hoisted `subtree`'s `ids` into a `let ids` beside `shape`, re-checked `entry.id` and `ids` against `inMotion` inside the detach edit, and added two tests to "VFS — a move in progress" (11 there, not 9; write-order.test.ts 35 after Task 1). Recorded in the ledger (`progress.md`, Task 1 and Ruling W-9) and in `task-1-report.md` ("Fix round 1"). Task 7 is anchored on the code as fixed.

Close the Task 19 reviews' P1, P2, P1-file and "late second move" data-loss races, and the two minor issues in the same code:
- a rename that loses at step 2 leaves its source marked;
- step 3 writes the source record when the entry is already gone.

**Files:**
- Modify: `src/vfs/VfsNamespace.ts`:
  - module helpers near `changedMeanwhile` (~`:425`), `unfollowable` (~`:582`) and `Leaving` (~`:291`);
  - fields after `writing` (~`:627`);
  - `delete` (`:1156-1256`), `rename` (`:1267-1358`), `subtree` (`:1939-1976`), and a new `currentSubtree` after it.
- Modify: `tests/vfs/write-order.test.ts`: two helpers after `lastWrite` (~`:123`), and a new `describe` at the end.
- Modify: `CHANGELOG.md`: a new `### Fixed` under `## Unreleased`, and its first bullet. The released `## 0.15.0-alpha.3` section is not touched.

**Interfaces:**
- Consumes the existing `mutate(dir, edit)` contract: an edit re-checks before it changes anything, and returning `false` writes nothing. It also uses `sameEntry`, `markedMeanwhile`, `changedMeanwhile`, `editable`, `reopen` and `followable`.
- Produces, used by Task 3:
  - `private readonly inMotion: Set<string>`;
  - `function beingMoved(path: string, inside?: boolean): VfsConflictError`;
  - `type SubtreeShape = Map<string, Map<string, boolean>>`;
  - `function namedIn(dir: OpenDir): Map<string, boolean>`;
  - `subtree(...)` now returns `{ dirs: OpenDir[]; moving: boolean; ids: Set<string>; shape: SubtreeShape }`;
  - `private currentSubtree(dirs: OpenDir[], shape: SubtreeShape): OpenDir[] | null`;
  - test helpers `outcome(promise)` and `quiet()` in `write-order.test.ts`.

- [ ] **Step 1: Add the two test helpers.** In `tests/vfs/write-order.test.ts`, insert this after the `lastWrite` function (just before `describe("VFS — writes of one directory record"`):

```ts
/** A promise's outcome, without waiting on it here: "done", or what it threw. */
function outcome(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(() => "done", (err: unknown) => err);
}

/** Let everything that is not waiting on a held write run as far as it can. */
async function quiet(): Promise<void> {
    for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
}
```

- [ ] **Step 2: Write the failing tests.** Append this `describe` block at the end of `tests/vfs/write-order.test.ts`:

```ts
describe("VFS — a move in progress", () => {
    it("refuses to delete a folder while a move of it is under way, rather than purging it from its new place", async () => {
        // The delete began after the move had marked the folder, so it took
        // the folder for half of an interrupted move and looked for the other
        // half - which the move had not yet put in /b. Finding none, it purged
        // the folder, and the move then put the purged folder in /b.
        const made = makeVfs();
        const { vfs } = made;
        await vfs.writeFile("/a/d/f.txt", "f");
        await vfs.writeFile("/b/x.txt", "x");
        const mark = holdWrite(made, await recordKey(vfs, "/a"), 1);   // the move's first step: /a/d marked

        const move = vfs.rename("/a/d", "/b/d");
        await mark.holding;
        const del = outcome(vfs.delete("/a/d", { recursive: true }));
        await quiet();
        mark.release();
        await move;

        expect(await del).toBeInstanceOf(VfsConflictError);
        const stored = fresh(made);
        expect(await stored.walk("/")).toEqual(["/b/d/f.txt", "/b/x.txt"]);
        expect(await stored.readText("/b/d/f.txt")).toBe("f");
        expect(await vfs.readText("/b/d/f.txt")).toBe("f");
    });

    it("refuses to delete a file while a move of it is under way, rather than letting go of its content", async () => {
        const made = makeVfs();
        const { vfs } = made;
        await vfs.writeFile("/a/f.txt", "f");
        await vfs.writeFile("/b/x.txt", "x");
        const mark = holdWrite(made, await recordKey(vfs, "/a"), 1);

        const move = vfs.rename("/a/f.txt", "/b/f.txt");
        await mark.holding;
        const del = outcome(vfs.delete("/a/f.txt"));
        await quiet();
        mark.release();
        await move;

        expect(await del).toBeInstanceOf(VfsConflictError);
        const stored = fresh(made);
        expect(await stored.walk("/")).toEqual(["/b/f.txt", "/b/x.txt"]);
        expect(await stored.readText("/b/f.txt")).toBe("f");
    });

    it("refuses a second move of a file that starts while the first is still writing", async () => {
        // The second move found the file marked - by the first - and took it
        // for half of an interrupted move, which it finished: the file ended
        // up named in both places, with one content reference between them.
        const made = makeVfs();
        const { vfs } = made;
        await vfs.writeFile("/a/f.txt", "f");
        await vfs.mkdir("/b");
        await vfs.mkdir("/c");
        const attach = holdWrite(made, await recordKey(vfs, "/b"), 1);   // the first move putting it in /b

        const first = vfs.rename("/a/f.txt", "/b/f.txt");
        await attach.holding;
        const second = await outcome(vfs.rename("/a/f.txt", "/c/f.txt"));
        attach.release();
        await first;

        expect(second).toBeInstanceOf(VfsConflictError);
        const stored = fresh(made);
        expect(await stored.walk("/")).toEqual(["/b/f.txt"]);
        expect(await stored.readText("/b/f.txt")).toBe("f");
    });

    it("refuses to delete a folder while something in it is being moved, rather than purging what the move carries", async () => {
        const made = makeVfs();
        const { vfs } = made;
        await vfs.writeFile("/a/d/f.txt", "f");
        await vfs.writeFile("/b/x.txt", "x");
        const mark = holdWrite(made, await recordKey(vfs, "/a"), 1);   // /a/d marked, on its way to /b

        const move = vfs.rename("/a/d", "/b/d");
        await mark.holding;
        expect(await outcome(vfs.delete("/a", { recursive: true }))).toBeInstanceOf(VfsConflictError);
        mark.release();
        await move;

        const stored = fresh(made);
        expect(await stored.walk("/")).toEqual(["/b/d/f.txt", "/b/x.txt"]);
        expect(await stored.readText("/b/d/f.txt")).toBe("f");
    });

    it("refuses to delete a folder that something in it was moved out of while the delete read it", async () => {
        // The delete read /a, then /a/d; the whole move of /a/d to /b ran in
        // between. The delete then re-checked only /a itself - unchanged -
        // and purged everything it had read, /a/d's record included: /b/d was
        // left pointing at a record that no longer existed.
        const made = watched();
        const { vfs, store, echo } = made;
        await vfs.writeFile("/a/d/f.txt", "f");
        await vfs.writeFile("/b/x.txt", "x");
        const folder = await recordKey(vfs, "/a/d");
        echo(folder);                         // so the delete reads /a/d from the store
        const get = store.get.bind(store);
        const asked = deferred();
        const answer = deferred();
        store.get = async (k: string) => {
            if (k === folder) {
                asked.resolve();
                await answer.promise;
            }
            return get(k);
        };

        const del = outcome(vfs.delete("/a", { recursive: true }));
        await asked.promise;                  // the delete has read /a, with d in it
        await vfs.rename("/a/d", "/b/d");     // the whole move, start to finish
        answer.resolve();

        expect(await del).toBeInstanceOf(VfsConflictError);
        const stored = fresh(made);
        expect(await stored.walk("/")).toEqual(["/b/d/f.txt", "/b/x.txt"]);
        expect(await stored.readText("/b/d/f.txt")).toBe("f");
    });

    it("refuses to delete a folder when something in it was marked for a move while the delete read the tree", async () => {
        // /a holds half of an interrupted move, so the delete read the whole
        // tree before it detached /a. A move of /a/d marked it meanwhile -
        // after the delete had read /a - and the delete, re-checking only /a
        // itself, purged /a/d from under the move.
        const made = watched();
        const { vfs, store, echo } = made;
        await vfs.writeFile("/a/d/f.txt", "f");
        await vfs.writeFile("/a/g.txt", "g");
        await vfs.writeFile("/b/x.txt", "x");
        await vfs.mkdir("/c");
        await vfs.writeFile("/z/z.txt", "z");
        const a = await recordKey(vfs, "/a");
        // Half of an interrupted move of /a/g.txt: its detach from /a fails.
        const detach = holdWrite(made, a, 2);
        const interrupted = vfs.rename("/a/g.txt", "/c/g.txt");
        await detach.holding;
        detach.fail();
        await expect(interrupted).rejects.toThrow("network");
        // The delete's read of the tree reaches /z last, and is held there.
        const last = await recordKey(vfs, "/z");
        echo(last);
        const get = store.get.bind(store);
        const asked = deferred();
        const answer = deferred();
        store.get = async (k: string) => {
            if (k === last) {
                asked.resolve();
                await answer.promise;
            }
            return get(k);
        };

        const del = outcome(vfs.delete("/a", { recursive: true }));
        await asked.promise;                  // it has read /a, and the tree up to /z
        const mark = holdWrite(made, a, 1);
        const move = vfs.rename("/a/d", "/b/d");
        await mark.holding;                   // /a/d marked, its write held
        answer.resolve();

        expect(await del).toBeInstanceOf(VfsConflictError);
        mark.release();
        await move;
        const stored = fresh(made);
        expect(await stored.readText("/b/d/f.txt")).toBe("f");
        expect(await stored.readText("/c/g.txt")).toBe("g");
    });

    it("lets go only of what a folder holds when it is deleted, not of a file moved out of it while the delete read it", async () => {
        // The delete read /a, then waited on /a/sub. A change to /a was
        // reported meanwhile, so the move that then took /a/f.txt to /b read
        // /a again and edited that copy. The delete let go of what its OWN
        // read of /a named - f.txt's content among it, which /b/f.txt still
        // used.
        const made = watched();
        const { vfs, store, echo } = made;
        await vfs.writeFile("/a/f.txt", "f");
        await vfs.writeFile("/a/sub/s.txt", "s");
        await vfs.mkdir("/b");
        const a = await recordKey(vfs, "/a");
        const sub = await recordKey(vfs, "/a/sub");
        echo(sub);
        const get = store.get.bind(store);
        const asked = deferred();
        const answer = deferred();
        store.get = async (k: string) => {
            if (k === sub) {
                asked.resolve();
                await answer.promise;
            }
            return get(k);
        };

        const del = vfs.delete("/a", { recursive: true });
        await asked.promise;                  // the delete has read /a, f.txt in it
        echo(a);                              // a change to /a reported: the next read of /a is a fresh copy
        await vfs.rename("/a/f.txt", "/b/f.txt");
        answer.resolve();
        await del;

        const stored = fresh(made);
        expect(await stored.walk("/")).toEqual(["/b/f.txt"]);
        expect(await stored.readText("/b/f.txt")).toBe("f");
    });

    it("leaves a file it could not move unmarked, when another move took its destination first", async () => {
        // The loser had marked its file as half of a move before it found the
        // destination taken. Left marked, every version that fell off the
        // file's history was kept for good, and every delete of it read the
        // whole tree looking for a second half that does not exist.
        const made = makeVfs();
        const { vfs, store } = made;
        await vfs.writeFile("/a/one.txt", "1");
        await vfs.writeFile("/b/two.txt", "2");
        await vfs.writeFile("/z/z.txt", "z");
        const z = await recordKey(vfs, "/z");
        const sources = ["/a/one.txt", "/b/two.txt"];

        const moves = await Promise.allSettled(sources.map((path) => vfs.rename(path, "/c/x.txt")));

        expect(moves.map((m) => m.status).sort()).toEqual(["fulfilled", "rejected"]);
        const left = sources[moves.findIndex((m) => m.status === "rejected")];
        const reader = fresh(made);
        expect(await reader.readText(left)).toBe(left === "/a/one.txt" ? "1" : "2");
        // A delete of an entry marked as half of a move reads the whole tree
        // for the other half; a delete of one that is not, does not.
        const gets = store.gets.length;
        await reader.delete(left);
        expect(store.gets.slice(gets)).not.toContain(z);
    });

    it("writes nothing to the folder a move leaves when the entry is gone from it by then", async () => {
        const made = watched();
        const { vfs, store, echo } = made;
        await vfs.writeFile("/a/f.txt", "f");
        await vfs.mkdir("/b");
        const a = await recordKey(vfs, "/a");
        const attach = holdWrite(made, await recordKey(vfs, "/b"), 1);

        const move = vfs.rename("/a/f.txt", "/b/f.txt");
        await attach.holding;                 // /a/f.txt marked; on its way to /b
        // Another device takes it out of /a, keeping its content, and the change reaches this tab.
        await fresh(made).delete("/a/f.txt", { keepContent: true });
        echo(a);
        const put = store.put.bind(store);
        let writesOfA = 0;
        store.put = async (k: string, value: unknown) => {
            if (k === a) writesOfA++;
            return put(k, value);
        };
        attach.release();
        await move;

        expect(writesOfA).toBe(0);
        const stored = fresh(made);
        expect(await names(stored, "/a")).toEqual([]);
        expect(await stored.readText("/b/f.txt")).toBe("f");
    });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd /Users/matt/GitHub/muhkoo/connect && npx vitest --run tests/vfs/write-order.test.ts -t "a move in progress"`

Expected: all 9 FAIL, and each failure is the bug the test names:
- tests 1, 2 and 4–6: `expected 'done' to be an instance of VfsConflictError`;
- test 3: `expected 'done' to be an instance of VfsConflictError`;
- test 7: `Error: content missing`;
- test 8: `expected [ …, 'vfs/d/<z id>' ] not to include 'vfs/d/<z id>'`;
- test 9: `expected 1 to be +0`.

The older tests in the file still pass.

- [ ] **Step 4: Add the module helpers.** In `src/vfs/VfsNamespace.ts`, directly after the `changedMeanwhile` function, add:

```ts
/**
 * Refuse an operation on `path` because this namespace is moving it - or,
 * `inside`, something in it. See `VfsNamespace.inMotion`.
 */
function beingMoved(path: string, inside = false): VfsConflictError {
    const what = inside ? `something in ${path} is` : `${path} is`;
    return new VfsConflictError(`${what} being moved; nothing was changed - try again once the move has finished`);
}
```

Directly after `type Leaving = …;`, add:

```ts
/**
 * What a recursive delete read in each directory it is about to purge: by
 * directory id, the id of every entry it named then, and whether an entry
 * with that id was marked as half of a move. See `VfsNamespace.currentSubtree`.
 */
type SubtreeShape = Map<string, Map<string, boolean>>;
```

Directly after the `unfollowable` function, add:

```ts
/** The id of every entry `dir` follows, and whether an entry with that id is marked: `SubtreeShape`'s view of it. */
function namedIn(dir: OpenDir): Map<string, boolean> {
    const named = new Map<string, boolean>();
    for (const [, entry] of followable(dir)) named.set(entry.id, named.get(entry.id) === true || entry.moving === true);
    return named;
}
```

- [ ] **Step 5: Add the `inMotion` field.** Directly after the `writing` field (`private readonly writing = new Map<string, Promise<void>>();`), add:

```ts
    /**
     * Every entry this namespace is moving right now, by id.
     *
     * A move between two directories marks the entry before it puts it in
     * the second (see `rename`), and a mark is all a later operation can
     * see. It cannot tell a move still writing from one that was
     * interrupted, and was taken for the second: a delete that began after
     * a move had marked a folder looked for the folder's other half, found
     * none yet, and purged it while the move was putting it in its new
     * place; a second move of a file finished the "interrupted" move and
     * left it named in two places. So a move holds its entry here until it
     * has taken it from where it was, and `rename` and `delete` refuse an
     * entry that is here - or, for a delete, a folder holding one.
     */
    private readonly inMotion = new Set<string>();
```

- [ ] **Step 6: Change `subtree`.** Replace the signature line and the start of the body:

```ts
    ): Promise<{ dirs: OpenDir[]; moving: boolean }> {
        const found = new Map<string, OpenDir>([[top.id, top]]);
        const pending = [top];
        let spared = 0;
        let moving = false;
        for (let dir = pending.pop(); dir; dir = pending.pop()) {
            for (const [, entry] of followable(dir)) {
                if (entry.moving === true) moving = true;
```

with:

```ts
    ): Promise<{ dirs: OpenDir[]; moving: boolean; ids: Set<string>; shape: SubtreeShape }> {
        const found = new Map<string, OpenDir>([[top.id, top]]);
        const pending = [top];
        // Every entry id in it, and what each record named as it was read.
        const ids = new Set<string>();
        const shape: SubtreeShape = new Map();
        let spared = 0;
        let moving = false;
        for (let dir = pending.pop(); dir; dir = pending.pop()) {
            shape.set(dir.id, namedIn(dir));
            for (const [, entry] of followable(dir)) {
                ids.add(entry.id);
                if (entry.moving === true) moving = true;
```

Also replace its return line `return { dirs: [...found.values()], moving };` with `return { dirs: [...found.values()], moving, ids, shape };`. Add these lines to the end of its doc comment, after the paragraph about `moving`:

```ts
     *
     * `ids` is every entry id in it, and `shape` what each record named when
     * it was read: see `currentSubtree`.
```

- [ ] **Step 7: Add `currentSubtree`.** Directly after the `subtree` method, add:

```ts
    /**
     * The records a recursive delete read, as they are now - or null when
     * one has changed since in a way that purging it would get wrong.
     *
     * The delete decided what to let go of, and whether to look for the
     * other half of a move, from what it read; then it waited, on reads and
     * on the write of its parent. A record that is no longer named by the
     * record it was read in has been moved out, and is not this delete's to
     * purge; an entry marked since it was read is being moved, and is about
     * to be named somewhere the delete never looked. Purging either purged
     * the folder a move had just put somewhere else. Anything else - a file
     * saved into one of them, or moved out - is purged as it now stands,
     * which is why the copies to purge are what this returns.
     *
     * Synchronous, for an edit. A record whose copy is not to hand counts as
     * changed.
     */
    private currentSubtree(dirs: OpenDir[], shape: SubtreeShape): OpenDir[] | null {
        const doomed = new Set(dirs.map((dir) => dir.id));
        const current: OpenDir[] = [];
        for (const dir of dirs) {
            const now = this.editable(dir);
            if (!now) return null;
            const read = shape.get(dir.id) ?? new Map<string, boolean>();
            const named = namedIn(now);
            for (const [id, marked] of named) if (marked && read.get(id) !== true) return null;
            for (const id of read.keys()) if (doomed.has(id) && !named.has(id)) return null;
            current.push(now);
        }
        return current;
    }
```

- [ ] **Step 8: Change `delete`.** There are four replacements.

(a) Replace:

```ts
            this.warn(`removed ${where} without clearing out what it held: this version cannot read it`);
            return;
        }
        // Every directory above the target, the root first. None of them is
```

with:

```ts
            this.warn(`removed ${where} without clearing out what it held: this version cannot read it`);
            return;
        }
        // Being moved by this namespace: it is marked already, or about to be,
        // and on its way to a second place. Letting go of it here would let
        // go of what the move puts there. See `inMotion`.
        if (this.inMotion.has(entry.id)) throw beingMoved(target);
        // Every directory above the target, the root first. None of them is
```

(b) Replace:

```ts
        let doomed: OpenDir[] = [];
        // Whether any of it is half of an interrupted move. See below.
```

with:

```ts
        let doomed: OpenDir[] = [];
        // What each of them named when it was read, for the check before the detach.
        let shape: SubtreeShape = new Map();
        // Whether any of it is half of an interrupted move. See below.
```

(c) Replace:

```ts
                const found = await this.subtree(child, target, above);
                doomed = found.dirs;
                moving = entry.moving === true || found.moving;
```

with:

```ts
                const found = await this.subtree(child, target, above);
                // Something in it is being moved by this namespace: the same
                // as the target being moved, a level down.
                for (const id of found.ids) if (this.inMotion.has(id)) throw beingMoved(target, true);
                doomed = found.dirs;
                shape = found.shape;
                moving = entry.moving === true || found.moving;
```

(d) Replace the block from `await this.mutate(parent, (node) => {` through the purge line:

```ts
        await this.mutate(parent, (node) => {
            // What is let go of below is what `entry` held. Gone since, it
            // was let go of already; replaced, the name holds something this
            // delete has not read. Marked since, a move of it has begun, and
            // what it holds is about to be named somewhere `elsewhere` did
            // not see - if it was looked for at all.
            const now = entryIn(node, name);
            if (!now) throw new VfsNotFoundError(target);
            if (!sameEntry(entry, now) || markedMeanwhile(entry, now)) throw changedMeanwhile(target);
            delete node.entries[name];
        });

        if (elsewhere === null) {
            // Part of the tree cannot be read, so it is unknown whether the
            // other copy is in it. Keeping what may be its contents costs
            // storage until a sweep; letting go of them could lose them.
            this.warn(`detached ${target} but kept what it held: a move of it was interrupted, and part of the tree cannot be read to find the other copy`);
            return;
        }
        if (entry.kind === "dir") await this.purge(doomed, elsewhere, opts.keepContent);
```

with:

```ts
        // The check in the edit below looks at each record to be purged as it
        // is then, which needs it to hand: a change reported meanwhile may
        // have dropped one from the cache. Read again, it is still checked
        // against what was read before.
        for (const dir of doomed) if (!this.editable(dir)) await this.reopen(dir);

        let purging = doomed;
        await this.mutate(parent, (node) => {
            // What is let go of below is what `entry` held. Gone since, it
            // was let go of already; replaced, the name holds something this
            // delete has not read. Marked since, a move of it has begun, and
            // what it holds is about to be named somewhere `elsewhere` did
            // not see - if it was looked for at all.
            const now = entryIn(node, name);
            if (!now) throw new VfsNotFoundError(target);
            if (!sameEntry(entry, now) || markedMeanwhile(entry, now)) throw changedMeanwhile(target);
            // And what is purged is what the records below hold now - unless
            // something in them has been moved, or begun to move, since they
            // were read. See `currentSubtree`.
            const current = this.currentSubtree(doomed, shape);
            if (!current) throw changedMeanwhile(target);
            purging = current;
            delete node.entries[name];
        });

        if (elsewhere === null) {
            // Part of the tree cannot be read, so it is unknown whether the
            // other copy is in it. Keeping what may be its contents costs
            // storage until a sweep; letting go of them could lose them.
            this.warn(`detached ${target} but kept what it held: a move of it was interrupted, and part of the tree cannot be read to find the other copy`);
            return;
        }
        if (entry.kind === "dir") await this.purge(purging, elsewhere, opts.keepContent);
```

- [ ] **Step 9: Replace `rename`.** Replace the whole method, from `    async rename(from: string, to: string): Promise<void> {` to its closing brace (just before the `/**` of `assertFitsAt`), with:

```ts
    async rename(from: string, to: string): Promise<void> {
        const src = this.resolve(from);
        const dst = this.resolve(to);
        if (src === dst) return;
        if (src === "/") throw new VfsConflictError("the root directory cannot be moved");
        if (isUnder(dst, src)) throw new VfsConflictError(`cannot move ${src} into itself`);

        const srcName = basename(src);
        const dstName = basename(dst);
        assertValidName(dstName);

        const srcParent = await this.openDir(dirname(src));
        const entry = entryIn(srcParent.node, srcName);
        if (!entry) throw new VfsNotFoundError(src);
        // Another move of it is under way here. Its mark cannot tell that
        // move from an interrupted one, and finishing it as one named the
        // entry in two places. Held from here, before the first wait, so two
        // moves begun together cannot both get past this. See `inMotion`.
        if (this.inMotion.has(entry.id)) throw beingMoved(src);
        this.inMotion.add(entry.id);

        // Each record is re-opened before it is written: creating the
        // destination's parents below may have written to the source's.
        const edit = (path: string, change: (node: DirNode, record: OpenDir) => boolean | void) =>
            this.openDir(path).then((dir) => this.mutate(dir, change));
        let unmarkLanded = false;
        try {
            if (entry.kind === "dir") {
                assertWritableDepth(dst);
                if (segments(dst).length > segments(src).length) await this.assertFitsAt(src, dst);
            }
            await this.mkdir(dirname(dst), { recursive: true });
            const dstParent = await this.openDir(dirname(dst));
            if (entryIn(dstParent.node, dstName)) throw new VfsConflictError(`${dst} already exists`);
            assertNotHidden(dstParent, dstName, dst);

            // Both ends were looked at before the waits above, and another write
            // may have changed either since: replaced the entry being moved, or
            // put something at the destination. Moving on regardless would write
            // the old entry over the new one, or this one over the other. Or
            // marked the entry: another move of it has begun. Taking it as well
            // would name it in two places, and each move would unmark its own.
            const take = (node: DirNode): Entry => {
                const now = entryIn(node, srcName);
                if (!now || !sameEntry(entry, now) || markedMeanwhile(entry, now)) throw changedMeanwhile(src);
                return now;
            };
            const free = (node: DirNode, record: OpenDir) => {
                if (entryIn(node, dstName)) throw new VfsConflictError(`${dst} already exists`);
                assertNotHidden(record, dstName, dst);
            };

            if (dstParent.id === srcParent.id) {
                // One record, so one write: the move happens entirely or not at all.
                await edit(dirname(src), (node, record) => {
                    const moved = take(node);
                    free(node, record);
                    delete node.entries[srcName];
                    node.entries[dstName] = { ...moved, mtime: Date.now() };
                });
                return;
            }

            // Two records, attached before detaching: interrupted, the entry is
            // in both rather than in neither. Both copies are marked for as long
            // as that can be so, because they share everything below them, and a
            // delete of either would otherwise let go of the other's contents.
            // An entry already marked is half of an earlier interrupted move, and
            // keeps its mark.
            const marked = entry.moving === true;
            let moved = entry;
            if (!marked) {
                await edit(dirname(src), (node) => {
                    moved = take(node);
                    node.entries[srcName] = { ...moved, moving: true };
                });
            }
            // Whether the edit below has put the entry at the destination: set
            // as its last step, after every check, each time it runs.
            let attached = false;
            try {
                await edit(dirname(dst), (node, record) => {
                    attached = false;
                    free(node, record);
                    node.entries[dstName] = { ...moved, moving: true, mtime: Date.now() };
                    attached = true;
                });
            } catch (err) {
                // Refused before it put anything at the destination - another
                // write took the name first - so the entry is still in one
                // place only, and the mark this move put on it would stay for
                // good: on a file, every version that falls off its history
                // kept; on either, every delete of it reading the whole tree.
                // Not when the write failed instead: the destination may hold
                // the entry by now, and the mark is what keeps a delete of
                // either copy from letting go of the other's. Best-effort.
                if (!marked && !attached) {
                    await edit(dirname(src), (node) => {
                        const now = entryIn(node, srcName);
                        if (now?.id !== entry.id || now.moving !== true) return false;
                        node.entries[srcName] = unmarked(now);
                        return true;
                    }).catch(() => {});
                }
                throw err;
            }
            // A file's history is sealed with its directory's key, and from here
            // on the directory that opens it is this one.
            if (entry.kind === "file") await this.rekeyHistory(entry.id, [srcParent.key], dstParent.key);
            await edit(dirname(src), (node) => {
                // Gone already leaves nothing to detach, and nothing to write.
                // Replaced, it is not this entry to take away: the move stops
                // here, in both places. Not `take`: the entry is marked by now,
                // by this move or the earlier one it finishes.
                const now = entryIn(node, srcName);
                if (!now) return false;
                if (!sameEntry(entry, now)) throw changedMeanwhile(src);
                delete node.entries[srcName];
                // Explicit, as in `createDir` and `settle`: noImplicitReturns.
                return true;
            });
            unmarkLanded = !marked;
        } finally {
            // Named in one place from here, the destination. A delete of it
            // there goes ahead as for an entry an interrupted move left marked
            // - which the Trash's "delete forever" relies on while the mark is
            // still being cleared.
            this.inMotion.delete(entry.id);
        }
        if (unmarkLanded) {
            await edit(dirname(dst), (node) => {
                const landed = entryIn(node, dstName);
                if (landed?.id === entry.id) node.entries[dstName] = unmarked(landed);
            });
        }
    }
```

- [ ] **Step 10: Run the new tests to verify they pass**

Run: `cd /Users/matt/GitHub/muhkoo/connect && npx vitest --run tests/vfs/write-order.test.ts`

Expected: every test in the file passes, the Task 13/15/17/19 tests included. Run it 5 times in a row. It must pass every time.

- [ ] **Step 11: Regression suites, types and lint**

Run: `cd /Users/matt/GitHub/muhkoo/connect && npx vitest --run tests/vfs tests/vcs tests/offline && yarn typecheck && npx eslint src/vfs/VfsNamespace.ts`

Expected: all test files pass, `tsc` exits 0, and eslint prints nothing.

- [ ] **Step 12: Mutation check.**
  - Before mutating anything, copy `src/vfs/VfsNamespace.ts` to the scratchpad.
  - Apply each mutation below alone, run `npx vitest --run tests/vfs/write-order.test.ts -t "a move in progress"`, and confirm that at least the named tests fail. Others may fail too.
  - Restore the file from the scratchpad copy after each mutation, and confirm with `cmp`. Do not use `git stash` or `git checkout`.

| Mutation | Tests that must fail (at least) |
|---|---|
| Drop the `inMotion` check at the top of `delete` | "refuses to delete a folder while a move of it…", "refuses to delete a file while a move of it…" |
| Drop the post-`subtree` `inMotion` loop | "refuses to delete a folder while something in it is being moved…" |
| Drop the `inMotion` check in `rename` | "refuses a second move of a file that starts…" |
| Drop `currentSubtree`'s "still named" loop | "refuses to delete a folder that something in it was moved out of…" |
| Drop `currentSubtree`'s "marked since" loop | "refuses to delete a folder when something in it was marked…" |
| `purge(doomed, …)` instead of `purge(purging, …)` | "lets go only of what a folder holds…" |
| Drop the loser unmark in rename's step-2 `catch` | "leaves a file it could not move unmarked…" |
| Step 3 without `if (!now) return false;` | "writes nothing to the folder a move leaves…" |

- [ ] **Step 13: Update the CHANGELOG.** `## Unreleased` is empty (Task 0). The text this fix supersedes is in the released `## 0.15.0-alpha.3` section: the sentence "Some moves and deletes that overlap a move are not refused yet; the next entry lists them." and the bullet "Two moves of one file started together can no longer both succeed…", which lists those cases. Leave both exactly as they are. Directly under `## Unreleased`, after one blank line, add:

```markdown
### Fixed

- **A move of a file or folder can no longer end up purged, or named in two places, when a delete or a second move
  of it overlaps, within one `Client`.** 0.15.0-alpha.3 listed these as not refused yet. `client.vfs` now refuses
  all of them with `VfsConflictError`:
  - a second move of something that is still being moved;
  - a delete of it while it is being moved;
  - a recursive delete of a folder while anything inside it is being moved, or has been moved or marked for a move
    since the delete read it.

  Before this, two moves could both succeed and leave one file named in two places, with one content reference
  between them, so deleting either copy freed the other's content. A delete could also purge a folder from the
  place a move had just put it. A move that loses its destination to another write no longer leaves the file marked
  as half of a move. Across two tabs these are not refused yet: see the entry on tabs above.
```

Keep one blank line between the end of this block and `## 0.15.0-alpha.3`. The last sentence points at the entry Task 6 adds above it. Until Task 6, it points at nothing, which is fine for an unreleased section. Task 7 replaces that sentence.

- [ ] **Step 14: Checkpoint for Matt (no commit)**

Run: `sh <scratchpad>/w1-baseline/changed.sh`

Expected: exactly `CHANGELOG.md`, `src/vfs/VfsNamespace.ts` and `tests/vfs/write-order.test.ts`, then `released CHANGELOG sections: unchanged`. Report the RED, GREEN and mutation results. Do not stage, commit or stash.

---

### Task 2: Coalescing queued writes of one record

While a record's write is in flight, every further edit of it joins **one** follow-up write. That write carries all of them and settles for all of them at once (spec §2).

**Files:**
- Modify: `src/vfs/VfsNamespace.ts`:
  - new `Edit` and `Batch` types after `OpenDir`;
  - a `waiting` field after `inMotion`;
  - `mutate` (`:1774-1833`);
  - new `touch`, `queue`, `send` and `close` methods after `adopt`.
- Modify: `tests/vfs/write-order.test.ts` (a new `describe`).
- Modify: `CHANGELOG.md`: a new `### Changed` under `## Unreleased`, above Task 1's `### Fixed`.

**Interfaces:**
- Consumes `writing`, `copyOf`, `editable`, `reopen`, `adopt` and `writeRecord`, all unchanged.
- Produces, used by Task 3:
  - `type Edit = (node: DirNode, record: OpenDir) => boolean | void`;
  - `interface Batch { copy: OpenDir; write: Promise<void> }`;
  - `private readonly waiting: Map<string, Batch>`;
  - `private touch(copy: OpenDir): void`;
  - `private queue(copy: OpenDir): Batch`. Task 3 changes it to `queue(copy: OpenDir, ticket: Ticket)`;
  - `private send(batch: Batch): Promise<void>`;
  - `private close(batch: Batch): void`.

- [ ] **Step 1: Write the failing tests.** Append to `tests/vfs/write-order.test.ts`:

```ts
describe("VFS — edits that wait for a write of their record", () => {
    it("sends twenty files saved into one folder at once in two writes of it", async () => {
        // While a write of a folder is in flight, every edit made to it waits
        // for the next one - and each used to queue a write of its own: twenty
        // files, twenty full-record writes, each billed.
        const made = makeVfs();
        const { vfs, store } = made;
        await vfs.mkdir("/d");
        const key = await recordKey(vfs, "/d");
        const files = Array.from({ length: 20 }, (_, i) => `f${String(i).padStart(2, "0")}.txt`);
        const put = store.put.bind(store);
        let writes = 0;
        store.put = async (k: string, value: unknown) => {
            if (k === key) writes++;
            return put(k, value);
        };
        const first = holdWrite(made, key, 1);

        const saving = files.map((name) => vfs.writeFile(`/d/${name}`, name));
        await first.holding;
        await listed(vfs, "/d", files);          // every edit made; the first write still held
        first.release();
        const stats = await Promise.all(saving);

        expect(stats.map((stat) => stat.name)).toEqual(files);
        expect(writes).toBe(2);
        const stored = fresh(made);
        expect(await names(stored, "/d")).toEqual(files);
        for (const name of files) expect(await stored.readText(`/d/${name}`)).toBe(name);
    });

    it("fails every save that rode on a combined write that failed, with the one error, and a retry of them works", async () => {
        const made = makeVfs();
        const { vfs } = made;
        await vfs.mkdir("/d");
        const key = await recordKey(vfs, "/d");
        const first = holdWrite(made, key, 1);
        const combined = holdWrite(made, key, 2);

        const one = vfs.writeFile("/d/one.txt", "1");
        await first.holding;
        const rest = ["a.txt", "b.txt", "c.txt"].map((name) => outcome(vfs.writeFile(`/d/${name}`, name)));
        await listed(vfs, "/d", ["a.txt", "b.txt", "c.txt", "one.txt"]);
        first.release();
        await one;
        await combined.holding;
        combined.fail();
        const errors = await Promise.all(rest);

        expect(errors[0]).toBeInstanceOf(Error);
        expect((errors[0] as Error).message).toBe("network");
        expect(errors.every((err) => err === errors[0])).toBe(true);   // one write, one error
        expect(await names(fresh(made), "/d")).toEqual(["one.txt"]);
        expect(await names(vfs, "/d")).toEqual(["one.txt"]);
        await Promise.all(["a.txt", "b.txt", "c.txt"].map((name) => vfs.writeFile(`/d/${name}`, name)));
        expect(await names(fresh(made), "/d")).toEqual(["a.txt", "b.txt", "c.txt", "one.txt"]);
    });

    it("puts an edit made after a write was sent into the next write, not that one", async () => {
        const made = makeVfs();
        const { vfs } = made;
        await vfs.mkdir("/d");
        const key = await recordKey(vfs, "/d");
        const first = holdWrite(made, key, 1);
        const second = holdWrite(made, key, 2);

        const one = vfs.writeFile("/d/one.txt", "1");
        await first.holding;
        const two = vfs.writeFile("/d/two.txt", "2");
        await listed(vfs, "/d", ["one.txt", "two.txt"]);
        first.release();
        await second.holding;                    // the write carrying two.txt is on its way
        const three = vfs.writeFile("/d/three.txt", "3");
        await listed(vfs, "/d", ["one.txt", "three.txt", "two.txt"]);
        second.release();
        await Promise.all([one, two, three]);

        expect(await names(fresh(made), "/d")).toEqual(["one.txt", "three.txt", "two.txt"]);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/matt/GitHub/muhkoo/connect && npx vitest --run tests/vfs/write-order.test.ts -t "edits that wait for a write"`

Expected:
- the first test FAILS with `expected 20 to be 2`;
- the second FAILS on `errors.every(...)`, because only the first save rejects and the next write carries the rest;
- the third PASSES. It is a guard: it fails only if the coalescing joins a write that has already been sealed.

- [ ] **Step 3: Add the types.** In `src/vfs/VfsNamespace.ts`, directly after the `OpenDir` interface, add:

```ts
/** An edit of one directory record. See `VfsNamespace.mutate`. */
type Edit = (node: DirNode, record: OpenDir) => boolean | void;

/** The edits of one record that go out in one write. See `VfsNamespace.queue`. */
interface Batch {
    /** The record they were made to: its one copy. */
    copy: OpenDir;
    /** Settles once the write has landed or failed - for every edit it carries. */
    write: Promise<void>;
}
```

- [ ] **Step 4: Add the `waiting` field.** Directly after the `inMotion` field, add:

```ts
    /**
     * The write of each record that has not gone out yet, by id: the one
     * the next edit of that record joins. See `queue`.
     */
    private readonly waiting = new Map<string, Batch>();
```

- [ ] **Step 5: Replace `mutate`, and add the helpers.** Replace the `mutate` method and its doc comment with the following. That covers everything from the line `    /**` that opens the doc comment, which is the line directly above `     * Apply an edit to a directory record and persist it.`, to the closing brace after `this.adopt(target);`. The replacement starts with its own `    /**`, so the old opener must go too:

```ts
    /**
     * Apply an edit to a directory record and persist it.
     *
     * `dir` says which record - its id, key and path - and nothing more. The
     * edit is made to THE copy of that record (see `editable`), which `dir`
     * may no longer be, and that copy is what is written. Editing whichever
     * copy the caller held let two copies of one record exist at once: an
     * overwrite held its directory across storing the old version's
     * history, a write of the directory failed meanwhile and dropped it from
     * the cache, and a save that then read a second copy and stored it,
     * successfully, was undone when the overwrite stored the first.
     *
     * So `edit` must take what it writes from the record it is given, not
     * from anything read off `dir` before an await - and re-check whatever it
     * relies on from then, throwing if another write changed it, before it
     * changes anything. Returning false writes nothing after all.
     *
     * The write that carries the edit may carry others, made while an
     * earlier write of the record was in flight (see `queue`): it lands, or
     * fails, for all of them at once.
     */
    private async mutate(dir: OpenDir, edit: Edit): Promise<void> {
        // At once when the copy is to hand, which it almost always is, so
        // that what the caller checked just before is still true when the
        // edit is made.
        const target = this.editable(dir) ?? await this.reopen(dir);
        if (edit(target.node, target) === false) return;
        this.touch(target);
        const { write } = this.queue(target);
        try {
            await write;
        } catch (err) {
            // The edit above was made in place, on the very object the cache
            // holds. Left there after a failed write, the cache would show a
            // change the store never took - a deleted file gone from every
            // listing while it is still stored, and a retry told it does not
            // exist. Drop it, so the next read asks the store.
            //
            // Unless a later write of this record is already queued. It
            // seals the record as it stands when it is sent, this edit
            // included, so the cache shows what is about to be stored, and
            // dropping it would only send readers to the store for an older
            // copy. If that write fails too, it drops the cache itself.
            //
            // Nor from a cache cleared since: that is the next identity's.
            if (this.writing.get(target.id) === write && target.gen === this.generation) this.cache.delete(target.id);
            throw err;
        } finally {
            if (this.writing.get(target.id) === write) this.writing.delete(target.id);
        }
        this.adopt(target);
    }
```

Then, directly after the `adopt` method, add:

```ts
    /** After an edit of `copy`: its time, and any entry it cannot read that the edit replaced. */
    private touch(copy: OpenDir): void {
        copy.node.mtime = Date.now();
        // A write to a hidden entry's exact name replaces it: that name now
        // means what this version wrote. Forgetting the old one here is also
        // what stops a later delete of the replacement from resurrecting it.
        for (const name of Object.keys(copy.hidden)) {
            if (Object.hasOwn(copy.node.entries, name)) delete copy.hidden[name];
        }
    }

    /**
     * The write that will carry the edit just made to `copy`.
     *
     * Writes of a record go out one at a time, each once the one before it
     * has landed or failed (see `writing`), and each seals the record as it
     * stands when it goes out. So a write still waiting carries every edit
     * made while it waits, and an edit made then joins it instead of
     * queueing a write of its own: a burst of edits of one directory while a
     * write of it is in flight costs two writes, not one per edit. Each is a
     * billed write; a 20-file upload into one folder cost twenty.
     */
    private queue(copy: OpenDir): Batch {
        const open = this.waiting.get(copy.id);
        if (open?.copy === copy) return open;
        const before = this.writing.get(copy.id);
        const batch = { copy } as Omit<Batch, "write"> as Batch;
        this.waiting.set(copy.id, batch);
        // Not sent until any earlier write of this record has landed: see
        // `writing`. Whether that one worked or not, this one still goes.
        const send = () => this.send(batch);
        batch.write = before ? before.then(send, send) : send();
        this.copyOf.set(batch.write, copy);
        this.writing.set(copy.id, batch.write);
        return batch;
    }

    /** Send `batch`: from here on, an edit of its record goes in the next write. */
    private send(batch: Batch): Promise<void> {
        this.close(batch);
        return this.writeRecord(batch.copy);
    }

    /** Stop `batch` taking more edits, as it is sealed. */
    private close(batch: Batch): void {
        if (this.waiting.get(batch.copy.id) === batch) this.waiting.delete(batch.copy.id);
    }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd /Users/matt/GitHub/muhkoo/connect && npx vitest --run tests/vfs/write-order.test.ts` (5 times in a row)

Expected: all pass, including Task 1's block and Task 13/15/17/19's.

- [ ] **Step 7: Regression suites, types and lint**

Run: `cd /Users/matt/GitHub/muhkoo/connect && npx vitest --run tests/vfs tests/vcs tests/offline && yarn typecheck && npx eslint src/vfs/VfsNamespace.ts`

Expected: all pass, and both checkers are clean.

- [ ] **Step 8: Mutation check.** Use the same copy, `cmp` and restore routine as in Task 1, and run `npx vitest --run tests/vfs/write-order.test.ts -t "edits that wait for a write"`. At least the named tests must fail. Do not run the whole file for these: with `send` not closing its batch, 30 of its tests fail, most of them only after a 30-second timeout, and the run takes about ten minutes.

| Mutation | Tests that must fail (at least) |
|---|---|
| `queue` never joins (`const open = undefined as Batch \| undefined`) | "sends twenty files … in two writes of it" (2 of the 3 fail) |
| `send` without `this.close(batch)` | "puts an edit made after a write was sent into the next write" (all 3 fail, two only after their 30-second timeouts, so this run takes about a minute) |

- [ ] **Step 9: Update the CHANGELOG.** `## Unreleased` has only Task 1's `### Fixed` so far. Between `## Unreleased` and `### Fixed`, with a blank line on each side, add:

```markdown
### Changed

- **A burst of saves into one folder costs at most two writes of its directory record, not one per save.** While a
  write of a folder is in flight, `client.vfs` now sends every further edit of that folder together, in one follow-up
  write that carries them all. Each save still resolves when the write carrying it lands. If that write fails, every
  save that rode on it fails with the same error. Before this, uploading 20 files into one folder sent 20 writes of
  the folder; each one is a billed `kv_write`, and on the Free tier they count toward its 1,000 writes a month.
```

"At most two" holds in a browser too: there, a write waits for the folder's lock before it is sealed, so a burst often goes out as one write (Task 3, Step 14).

- [ ] **Step 10: Checkpoint for Matt (no commit)**

Run: `sh <scratchpad>/w1-baseline/changed.sh`

Expected: the same three files as after Task 1, then `released CHANGELOG sections: unchanged`. Report RED, GREEN and the mutation results. Do not stage, commit or stash.

---

### Task 3: Device-wide coordination of directory writes

`VfsNamespace` gains an optional coordinator. With a coordinator, each batch is sent holding the record's device-wide lock. Under the lock, the record is read again and the batch's edits are replayed onto it only if another tab announced a write of it, or the coordinator may have missed one. After writing, the namespace announces before it lets go of the lock. A directory named by a `createDir` whose write has not landed is not followed until it has (Decision 1). Without a coordinator, writes go out as before, but `mkdir` still waits for a name not yet written.

**Files:**
- Create: `src/vfs/coordinator.ts`.
- Modify: `src/vfs/VfsNamespace.ts` in these places:
  - the module doc (`:9-27`);
  - the imports;
  - `VfsNamespaceDeps`;
  - `OpenDir`, `Batch`, and a new `Ticket` type;
  - the fields: `hearing`, `missedAt`, `heardAt`;
  - the constructor, `clearCache`, `openDirById` and `readRecord`;
  - `mutate`, `queue` and `send`;
  - new methods `sendLocked`, `replay`, `heard`, `current` and `fetchRecord`;
  - a `naming` field, `mkdir` and `createDir`;
  - `cloneEntry`'s `OpenDir`;
  - `sweep`'s doc.
- Create: `tests/vfs/cross-tab.test.ts`.
- Create, in the scratchpad only: `one-tab.ts` and `vitest.one-tab.config.mts` (Step 14).

**Interfaces:**
- Consumes everything from Tasks 1 and 2, and `nextTurn` from `./bounds`, which is already imported.
- Changes Task 2's `queue(copy: OpenDir): Batch` to `queue(copy: OpenDir, ticket: Ticket): Batch`, and `Batch` gains `edits` and `refused`.
- Adds `private readonly naming: Map<string, Promise<void>>`, which `mkdir` and `createDir` use.
- Produces, used by Tasks 6 and 7, the interface in `src/vfs/coordinator.ts`. Task 7 adds a fifth member, `holdMoving(id: string, shared?: boolean): Promise<(() => void) | null>`:
  ```ts
  export interface VfsCoordinator {
      lock<T>(id: string, fn: () => Promise<T>): Promise<T>;
      announce(id: string): void;
      onAnnounce(handler: (id: string | null) => void): () => void;
      listen(): void;
  }
  ```
  It also adds the dependency field `VfsNamespaceDeps.coordinator?: VfsCoordinator`.

- [x] **Step 0: Gate — satisfied: signed off by Matt, 2026-10-03.** This step is kept as the record of what he confirmed. It does not block: go on to Step 1. He signed off:
  - edit at once and replay under the lock (Decision 1), instead of the spec's edit under the lock, including the rule that `mkdir` waits for a name not yet written;
  - a bound on the lock WAIT (Decision 2), instead of the spec's send timeout. That leaves a hung PUT holding its folder's lock, and Task 13's in-tab "a hung put holds later writes" as it is;
  - the known gaps in Decision 9, which ship as listed in the CHANGELOG: the hung PUT, a skipping tab's early `SYNC_COMPLETE`, and history records that stay last-writer-wins.

  He also scheduled the per-entry move lock into W1. That is Task 7, which takes the cross-tab move races off Decision 9's list. Waiting for the drain lock (Decision 7) stays out of W1.

- [ ] **Step 1: Write the failing tests.** Create `tests/vfs/cross-tab.test.ts`:

```ts
/**
 * Two tabs of one app on one device: two namespaces over one store, ordered
 * by a coordinator that behaves as Web Locks and a BroadcastChannel do.
 */
import { describe, it, expect, vi } from "vitest";
import { makeContent, makeStore } from "./harness";
import { VfsNamespace } from "../../src/vfs/VfsNamespace";
import type { VfsCoordinator } from "../../src/vfs/coordinator";
import { dirKey, VfsConflictError } from "../../src/vfs/types";

const SEED = new Uint8Array(32).fill(7);
type Store = ReturnType<typeof makeStore>;
type Content = ReturnType<typeof makeContent>;

interface TabState {
    handlers: Set<(id: string | null) => void>;
    listening: boolean;
    inbox: string[] | null;
}

/**
 * The locks and channel the tabs of one browser share. A lock is granted in
 * the order asked for; an announcement reaches every other tab at once -
 * unless that tab is not listening (its channel not open yet) or its
 * messages are delayed (still on their way).
 */
function device() {
    const tails = new Map<string, Promise<void>>();
    const tabs = new Set<TabState>();
    return {
        tab() {
            const me: TabState = { handlers: new Set(), listening: true, inbox: null };
            tabs.add(me);
            const hear = (id: string | null) => {
                for (const handler of me.handlers) handler(id);
            };
            const coordinator: VfsCoordinator = {
                async lock<T>(id: string, fn: () => Promise<T>): Promise<T> {
                    coordinator.listen();
                    const before = tails.get(id) ?? Promise.resolve();
                    let release!: () => void;
                    const mine = new Promise<void>((resolve) => (release = resolve));
                    const tail = before.then(() => mine);
                    tails.set(id, tail);
                    await before;
                    try {
                        return await fn();
                    } finally {
                        release();
                        if (tails.get(id) === tail) tails.delete(id);
                    }
                },
                announce(id) {
                    for (const tab of tabs) {
                        if (tab === me || !tab.listening) continue;
                        if (tab.inbox) tab.inbox.push(id);
                        else for (const handler of tab.handlers) handler(id);
                    }
                },
                onAnnounce(handler) {
                    me.handlers.add(handler);
                    return () => void me.handlers.delete(handler);
                },
                listen() {
                    if (me.listening) return;
                    me.listening = true;
                    hear(null);
                },
            };
            return {
                coordinator,
                /** Stop hearing the other tabs, as before a channel is open. */
                deafen: () => void (me.listening = false),
                /** Hold what the other tabs announce until `deliver`. */
                delay: () => void (me.inbox = []),
                deliver: () => {
                    const inbox = me.inbox ?? [];
                    me.inbox = null;
                    for (const id of inbox) hear(id);
                },
            };
        },
    };
}

function twoTabs() {
    const dev = device();
    const store = makeStore();
    const content = makeContent();
    const A = dev.tab();
    const B = dev.tab();
    const open = (tab: { coordinator: VfsCoordinator }) =>
        new VfsNamespace({ store, content, seed: () => SEED, coordinator: tab.coordinator });
    return { dev, store, content, A, B, a: open(A), b: open(B) };
}

/** What the store holds, read by a namespace that has cached nothing. */
function stored(store: Store, content: Content): VfsNamespace {
    return new VfsNamespace({ store, content, seed: () => SEED });
}

async function names(vfs: VfsNamespace, path: string): Promise<string[]> {
    return (await vfs.list(path)).map((stat) => stat.name);
}

async function recordKey(vfs: VfsNamespace, path: string): Promise<string> {
    return dirKey(((await (vfs as any).openDir(path)) as { id: string }).id);
}

/** Hold back the `nth` write of `key`, as a slow request is held up. */
function holdPut(store: Store, key: string, nth: number) {
    const put = store.put.bind(store);
    let seen = 0;
    let reached!: () => void;
    let go!: () => void;
    const holding = new Promise<void>((resolve) => (reached = resolve));
    const released = new Promise<void>((resolve) => (go = resolve));
    store.put = async (k: string, value: unknown) => {
        if (k === key && ++seen === nth) {
            reached();
            await released;
        }
        return put(k, value);
    };
    return { holding, release: () => go() };
}

/** Fail the next read of `key`, as a dropped connection does. */
function failNextGet(store: Store, key: string): void {
    const get = store.get.bind(store);
    let failed = false;
    store.get = async (k: string) => {
        if (k === key && !failed) {
            failed = true;
            throw new Error("network");
        }
        return get(k);
    };
}

describe("VFS — two tabs of one device", () => {
    it("keeps both files when two tabs save into one folder at once", async () => {
        // Each tab held its own copy of /d, added its file, and wrote the
        // whole record: the store kept whichever arrived last.
        const { store, content, a, b } = twoTabs();
        await a.mkdir("/d");
        await b.list("/d");

        await Promise.all([a.writeFile("/d/a.txt", "a"), b.writeFile("/d/b.txt", "b")]);

        expect(await names(stored(store, content), "/d")).toEqual(["a.txt", "b.txt"]);
        expect(await names(a, "/d")).toEqual(["a.txt", "b.txt"]);
        expect(await names(b, "/d")).toEqual(["a.txt", "b.txt"]);
    });

    it("keeps every file when two tabs each save three files into one folder at once", async () => {
        const { store, content, a, b } = twoTabs();
        await a.mkdir("/d");
        await b.list("/d");
        const mine = (tab: VfsNamespace, prefix: string) =>
            [1, 2, 3].map((n) => tab.writeFile(`/d/${prefix}${n}.txt`, `${prefix}${n}`));

        await Promise.all([...mine(a, "a"), ...mine(b, "b")]);

        const s = stored(store, content);
        expect(await names(s, "/d")).toEqual(["a1.txt", "a2.txt", "a3.txt", "b1.txt", "b2.txt", "b3.txt"]);
        expect(await s.readText("/d/b2.txt")).toBe("b2");
    });

    it("lists what another tab has written to a folder once it has heard of the write", async () => {
        const { a, b } = twoTabs();
        await a.mkdir("/d");
        expect(await names(b, "/d")).toEqual([]);

        await a.writeFile("/d/a.txt", "a");

        expect(await names(b, "/d")).toEqual(["a.txt"]);
    });

    it("re-reads a folder another tab wrote once, when it next writes it", async () => {
        const { store, content, a, b } = twoTabs();
        await a.writeFile("/d/one.txt", "1");
        await b.list("/d");
        const key = await recordKey(a, "/d");
        await a.writeFile("/d/two.txt", "2");
        const gets = store.gets.length;

        await b.writeFile("/d/three.txt", "3");

        expect(store.gets.slice(gets).filter((k) => k === key)).toHaveLength(1);
        expect(await names(stored(store, content), "/d")).toEqual(["one.txt", "three.txt", "two.txt"]);
    });

    it("costs one tab on its own no reads it would not make without the others", async () => {
        const reads = async (coordinator?: VfsCoordinator): Promise<number> => {
            const store = makeStore();
            const vfs = new VfsNamespace({ store, content: makeContent(), seed: () => SEED, coordinator });
            await vfs.writeFile("/d/one.txt", "1");
            await vfs.mkdir("/e");
            const before = store.gets.length;
            await Promise.all(["2", "3", "4"].map((n) => vfs.writeFile(`/d/${n}.txt`, n)));
            await vfs.rename("/d/2.txt", "/e/2.txt");
            await vfs.writeFile("/d/3.txt", "three");
            await vfs.delete("/d/4.txt");
            return store.gets.length - before;
        };
        expect(await reads(device().tab().coordinator)).toBe(await reads());
    });

    it("refuses a save of a name another tab saved first, rather than overwriting it", async () => {
        const { store, content, a, b } = twoTabs();
        await a.mkdir("/d");
        await b.list("/d");
        const held = holdPut(store, await recordKey(a, "/d"), 1);   // a holds /d's lock while its write is in flight

        const first = a.writeFile("/d/x.txt", "from a");
        await held.holding;
        const second = b.writeFile("/d/x.txt", "from b");
        await vi.waitFor(async () => expect(await names(b, "/d")).toEqual(["x.txt"]), { interval: 1 });   // b's edit made, its write waiting on the lock
        held.release();
        await first;

        await expect(second).rejects.toThrow(VfsConflictError);
        expect(await stored(store, content).readText("/d/x.txt")).toBe("from a");
        expect(await b.readText("/d/x.txt")).toBe("from a");
    });

    it("refuses only the save that no longer applies, and stores the rest of its write", async () => {
        // b's two saves went out in one write. Made again to /d as a left it,
        // x.txt no longer applied - a had saved one first - and y.txt did.
        const { store, content, a, b } = twoTabs();
        await a.mkdir("/d");
        await b.list("/d");
        const held = holdPut(store, await recordKey(a, "/d"), 1);

        const first = a.writeFile("/d/x.txt", "from a");
        await held.holding;
        const x = b.writeFile("/d/x.txt", "from b").then(() => "done", (err: unknown) => err);
        const y = b.writeFile("/d/y.txt", "y");
        await vi.waitFor(async () => expect(await names(b, "/d")).toEqual(["x.txt", "y.txt"]), { interval: 1 });   // both edits made, one write waiting on the lock
        held.release();
        await first;

        expect(await x).toBeInstanceOf(VfsConflictError);
        await y;
        const s = stored(store, content);
        expect(await names(s, "/d")).toEqual(["x.txt", "y.txt"]);
        expect(await s.readText("/d/x.txt")).toBe("from a");
        expect(await s.readText("/d/y.txt")).toBe("y");
        expect(await names(b, "/d")).toEqual(["x.txt", "y.txt"]);
    });

    it("keeps every file when two tabs each save files into a new folder of the same name at once", async () => {
        // Each tab named its own new "Photos" in /d. b's later saves found
        // b's Photos named - in b's copy of /d, its write still waiting for
        // a's - and saved into it. Under the lock, made again to /d as a
        // left it, b's mkdir found a's Photos and named nothing: the folder
        // those files went into was named nowhere, and their saves had
        // already succeeded.
        const { store, content, a, b } = twoTabs();
        await a.mkdir("/d");
        await b.list("/d");
        const held = holdPut(store, await recordKey(a, "/d"), 1);   // a's write of /d, naming its Photos
        const save = (tab: VfsNamespace, name: string) => tab.writeFile(`/d/Photos/${name}`, name);

        const saves = [save(a, "a1.txt"), save(a, "a2.txt")];
        await held.holding;
        saves.push(save(b, "b1.txt"), save(b, "b2.txt"));   // at once: b2's mkdir finds b1's Photos as it names it
        await vi.waitFor(async () => expect(await names(b, "/d")).toEqual(["Photos"]), { interval: 1 });   // b's Photos named in its copy, the write waiting on the lock
        saves.push(save(b, "b3.txt"));                       // later: its mkdir finds b's Photos already named
        for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
        held.release();
        await Promise.all(saves);

        const s = stored(store, content);
        const all = ["a1.txt", "a2.txt", "b1.txt", "b2.txt", "b3.txt"];
        expect(await names(s, "/d")).toEqual(["Photos"]);
        expect(await names(s, "/d/Photos")).toEqual(all);
        for (const name of all) expect(await s.readText(`/d/Photos/${name}`)).toBe(name);
    });

    it("keeps a file saved in one tab while another tab moves a file out of that folder", async () => {
        // The Trash: "Move to Trash" is a rename. Its first write of /d - the
        // entry marked as being moved - was made to the copy of /d this tab
        // held, which did not have the other tab's new file.
        const { store, content, a, b } = twoTabs();
        await a.writeFile("/d/old.txt", "old");
        await a.mkdir("/trash");
        await b.list("/d");
        await b.list("/trash");
        const held = holdPut(store, await recordKey(a, "/d"), 1);

        const saving = a.writeFile("/d/new.txt", "new");
        await held.holding;
        const trashing = b.rename("/d/old.txt", "/trash/old.txt");
        const dId = (await recordKey(a, "/d")).slice("vfs/d/".length);
        await vi.waitFor(() => expect((b as any).writing.has(dId)).toBe(true), { interval: 1 });   // b's mark of old.txt made to its copy of /d
        held.release();
        await Promise.all([saving, trashing]);

        const s = stored(store, content);
        expect(await names(s, "/d")).toEqual(["new.txt"]);
        expect(await names(s, "/trash")).toEqual(["old.txt"]);
        expect(await s.readText("/trash/old.txt")).toBe("old");
        expect(await s.readText("/d/new.txt")).toBe("new");
    });

    it("fails a save whose folder's lock cannot be had, shows nothing of it, and a retry works", async () => {
        const store = makeStore();
        const content = makeContent();
        const A = device().tab();
        let refuse = false;
        const coordinator: VfsCoordinator = {
            ...A.coordinator,
            lock: (id, fn) =>
                refuse ? Promise.reject(new VfsConflictError("another tab has been writing it too long")) : A.coordinator.lock(id, fn),
        };
        const vfs = new VfsNamespace({ store, content, seed: () => SEED, coordinator });
        await vfs.mkdir("/d");

        refuse = true;
        await expect(vfs.writeFile("/d/x.txt", "x")).rejects.toThrow(VfsConflictError);
        expect(await names(vfs, "/d")).toEqual([]);
        expect(await names(stored(store, content), "/d")).toEqual([]);

        refuse = false;
        await vfs.writeFile("/d/x.txt", "x");
        expect(await names(stored(store, content), "/d")).toEqual(["x.txt"]);
    });

    it("fails a save whose re-read under the lock fails, writes nothing, and a retry works", async () => {
        const { store, content, a, b } = twoTabs();
        await a.mkdir("/d");
        await b.list("/d");
        const key = await recordKey(a, "/d");
        const held = holdPut(store, key, 1);

        const first = a.writeFile("/d/a.txt", "a");
        await held.holding;
        const second = b.writeFile("/d/b.txt", "b");
        await vi.waitFor(async () => expect(await names(b, "/d")).toEqual(["b.txt"]), { interval: 1 });
        failNextGet(store, key);                 // the read b makes under the lock, once a has written
        held.release();
        await first;

        await expect(second).rejects.toThrow("network");
        expect(await names(b, "/d")).toEqual(["a.txt"]);
        expect(await names(stored(store, content), "/d")).toEqual(["a.txt"]);
        await b.writeFile("/d/b.txt", "b");
        expect(await names(stored(store, content), "/d")).toEqual(["a.txt", "b.txt"]);
    });

    it("starts hearing the other tabs before it first reads a folder", async () => {
        const { a, b, B } = twoTabs();
        await a.mkdir("/d");
        B.deafen();                               // as before its channel is open

        expect(await names(b, "/d")).toEqual([]); // its first read: it hears from here on
        await a.writeFile("/d/a.txt", "a");

        expect(await names(b, "/d")).toEqual(["a.txt"]);
    });

    it("re-reads a folder before writing it when this tab may have missed another's write of it", async () => {
        const { store, content, a, b, B } = twoTabs();
        await a.mkdir("/d");
        await b.list("/d");
        B.deafen();                               // as before its channel is open
        await a.writeFile("/d/a.txt", "a");       // b does not hear of this

        await b.writeFile("/d/b.txt", "b");       // b starts hearing, told it may have missed some

        expect(await names(stored(store, content), "/d")).toEqual(["a.txt", "b.txt"]);
    });

    it("refuses to delete a folder it read before it could hear another tab move something out, then deletes it", async () => {
        const { store, content, a, b, B } = twoTabs();
        await a.writeFile("/x/d/f.txt", "f");
        await a.mkdir("/y");
        await b.walk("/");                        // b has every record cached
        B.deafen();
        await a.rename("/x/d", "/y/d");           // b does not hear of it

        const first = await b.delete("/x", { recursive: true }).then(() => "done", (err: unknown) => err);

        expect(first).toBeInstanceOf(VfsConflictError);
        expect(await stored(store, content).readText("/y/d/f.txt")).toBe("f");
        await b.delete("/x", { recursive: true });
        expect(await names(stored(store, content), "/")).toEqual(["y"]);
        expect(await stored(store, content).readText("/y/d/f.txt")).toBe("f");
    });

    it("warns when another tab's write is heard of only after this tab has written over it", async () => {
        const { store, a, b, B } = twoTabs();
        await a.mkdir("/d");
        await b.list("/d");
        const key = await recordKey(a, "/d");
        B.delay();                                // what a announces reaches b late
        await a.writeFile("/d/a.txt", "a");
        const held = holdPut(store, key, 1);      // b's write of /d, once sent
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
            const writing = b.writeFile("/d/b.txt", "b");
            await held.holding;
            B.deliver();                          // heard only now
            held.release();
            await writing;
            expect(warn.mock.calls.some(([message]) => String(message).includes("may be lost"))).toBe(true);
        } finally {
            warn.mockRestore();
        }
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/matt/GitHub/muhkoo/connect && npx vitest --run tests/vfs/cross-tab.test.ts`

Expected: 14 of the 15 tests FAIL. Only "costs one tab…" passes, because the namespace ignores `coordinator` and the last write wins:
- "keeps both files…" with `expected [ 'a.txt' ] to deeply equal [ 'a.txt', 'b.txt' ]`, or the mirror image;
- "keeps every file when two tabs each save three files…";
- "lists what another tab has written…", where `[]` is listed;
- "re-reads … once", with `expected [] to have a length of 1 but got +0`;
- "refuses a save of a name…", which resolves instead of rejecting;
- "refuses only the save that no longer applies…", with `expected 'done' to be an instance of VfsConflictError`;
- "keeps every file when two tabs each save files into a new folder…", with `expected [ 'a1.txt', 'a2.txt' ] to deeply equal [ 'a1.txt', 'a2.txt', 'b1.txt', …(2) ]`;
- "keeps a file saved in one tab…", at its `waitFor`, after about a second: `expected false to be true`. With no lock, b's mark of `/d` is never held up;
- "fails a save whose folder's lock…", which resolves;
- "fails a save whose re-read…", which resolves;
- "starts hearing the other tabs…", where `[]` is listed;
- "re-reads … may have missed…";
- "refuses to delete a folder it read…";
- "warns when…".

"costs one tab…" PASSES already. It is the guard against extra reads.

- [ ] **Step 3: Create `src/vfs/coordinator.ts`**

```ts
/**
 * How `client.vfs` orders writes of one directory record between the tabs of
 * an app on one device. Internal: nothing re-exports this module, and it is
 * not public API.
 *
 * The personal space keeps whichever write of a key arrives last, so two tabs
 * that each edit a copy of a folder and write it lose one tab's edit. A
 * coordinator gives every namespace on the device one lock per record, held
 * from the decision to write until the write has landed or failed, and tells
 * the others which record was written while still holding it. `Client` builds
 * one from Web Locks and a BroadcastChannel in a browser tab (see
 * `core/crossTab.ts`); without one, writes are ordered within one namespace
 * only, as they always were.
 */
export interface VfsCoordinator {
    /** Run `fn` holding the device-wide lock for record `id`, and settle as it does. */
    lock<T>(id: string, fn: () => Promise<T>): Promise<T>;
    /** Tell every other namespace that this one has just written record `id`. Called while holding its lock. */
    announce(id: string): void;
    /**
     * Call `handler` with the id of each record another namespace announces -
     * or with null when announcements may have been missed, because this one
     * has only just started hearing them, or now hears them for someone else,
     * so that every record held must be taken as written elsewhere. Returns a
     * function that stops it.
     */
    onAnnounce(handler: (id: string | null) => void): () => void;
    /**
     * Make sure announcements for whoever is signed in now are being heard.
     * Cheap; called before every read of a record from the store, so that
     * nothing is read before this namespace can hear of a later write of it.
     */
    listen(): void;
}
```

- [ ] **Step 4: Update the module doc, imports and deps.** In `src/vfs/VfsNamespace.ts`, replace the whole `## Consistency` part of the file's opening comment, from ` * ## Consistency` through ` * or devices - that would take a compare-and-swap at the server.`, with:

```ts
 * ## Consistency
 *
 * Every mutation is a read-modify-write of exactly ONE directory record, so a
 * write cannot leave the tree half-updated: either the parent names the new
 * child or it does not. A VFS write sends no HLC and the personal space has
 * no compare-and-swap: of two writes of one key it keeps whichever arrives
 * last.
 *
 * Within ONE namespace, writes of a record are sent one at a time, in the
 * order they were made - edits made while one is in flight go out together
 * in the next (see `queue`) - and a read that has to fetch a record waits for
 * its write in flight (see `writing`). Every edit of a record is made to one
 * in-memory copy of it, and that copy is what is written (see `mutate`).
 *
 * Between the tabs of an app on one device, a coordinator (`VfsCoordinator`;
 * `Client` wires one in a browser tab) gives each record one lock, and a tab
 * reads a record another tab has written again before its next write of it
 * (see `sendLocked`). Between devices - or a browser and the CLI - two writes
 * of the same directory are still last-writer-wins, and the other edit is
 * lost: that takes a compare-and-swap at the server. Orphaned records (a
 * directory whose parent entry lost the race) are unreachable rather than
 * corrupting - they cost storage until a sweep, the trade this shape makes in
 * exchange for single-record writes.
```

After the line `} from "./bounds";`, add:

```ts
import type { VfsCoordinator } from "./coordinator";
```

In `VfsNamespaceDeps`, after the `limits?: { entries?: number; pathChars?: number };` member, add:

```ts
    /**
     * Orders writes of a record with the other tabs of this app on the
     * device. `Client` passes one in a browser tab; without it - Node, a
     * test, a runtime with no Web Locks - writes are ordered within this
     * namespace only. See `VfsCoordinator`.
     */
    coordinator?: VfsCoordinator;
```

- [ ] **Step 5: Change `OpenDir`, `Batch` and the new `Ticket`.** In `OpenDir`, after `gen: number;`, add:

```ts
    /**
     * Where `hearing` stood when this copy was read from the store, or last
     * written to it: it holds every write of its record another tab
     * announced before then. See `VfsNamespace.current`.
     */
    seen: number;
```

Replace the `Batch` interface from Task 2 with:

```ts
/** One call's edit, as `mutate` was given it, kept so it can be made again. See `VfsNamespace.replay`. */
interface Ticket {
    edit: Edit;
}

/** The edits of one record that go out in one write. See `VfsNamespace.queue`. */
interface Batch {
    /** The record they were made to: its one copy. */
    copy: OpenDir;
    /** Every edit it carries, in the order they were made. */
    edits: Ticket[];
    /** Edits that no longer applied when made again to the record as another tab left it, with what each threw. */
    refused: Map<Ticket, unknown>;
    /** Settles once the write has landed or failed - for every edit it carries. */
    write: Promise<void>;
}
```

- [ ] **Step 6: Add the fields, and update the constructor and `clearCache`.** After the `waiting` field, add:

```ts
    /**
     * Announcements heard from other tabs, counted. `heardAt` is the count
     * at the last one for each record, `missedAt` the count when some may
     * have been missed. A copy read after both holds every write announced:
     * see `current`.
     */
    private hearing = 0;
    private missedAt = 0;
    private readonly heardAt = new Map<string, number>();
```

At the end of the constructor body, after `this.maxPathChars = …;`, add:

```ts
        // Another tab's write of a record leaves this tab's copy of it out of date: see `heard`.
        deps.coordinator?.onAnnounce((id) => this.heard(id));
```

In `clearCache`, after `this.cache.clear();`, add:

```ts
        this.heardAt.clear();
```

- [ ] **Step 7: Make `openDirById` listen first, and move the fetch into `fetchRecord`.** In `openDirById`, replace:

```ts
        const hit = this.cache.get(id);
        if (hit) return hit;
```

with:

```ts
        const hit = this.cache.get(id);
        if (hit) return hit;
        // Before anything is read, so that from here on this namespace hears
        // of any later write of the record by another tab. Starting to hear -
        // for the first time, or for someone else - clears the cache (see
        // `heard`), which is why it comes before this read is cached.
        this.deps.coordinator?.listen();
```

Inside its `load` function, replace everything from `            const raw = await this.deps.store.get(dirKey(id));` through `            return this.readRecord(id, key, value, gen, path);` with:

```ts
            return this.fetchRecord(id, key, gen, path);
```

Then add this method directly after `openDirById`. The comments are the ones moved out of `load`:

```ts
    /**
     * Fetch record `id` from the store and open it. Whatever another tab
     * announced before the fetch began is in what it returns: see `current`.
     */
    private async fetchRecord(id: string, key: Uint8Array, gen: number, path?: string): Promise<OpenDir> {
        const seen = this.hearing;
        const raw = await this.deps.store.get(dirKey(id));
        // An absent record is an EMPTY directory, not an error: the root
        // exists before anything has been written to it, and a directory is
        // created by its parent naming it rather than by its own record
        // appearing.
        if (raw === null || raw === undefined) {
            const node: DirNode = { v: 1, entries: emptyEntries(), mtime: Date.now() };
            return { id, key, path, node, hidden: Object.create(null), gen, seen } satisfies OpenDir;
        }
        // Present but unopenable is NOT absent. `unseal` folds the two
        // together, which suits a record that can simply be rebuilt; a
        // directory cannot, because rebuilding it means sealing an empty
        // one over whatever is really there. And it is not a raw
        // DOMException either: the typed error is what delete, purge and
        // sweep know how to step around, and it names the record.
        let value: unknown;
        try {
            value = await openSealed(key, raw);
        } catch (err) {
            if (err instanceof SealedRecordError) throw new VfsCorruptRecordError(id, path, err.message);
            throw err;
        }
        return this.readRecord(id, key, value, gen, seen, path);
    }
```

In `readRecord`, change the signature to `private readRecord(id: string, key: Uint8Array, value: unknown, gen: number, seen: number, path?: string): OpenDir {`, and its last line to:

```ts
        return { id, key, path, node: { ...(top as Omit<DirNode, "entries">), entries }, hidden, gen, seen };
```

In `cloneEntry`, change the `OpenDir` literal to:

```ts
        const open: OpenDir = { id: clone.id, key: fromBase64(clone.key), node, hidden: Object.create(null), gen: run.gen, seen: this.hearing };
```

- [ ] **Step 8: Replace `mutate`, `queue` and `send` (Task 2's versions)**

In `mutate`, replace:

```ts
        if (edit(target.node, target) === false) return;
        this.touch(target);
        const { write } = this.queue(target);
```

with:

```ts
        if (edit(target.node, target) === false) return;
        this.touch(target);
        const ticket: Ticket = { edit };
        const batch = this.queue(target, ticket);
        const { write } = batch;
```

and replace the method's last line, `        this.adopt(target);`, with:

```ts
        this.adopt(target);
        // Made again to the record as another tab left it, it no longer
        // applied - see `replay` - and nothing of it was written.
        if (batch.refused.has(ticket)) throw batch.refused.get(ticket);
```

Also add this paragraph to the end of `mutate`'s doc comment:

```ts
     *
     * With a coordinator, the edit may be made a second time, to the record
     * as another tab left it, and refused then (see `replay`): an edit must
     * do nothing but check `node` and `record` and change them, and must
     * check everything before it changes anything.
```

Replace `queue` and `send` with:

```ts
    private queue(copy: OpenDir, ticket: Ticket): Batch {
        const open = this.waiting.get(copy.id);
        if (open?.copy === copy) {
            open.edits.push(ticket);
            return open;
        }
        const before = this.writing.get(copy.id);
        const batch = { copy, edits: [ticket], refused: new Map() } as Omit<Batch, "write"> as Batch;
        this.waiting.set(copy.id, batch);
        // Not sent until any earlier write of this record has landed: see
        // `writing`. Whether that one worked or not, this one still goes.
        const send = () => this.send(batch);
        batch.write = before ? before.then(send, send) : send();
        this.copyOf.set(batch.write, copy);
        this.writing.set(copy.id, batch.write);
        return batch;
    }

    /**
     * Send `batch`: from here on, an edit of its record goes in the next
     * write. With a coordinator, holding the lock every tab of the device
     * takes to write this record - see `sendLocked`.
     */
    private send(batch: Batch): Promise<void> {
        const coordinator = this.deps.coordinator;
        if (!coordinator) {
            this.close(batch);
            return this.writeRecord(batch.copy);
        }
        // Closed under the lock once it is sealed (see `sendLocked`), and
        // here too, for a lock never granted or a re-read that failed: left
        // open, a later edit of the same copy would join a write that has
        // already failed, and fail with it.
        return coordinator.lock(batch.copy.id, () => this.sendLocked(batch, coordinator)).finally(() => this.close(batch));
    }
```

(Keep `queue`'s doc comment from Task 2 above it.)

- [ ] **Step 9: Add `sendLocked`, `replay`, `heard` and `current`.** Directly after `close`, add:

```ts
    /**
     * Send `batch` while no other tab can write its record.
     *
     * If another tab wrote the record since this copy was read, the copy is
     * out of date, and writing it would undo that tab's write. So it is read
     * again, here, under the lock, and every edit the batch carries is made
     * again to what was read (see `replay`). A copy no other tab has written
     * over is sent as it is: one tab on its own costs no extra request.
     *
     * The other tabs are told before the lock is let go, so that whichever
     * takes it next has heard. A write that failed may have landed even so,
     * and they are told of it too.
     */
    private async sendLocked(batch: Batch, coordinator: VfsCoordinator): Promise<void> {
        const { copy } = batch;
        // An announcement another tab made just before it let go of this
        // lock may still be on its way: let it in before deciding.
        await nextTurn();
        // Hearing for whoever is signed in now, before deciding: starting to
        // hear - or hearing someone else - marks every copy out of date.
        coordinator.listen();
        const checked = this.hearing;
        const fresh = copy.gen === this.generation && !this.current(copy)
            ? await this.fetchRecord(copy.id, copy.key, copy.gen, copy.path)
            : null;
        // Nothing waits from here to the seal, so no edit can come in between.
        this.close(batch);
        if (fresh && !this.replay(batch, fresh)) return;
        try {
            await this.writeRecord(copy);
            copy.seen = this.hearing;
        } finally {
            coordinator.announce(copy.id);
        }
        if (!fresh && (this.heardAt.get(copy.id) ?? 0) > checked) {
            // Written before the other tab's write of it was heard of: it may
            // have undone that write. The lock is meant to make this
            // impossible; seeing it means an announcement came late.
            const where = copy.path ?? `record ${printable(copy.id, 40)}`;
            this.warn(`another tab's write of ${where} was heard of only after this tab had written it; that write may be lost`);
        }
    }

    /**
     * Make every edit in `batch` again, in order, to `fresh` - the record as
     * another tab left it - and make that the copy. An edit that no longer
     * applies throws, as it would have the first time, and is left out; its
     * caller gets what it threw. Every edit checks before it changes
     * anything (see `mutate`), so one that throws has changed nothing. True
     * when what is left changes the record, and so needs writing.
     */
    private replay(batch: Batch, fresh: OpenDir): boolean {
        const { copy } = batch;
        copy.node = fresh.node;
        copy.hidden = fresh.hidden;
        copy.seen = fresh.seen;
        let changed = false;
        for (const ticket of batch.edits) {
            try {
                if (ticket.edit(copy.node, copy) !== false) changed = true;
            } catch (err) {
                batch.refused.set(ticket, err);
            }
        }
        if (changed) this.touch(copy);
        return changed;
    }

    /**
     * Another tab wrote record `id` - or, null, this namespace may have
     * missed some announcements. A copy read before then is out of date (see
     * `current`), and the next write of its record reads it again first (see
     * `sendLocked`). What the cache holds is read again when next asked
     * for, as a change frame from the personal space would have it.
     */
    private heard(id: string | null): void {
        const at = ++this.hearing;
        if (id === null) {
            this.missedAt = at;
            this.cache.clear();
            return;
        }
        this.heardAt.set(id, at);
        this.cache.delete(id);
    }

    /** Does `copy` hold every write of its record another tab has announced? See `heard`. */
    private current(copy: OpenDir): boolean {
        return copy.seen >= Math.max(this.missedAt, this.heardAt.get(copy.id) ?? 0);
    }
```

- [ ] **Step 10: Make `mkdir` wait for a name not yet written** (Decision 1). After the `heardAt` field, add:

```ts

    /**
     * Each directory a `createDir` here has named whose write has not landed
     * yet, by entry id: a promise that settles - and never rejects - once
     * that write has landed or failed. See `mkdir`.
     */
    private readonly naming = new Map<string, Promise<void>>();
```

In `mkdir`, replace:

```ts
            const dir = await this.openDir(current);
            const existing = entryIn(dir.node, name);
            if (!existing) assertNotHidden(dir, name, next);
```

with:

```ts
            let dir = await this.openDir(current);
            let existing = entryIn(dir.node, name);
            // Named by a mkdir here whose write has not landed. Until it has,
            // the name is a promise, not a fact: with a coordinator, that edit
            // is made again under the lock to the folder as another tab left
            // it, and comes to nothing when that tab named a directory there
            // first - and whatever was saved meanwhile into the one named
            // here is in a directory nothing names. A failed write drops it
            // too. So wait for the write, and look again.
            let unwritten = existing && this.naming.get(existing.id);
            while (unwritten) {
                await unwritten;
                dir = await this.openDir(current);
                existing = entryIn(dir.node, name);
                unwritten = existing && this.naming.get(existing.id);
            }
            if (!existing) assertNotHidden(dir, name, next);
```

In `createDir`, replace:

```ts
        await this.mutate(parent, (node, record) => {
            // mkdir looked before the wait above. A directory made there
            // since, by another `mkdir -p` of the same path - files saved
            // at once into a new folder - is kept, not replaced: whatever
            // was saved into it would go with it.
            const now = entryIn(node, name);
            if (now?.kind === "dir" && recursive) return false;
            if (now) throw new VfsConflictError(`${path} ${now.kind === "dir" ? "already exists" : "is a file"}`);
            assertNotHidden(record, name, path);
            node.entries[name] = entry;
            return true;
        });
    }
```

with:

```ts
        // The directory the edit below last found there, if any.
        let there: Entry | undefined;
        const named = this.mutate(parent, (node, record) => {
            // mkdir looked before the wait above. A directory made there
            // since, by another `mkdir -p` of the same path - files saved
            // at once into a new folder - is kept, not replaced: whatever
            // was saved into it would go with it.
            const now = entryIn(node, name);
            there = now;
            if (now?.kind === "dir" && recursive) return false;
            if (now) throw new VfsConflictError(`${path} ${now.kind === "dir" ? "already exists" : "is a file"}`);
            assertNotHidden(record, name, path);
            node.entries[name] = entry;
            return true;
        });
        // Set before anyone can find the entry in the cached parent - `mutate`
        // makes the edit at once, or after a re-read - so a mkdir that finds
        // it there waits for this write. See `naming`.
        this.naming.set(entry.id, named.then(() => {}, () => {}).then(() => void this.naming.delete(entry.id)));
        await named;
        // The directory kept instead may be one another mkdir here named,
        // its write not landed yet: wait for that too, as `mkdir` does.
        const kept = there && this.naming.get(there.id);
        if (kept) await kept;
    }
```

`Entry` is already imported from `./types`. This holds with no coordinator too: saves into a new folder now wait for the write that names it, where before only the first of them did. Nothing else changes for them.

- [ ] **Step 11: Fix `sweep`'s doc.** In the `sweep` doc comment, replace:

```ts
     * These accumulate because every write touches exactly one record: if two
     * tabs or devices edit the same directory, the personal space keeps
     * whichever put arrives last (a VFS write sends no HLC, and the space
     * applies puts of one key in arrival order), which can leave a child whose
     * parent entry lost the race. The per-record write queue (`writing`) only
     * orders writes within one tab. Unreachable is harmless —
```

with:

```ts
     * These accumulate because every write touches exactly one record: if two
     * devices edit the same directory - or two tabs, where there is no
     * coordinator - the personal space keeps whichever put arrives last (a
     * VFS write sends no HLC, and the space applies puts of one key in arrival
     * order), which can leave a child whose parent entry lost the race. The
     * per-record queue and the coordinator order writes within one device
     * only. Unreachable is harmless —
```

- [ ] **Step 12: Run the tests to verify they pass**

Run: `cd /Users/matt/GitHub/muhkoo/connect && npx vitest --run tests/vfs/cross-tab.test.ts tests/vfs/write-order.test.ts` (5 times in a row)

Expected: all pass every time.

- [ ] **Step 13: Regression suites, the surface, types and lint**

Run: `cd /Users/matt/GitHub/muhkoo/connect && npx vitest --run tests/vfs tests/vcs tests/offline tests/api && yarn typecheck && npx eslint src/vfs/VfsNamespace.ts src/vfs/coordinator.ts`

Expected:
- all pass, including `tests/api/export-surface.test.ts`, which shows no new public name;
- `tsc` exits 0;
- eslint is clean.

If export-surface fails because of a new name, the name has leaked through `export *`. Make it module-private. Do not update `api-surface.txt`.

- [ ] **Step 14: The existing suites on the coordinator path.** No suite but `cross-tab.test.ts` runs a `VfsNamespace` with a coordinator, and that is the path every browser tab takes. This runs `tests/vfs` and `tests/vcs` once with a one-tab coordinator in every namespace that has none. Nothing in the repo changes.

Create `<scratchpad>/one-tab.ts`:

```ts
/**
 * W1 check, never committed: give every VfsNamespace that has no coordinator a
 * one-tab one, so the existing suites run the coordinator path. W1_GRANT_DELAY
 * (ms) delays each grant, as a browser's lock IPC does.
 */
import { VfsNamespace } from "/Users/matt/GitHub/muhkoo/connect/src/vfs/VfsNamespace";

const delay = Number(process.env.W1_GRANT_DELAY ?? 0);

function oneTab() {
    const tails = new Map<string, Promise<void>>();
    return {
        async lock<T>(id: string, fn: () => Promise<T>): Promise<T> {
            const before = tails.get(id) ?? Promise.resolve();
            let release!: () => void;
            const mine = new Promise<void>((resolve) => (release = resolve));
            const tail = before.then(() => mine);
            tails.set(id, tail);
            await before;
            if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
            try {
                return await fn();
            } finally {
                release();
                if (tails.get(id) === tail) tails.delete(id);
            }
        },
        announce() {},
        onAnnounce() {
            return () => {};
        },
        listen() {},
    };
}

const proto = VfsNamespace.prototype as unknown as { send(batch: unknown): Promise<void> };
const send = proto.send;
proto.send = function (this: { deps: { coordinator?: unknown } }, batch: unknown) {
    this.deps.coordinator ??= oneTab();
    return send.call(this, batch);
};
```

Create `<scratchpad>/vitest.one-tab.config.mts`, with `<scratchpad>` written out as the absolute path:

```ts
// W1 check, never committed: connect's own config, plus one-tab.ts in every project's setupFiles.
import base from "/Users/matt/GitHub/muhkoo/connect/vitest.config";

const ONE_TAB = "<scratchpad>/one-tab.ts";
const projects = (base.test?.projects ?? []) as Array<{ test: { setupFiles: string[] } }>;

export default {
    ...base,
    root: "/Users/matt/GitHub/muhkoo/connect",
    test: {
        ...base.test,
        projects: projects.map((project) => ({
            ...project,
            root: "/Users/matt/GitHub/muhkoo/connect",
            test: { ...project.test, setupFiles: [...project.test.setupFiles, ONE_TAB] },
        })),
    },
};
```

Run: `cd /Users/matt/GitHub/muhkoo/connect && npx vitest --run --config <scratchpad>/vitest.one-tab.config.mts --project unit tests/vfs tests/vcs`, then the same with `W1_GRANT_DELAY=1` in front.

Expected, both times: 391 passed and 2 failed, and only these two. Both differ by design, and neither loses anything:
- "sends twenty files … in two writes of it": `expected 1 to be 2`. With a coordinator, the first write is sealed only once the lock is granted, so the whole burst often goes out as one write. That is why Task 2's CHANGELOG says "at most two".
- "keeps every file whose write worked … fails once part way through": `expected [ 'c' ] to deeply equal [ 'b', 'c' ]`. For the same reason, `b` rides on the write that fails, and fails with it. Both saves reject, and a retry stores them.

Any other failure is a regression on the browser path: fix it before going on.

- [ ] **Step 15: Mutation check.** Use the copy, `cmp` and restore routine, and run the whole file (`npx vitest --run tests/vfs/cross-tab.test.ts`). At least the named tests must fail. Most mutations fail several more.

| Mutation | Tests that must fail (at least) |
|---|---|
| `send` ignores the coordinator (always the no-coordinator branch) | "keeps both files…", "keeps a file saved in one tab while…" (13 fail in all) |
| `sendLocked` never re-reads (`const fresh = null as OpenDir \| null`) | "keeps both files…", "keeps a file saved in one tab while…", "fails a save whose re-read under the lock fails…", "keeps every file when two tabs each save files into a new folder…" |
| `replay` does not record refusals (empty `catch`) | "refuses a save of a name another tab saved first…", "refuses only the save that no longer applies…" |
| `mutate` rejects every edit of a batch once any is refused (`if (batch.refused.size > 0) throw [...batch.refused.values()][0];`) | "refuses only the save that no longer applies…" |
| `replay` stops at the first refusal (`break` after `batch.refused.set`) | "refuses only the save that no longer applies…" |
| `heard(null)` does nothing | "re-reads a folder before writing it when this tab may have missed…", "refuses to delete a folder it read before…" |
| `heard(id)` does not drop the cache | "lists what another tab has written to a folder…" |
| `current` always true | "keeps both files…", "keeps a file saved in one tab while…", "re-reads a folder before writing it when this tab may have missed…" |
| `openDirById` never calls `listen()` | "starts hearing the other tabs before it first reads a folder" |
| `mkdir` never waits (`let unwritten = undefined as Promise<void> \| undefined;`) | "keeps every file when two tabs each save files into a new folder…" |
| `createDir` does not wait for the directory it kept (drop `if (kept) await kept;`) | "keeps every file when two tabs each save files into a new folder…" |
| `createDir` never registers in `naming` | "keeps every file when two tabs each save files into a new folder…" |
| Drop the late-announcement warning | "warns when another tab's write is heard of only after…" |

Not pinned, on purpose: `send`'s `.finally(() => this.close(batch))` closes a window that needs an old-generation copy to join a failed batch, and `sendLocked`'s `listen()` repeats what both coordinators' `lock` already does.

- [ ] **Step 16: Checkpoint for Matt (no commit)**

Run: `sh <scratchpad>/w1-baseline/changed.sh`

Expected: `CHANGELOG.md`, `src/vfs/VfsNamespace.ts`, `src/vfs/coordinator.ts`, `tests/vfs/cross-tab.test.ts` and `tests/vfs/write-order.test.ts`, then `released CHANGELOG sections: unchanged`. Report RED, GREEN, the coordinator-path run and the mutation results. Do not stage, commit or stash.

---

### Task 4: Draining the offline queue under a device-wide lock

**Files:**
- Modify: `src/offline/OutboundQueue.ts` (the constructor, `drain`, a new `drainOnce`, and the module doc).
- Modify: `src/offline/OfflineManager.ts` (`OfflineManagerDeps` and the queue construction).
- Create: `tests/offline/tabs.test.ts` (shared with Task 5).
- Modify: `CHANGELOG.md`.

**Interfaces:**
- Produces, used by Task 6:
  ```ts
  export type TryLock = (name: string, fn: () => Promise<void>) => Promise<boolean>;
  export interface OutboundQueueOptions { tryLock?: TryLock; commitment?: () => string | null }
  new OutboundQueue(store: OfflineStore, opts?: OutboundQueueOptions)
  OfflineManagerDeps.locks?: TryLock
  ```

- [ ] **Step 1: Write the failing tests.** Create `tests/offline/tabs.test.ts`:

```ts
/**
 * Two tabs of one origin: two OfflineManagers over one IndexedDB, as two tabs
 * share it.
 */
import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { IndexedDbStore } from "../../src/offline/store/IndexedDbStore";
import { OfflineManager } from "../../src/offline/OfflineManager";
import type { TryLock } from "../../src/offline/OutboundQueue";
import { SessionState } from "../../src/core/Session";
import { pack } from "../../src/offline/clock/HlcTimestamp";

beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
});

/** Web Locks' `ifAvailable`, as the tabs of one browser share it. `taken` lists every name it granted. */
function deviceLocks(): { tryLock: TryLock; taken: string[] } {
    const held = new Set<string>();
    const taken: string[] = [];
    const tryLock: TryLock = async (name, fn) => {
        if (held.has(name)) return false;
        held.add(name);
        taken.push(name);
        try {
            await fn();
            return true;
        } finally {
            held.delete(name);
        }
    };
    return { tryLock, taken };
}

async function signedIn(commitment = "c1"): Promise<SessionState> {
    const session = new SessionState();
    await session.setSession({ token: "t", username: "u", commitment });
    return session;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function entry(n: number) {
    return { hlc: pack(n, 0, "n"), clientId: `c${n}`, domain: "kv" as const, method: "set", args: { n } };
}

describe("offline queue — two tabs", () => {
    it("replays each queued write once when two tabs drain the shared queue at once", async () => {
        const session = await signedIn();
        const locks = deviceLocks();
        const tabs = [0, 1].map(() => new OfflineManager({ store: new IndexedDbStore(), session, enabled: true, locks: locks.tryLock }));
        const replayed: number[] = [];
        for (const tab of tabs) {
            tab.registerReplayer("kv", async (queued) => {
                await sleep(5);
                replayed.push((queued.args as { n: number }).n);
            });
        }
        try {
            for (const n of [1, 2, 3]) await tabs[0].enqueue(entry(n));

            await Promise.all(tabs.map((tab) => tab.queue.drain()));

            expect(replayed).toEqual([1, 2, 3]);
            expect(await tabs[1].queue.pending()).toBe(0);
            expect(locks.taken).toEqual(["muhkoo:offline-drain:c1"]);
        } finally {
            for (const tab of tabs) tab.dispose();
        }
    });

    it("drains, after another tab's drain stopped on a failure, only what is left", async () => {
        const session = await signedIn();
        const locks = deviceLocks();
        const [first, second] = [0, 1].map(() => new OfflineManager({ store: new IndexedDbStore(), session, enabled: true, locks: locks.tryLock }));
        const replayed: string[] = [];
        first.registerReplayer("kv", async (queued) => {
            const { n } = queued.args as { n: number };
            if (n === 2) throw new TypeError("Failed to fetch");   // transient: the drain stops here
            replayed.push(`first:${n}`);
        });
        second.registerReplayer("kv", async (queued) => void replayed.push(`second:${(queued.args as { n: number }).n}`));
        try {
            for (const n of [1, 2, 3]) await first.enqueue(entry(n));

            await expect(first.queue.drain()).rejects.toBeInstanceOf(TypeError);
            await second.queue.drain();

            expect(replayed).toEqual(["first:1", "second:2", "second:3"]);
            expect(await first.queue.pending()).toBe(0);
        } finally {
            first.dispose();
            second.dispose();
        }
    });

    it("replays what a tab queued while another tab was draining, once that tab has left the drain to it", async () => {
        // The second tab found the first draining and skipped its own drain,
        // but the first had read the queue before the second's write was in
        // it: one pass, and that write waited for the next time either tab
        // came back online.
        const session = await signedIn();
        const locks = deviceLocks();
        const [first, second] = [0, 1].map(() => new OfflineManager({ store: new IndexedDbStore(), session, enabled: true, locks: locks.tryLock }));
        const replayed: string[] = [];
        let reached!: () => void;
        let go!: () => void;
        const replaying = new Promise<void>((resolve) => (reached = resolve));
        const released = new Promise<void>((resolve) => (go = resolve));
        first.registerReplayer("kv", async (queued) => {
            const { n } = queued.args as { n: number };
            if (n === 1) {
                reached();
                await released;
            }
            replayed.push(`first:${n}`);
        });
        second.registerReplayer("kv", async (queued) => void replayed.push(`second:${(queued.args as { n: number }).n}`));
        try {
            await first.enqueue(entry(1));
            const draining = first.queue.drain();
            await replaying;                          // first holds the lock, its pass already read
            await second.enqueue(entry(2));
            await second.queue.drain();               // first is draining: second leaves it
            go();
            await draining;

            expect(replayed).toEqual(["first:1", "first:2"]);
            expect(await second.queue.pending()).toBe(0);
        } finally {
            first.dispose();
            second.dispose();
        }
    });

    it("drains without the lock when no one is signed in", async () => {
        const locks = deviceLocks();
        const tab = new OfflineManager({ store: new IndexedDbStore(), session: new SessionState(), enabled: true, locks: locks.tryLock });
        const replayed: number[] = [];
        tab.registerReplayer("kv", async (queued) => void replayed.push((queued.args as { n: number }).n));
        try {
            await tab.enqueue(entry(1));
            await tab.queue.drain();
            expect(replayed).toEqual([1]);
            expect(locks.taken).toEqual([]);
        } finally {
            tab.dispose();
        }
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/matt/GitHub/muhkoo/connect && npx vitest --run tests/offline/tabs.test.ts`

Expected:
- "replays each queued write once…" FAILS with `expected [ 1, 1, 2, 2, 3, 3 ] to deeply equal [ 1, 2, 3 ]` (the order may interleave);
- "drains, after another tab's drain stopped on a failure…" PASSES. It is a guard: entries are removed only once replayed, before and after this task. Under the lock it pins only that a failed drain's error still reaches its caller;
- "replays what a tab queued while another tab was draining…" FAILS with `expected [ 'second:1', 'second:2', 'first:1' ] to deeply equal [ 'first:1', 'first:2' ]`: with no lock, the second tab drains alongside the first;
- "drains without the lock…" PASSES (`taken` is empty, since no lock is used yet).

- [ ] **Step 3: Change `OutboundQueue`.** In `src/offline/OutboundQueue.ts`, replace:

```ts
export type Replayer = (entry: QueueEntry) => Promise<void>;

export class OutboundQueue {
    private readonly replayers = new Map<QueueEntry["domain"], Replayer>();
    private draining: Promise<void> | null = null;

    constructor(private readonly store: OfflineStore) {}
```

with:

```ts
export type Replayer = (entry: QueueEntry) => Promise<void>;

/**
 * Run `fn` holding lock `name` if no one else holds it: true once it has
 * run, false - without running it - when another holder has it. Web Locks'
 * `ifAvailable` in a browser tab; see `core/crossTab.ts`.
 */
export type TryLock = (name: string, fn: () => Promise<void>) => Promise<boolean>;

export interface OutboundQueueOptions {
    /**
     * The lock that keeps two tabs from draining at once. Every tab of an
     * origin shares one IndexedDB queue, and each replayed all of it when it
     * came back online: two tabs, every queued write twice. Absent (Node,
     * tests), every drain runs, as before.
     */
    tryLock?: TryLock;
    /** Whose drain lock to take: the signed-in user's. With no one signed in, the drain runs unlocked. */
    commitment?: () => string | null;
}

export class OutboundQueue {
    private readonly replayers = new Map<QueueEntry["domain"], Replayer>();
    private draining: Promise<void> | null = null;

    constructor(
        private readonly store: OfflineStore,
        private readonly opts: OutboundQueueOptions = {},
    ) {}
```

Replace `drain` with:

```ts
    drain(): Promise<void> {
        if (this.draining) return this.draining;
        this.draining = this.drainOnce().finally(() => {
            this.draining = null;
        });
        return this.draining;
    }

    /**
     * One drain, holding the device-wide drain lock where there is one. A
     * tab that finds another tab holding it leaves the queue to that one,
     * which is replaying it already and removes each entry as it lands - so
     * a drain after it finds only what it left.
     */
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
```

Each pass ends: every entry it read is removed (replayed, refused for good, or with no replayer), or a transient failure throws. So the loop ends once nothing new is being queued. Without a lock, a drain is still one pass, as before.

Also add these lines to the module doc at the top of the file, directly after its line ` * drained queue is safe.` (the paragraph that begins `Replays are idempotent by construction`):

```ts
 *
 * Every tab of an origin shares the queue. Given a `tryLock`, a drain runs
 * only while holding `muhkoo:offline-drain:<commitment>`, so two tabs coming
 * back online replay it once between them, not once each.
```

- [ ] **Step 4: Change `OfflineManager`.** In `src/offline/OfflineManager.ts`, change the import to `import { OutboundQueue, type Replayer, type TryLock } from "./OutboundQueue";`. In `OfflineManagerDeps`, after `enabled: boolean;`, add:

```ts
    /**
     * The drain lock the tabs of this origin share - Web Locks in a browser
     * tab. Absent, every tab drains the shared queue itself, as before. See
     * `OutboundQueue`.
     */
    locks?: TryLock;
```

In the constructor, replace `this.queue = new OutboundQueue(deps.store);` with:

```ts
        this.queue = new OutboundQueue(deps.store, {
            tryLock: deps.locks,
            commitment: () => deps.session.commitment,
        });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/matt/GitHub/muhkoo/connect && npx vitest --run tests/offline` (3 times)

Expected: all pass, including `sync.test.ts` (an `OutboundQueue` with no options drains as before).

- [ ] **Step 6: Types, lint and the surface**

Run: `cd /Users/matt/GitHub/muhkoo/connect && yarn typecheck && npx eslint src/offline/OutboundQueue.ts src/offline/OfflineManager.ts && npx vitest --run tests/api`

Expected: all clean, and export-surface green, with no new name. `TryLock` and `OutboundQueueOptions` are not re-exported by `src/offline/index.ts`.

- [ ] **Step 7: Mutation check.** Copy `src/offline/OutboundQueue.ts` to the scratchpad first. Apply each mutation alone, run `npx vitest --run tests/offline/tabs.test.ts`, restore from the copy, and confirm with `cmp`.

| Mutation | Tests that must fail (at least) |
|---|---|
| `drainOnce` never takes the lock (`return this.runDrain();` first) | "replays each queued write once…" |
| A drain that finds the lock taken drains anyway (`if (!(await this.opts.tryLock(…))) await this.runDrain();`) | "replays each queued write once…" |
| Drain with the lock when no one is signed in (drop `\|\| !who`) | "drains without the lock when no one is signed in" |
| Another lock name (`muhkoo:drain:${who}`) | "replays each queued write once…" (its `taken` check) |
| One pass under the lock (drop the `do … while`) | "replays what a tab queued while another tab was draining…" |
| Swallow a failed drain (`.catch(() => {})` on `tryLock`) | "drains, after another tab's drain stopped on a failure…" |

- [ ] **Step 8: Update the CHANGELOG.** Under `## Unreleased` → `### Fixed`, after Task 1's bullet, add:

```markdown
- **Two tabs coming back online no longer replay the same queued offline writes.** Every tab of an origin shares one
  offline queue, and each tab replayed all of it. A tab now drains the queue only while it holds a lock that no other
  tab holds (Web Locks). A tab that finds another tab draining leaves the queue to it, and the draining tab carries
  on until the queue is empty, so what the other tab queued meanwhile is not left behind. The tab that left it may
  report its sync complete before those writes have landed. Without Web Locks (Node), nothing changes.
```

- [ ] **Step 9: Checkpoint for Matt (no commit)**

Run: `sh <scratchpad>/w1-baseline/changed.sh`

Expected: Task 3's five files, plus `src/offline/OutboundQueue.ts`, `src/offline/OfflineManager.ts` and `tests/offline/tabs.test.ts`, then `released CHANGELOG sections: unchanged`. Report RED, GREEN and the mutation results. Do not stage, commit or stash.

---

### Task 5: One HLC node id per tab

**Files:**
- Modify: `src/offline/OfflineManager.ts` (`boot`, and a new module-level `tabSuffix`).
- Modify: `tests/offline/tabs.test.ts` (a new `describe`).
- Modify: `CHANGELOG.md`.
- Read only: `/Users/matt/GitHub/muhkoo/accelerator/src` (verification).

**Interfaces:**
- Consumes `OfflineManager`, as Task 4 left it.
- Produces node ids of the form `${deviceId}.${tabSuffix}`, where `tabSuffix` is 12 hex characters. The stored `meta/nodeId` stays the device id.

- [ ] **Step 1: Write the failing tests.** Append to `tests/offline/tabs.test.ts`, and add `unpack` to the `HlcTimestamp` import (`import { pack, unpack } from "../../src/offline/clock/HlcTimestamp";`):

```ts
describe("HLC node ids — two tabs", () => {
    it("gives each tab its own node id, under the device's", async () => {
        const session = await signedIn();
        const first = new OfflineManager({ store: new IndexedDbStore(), session, enabled: true });
        await first.ready();
        const second = new OfflineManager({ store: new IndexedDbStore(), session, enabled: true });
        await second.ready();
        try {
            const a = unpack(await first.nextHlc()).nodeId;
            const b = unpack(await second.nextHlc()).nodeId;
            const device = await new IndexedDbStore().get<string>("meta", "nodeId");

            expect(a).not.toBe(b);
            expect(device).toBeTruthy();
            expect(a.startsWith(`${device}.`)).toBe(true);
            expect(b.startsWith(`${device}.`)).toBe(true);
        } finally {
            first.dispose();
            second.dispose();
        }
    });

    it("never mints one stamp in two tabs", async () => {
        const session = await signedIn();
        const first = new OfflineManager({ store: new IndexedDbStore(), session, enabled: true });
        await first.ready();
        const second = new OfflineManager({ store: new IndexedDbStore(), session, enabled: true });
        await second.ready();
        try {
            const mint = (tab: OfflineManager) => Promise.all(Array.from({ length: 200 }, () => tab.nextHlc()));
            const [a, b] = await Promise.all([mint(first), mint(second)]);
            expect(new Set([...a, ...b]).size).toBe(400);
        } finally {
            first.dispose();
            second.dispose();
        }
    });

    it("still gives two tabs that start together on a new device distinct node ids", async () => {
        const session = await signedIn();
        const tabs = [0, 1].map(() => new OfflineManager({ store: new IndexedDbStore(), session, enabled: true }));
        try {
            const ids = await Promise.all(tabs.map(async (tab) => unpack(await tab.nextHlc()).nodeId));
            expect(ids[0]).not.toBe(ids[1]);
        } finally {
            for (const tab of tabs) tab.dispose();
        }
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/matt/GitHub/muhkoo/connect && npx vitest --run tests/offline/tabs.test.ts -t "HLC node ids"`

Expected:
- the first test FAILS with `expected '<id>' not to be '<id>'` (one shared node id);
- the second usually FAILS, on duplicate stamps;
- the third may PASS, because concurrent first boots race on the stored id. It is a guard.

- [ ] **Step 3: Implement.** In `src/offline/OfflineManager.ts`, add this after the `HLC_STATE_KEY` constant:

```ts
/**
 * A random suffix for this tab's HLC node id, held in memory only - see
 * `OfflineManager.boot`. 48 bits: two tabs of one device never draw the same.
 */
function tabSuffix(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
```

In `boot`, replace:

```ts
        let nodeId = await this.store.get<string>("meta", META_NODE_ID);
        if (!nodeId) {
            nodeId = generateId();
            await this.store.put("meta", META_NODE_ID, nodeId);
        }
        this.nodeId = nodeId;
        const state = await this.store.get<HlcState>("hlc-state", HLC_STATE_KEY);
        this.hlc = new HLC(nodeId, { state });
```

with:

```ts
        let deviceId = await this.store.get<string>("meta", META_NODE_ID);
        if (!deviceId) {
            deviceId = generateId();
            await this.store.put("meta", META_NODE_ID, deviceId);
        }
        // One node id per TAB, under the device's. Every tab of an origin
        // loads the same stored id, and two tabs stamping with it in the same
        // millisecond minted identical HLCs: the node id is the tiebreak, and
        // the server keeps the first of two equal stamps, so the second write
        // was dropped. The suffix lives in memory only. The clock state below
        // stays shared, so the clock never goes back across tabs, and stamps
        // stored already stay valid: every comparison reads a packed stamp as
        // one string and never parses the node id.
        this.nodeId = `${deviceId}.${tabSuffix()}`;
        const state = await this.store.get<HlcState>("hlc-state", HLC_STATE_KEY);
        this.hlc = new HLC(this.nodeId, { state });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/matt/GitHub/muhkoo/connect && npx vitest --run tests/offline` (3 times)

Expected: all pass.

- [ ] **Step 5: Verify nothing parses the node id, and that the server compares order only.** Record the outputs in the task report.

Run: `cd /Users/matt/GitHub/muhkoo/connect && grep -rnE "nodeId|unpack\(" src | grep -v "^src/offline/clock/"`

Expected: exactly these, and nothing else (line numbers drift):
- `src/offline/crdt/LWWRegister.ts:9`, a doc comment ("…down to a nodeId");
- `src/offline/store/schema.ts:49`, `export const META_NODE_ID = "nodeId";`, the stored key's name;
- `src/offline/OfflineManager.ts`:
  - the field, `private nodeId = "";`;
  - `observeHlc`'s `this.hlc!.update(unpack(remote));`. `unpack` returns the node id as the remainder after the second `:`, and never splits it;
  - the non-persistent branch of `boot`: `this.nodeId = generateId();` and `this.hlc = new HLC(this.nodeId);`;
  - this task's two lines in `boot`: ``this.nodeId = `${deviceId}.${tabSuffix()}`;`` and `this.hlc = new HLC(this.nodeId, { state });`.

None of them parses a node id or compares two of them.

Run: `cd /Users/matt/GitHub/muhkoo/accelerator && grep -rnE "hlcLoses|meta\.hlc >=|hlc > prev|hlc > max|maxHlc\(hlcMap\) <=|deleteHlc <= tomb" src`

Expected: `PersonalSpaceDO.ts` `hlcLoses` (its definition, `meta.hlc >= incomingHlc`, and two calls), `dbCrdt.ts` `hlc > prev` and `hlc > max`, and `TableDOv1.ts` `maxHlc(hlcMap) <= tomb` and `deleteHlc <= tomb`. These are whole-string order comparisons.

Run: `cd /Users/matt/GitHub/muhkoo/accelerator && grep -rnE "split\(\":\"\)|nodeId" src | grep -i hlc`

Expected: no output, and exit status 1 (grep found nothing): no parsing, and no node-id equality.

If any of these differs, stop and report it. Do not change the accelerator.

- [ ] **Step 6: Types and lint**

Run: `cd /Users/matt/GitHub/muhkoo/connect && yarn typecheck && npx eslint src/offline/OfflineManager.ts`

Expected: clean.

- [ ] **Step 7: Update the CHANGELOG.** Under `## Unreleased` → `### Fixed`, after Task 4's bullet, add:

```markdown
- **Two tabs no longer stamp writes with the same HLC.** Every tab of a device used one HLC node id, so two writes made
  in the same millisecond by two tabs could carry identical stamps, and the server dropped the second of two equal
  stamps. Each tab now uses `<device id>.<tab suffix>`. The stored device id, the shared clock state and every stamp
  already stored are unchanged.
```

- [ ] **Step 8: Checkpoint for Matt (no commit)**

Run: `sh <scratchpad>/w1-baseline/changed.sh`

Expected: the same files as after Task 4, then `released CHANGELOG sections: unchanged`. Task 5 changes only files Task 4 already changed. Do not stage, commit or stash.

---

### Task 6: Web Locks and BroadcastChannel in the browser

**Files:**
- Create: `src/core/crossTab.ts`.
- Modify: `src/core/Client.ts` (the `OfflineManager` and `VfsNamespace` constructions).
- Create: `tests/core/crossTab.test.ts`.
- Create: `tests/client/tabs.test.ts`.
- Modify: `CHANGELOG.md`.

**Interfaces:**
- Consumes:
  - `VfsCoordinator` (Task 3);
  - `TryLock` and `OfflineManagerDeps.locks` (Task 4);
  - `VfsConflictError` (`src/vfs/types`);
  - `generateId` (`src/utilities`).
- Produces, from `src/core/crossTab.ts`, which nothing re-exports:
  ```ts
  export const LOCK_WAIT_MS = 30_000;
  export function drainLock(): TryLock | undefined;
  export function vfsCoordinator(
      commitment: () => string | null,
      opts?: { lockWaitMs?: number },
  ): (VfsCoordinator & { close(): void }) | undefined;
  ```
  Task 7 adds `holdMoving` to what `vfsCoordinator` returns.

- [ ] **Step 1: Write the failing tests.** Create `tests/core/crossTab.test.ts`:

```ts
/**
 * The browser's cross-tab coordination, in Node: `navigator.locks` is a fake
 * that grants as one browser does, and the BroadcastChannel is Node's own,
 * which reaches every other channel of the same name in the process.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { drainLock, vfsCoordinator } from "../../src/core/crossTab";
import { VfsConflictError } from "../../src/vfs/types";

/** Web Locks as one browser grants them: one holder per name, the rest in order; `ifAvailable`; `signal`. */
function fakeWebLocks() {
    const tails = new Map<string, Promise<void>>();
    const held = new Set<string>();
    const asked: string[] = [];
    return {
        asked,
        async request<T>(
            name: string,
            options: { ifAvailable?: boolean; signal?: AbortSignal },
            callback: (lock: unknown) => Promise<T>,
        ): Promise<T> {
            asked.push(name);
            if (options.ifAvailable && (held.has(name) || tails.has(name))) return callback(null);
            const before = tails.get(name) ?? Promise.resolve();
            let release!: () => void;
            const mine = new Promise<void>((resolve) => (release = resolve));
            const tail = before.then(() => mine);
            tails.set(name, tail);
            try {
                await new Promise<void>((resolve, reject) => {
                    options.signal?.addEventListener("abort", () => reject(new DOMException("The lock request was aborted", "AbortError")));
                    void before.then(resolve);
                });
            } catch (err) {
                release();   // its place in line passes straight on
                void tail.then(() => {
                    if (tails.get(name) === tail) tails.delete(name);
                });
                throw err;
            }
            held.add(name);
            try {
                return await callback({ name, mode: "exclusive" });
            } finally {
                held.delete(name);
                release();
                if (tails.get(name) === tail) tails.delete(name);
            }
        },
    };
}

function inABrowserTab() {
    const locks = fakeWebLocks();
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { locks });
    return locks;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("cross-tab coordination", () => {
    it("is off outside a browser tab", () => {
        expect(typeof window).toBe("undefined");
        expect(vfsCoordinator(() => "c1")).toBeUndefined();
        expect(drainLock()).toBeUndefined();
    });

    it("is off in a browser without Web Locks", () => {
        vi.stubGlobal("window", {});
        vi.stubGlobal("navigator", {});
        expect(vfsCoordinator(() => "c1")).toBeUndefined();
        expect(drainLock()).toBeUndefined();
    });

    it("holds one lock per user and record, one tab at a time", async () => {
        const locks = inABrowserTab();
        const a = vfsCoordinator(() => "c1")!;
        const b = vfsCoordinator(() => "c1")!;
        try {
            const order: string[] = [];
            let release!: () => void;
            const first = a.lock("r1", async () => {
                order.push("a in");
                await new Promise<void>((resolve) => (release = resolve));
                order.push("a out");
            });
            await tick();
            const second = b.lock("r1", async () => void order.push("b in"));
            await tick();
            expect(order).toEqual(["a in"]);
            release();
            await Promise.all([first, second]);
            expect(order).toEqual(["a in", "a out", "b in"]);
            expect(locks.asked).toEqual(["muhkoo:vfs:c1:r1", "muhkoo:vfs:c1:r1"]);
        } finally {
            a.close();
            b.close();
        }
    });

    it("tells the user's other tabs which record it wrote, and not itself", async () => {
        inABrowserTab();
        const a = vfsCoordinator(() => "c1")!;
        const b = vfsCoordinator(() => "c1")!;
        const heardByA: Array<string | null> = [];
        const heardByB: Array<string | null> = [];
        a.onAnnounce((id) => heardByA.push(id));
        b.onAnnounce((id) => heardByB.push(id));
        try {
            a.listen();
            b.listen();
            a.announce("r1");
            await vi.waitFor(() => expect(heardByB).toEqual([null, "r1"]));
            await tick();
            expect(heardByA).toEqual([null]);
        } finally {
            a.close();
            b.close();
        }
    });

    it("announces on muhkoo:vfs:<commitment> as { id, writer }, hears others' writers, and ignores its own", async () => {
        inABrowserTab();
        const a = vfsCoordinator(() => "c1")!;
        const wire = new globalThis.BroadcastChannel("muhkoo:vfs:c1");
        const onWire: unknown[] = [];
        wire.onmessage = (event) => void onWire.push(event.data);
        const heard: Array<string | null> = [];
        a.onAnnounce((id) => heard.push(id));
        try {
            a.listen();
            a.announce("r1");
            await vi.waitFor(() => expect(onWire).toHaveLength(1));
            const sent = onWire[0] as { id: unknown; writer: unknown };
            expect(sent.id).toBe("r1");
            expect(typeof sent.writer).toBe("string");

            wire.postMessage({ id: "r2", writer: "another tab" });
            wire.postMessage({ id: "r3", writer: sent.writer });   // its own writer id, as if it came back
            wire.postMessage({ id: "r4", writer: "another tab" });
            await vi.waitFor(() => expect(heard).toEqual([null, "r2", "r4"]));
        } finally {
            wire.close();
            a.close();
        }
    });

    it("follows a change of user: hears the new user's tabs, not the old one's, and says it may have missed some", async () => {
        const locks = inABrowserTab();
        let who = "alice";
        const tab = vfsCoordinator(() => who)!;
        const alice = vfsCoordinator(() => "alice")!;
        const bob = vfsCoordinator(() => "bob")!;
        const heard: Array<string | null> = [];
        tab.onAnnounce((id) => heard.push(id));
        try {
            tab.listen();
            tab.listen();
            expect(heard).toEqual([null]);              // once: it is hearing alice's tabs now
            who = "bob";
            await tab.lock("r1", async () => {});
            expect(heard).toEqual([null, null]);        // bob's now: what bob's tabs said before was missed
            expect(locks.asked).toEqual(["muhkoo:vfs:bob:r1"]);
            alice.announce("from-alice");
            bob.announce("from-bob");
            await vi.waitFor(() => expect(heard).toEqual([null, null, "from-bob"]));
            await tick();
            expect(heard).toEqual([null, null, "from-bob"]);
        } finally {
            tab.close();
            alice.close();
            bob.close();
        }
    });

    it("gives up waiting for a lock another tab has held too long, with a conflict, and writes nothing", async () => {
        inABrowserTab();
        const a = vfsCoordinator(() => "c1")!;
        const b = vfsCoordinator(() => "c1", { lockWaitMs: 30 })!;
        try {
            let release!: () => void;
            const holding = a.lock("r1", () => new Promise<void>((resolve) => (release = resolve)));
            await tick();
            let ran = false;
            await expect(b.lock("r1", async () => void (ran = true))).rejects.toThrow(VfsConflictError);
            expect(ran).toBe(false);
            release();
            await holding;
            await expect(b.lock("r1", async () => "after")).resolves.toBe("after");
        } finally {
            a.close();
            b.close();
        }
    });

    it("passes on what the write itself throws, an abort included, and a write longer than the wait is not cut short", async () => {
        inABrowserTab();
        const a = vfsCoordinator(() => "c1", { lockWaitMs: 30 })!;
        try {
            const abort = new DOMException("the request was aborted", "AbortError");
            await expect(a.lock("r1", async () => { throw abort; })).rejects.toBe(abort);
            await expect(
                a.lock("r1", async () => {
                    await new Promise((resolve) => setTimeout(resolve, 80));
                    return "landed";
                }),
            ).resolves.toBe("landed");
        } finally {
            a.close();
        }
    });

    it("writes without a lock when no one is signed in", async () => {
        const locks = inABrowserTab();
        const a = vfsCoordinator(() => null)!;
        try {
            await expect(a.lock("r1", async () => "ran")).resolves.toBe("ran");
            expect(locks.asked).toEqual([]);
        } finally {
            a.close();
        }
    });

    it("drains only when no other tab is draining", async () => {
        const locks = inABrowserTab();
        const tryLock = drainLock()!;
        let release!: () => void;
        const first = tryLock("muhkoo:offline-drain:c1", () => new Promise<void>((resolve) => (release = resolve)));
        await tick();
        let ran = false;
        await expect(tryLock("muhkoo:offline-drain:c1", async () => void (ran = true))).resolves.toBe(false);
        expect(ran).toBe(false);
        release();
        await expect(first).resolves.toBe(true);
        expect(locks.asked).toEqual(["muhkoo:offline-drain:c1", "muhkoo:offline-drain:c1"]);
    });
});
```

Create `tests/client/tabs.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { Client } from "../../src/core/Client";
import { MemorySessionStore } from "../../src/core/Session";

const BASE_URL = "http://localhost:8787";

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("Client — the other tabs of the app", () => {
    it("coordinates VFS writes and the offline drain with them in a browser tab with Web Locks", () => {
        vi.spyOn(console, "info").mockImplementation(() => {});
        vi.stubGlobal("window", {});
        vi.stubGlobal("navigator", { locks: { request: async () => undefined } });
        const client = new Client({ baseUrl: BASE_URL, offline: { enabled: false }, sessionStore: new MemorySessionStore() });
        expect((client.vfs as any).deps.coordinator).toBeDefined();
        expect((client.offline.queue as any).opts.tryLock).toBeDefined();
    });

    it("leaves both as they were in Node", () => {
        expect(typeof window).toBe("undefined");
        const client = new Client({ baseUrl: BASE_URL, offline: { enabled: false } });
        expect((client.vfs as any).deps.coordinator).toBeUndefined();
        expect((client.offline.queue as any).opts.tryLock).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/matt/GitHub/muhkoo/connect && npx vitest --run tests/core/crossTab.test.ts tests/client/tabs.test.ts`

Expected:
- `crossTab.test.ts` FAILS to load: `Error: Cannot find module '../../src/core/crossTab' imported from …/tests/core/crossTab.test.ts`;
- `tabs.test.ts`' first test FAILS: `expected undefined to be defined`.

- [ ] **Step 3: Create `src/core/crossTab.ts`**

```ts
/**
 * Coordination between the tabs of an app on one device: Web Locks and the
 * Web BroadcastChannel.
 *
 * Every factory here returns undefined unless the runtime is a browser tab
 * with both - not Node (which has `navigator.locks` from 24.5, but per
 * process), not a Worker, not an old WebView - and its callers then keep the
 * behaviour they had before: one tab's writes ordered among themselves only.
 * A storage-partitioned iframe gets locks and a channel of its own, as it
 * gets storage of its own; to the app's other tabs it is another device.
 *
 * `globalThis.BroadcastChannel` is named in full on purpose: this package
 * exports a class of its own called BroadcastChannel (the E2E room channel),
 * and an import of that in scope would silently take the Web API's place.
 */

import { VfsConflictError } from "../vfs/types";
import type { VfsCoordinator } from "../vfs/coordinator";
import type { TryLock } from "../offline/OutboundQueue";
import { generateId } from "../utilities";

/** How long a write waits for another tab to finish writing the same folder before it gives up. */
export const LOCK_WAIT_MS = 30_000;

/** The slice of the Web Locks API used here. */
interface LockManagerLike {
    request<T>(
        name: string,
        options: { ifAvailable?: boolean; signal?: AbortSignal },
        callback: (lock: unknown) => Promise<T>,
    ): Promise<T>;
}

/** The slice of the Web BroadcastChannel used here. */
interface ChannelLike {
    onmessage: ((event: { data: unknown }) => void) | null;
    postMessage(message: unknown): void;
    close(): void;
}

// Through `unknown`: the DOM's own LockManager and BroadcastChannel types do
// not line up with these slices closely enough for a direct cast.
function webLocks(): LockManagerLike | undefined {
    if (typeof window === "undefined") return undefined;
    const locks = (globalThis as unknown as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;
    return typeof locks?.request === "function" ? locks : undefined;
}

function webChannel(): (new (name: string) => ChannelLike) | undefined {
    const Channel = (globalThis as unknown as { BroadcastChannel?: new (name: string) => ChannelLike }).BroadcastChannel;
    return typeof Channel === "function" ? Channel : undefined;
}

/**
 * The offline queue's drain lock: `fn` runs only if no other tab is
 * draining, and `false` says another one is. See `OutboundQueue`.
 */
export function drainLock(): TryLock | undefined {
    const locks = webLocks();
    if (!locks) return undefined;
    return (name, fn) =>
        locks.request(name, { ifAvailable: true }, async (lock) => {
            if (!lock) return false;
            await fn();
            return true;
        });
}

/**
 * The `VfsCoordinator` for whoever `commitment()` names: a lock per record,
 * `muhkoo:vfs:<commitment>:<record id>`, and announcements on the channel
 * `muhkoo:vfs:<commitment>` as `{ id, writer }`, where `writer` is this tab's
 * random id. `close` is for tests.
 */
export function vfsCoordinator(
    commitment: () => string | null,
    opts: { lockWaitMs?: number } = {},
): (VfsCoordinator & { close(): void }) | undefined {
    const locks = webLocks();
    const Channel = webChannel();
    if (!locks || !Channel) return undefined;
    const lockWaitMs = opts.lockWaitMs ?? LOCK_WAIT_MS;
    const tab = generateId();
    const handlers = new Set<(id: string | null) => void>();
    let open: { who: string; channel: ChannelLike } | null = null;

    /**
     * Hear the channel of whoever is signed in now: opened the first time,
     * and opened again for someone else after a sign-in. What was announced
     * before it opened was not heard, which every handler is told.
     */
    const listen = (): void => {
        const who = commitment();
        if (open?.who === who) return;
        open?.channel.close();
        open = null;
        if (!who) return;
        const channel = new Channel(`muhkoo:vfs:${who}`);
        channel.onmessage = (event) => {
            const data = event.data as { id?: unknown; writer?: unknown } | null;
            if (typeof data?.id !== "string" || data.writer === tab) return;
            for (const handler of handlers) handler(data.id);
        };
        open = { who, channel };
        for (const handler of handlers) handler(null);
    };

    return {
        async lock<T>(id: string, fn: () => Promise<T>): Promise<T> {
            listen();
            const who = commitment();
            // Signed out: the store refuses the write itself, with a clearer message.
            if (!who) return fn();
            // Only the WAIT is bounded. Once granted, the lock is held until
            // the write has landed or failed: let go of while a write is still
            // on its way, the next tab's write could land first and then be
            // undone by it - the very loss this lock is for.
            const waiting = new AbortController();
            const timer = setTimeout(() => waiting.abort(), lockWaitMs);
            let granted = false;
            try {
                return await locks.request(`muhkoo:vfs:${who}:${id}`, { signal: waiting.signal }, () => {
                    granted = true;
                    clearTimeout(timer);
                    return fn();
                });
            } catch (err) {
                if (!granted && waiting.signal.aborted) {
                    throw new VfsConflictError(
                        `another tab of this app has been writing this folder for over ${Math.round(lockWaitMs / 1000)} seconds; nothing was written - try again`,
                    );
                }
                throw err;
            } finally {
                clearTimeout(timer);
            }
        },
        announce(id: string): void {
            listen();
            open?.channel.postMessage({ id, writer: tab });
        },
        onAnnounce(handler: (id: string | null) => void): () => void {
            handlers.add(handler);
            return () => void handlers.delete(handler);
        },
        listen,
        close(): void {
            open?.channel.close();
            open = null;
        },
    };
}
```

- [ ] **Step 4: Wire it into `Client`.** In `src/core/Client.ts`, add `import { drainLock, vfsCoordinator } from "./crossTab";` after `import { listPersonalKeys } from "./personalList";`. Replace:

```ts
        this.offline = new OfflineManager({
            store: offlineStore,
            session: this.session,
            enabled: offlineEnabled,
        });
```

with:

```ts
        this.offline = new OfflineManager({
            store: offlineStore,
            session: this.session,
            enabled: offlineEnabled,
            // Every tab of the origin shares the queue: one drains it at a time.
            locks: drainLock(),
        });
```

and replace:

```ts
        this.vfs = new VfsNamespace({
            store: personalStore,
            seed: () => this.session.seed,
```

with:

```ts
        this.vfs = new VfsNamespace({
            store: personalStore,
            seed: () => this.session.seed,
            // Orders writes of a folder with this app's other tabs on the
            // device - undefined outside a browser tab with Web Locks.
            coordinator: vfsCoordinator(() => this.session.commitment),
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/matt/GitHub/muhkoo/connect && npx vitest --run tests/core/crossTab.test.ts tests/client` (3 times)

Expected: all pass, and the process exits. A hang at the end means a BroadcastChannel was left open: every test must `close()` what it opens.

- [ ] **Step 6: The full unit run, types, lint, the build and the surface**

Run: `cd /Users/matt/GitHub/muhkoo/connect && yarn typecheck && yarn lint && yarn test:unit && yarn build && node scripts/check-dts.mjs`

Expected:
- every step exits 0;
- `yarn test:unit` reports every file passing, including `tests/api/export-surface.test.ts`;
- `check-dts` prints `OK`;
- `grep -c "muhkoo:vfs:" dist/browser/index.js` prints at least 1;
- `grep -n "export.*crossTab\|vfsCoordinator" dist/connect.d.ts` prints nothing, because the module is internal.

- [ ] **Step 7: Mutation check.** Copy `src/core/crossTab.ts` to the scratchpad first. Apply each mutation alone, run `npx vitest --run tests/core/crossTab.test.ts tests/client/tabs.test.ts`, restore from the copy, and confirm with `cmp`.

| Mutation | Tests that must fail (at least) |
|---|---|
| `drainLock` without `ifAvailable` (`{}`) | "drains only when no other tab is draining" (only after its 30-second timeout) |
| `listen` keeps the first user's channel (`if (open) return;`) | "follows a change of user…" |
| `lock` takes a lock with no one signed in (`if (who === undefined) return fn();`) | "writes without a lock when no one is signed in" |
| Hear its own announcements (drop `\|\| data.writer === tab`) | "announces on muhkoo:vfs:<commitment> as { id, writer }…" |
| Another channel name (`muhkoo:vfs:x:${who}`) | "announces on muhkoo:vfs:<commitment> as { id, writer }…" |
| Another message shape (`{ id, from: tab }`) | "announces on muhkoo:vfs:<commitment> as { id, writer }…" |

`if (!granted && waiting.signal.aborted)` → `if (waiting.signal.aborted)` fails no test. It is an equivalent mutant against the fake: the timer is cleared the moment the lock is granted, so the signal can abort after the grant only if a real browser grants the lock and fires the timer in the same turn. The `granted` check is what keeps a write's own error from being reported as "nothing was written" then. Keep it; it is not pinned.

- [ ] **Step 8: Update the CHANGELOG.** Under `## Unreleased` → `### Fixed`, add this as the FIRST bullet, above Task 1's:

```markdown
- **Two tabs writing to one folder no longer lose each other's files.** In a browser, `client.vfs` now writes each
  folder's record under a lock shared by every tab of the app on the device (Web Locks), and tells the other tabs which
  folder it wrote (BroadcastChannel).
  - A tab that hears of another tab's write reads that folder again before its next write of it, and makes its own
    pending edits to what it read. An edit that no longer applies fails with `VfsConflictError` instead of
    overwriting, and the other edits in the same write are still stored. For example, a save of a name the other tab
    took first fails.
  - Saves into a new folder wait until the folder is named in the store. Two tabs uploading a folder of the same name
    into one place at once end up with every file in one folder.
  - One tab on its own makes no extra requests.
  - A tab that waits 30 seconds for another tab to finish writing the same folder gives up with `VfsConflictError`
    and writes nothing.
  - Node, and runtimes without Web Locks, keep the previous behaviour.

  Not fixed yet:
  - Writes from another device, or from the CLI, can still race a browser tab.
  - A move in one tab is not yet refused as "being moved" in the app's other tabs. A second move, or a delete, of
    the same file or folder from another tab while the move is writing can still leave it named in two places, or
    purge it.
  - A request that never finishes holds its folder's lock: until it fails or the tab is closed, the other tabs'
    saves into that folder fail with `VfsConflictError` after 30 seconds each, and that tab's own later writes of
    the folder wait behind it.
  - A file's version history is still last-writer-wins between tabs.
```

Then, under `## Unreleased` → `### Changed`, after Task 2's bullet, add:

```markdown
- **`VfsNamespaceDeps`, `OfflineManagerDeps` and the `OutboundQueue` constructor take new optional members:**
  `coordinator`, `locks`, and a second `options` argument. `Client` fills them in a browser tab. Their types are
  internal, and code that builds these objects itself can leave them out, which keeps the previous behaviour.
```

- [ ] **Step 9: Checkpoint for Matt (no commit)**

Run: `sh <scratchpad>/w1-baseline/changed.sh`

Expected: every file of Tasks 1-5, plus `src/core/Client.ts`, `src/core/crossTab.ts`, `tests/core/crossTab.test.ts` and `tests/client/tabs.test.ts`, then `released CHANGELOG sections: unchanged`. Report RED, GREEN, the build checks and the mutation results. Do not stage, commit or stash.

---

### Task 7: Cross-tab move coordination

Matt asked for this in W1 on 2026-10-03: Decision 9's sketch of a lock per moving entry. Task 1 made a move hold its entry in `inMotion`, so that a second move or a delete of it in the same namespace is refused. This task does the same for every tab on the device, with one Web Lock per entry, `muhkoo:vfs:<commitment>:moving:<entryId>` (Decision 10). Matt signed off the design on 2026-10-04, with the destination's shared lock added (Step 0). What was worked out after his answer was ruled on by the controller (ledger W-8) and is reported to him at Step 16:
- `rename` holds the lock of the entry it moves for exactly as long as the entry is in `inMotion`: from before its mark until it has taken the entry from where it was.
- `rename` also holds, in shared mode and for the same window, the lock of the folder it moves into and of every folder above that one but the root.
  - Other moves share them.
  - A delete holds its target's lock exclusively, and the target is on the way to any folder inside it. So a move into a folder being deleted, or into one inside it, and the delete refuse each other, even when the folder is too new for the delete to have read it.
  - Once the move holds them, it looks the folder up again, and stops before its mark if a delete took it, or a folder above it, away meanwhile.
  - No move takes the root's lock.
- `delete` holds the lock of its target and of every entry it read below it. It takes them after its reads and holds them until it has let go of everything, the purge included.
- Every one of these locks is taken with `ifAvailable`. When another holder has it, in this tab or another, the move or delete refuses with `VfsConflictError` and changes nothing. Nothing waits for one. The browser lets go of a tab's locks when the tab goes.
- A tab that has just let go of a lock asks for it again only once the browser has let go of it too, so a move or delete straight after another of the same entry is not refused by the tab's own lock (Step 11).
- With a coordinator, a recursive delete also refuses when a record below names an entry it did not read. That entry's lock is not held, so nothing would stop another tab moving it out while the delete purges it.
- Without a coordinator (Node, the CLI, Workers), nothing changes: `inMotion` is all there is, as after Task 1, the two re-checks its fix round put in `delete`'s detach edit included (I-1).

This table covers Decision 9's three races, the residual Matt closed on 2026-10-04, and one more race found while closing it. It says what closes each:

| Race | Closed by | Pinned by |
|---|---|---|
| A second move of the entry in tab B finishes tab A's move as an interrupted one | `rename` holds the entry's lock | "refuses a second move, in another tab…", "refuses a rename in place, in another tab…" |
| A delete of it in tab B, or a recursive delete of a folder holding it, lets go of what A's move is about to name elsewhere | `delete` holds its target's lock and every read entry's | "refuses to delete, in another tab, a file…", "…a folder the first tab is still moving…", "…a folder holding something the first tab is still moving" |
| A recursive delete in one tab, and a move out of that folder in another tab that lands inside the delete's own write | the delete holds those locks through its parent's write and its purge, and refuses an entry named below since it read it | "refuses a move, in another tab, of something in a folder this tab is deleting…", "refuses a move of something a delete in another tab is still purging…", "refuses to delete a folder another tab saved into since the delete read it…" |
| A move into a folder that another tab is deleting, or into a new folder inside it, puts what it moves in a record the delete purges: in no listing, its content kept | `rename` holds, shared, the lock of the folder it moves into and of every folder above it but the root, and `delete` holds its target's exclusively; a move that gets them after a delete has finished looks the way to the folder up again | "refuses a move into a folder another tab is deleting…", "refuses a move into a folder it makes inside a folder another tab is deleting", "refuses to delete a folder another tab is moving something into…", "refuses a move into a folder another tab deleted after the move found it…", "…replaced after the move found it". The shared mode: "lets two tabs move files into one folder at the same time" |
| Two moves in two tabs, each of a folder into something below the other, both land: each folder ends up inside the other, and the root names neither | each `rename` holds its entry's lock exclusively and the folders on its way shared, so the second to ask is refused | "refuses one of two moves, in two tabs, that would each put a folder below the other" |

What the lock does not close is listed in Decision 9.

**Context outside this section.** A session given only this task also needs Decisions 3, 6, 9 and 10 above. It also needs Task 3, Step 14, which created `<scratchpad>/one-tab.ts` and `<scratchpad>/vitest.one-tab.config.mts`. Step 13 below replaces the first and reuses the second: if that config is missing, create it from Task 3, Step 14 first, unchanged.

**Files:**
- Modify: `src/vfs/coordinator.ts`: the module doc, and a `holdMoving(id, shared?)` member at the end of `VfsCoordinator`.
- Modify: `src/vfs/VfsNamespace.ts`:
  - a module helper `heldElsewhere`, after `beingMoved`;
  - the `inMotion` field's doc;
  - `rename`: the move lock around the in-motion window, and the locks of the destination folder and of every folder above it but the root, shared, with a second look at the way to that folder once they are held;
  - `delete`: the move locks around the detach and the purge, held for its target and for Task 1's `ids`. No new set: `ids` is every id it read below the target. Task 1's two `inMotion` re-checks stay in the detach edit;
  - `currentSubtree`: a `held` parameter. A new `holdAll` method goes directly after it. `delete` uses it, and so does `rename`, for the shared holds.
- Modify: `src/core/crossTab.ts`: `mode` in `LockManagerLike`'s options, `vfsCoordinator`'s doc, a `leaving` map, and a `holdMoving` member.
- Modify: `tests/vfs/cross-tab.test.ts`: the `VfsNotFoundError` import, move locks in the fake `device()` (shared ones too), six helpers, and two new `describe` blocks.
- Modify: `tests/core/crossTab.test.ts`: shared locks in `fakeWebLocks`, and six tests.
- Modify: `CHANGELOG.md`, `## Unreleased` only:
  - a new `### Fixed` bullet after Task 1's;
  - the last sentence of Task 1's bullet;
  - one of the "Not fixed yet" lines of Task 6's bullet.
- Modify, in the scratchpad only: `one-tab.ts` (Step 13).

**Interfaces:**
- Consumes:
  - from Task 1: `inMotion`, `beingMoved`, `SubtreeShape`, `namedIn`, and `subtree(...)`'s `ids` and `shape`. Also `currentSubtree(dirs, shape)`. And, from its fix round (I-1), `delete`'s `let ids` beside `shape`, and the two `inMotion` re-checks in its detach edit.
  - from Task 3: `VfsCoordinator`, `VfsNamespaceDeps.coordinator`, and `nextTurn`, already imported from `./bounds`. In `tests/vfs/cross-tab.test.ts`: `device()`, `twoTabs()`, `stored`, `names`, `recordKey` and `holdPut`. `failNextGet` is used only as the place the new helpers go after (Step 1(b)): the new tests do not call it. They call the helpers Step 1 adds, `failNextPut`, `holdGet`, `holdDelete`, `written`, `holdLockRequest` and `outcome`.
  - from Task 6: `vfsCoordinator`. In `tests/core/crossTab.test.ts`: `fakeWebLocks`, `inABrowserTab` and `tick`.
  - already in `VfsNamespace.ts` before W1: `ROOT_ID`, `openChain` (a folder and the id of every folder on the way to it, root first), `changedMeanwhile` and `VfsNotFoundError`. `rename`'s holds on the way to its destination, and its second look, use them.
- Produces:
  ```ts
  // src/vfs/coordinator.ts: a new, required member of VfsCoordinator
  holdMoving(id: string, shared?: boolean): Promise<(() => void) | null>;
  // src/vfs/VfsNamespace.ts
  function heldElsewhere(path: string, inside?: boolean): VfsConflictError;
  private currentSubtree(dirs: OpenDir[], shape: SubtreeShape, held?: ReadonlySet<string>): OpenDir[] | null;
  private holdAll(coordinator: VfsCoordinator, ids: Iterable<string>, shared?: boolean): Promise<(() => void) | null>;
  ```
  - In a browser, the lock is `muhkoo:vfs:<commitment>:moving:<entryId>`, requested with `{ ifAvailable: true, mode: "exclusive" }`, or with `mode: "shared"` when a move holds the folders on the way to where it moves.
  - Every object that implements `VfsCoordinator` needs `holdMoving` from here on: `vfsCoordinator` (Step 11), the fake in `tests/vfs/cross-tab.test.ts` (Step 1) and the scratchpad `one-tab.ts` (Step 13).
  - `tsc` checks only the first of these: `tsconfig.json` excludes `tests/`. A fake without it fails at run time with `coordinator.holdMoving is not a function`.

- [x] **Step 0: Gate — satisfied for what Matt answered on 2026-10-04. What was worked out after his answer is not signed off by him: the controller ruled on it (ledger W-8), and Step 16 reports it to him.** This step is the record of both, kept apart. It does not block: go on to Step 1.

  **What he was asked, and signed off** (the gate as it stood then, quoting Decisions 9 and 10):
  - how the lock is held (Decision 10):
    - a move holds its entry's lock for its whole `inMotion` window, a rename within one folder included;
    - a delete holds the lock of its target and of every entry it read below it, from after its reads until its purge is done;
    - with a coordinator, a recursive delete also refuses when a record below names an entry it did not read;
  - the cost: a recursive delete asks for one lock per entry it read, all at once. A cycle below the target that points back at a folder above it makes moves of that folder refuse for the length of the delete;
  - the outcomes that change within one tab, in a browser. None is a loss, but apps that branch on error names see each one:
    - of two deletes of one file or folder at once, the second fails with `VfsConflictError` ("being moved or deleted"), not `VfsNotFoundError`;
    - a rename of something a delete in the same tab is deleting can fail with `VfsConflictError` ("being moved or deleted");
    - a recursive delete racing a save into the folder fails with `VfsConflictError`, where without the lock the saved file was purged with the rest;
    - Cloud Drive's Trash takes `VfsNotFoundError` from a delete to mean "already gone" (`src/lib/trash.ts`). The IDE's `VfsMirror` gives up on any move or delete refused with `VfsConflictError` and shows its "refused" banner (`isTransient`). W1 changes neither app: the Production section passes this on;
  - what the lock does not close, shipping as the CHANGELOG lists it (Decision 9), as the list then stood:
    - a move or a save into a folder that another tab is deleting at that moment, which leaks storage;
    - a late announcement, which the delete's one-turn yield only narrows;
    - a frozen tab, which keeps an entry's lock until it resumes or closes;
    - two tabs deleting overlapping folders at once, which can both fail;
    - other devices and the CLI.

  **His answer:** yes, with one change. That list's first item proposed a fix, and he asked for it for moves:
  - a move also holds its destination folder's lock in shared mode, and a delete keeps taking its locks exclusively;
  - so a move into a folder that another tab is deleting is refused, and moves come off that item;
  - saves stay on it.

  **Worked out after his answer, while building that change. Not signed off by Matt: the controller ruled on each (ledger W-8), and Step 16 reports them to him** (Decisions 9 and 10):
  - **The folder alone was not enough, so a move holds every folder on the way to its destination but the root,** all shared.
    - A folder that is new since the delete read the tree is not among the locks the delete holds. That covers a folder made by the move's own `mkdir -p` inside the one being deleted, and one saved there by another tab. A move into it still ended up in no listing.
    - The cost: a move or rename of any folder on the way is refused, in any tab, while the move is writing.
    - It also refuses one of two moves that would each put a folder below the other.
  - **When the locks are taken,** after `mkdir` and before the mark, and **that the root's never is**.
  - **The second look.** Once it holds the locks, the move looks up the way to the folder again. If the folder is gone it fails with `VfsNotFoundError`; if the folder or anything on the way was replaced, it fails with "was changed by another write". Either way it has moved nothing; folders its own `mkdir -p` made stay, empty.
  - **Three more outcomes within one tab** (Decision 10, the fourth to the sixth):
    - a move or rename of a folder, or of one above it, while a move into it is writing;
    - a move into a folder, or below one, that a delete in the same tab holds;
    - a move into a folder, or below one, that a move in the same tab is moving.
  - **The list above, as it now stands** (Decision 9):
    - moves are off its first item;
    - a frozen tab also keeps its share of the folders on its way;
    - what a late announcement leaves at a move's or a delete's check, which nothing logs;
    - a delete of the folder while a move clears its mark there, which can leave one record until a sweep;
    - two moves that each go into what the other is moving, which can both fail;
    - and, not about tabs and not new in W1, a cycle that two moves at once can make in Node and the CLI.

  Tasks 1 to 6 did not depend on this answer. Task 8's moves check does, and its M3 checks the shared lock in Brave.

- [ ] **Step 1: Write the failing tests.** In `tests/vfs/cross-tab.test.ts`, make three changes.

(a) Import `VfsNotFoundError`, and give the fake device its move locks, shared ones included. Replace:

```ts
import { dirKey, VfsConflictError } from "../../src/vfs/types";
```

with:

```ts
import { dirKey, VfsConflictError, VfsNotFoundError } from "../../src/vfs/types";
```

then replace:

```ts
function device() {
    const tails = new Map<string, Promise<void>>();
    const tabs = new Set<TabState>();
    return {
```

with:

```ts
function device() {
    const tails = new Map<string, Promise<void>>();
    const tabs = new Set<TabState>();
    // Each entry's move lock: held by one, or shared by any number that ask
    // for it shared. Taken only if free.
    const moving = new Map<string, { shared: boolean; holders: number }>();
    return {
```

and replace:

```ts
                listen() {
                    if (me.listening) return;
                    me.listening = true;
                    hear(null);
                },
            };
```

with:

```ts
                listen() {
                    if (me.listening) return;
                    me.listening = true;
                    hear(null);
                },
                async holdMoving(id, shared = false) {
                    const now = moving.get(id);
                    if (now && !(shared && now.shared)) return null;
                    const lock = now ?? { shared, holders: 0 };
                    lock.holders++;
                    moving.set(id, lock);
                    let held = true;
                    return () => {
                        if (!held) return;
                        held = false;
                        if (--lock.holders === 0 && moving.get(id) === lock) moving.delete(id);
                    };
                },
            };
```

(b) Add the helpers. Directly above `describe("VFS — two tabs of one device", () => {`, after `failNextGet`, add:

```ts
/** Fail the next write of `key`, as a dropped connection does. */
function failNextPut(store: Store, key: string): void {
    const put = store.put.bind(store);
    let failed = false;
    store.put = async (k: string, value: unknown) => {
        if (k === key && !failed) {
            failed = true;
            throw new Error("network");
        }
        return put(k, value);
    };
}

/**
 * Hold back the next read of `key` once it has read the store, as a slow
 * response is held up: it answers with what was stored when it was asked.
 */
function holdGet(store: Store, key: string) {
    const get = store.get.bind(store);
    let held = false;
    let reached!: () => void;
    let go!: () => void;
    const holding = new Promise<void>((resolve) => (reached = resolve));
    const released = new Promise<void>((resolve) => (go = resolve));
    store.get = async (k: string) => {
        if (k !== key || held) return get(k);
        held = true;
        const value = await get(k);
        reached();
        await released;
        return value;
    };
    return { holding, release: () => go() };
}

/** Hold back the first delete of `key`, as a slow request is held up. */
function holdDelete(store: Store, key: string) {
    const remove = store.delete.bind(store);
    let held = false;
    let reached!: () => void;
    let go!: () => void;
    const holding = new Promise<void>((resolve) => (reached = resolve));
    const released = new Promise<void>((resolve) => (go = resolve));
    store.delete = async (k: string) => {
        if (k === key && !held) {
            held = true;
            reached();
            await released;
        }
        return remove(k);
    };
    return { holding, release: () => go() };
}

/** Every key written from here on, in order. */
function written(store: Store): string[] {
    const put = store.put.bind(store);
    const keys: string[] = [];
    store.put = async (k: string, value: unknown) => {
        keys.push(k);
        return put(k, value);
    };
    return keys;
}

/** Hold back `tab`'s next request for the move lock of `id`, before it is made. */
function holdLockRequest(tab: { coordinator: VfsCoordinator }, id: string) {
    const hold = tab.coordinator.holdMoving.bind(tab.coordinator);
    let held = false;
    let reached!: () => void;
    let go!: () => void;
    const asking = new Promise<void>((resolve) => (reached = resolve));
    const released = new Promise<void>((resolve) => (go = resolve));
    tab.coordinator.holdMoving = async (asked: string, shared?: boolean) => {
        if (asked === id && !held) {
            held = true;
            reached();
            await released;
        }
        return hold(asked, shared);
    };
    return { asking, release: () => go() };
}

/** A promise's outcome, without waiting on it here: "done", or what it threw. */
function outcome(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(() => "done", (err: unknown) => err);
}
```

(c) Append these two `describe` blocks at the end of the file:

```ts
describe("VFS — a move in one tab, and a move or delete of the same thing in another", () => {
    it("refuses a second move, in another tab, of a file the first tab is still moving", async () => {
        // b found the file marked - by a's move, still writing - took the
        // mark for an interrupted move, and finished it: the file ended up
        // named in /b and /c, with one content reference between them.
        const { store, content, a, b } = twoTabs();
        await a.writeFile("/a/f.txt", "f");
        await a.mkdir("/b");
        await a.mkdir("/c");
        await b.walk("/");
        const attach = holdPut(store, await recordKey(a, "/b"), 1);   // a's move putting it in /b

        const move = outcome(a.rename("/a/f.txt", "/b/f.txt"));
        await attach.holding;                     // /a/f.txt marked, and b has heard
        const second = await outcome(b.rename("/a/f.txt", "/c/f.txt"));
        attach.release();

        expect(second).toBeInstanceOf(VfsConflictError);
        expect(await move).toBe("done");
        const s = stored(store, content);
        expect(await s.walk("/")).toEqual(["/b/f.txt"]);
        expect(await s.readText("/b/f.txt")).toBe("f");
    });

    it("refuses a rename in place, in another tab, of a file the first tab is moving elsewhere", async () => {
        // b's rename found the file marked and took it, mark and all: renamed
        // in /a while a put it in /b, one file named in two places.
        const { store, content, a, b } = twoTabs();
        await a.writeFile("/a/f.txt", "f");
        await a.mkdir("/b");
        await b.walk("/");
        const attach = holdPut(store, await recordKey(a, "/b"), 1);

        const move = outcome(a.rename("/a/f.txt", "/b/f.txt"));
        await attach.holding;
        const renamed = await outcome(b.rename("/a/f.txt", "/a/g.txt"));
        attach.release();

        expect(renamed).toBeInstanceOf(VfsConflictError);
        expect(await move).toBe("done");
        expect(await stored(store, content).walk("/")).toEqual(["/b/f.txt"]);
    });

    it("refuses to delete, in another tab, a file the first tab is still moving, rather than letting go of its content", async () => {
        // b found the file marked, looked for its other half - which a had
        // not yet put in /b - found none, and let go of its content: a then
        // named it in /b with nothing behind it.
        const { store, content, a, b } = twoTabs();
        await a.writeFile("/a/f.txt", "f");
        await a.mkdir("/b");
        await b.walk("/");
        const attach = holdPut(store, await recordKey(a, "/b"), 1);

        const move = outcome(a.rename("/a/f.txt", "/b/f.txt"));
        await attach.holding;
        const del = await outcome(b.delete("/a/f.txt"));
        attach.release();

        expect(del).toBeInstanceOf(VfsConflictError);
        expect(await move).toBe("done");
        const s = stored(store, content);
        expect(await s.walk("/")).toEqual(["/b/f.txt"]);
        expect(await s.readText("/b/f.txt")).toBe("f");
    });

    it("refuses to delete, in another tab, a folder the first tab is still moving, rather than purging it from its new place", async () => {
        const { store, content, a, b } = twoTabs();
        await a.writeFile("/a/d/f.txt", "f");
        await a.mkdir("/b");
        await b.walk("/");
        const attach = holdPut(store, await recordKey(a, "/b"), 1);

        const move = outcome(a.rename("/a/d", "/b/d"));
        await attach.holding;
        const del = await outcome(b.delete("/a/d", { recursive: true }));
        attach.release();

        expect(del).toBeInstanceOf(VfsConflictError);
        expect(await move).toBe("done");
        const s = stored(store, content);
        expect(await s.walk("/")).toEqual(["/b/d/f.txt"]);
        expect(await s.readText("/b/d/f.txt")).toBe("f");
    });

    it("refuses to delete, in another tab, a folder holding something the first tab is still moving", async () => {
        const { store, content, a, b } = twoTabs();
        await a.writeFile("/a/d/f.txt", "f");
        await a.writeFile("/a/g.txt", "g");
        await a.mkdir("/b");
        await b.walk("/");
        const attach = holdPut(store, await recordKey(a, "/b"), 1);

        const move = outcome(a.rename("/a/d", "/b/d"));
        await attach.holding;
        const del = await outcome(b.delete("/a", { recursive: true }));
        attach.release();

        expect(del).toBeInstanceOf(VfsConflictError);
        expect(await move).toBe("done");
        const s = stored(store, content);
        expect(await s.walk("/")).toEqual(["/a/g.txt", "/b/d/f.txt"]);
        expect(await s.readText("/b/d/f.txt")).toBe("f");
        // Refused, it let go of the locks it did get: tried again, it works.
        await b.delete("/a", { recursive: true });
        expect(await stored(store, content).walk("/")).toEqual(["/b/d/f.txt"]);
    });

    it("refuses a move, in another tab, of something in a folder this tab is deleting, rather than purging it from where the move put it", async () => {
        // a had checked /a and was writing / without it when b - which had
        // not heard of the delete yet - moved /a/d out. a then purged every
        // record it had read, /a/d's among them, and let go of f.txt's
        // content: /b/d named a record that no longer existed.
        const { store, content, a, b } = twoTabs();
        await a.writeFile("/a/d/f.txt", "f");
        await a.mkdir("/b");
        await b.walk("/");
        const detach = holdPut(store, await recordKey(a, "/"), 1);   // a's write of / without /a

        const del = outcome(a.delete("/a", { recursive: true }));
        await detach.holding;
        const move = await outcome(b.rename("/a/d", "/b/d"));
        detach.release();

        expect(move).toBeInstanceOf(VfsConflictError);
        expect(await del).toBe("done");
        const s = stored(store, content);
        expect(await names(s, "/")).toEqual(["b"]);
        expect(await names(s, "/b")).toEqual([]);
    });

    it("refuses a move of something a delete in another tab is still purging, from a tab that has not heard of the delete yet", async () => {
        // The delete holds its locks until it has let go of everything, not
        // only until its parent is written: a tab that has not yet heard of
        // that write still finds /a/d where it was, and moved it out of
        // records that were being purged.
        const { store, content, a, b, B } = twoTabs();
        await a.writeFile("/a/d/f.txt", "f");
        await a.mkdir("/b");
        await b.walk("/");
        B.delay();                                // what a announces reaches b late
        const purge = holdDelete(store, await recordKey(a, "/a/d"));   // a purging /a/d's record

        const del = outcome(a.delete("/a", { recursive: true }));
        await purge.holding;                      // / written without /a; the purge under way
        const move = await outcome(b.rename("/a/d", "/b/d"));
        purge.release();
        B.deliver();

        expect(move).toBeInstanceOf(VfsConflictError);
        expect(await del).toBe("done");
        expect(await names(stored(store, content), "/b")).toEqual([]);
    });

    it("refuses to delete a folder another tab saved into since the delete read it, rather than letting go of a file then moved out", async () => {
        // b saved g.txt into /a/d after a's delete had read /a/d, and a read
        // /a/d again - b's write announced - before it checked it. So a
        // purged g.txt with the rest without holding g.txt's move lock: b
        // moved it to /b while a was writing /, and a let go of its content.
        const { store, content, a, b } = twoTabs();
        await a.writeFile("/a/d/f.txt", "f");
        await a.mkdir("/b");
        await b.walk("/");
        const folder = await recordKey(a, "/a/d");
        const root = await recordKey(a, "/");
        await b.writeFile("/a/d/e.txt", "e");     // heard: a reads /a/d from the store next
        const read = holdGet(store, folder);
        const detach = holdPut(store, root, 1);

        const del = outcome(a.delete("/a", { recursive: true }));
        await read.holding;                       // a has read /a/d, without g.txt
        await b.writeFile("/a/d/g.txt", "g");
        read.release();
        await Promise.race([del, detach.holding]);   // refused - or checked, and writing /
        await b.rename("/a/d/g.txt", "/b/g.txt");
        detach.release();

        expect(await del).toBeInstanceOf(VfsConflictError);
        const s = stored(store, content);
        expect(await s.readText("/b/g.txt")).toBe("g");
        expect(await s.readText("/a/d/f.txt")).toBe("f");
    });

    it("lets another tab delete a file a move of it left marked when the move failed part way", async () => {
        // The move's lock goes when the move does, failed or not: kept, the
        // file could not be moved or deleted in any tab again.
        const { store, content, a, b } = twoTabs();
        await a.writeFile("/a/f.txt", "f");
        await a.mkdir("/b");
        await b.walk("/");
        failNextPut(store, await recordKey(a, "/b"));   // a's move cannot put it in /b

        await expect(a.rename("/a/f.txt", "/b/f.txt")).rejects.toThrow("network");
        await b.delete("/a/f.txt");

        const s = stored(store, content);
        expect(await s.walk("/")).toEqual([]);
        expect(await names(s, "/")).toEqual(["a", "b"]);
    });

    it("passes on a move lock the browser will not give a delete, and lets go of the ones it was given", async () => {
        // A browser can refuse a lock request outright, as in a document that
        // is no longer fully active. The delete fails with that, not as if
        // another tab held the lock, and keeps none of the locks it did get:
        // kept, nothing in the folder could be moved or deleted in any tab.
        const { store, content, a, b, B } = twoTabs();
        await a.writeFile("/a/d/f.txt", "f");
        await a.mkdir("/b");
        await b.walk("/");
        const folder = ((await (b as any).openDir("/a/d")) as { id: string }).id;
        const refusal = new DOMException("the document is not fully active", "InvalidStateError");
        const hold = B.coordinator.holdMoving.bind(B.coordinator);
        B.coordinator.holdMoving = (id: string) => (id === folder ? Promise.reject(refusal) : hold(id));

        await expect(b.delete("/a", { recursive: true })).rejects.toBe(refusal);
        expect(await stored(store, content).walk("/")).toEqual(["/a/d/f.txt"]);
        await a.rename("/a/d/f.txt", "/b/f.txt");
        await a.delete("/a", { recursive: true });
        expect(await stored(store, content).walk("/")).toEqual(["/b/f.txt"]);
    });
});

describe("VFS — a move into a folder, and a delete of that folder in another tab", () => {
    it("refuses a move into a folder another tab is deleting, rather than putting what it moves where nothing names it", async () => {
        // a had checked /b/d and was writing /b without it when b moved f.txt
        // into /b/d. a then purged /b/d's record, and f.txt's entry with it:
        // f.txt was in no listing, and its content was still stored.
        const { store, content, a, b } = twoTabs();
        await a.writeFile("/a/f.txt", "f");
        await a.writeFile("/b/d/g.txt", "g");
        await b.walk("/");
        const detach = holdPut(store, await recordKey(a, "/b"), 1);   // a's write of /b without /b/d

        const del = outcome(a.delete("/b/d", { recursive: true }));
        await detach.holding;
        const move = await outcome(b.rename("/a/f.txt", "/b/d/f.txt"));
        detach.release();

        expect(move).toBeInstanceOf(VfsConflictError);
        expect(await del).toBe("done");
        const s = stored(store, content);
        expect(await s.walk("/")).toEqual(["/a/f.txt"]);
        expect(await s.readText("/a/f.txt")).toBe("f");
        // Nothing stored that nothing names: g.txt's content is let go of.
        expect([...content.blobs.values()].map((blob) => new TextDecoder().decode(blob.bytes))).toEqual(["f"]);
    });

    it("refuses a move into a folder it makes inside a folder another tab is deleting", async () => {
        // /b/d/e is new: b's move made it, inside /b/d, after a had read
        // /b/d. So a did not hold its lock, and a move holding that folder
        // alone went ahead: a then purged /b/d's record, and f.txt was in no
        // listing, its content still stored. /b/d is on the way to /b/d/e.
        const { store, content, a, b } = twoTabs();
        await a.writeFile("/a/f.txt", "f");
        await a.writeFile("/b/d/g.txt", "g");
        await b.walk("/");
        const detach = holdPut(store, await recordKey(a, "/b"), 1);   // a's write of /b without /b/d

        const del = outcome(a.delete("/b/d", { recursive: true }));
        await detach.holding;
        const move = await outcome(b.rename("/a/f.txt", "/b/d/e/f.txt"));
        detach.release();

        expect(move).toBeInstanceOf(VfsConflictError);
        expect(await del).toBe("done");
        const s = stored(store, content);
        expect(await s.walk("/")).toEqual(["/a/f.txt"]);
        expect(await s.readText("/a/f.txt")).toBe("f");
        expect([...content.blobs.values()].map((blob) => new TextDecoder().decode(blob.bytes))).toEqual(["f"]);
    });

    it("refuses to delete a folder another tab is moving something into, and deletes both once the move is done", async () => {
        // a read /b/d before b's move had put f.txt there, and purged it: b
        // then named f.txt in a record that nothing names.
        const { store, content, a, b } = twoTabs();
        await a.writeFile("/a/f.txt", "f");
        await a.writeFile("/b/d/g.txt", "g");
        await b.walk("/");
        const attach = holdPut(store, await recordKey(a, "/b/d"), 1);   // b's move putting f.txt in /b/d

        const move = outcome(b.rename("/a/f.txt", "/b/d/f.txt"));
        await attach.holding;
        const del = await outcome(a.delete("/b/d", { recursive: true }));
        attach.release();

        expect(del).toBeInstanceOf(VfsConflictError);
        expect(await move).toBe("done");
        expect(await stored(store, content).walk("/")).toEqual(["/b/d/f.txt", "/b/d/g.txt"]);
        // Refused, it changed nothing: tried again once the move is done, it takes both.
        await a.delete("/b/d", { recursive: true });
        expect(await stored(store, content).walk("/")).toEqual([]);
        expect(content.blobs.size).toBe(0);
    });

    it("lets two tabs move files into one folder at the same time", async () => {
        // Each move holds the folder's lock shared, so neither refuses the other.
        const { store, content, a, b } = twoTabs();
        await a.writeFile("/a/f.txt", "f");
        await a.writeFile("/b/g.txt", "g");
        await a.mkdir("/d");
        await b.walk("/");
        const mark = holdPut(store, await recordKey(a, "/b"), 1);   // b marking g.txt, its locks held

        const second = outcome(b.rename("/b/g.txt", "/d/g.txt"));
        await mark.holding;
        const first = await outcome(a.rename("/a/f.txt", "/d/f.txt"));
        mark.release();

        expect(first).toBe("done");
        expect(await second).toBe("done");
        const s = stored(store, content);
        expect(await s.walk("/")).toEqual(["/d/f.txt", "/d/g.txt"]);
        expect(await s.readText("/d/g.txt")).toBe("g");
    });

    it("refuses one of two moves, in two tabs, that would each put a folder below the other", async () => {
        // a moved /p/x into /q/d/e while b moved /q/d into /p/x/y. Each held
        // only the folder it went into, so neither refused the other: x ended
        // up below d and d below x, and neither was in any listing.
        const { store, content, a, b } = twoTabs();
        await a.writeFile("/p/x/y/k.txt", "k");
        await a.mkdir("/q/d/e", { recursive: true });
        await b.walk("/");
        const attach = holdPut(store, await recordKey(a, "/q/d/e"), 1);   // a putting x in /q/d/e, its locks held

        const first = outcome(a.rename("/p/x", "/q/d/e/x"));
        await attach.holding;
        const second = await outcome(b.rename("/q/d", "/p/x/y/d"));
        attach.release();

        expect(second).toBeInstanceOf(VfsConflictError);
        expect(await first).toBe("done");
        const s = stored(store, content);
        expect(await s.walk("/")).toEqual(["/q/d/e/x/y/k.txt"]);
        expect(await s.readText("/q/d/e/x/y/k.txt")).toBe("k");
    });

    it("refuses a move into a folder another tab deleted after the move found it, and writes nothing", async () => {
        // The delete had finished, and let go of the folder's lock, by the
        // time the move asked for it: the move then marked f.txt, and wrote
        // again to take the mark off when it could not put f.txt there.
        const { store, content, a, b, B } = twoTabs();
        await a.writeFile("/a/f.txt", "f");
        await a.writeFile("/b/d/g.txt", "g");
        await b.walk("/");
        const folder = ((await (b as any).openDir("/b/d")) as { id: string }).id;
        const source = await recordKey(a, "/a");
        const asked = holdLockRequest(B, folder);   // b's move has found /b/d
        const keys = written(store);

        const move = outcome(b.rename("/a/f.txt", "/b/d/f.txt"));
        await Promise.race([asked.asking, move]);
        await a.delete("/b/d", { recursive: true });
        asked.release();

        expect(await move).toBeInstanceOf(VfsNotFoundError);
        expect(keys).not.toContain(source);
        expect(store.records.has(dirKey(folder))).toBe(false);
        const s = stored(store, content);
        expect(await s.walk("/")).toEqual(["/a/f.txt"]);
        expect(await names(s, "/b")).toEqual([]);
    });

    it("refuses a move into a folder another tab replaced after the move found it", async () => {
        // The lock the move holds is the old folder's. Put in the new one,
        // nothing would stop a delete of that one meanwhile.
        const { store, content, a, b, B } = twoTabs();
        await a.writeFile("/a/f.txt", "f");
        await a.writeFile("/b/d/g.txt", "g");
        await b.walk("/");
        const folder = ((await (b as any).openDir("/b/d")) as { id: string }).id;
        const asked = holdLockRequest(B, folder);

        const move = outcome(b.rename("/a/f.txt", "/b/d/f.txt"));
        await Promise.race([asked.asking, move]);
        await a.delete("/b/d", { recursive: true });
        await a.mkdir("/b/d");                     // another folder, of the same name
        asked.release();

        expect(await move).toBeInstanceOf(VfsConflictError);
        const s = stored(store, content);
        expect(await s.walk("/")).toEqual(["/a/f.txt"]);
        expect(await names(s, "/b/d")).toEqual([]);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/matt/GitHub/muhkoo/connect && npx vitest --run tests/vfs/cross-tab.test.ts`

Expected:
- 15 of the 17 new tests FAIL:
  - 13 with `AssertionError: expected 'done' to be an instance of VfsConflictError`: the second operation went through;
  - "refuses a move into a folder another tab deleted after the move found it…" with `AssertionError: expected 'done' to be an instance of VfsNotFoundError`: the move put the file in the folder before the delete took it;
  - "passes on a move lock the browser will not give a delete…" with `AssertionError: promise resolved "undefined" instead of rejecting`: the delete asked for no lock;
- 2 PASS. They are guards for Step 14:
  - "lets another tab delete a file a move of it left marked…", against a move that never lets go of its lock;
  - "lets two tabs move files into one folder at the same time", against a move that holds the folders on its way exclusively;
- Task 3's 15 tests still pass: 15 failed and 17 passed, of 32.

- [ ] **Step 3: Extend `VfsCoordinator`.** In `src/vfs/coordinator.ts`, replace:

```ts
 * the others which record was written while still holding it. `Client` builds
 * one from Web Locks and a BroadcastChannel in a browser tab (see
 * `core/crossTab.ts`); without one, writes are ordered within one namespace
 * only, as they always were.
 */
```

with:

```ts
 * the others which record was written while still holding it. It also gives
 * each file or folder being moved or deleted a lock, which a move or delete
 * of it elsewhere takes only if it is free, and refuses otherwise (see
 * `holdMoving`). `Client` builds one
 * from Web Locks and a BroadcastChannel in a browser tab (see
 * `core/crossTab.ts`); without one, writes are ordered within one namespace
 * only, as they always were.
 */
```

and replace the end of the interface:

```ts
     * nothing is read before this namespace can hear of a later write of it.
     */
    listen(): void;
}
```

with:

```ts
     * nothing is read before this namespace can hear of a later write of it.
     */
    listen(): void;
    /**
     * Hold the lock that says entry `id` - a file or a folder, by its id in
     * the tree - is being moved or deleted on this device, if no one holds
     * it. Never waits: resolves to null when another holder has it, in this
     * tab or another, and otherwise to the function that lets go of it. A
     * tab that dies lets go of everything it held. With no one signed in it
     * holds nothing, and resolves to a function that does nothing.
     *
     * `shared` holds a folder's lock as a place on the way to where a move
     * is putting something. Any number of shared holders hold it at once,
     * in any tab; a holder that is not shared cannot have it while they do,
     * nor they while it does.
     *
     * A move marks its entry before it puts it in its second place, and a
     * mark cannot tell a move still writing from one that was interrupted.
     * Another tab took the first for the second: it finished the move too,
     * naming the entry in two places, or let go of what the move was about
     * to put somewhere else. So a move holds this from before it marks until
     * it has taken the entry from where it was, a delete holds it for all it
     * is deleting, and either refuses when it cannot have it. A move also
     * holds the folder it is moving into, and every folder above that one,
     * shared, for as long: a move into a folder that another tab was
     * deleting put what it moved in a record the delete then purged. See
     * `VfsNamespace.rename` and `VfsNamespace.delete`.
     */
    holdMoving(id: string, shared?: boolean): Promise<(() => void) | null>;
}
```

- [ ] **Step 4: Add `heldElsewhere`, and note the lock in `inMotion`'s doc.** In `src/vfs/VfsNamespace.ts`, directly after the `beingMoved` function, add:

```ts
/**
 * Refuse an operation on `path` because a move or a delete of it - or,
 * `inside`, of it or of something in it - holds its move lock on this
 * device: in another tab of the app, or in this one. See
 * `VfsCoordinator.holdMoving`.
 */
function heldElsewhere(path: string, inside = false): VfsConflictError {
    const what = inside ? `${path}, or something in it, is` : `${path} is`;
    return new VfsConflictError(`${what} being moved or deleted in this app, in this tab or another; nothing was changed - try again once that has finished`);
}
```

In the `inMotion` field's doc comment, replace:

```ts
     * has taken it from where it was, and `rename` and `delete` refuse an
     * entry that is here - or, for a delete, a folder holding one.
     */
    private readonly inMotion = new Set<string>();
```

with:

```ts
     * has taken it from where it was, and `rename` and `delete` refuse an
     * entry that is here - or, for a delete, a folder holding one.
     *
     * This set is one namespace's. With a coordinator, a move also holds
     * the entry's move lock for every tab on the device, for as long as the
     * entry is here: see `VfsCoordinator.holdMoving`.
     */
    private readonly inMotion = new Set<string>();
```

- [ ] **Step 5: Hold the move locks in `rename`.** There are three replacements.

(a) Replace:

```ts
        const edit = (path: string, change: (node: DirNode, record: OpenDir) => boolean | void) =>
            this.openDir(path).then((dir) => this.mutate(dir, change));
        let unmarkLanded = false;
        try {
            if (entry.kind === "dir") {
                assertWritableDepth(dst);
```

with:

```ts
        const edit = (path: string, change: (node: DirNode, record: OpenDir) => boolean | void) =>
            this.openDir(path).then((dir) => this.mutate(dir, change));
        let unmarkLanded = false;
        // The same for every tab of the app on this device: the entry's move
        // lock, held for as long as it is in `inMotion`. Another tab's move
        // or delete of it holds it, and taking that move's mark for an
        // interrupted one named the entry in two places, or purged it. See
        // `VfsCoordinator.holdMoving`.
        let release: (() => void) | null = null;
        // And the locks of the folders on the way to where it goes, shared,
        // for as long. See below.
        let into: (() => void) | null = null;
        try {
            const coordinator = this.deps.coordinator;
            if (coordinator) {
                release = await coordinator.holdMoving(entry.id);
                if (!release) throw heldElsewhere(src);
            }
            if (entry.kind === "dir") {
                assertWritableDepth(dst);
```

(b) A few lines further down, in `rename`, replace:

```ts
            await this.mkdir(dirname(dst), { recursive: true });
            const dstParent = await this.openDir(dirname(dst));
            if (entryIn(dstParent.node, dstName)) throw new VfsConflictError(`${dst} already exists`);
```

with:

```ts
            await this.mkdir(dirname(dst), { recursive: true });
            const way = await this.openChain(dirname(dst));
            if (!way) throw new VfsNotFoundError(dirname(dst));
            let dstParent = way.dir;
            if (coordinator && dstParent.id !== ROOT_ID) {
                // The folder it goes into, and every folder above that one
                // but the root, held shared: other moves into any of them
                // share them, and a delete of one - which holds the lock of
                // its target and of everything it read below - holds it
                // alone. A move into a folder that another tab was deleting
                // put what it moved in a record the delete then purged: in no
                // listing, its content kept. Not that folder alone: it may be
                // new since the delete read the tree - made by the `mkdir`
                // above, or by another tab - and the delete does not hold a
                // lock it did not read. Its target's is on the way here. The
                // root is never deleted.
                into = await this.holdAll(coordinator, way.chain.slice(1), true);
                if (!into) throw heldElsewhere(dirname(dst));
                // A delete of one of them may have finished since they were
                // looked up, and announced its write of the folder above
                // before it let go of their locks: let that in, and look
                // again. Gone, or another folder anywhere on the way, the
                // move stops here, before its mark.
                await nextTurn();
                const again = await this.openChain(dirname(dst));
                if (!again) throw new VfsNotFoundError(dirname(dst));
                if (again.chain.some((id, i) => id !== way.chain[i])) throw changedMeanwhile(dirname(dst));
                dstParent = again.dir;
            }
            if (entryIn(dstParent.node, dstName)) throw new VfsConflictError(`${dst} already exists`);
```

(c) In its `finally`, replace:

```ts
            this.inMotion.delete(entry.id);
        }
        if (unmarkLanded) {
```

with:

```ts
            this.inMotion.delete(entry.id);
            release?.();
            into?.();
        }
        if (unmarkLanded) {
```

The new `await`s run only with a coordinator. A rename without one makes the same reads and writes, in the same order, as after Task 1: `openChain` is what `openDir` calls, and (b) calls it directly to have the way as well as the folder. In (b):
- `way.chain` is the root's id, then the id of every folder on the way, down to the one the move goes into. `slice(1)` leaves out the root: its lock is never taken. The root cannot be deleted, and only a delete below a cycle that points at the root ever holds its lock (Decision 10).
- Every folder on the way, not only the last. A delete holds its target's lock and the locks of what it read below it, and the folder the move goes into may be new since that read. The move's own `mkdir` may have made it inside the folder being deleted, or another tab may have. The delete's target is always on the way. Holding only the last folder let such a move land in a record the delete purged (Decision 10, "Not the folder alone"). Pinned by "refuses a move into a folder it makes inside a folder another tab is deleting".
- Shared, through `holdAll`, which Step 7 adds: asked for all at once, and refused as a whole, with nothing kept, when another holder has any of them exclusively. `heldElsewhere(dirname(dst))` names the folder it goes into. When a folder above it is the one being moved or deleted, so is this folder.
- A rename within one folder holds that folder and those above it too: it writes into it as a move into it does.
- The second look is for a delete that finished between `openChain` and the grant, when the locks were free again. That delete announced its write of the folder above its target before it let go of any lock. After one turn, this tab has heard of it unless the announcement came late (Decision 3). So `openChain` reads that folder again and does not find the way, or finds another folder somewhere on it. Both chains have one id per name in the path, so they are the same length, and comparing them id by id is enough.
- `dstParent = again.dir`: the checks below it look at the folder as it is now.

- [ ] **Step 6: Hold the move locks in `delete`.** There are two replacements. Task 1's fix round (I-1) already keeps the id of every entry `delete` read below its target, in `ids`, and re-checks it against `inMotion` in the detach edit. That is the set whose locks this step holds, so the step adds no set of its own, and both of Task 1's re-checks stay in the edit.

(a) Replace:

```ts
        // Every id found below the target, re-checked against `inMotion` at the detach.
        let ids: Set<string> = new Set();
```

with:

```ts
        // Every id found below the target: re-checked against `inMotion` at the
        // detach and, with a coordinator, whose move locks it holds. See below.
        let ids: Set<string> = new Set();
```

(b) Replace everything from `const elsewhere = moving ? …` to the end of the method:

```ts
        const elsewhere = moving ? await this.namedElsewhere(parent.id, name) : undefined;

        // The check in the edit below looks at each record to be purged as it
        // is then, which needs it to hand: a change reported meanwhile may
        // have dropped one from the cache. Read again, it is still checked
        // against what was read before.
        for (const dir of doomed) if (!this.editable(dir)) await this.reopen(dir);

        let purging = doomed;
        await this.mutate(parent, (node) => {
            // What is let go of below is what `entry` held. Gone since, it
            // was let go of already; replaced, the name holds something this
            // delete has not read. Marked since, a move of it has begun, and
            // what it holds is about to be named somewhere `elsewhere` did
            // not see - if it was looked for at all.
            const now = entryIn(node, name);
            if (!now) throw new VfsNotFoundError(target);
            if (!sameEntry(entry, now) || markedMeanwhile(entry, now)) throw changedMeanwhile(target);
            // Marked already when this delete read it, a move that has since
            // taken the entry - or something below it - would not mark it a
            // second time, so `markedMeanwhile` and `currentSubtree` would not
            // see it either. `inMotion` is live, not a snapshot, so it still
            // does: re-checked here, at the last moment before the detach.
            if (this.inMotion.has(entry.id)) throw beingMoved(target);
            for (const id of ids) if (this.inMotion.has(id)) throw beingMoved(target, true);
            // And what is purged is what the records below hold now - unless
            // something in them has been moved, or begun to move, since they
            // were read. See `currentSubtree`.
            const current = this.currentSubtree(doomed, shape);
            if (!current) throw changedMeanwhile(target);
            purging = current;
            delete node.entries[name];
        });

        if (elsewhere === null) {
            // Part of the tree cannot be read, so it is unknown whether the
            // other copy is in it. Keeping what may be its contents costs
            // storage until a sweep; letting go of them could lose them.
            this.warn(`detached ${target} but kept what it held: a move of it was interrupted, and part of the tree cannot be read to find the other copy`);
            return;
        }
        if (entry.kind === "dir") await this.purge(purging, elsewhere, opts.keepContent);
        else await this.letGo(new Map([[entry.id, [{ dir: parent, entry }]]]), elsewhere, opts.keepContent);
        if (elsewhere && entry.moving === true) await this.settle(entry.id, elsewhere);
    }
```

with:

```ts
        const elsewhere = moving ? await this.namedElsewhere(parent.id, name) : undefined;

        // On this device, the move lock of the target and of everything read
        // below it, held from here until what they held has been let go of.
        // A move in another tab holds the lock of what it moves until it has
        // taken it from where it was. A delete that found it marked looked
        // for its other half before the move had put it there, found none,
        // and let go of what the move then named in its new place; one that
        // was writing the parent let a move of something below start, and
        // then purged it. Held here, a move of any of it that is under way
        // refuses this delete, and none can start until it is done. What it
        // does not cover - anything named below since it was read - the check
        // in the edit refuses. See `VfsCoordinator.holdMoving`.
        const coordinator = this.deps.coordinator;
        const release = coordinator ? await this.holdAll(coordinator, [entry.id, ...ids]) : () => {};
        if (!release) throw heldElsewhere(target, ids.size > 0);
        try {
            // A move that let go of its lock just before this took it told the
            // other tabs what it wrote first: let that in before checking.
            if (coordinator) await nextTurn();

            // The check in the edit below looks at each record to be purged as it
            // is then, which needs it to hand: a change reported meanwhile may
            // have dropped one from the cache. Read again, it is still checked
            // against what was read before.
            for (const dir of doomed) if (!this.editable(dir)) await this.reopen(dir);

            let purging = doomed;
            await this.mutate(parent, (node) => {
                // What is let go of below is what `entry` held. Gone since, it
                // was let go of already; replaced, the name holds something this
                // delete has not read. Marked since, a move of it has begun, and
                // what it holds is about to be named somewhere `elsewhere` did
                // not see - if it was looked for at all.
                const now = entryIn(node, name);
                if (!now) throw new VfsNotFoundError(target);
                if (!sameEntry(entry, now) || markedMeanwhile(entry, now)) throw changedMeanwhile(target);
                // Marked already when this delete read it, a move that has since
                // taken the entry - or something below it - would not mark it a
                // second time, so `markedMeanwhile` and `currentSubtree` would not
                // see it either. `inMotion` is live, not a snapshot, so it still
                // does: re-checked here, at the last moment before the detach.
                if (this.inMotion.has(entry.id)) throw beingMoved(target);
                for (const id of ids) if (this.inMotion.has(id)) throw beingMoved(target, true);
                // And what is purged is what the records below hold now - unless
                // something in them has been moved, or begun to move, since they
                // were read; or, with a coordinator, named there since, as its
                // move lock is not held. See `currentSubtree`.
                const current = this.currentSubtree(doomed, shape, coordinator ? ids : undefined);
                if (!current) throw changedMeanwhile(target);
                purging = current;
                delete node.entries[name];
            });

            if (elsewhere === null) {
                // Part of the tree cannot be read, so it is unknown whether the
                // other copy is in it. Keeping what may be its contents costs
                // storage until a sweep; letting go of them could lose them.
                this.warn(`detached ${target} but kept what it held: a move of it was interrupted, and part of the tree cannot be read to find the other copy`);
                return;
            }
            if (entry.kind === "dir") await this.purge(purging, elsewhere, opts.keepContent);
            else await this.letGo(new Map([[entry.id, [{ dir: parent, entry }]]]), elsewhere, opts.keepContent);
            if (elsewhere && entry.moving === true) await this.settle(entry.id, elsewhere);
        } finally {
            release();
        }
    }
```

The `await nextTurn()` and the `holdAll` call run only with a coordinator. In (b):
- `ids` is what Task 1's fix round hoisted: `subtree`'s `ids`, set beside `doomed` and `shape`. It holds every entry read below the target, which is what the delete must hold. Before that fix round this step added the same set itself, as `below`.
- Task 1's two re-checks stay in the edit, before `currentSubtree`, unchanged but for their indentation. Without a coordinator they are all that refuses a move begun during the delete's awaits (I-1).
- With a coordinator, the locks refuse such a move first. A move under way holds its entry's lock, so `holdAll` refuses the delete. Once the delete holds them, a move that asks for one is refused.
- The re-checks can still fire with a coordinator, within one tab. A rename puts its entry in `inMotion` before it asks for the entry's lock. If the delete's detach edit runs while such a rename is still waiting for the answer, the delete refuses itself ("is being moved") and lets go of its locks. The rename is then refused, or, if its request comes after that, goes ahead. Nothing is lost either way (Decision 10, the first same-tab outcome).
- `currentSubtree` is given `ids` as `held` only with a coordinator (Step 7).

- [ ] **Step 7: Add `held` to `currentSubtree`, and add `holdAll`.** Replace the end of `currentSubtree`'s doc comment and the method itself:

```ts
     * Synchronous, for an edit. A record whose copy is not to hand counts as
     * changed.
     */
    private currentSubtree(dirs: OpenDir[], shape: SubtreeShape): OpenDir[] | null {
        const doomed = new Set(dirs.map((dir) => dir.id));
        const current: OpenDir[] = [];
        for (const dir of dirs) {
            const now = this.editable(dir);
            if (!now) return null;
            const read = shape.get(dir.id) ?? new Map<string, boolean>();
            const named = namedIn(now);
            for (const [id, marked] of named) if (marked && read.get(id) !== true) return null;
            for (const id of read.keys()) if (doomed.has(id) && !named.has(id)) return null;
            current.push(now);
        }
        return current;
    }
```

with the following, which also adds `holdAll` directly after it:

```ts
     * Synchronous, for an edit. A record whose copy is not to hand counts as
     * changed.
     *
     * `held`, with a coordinator, is every entry whose move lock the delete
     * holds. An entry named since the records were read - saved or moved in
     * - is not among them, so nothing stops another tab moving it out while
     * the delete writes the parent, and purging it then let go of what that
     * move had put somewhere else. So with `held`, that counts as changed
     * too, and the delete is tried again from the start.
     */
    private currentSubtree(dirs: OpenDir[], shape: SubtreeShape, held?: ReadonlySet<string>): OpenDir[] | null {
        const doomed = new Set(dirs.map((dir) => dir.id));
        const current: OpenDir[] = [];
        for (const dir of dirs) {
            const now = this.editable(dir);
            if (!now) return null;
            const read = shape.get(dir.id) ?? new Map<string, boolean>();
            const named = namedIn(now);
            for (const [id, marked] of named) if (marked && read.get(id) !== true) return null;
            for (const id of read.keys()) if (doomed.has(id) && !named.has(id)) return null;
            if (held) for (const id of named.keys()) if (!held.has(id)) return null;
            current.push(now);
        }
        return current;
    }

    /**
     * Hold the move lock of every entry in `ids` - see
     * `VfsCoordinator.holdMoving` - or of none: null when another holder has
     * any of them, and then nothing is held. Otherwise the function that
     * lets go of them all. Asked for all at once: none of them waits.
     * `shared` holds them as the folders a move goes into.
     */
    private async holdAll(coordinator: VfsCoordinator, ids: Iterable<string>, shared = false): Promise<(() => void) | null> {
        const tries = await Promise.allSettled([...new Set(ids)].map((id) => coordinator.holdMoving(id, shared)));
        const held = tries.flatMap((tried) => (tried.status === "fulfilled" && tried.value ? [tried.value] : []));
        const release = () => {
            for (const letGo of held) letGo();
        };
        const failed = tries.find((tried): tried is PromiseRejectedResult => tried.status === "rejected");
        if (failed) {
            release();
            throw failed.reason;
        }
        if (held.length < tries.length) {
            release();
            return null;
        }
        return release;
    }
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd /Users/matt/GitHub/muhkoo/connect && npx vitest --run tests/vfs/cross-tab.test.ts tests/vfs/write-order.test.ts` (5 times in a row)

Expected: all 70 pass every time: 32 in `cross-tab.test.ts` and 38 in `write-order.test.ts`, Task 1's two fix-round tests among them.

`yarn typecheck` fails until Step 11, with `src/core/crossTab.ts(…): error TS2322: … Property 'holdMoving' is missing in type …`. That is expected: the browser coordinator does not have `holdMoving` yet.

- [ ] **Step 9: Write the failing browser tests.** In `tests/core/crossTab.test.ts`, make two changes.

(a) Let the fake lock manager grant shared locks, as a browser does. Replace:

```ts
/** Web Locks as one browser grants them: one holder per name, the rest in order; `ifAvailable`; `signal`. */
function fakeWebLocks() {
    const tails = new Map<string, Promise<void>>();
    const held = new Set<string>();
    const asked: string[] = [];
    return {
        asked,
        async request<T>(
            name: string,
            options: { ifAvailable?: boolean; signal?: AbortSignal },
            callback: (lock: unknown) => Promise<T>,
        ): Promise<T> {
            asked.push(name);
            if (options.ifAvailable && (held.has(name) || tails.has(name))) return callback(null);
```

with:

```ts
/**
 * Web Locks as one browser grants them: one holder per name, the rest in
 * order; `ifAvailable`; `signal`; and `mode: "shared"`, for any number of
 * holders at once. Shared holds are asked for only with `ifAvailable`, as
 * the move locks are, so none waits here, and nothing waits for one.
 */
function fakeWebLocks() {
    const tails = new Map<string, Promise<void>>();
    const held = new Set<string>();
    const shared = new Map<string, number>();   // shared holders, by name
    const asked: string[] = [];
    return {
        asked,
        async request<T>(
            name: string,
            options: { ifAvailable?: boolean; signal?: AbortSignal; mode?: "exclusive" | "shared" },
            callback: (lock: unknown) => Promise<T>,
        ): Promise<T> {
            if (options.mode === "shared") {
                asked.push(`${name} (shared)`);
                if (!options.ifAvailable) throw new Error("this fake grants a shared lock only with ifAvailable");
                if (held.has(name) || tails.has(name)) return callback(null);
                shared.set(name, (shared.get(name) ?? 0) + 1);
                try {
                    return await callback({ name, mode: "shared" });
                } finally {
                    const left = shared.get(name)! - 1;
                    if (left > 0) shared.set(name, left);
                    else shared.delete(name);
                }
            }
            asked.push(name);
            if (options.ifAvailable && (held.has(name) || tails.has(name) || shared.has(name))) return callback(null);
```

The rest of `request`, where an exclusive request waits its turn, is unchanged. A waiting request does not wait for shared holders here: nothing in connect asks to wait for a name that is ever held shared.

(b) Directly above the test `it("drains only when no other tab is draining", …)`, add:

```ts
    it("holds an entry's move lock, muhkoo:vfs:<commitment>:moving:<id>, until it is let go, and no tab can have it meanwhile", async () => {
        const locks = inABrowserTab();
        const a = vfsCoordinator(() => "c1")!;
        const b = vfsCoordinator(() => "c1")!;
        try {
            const release = await a.holdMoving("e1");
            expect(release).toBeTypeOf("function");
            expect(await b.holdMoving("e1")).toBeNull();
            expect(await a.holdMoving("e1")).toBeNull();     // nor the same tab, a second time
            const other = await b.holdMoving("e2");
            expect(other).toBeTypeOf("function");
            release!();
            await tick();
            const after = await b.holdMoving("e1");
            expect(after).toBeTypeOf("function");
            after!();
            other!();
            expect(locks.asked).toEqual([
                "muhkoo:vfs:c1:moving:e1",
                "muhkoo:vfs:c1:moving:e1",
                "muhkoo:vfs:c1:moving:e1",
                "muhkoo:vfs:c1:moving:e2",
                "muhkoo:vfs:c1:moving:e1",
            ]);
        } finally {
            a.close();
            b.close();
        }
    });

    it("gives this tab an entry's move lock again straight after it let go of it, before the browser has", async () => {
        // The browser lets go of a lock only once the callback's promise has
        // settled. Asked for again at once - a move or a delete straight after
        // another of the same entry in this tab - it was still held, and this
        // tab's own lock refused it.
        const locks = inABrowserTab();
        const a = vfsCoordinator(() => "c1")!;
        try {
            const first = await a.holdMoving("e1");
            first!();
            const again = await a.holdMoving("e1");
            expect(again).toBeTypeOf("function");
            again!();
            expect(locks.asked).toEqual(["muhkoo:vfs:c1:moving:e1", "muhkoo:vfs:c1:moving:e1"]);
        } finally {
            a.close();
        }
    });

    it("holds no move lock when no one is signed in", async () => {
        const locks = inABrowserTab();
        const a = vfsCoordinator(() => null)!;
        try {
            expect(await a.holdMoving("e1")).toBeTypeOf("function");
            expect(await a.holdMoving("e1")).toBeTypeOf("function");
            expect(locks.asked).toEqual([]);
        } finally {
            a.close();
        }
    });

    it("passes on a move lock the browser refuses to give, rather than waiting for ever", async () => {
        vi.stubGlobal("window", {});
        const refusal = new DOMException("the document is not fully active", "InvalidStateError");
        vi.stubGlobal("navigator", { locks: { request: () => Promise.reject(refusal) } });
        const a = vfsCoordinator(() => "c1")!;
        try {
            await expect(a.holdMoving("e1")).rejects.toBe(refusal);
        } finally {
            a.close();
        }
    });

    it("shares a folder's move lock among moves into it, in one tab or two, and keeps it from a move or delete of the folder", async () => {
        const locks = inABrowserTab();
        const a = vfsCoordinator(() => "c1")!;
        const b = vfsCoordinator(() => "c1")!;
        try {
            const intoA = await a.holdMoving("d1", true);
            const intoB = await b.holdMoving("d1", true);
            const intoA2 = await a.holdMoving("d1", true);   // a second move into it, in the same tab
            expect([intoA, intoB, intoA2].map((release) => typeof release)).toEqual(["function", "function", "function"]);
            expect(await a.holdMoving("d1")).toBeNull();
            expect(await b.holdMoving("d1")).toBeNull();
            intoA!();
            intoA2!();
            await tick();
            expect(await a.holdMoving("d1")).toBeNull();     // b's is still held
            intoB!();
            await tick();
            const whole = await b.holdMoving("d1");
            expect(whole).toBeTypeOf("function");
            expect(await a.holdMoving("d1", true)).toBeNull();
            whole!();
            expect(locks.asked).toEqual([
                "muhkoo:vfs:c1:moving:d1 (shared)",
                "muhkoo:vfs:c1:moving:d1 (shared)",
                "muhkoo:vfs:c1:moving:d1 (shared)",
                "muhkoo:vfs:c1:moving:d1",
                "muhkoo:vfs:c1:moving:d1",
                "muhkoo:vfs:c1:moving:d1",
                "muhkoo:vfs:c1:moving:d1",
                "muhkoo:vfs:c1:moving:d1 (shared)",
            ]);
        } finally {
            a.close();
            b.close();
        }
    });

    it("gives this tab a folder's move lock straight after it let go of it, held shared or not", async () => {
        // As for one entry's move lock: the browser has not let go of it yet.
        inABrowserTab();
        const a = vfsCoordinator(() => "c1")!;
        try {
            const whole = await a.holdMoving("d1");
            whole!();
            const into = await a.holdMoving("d1", true);
            expect(into).toBeTypeOf("function");
            const into2 = await a.holdMoving("d1", true);
            expect(into2).toBeTypeOf("function");
            into!();
            into2!();
            const again = await a.holdMoving("d1");
            expect(again).toBeTypeOf("function");
            again!();
        } finally {
            a.close();
        }
    });
```

- [ ] **Step 10: Run them to verify they fail**

Run: `cd /Users/matt/GitHub/muhkoo/connect && npx vitest --run tests/core/crossTab.test.ts`

Expected: the 6 new tests FAIL with `TypeError: a.holdMoving is not a function`. The other 10 pass.

- [ ] **Step 11: Add `holdMoving` to the browser coordinator.** In `src/core/crossTab.ts`, make four changes.

(a) Replace `vfsCoordinator`'s doc comment:

```ts
 * The `VfsCoordinator` for whoever `commitment()` names: a lock per record,
 * `muhkoo:vfs:<commitment>:<record id>`, and announcements on the channel
 * `muhkoo:vfs:<commitment>` as `{ id, writer }`, where `writer` is this tab's
 * random id. `close` is for tests.
 */
```

with:

```ts
 * The `VfsCoordinator` for whoever `commitment()` names: a lock per record,
 * `muhkoo:vfs:<commitment>:<record id>`; a move lock per entry,
 * `muhkoo:vfs:<commitment>:moving:<entry id>`, taken only if free, and
 * shared by the moves into a folder; and
 * announcements on the channel `muhkoo:vfs:<commitment>` as `{ id, writer }`,
 * where `writer` is this tab's random id. `close` is for tests.
 */
```

(b) Directly after its `let open: { who: string; channel: ChannelLike } | null = null;`, add:

```ts
    // Move locks this tab has let go of, until the browser has too. See `holdMoving`.
    const leaving = new Map<string, Promise<void>>();
```

(c) Replace the end of the object it returns:

```ts
        listen,
        close(): void {
            open?.channel.close();
            open = null;
        },
    };
}
```

with:

```ts
        listen,
        async holdMoving(id: string, shared = false): Promise<(() => void) | null> {
            const who = commitment();
            // Signed out: the store refuses the writes themselves.
            if (!who) return () => {};
            const name = `muhkoo:vfs:${who}:moving:${id}`;
            // Let go of by this tab, but perhaps not yet by the browser, which
            // lets go only once the callback below has settled. Asked for
            // before then - a move or a delete straight after another of the
            // same entry - it is still held, and this tab refuses itself.
            const before = leaving.get(name);
            if (before) await before;
            return new Promise((resolve, reject) => {
                const request = locks.request(name, { ifAvailable: true, mode: shared ? "shared" : "exclusive" }, async (lock) => {
                    if (!lock) {
                        resolve(null);
                        return;
                    }
                    // Held until this settles: when the function handed back
                    // is called, or when the tab goes and the browser lets go
                    // of everything it held.
                    let held = true;
                    await new Promise<void>((letGo) =>
                        resolve(() => {
                            if (!held) return;
                            held = false;
                            // Settles once the browser has let go of it too,
                            // and of every other hold of it this tab has let
                            // go of: two moves into one folder hold it at once.
                            const gone = Promise.all([leaving.get(name), request.then(() => {}, () => {})]).then(() => {});
                            leaving.set(name, gone);
                            void gone.then(() => {
                                if (leaving.get(name) === gone) leaving.delete(name);
                            });
                            letGo();
                        }),
                    );
                });
                request.catch(reject);
            });
        },
        close(): void {
            open?.channel.close();
            open = null;
        },
    };
}
```

(d) In `LockManagerLike`, replace:

```ts
        options: { ifAvailable?: boolean; signal?: AbortSignal },
```

with:

```ts
        options: { ifAvailable?: boolean; signal?: AbortSignal; mode?: "exclusive" | "shared" },
```

- `request.catch(reject)` matters: a request the browser refuses outright, such as in a document that is no longer fully active, never calls the callback. Without it, `holdMoving` would never settle.
- `leaving` matters because the browser lets go of a lock only after the callback's promise has settled, and the promise `request` returns settles only after that. Without it, a tab that asks for a lock straight after letting go of it can find it still held, and refuse itself. For example, a rename right after a rename of the same entry, or a delete retried at once. The test fakes in `tests/vfs` let go at once, so only Step 9's new test shows it.
- It waits only for a release already under way, which settles at once. A lock this tab still holds is refused, as before, and never waited for.
- `leaving` waits for every release of the name under way, not only the last. A tab can let go of two shared holds of one folder at once, as two moves into it finish. A move of that folder asked for straight after must find the browser has let go of both.
- `"exclusive"` is Web Locks' default mode. It is written out so that the two modes sit side by side.
- The release function uses `request`. It is called only after `holdMoving` has resolved, so `request` is always set by then.

- [ ] **Step 12: Run everything: tests, types, lint, the build and the surface**

Run: `cd /Users/matt/GitHub/muhkoo/connect && npx vitest --run tests/core/crossTab.test.ts tests/client tests/vfs/cross-tab.test.ts` (3 times), then `yarn typecheck && yarn lint && yarn test:unit && yarn build && node scripts/check-dts.mjs && grep -c ":moving:" dist/browser/index.js`

Expected:
- the focused run passes all three times, and the process exits. A hang at the end means a BroadcastChannel was left open;
- `tsc` exits 0;
- `yarn lint` reports 0 errors. Its warnings are older ones in files W1 does not touch;
- `yarn test:unit` passes every file, with 23 more tests than after Task 6: 17 in `tests/vfs/cross-tab.test.ts` and 6 in `tests/core/crossTab.test.ts`. On 2026-10-04, a scratch copy of connect as Task 6 left it (tree 52de941), with this task applied, went from 1026 to 1049 in 82 files, all passing. That run had a `dist/`, as connect does. With none, `tests/api/export-surface.test.ts` skips its 5 built-artifact checks: 1044 passed and 5 skipped;
- `check-dts` prints `OK`, and the `grep -c` count is at least 1;
- `holdMoving` now appears in `dist/connect.d.ts`, as a member of `VfsCoordinator`. That is expected: see Global Constraints. No new name is exported, and `tests/api/export-surface.test.ts` passes.

- [ ] **Step 13: The existing suites on the coordinator path, again.** Task 3, Step 14 ran `tests/vfs` and `tests/vcs` with a one-tab coordinator in every namespace. That coordinator now needs `holdMoving`, shared holds included. It must also be installed before a rename or a delete, not only at the first write: both now ask the coordinator before they write anything. Replace `<scratchpad>/one-tab.ts` with:

```ts
/**
 * W1 check, never committed: give every VfsNamespace that has no coordinator a
 * one-tab one, so the existing suites run the coordinator path. W1_GRANT_DELAY
 * (ms) delays each grant, as a browser's lock IPC does.
 */
import { VfsNamespace } from "/Users/matt/GitHub/muhkoo/connect/src/vfs/VfsNamespace";

const delay = Number(process.env.W1_GRANT_DELAY ?? 0);

function oneTab() {
    const tails = new Map<string, Promise<void>>();
    // Each entry's move lock: held by one, or shared by any number that ask for it shared.
    const moving = new Map<string, { shared: boolean; holders: number }>();
    return {
        async lock<T>(id: string, fn: () => Promise<T>): Promise<T> {
            const before = tails.get(id) ?? Promise.resolve();
            let release!: () => void;
            const mine = new Promise<void>((resolve) => (release = resolve));
            const tail = before.then(() => mine);
            tails.set(id, tail);
            await before;
            if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
            try {
                return await fn();
            } finally {
                release();
                if (tails.get(id) === tail) tails.delete(id);
            }
        },
        announce() {},
        onAnnounce() {
            return () => {};
        },
        listen() {},
        async holdMoving(id: string, shared = false): Promise<(() => void) | null> {
            if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
            const now = moving.get(id);
            if (now && !(shared && now.shared)) return null;
            const lock = now ?? { shared, holders: 0 };
            lock.holders++;
            moving.set(id, lock);
            let held = true;
            return () => {
                if (!held) return;
                held = false;
                if (--lock.holders === 0 && moving.get(id) === lock) moving.delete(id);
            };
        },
    };
}

type Patched = Record<"send" | "rename" | "delete", (this: { deps: { coordinator?: unknown } }, ...args: unknown[]) => Promise<void>>;
const proto = VfsNamespace.prototype as unknown as Patched;
for (const name of ["send", "rename", "delete"] as const) {
    const original = proto[name];
    proto[name] = function (...args: unknown[]) {
        this.deps.coordinator ??= oneTab();
        return original.apply(this, args);
    };
}
```

The run reuses Task 3, Step 14's `<scratchpad>/vitest.one-tab.config.mts` unchanged. If that file is missing, as in a fresh session, create it from Task 3, Step 14 first.

Run: `cd /Users/matt/GitHub/muhkoo/connect && npx vitest --run --config <scratchpad>/vitest.one-tab.config.mts --project unit tests/vfs tests/vcs`, then the same with `W1_GRANT_DELAY=1` in front.

Expected, both times: 409 passed and 3 failed. That makes 412 tests: the 395 of Task 3, Step 14's run, plus the 17 new ones in `cross-tab.test.ts`, which bring their own coordinators. That run gave 393 passed and 2 failed, not the 391 and 2 its text says: Task 1's fix round added 2 tests. Holding every folder on a move's way changes none of the other 395. On 2026-10-04, a scratch copy of connect as Task 6 left it, with this task applied, gave these counts and these three failures, with and without `W1_GRANT_DELAY=1`. Task 1's two fix-round tests pass on this path: the second move holds the entry's lock, so the delete's `holdAll` refuses it. The three failures, and only these three, differ by design:
- the two that Task 3, Step 14 lists: "sends twenty files … in two writes of it" and "keeps every file whose write worked … fails once part way through";
- "lets go of a folder's contents once when two deletes of it run at once": `expected { status: 'rejected', …(1) } to match object { reason: Any<VfsNotFoundError> }`.
  - On this path, the second delete finds the first holding the folder's move lock, and fails with `VfsConflictError` ("being moved or deleted") instead of `VfsNotFoundError`.
  - Its other checks hold: the content is let go of once, and the copy is kept. On 2026-10-03, the test passed on this path with only that one expectation changed to `VfsConflictError`.

Any other failure is a regression on the browser path: fix it before going on.

- [ ] **Step 14: Mutation check.**
  - Before mutating anything, copy `src/vfs/VfsNamespace.ts` and `src/core/crossTab.ts` to the scratchpad.
  - Apply each mutation below alone, and run `npx vitest --run tests/vfs/cross-tab.test.ts` for a `VfsNamespace.ts` row, or `npx vitest --run tests/core/crossTab.test.ts tests/client/tabs.test.ts` for a `crossTab.ts` row. The one row marked "write-order" runs `npx vitest --run tests/vfs/write-order.test.ts` instead. At least the named tests must fail.
  - Restore the file from the scratchpad copy after each mutation, and confirm with `cmp`. Do not use `git stash` or `git checkout`.

| Mutation | Tests that must fail (at least) |
|---|---|
| `rename` takes no move lock (drop the `if (coordinator) { … holdMoving … }` block) | 8 tests: "refuses a second move…", "refuses a rename in place…", "refuses to delete, in another tab, a file…", "…a folder the first tab is still moving…", "…a folder holding something…", "refuses a move, in another tab, of something in a folder this tab is deleting…", "refuses a move of something a delete in another tab is still purging…", "refuses one of two moves, in two tabs, that would each put a folder below the other" |
| `rename` never lets go of it (drop `release?.();` from its `finally`) | "lets another tab delete a file a move of it left marked…", Task 3's "refuses to delete a folder it read before it could hear another tab move something out, then deletes it", and "refuses to delete a folder another tab is moving something into…" (its retry) |
| `rename` takes no lock of the folders on its way (drop the whole `if (coordinator && dstParent.id !== ROOT_ID) { … }` block) | 6 tests: "refuses a move into a folder another tab is deleting…", "refuses a move into a folder it makes inside a folder another tab is deleting", "refuses to delete a folder another tab is moving something into…", "refuses one of two moves, in two tabs, that would each put a folder below the other", "refuses a move into a folder another tab deleted after the move found it…", "…replaced after the move found it" |
| `rename` holds only the folder it moves into (`way.chain.slice(-1)` for `way.chain.slice(1)`) | "refuses a move into a folder it makes inside a folder another tab is deleting", "refuses one of two moves, in two tabs, that would each put a folder below the other" |
| `rename` holds those folders exclusively (`this.holdAll(coordinator, way.chain.slice(1))` for `this.holdAll(coordinator, way.chain.slice(1), true)`) | "lets two tabs move files into one folder at the same time" |
| `holdAll` ignores `shared` (`coordinator.holdMoving(id)` for `coordinator.holdMoving(id, shared)`) | "lets two tabs move files into one folder at the same time" |
| `rename` does not look at the way again once it holds it (drop the five lines from `await nextTurn();` through `dstParent = again.dir;` in that block) | "refuses a move into a folder another tab deleted after the move found it…", "…replaced after the move found it" |
| `rename` looks again by path only (drop the `if (again.chain.some(…)) …` line) | "refuses a move into a folder another tab replaced after the move found it" |
| `rename` never lets go of those folders (drop `into?.();`) | "refuses to delete a folder another tab is moving something into…" (its retry) |
| `delete` takes no move locks (`const release: (() => void) \| null = () => {};`) | 9 tests: "refuses to delete, in another tab, a file…", "…a folder the first tab is still moving…", "…a folder holding something…", "refuses a move, in another tab, of something in a folder this tab is deleting…", "refuses a move of something a delete … still purging…", "passes on a move lock the browser will not give a delete…", "refuses a move into a folder another tab is deleting…", "refuses a move into a folder it makes inside a folder another tab is deleting", "refuses to delete a folder another tab is moving something into…" |
| `delete` holds only its target's lock (`[entry.id]` for `[entry.id, ...ids]`) | "…a folder holding something…", "refuses a move, in another tab, of something in a folder this tab is deleting…", "refuses a move of something a delete … still purging…", "passes on a move lock the browser will not give a delete…" |
| `delete` lets go before it purges (`release();` just above `if (elsewhere === null) {`) | "refuses a move of something a delete in another tab is still purging…" |
| write-order: `delete` drops Task 1's re-checks in the detach edit: the two consecutive lines inside `this.mutate(parent, …)`, just before `currentSubtree` (16-space indent; the same first line also appears, 8-space indent, in the check before the awaits, which this row leaves alone): `if (this.inMotion.has(entry.id)) throw beingMoved(target);` and `for (const id of ids) if (this.inMotion.has(id)) throw beingMoved(target, true);`). Step 6 must keep them: without a coordinator they are all that closes I-1 | Task 1's fix-round tests "refuses to delete a file that was already marked when read, if a second move takes it before the detach" and "refuses to delete a folder holding a file that was already marked when read, if a second move takes it before the detach" |
| `currentSubtree` ignores `held` (drop its `if (held) …` line) | "refuses to delete a folder another tab saved into since the delete read it…" |
| `holdAll` keeps what it got when refused (drop the `release();` before `return null;`) | "refuses to delete, in another tab, a folder holding something…" (its retry), "refuses to delete a folder another tab is moving something into…" (its retry) |
| `holdAll` takes a request the browser refused outright for a lock held elsewhere (drop the whole `if (failed) { … }` block) | "passes on a move lock the browser will not give a delete…" |
| `holdAll` keeps what it got when a request is refused outright (drop the `release();` before `throw failed.reason;`) | "passes on a move lock the browser will not give a delete…" |
| Browser `holdMoving` without `ifAvailable` (`{ mode: shared ? "shared" : "exclusive" }` for `{ ifAvailable: true, mode: shared ? "shared" : "exclusive" }`) | "holds an entry's move lock…" (only after its 30-second timeout); "shares a folder's move lock…" and "gives this tab a folder's move lock straight after…", as the fake grants a shared lock only with `ifAvailable` |
| Browser move lock named without `moving:` (`` `muhkoo:vfs:${who}:${id}` ``) | "holds an entry's move lock…", "gives this tab an entry's move lock again straight after…", "shares a folder's move lock…" |
| Browser never holds a move lock shared (`mode: "exclusive"` for `mode: shared ? "shared" : "exclusive"`) | "shares a folder's move lock…", "gives this tab a folder's move lock straight after…" |
| Browser holds every move lock shared (`mode: "shared"` for the same) | "holds an entry's move lock…", "gives this tab an entry's move lock again straight after…", "shares a folder's move lock…" |
| Browser takes a move lock with no one signed in (drop `if (!who) return () => {};`) | "holds no move lock when no one is signed in" |
| Browser swallows a refused request (`request.catch(() => {})` for `request.catch(reject)`) | "passes on a move lock the browser refuses to give…" (only after its 30-second timeout) |
| Browser asks again before its own release has landed (drop `if (before) await before;`) | "gives this tab an entry's move lock again straight after…", "gives this tab a folder's move lock straight after…" |

Not pinned, on purpose:
- `delete`'s `await nextTurn()`, and `rename`'s before it looks at the folder again. Like `sendLocked`'s, each only lets in an announcement that may still be on its way (Decision 3).
- The wording of `heldElsewhere`.
- `holdMoving`'s `if (!held) return;`. Nothing calls a release function twice, and a second call would only leave a settled promise in `leaving`.
- No lock for the root (`&& dstParent.id !== ROOT_ID`, and `slice(1)`). Taking it changes nothing a test can reach: only a delete below a cycle that points at the root ever holds the root's lock, and refusing a move then would be needless, not a loss.
- The second look comparing the whole way, not only the folder's id (`again.dir.id !== dstParent.id` passes too). To find the same folder on another way under the same path, something must move it, or a folder above it, between the two looks, and then put a folder of the same name back on that path. No test sets that up.
- `leaving` waiting for every release of a name under way, not only the last (Step 11). The fake lock manager lets go in the order its holders let go, so waiting for the last alone also passes. Waiting for all does not depend on that order.

- [ ] **Step 15: Update the CHANGELOG.** `## Unreleased` holds Tasks 1, 2, 4, 5 and 6's entries. Make three changes in it, and none below it. Task 6's sub-bullet on Node ("Node, and runtimes without Web Locks, keep the previous behaviour, except that…") is Ruling W-3's text: leave it as it is.

(a) In Task 1's bullet, replace the last sentence, `Across two tabs these are not refused yet: see the entry on tabs above.`, with `Across two tabs: see the next entry.`

(b) In Task 6's bullet, under "Not fixed yet:", delete these three lines:

```markdown
  - A move in one tab is not yet refused as "being moved" in the app's other tabs. A second move, or a delete, of
    the same file or folder from another tab while the move is writing can still leave it named in two places, or
    purge it.
```

(c) Directly after Task 1's bullet, which now ends `…Across two tabs: see the next entry.`, and directly above Task 4's bullet (`- **Two tabs coming back online no longer replay…`), add this bullet, with one blank line before and after it, as between the other `### Fixed` bullets:

```markdown
- **Another tab can no longer move or delete a file or folder that one tab is still moving, and leave it named in two
  places or purged.** In a browser, a move holds a lock on what it moves (Web Locks) until it has taken it from where
  it was, and a delete holds one on everything it deletes until it has let go of it. A move, rename or delete in
  another tab that finds one of these held fails with `VfsConflictError` and changes nothing. It never waits, and a
  tab that closes lets go of its locks. Before this, a second move could finish the first as if it had been
  interrupted, which named the file in two places with one content reference between them, and a delete could let go
  of what a move was about to name somewhere else. A move also holds the folder it moves into, and every folder above
  that one, shared with other moves. So a move into a folder that is being deleted, or into a folder inside it, now
  fails with `VfsConflictError` and moves nothing, where the moved file or folder could end up in no listing with
  its storage still in use. So does a delete, move or rename of a folder while something is being moved into it or
  into a folder inside it, and a move into a folder while that folder, or one above it, is being moved. A move
  refused this way keeps the folders it had already made for its destination, empty. Of two moves that would each
  put a folder inside the other, at least one now fails, where both folders could end up in no listing. A move into
  a folder that was deleted or replaced just as the move began now fails with `VfsNotFoundError` naming the folder,
  or with `VfsConflictError`, and moves nothing. In a browser, a recursive delete of a folder
  that something was saved or moved into after the delete read it now also fails with `VfsConflictError`, and trying
  again deletes it. Node, the CLI, and runtimes without Web Locks keep the previous behaviour.

  The locks also apply between operations in the same tab, so in a browser four more outcomes change there. Each
  refusal says the file or folder "is being moved or deleted":
  - Of two deletes of one file or folder running at once, the second now fails with `VfsConflictError`, where it
    failed with `VfsNotFoundError`. Code that took `VfsNotFoundError` from a delete to mean "already gone" gets this
    instead. Trying again once the first delete has finished gives `VfsNotFoundError`.
  - A rename of something that a delete in the same tab is still deleting can now fail with `VfsConflictError`.
  - A move into a folder that a delete in the same tab is still deleting, or into a folder inside it, can now fail
    with `VfsConflictError`, where it went into a new folder of the same name.
  - A move into a folder, and a move or rename of that folder or of a folder above it, at once in the same tab:
    whichever asks second now fails with `VfsConflictError`. Before, both went ahead, and the move into the folder
    either landed in it at its new place or failed with `VfsNotFoundError` after it had landed.

  Not fixed yet:
  - A save into a folder that another tab is deleting at the same moment can succeed and still be gone afterwards, as
    if it had landed just before the delete. Unlike a delete, it leaves its storage in use until a sweep.
  - A tab the browser freezes in the middle of a move keeps that file's or folder's lock, and its share of the locks
    of the folder it is moving it into and of the folders above that one, until it resumes or closes; meanwhile other
    tabs' moves and deletes of any of them fail with `VfsConflictError`.
  - Moves and deletes from another device, or from the CLI, are not ordered against a browser tab's.
  - Two tabs deleting overlapping folders at the same moment, or moving two folders each into the other, can both
    fail with `VfsConflictError`. Trying again works.
```

Then check: `sed -n '/^## Unreleased/,/^## 0\.15\.0-alpha\.3 /p' CHANGELOG.md`, and the same piped into `grep -c "not yet refused as\|see the entry on tabs above"`. Expected:
- `### Fixed` lists Task 6's, Task 1's, this, Task 4's and Task 5's bullets, in that order;
- the count is `0`: both texts that (a) and (b) replace are gone. Task 1's "0.15.0-alpha.3 listed these as not refused yet" stays: it is about one `Client`.

- [ ] **Step 16: Checkpoint for Matt (no commit), and what he has not yet signed off**

Run: `sh <scratchpad>/w1-baseline/changed.sh`

Expected: the same 12 files as after Task 6, then `released CHANGELOG sections: unchanged`. Task 7 creates no file. The 6 it changes are among the 12 (checked on 2026-10-04, in a scratch copy of connect as Task 6 left it). Do not stage, commit or stash.

Report RED, GREEN, the coordinator-path run and the mutation results. The items below go to Matt with W1's results, quoting Decisions 9 and 10.
- He signed off Step 0's first list and his change, not these: each was worked out after his answer, while building it. The controller ruled on each (ledger W-8): 1 to 7 as written here; 8 stays out of the CHANGELOG (W1 does not change it) and is a follow-up.
- Task 8 does not wait for his answer: nothing ships before he asks for a release. If he wants any of them changed, the plan is amended and Tasks 7 and 8 run again.

1. **A move holds every folder on the way to the one it moves into, not only that folder** (Decision 10, "Not the folder alone").
   - The folder alone left the race he closed open. A folder that is new since the delete read the tree is not among the locks the delete holds. It may have been made inside the folder being deleted by the move's own `mkdir -p`, or by another tab's save. A move into it still ended up in no listing, its content stored.
   - The cost: a move or rename of any folder on that way is refused, in any tab, while the move is writing. So is a delete of one, which is the point. A tab frozen mid-move keeps its share of those folders until it resumes or closes.
   - A side effect: of two moves that would each put a folder inside the other, at least one is refused. Without it, both could land and leave both folders in no listing.
   - Pinned by "refuses a move into a folder it makes inside a folder another tab is deleting" and "refuses one of two moves, in two tabs, that would each put a folder below the other".
   - Within one tab, a delete and a rename of the same entry at once can now both be refused: Task 1's in-edit re-check refuses the delete while the rename waits for its lock, and the rename is then refused too if its answer comes while the delete still holds the lock (Decision 10, the first same-tab outcome). Nothing is lost; trying again works.
2. **When those locks are taken, and the root.** They are taken after the move's `mkdir`, before its mark, all at once and only if free. They are let go of with the entry's lock. The root's is never taken.
3. **The second look** (Decision 10). Once it holds those locks, the move looks the way up again. If a delete took the folder away meanwhile, it fails with `VfsNotFoundError` naming the folder. If another folder is now on the way, it fails with `VfsConflictError` ("was changed by another write"). Either way it has moved nothing. Folders its own `mkdir -p` made before it took the locks stay, empty; inside a folder being deleted, one can be a record nothing names until a sweep.
4. **Three more outcomes within one tab, in a browser** (Decision 10, the fourth to the sixth). Apps that branch on error names see them:
   - a move or rename of a folder, or of a folder above it, while a move into it is still writing, fails with `VfsConflictError` ("being moved or deleted");
   - a move into a folder, or into a folder below it, that a delete in the same tab holds fails the same way;
   - a move into a folder, or into a folder below it, that a move or rename in the same tab is moving fails the same way. Before, it went into the folder at its new place.
5. **A delete of a folder while a move clears its mark there** (Decision 9). Both succeed, and one small record can stay stored, with nothing naming it, until a sweep. Holding the move's locks until the mark is cleared would close it. The cost: a delete, move or rename of that folder, or of a folder above it, is refused for one more write.
6. **What a late announcement leaves** (Decision 9). He signed off that it exists, not what it leaves. At these two checks nothing logs it, so Task 8's checks cannot see it there.
   - Missed by a move's second look, the move lands in a record the delete purged.
   - Missed by a delete's check, the delete lets go of the content of a file another tab had just moved out.
7. **Two moves that each go into what the other is moving** can both be refused, as overlapping deletes can (Decision 9). Trying again works.
8. **Node and the CLI: two moves at once that each put a folder below the other** leave both in no listing (Decision 9). This is not new in W1, it is not about tabs, and W1 does not fix it. Ruled (W-8): not in the CHANGELOG; reported to Matt as a follow-up.

---

### Task 8: Verification across repos, and the two-tab checks in Brave on staging

Start once the controller has ruled on what Task 7, Step 16 lists (ledger W-8).

**Files:**
- Create, in the scratchpad and not in any repo: `w1-two-tabs.mjs` and `w1-two-tab-moves.mjs`.
- Touch only Cloud Drive's `node_modules`, which is restored at the end, and the Cloud Drive **staging** deployment.
- Nothing in connect changes in this task.

**What the Brave checks can and cannot see.** Cloud Drive's `doUpload` (`src/features/Drive.tsx`) uploads one file at a time, one `await` each. So each tab has at most one write in flight, and the check exercises the lock, the announcement and the re-read between tabs. It cannot exercise coalescing under the lock, or two tabs creating a folder of the same name. Those rest on Task 3's tests and its coordinator-path run (Step 14).

The moves check, `w1-two-tab-moves.mjs`, makes its races certain rather than likely.
- A move writes the folder it leaves first (the mark), then the folder it goes to. VFS writes are POSTs to `…/kv/vfs%2Fd%2F<record id>`, so the script holds tab A's second write with Playwright's `page.route`. A's move is then under way while tab B acts.
- File names carry the run's stamp, as the folder's name does, so what one run leaves in the Trash cannot be counted by the next.
- M3 runs first. It is two moves into one folder at once: A and B each move a different file to the Trash. Both hold, in shared mode, the lock of the Trash's files folder (`/.trash/files`) and of `/.trash` above it, so B's move is not refused. It marks its file, waits for A's write of the Trash, and lands after it. B marks its file only once it holds the shared lock, and the script lets A's write go only once B's mark has been sent, so B certainly asked for that lock while A held it.
- M1 is Decision 9's second move in another tab: both tabs move x to the Trash.
- M2 is a delete of it in another tab: B deletes forever what A is restoring. `deleteForever` is a recursive delete of the item.
- The third race, a recursive delete of a folder while another tab moves something out of it, cannot be reached from Cloud Drive's UI: the Trash does not open a trashed folder. It rests on Task 7's unit tests, which run the same `VfsNamespace` code through a coordinator that grants and refuses as Web Locks do. Task 7's browser-coordinator tests pin the Web Locks calls themselves: the lock name, `ifAvailable`, the mode, and that a refused request rejects.
- A move into a folder that another tab is deleting (Decision 10's shared lock) cannot be reached from Cloud Drive's UI either. The only folders it deletes are in the Trash ("delete forever"), and nothing puts anything into a trashed folder: the Move dialog does not list the Trash. That race rests on Task 7's unit tests, which run the same `VfsNamespace` code through a coordinator that grants and refuses shared and exclusive holds as Web Locks do. What they cannot show is that Brave grants the shared mode as the fake does. M3 checks that.
- Nor does it run two moves of one entry back to back in one tab. That a tab waits for its own release before asking again (Task 7, Step 11) rests on Task 7, Step 9's test against a fake lock manager, not on a real browser.

`<scratchpad>` below means the executing session's scratchpad directory. Use its absolute path. The race probe in Step 2 is a file that already exists, at the absolute path given there.

**Interfaces:**
- Consumes the connect build from Task 7 (`dist/`).
- Uses Cloud Drive's `data-cy` hooks:
  - `auth-screen`, `tab-login`, `auth-submit`, `drive`, `new-folder`, `item-<name>`, `upload-input` and `breadcrumbs`, from `src/features/Drive.tsx` and the staging Cypress support;
  - for the moves check, also `item-menu-<name>`, `menu-delete`, `menu-download`, `error` and `open-trash` from `src/features/Drive.tsx`, and `trash-view`, `trash-empty-state`, `trash-item-<name>`, `trash-restore-<name>`, `trash-delete-<name>`, `trash-error` and `trash-notice` from `src/features/TrashView.tsx`.

- [ ] **Step 1: The whole connect tree, one more time**

Run: `cd /Users/matt/GitHub/muhkoo/connect && yarn typecheck && yarn lint && yarn test:unit && yarn build && node scripts/check-dts.mjs && sh <scratchpad>/w1-baseline/changed.sh`

Expected: all exit 0. `changed.sh` lists exactly these 12 files, plus this plan file if its checkboxes were ticked, then `released CHANGELOG sections: unchanged`:
- `CHANGELOG.md`;
- `src/core/Client.ts`, `src/core/crossTab.ts`;
- `src/offline/OfflineManager.ts`, `src/offline/OutboundQueue.ts`;
- `src/vfs/VfsNamespace.ts`, `src/vfs/coordinator.ts`;
- `tests/client/tabs.test.ts`, `tests/core/crossTab.test.ts`, `tests/offline/tabs.test.ts`, `tests/vfs/cross-tab.test.ts`, `tests/vfs/write-order.test.ts`.

`yarn build` re-stamps `src/version.ts` from `package.json`. The version has not changed, so its content does not either, and it is not listed. If it is, report it.

Also run `sed -n '/^## Unreleased/,/^## 0\.15\.0-alpha\.3 /p' CHANGELOG.md`. Expected: `### Changed` with Task 2's and Task 6's bullets, then `### Fixed` with Task 6's, Task 1's, Task 7's, Task 4's and Task 5's, in that order.

- [ ] **Step 2: The race probe and the CLI suite.** The CLI links `../connect` and so runs the new `dist`.

Run: `node /private/tmp/claude-501/-Users-matt-GitHub-muhkoo-accelerator/786cbcf3-c0cb-425d-905d-b6db5398ed89/scratchpad/workers-explore/probe-race.mjs`

Expected:
- `case1 … 20 of 20 kept; record puts: 2` (was 20). The count depends on timing: anything from 1 to 2 is right, and more than 2 is not;
- `case2 … 10 of 10 kept`;
- `case3 results: [ 'a failed: transient 503', 'b', 'c' ]`. The probe runs in Node, with no coordinator. In a browser, `b` would ride on `a`'s failed write and fail with it (Task 3, Step 14).

Run: `cd /Users/matt/GitHub/muhkoo/cli && npx vitest run`

Expected: all pass (498 tests on 2026-10-03, against a build of the plan's code as it was then; not re-counted after the 2026-10-04 amendment). For any failure, read its assertion:
- One that pins the old behaviour this plan changes on purpose is listed for Matt with the reason. Examples: a count of directory writes during concurrent saves, or a second move or delete that used to succeed during a move.
- Anything else is a regression. Fix it in connect before going on.

- [ ] **Step 3: Write the two-tab script.** Create `<scratchpad>/w1-two-tabs.mjs`:

```js
// Two tabs of Cloud Drive (staging) in Brave, uploading into one folder at the same moment, round after round,
// then a third tab that reads the folder back from the store. Credentials come from the environment only.
//   MUHKOO_USER=… MUHKOO_PASSWORD=… node w1-two-tabs.mjs      (set them in the shell, not on this line)
import { chromium } from "/Users/matt/GitHub/muhkoo/ide/node_modules/playwright/index.mjs";

const URL = process.env.DRIVE_URL ?? "https://cloud-drive.apps.staging.muhkoo.dev";
const BRAVE = process.env.BRAVE_PATH ?? "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
const ROUNDS = Number(process.env.ROUNDS ?? 8);
const PER_TAB = Number(process.env.PER_TAB ?? 3);
const user = process.env.MUHKOO_USER;
const password = process.env.MUHKOO_PASSWORD;
if (!user || !password) {
    console.error("Set MUHKOO_USER and MUHKOO_PASSWORD (the staging test account) in the environment.");
    process.exit(2);
}
const SLOW = 180_000;
const log = (...parts) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...parts);

const browser = await chromium.launch({ executablePath: BRAVE, headless: !process.env.HEADED });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const notes = [];

async function open(label) {
    const page = await context.newPage();
    page.on("console", (message) => {
        const text = message.text();
        if (text.includes("[muhkoo/vfs]") || message.type() === "error") notes.push(`${label} ${message.type()}: ${text.slice(0, 300)}`);
    });
    page.on("pageerror", (err) => notes.push(`${label} pageerror: ${String(err).slice(0, 300)}`));
    await page.goto(URL, { waitUntil: "domcontentloaded" });
    const drive = page.locator('[data-cy="drive"]');
    const auth = page.locator('[data-cy="auth-screen"]');
    const state = await Promise.race([
        drive.waitFor({ state: "visible", timeout: SLOW }).then(() => "in"),
        auth.waitFor({ state: "visible", timeout: SLOW }).then(() => "out"),
    ]);
    if (state === "out") {
        await page.locator('[data-cy="tab-login"]').click();
        await page.locator('input[autocomplete="username"]').fill(user);
        await page.locator('input[autocomplete="current-password"]').fill(password);
        await page.locator('[data-cy="auth-submit"]').click();
        await drive.waitFor({ state: "visible", timeout: SLOW });
    }
    log(`${label}: in the drive`);
    return page;
}

async function enter(page, folder) {
    await page.locator(`[data-cy="item-${folder}"]`).click();
    await page.locator('[data-cy="breadcrumbs"]').filter({ hasText: folder }).waitFor({ timeout: SLOW });
}

async function upload(page, files) {
    await page.locator('[data-cy="upload-input"]').setInputFiles(
        files.map((name) => ({ name, mimeType: "text/plain", buffer: Buffer.from(`${name}\n`) })),
    );
}

async function shown(page, files) {
    for (const name of files) await page.locator(`[data-cy="item-${name}"]`).waitFor({ state: "visible", timeout: SLOW });
}

async function listing(page) {
    const ids = await page.locator('[data-cy^="item-"]:not([data-cy^="item-menu-"])').evaluateAll((els) => els.map((el) => el.getAttribute("data-cy")));
    return ids.map((id) => id.slice("item-".length)).sort();
}

let exit = 0;
try {
    const folder = `w1-tabs-${Date.now()}`;
    const A = await open("A");
    A.once("dialog", (dialog) => dialog.accept(folder));
    await A.locator('[data-cy="new-folder"]').click();
    await A.locator(`[data-cy="item-${folder}"]`).waitFor({ timeout: SLOW });
    const B = await open("B");
    await enter(A, folder);
    await enter(B, folder);

    const expected = [];
    for (let round = 1; round <= ROUNDS; round++) {
        const a = Array.from({ length: PER_TAB }, (_, i) => `a-${round}-${i}.txt`);
        const b = Array.from({ length: PER_TAB }, (_, i) => `b-${round}-${i}.txt`);
        expected.push(...a, ...b);
        await Promise.all([upload(A, a), upload(B, b)]);     // the same moment, both tabs
        await Promise.all([shown(A, a), shown(B, b)]);
        log(`round ${round}: each tab shows its own uploads`);
    }

    // What is stored, not what either tab's cache shows: a third tab reads the folder from the store.
    const C = await open("C");
    await enter(C, folder);
    let found = [];
    for (let i = 0; i < 30; i++) {
        found = await listing(C);
        if (found.length >= expected.length) break;
        await C.waitForTimeout(1000);
    }
    const missing = expected.filter((name) => !found.includes(name));
    const lateHeard = notes.filter((note) => note.includes("may be lost"));
    console.log(JSON.stringify({ folder, rounds: ROUNDS, perTab: PER_TAB, expected: expected.length, found: found.length, missing, lateHeard, notes }, null, 2));
    if (missing.length || lateHeard.length) exit = 1;
} catch (err) {
    console.error(err);
    exit = 3;
} finally {
    await browser.close();
}
process.exit(exit);
```

- [ ] **Step 4: Write the two-tab moves script.** Create `<scratchpad>/w1-two-tab-moves.mjs`. It signs in the same way as `w1-two-tabs.mjs`.

```js
// Two tabs of Cloud Drive (staging) in Brave. In each check, tab A moves a file, and the request that puts it in
// its new place is held, so the move is still under way while tab B acts. Then a new tab reads back what is
// stored. Credentials come from the environment only. File names carry the run's stamp, so runs do not mix.
//   MUHKOO_USER=… MUHKOO_PASSWORD=… node w1-two-tab-moves.mjs      (set them in the shell, not on this line)
//   M3: A moves y to the Trash; B moves z to the Trash.              Expect B not refused, and both in the Trash.
//   M1: A moves x to the Trash; B moves it to the Trash too.         Expect B refused, and one x in the Trash.
//   M2: A restores x; B deletes it forever from the Trash.           Expect B refused, x back with its content.
// M3 runs first, while both tabs show the folder.
import { readFile } from "node:fs/promises";
import { chromium } from "/Users/matt/GitHub/muhkoo/ide/node_modules/playwright/index.mjs";

const DRIVE = process.env.DRIVE_URL ?? "https://cloud-drive.apps.staging.muhkoo.dev";
const BRAVE = process.env.BRAVE_PATH ?? "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
const user = process.env.MUHKOO_USER;
const password = process.env.MUHKOO_PASSWORD;
if (!user || !password) {
    console.error("Set MUHKOO_USER and MUHKOO_PASSWORD (the staging test account) in the environment.");
    process.exit(2);
}
const SLOW = 180_000;
const REFUSED = /being moved or deleted/;
const log = (...parts) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...parts);

const browser = await chromium.launch({ executablePath: BRAVE, headless: !process.env.HEADED });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const notes = [];

async function open(label) {
    const page = await context.newPage();
    page.on("console", (message) => {
        const text = message.text();
        if (text.includes("[muhkoo/vfs]") || message.type() === "error") notes.push(`${label} ${message.type()}: ${text.slice(0, 300)}`);
    });
    page.on("pageerror", (err) => notes.push(`${label} pageerror: ${String(err).slice(0, 300)}`));
    await page.goto(DRIVE, { waitUntil: "domcontentloaded" });
    const drive = page.locator('[data-cy="drive"]');
    const auth = page.locator('[data-cy="auth-screen"]');
    const state = await Promise.race([
        drive.waitFor({ state: "visible", timeout: SLOW }).then(() => "in"),
        auth.waitFor({ state: "visible", timeout: SLOW }).then(() => "out"),
    ]);
    if (state === "out") {
        await page.locator('[data-cy="tab-login"]').click();
        await page.locator('input[autocomplete="username"]').fill(user);
        await page.locator('input[autocomplete="current-password"]').fill(password);
        await page.locator('[data-cy="auth-submit"]').click();
        await drive.waitFor({ state: "visible", timeout: SLOW });
    }
    log(`${label}: in the drive`);
    return page;
}

async function enter(page, folder) {
    await page.locator(`[data-cy="item-${folder}"]`).click();
    await page.locator('[data-cy="breadcrumbs"]').filter({ hasText: folder }).waitFor({ timeout: SLOW });
}

async function openTrash(page) {
    await page.locator('[data-cy="open-trash"]').click();
    await page.locator('[data-cy="trash-view"]').waitFor({ timeout: SLOW });
    // Loaded: either the empty state or at least one item.
    await page.locator('[data-cy="trash-empty-state"], [data-cy^="trash-item-"]').first().waitFor({ timeout: SLOW });
}

/** The directory record a request writes, or null: a write is a POST to …/kv/vfs%2Fd%2F<id>, a read adds /get. */
function recordOf(url) {
    const at = url.indexOf("/kv/vfs%2Fd%2F");
    if (at < 0) return null;
    const rest = url.slice(at + "/kv/vfs%2Fd%2F".length).split("?")[0];
    return rest.includes("/") ? null : decodeURIComponent(rest);
}

/**
 * Every directory record `page` writes, in order, and `hold(pick)`: hold back the first write from then on that
 * `pick(id)` chooses, until `release()`. Every other request goes straight through.
 */
async function recordWrites(page) {
    const writes = [];
    let picker = null;
    await page.route(
        (url) => url.pathname.includes("/kv/vfs%2Fd%2F") && !url.pathname.endsWith("/get"),
        async (route) => {
            const request = route.request();
            const id = request.method() === "POST" ? recordOf(request.url()) : null;
            if (id !== null) {
                writes.push(id);
                if (picker?.pick(id)) {
                    const { reached, released } = picker;
                    picker = null;
                    reached();
                    await released;
                }
            }
            await route.continue();
        },
    );
    return {
        writes,
        hold(pick) {
            let reached;
            let go;
            const holding = new Promise((resolve) => (reached = resolve));
            const released = new Promise((resolve) => (go = resolve));
            picker = { pick, reached, released };
            return { holding, release: () => go() };
        },
    };
}

/** Wait until `test()` is true, asking every 100 ms, for up to a minute. */
async function until(test) {
    for (const end = Date.now() + 60_000; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 100))) {
        if (await test()) return;
    }
    throw new Error("timed out waiting");
}

/** What `page` shows once the operation it was asked for settles: the error text, or `done` when `gone` goes. */
async function settled(page, errorSelector, gone) {
    const error = page.locator(errorSelector);
    return Promise.race([
        error.waitFor({ state: "visible", timeout: 60_000 }).then(() => error.innerText()),
        page.locator(gone).waitFor({ state: "detached", timeout: 60_000 }).then(() => "done"),
    ]);
}

/** The content of `name` in the folder `page` shows, through the app's own download. */
async function contentOf(page, name) {
    await page.locator(`[data-cy="item-menu-${name}"]`).click();
    const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 60_000 }),
        page.locator('[data-cy="menu-download"]').click(),
    ]);
    return readFile(await download.path(), "utf8");
}

const result = { m3: {}, m1: {}, m2: {} };
let exit = 0;
try {
    const stamp = Date.now();
    const folder = `w1-moves-${stamp}`;
    const [x, y, z] = ["x", "y", "z"].map((name) => `${name}-${stamp}.txt`);
    const A = await open("A");
    const writesA = await recordWrites(A);
    A.once("dialog", (dialog) => dialog.accept(folder));
    await A.locator('[data-cy="new-folder"]').click();
    await A.locator(`[data-cy="item-${folder}"]`).waitFor({ timeout: SLOW });
    await enter(A, folder);
    // Saves into the new folder write its record, and no other: that is how its id is learned.
    const before = writesA.writes.length;
    await A.locator('[data-cy="upload-input"]').setInputFiles(
        [x, y, z].map((name) => ({ name, mimeType: "text/plain", buffer: Buffer.from(`${name}\n`) })),
    );
    for (const name of [x, y, z]) await A.locator(`[data-cy="item-${name}"]`).waitFor({ timeout: SLOW });
    const wrote = [...new Set(writesA.writes.slice(before))];
    if (wrote.length !== 1) throw new Error(`the upload wrote ${wrote.length} directory records, not just its folder's: ${wrote.join(", ")}`);
    const [folderRecord] = wrote;
    const B = await open("B");
    const writesB = await recordWrites(B);
    await enter(B, folder);
    for (const name of [x, y, z]) await B.locator(`[data-cy="item-${name}"]`).waitFor({ timeout: SLOW });

    // M3. Two moves into one folder at once. A's move of y to the Trash writes the folder (y marked), then the
    // Trash: hold the Trash write. B then moves z to the Trash. Both hold the Trash's lock shared, so B is not
    // refused: it marks z - which it does only once it holds that lock - and then waits for A's write of the Trash.
    let markedY = false;
    const yIntoTrash = writesA.hold((id) => {
        if (id === folderRecord) markedY = true;
        return markedY && id !== folderRecord;
    });
    await A.locator(`[data-cy="item-menu-${y}"]`).click();
    await A.locator('[data-cy="menu-delete"]').click();
    await yIntoTrash.holding;
    log("M3: A has marked y and is putting it in the Trash");
    const sentB = writesB.writes.length;
    await B.locator(`[data-cy="item-menu-${z}"]`).click();
    await B.locator('[data-cy="menu-delete"]').click();
    const errorB = B.locator('[data-cy="error"]');
    await until(async () => writesB.writes.slice(sentB).includes(folderRecord) || (await errorB.isVisible()));
    result.m3.bMarked = writesB.writes.slice(sentB).includes(folderRecord);
    yIntoTrash.release();
    result.m3.b = await settled(B, '[data-cy="error"]', `[data-cy="item-${z}"]`);
    await A.locator(`[data-cy="item-${y}"]`).waitFor({ state: "detached", timeout: SLOW });
    log("M3: both moves settled; B:", result.m3.b);
    const E = await open("E");
    await openTrash(E);
    result.m3.inTrash = {
        y: await E.locator(`[data-cy="trash-item-${y}"]`).count(),
        z: await E.locator(`[data-cy="trash-item-${z}"]`).count(),
    };

    // M1. A's move of x to the Trash writes the folder (x marked), then the Trash: hold the Trash write.
    let marked = false;
    const intoTrash = writesA.hold((id) => {
        if (id === folderRecord) marked = true;
        return marked && id !== folderRecord;
    });
    await A.locator(`[data-cy="item-menu-${x}"]`).click();
    await A.locator('[data-cy="menu-delete"]').click();
    await intoTrash.holding;
    log("M1: A has marked x and is putting it in the Trash");
    await B.locator(`[data-cy="item-menu-${x}"]`).click();
    await B.locator('[data-cy="menu-delete"]').click();
    result.m1.b = await settled(B, '[data-cy="error"]', `[data-cy="item-${x}"]`);
    intoTrash.release();
    await A.locator(`[data-cy="item-${x}"]`).waitFor({ state: "detached", timeout: SLOW });
    log("M1: A's move landed; B:", result.m1.b);
    result.m1.bRefused = REFUSED.test(String(result.m1.b));
    const C = await open("C");
    await enter(C, folder);
    result.m1.inFolder = await C.locator(`[data-cy="item-${x}"]`).count();
    await openTrash(C);
    result.m1.inTrash = await C.locator(`[data-cy="trash-item-${x}"]`).count();

    // M2. A's restore of x writes the Trash (x marked), then the folder: hold the folder write.
    if (result.m1.inTrash !== 1) {
        result.m2.skipped = `M1 left ${result.m1.inTrash} of x in the Trash`;
    } else {
        for (const page of [A, B]) {
            await openTrash(page);
            await page.locator(`[data-cy="trash-item-${x}"]`).waitFor({ timeout: SLOW });
        }
        const backHome = writesA.hold((id) => id === folderRecord);
        await A.locator(`[data-cy="trash-restore-${x}"]`).click();
        await backHome.holding;
        log("M2: A has marked x and is putting it back in its folder");
        B.once("dialog", (dialog) => dialog.accept());
        await B.locator(`[data-cy="trash-delete-${x}"]`).click();
        result.m2.b = await settled(B, '[data-cy="trash-error"]', `[data-cy="trash-item-${x}"]`);
        backHome.release();
        await A.locator('[data-cy="trash-notice"]').waitFor({ timeout: SLOW });
        log("M2: A's restore landed; B:", result.m2.b);
        result.m2.bRefused = REFUSED.test(String(result.m2.b));
        const D = await open("D");
        await enter(D, folder);
        result.m2.inFolder = await D.locator(`[data-cy="item-${x}"]`).count();
        result.m2.content = await contentOf(D, x).catch((err) => `unreadable: ${String(err).slice(0, 200)}`);
        await openTrash(D);
        result.m2.inTrash = await D.locator(`[data-cy="trash-item-${x}"]`).count();
    }

    const lateHeard = notes.filter((note) => note.includes("may be lost"));
    const ok =
        result.m3.bMarked && result.m3.b === "done" && result.m3.inTrash.y === 1 && result.m3.inTrash.z === 1 &&
        result.m1.bRefused && result.m1.inFolder === 0 && result.m1.inTrash === 1 &&
        result.m2.bRefused && result.m2.inFolder === 1 && result.m2.content === `${x}\n` && result.m2.inTrash === 0 &&
        lateHeard.length === 0;
    console.log(JSON.stringify({ folder, files: { x, y, z }, ok, ...result, lateHeard, notes }, null, 2));
    if (!ok) exit = 1;
} catch (err) {
    console.error(err);
    exit = 3;
} finally {
    await browser.close();
}
process.exit(exit);
```

Run: `node --check <scratchpad>/w1-two-tab-moves.mjs`. Expected: no output, exit 0.

- [ ] **Step 5: Baseline against the current staging build (expected RED).**
  - Check that `MUHKOO_USER` and `MUHKOO_PASSWORD` are set: `[ -n "$MUHKOO_USER" ] && [ -n "$MUHKOO_PASSWORD" ] && echo set`. If they are not set, stop and ask Matt to export them in the session's shell. Never put them in a file or on a command line.
  - Check what staging serves. Deploys come from a working tree, so probe it, do not infer it: `curl -s https://cloud-drive.apps.staging.muhkoo.dev/ | grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' | head -1 | xargs -I{} curl -s https://cloud-drive.apps.staging.muhkoo.dev/{} | grep -oE '0\.15\.0-alpha\.[0-9]+' | sort -u`. Expected: `0.15.0-alpha.3`, the registry build, as probed on 2026-10-03.
  - Run: `node <scratchpad>/w1-two-tabs.mjs`
  - Expected, on the deployed `0.15.0-alpha.3`: `missing` is non-empty in at least one run (exit 1).
  - If a run loses nothing, run once more with `ROUNDS=12 PER_TAB=5`, and record both results either way. The baseline shows that the check can see the bug. A baseline that never reproduces is reported, and is not a blocker.
  - Run: `node <scratchpad>/w1-two-tab-moves.mjs`
  - Expected, on the deployed `0.15.0-alpha.3`: exit 1, with `m1.bRefused: false`, because B's move goes through. `m2` either says `skipped`, or has `bRefused: false`, often with `content` unreadable: B let go of what A's restore then named. `m3` has `b: "done"`, but its `inTrash` may lack `z`: with no lock, A's held write of the Trash lands over B's, the two-tab loss W1 fixes. Record the JSON. As with the upload baseline, one that shows nothing wrong is reported, and is not a blocker.

- [ ] **Step 6: Build Cloud Drive against this connect, and check it before deploying**
  - Run: `cd /Users/matt/GitHub/muhkoo/connect && npm pack --pack-destination <scratchpad>`. Expected: `muhkoo-connect-0.15.0-alpha.3.tgz` in the scratchpad. It carries the same version as the registry's alpha.3, because nothing is released yet, so only its content tells the two apart: the `muhkoo:vfs:` count below.
  - Run: `cd /Users/matt/GitHub/muhkoo/cloud-drive && git status --short > <scratchpad>/cloud-drive-status.txt && node -p "require('./.muhkoo-app.staging.json').slug + ' ' + require('./.muhkoo-app.staging.json').appId"`
    - Expected: `cloud-drive 999bed2ba01b168d4f70932777392da4`. If it is anything else, stop.
    - The status file records what the staging deploy ships: deploys come from the working tree.
  - Run: `cd /Users/matt/GitHub/muhkoo/cloud-drive && npm install --no-save <scratchpad>/muhkoo-connect-0.15.0-alpha.3.tgz && grep -c "muhkoo:vfs:" node_modules/@muhkoo/connect/dist/browser/index.js && ls node_modules/node_modules 2>/dev/null; echo "self-link check done"`
    - Expected: a count of at least 1.
    - Expected: no `node_modules/node_modules` (a stale harness self-link inflates the build).
  - Run: `cd /Users/matt/GitHub/muhkoo/cloud-drive && npm run build:staging && ls -la dist/assets | sort -k5 -n | tail -5 && grep -l "muhkoo:offline-drain:" dist/assets/*.js && grep -l ":moving:" dist/assets/*.js`
    - Expected: the build succeeds.
    - Expected: the largest chunks are about the size they were before this work. If any is markedly larger, stop and report.
    - Expected: one asset contains the drain lock name, and one contains `:moving:`, from the move lock's name (Task 7).

- [ ] **Step 7: Deploy Cloud Drive to STAGING, and confirm what is live**
  - Run: `cd /Users/matt/GitHub/muhkoo/cloud-drive && npm run deploy:staging`. This is staging only. Never run `deploy:production` here.
  - Run: `cd /Users/matt/GitHub/muhkoo/cloud-drive && curl -s https://cloud-drive.apps.staging.muhkoo.dev/ | diff - dist/index.html && echo "served = built"`.
    - Expected: `served = built`. Asset names are content-hashed, so an identical `index.html` means the build with the drain lock (Step 6) is the one served.
    - If the host rewrites `index.html` and they differ, compare the `assets/index-*.js` name they reference instead.

- [ ] **Step 8: The checks against the new build (expected GREEN)**
  - Run: `node <scratchpad>/w1-two-tabs.mjs`, then `ROUNDS=12 PER_TAB=5 node <scratchpad>/w1-two-tabs.mjs`.
  - Expected for both: exit 0, `missing: []` and `lateHeard: []`.
  - Run: `node <scratchpad>/w1-two-tab-moves.mjs`, twice.
  - Expected both times: exit 0 and `ok: true`, with:
    - `m3`: `bMarked: true`, `b: "done"` and `inTrash: { y: 1, z: 1 }`. B was not refused: the Trash's lock is shared;
    - `m1`: `bRefused: true`, where B's message names x as "being moved or deleted"; `inFolder: 0`; `inTrash: 1`;
    - `m2`: `bRefused: true`, `inFolder: 1`, `content` the name of x and a newline, and `inTrash: 0`;
    - `lateHeard: []`.
  - Report `notes` in full for every run: any `[muhkoo/vfs]` warning, any `VfsConflictError`, and any page error. B's refusals in M1 and M2 are expected. The app shows them; they are not page errors.

- [ ] **Step 9: Restore Cloud Drive's dependencies**
  - Run: `cd /Users/matt/GitHub/muhkoo/cloud-drive && npm ci && node -p "require('./node_modules/@muhkoo/connect/package.json').version" && (grep -c "muhkoo:vfs:" node_modules/@muhkoo/connect/dist/browser/index.js || true)`
    - connect's `exports` map does not expose `./package.json`, so the path goes through `./node_modules`. `grep -c` exits 1 when it counts 0, hence the `|| true`, which covers only the grep.
  - Expected: `0.15.0-alpha.3` and a count of `0`: the registry build again.
  - Also run `git status --short` and compare it with the saved status: identical.
  - Note in the report that Cloud Drive **staging** stays on the unreleased build until its next staging deploy.

- [ ] **Step 10: Report.** Write the task report as the final message. Do not write it to a file. Include:
  - the Step 1 counts;
  - the probe output and the CLI count;
  - the baseline and GREEN JSON of both checks;
  - the asset check;
  - the restore check.

  Nothing was committed, published or deployed to production.

  This is the last step of W1's tasks. The Production section below is not part of Task 8: none of it runs unless Matt asks for that item in that message.

---

## Production (only on Matt's ask)

Each item below happens only when Matt asks for it in that message, and each needs its own ask. An earlier "yes" does not carry over.

1. **Release connect.**
   - Before it, from the ledger: Task 8c's Brave pass on the final build is green (W-14); the CHANGELOG wording items NB-2 and NB-3 are fixed; and NB-1, the slow IndexedDB open, has been put to Matt as a small pre-release refinement (Decision 9).
   - Check what is published first: `npm view @muhkoo/connect dist-tags`, and the newest released heading in `CHANGELOG.md`. On 2026-10-03 both are `0.15.0-alpha.3`, so W1 is `0.15.0-alpha.4`. Use the next version above whatever they say then: npm refuses to publish a version twice.
   - Bump `package.json` `version` to it.
   - Run `yarn build`. It re-stamps `src/version.ts`: bumping `package.json` alone ships an SDK that misreports itself.
   - In `CHANGELOG.md`, turn `## Unreleased` into `## 0.15.0-alpha.4 — two tabs keep each other's files (<date>)`, add the line `Published with \`npm run release\`: both \`alpha\` and \`latest\` point at it.` under it, and put a new, empty `## Unreleased` above it, as the file has now.
   - Run `npm run release`, never a bare `npm publish`. It moves `latest`, which 13 apps resolve.
2. **Release the CLI.** It benefits from coalescing, because `vfs import` saves into one folder. Bump `@muhkoo/connect` in `/Users/matt/GitHub/muhkoo/cli/package.json`, then `npm run release` there.
3. **Move the apps onto it.**
   - **Required first, in both apps (final review, Minor 9):** handle `VfsConflictError` from a delete. Both treat only `VfsNotFoundError` from a delete as "already gone": the IDE in `src/muhkoo/VfsMirror.ts:292`, and Cloud Drive in `src/lib/trash.ts:77` (`dropInfo`). With two tabs, the second delete of one entry now gets the "being moved or deleted" `VfsConflictError` instead. The IDE then shows "…would not delete X …, so the old copy is still there" when the file is gone. Neither app moves to this version until it handles that. Both are other repos, so this is a change in each, not in connect.
   - In Cloud Drive and the IDE, bump `@muhkoo/connect` (Cloud Drive pins `0.15.0-alpha.3` exactly today), run `npm install`, and deploy to staging (`npm run deploy:staging`, the default).
   - Only then, and only on a further ask, run `npm run deploy:production` for each.
   - Before production, pass on to both apps the Task 19 and W1 behaviour change: saves, moves and deletes can now reject with `VfsConflictError` in races. The class alone does not say whether to try again: permanent refusals such as "already exists" use it too. Apps tell them apart by the message:
     - **Worth trying again as it was:** the three refusals whose message says "try again":
       - "… is being moved; nothing was changed - try again once the move has finished" (Task 1);
       - "… is being moved or deleted in this app, in this tab or another; nothing was changed - try again once that has finished" (Task 7);
       - "another tab of this app has been writing this folder for over 30 seconds; nothing was written - try again" (Task 6).
     - **Look again before trying again:** "… was changed by another write while this one was in progress; nothing was written over it". It can mean another tab saved that name first, where a blind retry overwrites that tab's file. It can also mean something was saved into a folder being deleted, where a retry deletes that file too.
     - **Permanent:** "already exists", "is a file", "is a directory", "is not empty", and the rest.
     - **Same-tab changes in a browser (Decision 10).** A second delete of something a delete in the same tab is still deleting now gets the "being moved or deleted" refusal instead of `VfsNotFoundError`. So can a move into a folder, or into a folder below it, that the same tab is deleting, moving or renaming. A delete whose way a move or rename in the same tab changes gets `VfsNotFoundError` or the "was changed by another write" refusal, and deletes nothing (Task 9's fix round). Where the browser refuses Web Locks, the "being moved or deleted" refusals here do not happen.
     - **In every runtime, Node and the CLI included (Task 7b).** A move or rename of something a delete has begun on, or of anything below it, gets the "being moved or deleted" refusal until the delete has finished.
     - **A folder that something is being moved into (Decision 10).** In any tab, a move or rename of it or of a folder above it, and a delete of it or of a folder above it, get the "being moved or deleted" refusal until that move has finished. The other way round, a move into a folder, or into a folder below it, gets the same refusal while that folder is being moved, renamed or deleted. A move into a folder that another tab deleted, or replaced, just as the move began fails with `VfsNotFoundError` naming the folder, or with the "was changed by another write" refusal.
       - Cloud Drive's `src/lib/trash.ts` takes `VfsNotFoundError` from a delete to mean "already gone" (`isNotFound`). It must handle `VfsConflictError` too: see the first bullet of this item.
       - The IDE's `src/muhkoo/VfsMirror.ts` takes `VfsNotFoundError` as already done, and must handle `VfsConflictError` too (first bullet). Its `isTransient` counts every `VfsConflictError` as permanent, so a "being moved or deleted" refusal is dropped with its "refused" banner, not retried. Another tab's move or delete of the same entry gives the same refusal.
4. **Docs site** (`/Users/matt/GitHub/muhkoo/docs`). In `src/content/docs/reference/vfs.mdx` § Maintenance, "two tabs editing the same directory" becomes "two devices (or a browser and the CLI) editing the same directory". Also add the matching entry to the public changelog surface. Deploying the docs is a separate ask.
