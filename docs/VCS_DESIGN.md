# Version control over the Muhkoo VFS

Snapshots, branches and merge for a project stored in `client.vfs`.

## Why not just use the VFS's file history

`vfs.history()` / `vfs.restore()` version **one file**. They cannot answer "put
the project back to this morning", because nothing records which versions of
which files were coherent together. That relationship is the whole point of a
commit.

## Two object spaces, deliberately

| | Working tree | Repository |
| --- | --- | --- |
| Where | `/apps/<slug>` in the VFS | `vcs/<slug>/…` in the personal space |
| Keyed by | stable random directory ids | **content hash** |
| Mutable | yes — edits land here | never |
| Purpose | fast reads, in-place edits | immutable history |

The working tree uses mutable ids on purpose: a file write must touch one record
([[VFS design]]), which content-addressing would prevent — every write would
rewrite every ancestor. History needs the opposite: objects that never change,
so a commit means the same thing forever. Git makes the same split (working
directory vs `.git/objects`), and for the same reason.

## Objects

All sealed with the project's VFS key, so the server stores ciphertext.

```
blob    NOT STORED — a file's bytes are already a FileManifest in the VFS,
        and shards are content-addressed. A commit references the manifest.

tree    { v:1, entries: { <name>: { kind:"tree", hash } | { kind:"file", manifest, size } } }
        Addressed by the SHA-256 of its canonical JSON. An unchanged directory
        therefore has the same hash in every commit that contains it, so a deep
        project costs one new tree per changed directory, not per commit.

commit  { v:1, tree: hash, parents: string[], message, author, at }
        Addressed by its own hash. `parents` is an ARRAY: one for a normal
        commit, two for a merge, zero for the first.
```

**No blob objects.** Content already lives in the content-addressed shard store
and is described by a `FileManifest`. Introducing a second content layer would
duplicate every byte and gain nothing.

## Refs

```
vcs/<slug>/HEAD         → { branch }  or  { detached: commitHash }
vcs/<slug>/refs/<name>  → commitHash
```

## Operations

- `commit(message)` — walk the working tree, write trees bottom-up, write the
  commit, advance the current branch.
- `log()` — walk `parents` from HEAD.
- `checkout(ref)` — materialise a commit's tree into the working tree. Cheap:
  file entries carry manifests, so **no file content moves** — only directory
  records are rewritten.
- `diff(a, b)` — compare trees; identical subtree hashes prune whole branches of
  the walk without reading them.
- `branch(name)` / `switch(name)` — a branch is a name pointing at a commit.
- `merge(other)` — see below.

## Merge, which is the hard part

The server can help with none of it: it holds ciphertext and cannot diff, so
every merge is client-side and needs base, ours and theirs **fetched and
decrypted**.

1. **Merge base** — the most recent commit reachable from both heads. Walk both
   ancestries; first common hash wins.
2. **Per path**, compare `base`, `ours`, `theirs` manifests:
   - identical on both sides → keep
   - changed on one side only → take that side
   - deleted on one side, untouched on the other → delete
   - changed on both sides → three-way merge the CONTENT
3. **Content merge** — diff3 over lines for text. **Binary files cannot be
   merged**: a conflict is raised and the user picks a side. Content type comes
   from the manifest, so this is decidable without reading the bytes.
4. **Conflicts** are written into the working tree with markers and recorded in
   `vcs/<slug>/MERGE`, so resolving is ordinary editing followed by `commit`.

## What this does NOT do

- **No remotes, no fetch/push.** Every device already sees the same personal
  space, so "syncing" is a matter of two clients writing the same refs — the
  distributed part is already true. Concurrent ref writes are last-writer-wins
  at the personal space, so a lost race can strand a commit; the objects survive
  and `reflog` (a later addition) would recover it.
- **No rebase, no cherry-pick, no submodules.** Later, if wanted.

## Phases

All four are built.

1. **Objects + commit/log/checkout/diff** — the foundation everything else needs.
2. **Branches** — refs, `switch`, and detached HEAD.
3. **Merge** — base finding, three-way, conflict markers.
4. **Surfaces** — `muhkoo vcs …` in the CLI, history/branch UI in the IDE.

## Decisions made while building

A few things the design above did not settle, decided against real failures the
tests caught:

**A commit retains what it records.** Content is reference-counted, and the
working tree was the only thing holding a reference. Deleting a file after
committing it therefore freed shards the commit still needed, and the history
became unreadable. `commit()` takes the repository's own reference, and
`checkout` deletes with `keepContent` so materialising an old state never frees
anything history points at.

**Mergeability is judged by content, not by the declared type.** The MIME type is
a hint the VCS does not own: a content store may omit it, and files with no
extension to derive one from (`Makefile`, `LICENSE`, `.gitignore`, `.env`) get
`application/octet-stream`. Trusting the label made every one of those an
unmergeable false conflict. Obvious binary types are still rejected without
reading — merging a video is never the answer — but anything else is sniffed:
a NUL byte or invalid UTF-8 means binary, everything else merges.

**Moving refuses to overwrite uncommitted work.** `switch`, `checkout` and
`merge` all replace the working tree, and unlike an ordinary write nobody asked
for it. Each refuses while there are uncommitted changes, naming the files at
risk, and takes `{ discardChanges: true }` for the case where losing them is the
point.

**A conflicted merge is finished by the next commit.** The other side is recorded
under `mergeKey(slug)` when the merge stops, and consumed as the second parent
when you commit the resolution. Without that the resolving commit would have one
parent, and the two branches would still read as diverged afterwards.
