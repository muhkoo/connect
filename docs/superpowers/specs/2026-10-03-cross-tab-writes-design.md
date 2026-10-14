# W1 — Correct writes across tabs on one device — Design

**Date:** 2026-10-03 · **Status:** approved by Matt ("W1 looks good", 2026-10-03).
**Amended during execution (2026-10-05):** see "Amendments during execution" below.
**Program:** the first of the SDK worker/threads sub-projects (Matt, 2026-10-03, "Correctness first"). The order is:
- W1: across tabs (this spec)
- W2: server compare-and-swap, for across devices
- W3: a file-pipeline worker and a parallel transfer pool
- W4: a resumable upload queue
- W5: a parallel upload pool in the CLI
- W6: an optional shared worker

**Repo:** connect only (the core SDK, so every app benefits). No accelerator change. W2 owns the server side.

## Problem

The personal space stores whatever arrives last. It has no compare-and-swap, and VFS writes carry no HLC. The
SDK now orders writes **inside one tab**:
- Task 13: a write queue per directory record;
- Task 15: a read waits for that record's pending write;
- Task 17: hardening of the failure paths.

Nothing orders writes **between tabs** of the same app on one device, so these still happen:

1. **A folder edit is lost between tabs.** Tab A and tab B each hold a cached copy of `/Docs`. A writes `a.txt`,
   B writes `b.txt`, and each sends its whole directory record. The record that lands last wins, so the other
   file disappears from the folder, and its bytes stay billed with nothing pointing at them. Cloud Drive, the IDE
   and any app using `client.vfs` hit this as soon as a user has two tabs open.
2. **Every tab replays the shared offline queue.** The offline layer keeps one IndexedDB `outbound-queue`, and
   every tab drains it independently (`OutboundQueue.drain` is single-flight per instance only). Two tabs coming
   back online replay the same entries twice.
3. **Every tab uses the same HLC node id.** `OfflineManager.boot` stores one `nodeId` in IndexedDB `meta`, and
   every tab of the origin loads it. Two tabs can stamp identical HLCs, so the node-id tiebreak cannot order them.
4. **A burst rewrites the same record many times.** N edits of one folder queued behind an in-flight write send
   N full-record PUTs, one after another. Each is a billed `kv_write`, and on the Free tier VFS records count
   toward its 1,000 writes a month. Importing 20 files into one folder sends 20 directory PUTs.

## Design

### 1. A device-wide lock per directory record (browsers)

- **What runs under the lock.** `VfsNamespace.mutate` (every directory-record edit: write, mkdir, rename, delete,
  copy, history) runs its read-modify-write under a Web Lock:
  - lock name: `muhkoo:vfs:<commitment>:<recordId>`;
  - the lock covers the read, the edit, the send and waiting for the write to settle.
  - *Amended in planning (plan Decision 1, signed off): the edit is applied at once, and replayed under the lock onto
    a fresh copy when another tab has written.*
- **Re-read only when another tab wrote.** Each tab announces the records it writes on a `BroadcastChannel`
  (`muhkoo:vfs:<commitment>`), as `{ id, writer: tabId }`.
  - A tab that hears an announcement for a record marks its cached copy **stale**.
  - Inside the lock, a stale or missing copy is re-read from the store before the edit; a fresh copy is used as
    is.
  - The common case, one tab, costs no extra round trip.
  - *Amended in execution: a write counter in IndexedDB decides whether a copy is stale; the announcement is a
    hint. See Amendments, 1.*
- **Why not rely on the change frames.** The personal-space socket's change frames already reach every tab, but
  a frame can arrive after the other tab's lock is released. The announcement goes out before the lock is
  released, so it is ordered by the lock. Change frames stay as they are: they cover other devices and the CLI.
  - *Amended in execution: measured in Brave, the announcement is not ordered by the lock. See Amendments, 1.*
- **Where the lock is unavailable** (no `navigator.locks`, e.g. Node before 24.5 and old WebViews), mutation falls
  back to today's in-tab queue. A storage-partitioned iframe has its own lock and channel namespace, the same as
  its own tab.
  - *Amended in execution: also where the browser refuses Web Locks to the page. See Amendments, 4.*
- **Use `globalThis.BroadcastChannel`.** Connect's own `src/sessions/BroadcastChannel.ts` class shadows the
  global name.
- **What this does not fix.** The lock serializes tabs on ONE device. Writes from another device or the CLI can
  still race a browser tab. That needs W2.

### 2. Coalescing queued writes of one record

- When a record's write is in flight and more edits of it arrive, they apply to the cached copy and join **one**
  follow-up write.
- That write sends the snapshot taken when it is sent (already true since Task 13), and every edit queued behind
  it resolves when it settles.
- A failure rejects every edit that rode on it, as one error.
- **Result:** a burst of N edits costs at most 2 PUTs (the in-flight one, then one combined), instead of N.
  - *As built: that holds for edits made while the first write is in flight. Saves that finish at different
    moments can cost more than 2, never more than one each: 20 staggered saves cost 9 in the final review's probe.*

### 3. Draining the offline queue under a lock

- `OutboundQueue.drain` takes `navigator.locks.request("muhkoo:offline-drain:<commitment>", { ifAvailable: true })`.
- If another tab holds it, this tab skips the drain; the holder is already replaying.
- Entries are removed only after they succeed, as today, so a tab that drains later sees only what's left.
- Without Web Locks, today's behaviour is unchanged. *As built, also where the browser refuses them: the drain runs
  unlocked (Amendments, 4).*

### 4. One HLC node id per tab

- `OfflineManager.boot` keeps the stored device id, and uses `nodeId = <deviceId>.<tabSuffix>`, where the suffix
  is random and held in memory.
- The persisted HLC *state* (the last physical/logical time) stays shared, so the clock never goes backwards
  across tabs.
- Existing stored HLCs stay valid; node ids are opaque strings to the comparator.
  - Verify that nothing parses the node id.
  - Verify that the server compares only HLC order, and does not compare node-id equality.

## Amendments during execution

Execution (2026-10-04/05) changed four things in this design. The plan
(`docs/superpowers/plans/2026-10-03-cross-tab-writes.md`, Decisions 3, 10 and 11) has the detail. The ledger
(`.superpowers/sdd/2026-10-03-cross-tab-writes/progress.md`) has the rulings, W-1 to W-14. Two more changes were
made while planning, and Matt signed them off on 2026-10-03 (plan Decisions 1 and 2):
- an edit is applied at once, and replayed under the lock onto a fresh copy when another tab has written;
- only the wait for the lock is bounded, at 30 seconds. A hung PUT keeps its lock until it fails.

### 1. Freshness: a write counter in IndexedDB, not stale marks (Task 9)

- **Why.** §1 assumes the announcement reaches the next tab before that tab is granted the lock. Measured in Brave
  on staging (plan Task 8, an order probe), it does not:
  - it had not arrived at the grant in 66 of 100 and 139 of 200 hand-offs;
  - it had still not arrived after one more turn in 8 of 100 and 12 of 200: about 6%.
  - The tab then took its copy for current and wrote it over the other tab's write. Uploads lost a file in 3 of 4
    runs, and the Trash moves check in 2 of 4.
- **What was built** (ledger W-11, ruled by the controller):
  - Each directory record has a write counter in IndexedDB: database `muhkoo.vfs`, store `counts`, key
    `[commitment, recordId]`. Every tab of the origin shares it.
  - Under the record's lock, `begin` reads the count and marks it odd: a write is under way. Once the write has
    landed or failed, `bump` makes it even, and the lock is released only after that is stored.
  - A copy's counter is read before the copy is fetched. Under the lock, the copy is used as is only if the counter
    has not moved and no announcement of the record has been heard since. Otherwise it is re-read and its edits
    replayed.
  - Every move and delete check that relied on "no announcement heard" reads the counters after taking its locks:
    the delete's checks and its search for the other half of a move, both of a move's looks at its way, and
    `sweep`.
  - A counter that cannot be told means "re-read": IndexedDB missing or failing, or a write begun and never counted.
  - The announcement stays, as a hint. It drops cached copies, keeps listings fresh, and can add a re-read. It never
    spares one.
- **Cost:** two local IndexedDB transactions per locked write, and one read before each record fetch. No network
  request. One tab on its own still costs no extra round trip.
- **Tests:** the cross-tab unit suites run twice, with prompt announcements and with every announcement held back.
- **Checked in Brave on staging** (plan Task 8b): uploads 6 of 6 runs, 528 of 528 files; moves 6 of 6 counted runs;
  no warning. The order probe still showed 3 of 100 announcements late after one turn, and nothing was lost.

### 2. A move lock across tabs (Task 7, approved by Matt)

- Not in this spec. Matt asked for it on 2026-10-03, and approved how it is held on 2026-10-04.
- A move holds a lock on the file or folder it moves, `muhkoo:vfs:<commitment>:moving:<entryId>`, from before it
  marks the entry until it has taken it from where it was. A delete holds that lock on its target and on everything
  it read below it.
- Every request uses `ifAvailable`. A move or delete that finds the lock held fails with `VfsConflictError` and
  changes nothing. Nothing waits, so there is no lock order to keep and no deadlock.
- **The destination, shared, the whole way.** Matt asked on 2026-10-04 that a move also hold the folder it moves
  into, shared, so that a move into a folder another tab is deleting is refused. Building it showed the folder
  alone is not enough: a folder made since the delete read the tree is not among the delete's locks. So a move
  holds, shared, the folder it moves into and every folder above it but the root. Moves into one folder go ahead
  together. The controller ruled on that extension (W-7, W-8).
- Once it holds them, the move looks at the way to its destination again, and fails before it marks anything if a
  folder on it is gone or replaced.
- **Cost:** a move, rename or delete of a folder is refused while something is being moved into it, or below it.

### 3. A delete's claim (Task 7b)

- Ruled by the controller (W-10) to close a content-loss race: a move that started while a delete was searching the
  tree for the other half of an interrupted move could end up named with its content let go of.
- Within one namespace, in every runtime, Node and the CLI included: a delete claims its target at its first check,
  and everything it read below once its reads end. A move or rename of anything claimed, or of anything below a
  claimed folder, fails with `VfsConflictError` until the delete has finished.
- With a coordinator, the delete takes its move locks before that search, not after it.

### 4. Fallbacks where the browser will not coordinate (final review)

- **Web Locks refused** with a `SecurityError`, as in an opaque-origin iframe or on a site whose data the user has
  blocked: no lock. Writes, moves, deletes and the offline drain run without one, as in Node, and the tab does not
  ask again. Before this fix, `client.vfs` failed outright there.
- **BroadcastChannel refused:** the tab hears nothing. That is safe, as the counters decide.
- **IndexedDB:** each open and each transaction gives up after 3 seconds, which means "re-read". A hung IndexedDB
  then costs up to 3 seconds per read and 6 per write, instead of stopping the tab's `client.vfs`.
- A refused tab keeps its coordinator (W-13). Its counts and re-checks still run, so where IndexedDB is refused too,
  it re-reads each folder before writing it.

### What remains across tabs

In the CHANGELOG and the plan's Decision 9:
- A write that one tab could not count in IndexedDB, while another tab's counts work, can be lost. The tab warns.
- A delete of one half of an interrupted move can let go of the content the other half names, when another tab moves
  a folder holding that half during the delete's search (final review, Minor 8). A W2 follow-up.
- A save into a folder that another tab is deleting, or has just deleted unheard, can end up in no listing with its
  storage in use.
- A hung offline replay keeps the drain lock: the other tabs leave the queue to it, and nothing queued is replayed
  until that request fails or its tab closes.
- Signed off: a hung PUT, a skipping tab's early `SYNC_COMPLETE`, history records staying last-writer-wins.
- Other devices, the CLI and Web Workers: W2.

**Verified:** Task 8c, one more Brave pass on the final build (W-14), was green on 2026-10-05, including a tab
with site data blocked. Cloud Drive and the IDE must handle `VfsConflictError` from a delete before they move to the
release. Release only on Matt's ask.

## Interfaces

No new public name. Exported types gain optional members: `VfsNamespaceDeps.coordinator?`,
`OfflineManagerDeps.locks?` and a second argument to the `OutboundQueue` constructor. Their types are internal.
- `VfsNamespaceDeps.coordinator?: VfsCoordinator`, from `src/vfs/coordinator.ts`, which nothing re-exports. As built,
  its members are:
  - `lock(id, fn)`: the record's lock. The coordinator builds the lock name from the record id;
  - `announce(id)`, `onAnnounce(handler)` and `listen()`: the announcements, now a hint. `handler(null)` means some
    may have been missed;
  - `counters(ids)`, `begin(id)` and `bump(id)`: the write counts (Amendments, 1). None of them rejects;
  - `holdMoving(id, shared?)`: the move lock (Amendments, 2).
- The browser build wires it to Web Locks, BroadcastChannel and IndexedDB (`src/core/crossTab.ts`). Node and tests
  leave it undefined (today's behaviour) or pass a fake.
- The names, all internal: the lock and channel above; the move lock `muhkoo:vfs:<commitment>:moving:<entryId>`; the
  IndexedDB database `muhkoo.vfs`, store `counts`, key `[commitment, recordId]`.

## Testing

- **Unit (vitest, a fake coordinator shared by two `VfsNamespace` instances over one store, simulating two tabs):**
  - two instances writing different files into one folder at once: both entries end up stored;
  - an announcement marks the other instance's cached copy stale, and the next mutation re-reads it;
  - with no coordinator: unchanged behaviour (the existing suites stay green);
  - coalescing: 20 concurrent `writeFile`s into one folder send at most 2 record PUTs, and every write resolves
    with its entry stored;
  - a failed combined write rejects every edit that rode on it, and a retry succeeds;
  - the offline drain: two managers sharing one store, with a fake lock, replay each entry once;
  - node ids: two managers over one store get distinct node ids sharing one prefix, and HLCs from them never tie.
- **Browser, in Brave (Playwright), two tabs of a staging app:** both tabs write into one folder within the same
  second, and both files are in the listing after a reload. Use Cloud Drive staging: upload in both tabs at once.
- **Existing suites** (`tests/vfs`, `tests/vcs`, `tests/offline`) stay green.

## Rollout

- The connect release after the key-prefix work, with a CHANGELOG `### Fixed` section ("two tabs writing to one
  folder no longer lose each other's files").
- Cloud Drive and the IDE pick it up by moving to that version. Release only on Matt's ask.
  - *As built, each must first handle `VfsConflictError` from a delete: see Amendments, "Before release".*

## Out of scope

- Across devices, and the CLI against a browser: W2 (server compare-and-swap).
- Workers, a shared socket, durable uploads, parallel transfers: W3–W6.

## Risks

| Risk | Mitigation |
|---|---|
| A tab holding a lock is frozen (bfcache), which stalls other tabs' writes to that record | Hold the lock only for read, edit, send and settle, never across user think time. *Amended (plan Decision 2, signed off): only the wait for the lock is bounded, at 30 seconds, after which a tab gives up with `VfsConflictError` and writes nothing. A send timeout would let a late PUT land over the next tab's write, so a hung PUT keeps its lock until it fails. Task 13's "a hung put holds later writes" stays.* |
| A missed announcement (the channel isn't shared, e.g. a partitioned iframe and a top-level tab) | Per-partition locks, channels and IndexedDB match per-partition storage. Cross-partition writers behave like separate devices: W2. *Within one partition, a missed or late announcement no longer matters: the write counter decides (Amendments, 1).* |
| An announcement reaches a tab after it is granted the lock (measured in Brave: about 6% of hand-offs, even after one more turn) | *Added in execution.* The write counter, stored before the lock is released and read under it, decides whether a copy is current. The announcement is only a hint (Amendments, 1). |
| The browser refuses Web Locks, the channel or IndexedDB, or IndexedDB hangs | *Added in execution.* No lock, nothing heard, or "re-read" after 3 seconds; `client.vfs` keeps working (Amendments, 4). |
| One tab's write cannot be counted while another tab's can | *Added in execution.* The writing tab warns that the write may be lost, and the CHANGELOG lists it. Not closed in W1. |
| The lock adds latency | `navigator.locks` is local and sub-millisecond. The re-read happens only when another tab wrote. *As built, also when the count cannot be told; and each locked write adds two local IndexedDB transactions, each record fetch one read, each bounded at 3 seconds.* |
