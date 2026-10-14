# @muhkoo/connect API Reference

> **The canonical docs are the [`muhkoo/docs`](../docs) site (`docs.muhkoo.dev`).**
> Start there for the unified `Client` (`client.auth` / `client.kv` /
> `client.db` / `client.storage` / `client.message` / `client.space` /
> `client.agents` / `client.functions`), the `@MuhkooAgent`/`@MuhkooSpace`/
> `@MuhkooDB`/`@MuhkooFunction` decorators, guides, and worked examples. This
> file is the low-level **export inventory** — the building blocks the `Client`
> composes — kept for contributors working in-tree.

Public surface of `@muhkoo/connect`. Every export listed below is real today;
deprecated / aspirational APIs have been removed.

## Installation

```bash
yarn add @muhkoo/connect
```

## Entry points

`@muhkoo/connect` has three build targets, selected automatically by
`package.json`'s `exports`:

| Condition | File |
| --- | --- |
| `workerd` | `dist/workers/index.js` |
| `browser` | `dist/browser/index.js` |
| default (Node) | `dist/server/index.js` |

The `types` condition resolves to a single bundled `dist/connect.d.ts` that
re-exports everything (so a type referenced in one runtime is still
declarable in another, even if the runtime impl is absent).

Everything documented below is exported from the main entry point,
`@muhkoo/connect`. There is one additional subpath, `@muhkoo/connect/p2p-worker`,
which resolves to the P2P block-engine Web Worker chunk and exports no API.

### What's in which build

| Symbol | browser | server | workers |
| --- | :---: | :---: | :---: |
| `BroadcastChannel`, `EncryptedSession` | yes | yes | yes |
| `WSTransport` | yes | yes | yes |
| `KeyStore`, `DoubleRatchet` | yes | yes | yes |
| `DoubleRatchetManager`, `Authenticator` | yes | yes | NO |
| `Field`, `Poseidon`, `PreimagePoK`, `HashKnowledge`, `AuthPublicInput` | yes | yes | NO |
| `verifyPreimagePoK`, `verifyHashKnowledge`, `quickVerify`, `compilePrograms`, `initializeCircuits` | yes | yes | NO |
| `PersonalSpaceClient` | yes | yes | NO |
| `wrapWithPassphrase`, `unwrapWithPassphrase` | yes | yes | yes |
| `verifyGroth16`, `initBn128Wasm`, `PREIMAGE_POK_VERIFICATION_KEY` | yes | yes | yes |
| `EventCore`, `EventCoreEvents` | yes | yes | yes |
| `Message`, `Packet`, `SerializeMessage`, `decorators` | yes | yes | yes |

The exclusions exist because `snarkjs`/`ffjavascript` use Node-only APIs
(`os.cpus`, `URL.createObjectURL`) that edge runtimes don't expose.

## Sessions

### BroadcastChannel

`src/sessions/BroadcastChannel.ts`. Turnkey multi-peer encrypted "room"
combining `WSTransport` + `EncryptedSession`.

```typescript
import { BroadcastChannel, BroadcastChannelEvents } from "@muhkoo/connect";

const channel = new BroadcastChannel({
  url: "wss://accelerator.example.dev/room/x",
  myId: "alice@example.dev",
  autoAnnounce: false, // default — call announce() yourself
  // ...rest is forwarded to WSTransport
});
```

**Options** (`BroadcastChannelOptions extends WSTransportOptions`):

- `url: string` — WebSocket URL
- `myId: string` — local identity (username, DID, pubkey string, anything)
- `autoAnnounce?: boolean` — if true, announce immediately on CONNECTED.
  Defaults to false so chat-style apps can complete a `{name}` handshake first.
- WSTransport options: `autoReconnect`, `reconnectDelay`, `maxReconnectAttempts`,
  `maxQueueSize`

**Methods**:

- `connect(): Promise<void>` — generate keys + open socket
- `disconnect(): void` — stop reconnecting and close
- `announce(): Promise<void>` — broadcast our keyExchange. Idempotent
  per-connection, but the `announced` flag **resets on every `CONNECTED`
  event** so a fresh announce fires on reconnect (the platform's websockets hit
  a ~100s idle timeout; without re-announcing, peers who joined after our
  last reconnect would never see our pubkey). If you're driving announce
  manually (`autoAnnounce: false`), wire it to your "server ready"
  signal — the SDK will let it through on every reconnect.
- `send(plaintext: string): Promise<number>` — fan-out: one cipherMessage frame
  per peer ratchet. Returns the number of peers it sent to (0 if no peers
  handshaken yet — render locally and try later).
- `sendRaw(frame: unknown): void` — JSON-stringify and send any other app frame
- `peers(): string[]`
- `forgetPeer(peerId: string): void`
- `isConnected(): boolean`
- `on(event, handler)` / `off(event, handler)` — per-instance EventTarget

**Events** (`BroadcastChannelEvents`):

| Const | String |
| --- | --- |
| `CONNECTED` | `"connected"` |
| `DISCONNECTED` | `"disconnected"` |
| `RECONNECTING` | `"reconnecting"` |
| `ERROR` | `"error"` |
| `PEER_HANDSHAKE` | `"channel:peer_handshake"` |
| `MESSAGE` | `"channel:message"` |
| `RAW_FRAME` | `"channel:raw_frame"` |

`channel:message` event detail is `{ from, text, cipherMessage }`.
`channel:peer_handshake` detail is `{ peerId }`.
Channel-managed frames are `{ keyExchange }` and `{ cipherMessage }`; any
other inbound frame fires `RAW_FRAME`.

The events live on a per-instance `EventTarget`, so two channels in the same
app do not cross-contaminate each other's events.

### EncryptedSession

`src/sessions/EncryptedSession.ts`. Transport-agnostic per-peer ratchet
manager. Use this if you want to ship frames over something other than
`WSTransport`.

```typescript
import { EncryptedSession } from "@muhkoo/connect";

const session = new EncryptedSession({ myId: "alice" });
await session.initialize();   // generates KeyStore entries if needed
const kx = await session.getOwnKeyExchange();
// transport.send(JSON.stringify(kx))
```

**Methods**:

- `initialize(): Promise<void>`
- `get ready: Promise<void>`
- `get id: string`
- `getOwnKeyExchange(): Promise<{ keyExchange: KeyExchangeFrame }>`
- `encrypt(plaintext: string): Promise<CipherFrame[]>` — fan-out across all
  ratcheted peers. Empty array means no peers yet.
- `receive(frame: IncomingFrame): Promise<ReceiveResult>`
- `peers(): string[]`
- `hasRatchetFor(peerId: string): boolean`
- `forgetPeer(peerId: string): void`

`receive()` returns `{ kind: "plaintext" | "handshake" | "ignored", ... }`. When
`kind === "handshake"` and `outbound` is non-null, the app MUST send `outbound`
back to that peer (reciprocation). The session dedups internally — `outbound`
is only set the first time per peer per session lifetime.

`kind: "ignored"` is also returned for **stale cipherMessages** — the underlying
DoubleRatchet rejects payloads older than 5 minutes as a wallclock-based replay
defense, and `EncryptedSession.receive` catches that rejection and converts it
to `ignored` instead of throwing. The real replay defense is the consumed
message key; the wallclock check is just defense-in-depth, so legacy backlog
replays and websocket idle-reconnect cycles don't spam the channel ERROR stream.

Role assignment is deterministic: `isClient = (myId < peerId)` lexicographically.
Per-pair sessionId is `[myId, peerId].sort().join(":")`.

**Frame shapes**:

```typescript
interface KeyExchangeFrame {
  type: "handshake" | "update";
  userId: string;
  ecdhPublicKey: string;   // base64(JSON.stringify(JWK))
  ecdsaPublicKey: string;  // base64(JSON.stringify(JWK))
}

interface CipherFrame {
  cipherMessage: CipherMessage;
}
```

## Transport

### WSTransport

`src/transport/WSTransport.ts`. Pure WebSocket lifecycle. Auto-reconnect with
linear backoff, capped outbound queue while disconnected.

```typescript
import { WSTransport, EventCoreEvents } from "@muhkoo/connect";

const transport = new WSTransport({
  url: "wss://example.dev/ws",
  autoReconnect: true,
  reconnectDelay: 3000,
  maxReconnectAttempts: 5,
  maxQueueSize: 100,
});

transport.on(EventCoreEvents.CONNECTED, () => { /* ... */ });
transport.on(EventCoreEvents.MESSAGE, (e) => { /* e.detail is the raw frame string */ });

await transport.connect();
transport.send("raw frame string");
transport.disconnect();
```

Emits `CONNECTED`, `DISCONNECTED`, `RECONNECTING` (`detail: { attempt }`),
`ERROR`, `MESSAGE` (raw inbound). `send()` throws if the outbound queue is
full while disconnected.

## Crypto

### KeyStore

`src/crypto/KeyStore.ts`. Singleton holding ECDH + ECDSA P-384 keypairs keyed
by identity.

```typescript
import { KeyStore } from "@muhkoo/connect";

const ks = KeyStore.getInstance();
await ks.generateOwnKeyPair("alice");
const own = ks.getKeyPair("alice");    // { privateKey, publicKey } for ECDH
const auth = ks.getAuthKeyPair("alice"); // for ECDSA

await ks.storeRemotePublicKeys("bob", bobEcdhPub, bobEcdsaPub);

const dehydrated = await ks.dehydrateKeyPair("alice");
await ks.hydrateKeyPair("alice2", dehydrated);

const packed = await ks.packDehydratedKeys("alice");  // base64(JSON)
await ks.hydrateFromPacked("alice3", packed);

const ecdsaPubBytes = await ks.getRawEcdsaPublicKey("alice"); // SEC1 uncompressed
```

**`DehydratedKeys`**:

```typescript
interface DehydratedKeys {
  ecdhPub: string;   // serialize(JSON.stringify(JWK))
  ecdhPriv: string;  // "" if remote-only
  ecdsaPub: string;
  ecdsaPriv: string; // "" if remote-only
}
```

`serialize()` is the project's gzip+base58 wrapper from `utilities`. Strings
in `dehydrateKeyPair`'s output are JWK JSON run through that wrapper.

### DoubleRatchet / DoubleRatchetManager

`src/crypto/DoubleRatchet.ts`, `src/crypto/DoubleRatchetManager.ts`. The
Signal-style ratchet primitives. `EncryptedSession` wraps them; you generally
don't construct these directly. `DoubleRatchetManager` is NOT in the workers
build (snarkjs dependency chain).

### Authenticator

`src/crypto/Authenticator.ts`. ECDSA auth-token signing and verification +
ZK proof verification. Not in the workers build.

### ZeroKnowledge

`src/crypto/ZeroKnowledge.ts`. circomlibjs + snarkjs-backed circuit utilities.
Exports include `Field`, `Field as FieldElement`, `Poseidon`, `PreimagePoK`,
`HashKnowledge`, `AuthPublicInput`, `verifyPreimagePoK`,
`verifyHashKnowledge`, `verify`, `quickVerify`, `compilePrograms`,
`initializeCircuits`, `encodeToHex`, `decodeFromHex`, plus types
`SnarkProof` (alias for `Groth16Proof`), `VerificationKey`, `ZkCompiled`,
`CircuitBufferConfig`. Not in the workers build.

## Personal-space client

### PersonalSpaceClient

`src/personal/PersonalSpaceClient.ts`. HTTP wrapper for the accelerator's
`/api/personal/:commitment/*` ZK-gated KV API. NOT in the workers build.

```typescript
const client = new PersonalSpaceClient({
  baseUrl: "https://accelerator.example.dev",
  commitment, secret, salt, ecdsaPub, ecdsaPubHash, // decimal BigInt strings
  circuits: {
    wasmUrl: "/circuits/build/preimagePoK_js/preimagePoK.wasm",
    zkeyUrl: "/circuits/build/preimagePoK_0001.zkey",
  },
});

await client.put("notes", { hello: "world" });
const v = await client.get<{ hello: string }>("notes");
const existed = await client.delete("notes"); // boolean
const keys = await client.list();
```

Each call:

1. `POST /api/personal/:commitment/challenge` to get a one-shot
   `{ challengeId, nonce, commitment }`.
2. Reduce `nonce` (hex) to a BN254 field element (mod
   21888242871839275222246405745257275088548364400416034343698204186575808495617).
3. Generate a fresh Groth16 proof via `snarkjs.groth16.fullProve` over the
   `preimagePoK` circuit. Public signals: `[commitment, nonce, ecdsaPubHash]`.
   Private witnesses: `secret, salt, ecdsaPub`.
4. POST the gated endpoint with `{ challengeId, proof, publicSignals, value? }`.

`snarkjs` is a bare-specifier import — externalized by rollup. Browser
consumers provide it via import map (the accelerator chat app uses esm.sh);
Node consumers install it as a peer dep.

### wrapWithPassphrase / unwrapWithPassphrase

`src/crypto/PassphraseWrap.ts`. PBKDF2-SHA256 (200_000 iterations) → 256-bit
AES-GCM key → encrypt with random 16-byte salt + 12-byte IV. Present in ALL
three builds — it has no snarkjs dependency (`src/workers/index.ts` exports it).

```typescript
const wrapped = await wrapWithPassphrase("hunter2", new TextEncoder().encode("plaintext"));
// wrapped: { salt, iv, ciphertext, alg: "PBKDF2-SHA256/AES-256-GCM", iter: 200000 }
//   all bytes base64-encoded
const plaintext = await unwrapWithPassphrase("hunter2", wrapped);
// throws "decryption failed (wrong passphrase or tampered payload)"
// on AES-GCM tag mismatch.
```

## Groth16 verification

### initBn128Wasm + verifyGroth16

`src/workers/groth16-verifier.ts`. Universal — works in Node, browsers, and
edge runtimes. bn128.wasm-driven, no snarkjs dependency.

```typescript
import {
  initBn128Wasm,
  verifyGroth16,
  PREIMAGE_POK_VERIFICATION_KEY,
} from "@muhkoo/connect";
import type { Groth16Proof, VerificationKey } from "@muhkoo/connect";

const { instance, memory, initialPFree } = await initBn128Wasm();
// Or, on an edge runtime, pre-compile the .wasm at deploy time:
//   import wasmModule from "./bn128.wasm";
//   await initBn128Wasm(wasmModule);

const ok = await verifyGroth16(
  instance, memory, initialPFree,
  PREIMAGE_POK_VERIFICATION_KEY,
  proof, publicSignals,
);
```

`verifyGroth16` returns `false` for any structural problem (malformed proof,
out-of-range field elements, off-curve points, failed pairing). Throws only
for WASM/runtime faults.

`PREIMAGE_POK_VERIFICATION_KEY` is pinned in `src/types/zk.ts`. If the
circuit is recompiled, regenerate this constant together with the
verification-key JSON shipped in the accelerator's
`public/circuits/build/preimagePoK_verification_key.json`.

## Filesystem and version control

### VfsNamespace / VcsNamespace

`src/vfs/VfsNamespace.ts`, `src/vcs/VcsNamespace.ts`. `client.vfs` is a
`VfsNamespace`: a tree of encrypted directory records in the user's personal
space, with file content written through `client.storage`. `client.vcs` is a
`VcsNamespace`, and `client.vcs.open(slug)` returns the `Repo` for the project
under `/apps/<slug>`. Both classes are exported, with `VfsNamespaceDeps` and
`VcsNamespaceOptions`, for constructing them yourself. Everyday use is covered
by the [VFS reference](https://docs.muhkoo.dev/reference/vfs/).

> **New in 0.14.0-alpha.9.** The rest of this section describes 0.14.0-alpha.9.
> Where 0.14.0-alpha.8 behaves
> differently, the entry says what it used to do.

#### What the SDK reads is untrusted input

Any app a user signs into holds their master seed, because hosted sign-in hands
it over. That app can therefore write any directory record, history record or
repository object, including shapes this SDK would never write. So the SDK
treats everything it reads through `client.vfs` and `client.vcs` as untrusted
input. A record that used to crash, hang or quietly mislead it now throws a
typed error, or is hidden with a warning. This is a mitigation. The root cause,
apps holding the seed, is still open.

Two rules run through what follows:

- **A tree the SDK cannot read in full is refused, never returned in part.**
  Every caller of a walk reads a missing path as a deleted one, and a sync then
  deletes it.
- **A record the SDK cannot read is left exactly as stored.** It may be one a
  newer version wrote, and rewriting it would lose that.

#### Errors

| Class | Thrown when |
| --- | --- |
| `VfsLockedError` | the master seed is not in memory |
| `VfsNotFoundError` | a path does not exist |
| `VfsConflictError` | an operation would clobber or misuse an entry, or cannot safely go ahead |
| `VfsCorruptRecordError` (new) | a directory record cannot be read |
| `VfsLimitError` (new) | a walk or copy would pass a size or depth ceiling, or a write would put a directory deeper than a walk reads |
| `VcsError` | version control refuses, including every repository record it cannot read |

The two new classes are the only additions to the public export list, and
nothing was removed from it. Everything else below sits on classes and types
that were already exported.

**`VfsLimitError`** (`name` `"VfsLimitError"`, extends `Error`) is thrown
instead of a partial result. Its fields are all readonly:

- `limit: "entries" | "pathChars" | "depth" | "shared"`: which ceiling was hit.
- `max: number`: the ceiling itself.
- `path: string`: where the operation started, or the destination for a write.
- `at: string`: where the ceiling was reached. For `entries` and `pathChars`
  it is the directory being listed; for `depth`, the entry one level too deep;
  for `shared`, the source path of the over-shared directory. It is the only
  pointer you get, because walking the tree again to find the culprit would
  stop at the same place.

Its message reads
`VFS: stopped <doing> <path>: <what> (reached at <at>).<remedy>`. `<doing>` is
`walking`, `copying` or `writing`. `<what>` is one of `it holds more than N
entries`, `its paths add up to more than N characters`, `it is nested more than
N directories deep` or `one directory appears in it more than N times`. `at` is
cut to 200 characters followed by `...`. Walking and copying end with
` If you do not recognise what is there, remove it with a recursive delete.`;
writing has no remedy. The advice names no SDK call, because the CLI prints it
to people who need `muhkoo vfs rm -r`.

**`VfsCorruptRecordError`** (`name` `"VfsCorruptRecordError"`, extends `Error`)
is thrown when a directory record does not decrypt or parse with the key its
parent holds, or does but is not a shape this SDK reads: not an object, a format
version other than 1, or `entries` missing or not a map.

- `id: string`: the record's id, kept raw. The record is stored at `vfs/d/<id>`.
- `path?: string`: the path it was reached through, when known. A moved subtree
  can have two paths, and the error names whichever was asked for first.

Its message reads
`VFS: <path, or "a directory"> (record <id>) cannot be read: <reason>. <remedy>`.
The path and id are escaped, with control and bidi characters written as
`\uXXXX`, and the id is cut to 40 characters. The reason is one of `it is not a
sealed record`, `its envelope is not base64`, `its envelope is the wrong size`,
`it does not decrypt with the key it should`, `it decrypts, but not to a
record`, `it is not an object`, `it has format version <v>, and this version
reads only 1` or `its entries are missing or not a map`. The remedy is `It has
been left as stored; remove it with a recursive delete.` For the root record
(id `root`) it is `It is the root of this filesystem, so it cannot be deleted;
nothing has been changed.`

The record is never read as an empty directory, because the next write would
seal an empty record over the real one, and it is never skipped. A record that
does not exist at all still reads as an empty directory: that is how the root
and every new directory start.

```typescript
import { VfsCorruptRecordError, VfsLimitError } from "@muhkoo/connect";

try {
  const files = await client.vfs.walk("/apps/my-app");
} catch (err) {
  if (err instanceof VfsLimitError) {
    // err.limit and err.max say which ceiling; err.at is where it stopped.
  } else if (err instanceof VfsCorruptRecordError) {
    // err.path is where it was reached. err.id is raw: print err.message.
  } else throw err;
}
// The remedy for either is removing what you do not recognise:
//   await client.vfs.delete(path, { recursive: true });   // or: muhkoo vfs rm -r <path>
```

#### New methods and options

- **`vfs.walkEntries(path = "."): Promise<VfsStat[]>`** returns every entry
  under a prefix, directories as well as files, depth-first. Each directory
  comes just before its contents. Within a directory the order is directories
  first, then by name (`localeCompare`). `walk(path)` is now exactly this list
  filtered to files and mapped to paths, so the two cannot disagree. Version
  control uses it because a commit records empty directories too.
- **`vfs.eachEntry(path, visit): Promise<void>`** is `walkEntries` without
  building the list. `visit(stat: VfsStat, manifest: FileManifest | null)` is
  called for each entry in the same order. `manifest` is the file's manifest
  (the handle `statManifest` would give, without resolving the path again), or
  `null` for a directory. `path` has no default. It is for callers that compare
  as they go instead of holding the whole tree; `repo.status()` and
  `repo.commit()` use it. `walk` is built on it, so it has the same cycle guard,
  budgets, depth ceiling and errors.
- **`vfs.assertCreatable(dirs: Iterable<string>): Promise<void>`** checks in
  advance what creating these directories with `mkdir -p` would refuse part
  way, and writes nothing. Relative paths resolve against `cwd` and duplicates
  are ignored. It throws `VfsLimitError` (`depth`, `writing`) for a directory
  more than 64 below the root, and `VfsConflictError` when a missing name on the
  way is held by an entry this version cannot read. A *file* in the way is not
  refused, because the intended caller, a checkout, removes files first. The
  SDK uses it so a checkout refuses before deleting anything.
- **`repo.abortMerge(): Promise<void>`** deletes the pending-merge record, so the
  next commit is an ordinary one with one parent. It gives up on a merge that
  stopped for conflicts and leaves the working tree as it is, conflict markers
  and all. `switchTo(await repo.currentBranch(), { discardChanges: true })`
  puts the tree back (or, on a detached HEAD,
  `checkout(await repo.current(), { discardChanges: true })`). Do not use
  `checkout` on a branch: it always detaches HEAD, so later commits would no
  longer move the branch. It is also the way out when the pending-merge record
  cannot be read, which would otherwise make every commit throw.
- **`limits?: { entries?: number; pathChars?: number }`** on `VfsNamespaceDeps`
  bounds one walk (and so `glob`, `walkEntries` and `eachEntry`) or one copy:
  `entries` is the most entries it may visit, `pathChars` the most characters
  of path text summed over every path it visits. The same option on
  `VcsNamespaceOptions` bounds one read of history: the most tree entries one
  `status`, `diff` or `checkout` may visit, and the characters of those paths.
  Path text has its own budget because a name may be 255 bytes and one path
  about 16KB, so counting entries alone does not bound memory. `Client` passes
  neither, so `client.vfs` and `client.vcs` always have the defaults; the option
  exists for constructing a namespace yourself, and the tests lower it.
- **`moving?: true`** is a new optional stored field on `FileEntry` and
  `DirEntry` (not on `VfsStat`). It is set on both copies while a move between
  two directories is under way and cleared by the move's last write, so a
  delete of a marked entry knows to look for the other copy before letting go of
  anything. Left in place, the mark costs a delete of that entry one read of the
  whole tree, and a marked file keeps every version that falls off its history.
  `writeFile`, `writeManifest` and `restore` keep the mark on the entry they
  replace.

#### Limits

| Ceiling | Value | Configurable |
| --- | --- | --- |
| Entries one walk or copy visits | 500,000 | `limits.entries` |
| Characters of path text one walk or copy produces | 32,000,000 (64 x entries) | `limits.pathChars` |
| Entries one read of history (`status`, `diff`, `checkout`) visits | 500,000 | `limits.entries` on `VcsNamespaceOptions` |
| Characters of path in one read of history | 32,000,000 | `limits.pathChars` on `VcsNamespaceOptions` |
| Depth of a walk, below where it starts | 64 directories | no |
| Depth of any directory written, from the root | 64 directories | no |
| Depth of a repository tree, under `/apps/<slug>` | 62 levels | no |
| Record fetches in flight per walk | 64 in total (was 8 per directory being listed) | no |
| Places one directory may appear in a copied tree | 4 | no |
| Nesting inside a record | 32 levels (the SDK writes five) | no |
| Entry ids | 1-64 characters of `A-Z a-z 0-9 _ -` | no |
| Branch names | at most 200 characters | no |
| Times | must fit in a `Date` (\|t\| <= 8.64e15 ms) | no |
| Yield to the event loop | every 8,192 entries | no |

Unchanged: a name may be at most 255 UTF-8 bytes, and history keeps 20
versions per file by default.

#### Walks

- **Traversal.** `walk` (and `glob`, `walkEntries`, `eachEntry`) visits one
  directory at a time, depth first, holding only its output and its current
  path. One pool of 64 record fetches, shared by the whole walk, reads ahead of
  it. The old walk listed sibling directories 8 at a time per directory, which
  multiplied down the tree. What a walk returns, and the order, are unchanged.
  A cold walk of a 333-directory project takes about 0.37s at 30ms per fetch,
  against 0.25s before; the worst planted fan-outs at the default budgets now
  peak under 300MB of heap. A walk that fails stops fetching, where it used to
  keep fetching in the background.
- **Cycles.** The cycle guard works on directory identity along the current
  path, where it used to track paths. Two records of about 120 bytes whose
  entries point back at themselves used to crash `vfs mount`, `vfs tree` and
  `vcs status`. Directories above the starting point count, so a pointer back
  above where the walk began is a cycle too. A directory that is one of its own
  ancestors is skipped with the warning `[muhkoo/vfs] skipping <path>: it is one
  of its own ancestors (the tree contains a cycle)`, once per walk. A directory
  reachable from two parents, which an interrupted rename can leave, still
  appears under both.
- **Budgets and depth.** Past the entry budget, the path-text budget or 64
  levels below the start, a walk throws `VfsLimitError`. Budgets are charged
  per directory listing, before any of that listing's paths are built. The
  depth ceiling used to stop quietly, with a warning, and return the shallower
  part, which a sync reads as everything deeper having been deleted.
- **Yielding.** Every 8,192 entries a walk yields a turn of the event loop and
  parks the whole walk. It uses `setImmediate` where available, otherwise a
  `MessageChannel` message (browsers), and `setTimeout(0)` only when neither
  exists. It does not use `scheduler.yield()`, which runs ahead of timers and
  messages already queued. Before, a fully cached walk never waited, which froze
  a tab or made `vfs mount` ignore Ctrl-C. Reading history for `status`, `diff`
  and `checkout`, `merge`'s pass over every path, `sweep`'s whole-tree read,
  `copy`'s dry run and `assertCreatable` yield the same way.

#### Reading records

- **Malformed records** throw `VfsCorruptRecordError` from every operation whose
  path runs through them: `list`, `stat`, `exists`, `cd`, `walk`, reads and
  writes. They used to throw a `TypeError`, a `SyntaxError` or a bare decryption
  failure, and a stored value that was not a sealed envelope used to read as an
  *empty* directory, so the next write sealed an empty record over the real one.
- **Entries this version cannot read are hidden**, not fatal to the directory:
  an unknown kind (perhaps a newer SDK's), a file whose manifest is missing or
  has no string id, a directory whose key is not base64 of 32 bytes, an id this
  SDK could not have minted, or an unusable name. Such an entry disappears from
  `list`, `stat`, `exists` (even by its exact name), `walk`, `glob` and `copy`,
  with one warning per record read:
  `[muhkoo/vfs] ignoring <n> entr(y|ies) with an unusable name and <n> entr(y|ies) this version cannot read ... in <path>`.
  Names are counted, never printed. The entry is written back untouched
  whenever its directory changes, so an older SDK no longer erases what a newer
  one stored.
- **Entry ids** must match `^[A-Za-z0-9_-]{1,64}$`, for files and directories
  alike. The SDK mints up to 22 letters and digits, and the root's id is `root`. Any
  other id is hidden like an unreadable entry: never fetched, and removed by a
  recursive delete of its directory. An id becomes a store key that is put in a
  URL: a lone surrogate made `encodeURIComponent` throw, and an id past the
  server's 2048-byte key limit got a 500 from every walk above it and every
  attempt to delete it.
- **Names.** The rule is unchanged, but it is now applied once, when a record is
  read. A usable name is non-empty, is not `.` or `..`, contains no `/` or
  backslash, no C0/C1 control characters (U+0000-U+001F, U+007F-U+009F) and no
  bidi overrides (U+202A-U+202E, U+2066-U+2069), and is at most 255 UTF-8 bytes.
  An entry with an unusable name is hidden, still counts as a reference for
  `sweep()`, and goes with a recursive delete of its directory. It used to be
  filtered and warned about on every visit of every walk, without counting
  against the walk's budget. Writes still reject such names with
  `VFS: <json name> is not a usable name`.
- **Built-in property names work.** Files and folders named `constructor`,
  `toString`, `__proto__` and the rest work in the working tree and in commits,
  because entry maps have no prototype. Before, `exists("/constructor")` was
  true on an empty filesystem, `src/constructor/` could not be created, and a
  file named `__proto__` was reported written but stored nowhere.
- **Numbers in stats are usable numbers.** `mtime`, `size` and `versions` in a
  `VfsStat` (from `list`, `stat`, `walkEntries`, `eachEntry` and `stat("/")`),
  and `size` and `mtime` in `history()`, read as 0 when stored as something
  else: an `mtime` that is not a number or is outside a `Date`'s range, or a
  size or version count that is not a non-negative safe integer. A planted
  `mtime` of `"yesterday"` or `1e300` used to pass straight through, and
  `muhkoo vfs ls` crashed formatting it.
- **Deep nesting is dropped on read.** Any entry, top-level record field or
  history version nested more than 32 levels deep is dropped with a warning
  (`... value(s) nested too deeply to keep`, or `ignoring <n> version(s) of
  <path> this version cannot read`). `JSON.parse` accepts nesting that
  `JSON.stringify` cannot write, so one such value used to make every write to
  that directory, or every save of that file, throw `RangeError`. A write that
  still cannot be serialized throws `VfsConflictError`
  `VFS: cannot write to <dir>: it would hold a value nested too deeply to store`.

#### The root

`exists("/")` now returns `true`, and `stat("/")` returns
`{ path: "/", name: "", kind: "dir", size: 0, mtime: <root record mtime>, versions: 0 }`,
including when `/` is reached through a relative path such as `.` with `cwd`
`/`. Before, `exists("/")` was `false` and `stat("/")` threw
`VfsNotFoundError`, so `vfs mount` at its default root of `/` saw an empty
remote on every pass. **Behaviour change:** while the VFS is locked, both now
throw `VfsLockedError`. `exists("/")` used to answer `false`, which read as an
empty filesystem rather than a locked one.

#### Writing, moving and copying

- **Depth.** `writeFile`, `writeManifest` and `mkdir` throw `VfsLimitError`
  (`depth`, `max` 64, `stopped writing ...`) for a directory more than 64
  levels below the root, and write nothing. A file may still sit in a directory
  64 levels deep; for `writeFile` and `writeManifest`, the error's `path` is the
  parent directory being created. `rename` and `copy` of a directory are refused
  the same way when it, or anything in it, would land deeper, and the error
  names the destination. The reason is that a walk refuses more than 64 levels,
  so a tree written 65 deep under `/` made every walk of the root fail,
  including every pass of `vfs mount` at its default root.
- **Hidden names.** `writeFile` and `writeManifest` to a name held by a hidden
  entry replace it. `rename`, `copy` and `mkdir` onto it, including the parent
  directories `writeFile` and `writeManifest` create, throw `VfsConflictError`
  `VFS: <path> already exists, but this version cannot read it; a recursive
  delete removes it`, and a checkout that needs the name is refused the same
  way.
- **`rename`.** A rename within one directory is now a single write, so it
  cannot be interrupted half way. A move between two directories still attaches
  before it detaches, but both copies carry `moving` until the last write clears
  it, and a file's history is re-sealed for its new directory. Moving a
  directory *deeper* first reads the whole subtree to check depth; a move that
  is not deeper still writes only the two parents. If the subtree cannot be
  read, the depth check does not stop the move.
- **`copy`** runs a dry pass over the whole source tree before it writes
  anything, checking cycles, depth, both budgets and unreadable records, so a
  copy that is going to fail fails before its first write. It used to fail part
  way, leaving orphaned records and references. A directory that appears in more
  than 4 places in the source throws `VfsLimitError` (`shared`, `path` = source,
  `copying`). The copy shares the walk's `entries` and `pathChars` budgets.
  Depth is counted per branch, from the root, at the destination (`depth`,
  `writing`, naming the destination). A true cycle throws `VfsConflictError`
  `VFS: refusing to copy a directory that contains a cycle` (the old message
  carried a doubled `VFS: VFS:` prefix). A subtree reachable twice is copied
  under both names. Hidden entries and unusable names are not carried over.
  Copied files still get new ids and no history. Copying a tree with more than
  64 directories no longer fails with a false "contains a cycle" error.

#### History

- **Checked like a directory record.** A history version with no manifest, or
  whose manifest has no string id, is left out with a warning, and `history()`
  and `restore(path, index)` leave out the same ones. Before, `history` skipped
  non-objects but `restore` did not, so `restore(path, 0)` could mean a
  different version from the first one listed. A history record that is missing
  or is not a sealed envelope is still an empty history.
- **A moved file keeps its history** and can be written again, because a move
  re-seals the history for its new directory. Before, every later `history`,
  `restore` and `writeFile` of a moved file failed with a bare decryption error.
  A history that does not open with its directory's key (moved by an earlier
  version, or shared by the two halves of an interrupted move) is tried with
  every other directory key in the tree, which is a whole-tree read. An earlier
  version's move is then re-sealed, so that search happens once. If no key opens
  it: `VfsConflictError`
  `VFS: the version history of <path> cannot be read: <problem>. Nothing has been changed; a copy of the file starts a history of its own`.
- **Each version is released once**, and only when nothing else names it.
  `restore` puts a version back without taking a new reference, so one manifest
  can be both the file's content and in its history. Deleting a file, or
  recursively deleting a directory holding two copies of one file, used to
  release it once per mention, and could free bytes a copy still used; `restore`
  of the oldest version released the very version being restored. A version
  that falls off a full history is now released only when neither the file nor
  the rest of the history names it. A file marked `moving` releases nothing that
  falls off its history.

#### Deleting and sweeping

- **Order.** `delete` reads everything it will touch, detaches the entry, and
  only then releases content. Any failure before the detach, such as a network
  error, changes nothing, so retrying is safe. Before, content was released
  first and the entry removed last, and a retry after a failure part way
  released shared content a second time.
- **Scope.** A recursive delete no longer reaches above its target. Before, an
  entry under `/junk` pointing at the root pulled the whole filesystem into the
  delete, root record included. The root, and every directory on the way down
  to the target, are left alone with the warning `leaving <a directory that is |
  n directories that are> above <target> in the tree alone while deleting it`.
  If the target itself points at a directory above it, a recursive delete only
  detaches it (`detaching <target> without clearing it out: it is a directory
  above it in the tree`) and a non-recursive one throws `<target> is not empty`.
  A directory holding only hidden entries is not empty either.
- **Hidden entries.** A non-recursive delete of a name held by a hidden entry
  throws `VfsConflictError`
  `VFS: <path> cannot be read by this version; a recursive delete removes it`;
  it used to throw `VfsNotFoundError`. A recursive delete of that exact name
  detaches it without reading or releasing what it holds, and warns
  `removed <path> without clearing out what it held: this version cannot read it`.
- **Unreadable records.** `delete(path, { recursive: true })` on a directory
  whose record throws `VfsCorruptRecordError` detaches it without clearing it
  out (`detaching <path> without clearing it out: its record cannot be read`),
  leaving what it held for `sweep`. Without `recursive`, the error is thrown.
  Inside a recursive delete, an unreadable subdirectory is skipped with a
  warning and the rest is deleted; any other failure stops the delete before
  anything is released.
- **`keepContent`.** `delete(path, { recursive: true, keepContent: true })` now
  keeps the content of everything in a directory it removes, as it already did
  for a single file (only history records are deleted). A checkout needs this
  to turn a directory back into the file it replaced; before, the directory's
  files were released and the checkout was left half done.
- **Interrupted moves.** Deleting an entry marked `moving`, or a directory that
  contains one, first reads the whole tree once and keeps whatever is still
  named elsewhere: directory records, and each file's content and history.
  Before, deleting the unwanted copy left by an interrupted move took the other
  copy's contents with it. If part of the tree cannot be read, the delete
  detaches but keeps everything, which costs only storage (`detached <target>
  but kept what it held: a move of it was interrupted, ...`). When exactly one
  marked copy is left, the delete also clears its mark.
- **`sweep()`** throws `VfsCorruptRecordError`, before deleting anything, when a
  record reachable by a path cannot be read. It refuses with `VfsConflictError`
  `VFS: refusing to sweep: <n> entr(y|ies) in this filesystem cannot be read by
  this version, so what they reference is unknown; upgrade, or sweep with force
  to go ahead anyway` when any entry cannot be followed: an entry this version
  cannot read, or an unreadable record behind an unusable name, which no path
  can reach. `sweep({ force: true })` goes ahead, keeps such a record and
  carries on. Entries hidden only for their name are still followed, so what
  they point at is not swept. The empty-root refusal now ends `sweep with force
  if it really is empty` instead of `pass { force: true } if it really is
  empty`.

#### Version control

- **Every object is checked against its hash.** A mismatch throws `VcsError`
  `object <first 8 hex> does not match its hash: this repository did not write
  it, or it is corrupt`. Before, a planted tree could contain itself, and
  `status`, `diff`, `checkout`, `switchTo` and `merge` hung. Every object the
  SDK has ever written verifies, because hashing has never changed. A reference
  that is not a 64-character lowercase hex SHA-256 throws `a reference in this
  repository is not an object hash`. When committing, a forgery planted at the
  address of a tree about to be written is overwritten rather than trusted.
- **Object read errors.** A missing object throws `object <8 hex> is missing
  from this repository`. One that is not a sealed record, does not decrypt or
  is not JSON throws `object <8 hex> cannot be read: <reason>`, with the same
  reasons as `VfsCorruptRecordError`; one nested too deeply to hash throws
  `object <8 hex> cannot be read: it is nested too deeply`. These used to
  surface as a bare `DOMException` or `SyntaxError`.
- **Commits are shape-checked** in `log`, `diff`, `status`, `checkout`, `merge`,
  `mergeBase` and `resolve`. A commit needs `v === 1`, `tree` an object hash,
  `parents` an array of object hashes, `message` and `author` strings, and `at`
  a number within a `Date`'s range. Otherwise: `object <8 hex> is not a commit
  this version can read: <problem>`, where the problem is `it is not a commit
  this version can read`, `its tree is not an object hash`, `its parents are not
  a list of object hashes`, `its message or author is not text` or `its time is
  not a time`.
- **Trees are shape-checked.** A tree must be `{ v: 1, entries: <map> }`, or
  `object <8 hex> is not a tree this version can read` is thrown. An entry is
  skipped when its name fails the VFS name rule (so `../x` or `..` can never
  land outside the project on checkout), its kind is unknown, a subtree hash is
  malformed, or a file has no manifest with a string id. Skipping warns
  `[muhkoo/vcs] ignoring <n> unreadable entr(y|ies) in tree <8 hex>`.
- **History reads have a budget.** Reading a commit's files, or diffing two
  commits, shares one budget per read: 500,000 entries and 32,000,000
  characters of path by default, and 62 directories below `/apps/<slug>` (the
  deepest a checkout could write). Past it: `VcsError` `stopped reading history:
  <it holds more than N entries | its paths add up to more than N characters |
  it is nested more than 62 directories deep>, which no real project does - the
  repository may have been tampered with`. It is thrown before the working tree
  is touched, in `status`, `diff`, `checkout`, `switchTo`, `merge` and
  `repo.restore`. Identical subtrees are fetched once but still listed under
  every name they appear at.
- **Project names.** `client.vcs.open(slug)` throws `VcsError` `"<slug>" is not
  a project name` unless the slug is a single usable name under the VFS name
  rule. `demo/`, `..` and `a/b` are rejected, not normalised. Before,
  `--project demo/` committed an empty tree while reporting success, and
  checking that commit out deleted every file in the project.
- **Branch names** must match `^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$`: a letter or
  digit, then letters, digits, `.`, `_`, `/` or `-`, at most 200 characters in
  all. The cap is new, because a name is also a store key and a longer one got a
  bare server error. `branch()` throws `"<name>" is not a usable branch name`,
  and names read back from HEAD, the branch list and a pending merge are held to
  the same rule.
- **`commit()` and `status()` read the working tree through the guarded walk.**
  `commit()` builds its trees from one `vfs.eachEntry` walk of `/apps/<slug>`,
  with the walk's cycle guard, budgets and depth ceiling; before, it recursed by
  path with no guard, and a directory naming itself hung it. `status()`
  compares against HEAD as it walks, and neither looks each file up again by
  path (a planted 50-deep tree took `status` 4.6s before, 0.17s now). Both can
  now throw `VfsLimitError` or `VfsCorruptRecordError` from the working-tree
  side. Empty directories are still recorded.
- **Checkout checks before it deletes.** `checkout`, `switchTo` and a
  fast-forward `merge` read the target commit's files in full, walk the working
  tree once and check every directory they need with `vfs.assertCreatable`, all
  before deleting anything. A tree that cannot be read, or a directory blocked
  by a hidden entry or the depth limit, throws with the working tree unchanged;
  it used to stop half way with files gone and HEAD unchanged. The checkout then
  deletes files the commit lacks (keeping content), recursively deletes
  directories where the commit has a file (keeping content), and writes the
  commit's files.
- **Abbreviated hashes.** When resolving one, only store keys that are full
  object hashes count as matches, so a stray key under the prefix no longer
  makes every abbreviation of it "ambiguous".

Records that are not objects, and how to recover from each:

| Record | Error (`VcsError`) | Recovery |
| --- | --- | --- |
| HEAD present but the wrong shape, or naming an invalid branch or a non-hash | `HEAD cannot be read[: <reason>]; check out a branch or a commit, discarding changes, to replace it` | `checkout(commit, { discardChanges: true })` or `switchTo(branch, { discardChanges: true })`; neither reads HEAD first. A missing HEAD still means the default branch. |
| A branch ref that does not name a commit | `branch "<name>" cannot be read: it does not name a commit; create the branch again, at a commit, to replace it` | `branch(name, at)` replaces it, with a warning |
| The branch list itself | `the list of branches cannot be read; creating a branch replaces it` | creating any branch replaces it, with a warning. Individual invalid names are left out with `ignoring <n> branch name(s) this version would not accept` instead of hiding every real branch. |
| A pending merge that is not `{ theirs: <hash>, name: <valid branch> }` | `the merge in progress cannot be read[: <reason>]; abort the merge to clear it` | `repo.abortMerge()` (from the CLI: `muhkoo vcs merge --abort`, with `--discard` to put the tree back too). Until then every `commit()` throws, because it reads the record, and so does `pendingMerge()`: a caller that only reports status should catch this error rather than fail on it. |

HEAD and the branch list used to fall back to the default branch or an empty
list, or throw a `TypeError`.

#### Warnings

Records the SDK sets aside produce `console.warn` lines prefixed
`[muhkoo/vfs]` or `[muhkoo/vcs]`, which the CLI shows. Names unfit to print are
counted, never printed, and record ids and format versions in messages are
escaped, so a planted value cannot send terminal control sequences. Commit
messages come back from `log()` exactly as written, newlines included:
escaping them is the printer's job.

#### Migrating

- Expect `VfsLimitError` and `VfsCorruptRecordError` from `walk`, `glob`,
  `walkEntries`, `eachEntry`, `list`, `stat`, `exists`, `copy`, `rename` and the
  write methods, where you used to get partial results or generic errors.
- Code that relied on `exists("/")` returning `false` while locked must handle
  `VfsLockedError`.
- Expect `VcsError` for an unreadable HEAD, branch ref, branch list, pending
  merge, commit or tree.
- The remedy for an unreadable record or an over-budget tree is a recursive
  delete: `delete(path, { recursive: true })` in the SDK, `muhkoo vfs rm -r
  <path>` from the CLI.

#### Not fixed

- **Memory.** Enough distinct directory records, or large enough ones, can
  still run a walk out of memory. The namespace caches every record it reads
  until the record changes or `clearCache()` is called, and nothing limits a
  record's size short of the store's value limit of about 2MB. A few hundred
  records of about 1MB each exhausted a 512MB heap (affecting `vfs mount`, `vcs
  status` and `vcs commit`); a few thousand of 1.4MB exhausted Node's default
  heap of about 4GB; half a million empty directories, inside the entry budget,
  exhausted 512MB. The whole-tree read used by `sweep`, by deleting a marked
  entry, and by `history`, `restore` or a save of a file whose history needs
  another key, has no entry budget. This is accepted as a denial of service by
  someone who can already delete everything. A bounded cache was tried and
  removed: it re-fetched the whole tree on every walk and could lose one of two
  concurrent saves.
- **The root record.** An unreadable root has no in-product recovery, because
  the root cannot be deleted.
- **Interrupted moves** (storage cost, never data loss). If a move's last write,
  the one that clears the `moving` mark, is the write that fails, the only copy
  stays marked, a retried move carries the mark over, and that file keeps every
  version that falls off its history from then on. Copies left by a move
  interrupted before this version are not marked. The two halves of an
  interrupted move share one history key, so the half whose directory key does
  not open it reads the whole tree on every `history`, `restore` and save until
  the other half is deleted.
- **Orphaned history.** A file moved by an earlier version whose old directory
  has since been deleted has no key left that opens its history. It cannot be
  saved in place (`VfsConflictError`), each refused save has already uploaded
  its content, and nothing releases that. Copying the file, which starts a fresh
  history, is the way out.
- **Checkout write failures.** A checkout whose writes fail part way, most
  simply on a network error, can still be left half done. The up-front checks
  cover only what can be known before writing.
- **Refusal as denial of service.** A seed holder can still plant a tree that
  makes every walk of the subtrees above it throw `VfsLimitError` or
  `VfsCorruptRecordError`, or makes `sweep` refuse, until the entry is removed
  with a recursive delete. These refusals are deliberate, because returning part
  of the tree would read as deletions. `sweep({ force: true })` past entries
  this version cannot read may delete records only those entries referenced.
- **The root cause.** Hosted sign-in hands every app the master seed, so any app
  the user signs into can read, re-seal and overwrite any record in their
  filesystem and repositories. Other users' filesystems are not affected.

## Types

Every published type ships in the single rolled-up `dist/connect.d.ts`
(generated from `src/browser/index.ts` — see `rollup.dts.config.js`). There is
no `src/index.d.ts`.

The shared type modules under `src/types/` (`src/types/index.ts` re-exports all
of them wholesale) are: `crypto.ts`, `identity.ts`, `permissions.ts`,
`messaging.ts`, and `zk.ts` — the latter carrying `Groth16Proof`,
`VerificationKey`, and `PREIMAGE_POK_VERIFICATION_KEY`.

Earlier revisions of this file listed `Attribute`, `Tag`, `FileOptions`, and
`FilesInterface` here. None of those exist any more — the file-layer types are
`WriteFileOptions` (`src/core/namespaces/FileNamespace.ts`) plus `FileStat` /
`FileManifest` (`src/storage/types.ts`).

## Events

`EventCore` (`src/events/EventCore.ts`) is a static event emitter built on
`EventTarget` plus an enum of standard event names. `WSTransport` extends it;
`BroadcastChannel` uses its own per-instance EventTarget but reuses
the `EventCoreEvents` enum values for lifecycle event names.

```typescript
export enum EventCoreEvents {
  CONNECTED = "connected",
  DISCONNECTED = "disconnected",
  RECONNECTING = "reconnecting",
  ERROR = "error",
  DATA_RECEIVED = "data_received",
  DATA_SENT = "data_sent",
  MESSAGE = "message",
  GET_HISTORY = "get_history",
  RECEIVED_HISTORY = "received_history",
}
```

## Messaging

`Message`, `Packet`, `SerializeMessage` decorator, `decorators` namespace
(`src/messaging/index.ts`). Used by the packet-cipher layer
(`src/network/PacketCipher.ts`) and the space transport
(`src/spaces/Space.ts`, `src/spaces/SpaceCipher.ts`). Useful if you're
building your own protocol on top of `WSTransport`.

## Things that DO NOT exist (despite older docs)

- `MuhkooClient` — the unified client class is `Client` (with `client.auth`,
  `client.storage`, `client.message`). There is no `client.shared`.
- `Network` class — deleted. `src/network/` still exists and still exports
  `PacketCipher` / `DoubleRatchetCipher` (`src/network/PacketCipher.ts`), but
  there is no `Network` class to import.
- `Attribute`, `Tag`, `FileOptions`, `FilesInterface` — listed by older
  revisions of this file; none of them exist in `src/` or in
  `dist/connect.d.ts`.
- `SessionManager`, `ApiClient` — referenced by old examples and integration
  tests; do not exist in `src/`.

## License

MIT — see [LICENSE](./LICENSE).
