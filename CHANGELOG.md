# Changelog

All notable changes to `@muhkoo/connect` are documented here. This project
follows semantic versioning (pre-1.0: new backward-compatible features bump the
minor, fixes bump the patch/alpha).

**Releasing: `npm run release`, not `npm publish`.** Publishing with `--tag alpha`
alone does not move `latest`, and pre-1.0 there is no stable line for `latest` to
protect — it already points at an alpha. Leaving it behind means a plain
`npm install` keeps handing out an old SDK: `latest` sat on 0.13.2-alpha.0 for the
whole 0.14 line, so every default install, including the `npx -y @muhkoo/cli` in
the preview deploy script, ran without shard batching or `loginWithDevice`.
`npm run release` publishes and moves both tags together.

## 0.15.0-alpha.5 — Payment refusals you can act on, and `client.app.access()` (2026-10-10)

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
  as the Free tier's quota refusals, stays the error it was before (`HttpError` from the namespaces, a plain `Error`
  from the lower-level clients). It comes from `client.kv`, `client.db`, `client.vfs`,
  `client.space.createSpace`, file uploads (`client.storage`, a Space's or a room's files), and from the lower-level
  `ShardClient`, `SharedSpaceClient` and `PersonalSpaceClient`. It does not come from a refusal sent over a Space's live
  socket, from a Space's keyring requests (admitting a member, which still fail with a plain `Error`), or from
  `client.functions.invoke`, which returns the raw `Response`. It is exported from all three builds.
- **`client.offline.resume()`** sends what the offline queue holds for the signed-in user now, as a reconnect does, if
  it holds anything. It also runs the catch-up tasks (Space history paging), as a reconnect does. `client.app.access()` calls it each time it answers `allowed`. `client.offline.queue.waiting()`
  lists those writes: the signed-in user's, and any that carry no user (see Fixed). `pending()` still counts every
  user's, so use `waiting()` for an "unsaved changes" badge: with `pending()`, another user's writes, which cannot be
  sent while you are signed in, would keep the badge on.

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
  `code` and `dropped: false`. Other 4xx refusals are still dropped, as before, with `dropped: true`.
  - `dropped: false` means the write is kept, not lost: it is still in the queue and will be sent.
  - The sync still ends with `SYNC_COMPLETE`, and the status goes back to `online`, while those writes wait: a drain
    stopped by a payment refusal emits it too. An app learns that writes are waiting from the `SYNC_ERROR` with
    `dropped: false`, or from `client.app.access()`, not from `SYNC_COMPLETE`. Do not call `client.app.access()` from a
    `SYNC_COMPLETE` handler: each `allowed` answer starts another sync, so the two would call each other.
  - For about a minute after a payment, `client.app.access()` can answer `allowed` while the server still refuses the
    write. The sync it starts is then refused again, and the write waits for the next reconnect or the next `allowed`
    answer. Ask again a minute later if writes are still waiting (`client.offline.queue.waiting()`).
  - Earlier versions drop these writes. The accelerator now refuses writes in any app whose owner's payment is past
    due, on paid tiers too, which never got a 402 before. Apps that queue writes offline should move to this version.
  - A message queued for a Space is sent over its socket, and a refusal there is not seen: under an owner past-due
    block it is lost, not kept (v1 scope).
  - A background upload (`Space.putFile` with `backgroundUpload`) refused for payment is queued, as before. Its bytes
    live only in the browser's cache until it lands. If the browser evicts them, the replay drops the entry, and the
    file's manifest names shards the server never received.
- **A queued write is sent only under the session of the user who made it.** Every tab of an origin shares one offline
  queue, and a replayed write is sent as whoever is signed in. A write left queued when its user signed out could be
  sent, on the next sync, into the space of the next user to sign in on that device, and a write to a fixed key could
  overwrite theirs. Each queued write now records whose it is, and a sync sends only the signed-in user's; another
  user's waits, untouched, until they sign in on that device again and a sync runs (a reconnect, or `client.app.access()`
  answering `allowed`); nothing sends on sign-in by itself. A write queued by an earlier version, or while no
  one was signed in, records no user. It is still sent under whoever is signed in next, as before, so it can reach the
  wrong user's space if that is not who made it.
- **A file upload or commit made with a stale session now re-establishes the session, once.** Shard uploads and the
  commit after them go through the same silent re-authentication as every other request. Before, a 401 came straight
  back: an upload failed with a plain `Error`, and a commit tried three times with the same session, then gave up with
  a warning and took no reference to the file's shards. An upload or commit whose session cannot be re-established now
  gives up after that one try. A paid-only app refuses an upload made without a valid session (`401 session_required`),
  so in a tab left open for over a day every upload would fail. Reads are unchanged.

## 0.15.0-alpha.4 — Writes across tabs that can't overwrite each other (2026-10-06)

Published with `npm run release`: both `alpha` and `latest` point at it.

### Changed

- **A burst of saves into one folder costs far fewer writes of its directory record.** While a write of a folder is in
  flight, `client.vfs` now sends every further edit of that folder together, in the next write, which carries them
  all. So twenty saves made at once cost two writes, not twenty. Saves that finish at different moments, as uploads of
  files of different sizes do, share a write only with the others made while the same write was in flight: they can
  cost more than two writes, but never more than one each. Each save still resolves when the write carrying it lands.
  If that write fails, every save that rode on it fails with the same error. Before this, uploading 20 files into one
  folder sent 20 writes of the folder; each one is a billed `kv_write`, and on the Free tier they count toward its
  1,000 writes a month.
- **`VfsNamespaceDeps`, `OfflineManagerDeps` and the `OutboundQueue` constructor take new optional members:**
  `coordinator`, `locks`, and a second `options` argument. `Client` fills them in a browser tab. Their types are
  internal, and code that builds these objects itself can leave them out, which keeps the previous behaviour.

### Fixed

- **Two tabs writing to one folder no longer lose each other's files.** In a browser, `client.vfs` now writes each
  folder's record under a lock shared by every tab of the app on the device (Web Locks), and tells the other tabs which
  folder it wrote (BroadcastChannel).
  - Before it writes a folder, a tab reads it again if another tab has written it since, even when the other tab's
    message about that write has not arrived yet: each tab records its writes in IndexedDB before it lets go of the
    lock. It then makes its own pending edits to what it read. An edit that no longer applies fails with
    `VfsConflictError` instead of overwriting, and the other edits in the same write are still stored. For example, a
    save of a name the other tab took first fails.
  - Saves into a new folder wait until the folder is named in the store. Two tabs uploading a folder of the same name
    into one place at once end up with every file in one folder.
  - One tab on its own makes no extra requests. Where IndexedDB cannot be used, each write of a folder first reads it
    again, and a move, a delete or a sweep reads again every folder it checks. `client.vfs` gives up on each call to
    IndexedDB that has not answered within 3 seconds, and goes on the same way. So while IndexedDB does not answer,
    each read of a folder takes up to 3 seconds longer, each write of a folder up to 6, and a move, a delete or a
    sweep up to 6 more besides, for its checks. An IndexedDB that is slow to open is used as soon as it opens, if it
    opens within 30 seconds. If an open never answers, each call gives up within 3 seconds, and once the open has gone
    30 seconds without an answer, the next call tries a new one, which is in turn given up on after 30 seconds if it
    never answers either. So while IndexedDB never answers and `client.vfs` keeps calling it, the tab leaves behind
    at most one more open that never settles every 30 seconds.
  - A tab that waits 30 seconds for another tab to finish writing the same folder gives up with `VfsConflictError`
    and writes nothing.
  - Where the browser refuses a page Web Locks or a BroadcastChannel, as it can in a sandboxed iframe or on a site
    whose data the user has blocked, `client.vfs` works without them. Refused Web Locks, a tab orders its own writes
    only, as in Node, and no lock refuses a move or delete because something "is being moved or deleted": none of
    the refusals of that kind listed below for a browser happens there, between tabs or within one tab. A move or
    rename of something a delete in the same `Client` is deleting is still refused, as in Node. Of the move and
    delete outcomes for a browser, only the checks that need no lock still apply there. A move of something, or into
    a folder, that was deleted or replaced just as the move began, a delete of something in a folder that another tab
    deleted, moved or replaced just as the delete began, and a delete while a move or rename in the same tab moves a
    folder on its way, fail with `VfsNotFoundError` or `VfsConflictError`. A recursive delete of a folder that
    something was saved or moved into after the delete read it fails with `VfsConflictError`. Where the browser
    refuses IndexedDB too, as it does on a site whose data is blocked, each write of a folder first reads it again, a
    move, a delete or a sweep reads again every folder it checks, and `client.vfs` logs a console warning, once per
    `Client`.
  - Node, Web Workers, and runtimes without Web Locks keep the previous behaviour, except that saves into a new folder
    wait there too until the folder is named. Before, if that write failed, later saves went into a folder nothing
    named.

  Not fixed yet:
  - Writes from another device, from the CLI, or from a client in a Web Worker can still race a browser tab.
  - A request that never finishes holds its folder's lock: until it fails or the tab is closed, the other tabs'
    saves into that folder fail with `VfsConflictError` after 30 seconds each, and that tab's own later writes of
    the folder wait behind it.
  - A file's version history is still last-writer-wins between tabs.
  - A write that a tab cannot record in IndexedDB, while another tab of the app can, may be lost if that other tab
    writes the same folder before it hears of the write. `client.vfs` logs a warning, once per `Client`, when this
    can happen.

- **A move of a file or folder can no longer end up purged, or named in two places, when a delete or a second move
  of it overlaps, within one `Client`.** 0.15.0-alpha.3 listed the first three as not refused yet. `client.vfs` now
  refuses all of them with `VfsConflictError`:
  - a second move of something that is still being moved;
  - a delete of it while it is being moved;
  - a recursive delete of a folder while anything inside it is being moved, or has been moved or marked for a move
    since the delete read it;
  - a move or rename of a file or folder that a delete is still deleting, or of anything inside it. It now fails at
    once, in Node too, from the moment the delete has found it until the delete has finished. A move that began
    before that goes ahead, and a delete that finds it still under way fails instead.

  Before this, two moves could both succeed and leave one file named in two places, with one content reference
  between them, so deleting either copy freed the other's content. A delete could also purge a folder from the
  place a move had just put it. A move that loses its destination to another write no longer leaves the file marked
  as half of a move. Across two tabs: see the next entry.

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
  or with `VfsConflictError`, and moves nothing. In a browser, a recursive delete of a folder that something was saved
  or moved into after the delete read it now also fails with `VfsConflictError`; trying again deletes it, though it can
  take more than one try. In a browser, a delete of something in a folder that another tab deleted, moved or replaced
  just as the delete began now fails with `VfsNotFoundError` or `VfsConflictError` and changes nothing, where it could
  write that folder back and let go of content that a copy or a commit still used. A delete takes its locks as soon as
  it has read what it deletes, before it looks through the tree for the other half of an interrupted move, so a move in
  another tab that starts during that look now fails too, where the file it moved could end up in its new place with
  its content let go of. Node, the CLI, Web Workers, and runtimes without Web Locks keep the previous behaviour.

  The locks also apply between operations in the same tab, so in a browser three more outcomes change there. Each
  refusal says the file or folder "is being moved or deleted":
  - Of two deletes of one file or folder running at once, the second now fails with `VfsConflictError`, where it
    failed with `VfsNotFoundError`. Code that took `VfsNotFoundError` from a delete to mean "already gone" gets this
    instead. Trying again once the first delete has finished gives `VfsNotFoundError`.
  - A move into a folder that a delete in the same tab is still deleting, or into a folder inside it, can now fail
    with `VfsConflictError`, where it went into a new folder of the same name.
  - A move into a folder, and a move or rename of that folder or of a folder above it, at once in the same tab:
    whichever asks second now fails with `VfsConflictError`. Before, both went ahead, and the move into the folder
    either landed in it at its new place or failed with `VfsNotFoundError` after it had landed.

  One more same-tab outcome changes in a browser, for the same reason as the delete above: a delete of a file or folder
  while a move or rename in the same tab moves a folder on its way now fails with `VfsNotFoundError` or
  `VfsConflictError` and deletes nothing. Before, and still in Node, it deleted the file from its new place. Trying
  again at the new path deletes it.

  Not fixed yet:
  - A save into a folder that another tab is deleting at the same moment can succeed and still be gone afterwards, as
    if it had landed just before the delete. So can a save made just after another tab's delete that this tab has not
    yet heard of. Unlike a delete, it does not let go of the saved file's content, and `sweep` does not either, so
    that storage stays in use.
  - A delete of a file or folder that an interrupted move left named in two places can let go of the content the
    other place still names, when another tab moves a folder that holds that other place while the delete is looking
    through the tree for it.
  - A tab the browser freezes in the middle of a move keeps that file's or folder's lock, and its share of the locks
    of the folder it is moving it into and of the folders above that one, until it resumes or closes; meanwhile other
    tabs' moves and deletes of any of them fail with `VfsConflictError`.
  - Moves and deletes from another device, from the CLI, or from a client in a Web Worker are not ordered against a
    browser tab's.
  - Two tabs deleting overlapping folders at the same moment, or moving two folders each into the other, can both
    fail with `VfsConflictError`. Trying again works.

- **Two tabs coming back online no longer replay the same queued offline writes.** Every tab of an origin shares one
  offline queue, and each tab replayed all of it. A tab now drains the queue only while it holds a lock that no other
  tab holds (Web Locks). A tab that finds another tab draining leaves the queue to it, and the draining tab carries
  on until the queue is empty, so what the other tab queued meanwhile is not left behind. The tab that left it may
  report its sync complete before those writes have landed. In Node, in a Web Worker, and where there are no Web Locks
  or the browser refuses them, nothing changes. Not fixed yet: a replay whose request never finishes keeps the lock,
  so until that request fails or its tab is closed, the other tabs leave the queue to it and nothing queued is
  replayed. Before, only that tab's own drain stalled.

- **Two tabs no longer stamp writes with the same HLC.** Every tab of a device used one HLC node id, so two writes made
  in the same millisecond by two tabs could carry identical stamps, and the server dropped the second of two equal
  stamps. Each tab now uses `<device id>.<tab suffix>`. The stored device id, the shared clock state and every stamp
  already stored are unchanged.

## 0.15.0-alpha.3 — `client.kv.keys`, prefix listing, and folder edits that can't overwrite each other (2026-10-03)

Published with `npm run release`: both `alpha` and `latest` point at it.

### Added

- **`client.kv.keys(prefix?)`** returns the full keys in the signed-in user's personal space that start with `prefix` (every key when it is omitted), paging through the server. Values are not fetched. `muhkoo kv ls` uses it.

### Changed

- **`client.kv.list(collection)` is filtered on the server.** It sends the collection as a prefix and follows the server's cursor, so a list no longer downloads every key in the personal space, and the server no longer reads every stored value to answer it. This needs the accelerator's key index, which is on staging and reaches production in a later accelerator deploy; until then the server returns every key and the SDK filters them, as before. The signature and the result are unchanged. Against a server older than this change, which ignores the prefix, it filters locally as before. A server that repeats a cursor is now an error, with offline on too, instead of a list that never ends.
- **`client.vfs.sweep()` and abbreviated commit hashes in `client.vcs` ask the server only for their own keys**: `vfs/`, and `vcs/<project>/obj/<abbreviation>`, instead of every key in the personal space. `VfsStore.list` takes an optional `prefix`. A store that ignores it keeps working, because both callers still filter what they get back.

### Fixed

- **An overwrite in progress while a write of the same folder fails can no longer drop another file saved to that
  folder at the same time.** `client.vfs` makes every edit of a folder to one in-memory copy of it. Before this, a
  save that held the folder while it stored the old version's history could write an older copy over a file saved
  in the meantime. A save, restore, move, copy or delete whose file or destination another write changed in the
  meantime now fails with `VfsConflictError` rather than overwriting that write. Some moves and deletes that overlap
  a move are not refused yet; the next entry lists them. Two deletes of one folder at once no longer free content
  that a copy elsewhere still uses. After `clearCache()`, reads and writes begun before it no longer put the
  previous identity's folders, or its root key, back in the cache.
- **Two moves of one file started together can no longer both succeed, and a recursive delete that read a folder
  just before a move of it began can no longer purge it from its new place.** `client.vfs` now refuses the second
  move, or the delete, with `VfsConflictError`. Before this, both succeeded. Two moves left the file named in both
  destinations with one content reference between them, so deleting either copy freed the other's content. The
  delete removed everything in the folder from its new place. Not refused yet, and still able to lose data in the
  same ways:
  - a second move, or a delete, of a file or folder that starts after a move of it has begun writing;
  - a recursive delete of a folder above the one being moved, when the two overlap.
- **`--json` output (and piped output) no longer starts with the SDK's `initialized` line.** The
  `[@muhkoo/connect] initialized — v…` build stamp is now printed only in a browser, where it goes to the developer
  console. Outside a browser it went to stdout, in front of a program's own output, so `muhkoo kv ls --json | jq`
  failed to parse and `muhkoo kv ls | wc -l` counted the line as a key.

## 0.15.0-alpha.2 — folder writes keep their files when a write fails; large reads no longer fail (2026-10-03)

Published with `npm run release`: both `alpha` and `latest` point at it.

### Fixed

- **A folder read no longer returns an older copy while your own write of it is in flight.** `client.vfs` now
  waits for a pending write of a directory before fetching it again, so an edit made right after another
  edit of the same folder can't overwrite it with stale data. Writes from other tabs or devices are still
  last-writer-wins.
- **When a folder write fails while other writes to that folder are queued, reads no longer pick up an older copy,
  so those queued writes keep their entries.** When a write of a folder failed while other reads of it were
  waiting, `client.vfs` could fetch two separate copies of the folder. Saving one copy over the other dropped files
  that had saved successfully. Reads that wait now share one copy, and they also wait for any write of the folder
  queued in the meantime. One case remains and is fixed in the next release: an overwrite in progress while a write
  of the same folder fails.
- **Reading several large files at once no longer fails with "chunk unrecoverable".** Shard reads made at the same
  moment go to the server as one batch, and the server refuses a batch above 24 MiB. About 25 one-MiB shards, a few
  large files read together, were enough to trigger it. Batches are now split by size, using the shard size in the
  file's manifest, and a batch the server still refuses is split in half and asked for again.
  `ShardClient.getShard(hash, { size })` takes that size as an optional hint.

## 0.15.0-alpha.1 — upload progress for `vfs.writeFile`; directory writes no longer undo each other (2026-10-03)

Published with `npm run release`: both `alpha` and `latest` point at it.

### Added

- **`vfs.writeFile(path, data, { onProgress })`** reports upload progress as `(done, total)`, the same callback `space.putFile` takes. `VfsContentStore.write` gains a matching optional third argument; stores that ignore it keep working.

### Fixed

- **Two writes of one directory no longer undo each other.** `client.vfs` now sends a directory's writes one at a time, in the order they were made. The personal space keeps whichever of two in-flight writes it applies last, so a write made first could land last and undo the later one. Two examples: a file deleted forever from the Trash while the move that put it there was still being written came back; and one of two files saved into a folder at once could vanish.

## 0.15.0-alpha.0 — a reload no longer hides your messages; signed private channels (2026-10-02)

**Published under the npm `alpha` tag only. `latest` stays on 0.14.0-alpha.9.**
- Install it explicitly: `@muhkoo/connect@0.15.0-alpha.0`.
- This release ships part of step S.
- Do not move `latest` to it until the server side (step I) is live in production. Until then, creating a private channel fails against production (public channels, files and the CLI are unaffected).
- It also waits on step S's `withAppKey` and the portal migration (spec §8.1 rows S and P). Without them, portal's per-app Spaces break on upgrade (see "Changed (breaking)").

### Fixed

- **A reloaded page no longer hides your earlier messages from everyone else.** A locked session (signed in, but the account secret not in memory) used to take part with a temporary key. Other members' SDKs then dropped every message you had signed before. A locked session now never takes part:
  - `client.space.get()` returns a Space with `admission: "locked"`;
  - `connect()` throws `IdentityLockedError`;
  - `createChannel` and `createSpace` with messaging throw it too.

### Added

- **Signed membership for new private channels.** Covers:
  - the genesis and `ec(0)` at creation;
  - `space.add`, `remove`, `setRole`, `leave`, `membership()` and `onMembership`;
  - the pinned owner and member identities;
  - `admission` and `onAdmission`;
  - `client.trust`.

  Removal cuts a member off at the relay. The key is not rotated in this release.
- **Chat-key certificates on join requests.** Join requests now carry a certificate by the account IK over the exact chat keys posted. The relay verifies it and binds the member's IK. Admitting clients and the keeper do not check it yet (step S), so this build does not by itself stop a relay from substituting chat keys.
- **`refuse=close` and a terminal 4403.** Opening a private Space's WebSocket now asks the relay to refuse a denied connection with a close, `NOT_MEMBER_CLOSE_CODE` (4403), instead of the ordinary drop a `WSTransport` retries forever. The transport treats it as terminal — no reconnect timer — and the Space confirms the reason with `GET /keyring/state` before deciding: a 403 means `not-member`, a 401 means `locked`, anything else resumes at most once a minute. Without this, a removed member's tab kept minting fresh tickets and reconnecting in a loop instead of finding out it had been cut off.
- **Hosted sign-in `returnTo`.** `client.auth.hosted.login({ ..., returnTo })` carries a same-origin path through the OAuth round trip and hands it back from `handleCallback()`, so an app can send a user to `/login`, through the hosted flow, and back to the page — a locked private channel, for instance — they started on. `returnTo` is checked with `isSameOriginPath` both before it is stashed and again when it comes back, so a tampered `sessionStorage` entry is dropped rather than followed.

### Changed (breaking, typed seams)

- **No temporary key when the chat-key vault fails.** `client.space.get`, `joinSpace`, `joinChannel`, `joinByInvite`, `createChannel` and `createSpace` throw `IdentityUnavailableError` when the saved chat keys cannot be loaded; they used to carry on with a temporary key. `retryable` says whether trying again can help. A files-only Space needs no identity: `createSpace({ messaging: false })`, `get(id, policy, { messaging: false })` and the `client.vfs` content Space. Note: an unlocked files-only Space is now built without a keyring, so `space.keyring` is `undefined`.
  - Its `join()` and `create()` throw.
  - `connect()` takes the keyring-less path.
  - It used to carry a keyring.
- **A locked session never takes part.** `get`, `joinSpace` and `joinChannel` return a Space with `admission: "locked"`: its `join()` resolves `false` and its `connect()` throws `IdentityLockedError`. `joinByInvite`, `createChannel` and `createSpace` with messaging throw `IdentityLockedError`. A Client with no session (app key only), and a Client restored from a stored session, hold no seed, so they are always locked. Portal's per-app `spaceClient()` is such a Client: its invite join and `ensureTeamSpace` break on upgrade, and this build has no `withAppKey` to replace it.
- **`connect()` reads the member list before the ticket.** Every Space, public ones included, now sends `GET /keyring/log` before `POST /api/ws-ticket`. `connect()` can reject with `IdentityLockedError` (a 401 that survives the client's silent re-auth) or `AdmissionDeniedError` (a 403). The 403 includes an unlogged private Space opened by a non-member, which used to open its socket and fail later, at `join()`, with a plain `Error`.
- **`refuse=close` on every socket.** Every Space's WebSocket URL, public ones included, carries `refuse=close`, and the transport treats a 4403 close as terminal.
- **`DISCONNECTED` carries the close.** The `DISCONNECTED` event of `WSTransport` and `BroadcastChannel` now carries `{ code, reason }` when the socket reported a close code. It used to carry `undefined`.
- **No key rotation on a new private channel.** On a private channel created by this build (one with a signed member list), `space.rotate()` throws `SpaceTrustError("log-refused")`, and `space.admit()` and `SpaceKeyring.admit()` throw for anyone who is neither a current member nor the keeper. A `historyPolicy: "rotate"` private channel created by this build therefore never rotates; removal cuts a member off at the relay instead.
- **`JoinRequest.keyCert`.** Join requests posted by this build carry an optional `keyCert` (`ChatKeyCert`). Code that builds, compares or re-serialises join requests sees the new field.
- **New public names.** Values: `IdentityLockedError`, `IdentityUnavailableError`, `SpaceTrustError`, `AdmissionDeniedError`, `KeyringHttpError`, `NOT_MEMBER_CLOSE_CODE`, `NOT_MEMBER_RECHECK_MS`, `isSameOriginPath`. Types: `AdmissionState`, `MemberView`, `ChatKeyCert`, `MembershipEntry`, `SpaceTrustCode`. Members: `HttpClient.fetchWithRecovery`, `KeyringClientDeps.fetchWithRecovery`, and the `messaging` option of `client.space.get`. They are frozen once released. `KeyStore` methods, which the workers surface exports too: `forget`, `markVaultBacked`, `isVaultBacked`, `replaceOwnKeyPair`, `generateKeyPair`, `importKeyPair`, `exportKeyPair`.
  - `markVaultBacked` exists for tests. SDK code marks a pair only through `replaceOwnKeyPair`.
  - Calling `markVaultBacked` yourself vouches for whatever pair the tab holds.
- **Opening a Space can replace an ephemeral DM pair minted while locked.** The vault pair takes its place, so a DM already using the minted pair signs with a key its peer has not seen. DMs move to the stable identity in a later release.

### Corrected

- **Email and Google factors are not split-key: Muhkoo can recover an account that has one.** 0.7.0-alpha.4 described the gated wrap key, `HKDF( OPRF(K1, input) ‖ OPRF(K2, input) )`, as two evaluations in separate trust domains, so that no single server-side compromise could derive it offline. That is not true. Muhkoo operates both keys, the accelerator relays K2's evaluation to the client verbatim without checking it, and the vault stores the email address or Google `sub` that is the OPRF input. The second key protects a stolen vault blob against an outside attacker only, not against the operator or a compromise of the accelerator. Password, passkey, recovery-phrase and `device` factors are unaffected: Muhkoo cannot unwrap those copies. The comments on `enrollEmailFactor`, `recoverWithEmail`, the Google methods, `AuthClient.oprfEvaluateGated` and `src/auth/gatedFactor.ts` now say so. No code changed. An app with its own enroll UI for these factors should tell users, as the hosted sign-in does.

## 0.14.0-alpha.9 — records this SDK did not write, read safely (2026-09-24)

### Security

Any app a user signs into holds the master seed, so it can write any directory record and any repository object (see 0.13.0). A second review found records that crash, hang or quietly mislead the SDK. These are the read-side fixes.

- **`walk` (and so `glob`) can no longer be made to run out of memory by a cycle or a fan-out.** Two things let it. Its cycle guard was a set of *paths*, and a directory whose two entries both point back at itself makes a fresh path at every level — `/loop/a`, `/loop/b`, `/loop/a/a` — so the guard never fired. Two records of about 120 bytes crashed `vfs mount`, `vfs tree` and `vcs status`. The guard now works on directory *identity* along the current path: a directory that is one of its own ancestors is skipped, with a warning. A directory reachable from two parents, as an interrupted `rename` can leave one, still appears under both. And the walk listed sibling directories eight at a time *per directory* — eight per level, multiplying down the tree — so on a planted fan-out, whose records are cached after one fetch each, every visit up to the entry budget was in flight at once, each holding its own copy of the ancestor set. Twenty-nine records inside both default budgets exhausted a 3GB heap, and 25 records of `{a, b}` crashed `vcs status` and `vcs commit` on anything under 3GB. The walk now goes one directory at a time, depth first, holding only its output and its current path, with one pool of 64 record fetches for the whole walk reading ahead of it. What it returns, and the order, are unchanged. The pool is a fixed total, where the old walk had eight fetches per directory being listed — up to 225 at once on a 333-directory project — so a cold walk of that project takes about 0.37s at 30ms a fetch, against 0.25s before. The worst planted fan-outs at the default budgets — `vcs status` of a planted HEAD against a planted working tree, and `vcs merge` of three planted sides, among them — now peak under 300MB of heap, and the test suite runs each in a 512MB one. Many distinct records still can run it out of memory: see the next entry.
- **Not fixed: enough distinct records, or large enough ones, can still run a walk out of memory.** The namespace keeps every directory record it reads, for as long as it lives, unless a change to that record or `clearCache()` drops it: that cache is what lets a file tree re-list, and a mount walk again, without going back to the network. A walk reads every directory below where it starts, so what it leaves held grows with the number of distinct records and their size, and nothing limits a record's size short of the store's value limit of about 2MB. Whoever holds the master seed can plant them: a few hundred records of about 1MB each run a walk — and so `vfs mount`, `vcs status` and `vcs commit` — out of a 512MB heap, a few thousand of 1.4MB run out Node's default heap of about 4GB, and half a million empty directories, inside the entry budget, ran out the 512MB heap too. The same holds for the whole-tree read that looks for the other half of an interrupted move, or for the key of a history its directory's key does not open: it has no entry budget, and runs on a save, `history` or `restore` of such a file, on `sweep`, and on a delete of a marked entry. That is a denial of service by someone who can already delete everything, and it is accepted as one. A cache bounded by count and size was tried and taken out: past its bound every walk fetched the whole tree again — a `vfs mount` pass over 5,000 directories took 23–25s and about 10,000 gets at 30ms a get, against 0.06s and none — and a directory it forgot while a save was using it could lose one of two saves made into it at once.
- **A tree too large or too deep to read throws `VfsLimitError` instead of returning part of it.** Records can name the same subdirectory twice without any cycle, doubling the paths at every level, so the walk now has a budget of entries — half a million by default — and of path text, 32 million characters by default, because a name may be 255 bytes and one path ~16KB: forty-odd small records of long names stayed under the entry budget and still asked for gigabytes. Half a million is a very large real project; a million fitted one walk in 512MB, but not `vcs status`, which holds both a commit's paths and the working tree's changes. Set both with `limits: { entries, pathChars }` on `VfsNamespaceDeps` when constructing `VfsNamespace` yourself; `Client` does not pass them, so `client.vfs` always has the defaults. Past either, or past 64 levels, it throws, and the error's `at` says where, since walking the tree to find out would stop at the same place. Returning the part it had read tells a sync that everything else was deleted, which is also why the depth ceiling no longer stops quietly.
- **A long walk lets the rest of the program run.** With every record cached, a walk never waits on anything, so timers, input and signal handlers waited for it instead: a frozen tab, or a `vfs mount` that ignored Ctrl-C. It now yields every few thousand entries, and the yield parks the whole walk — one that parked a single branch while every other branch in flight carried on gave a timer 0–1 turns in seconds. It yields with `setImmediate` or, in a browser, a `MessageChannel` message, and `setTimeout` only when the runtime has neither: a browser runs a chained timer at most once a second in a background tab, and once a minute after five minutes. Not `scheduler.yield()`, although Chromium has it: its continuation runs ahead of timers and messages already queued, and a walk yielding through it gave a 1ms interval no ticks in 2s. Reading history for `status`, `diff` and `checkout`, `merge`'s pass over every path, the whole-tree read `sweep` makes, and `copy`'s check of the tree before it writes, yield the same way; `merge` of three planted sides went over a second without one. A walk that has failed stops fetching, where its workers used to carry on through every remaining sibling directory in the background, and a directory that is its own ancestor is reported once per walk rather than once per path that reaches it.
- **A malformed directory record throws `VfsCorruptRecordError`,** naming the record's id and the path it was reached through, instead of a `TypeError`, `SyntaxError` or bare decryption failure from inside `list()` that failed the walk of the entire tree. Malformed means: a stored value that is not a sealed record, one that does not decrypt with the key its parent holds or decrypts to something other than JSON, or a record that is not an object, has a format version other than 1, or has `entries` missing or not a map. It is never read as an empty directory — the next write would have sealed an empty record over the real one. `delete(path, { recursive: true })` still removes it, detaching it without clearing out a subtree it cannot read, and `sweep()` stops before deleting anything while a record is unreadable. The record id and version in the message are escaped, so a planted one cannot send control sequences to a terminal that prints it; for the root, which cannot be deleted, the message no longer suggests deleting it. The advice in this error and in `VfsLimitError` reads "remove it with a recursive delete" rather than naming the SDK call, since the CLI prints it to people who need `muhkoo vfs rm -r`.
- **An entry this version cannot read is hidden, not deleted.** An unknown kind (perhaps a newer SDK's), a file with no manifest or a manifest with no id, a directory with no usable key: it disappears from `list`, `stat`, `exists`, `walk` and `copy`, with a warning, but is written back untouched whenever its directory changes, so an older SDK no longer erases what a newer one stored. `writeFile` or `writeManifest` to that exact name replaces it; `rename`, `copy` and `mkdir` onto it are refused with `VfsConflictError`, as for any existing destination, and so is a checkout that needs the name. A recursive `delete` of that exact name removes it, detaching it without reading what it holds, and those refusals now say so; before, `delete` said the name did not exist, and the only way to clear it was to delete everything around it. `sweep()` refuses to run while one exists unless given `{ force: true }`, because it cannot tell what such an entry keeps alive.
- **An entry with an unusable name is set aside once per record.** It was filtered, and warned about, every time a walk passed through its directory, without being charged to the walk's budget, so one record reached many times cost minutes of work and a warning per entry per visit. It is now as hidden as an unreadable entry, including from `stat` and `exists` by its exact name, and still counts as a reference for `sweep()` and goes with a recursive delete of its directory.
- **`vcs` checks every object against its hash.** A stored object could claim any address, including its own, so a tree could contain itself, and `status`, `diff`, `checkout`, `switchTo` and `merge` hung without a word. An object that does not match now throws `VcsError`. Every object the SDK has ever written matches — the hashing has never changed. A forgery planted at the address of a tree about to be committed is overwritten rather than trusted.
- **Reading history has an entry budget too.** Trees whose every hash is genuine can still describe 2^60 files in sixty objects. Past the budget — half a million entries and 32 million characters of path by default, as for a walk, `limits: { entries, pathChars }` on `VcsNamespaceOptions` when constructing `VcsNamespace` yourself (`Client` does not pass them) — `status`, `diff` and `checkout` throw `VcsError` before touching the working tree. Identical subtrees are still listed under every name they appear at: `vfs cp a b` gives both one tree hash, and deduplicating by hash would have dropped `b` from status and checkout.
- **Tree entries are checked the way directory entries are.** A name that would land outside the project on checkout (`../x`, `..`), and an entry of unknown kind or with a malformed hash or manifest, is skipped with a warning.
- **`copy` checks the whole tree before it writes anything.** It checked as it went, so a copy that was going to fail first wrote up to a budget's worth of records and took a reference to every file it passed, all left unreachable. A tree that names one directory in more than four places is refused as well: three records can otherwise describe 90,000 directories, each a separate write, while a real tree has a directory in two places at most, after a move that was interrupted.
- **A recursive delete never reaches above what it deletes.** It collected each directory under the target once, but never left out the directories *above* it, so an entry under `/junk` naming the root pulled the whole filesystem into the delete — every file's content released, every directory record deleted, the root's included — even under a name no listing shows. Two tabs racing renames can leave the same shape with no attacker at all. The root, and every directory on the way down to the target, is now left alone with a warning, as a walk skips it; an entry that is itself such a pointer is only detached.
- **An entry whose id this SDK could not have minted is hidden.** An id becomes a store key, and `Client`'s store puts the key in a URL: a lone surrogate made `encodeURIComponent` throw, and an id past the server's 2048-byte key limit got a 500 — from every walk above the entry and every attempt to delete it, for good. An id must now be 1–64 characters of `A–Z a–z 0–9 _ -` (the SDK mints up to 22 letters and digits). Anything else is hidden like any entry this version cannot read: never fetched, and gone with a recursive delete of its directory. File ids too, which name history records.
- **Numbers in a stat are numbers.** `mtime`, `size` and `versions` came out of the record as they were, so a `VfsStat` could hold an `mtime` of `"yesterday"` or `1e300`, and `muhkoo vfs ls` died formatting it. A time a `Date` cannot hold, or a size or version count that is not a whole number of zero or more, now reads as 0 — in listings, walks, `stat("/")` and `history()` alike.
- **A value nested too deeply to write back is dropped when a record is read.** `JSON.parse` accepts nesting that `JSON.stringify` cannot write, so one such entry — hidden, even — made every write to its directory throw `RangeError`; at the root, every top-level create and delete. Entries and record fields nested more than 32 levels (the SDK writes five) are dropped with a warning, and a write that still cannot be stored throws `VfsConflictError` naming the directory.
- **A file's version history is checked the way a directory record is.** A version with no manifest, or one whose manifest has no id, is left out with a warning — `history` already skipped a version that was not an object and `restore` did not, so `restore(path, 0)` could mean a different version from the first one listed, and restoring one with no manifest wrote an entry that then vanished from every listing. A version nested too deeply to write back is dropped too: a history is written back on every save, so one such version made every `writeFile` and `restore` of the file throw `RangeError`, and a move to another directory throw half way, leaving the file in both.
- **`vcs` checks HEAD, branches, a pending merge and every commit it reads.** Only objects are hashed, and a hash-valid commit can still be any shape. A HEAD, branch ref, branch list or merge record of the wrong shape, a branch name that `branch()` would refuse — which now includes one over 200 characters, since a name is also a store key and a longer one got a bare server error from `status`, `log` and `commit` — and a commit whose parents are not a list of hashes, whose message or author is not text or whose time is not one a `Date` can hold now throw `VcsError` — instead of a `TypeError`, or, for a name carrying escape sequences, instead of reaching the terminal of whoever runs `vcs status`. Such a name in the branch list is left out with a warning rather than hiding every real branch, and creating a branch replaces a list that cannot be read at all; a HEAD that cannot be read is replaced by checking out a branch or commit with `discardChanges`; a branch ref that cannot be read, by creating the branch again at a commit; and a pending merge that cannot be read, which would otherwise stop every commit, is cleared by the new **`repo.abortMerge()`** — which also gives up on a merge that stopped for conflicts, leaving the working tree as it is. A stored value that is not a sealed record, does not decrypt, is not JSON or is nested too deeply to hash is a `VcsError` naming the object, not a bare `DOMException` or `SyntaxError`. Commit messages come back as written: escaping them for a terminal is the printer's job, and a message may hold newlines.
- **Writes stay inside the depth a walk reads.** A walk refuses anything more than 64 directories below where it starts, but writes had no limit, so a real tree written 65 deep under `/` was accepted and every walk of the root — every pass of `vfs mount` at its default root — failed from then on. `writeFile`, `writeManifest` and `mkdir` now throw `VfsLimitError` (`limit: "depth"`) for a directory more than 64 below the root, having written nothing, as do `rename` and `copy` of a directory when it, or anything in it, would land deeper than that. Either error names the destination, not the source. A copy measures everything as it checks the tree before writing. A rename reads the subtree it moves only when it moves it deeper — one move of a 40-deep tree under a 30-deep directory was otherwise accepted — and is still a write to each of the two parents and nothing else. `vcs` refuses a tree nested deeper than a checkout could write — 62 levels under `/apps/<slug>` — with `VcsError` in `status`, `diff` and `checkout`, before touching the working tree.
- **A checkout checks the directories it needs before it deletes anything.** It deleted the files the target lacks before writing any, so a directory it had to create under a name held by an entry this version cannot read stopped it half way: files gone, HEAD unchanged. It now reads the working tree, checks every directory it needs with the new **`vfs.assertCreatable(dirs)`**, and throws having changed nothing. A write that fails part way — a network error — can still leave a checkout half done.
- **`sweep({ force: true })` gets past a record no path can name.** A directory entry with an unusable name, pointing at a record that does not decrypt, stopped every sweep for good, with advice to delete it recursively — which needs a path. It is now one more thing whose references are unknown: `sweep()` refuses, as it does for an entry it cannot read, and a forced sweep keeps that record and carries on.
- **`vcs commit` reads the working tree through the same guarded walk.** It listed each directory by path and recursed with no guard at all, so a directory naming itself hung `commit` even after `walk` was fixed. New **`vfs.walkEntries(path)`** returns directories as well as files, in walk order; `walk` is the same traversal with the directories left out, so a commit records exactly the tree `status` compares it with. New **`vfs.eachEntry(path, visit)`** is that walk without the list: `visit` gets each entry in the same order, with a file's manifest. `status` uses it to compare as it walks, instead of holding the walk, a map of it and the commit's map at once, and `status` and `commit` no longer look every file up again by path — on a planted tree 50 directories deep that took `status` 4.6s, against 0.17s now.

### Fixed

- **`exists("/")` is `true`, and `stat("/")` describes a directory.** The root has no entry of its own, so `exists` answered `false` and `stat` said it did not exist, and `vfs mount` at its default root of `/` saw an empty remote on every pass. **Behaviour change:** both now throw `VfsLockedError` while locked. `stat("/")` said the root did not exist whether locked or not, and `exists("/")` answered `false` — which read as an empty filesystem rather than a locked one.
- **Deleting one copy left by an interrupted move keeps the other.** A move between two directories attaches before it detaches, so one interrupted between the two writes leaves the entry in both — the same directory record, or the same file id, content and history. Deleting the copy that was not wanted then took the other's contents with it: for a directory, its record and every file in it; for a file, its content and its history. A move now marks both copies until it has finished, and deleting a marked entry first reads the tree, once, and keeps whatever is still named elsewhere. If part of the tree cannot be read it keeps everything, which costs only storage. That delete also takes the mark off the copy left, when it is the only one: marked, a file keeps every version that falls off its history in case the other copy holds it, and with the other copy gone it would have gone on doing so for good. Not covered: when the move's last write (the one that takes the mark off) is the write that fails, the only copy stays marked, a retried move carries the mark over, and that file keeps every version that falls off its history from then on — storage, never data. A move within one directory is now a single write, which cannot be interrupted half way. Copies left by a move interrupted before this version are not marked.
- **A file moved to another directory keeps its history, and can be written again.** A history record is sealed with its directory's key, and a moved file was left with the old directory's record and the new directory's key: every `history`, `restore` and `writeFile` of it failed with a bare decryption error from then on. A move now re-seals the history for its new directory. A history that does not open with its directory's key — one moved by an earlier version, or shared by the two halves of an interrupted move — is tried with every other directory key in the tree. For a file an earlier version moved, it is then re-sealed for its directory, so that whole-tree read happens once. The two halves of an interrupted move keep the one key they share, so the half whose directory's key does not open it reads the whole tree on every `history`, `restore` and save, until the other half is deleted. One that no key opens throws `VfsConflictError` naming the file, not a `DOMException`, and says that a copy of the file starts a history of its own. Not covered: a file moved by an earlier version whose old directory has since been deleted has no key left anywhere, so it cannot be saved in place, and each refused save has already uploaded its content, which nothing then releases. Copying it is the way out.
- **A file lets go of each version once, and only when nothing names it.** `restore` puts a version back without taking a second reference, so one reference can be named twice: by the file and in its history, or twice in its history once the file is saved again. Deleting the file released that reference once per mention — the second time, a copy's. And a version falling off the end of a full history was released while something still named it: `restore` of the oldest version released the very version being restored, which was gone at once for good, and saving after a restore released a version the history still listed when an older mention of it fell off. A recursive delete of a directory holding two copies of one file released its content twice for the same reason. Each is now released once, when nothing else names it. Half of an interrupted move lets go of nothing that falls off its history, because the other half may hold it — until the other half is deleted.
- **A checkout turns a directory back into the file it replaced.** It deleted the directory's files and then could not write the file over the empty directory, leaving the working tree half changed. `delete(path, { recursive: true, keepContent: true })` now keeps the content of everything it removes, as it did for a file.
- **A delete that fails part way can be retried safely.** Deleting released a file's content first and removed the entry last, so a failure in between — a network error, most simply — left the entry in place with its content already released, and trying again released it a second time. Content is shared by copies, so that could free bytes another file was still using. A delete now reads everything it will touch, removes the entry, and only then lets go; a failure before the entry is removed has changed nothing.
- **`vcs.open()` refuses a project name that is not a single name.** `demo/`, `..`, `a/b` and the like are rejected with `VcsError`. `--project demo/` committed an empty tree while reporting success, and checking that commit out deleted every file in the project.
- **Folders and files named `constructor`, `toString`, `__proto__` and the other built-in object property names work.** Lookups found the inherited property instead: `exists("/constructor")` was `true` on an empty filesystem, `src/constructor/` could not be created, and a file named `__proto__` was reported written and stored nowhere — in the working tree and in commits alike.
- **`copy` of a tree with more than 64 directories no longer claims it contains a cycle.** The guard counted every directory copied against the depth limit. Depth is now counted per branch, from the root, where the copy will land, the copy shares the walk's entry budget, and a subtree reachable twice is copied under both names instead of being refused.

## 0.14.0-alpha.5 — reads wide enough to fill a batch (2026-09-05)

### Changed

- **Default read concurrency raised — `FileStorage` 8 → 16, and the VFS directory walk 8 → 24.** Once shard reads coalesce (0.14.0-alpha.4), these numbers stop meaning "how many requests are in flight" and start meaning "how many hashes are available to gather into one request". At the old values that made things *worse*: 32 small concurrent requests became one large serial one, and opening a project got slower in Chromium (18.4s → 31.9s) even as the request count fell 28×. A batch window can only collect what callers have already asked for, so the reads have to be wide enough to fill one batch and then keep a second on the wire while the first lands. The walk matters for the same reason at one remove — it is what discovers the files whose shards then batch together, so a narrow walk throttles everything downstream.
- **Batching and concurrency are one change shipped as two versions.** 0.14.0-alpha.4 is the first half without the second, and measured slower than 0.14.0-alpha.2 in Chromium; install 0.14.0-alpha.5. Together, opening the same 519-file project cold in the Muhkoo IDE: requests 2,086 → 22, Chromium 18.4s → 8.8s, Brave 37.5s → 14.9s. Brave moves furthest because it inspects every request — the cost was round trips, not bytes.
- Only the defaults moved. A caller constructing `FileStorage` directly can still pass its own `concurrency`; the walk's ceiling is not configurable, and is deliberately a ceiling rather than unbounded, since browsers cap concurrency per origin and a larger number mostly moves the queue.

## 0.14.0-alpha.4 — many shards in one request (2026-09-05)

**Supersedes 0.14.0-alpha.3, which is deprecated on npm: it published with no type declarations at all.** That failure is silent — consumers keep compiling, every SDK type quietly becomes `any`, and the first symptom is an unrelated type error somewhere downstream. Do not install 0.14.0-alpha.3.

### Changed

- **Concurrent shard reads coalesce into a single request.** A shard is not a file: a project is thousands of small modules, each split into shards, and reads were one request per shard — 2,086 of them to open a 519-file project. Reads issued within a few milliseconds of each other now leave as one `POST /api/shards/batch` (up to 256 hashes). **Callers are unchanged** — `getShard` still asks for one shard and gets one shard back; the coalescing is inside `ShardClient`.
  - A shard the server does not have is reported absent rather than failing the batch, so the caller can still rebuild that chunk from parity and the other hashes in the batch still get their bytes.
  - New `ShardClient` option **`batchShards?: boolean`** (default `true`) forces one-at-a-time.
  - Against a deployment without the batch route it degrades once and stays degraded, on a 404/405 **or** on a 200 that is not shaped like a batch reply. The second condition is load-bearing: a catch-all handler or a proxy answering that POST with something else would otherwise resolve every hash to "missing" for shards that are sitting right there.

### Fixed

- **`build` now emits the type bundle, and publishing refuses a missing or stale one.** `dist/connect.d.ts` was in the published file list but nothing built it — `build` emitted JavaScript only, so a release carried whatever happened to be left in `dist`, or nothing. `build` now runs `build:dts`, and `prepublishOnly` fails if the bundle is absent or older than `src/`.

## 0.14.0-alpha.2 — fetch the data shards, and parity only when it is missing (2026-09-04)

### Fixed

- **A read no longer pays for parity it throws away.** Reed–Solomon needs `dataShards` of the `dataShards + parityShards` total and the leading entries are the data ones, but every read fetched all of them and discarded the parity — with the defaults, six round trips where four would do, per chunk, per file. Invisible on one large file and ruinous on a project, where a 60-byte source module costs the same six requests as a megabyte. Opening a 519-file project cold went from 3,124 requests and 37.4s to 2,085 and 22.4s; a ~2,000-file project drops from roughly 12,000 requests to 8,000.
- **Recovery is unchanged.** Parity is still fetched, just lazily — only when a data shard did not arrive — so a damaged chunk repairs exactly as before, paying one extra round trip in the rare case instead of two wasted ones in the common one.

## 0.14.0-alpha.1 — signing in from a browser that already knows you (2026-09-04)

**Supersedes 0.14.0-alpha.0, which is deprecated on npm: it shipped announcing itself as `0.13.2-alpha.0`.** The code is otherwise identical. Install 0.14.0-alpha.1 or later.

### Added

- **`auth.zk.loginWithDevice(username, factorId, deviceKey, opts?)` — sign in from a paired browser or machine with no password and no credential at rest.** `unlockWithDevice` (0.11.0) recovers the master seed and nothing else, which suits a CLI that already holds a session token in a file on disk and strands a browser, whose session expires while the pairing is still perfectly valid — at that point it holds the means to decrypt everything and no way to make an authenticated call. `loginWithDevice` derives the ZK identity from the recovered seed and proves it, exactly as `recoverWithPhrase` does: the seed has always been sufficient to authenticate, so demanding a password there proved nothing that was not already known. Takes the same `LoginOptions` as `login` and resolves to the `AuthUser`.
  - The seed still never lands on disk. What is stored locally is a random key that opens a server-held blob, so revoking the factor (`auth.zk.revokeDevice`, or `muhkoo devices rm`) makes that key inert immediately — which a stored seed can never be, since nothing can reach out and un-store it.
  - This is what "keep me signed in on this browser" is built on. The master seed is memory-only by design, so before this every fresh page load of every app meant retyping a password; sharing a registrable domain does not help, because browser storage is per-origin. The key is generated on, and never leaves, the sign-in origin.
- **`DeviceRevokedError`**, exported from the package root and thrown by both `loginWithDevice` and `unlockWithDevice` when the pairing has been revoked. Typed rather than a bare `Error` because the correct response is specific and the wrong one is harmful: discard the stored key and fall back to a password. Retrying cannot succeed — the factor is gone from the vault — and silently re-pairing would undo a revocation someone performed deliberately, which is the whole point of a pairing being revocable. Distinct from a wrong key, which fails to *decrypt* rather than to *resolve*; a machine whose access was withdrawn should be able to say so. `unlockWithDevice` threw a bare `Error` carrying the same sentence, so telling the two apart meant matching on message text.
- **`auth.hosted.login({ appId, redirectUri, redirect?, prompt? })`** — `prompt: "login"` forces the credential screen even when the browser is already remembered. Without it, an app's own sign-out is undone on the very next sign-in click: single sign-on means the hosted page still knows the user, so an app has to be able to say "ask anyway". Named after the OIDC parameter that solves the same problem.

### Fixed

- **The build stamps `VERSION` from `package.json`, and publishing refuses a stale stamp.** That constant is printed to the console when a `Client` is constructed, and its only job is to answer "is this page running the build I just shipped, or a cached one?" — a stale value does not merely go unnoticed, it answers that question wrongly, during exactly the debugging session where someone is relying on it. It was previously kept in step by a comment asking nicely, and 0.14.0-alpha.0 duly shipped mislabelled.

## 0.13.2-alpha.0 — released in lockstep with the CLI (2026-08-29)

No SDK changes. `@muhkoo/cli` is versioned in lockstep with this package (see `cli/scripts/sync-version.mjs`) because it ships against an exact SDK version, so a CLI-only fix — here, `vfs mount` reading files concurrently — needs a matching release on this side.

## 0.13.1-alpha.0 — walk sibling directories concurrently (2026-08-29)

### Fixed

- **`vfs.walk` lists sibling directories at the same time instead of one after another.** Each `list` is a round trip for one directory record, and walking them in series cost the sum of those latencies — measured against real projects, the walk alone was 1–2.1s before a single file had been read. Directories are independent, so there was never a reason to queue them. Bounded at 8; browsers cap concurrency per origin anyway.
- **Order is unchanged.** Each entry maps to its own slice of the result and the slices are concatenated in listing order, so the output is byte-identical to the depth-first version — `mount`, the CLI's `vfs tree`, and the IDE's project context all consume that order. Covered by a test that pins the exact expected sequence.
- The cycle guard still holds when visits overlap: the visited set is claimed before the first `await`, so two concurrent visits to one directory cannot both get through.

## 0.13.0-alpha.0 — treat a directory record as untrusted input (2026-08-24)

### Security

A security review of the VFS mount pattern found that **any app a user signs into can write arbitrary files anywhere in that user's VFS** — hosted auth hands the app the master seed, the VFS root key is a pure HKDF of it, and every child directory key lives inside its parent record, so the root key reaches the whole tree. A directory record is therefore not necessarily something this SDK wrote, and the write-side checks are not in that path at all. The root cause is tracked as SEC-3 in `accelerator/SECURITY-FOLLOWUPS.md`; these are the read-side changes.

- **Entry names are validated where they are read.** `list()` now drops (and warns about) any entry whose stored name would become path structure or hide what it is: `/`, backslash, NUL, other control characters, Unicode bidi overrides, `.`/`..`, or over 255 bytes. Dropped rather than thrown on — one bad entry must not make a directory unlistable, and callers walk this output straight into filesystem paths. `isSafeName` is exported.
- **`assertValidName` is no longer a tautology.** Every call site passed `basename()` of an already-normalized path, which by construction could never contain the three things it checked for. It now shares `isSafeName`.
- **Cycle guards and a depth cap** in `walk`, `sweep`, `purge` and `cloneEntry`. `walk` recursed on a re-resolved path with no visited set, so a record pointing at an ancestor — or, before names were validated, an entry simply named `..` — looped forever while growing its result unboundedly; `mount` calls it on every sync pass. `cloneEntry` was the worst of the four: it mints a new id, key and stored record per level, so copying a cyclic directory wrote records to the store, and to the user's bill, in an unbounded loop.

Covered by `tests/vfs/hostile-records.test.ts`, which plants sealed records directly rather than going through the SDK — the capability the threat model actually grants.

## 0.12.2-alpha.0 — retract 0.12.1 (2026-08-24)

### Changed

- **Reverts the `manifestId` field added in 0.12.1, and retracts its claim.** That release said keying the platform's storage-reference ledger on content rather than manifest identity caused two copies of one file to share a reference. Measured against a live account, that is not true: chunks are encrypted with a fresh key per write, so two writes of identical plaintext produce *different* shard hashes and therefore different ledger keys. Both copies take their own reference. The field fixed nothing, so it is gone rather than left as inert protocol surface. 0.12.1 is functionally identical to 0.12.0 against any current server.

## 0.12.0-alpha.0 — `client.vcs`, and a filesystem that stops re-reading itself (2026-08-24)

### Added

- **`client.vcs` — version control over the VFS.** `vcs.open(slug)` returns a repository for one project: `commit`, `log`, `diff`, `status`, `checkout`, `restore`, `branch`, `switchTo`, `merge`. There are no remotes and no `push`/`pull` by design — the repository lives in your account, so every machine you sign in from is already looking at the same objects.
  - **Two object spaces.** The working tree is the mutable VFS; commits and trees are content-addressed objects sealed under a per-project key (`deriveRepoKey(seed, slug)`). There are no blob objects: a tree points at the `FileManifest` the VFS already holds, so committing moves no bytes.
  - **A commit takes its own reference to what it records.** Content is reference-counted and the working tree was the only thing holding a reference, so deleting a file after committing it freed shards the commit still needed. `checkout` deletes with `keepContent` for the same reason.
  - **Three-way merge with conflict markers**, `merge3`/`merge3Text`. A conflicted merge records the other side and the next `commit` consumes it as a second parent — without that, resolving would produce a single-parent commit and the branches would still read as diverged.
  - **Mergeability is judged by content, not by the declared type.** The MIME type is a hint the VCS does not own: a content store may omit it, and `Makefile`, `LICENSE`, `.gitignore` and `.env` have no extension to derive one from. Obvious binary types are rejected without reading; everything else is sniffed for NUL bytes and invalid UTF-8.
  - **`switchTo`, `checkout` and `merge` refuse to overwrite uncommitted work**, naming the files at risk. They replace the working tree, and unlike an ordinary write nobody asked for it. `{ discardChanges: true }` opts out.
  - `resolve(rev)` understands `HEAD`, branch names, abbreviated hashes, and trailing `^` / `~n`.
- `vfs.readByManifest(manifest)` — read content by its handle, wherever it came from. A merge needs the common ancestor's version of a file, which by definition is no longer in the working tree.
- `vfs` and `vcs` types are now exported from every build surface.

### Fixed

- **Loading a project no longer re-fetches the same directory records thousands of times.** The record cache stored the resolved value rather than the in-flight promise, so every concurrent path resolution missed and started its own request for the same record — and since every resolution starts at the root, the cost was files × depth. Reading 20 files across 4 directories went from **80 requests to 4**, and the ratio grows with the number of files. A failed read is no longer remembered, so one blip cannot poison a directory for the life of the session.
- **The change feed invalidates one record instead of the whole cache.** Our own writes echo back, so a sync writing a few hundred files emptied the cache a few hundred times and sent every in-flight resolution back to the network. The frame names the record; only that one is dropped now.

## 0.11.0-alpha.0 — `client.vfs`, a real filesystem (2026-08-22)

### Added

- **`client.vfs` — directories, paths, versions, and binary files over the primitives you already have.** File bytes still go through `client.storage.writeFile` into a real Space, unchanged; what is new is the *metadata*. Instead of the flat `{spaceId, manifest}` mirror keyed by file id that `writeFile` already keeps in your personal space, the VFS arranges the same information as a tree you can navigate: one AES-256-GCM-sealed record per directory, so the server never sees a filename, a directory shape, or a file size.
  - **A working directory, POSIX-style.** `vfs.cd(path)` and `vfs.cwd`; every method resolves relative paths against it, `..` climbs and stops at the root, and absolute paths pass through untouched. `cd` verifies the target is a real directory, so a typo fails where the message can name it rather than turning every later relative path into "does not exist". It lives in the SDK rather than the CLI so that a CLI, a script and an app all agree on what "here" means.
  - Reads: `stat`, `list`, `walk`, `exists`, `readFile`, `readText`, `glob`.
  - Writes: `writeFile`, `mkdir`, `delete`, `rename` (which is also move), `copy`.
  - Versions: `history`, `restore`. Every write keeps the previous manifest, so there is cross-session undo; unchanged chunks dedupe in the content-addressed shard store, so keeping versions costs almost nothing. Capped per file (default 20).
  - **`vfs.watch(handler)` — live changes.** Fires when this filesystem is written somewhere else: another tab, another machine, a CLI. It rides the personal space's existing websocket, shared with `client.kv` via the new `kv.onRaw()` rather than opening a second socket to the same space. Deliberately a notification, not a diff — the frame names a record id, and a record id is not a path, so the cache is dropped and the caller re-reads what it is actually showing. A runtime with no `WebSocket` gets a harmless no-op, because watching is an optimisation and never required for correctness.
  - Maintenance: `sweep()` reclaims records orphaned by a lost write race.
  - **Directories have stable random ids, not content hashes.** A git-style tree rewrites every ancestor to the root on each write; here a file write touches exactly one record — its parent — and moving a directory is O(1) no matter how large the subtree, because nothing inside it records its own path.
  - **A directory's key lives in its parent.** Only the root key derives from the master seed (`muhkoo-vfs-v1`), so capabilities chain downward: handing over `{id, key}` for a subtree grants that subtree and nothing above it. That is the seam sharing will hang off without re-encrypting the filesystem.
  - `copy` of a file moves no bytes — content is immutable and content-addressed, so the new entry points at the same manifest. It does get a fresh file id, so the two do not share version history.
  - Binary files round-trip. Anything holding files as `Record<string, string>` will corrupt a PNG; this does not.
  - **Machine access without storing the seed.** `auth.zk.enrollDevice(label)` wraps the master seed under a fresh random key, stores only the ciphertext as a vault `device` factor, and hands back the key for the caller to keep. `unlockWithDevice(username, factorId, deviceKey)` opens it again; `listDevices()` / `revokeDevice(id)` manage them. Revoking a factor makes that machine's stored key inert immediately — which a stored seed can never be, since nothing can reach out and un-store it. Device factors are read by **id**, not type: you have one password but may pair many machines.
  - `auth.zk.unlockWithSeed(seedBase64)` — the inverse of `seedBase64`, for hosts that hold the seed themselves (a CLI, a server-side tool, a test). Without it, anything outside a browser runs a full ZK login on every invocation.
  - `space.createSpace({ messaging: false })` registers a space without bootstrapping a group keyring or opening a WebSocket. For a space that only holds FILES — chunks carry their own keys — the keyring buys nothing, and the socket makes writes depend on a live connection. The VFS uses this.
  - Locked (no master seed in memory) throws `VfsLockedError`, and a wrong key throws, rather than presenting an empty filesystem — the dangerous outcome is a "successful" write over a tree you could not decrypt.

## 0.10.14-alpha.0 — don't prompt for a passkey that can't work here (2026-08-12)

### Fixed

- **`auth.zk.resume()` no longer attempts a passkey unlock when the account has no passkey usable from the current origin.** Passkeys are per-origin, and enrolling through hosted auth records `auth.muhkoo.dev` — so a user who added a passkey there is mismatched on every app host. `resume()` previously attempted anyway; the attempt failed harmlessly only because the server returns a shapeless decoy that trips an internal guard before WebAuthn is reached. That silence was incidental, not designed: once the decoy is made indistinguishable (needed to close an account-enumeration oracle), the same call would fire a modal `navigator.credentials.get()` at page load — on the splash screen, since `resume()` is awaited inside every app's readiness gate. This ships first so that server-side change is safe to make.
  - New `passkeyUsableFromOrigin(rpId, host)`, exported from the auth surface. Use it — not `rpIdUsableForOrigin` — when deciding whether to *offer or attempt* a passkey. It mirrors `loginWithPasskey`'s own resolution, so a factor with **no recorded rpId** (enrolled before per-origin support) counts as usable; the raw predicate reports `false` for those and excluding them has locked real users out of production before.

## 0.10.13-alpha.0 — TV device pairing, client surface (2026-08-07)

### Added

- **`client.auth.hosted` device pairing** — sign a keyboard-less device in without typing on it. The device shows a short code; the user approves from a browser that is already signed in, and the master seed is delivered sealed to that device alone. Built for an Android TV WebView, which has neither a keyboard nor WebAuthn.
  - Device: `startDevicePairing()`, `pollDevicePairing()`, `waitForDevicePairing()` (handles the interval/backoff and `slow_down` for you), `cancelDevicePairing()`, plus `resumeDeviceSession()` / `hasDeviceSession()` / `forgetDeviceSession()` across restarts.
  - Approver: `lookupDevicePairing()`, `approveDevicePairing()`, `denyDevicePairing()`, `listPairedDevices()`, `revokePairedDevice()`.
  - `DevicePairingError` / `ReauthRequiredError` carry the machine-readable reason, so a UI can tell "expired" from "denied" from "confirm it's you first".
- **`deviceStore`** — at-rest persistence for a paired device: the identity blob is encrypted in `localStorage` under a **non-extractable** IndexedDB key. Read the module docs before relying on it: against an attacker with device, ADB, or root access this is **obfuscation, not protection**. A native-Keystore bridge (`MuhkooKeystoreBridge`) is supported for hosts that can provide one.

Requires an accelerator with the `/api/auth/device/*` endpoints (shipped 2026-08-06). Protocol spec: `muhkoo/auth/docs/tv-device-pairing-spec.md`.

## 0.10.12-alpha.0 — TV device-pairing seal (2026-08-06)

### Added

- **v2 device-pairing handoff** — `generateDevicePairingKeypair()`, `sealSeedToDevice()`, `unsealSeedFromDevice()` and `pairingVerificationCode()`. Lets a keyboard-less device (an Android TV WebView, which has no WebAuthn) receive the master seed without the server ever reading it. Same sealed envelope the hosted-auth handoff already uses, so it rides the existing `sealedKeys` field — but the key is ECDH-derived to the device's ephemeral P-256 key instead of arriving in a redirect fragment, because a TV has no redirect to receive one. P-256 ECDH → HKDF-SHA256 → AES-256-GCM, fresh ephemeral key and IV per seal.
- Both public keys are bound into the KDF. This is load-bearing, not belt-and-braces: P-256 ECDH returns only the shared x-coordinate, so a seal addressed to the *negation* of a device key (on-curve, derivable by anyone from the published key, and showing a different verification code) would otherwise still decrypt under the honest private key.
- `pairingVerificationCode()` is shown on both screens so a human can confirm the keys match — PBKDF2-SHA256 (200k iterations, to blunt precomputation) rendered in a 30-symbol alphabet with every confusable pair removed (`0/O`, `1/I/L`, `U`).

The v1 fragment-key handoff (`sealSeed`/`unsealSeed`) is unchanged and still rejects non-v1 envelopes.

Protocol spec: `muhkoo/auth/docs/tv-device-pairing-spec.md`. The server endpoints it describes are not built yet — these are the client primitives to code against.

## 0.10.11-alpha.0 — Access tokens + per-origin passkeys (2026-07-29)

### Fixed

- **Passkey unlock on apps served from more than one host.** A passkey is bound to the origin it was enrolled on, but the vault handed back whichever passkey was enrolled *first* regardless of origin — so an app reachable at both a custom domain and the platform host (e.g. `theater.muhkoo.com` and `muhkoo-theater.apps.muhkoo.dev`) failed to unlock on one of them with a raw *"The requested RPID did not match the origin or related origins"*. The vault read is now origin-aware (the platform also infers the origin from the request, so already-deployed clients are fixed), and `loginWithPasskey` refuses a foreign RP id **before** prompting instead of triggering a biometric prompt that cannot succeed. Enroll one passkey per origin; each unlocks its own.

### Added

- **`client.auth.zk.hasPasskeyForThisOrigin()`** — whether a passkey enrolled for the CURRENT origin can unlock here, so an app can offer "Unlock with passkey" only when it will work. `listFactors()` now also returns each passkey's `rpId`, and a wrong-origin unlock throws the typed `PasskeyOriginError` (`code: "passkey_wrong_origin"`).

- **`new Client({ accessToken })`** — authenticate as a machine with a scoped, expiring [access token](https://docs.muhkoo.dev/concepts/access-tokens/) (`mk_<env>_at_…`) instead of a ZK identity. Rides the same `X-Muhkoo-Key` header as an app key and takes precedence over `apiKey` when both are set — for headless/server/CI clients.
- **`client.accessTokens`** namespace — `create(appId, { scopes, env, expiresInDays, label })` (returns the plaintext once), `list(appId)`, and `revoke(appId, keyId)`. Scopes are resource-level (`db:read`/`db:write`, `kv:*`, `storage:*`, `messages:*`, `functions:invoke`, `ai:infer`); see the exported `ACCESS_TOKEN_SCOPES`.
- **`@MuhkooDB({ backend: true })`** — mark a table backend-only in an agent app descriptor. Backend tables are omitted from `ejectAgentPrompt` output, matching the platform gate that rejects publishable keys from backend-only tables.

## 0.10.10-alpha.0 — Streaming large-file storage (2026-07-06)

### Fixed

- **`writeFileToShards` now truly streams.** It previously read the ENTIRE source into one `Uint8Array` before chunking (despite a comment claiming per-chunk memory), so multi-GB files (e.g. a 4K movie) threw "the file could not be read" — a `Blob`/`File` overflows the browser's ~2GB `ArrayBuffer` cap. It now slices the source per chunk; peak memory stays at ~`chunkSize`.

### Added

- **`Space.getFileStream(manifest)`** / **`FileStorage.readChunksFromShards(manifest)`** — async-iterate a stored file's decrypted chunks in order without holding the whole file in memory. For multi-GB reads (a single `Uint8Array` can't hold them) — e.g. a transcoder piping the raw straight to a temp file. Same peer/origin shard sourcing and per-chunk auth as `getFile`.

## 0.10.9-alpha.0 — Passkey platform-authenticator fix (2026-07-06)

### Fixed

- **Passkey enrollment now pins the platform authenticator** (`authenticatorAttachment: "platform"`). Previously the browser could route WebAuthn to a third-party password-manager extension that doesn't implement the PRF extension our seed-wrapping factor requires, causing "didn't return a PRF result" failures. Enrollment now goes to the OS authenticator (Touch ID / Windows Hello / iCloud Keychain), which supports PRF.

## 0.10.1-alpha.0 — CLI cross-origin isolation support (2026-07-01)

### Added

- **Per-app cross-origin isolation** is now a self-serve hosting setting. Apps
  that need `SharedArrayBuffer` (multi-threaded WebAssembly — e.g. `ffmpeg.wasm`)
  can opt in without any platform changes: set `crossOriginIsolation: true` in
  the provision spec (`muhkoo provision`) or toggle it in the portal Hosting
  card. The platform then serves the app's document with `Cross-Origin-Opener-Policy:
  same-origin` + `Cross-Origin-Embedder-Policy: credentialless`, so the runtime's
  `crossOriginIsolated` check passes and threaded wasm cores load automatically.
  No SDK API change — this is a version-lockstep bump carrying the CLI feature.

## 0.10.0-alpha.0 — Stable member keypair across reloads + `resume()` (2026-07-01)

### Added

- **`client.auth.zk.resume()`** — one boot call that restores the session and,
  when a passkey is enrolled, silently unlocks the identity via WebAuthn (the
  master seed is recovered, never persisted). Returns `{ user, unlocked }` so the
  app prompts for a password only when there's no passkey. Replaces the manual
  `restore()` + key-hydration scaffolding apps used to hand-roll.
- **SDK-owned ratchet-keypair vault.** The member's long-lived ratchet/space
  keypair is now provisioned + seed-wrapped + rehydrated by the SDK itself
  (`SpaceNamespace` rehydrates it from the personal-space `chat-keys` blob before
  opening a Space). Every app gets a **stable member keypair across page
  reloads** with no per-app code — so members stop re-admitting to Spaces on
  every load and the server-blind group-key cache round-trips.

### Fixed

- A reloaded, unlocked client no longer regenerates a fresh keypair each session
  (which forced a full keyring re-admit and defeated the group-key cache).

## 0.9.0-alpha.0 — P2P file transfer (`client` `p2p` option) (2026-06-26)

### Added

- **Peer-to-peer file-shard exchange among Space members (opt-in).** With
  `new Client({ p2p: { enabled: true } })`, a Space's file reads/writes try the
  other members first over **WebRTC data channels** before spending origin
  bandwidth — a private, Space-scoped swarm. Best-effort: a miss or unreachable
  peer falls back to origin, so it never blocks a read.
  - **Private + authenticated**: signaling rides the Space's existing ephemeral
    relay (no new server channel); the sender is server-stamped, so peers can't
    spoof identity. Blocks are AES-GCM ciphertext addressed by SHA-256 — a peer
    can serve them but can't read them, and an inbound block is hash-verified
    before use (a tampered block is dropped and origin is used instead).
  - **Bitswap-lite protocol** (`WANT`/`HAVE`/`BLOCK`/`CANCEL`) with a
    pluggable `PeerTransport` so a libp2p/Helia transport can slot in later
    without touching the engine.
  - **Off-thread by default**: the block engine (hashing, blockstore, protocol)
    runs in a **Web Worker** — shipped as a separate chunk and exposed via the
    `@muhkoo/connect/p2p-worker` export (keys never enter the worker; only
    encrypted blocks cross, as transferables). `PeerNetwork` builds it
    automatically (or accepts `p2p.workerFactory`), falling back to an
    in-process engine where a worker can't be constructed.
  - New exports: `PeerNetwork`, `PeerExchange`, `WebRtcTransport`,
    `SpaceSignaler`, `BlockEngine`, `isP2pCapable`, and the `protocol` codec.
- **Peer data channel (`space.gossipToPeers` / `space.onPeerGossip`).** A direct,
  **server-bypassing** broadcast to connected Space peers over the same mesh
  (multiplexed alongside block exchange) — for CRDT ops and high-frequency state
  (live cursors, presence, collaborative edits) you don't want to push through
  the relay. Fragments large payloads; single-hop (no re-forwarding).
- **Directed ephemerals**: `space.sendEphemeral(subject, data, to?)` — with a
  `to` member id the accelerator unicasts to that member instead of
  broadcasting (used for WebRTC signaling; backward-compatible).

## 0.8.0-alpha.0 — Offline support (`client.offline`) (2026-06-24)

### Added

- **Transparent offline support, on by default in browsers.** A new layer caches every data domain locally, lets the app keep reading and writing with no connection, and reconciles automatically on reconnect — all behind the scenes. It's a no-op in Node/edge/SSR (a `NoopStore`), so existing non-browser consumers are unaffected. Disable or customize via `new Client({ offline: { enabled, store, cacheShards, maxQueueBytes } })`.
  - **`client.offline.status`** (`online | offline | syncing`) and **`client.offline.onStatusChange(cb)`** — connectivity fused from `navigator.onLine`, real fetch outcomes, and the websocket lifecycle. Also emitted on `EventCore` (`ONLINE`/`OFFLINE`/`SYNCING`/`SYNC_PROGRESS`/`SYNC_COMPLETE`/`SYNC_ERROR`).
  - **`client.offline.snapshot`** — encrypted, local app-state cache (`save`/`load`/`delete`/`list`) for repainting instantly on a cold offline boot (last route, open space, drafts). Encrypted at rest with the identity-derived key; `load` returns `null` while locked.
- **Spaces messages offline.** Inbound + `history()` messages are cached (sealed ciphertext at rest); **`space.cachedMessages()`** decodes them for instant offline hydrate. Sends made while disconnected are applied optimistically and durably queued, then replayed on reconnect; a forward catch-up pulls anything missed while away. Messages converge with no server change (server-assigned monotonic handle).
- **File storage offline.** Shard bytes are cached in the Cache API (content-addressed → self-validating); reads serve cache-first and Reed–Solomon recovers from cached shards, and uploads made offline are queued and replayed. Convergent by construction (content addressing + idempotent PUT).
- **`client.kv` offline.** Cache-first reads, optimistic writes, a durable replay queue, and a realtime-feed merge. Conflicts resolve as a **CRDT LWW-Register** keyed by a Hybrid Logical Clock; deletes are causal tombstones. Cross-device convergence is honored server-side (the accelerator selects by HLC and tombstones deletes, server-blind to the encrypted value).
- **`client.db` offline.** `get`/`query` are cached (offline reads), writes are optimistic + queued + replayed, and each write carries per-column HLC stamps (`_hlc`). The accelerator now merges **per-column LWW** (a private `_muhkoo_crdt` sidecar): two devices editing different columns of the same row both keep their edits, same-column conflicts resolve by HLC, and deletes are causal tombstones (a stale write can't resurrect a removed row). Legacy clients (no `_hlc`) keep last-writer-by-arrival.
- **Faster reconnect catch-up.** Spaces pull a forward delta (`GET …/history?since=<handle>`) from the last-seen handle to the head, instead of re-reading the tail backwards.
- Conflict-resolution primitives are exported for advanced use: `HLC`, `compareHlc`, `mergeRegister`, `mergeMap`, `materializeRow`, `IndexedDbStore`, `NoopStore`, `OfflineManager`, and friends.

## 0.7.0-alpha.5 — Security hardening (2026-06-18)

### Security

- **`HttpClient` attaches credentials same-origin only.** The app key (`X-Muhkoo-Key`) and user session token (`X-Muhkoo-Session`) are no longer sent when a request URL escapes the configured `baseUrl` origin — closing a token-exfiltration vector through absolute / `http`-prefixed request paths.
- **Stopped logging identity material.** Removed `console.log` of the ZK salt and commitment in `DoubleRatchetManager` (the salt is a private circuit witness; the commitment is the user's stable id).

## 0.7.0-alpha.4 — Hosted auth, recovery factors & function invoke (2026-06-17)

### Added

- **Email recovery factor (M2 — verification-gated split-key):**
  - `client.auth.zk.enrollEmailFactor(email)` — add an email as a recovery + login factor. Sends a 6-digit code to the address and returns `{ confirm(code) }`; confirming wraps the master seed under a wrap key released only after the address is verified. Requires being signed in.
  - `client.auth.zk.recoverWithEmail(username)` — account recovery from nothing but the username + inbox access. Sends a code to the *enrolled* address (the response never reveals whether one exists) and returns `{ confirm(code) }`, which completes the recovery and signs in (→ `AuthUser`). Call `changePassword` afterwards.
  - How it works: the wrap key is `HKDF( OPRF(K1, input) ‖ OPRF(K2, input) )` — two evaluations in **separate trust domains**, each only released after a fresh proof of inbox control. No single server-side compromise can derive it offline. The ZK identity layer is unchanged.
  - `listFactors()` entries for gated factors carry a `masked` display hint (`m•••@gmail.com`); the full address is never exposed in list responses.
- **Google factor (M2.3 — "Sign in with Google", verification-gated split-key):**
  - `client.auth.zk.enrollGoogleFactor(idToken)` — link a Google account as a recovery + login factor (signed-in). The app obtains `idToken` via Google Identity Services and passes it in; the SDK never renders Google UI.
  - `client.auth.zk.loginWithGoogle(username, idToken)` — sign in with Google (the account must have linked it). Unlocks the seed via the Google-gated split-key eval; the ZK identity layer is unchanged.
  - `client.auth.zk.registerWithGoogle(username, idToken)` — create a brand-new **passwordless** account whose only factor is Google.
  - Google is pure authentication UX — the verified ID token only gates the wrap-key release. The `google` factor is keyed on the stable Google `sub`.
- **Hosted auth — `client.auth.hosted` (auth.muhkoo.dev):** centralize sign-in so apps drop the embedded login UI (and ~6 MiB of snarkjs), and provider config (Google OAuth origins, WebAuthn, DKIM) lives in one place instead of per-app.
  - `client.auth.hosted.login({ appId, redirectUri })` — redirect to the hosted page (PKCE + `state` stashed automatically). `redirectUri` must be registered for the app in the portal (App Detail → Hosted sign-in).
  - `client.auth.hosted.handleCallback()` — on the callback route, exchange the returned code, unseal the master seed from the URL fragment, establish the session, and scrub the URL (→ `{ username, commitment }`). `client.auth.hosted.isCallback()` guards it.
  - `client.auth.hosted.manageAccount({ returnUri? })` — redirect to **centralized account & security management** (`auth.muhkoo.dev/security`): manage passkeys, recovery email, Google, recovery phrase, and password in one place across every app, with a "Back to app" return. Replaces the per-app security UI.
  - Sealed-seed handoff: the hosted page AES-GCM-seals the seed under a one-time key carried only in the URL fragment (never sent to a server); the app unseals it after the code exchange. Authorization-code + PKCE (S256); single-use, 60s codes. `authBaseUrl` client option overrides the hosted origin (default `auth.muhkoo.dev`).
- **`client.functions.invoke(target, opts?)`** — invoke an HTTP-triggered serverless function with the SDK's credentials attached (`X-Muhkoo-Key` + `X-Muhkoo-Session` when signed in), JSON in/out (non-2xx → `HttpError`). `target` is `{ name, slug }`, a `name--slug` host label, or a full URL; `opts` takes `method`, `body`, `headers`, `path`. `client.functions.invokeRaw(...)` returns the raw `Response` for non-JSON functions, and `client.functions.invokeUrl(...)` resolves a target to its URL.
- **`functionsHostSuffix`** client option — override the HTTP-function zone (`fns.muhkoo.dev` by default) for staging/self-hosted deployments. Exported `DEFAULT_FN_HOST_SUFFIX`.

## 0.6.0-alpha.11 — Account recovery (M1)

Recoverable zero-knowledge identity: the password is now a **factor**, not the
source of the keys. A random master seed yields the same secret/keys/commitment
as before (the ZK circuit and all existing commitments are **unchanged** — fully
backward-compatible), and is AES-256-GCM-wrapped per recovery factor and stored
server-blind in a per-user vault. So a forgotten password no longer means a lost
account, and the password can be changed without moving the identity. (alpha.2–
alpha.10 were dev iterations folded into this entry.)

### Added

- **Passkey factor (WebAuthn PRF):**
  - `client.auth.zk.enrollPasskey({ rpId?, rpName?, label? })` — add a passkey that wraps the seed under its PRF output.
  - `client.auth.zk.loginWithPasskey(username)` — passwordless sign-in (→ `AuthUser`).
  - `client.auth.zk.passkeyAvailable()` — `boolean`; whether WebAuthn is usable here.
  - `client.auth.zk.passkeyPrfAvailable()` — `Promise<boolean | null>`; whether the authenticator supports the PRF extension we need (`null` = undeterminable). Use it to hide the passkey option on incapable browsers.
- **Recovery phrase factor (BIP39):**
  - `client.auth.zk.enrollRecoveryPhrase()` — returns the 24-word phrase to show **once** (it *is* the seed; nothing is stored server-side).
  - `client.auth.zk.recoverWithPhrase(username, mnemonic)` — the "forgot password" path (→ `AuthUser`).
- **Password management:** `client.auth.zk.changePassword(newPassword)` — re-wraps the (unchanged) seed; identity/commitment never move.
- **Factor management:** `client.auth.zk.listFactors()` (enrolled methods, metadata only) and `client.auth.zk.removeFactor(id)` (can't remove the last one).
- **`client.auth.zk.seedBase64`** — the master seed as base64 (or `null` when locked). Wrap app-level data (e.g. chat keys) to the **seed** instead of the password, so it survives password changes and unlocks under a passwordless passkey login.
- **`VaultUnavailableError`** (exported) — thrown by `login`/`unlock` when the vault is unreachable (network / 5xx / rate-limit), distinct from a wrong password.

### Changed

- **`register` / `login` / `unlock` are now vault-backed** — the surface is identical, but `register` derives a random-seed identity and enrolls the OPRF-gated password factor, and `login`/`unlock` unlock the seed from the vault.
- **Legacy (pre-vault) accounts migrate transparently** on first vault-aware login/unlock: a password factor wrapping the exact legacy-derived seed is enrolled, commitment preserved.

### Fixed

- **A vault outage no longer masquerades as a wrong password.** A transient vault failure (e.g. rate-limit) used to silently fall back to the legacy derivation and surface a misleading "commitment mismatch"; it now throws `VaultUnavailableError`.

### Security

- The password factor's wrap key is **OPRF-gated** — `HKDF(OPRF(serverKey, scrypt(password)))` via ristretto255 — so a stolen vault blob is **not** offline-crackable; each guess needs an online, rate-limited evaluation.
- The accelerator now **verifies the auth proof's ECDSA signature** server-side (proof of key possession), on top of the Groth16 proof.

## 0.6.0-alpha.1

### Changed

- **`ejectAgentPrompt` now emits a "How to respond" section** that compels the
  agent to finish its turn with a short, plain-language reply after using tools —
  and never to end with only tool calls, an empty message, or a recitation of its
  tool list. This fixes agents (notably on `gpt-oss-*` models) that ran their tool
  loop but never posted a user-facing answer ("you can see the work, but no reply").
  Toolless agents get the "always reply" rule without the tool-specific lines.

## 0.6.0-alpha.0

### Added

- **App-describing decorators + `ejectAgentPrompt`** — declare your app's
  agent-facing surface in code and generate a system prompt for a Programmable
  Agent. Annotate a plain class with `@MuhkooAgent` (the app's identity, purpose,
  and behavioral guidance) plus per-surface member decorators — `@MuhkooSpace`
  (a channel the agent can resolve/post to), `@MuhkooDB` (an app table, with
  `access: "read" | "write"`), and `@MuhkooFunction` (a callable function) — then
  call `ejectAgentPrompt(AppClass)` to compose the `systemPrompt` string. The
  prompt carries the **semantic** layer (what the app is, how to act, what each
  surface means); the Muhkoo runtime still appends the authoritative roster
  (exact columns, function params, the closed tool list) at invocation time, so
  the prompt never restates schema or drifts from it. Also exports
  `ejectAgentTools` (derive a tools allowlist matching the described surface),
  `getMuhkooAppDescriptor`, and the `MuhkooAgentMeta` / `MuhkooSpaceMeta` /
  `MuhkooDBMeta` / `MuhkooFunctionMeta` / `MuhkooDBAccess` /
  `MuhkooAppDescriptor` / `MuhkooAgentToolsConfig` types. Requires
  `experimentalDecorators` (no `reflect-metadata` dependency). Available in the
  browser and server builds.
- **Agent tool-use via the SDK** — `client.agents.create`/`update` now accept a
  `tools` field (`AgentToolsConfig`: db read/write + table allowlist, function
  allowlist, channels, `maxIterations`), and `AgentConfig` returns it. This lets
  you grant an agent the same function-calling tool-use the portal exposes —
  e.g. `client.agents.create(appId, { handle, displayName, model, systemPrompt:
  ejectAgentPrompt(App), tools: ejectAgentTools(App) })`. Enabling tools
  requires a function-calling `model` in the same call (server-enforced). Adds
  the `AgentToolsConfig` and `AgentDbToolMode` exports.

## 0.4.0-alpha.1

### Added

- **Serverless Functions (`client.functions`)** — deploy and manage an app's
  developer-authored serverless functions from the SDK: `deploy`, `get`,
  `list`, `code` (read decrypted source), `update`, `delete`, and per-Space
  `enable`/`disable`. A function is an untrusted single-module ES worker
  (`export default { fetch }`) that runs on the accelerator with two triggers —
  **HTTP** (its own `<name>--<slug>.fns.<zone>` subdomain) and **Space-bound**
  (invoked on Space messages, like a Programmable Agent). Source is encrypted at
  rest and uploaded just-in-time on invocation. Exports `FunctionConfig`,
  `FunctionDeployInput`, `FunctionUpdateInput`, `FunctionTriggers`,
  `FunctionTrigger`, `FunctionTriggerType`, `FunctionCaps`, and
  `FunctionScopeOpts`. Management is session-authed (owner / Space editor) and
  **paid-tier-only**.

## 0.4.0-alpha.0

### Added

- **Programmable Agents (`client.agents`)** — manage an app's server-side,
  model-backed agents from the SDK: `create`, `get`, `list`, `update`,
  `delete`, and per-Space `enable`/`disable`. Exports `AgentConfig`,
  `AgentCreateInput`, `AgentUpdateInput`, `AgentProvisioned`, `AgentSkill`,
  `AgentTrigger`, `AgentTriggerType`, and `AgentScopeOpts`.
- **Space invitations & roles** — `client.space.createInviteLink` /
  `listInviteLinks` / `revokeInviteLink` / `joinByInvite`, plus
  `setMemberRole`, `members` (roster with roles), and `roster`. `InviteLink`
  now carries an optional `role` granted to redeemers.
- **File-upload progress** — `Space.putFile` / `FileStorage.writeFileToShards`
  accept an `onProgress(completed, total)` callback (per chunk) so UIs can show
  an upload progress bar.
- **`HttpClient.patch`** — JSON `PATCH` helper alongside `get`/`post`/`del`.
- **`WSTransport.urlProvider`** — optional async provider for a fresh connection
  URL on each reconnect (used for one-time/expiring WS upgrade tickets).

### Fixed

- **WebSocket reconnect with single-use tickets** — Spaces now mint a fresh
  upgrade ticket on every reconnect (via `urlProvider`) instead of reusing the
  spent one, so a dropped socket (idle timeout, network flap) reliably recovers
  instead of stalling on a channel error. Reconnect also re-schedules when an
  attempt fails before the socket opens, and Space sockets keep retrying across
  network flaps.
- **Own messages dropped on receive** — `Space` now trusts messages whose
  `source` is the local user, so a returning member (who loaded a cached key and
  never re-published their identity to the roster) no longer has the echo of
  their own messages silently dropped by signature verification.
