# @muhkoo/connect

Client SDK for the Muhkoo Accelerator. The headline surface is a single
**`Client`** that hangs everything off its namespaces —
`client.auth` / `client.kv` / `client.db` / `client.storage` / `client.vfs` /
`client.vcs` / `client.message` / `client.space` / `client.agents` /
`client.functions` / `client.accessTokens` / `client.offline` — backed by
end-to-end-encrypted messaging (fan-out group channels with history, plus Double
Ratchet + ECDH P-384 for direct messages), ZK identity + personal/shared spaces,
server-side Programmable Agents, developer-authored serverless functions, and an
edge-compatible Groth16 verifier — all bundled from a single
TypeScript source tree.

See [`CHANGELOG.md`](./CHANGELOG.md) for what's new.

> Status: alpha. The library is consumed in tree by `../accelerator` and the
> `../web` SPA.

## What's in the box

- **`Client`** — the unified entry point. `new Client({ apiKey, baseUrl })`
  exposes, over one shared session: `auth` (ZK register/login), `kv` (per-user
  encrypted key/value), `db` (the app's scalable database), `storage` (encrypted
  files), `vfs` + `vcs` (the encrypted filesystem and its history), `message`
  (pub/sub + E2E direct messages), `space` (fan-out group channels with
  history), `agents` (server-side Programmable Agents), `functions`
  (developer-authored serverless functions), `accessTokens` (scoped machine
  credentials), and `offline` (CRDT sync). This is the supported surface;
  everything below is a building block it composes.

- **App-describing decorators** — `@MuhkooAgent` / `@MuhkooSpace` / `@MuhkooDB` /
  `@MuhkooFunction` annotate a plain class with your app's agent-facing surface;
  `ejectAgentPrompt()` / `ejectAgentTools()` turn that into a `systemPrompt` +
  tool allowlist for a Programmable Agent. See the [agents reference](https://docs.muhkoo.dev/reference/agents/).

- **`BroadcastChannel`** — multi-peer end-to-end-encrypted "room". Wires
  `WSTransport` (socket lifecycle, reconnect, offline queue) together with
  `EncryptedSession` (per-peer Double Ratchet, handshake fan-out, recipient
  filtering). Drops onto a chat protocol without changing the wire format.
- **`EncryptedSession`** — transport-agnostic per-peer ratchet manager. Lets you
  bring your own transport.
- **`WSTransport`** — pure WebSocket lifecycle (connect / auto-reconnect /
  buffered outbound queue / lifecycle events).
- **`KeyStore`** — singleton holding ECDH + ECDSA P-384 keypairs per identity,
  with dehydrate/hydrate helpers for persistence.
- **`DoubleRatchet`** + **`DoubleRatchetManager`** — the underlying ratchet
  primitives (browser/server builds only — see below).
- **`PersonalSpaceClient`** — HTTP client for the accelerator's
  `/api/personal/:commitment/*` ZK-gated KV API. Generates a fresh Groth16
  proof per request using snarkjs and the `preimagePoK` circuit.
- **`FileStorage` + `ShardClient`** — the chunked AES-256-GCM + Reed–Solomon
  layer under `client.storage`. A read fetches only the **data** shards and
  reaches for parity solely when one is actually missing: RS needs `dataShards`
  of `dataShards + parityShards`, so pulling all of them and discarding the
  parity cost six round trips where four would do. Concurrent shard reads then
  **coalesce** into a single `POST /api/shards/batch`, which is what stops a
  project costing one request per shard — a shard is not a file, and a project is
  thousands of small modules. Callers are unchanged (`getShard` still asks for
  one shard); `batchShards: false` forces one-at-a-time, and a deployment without
  the route is detected and permanently degraded to it. Read concurrency was
  raised to match, because batching with too few reads in flight trades
  parallelism for round trips and is worse than not batching at all. Opening the
  same 519-file project in the Muhkoo IDE went from 2,086 requests to 22: 18.4s →
  8.8s in Chromium, 37.5s → 14.9s in Brave, which filters every request and so
  paid the round-trip cost hardest.
- **`wrapWithPassphrase` / `unwrapWithPassphrase`** — PBKDF2-SHA256 (200k
  iterations) + AES-256-GCM passphrase wrap. Pairs naturally with
  `PersonalSpaceClient` for client-side payload encryption.
- **`verifyGroth16` / `initBn128Wasm`** — universal Groth16 verifier driven by
  bn128.wasm. Runs anywhere WebAssembly does (Node, browsers, edge runtimes).
  Used by the accelerator's `verifyZkAuthProof`.
- ZK building blocks re-exported from `crypto/ZeroKnowledge` (`Field`,
  `Poseidon`, `PreimagePoK`, `HashKnowledge`, `AuthPublicInput`,
  `verifyHashKnowledge`, `verifyPreimagePoK`, `quickVerify`,
  `compilePrograms`, `initializeCircuits`, `encodeToHex`, `decodeFromHex`).
- Messaging utilities (`Message`, `Packet`, `SerializeMessage`) and event
  primitives (`EventCore`, `EventCoreEvents`).

## Three build targets

`yarn build` produces three bundles from one source tree. They are selected via
the `exports` field in `package.json`:

| Target | Entry | Output |
| --- | --- | --- |
| `browser` | `src/browser/index.ts` | `dist/browser/index.js` |
| `server` | `src/server/index.ts` | `dist/server/index.js` |
| `workers` | `src/workers/index.ts` | `dist/workers/index.js` |

The `workers` build deliberately excludes anything that pulls in
`snarkjs` / `ffjavascript` transitive deps (which need `URL.createObjectURL`
and other APIs edge runtimes don't expose):

- `ZeroKnowledge.ts` — `Field`, `Poseidon`, `PreimagePoK`, `verifyPreimagePoK`,
  etc.
- `Authenticator.ts`
- `DoubleRatchetManager.ts`
- `personal/` — `PersonalSpaceClient`, `wrapWithPassphrase`,
  `unwrapWithPassphrase`

The `workers` build keeps `KeyStore`, `DoubleRatchet`, `EncryptedSession`,
`BroadcastChannel`, `WSTransport`, and the bn128.wasm-driven
`groth16-verifier` — that last one is the only viable Groth16 path on the edge.

Types in `dist/connect.d.ts` (bundled from the flat `src/browser/index.ts`
entry) include everything from all three runtimes so consumers can reference
types even when the runtime impl is absent for their target. Calling
`verifyGroth16` / `initBn128Wasm` works in the `workers` build; importing
`PersonalSpaceClient` and calling it there will fail at runtime.

### Bare specifiers and snarkjs

Browser and server builds externalize bare specifiers — the consumer's bundler
(or an import map for direct browser use) resolves them. The accelerator's
chat app provides `snarkjs` via an esm.sh import map; Node consumers add
`snarkjs` as a peer dependency.

## Installation

```bash
npm install @muhkoo/connect@alpha
# or: yarn add @muhkoo/connect@alpha / pnpm add @muhkoo/connect@alpha
```

Ask for the **`alpha`** tag explicitly. `latest` still points at the older
`0.13.2-alpha.0` line, so a bare `npm install @muhkoo/connect` installs a build
without the surface documented here. Two published builds are deprecated and
should not be pinned: `0.14.0-alpha.0` (reports the wrong version at runtime)
and `0.14.0-alpha.3` (shipped with no type declarations, so every SDK type
resolves to `any`).

ESM-only, with bundled type declarations. `snarkjs` is an **optional peer
dependency** — install it only if you use the ZK-proof features
(`PersonalSpaceClient`, shared-space writes, client-side proof generation):

```bash
npm install snarkjs
```

## Quick start

### The unified client (recommended)

`Client` is the supported entry point. One object, one app key, and every
namespace sharing a single session.

```typescript
import { Client } from "@muhkoo/connect";

const client = new Client({
  apiKey: "mk_test_pk_…",                 // app / publishable key
  baseUrl: "https://accelerator.example.dev",
  // circuits default to `${baseUrl}/circuits/build/preimagePoK{.wasm,_0001.zkey}`
});
```

> **`apiKey`** is transitionally optional (auth + storage work without it
> today) but is becoming **required** as part of productizing the Accelerator:
> it's how each app authenticates and gets metered/billed, and it authorizes
> messaging websockets. Always pass one for new integrations.

```typescript
// (continued)

// Auth — deterministic ZK identity derived from (username, password).
const user = await client.auth.zk.login("alice", "correct horse battery staple");
//    └ { username, commitment }

// KV — per-user persistent key/value (collection + id); client-side encrypted,
// the server stores only ciphertext.
await client.kv.set("todos", "t1", { title: "Buy groceries", completed: false });
const todo = await client.kv.get("todos", "t1");
const ids  = await client.kv.list("todos");
await client.kv.delete("todos", "t1");

// Message — realtime pub/sub + end-to-end-encrypted direct messages.
const sub = client.message.subscribe("todos", (e) => console.log("update:", e.data));
await client.message.publish("todos", { id: "t1", done: true });
await client.message.send("user:abc", { text: "Hello!" });

// Space — fan-out group channels with persisted history (group chat).
const space = await client.space.joinChannel("project-x"); // or createChannel(...)
space.onMessage((e) => console.log(e.from, e.message.body));
await space.sendMessage("Hi everyone");
const { messages } = await space.history({ limit: 100 });
```

`client.message` is lightweight realtime: `subscribe`/`publish` are plaintext
fan-out; `send("user:<id>", …)` is an **end-to-end-encrypted** direct message
(Double Ratchet — forward-secret, ephemeral, no history; both parties must be
online).

`client.space` is **fan-out group messaging with history**. A channel seals each
message once with a shared group key so the server can persist + replay it.
`createChannel(name)` mints + registers a channel (you become its first
key-holder); `joinChannel(name)` resolves an existing one and is admitted by the
app's **keeper** — a server-side process the platform runs per app, which holds
the channel's group key and re-issues it to newcomers — so a channel is joinable
even when no human member is online. The message **relay** stays blind (it only
ever sees opaque, ECIES-wrapped key blobs); the **keeper** does hold group keys,
so channels are *relay-blind*, not fully server-blind. (Enabling a server-side
agent on a channel likewise gives that agent the group key.) The space handle was
once `Room`; that name is still exported as an alias, and `client.message.room()`
returns the same handle.

**Shareable invite links + member roles.** A private Space (`createChannel(name,
{ private: true })`) admits only allowlisted members. Instead of inviting
people one username at a time, mint a **capability link** anyone can redeem —
the keeper admits them on redemption. Members carry a **role** (`viewer` /
`editor`) the owner controls; apps use roles to gate delegated management (e.g.
who can edit an app's config).

```typescript
// Owner: mint a shareable invite (optionally time-/use-bounded, with a role).
const { token } = await client.space.createInviteLink(space.id, { role: "viewer", maxUses: 10 });
const url = `https://yourapp.com/join?space=${space.id}&token=${token}`;
await client.space.listInviteLinks(space.id);     // owner: active links
await client.space.revokeInviteLink(space.id, token);

// Recipient: redeem the link → admitted by the keeper, group key wrapped for them.
const joined = await client.space.joinByInvite(space.id, token);

// Owner: see members + roles, and promote/demote.
await client.space.members(space.id);             // [{ memberId, role }]
await client.space.setMemberRole(space.id, "alice", "editor");
await client.space.roster(space.id);              // member identity pubkeys
```

**Programmable Agents (`client.agents`).** Server-side "virtual users" backed by
the edge AI runtime: an app editor gives an agent a persona (system prompt), a
model, and **triggers** (e.g. reply on @-mention), then enables it per-Space;
members chat with it inside that Space. Management is session-authed (owner or
Space editor) and **paid-tier-only**. Enabling an agent on a Space makes that
Space readable by the app's keeper (per-Space opt-in); every other Space stays
blind.

```typescript
const { config } = await client.agents.create(appId, {
  handle: "@assistant",
  displayName: "Assistant",
  model: "meta/llama-3.1-8b-instruct",
  systemPrompt: "You are a concise, friendly teammate in this Space.",
  triggers: [{ type: "mention" }],
});
await client.agents.enable(appId, config.agentId, space.id);  // per-Space opt-in
// list / update / delete / disable also available.
```

Give the agent **tools** (a function-calling loop over the app's database,
functions, and channels) by passing `tools` — requires a function-calling
`model`. Generate both the prompt and the tool allowlist from decorators:

```typescript
import { MuhkooAgent, MuhkooSpace, MuhkooDB, ejectAgentPrompt, ejectAgentTools } from "@muhkoo/connect";

@MuhkooAgent({ name: "Assistant", purpose: "A helpful teammate in this chat." })
class ChatApp {
  @MuhkooSpace({ description: "Main team discussion." })             general!: string;
  @MuhkooDB({ access: "read", description: "Chat message history." }) messages!: unknown;
}

await client.agents.create(appId, {
  handle: "@assistant",
  displayName: "Assistant",
  model: "openai/gpt-oss-120b",            // a function-calling model
  systemPrompt: ejectAgentPrompt(ChatApp),
  tools: ejectAgentTools(ChatApp),
});
```

**Serverless Functions (`client.functions`).** Deploy your own code that runs on
the accelerator. A function is an untrusted single-module ES worker
(`export default { fetch }`) with two triggers: **HTTP** (reachable at its own
`<name>--<slug>.fns.<zone>` subdomain) and **Space-bound** (invoked on Space
messages, like an agent). Source is encrypted at rest and uploaded just-in-time
on invocation. Management is session-authed (owner / Space editor) and
**paid-tier-only**.

```typescript
const { config } = await client.functions.deploy(appId, {
  name: "hello",
  displayName: "Hello",
  code: `export default { fetch: () => new Response("hi from Muhkoo!") }`,
  triggers: { http: { enabled: true } },
});
// → reachable at https://hello--<app-slug>.fns.<zone>/
await client.functions.enable(appId, config.functionId, space.id); // Space-bound
// list / get / code / update / delete / disable also available.
```

Auth lifecycle:

```typescript
await client.auth.zk.register({ username, password, email });  // signs in by default
await client.auth.zk.restore();            // re-validate a persisted token on boot
await client.auth.zk.unlock(password);     // re-derive identity for a restored session
await client.auth.zk.logout();
client.user;                               // { username, commitment } | null
```

Two credentials ride on every request: the app key (`X-Muhkoo-Key`) and, once
signed in, the user session token (`X-Muhkoo-Session`). The accelerator
validates the token and authorizes per-user spaces without a fresh proof per
call. Persist the token across reloads with a custom `sessionStore` (e.g. a
`localStorage`-backed one); identity material is never persisted — `unlock()`
re-derives it from the password when you need to decrypt or message.

### Staying signed in — the `device` factor

The master seed is memory-only by design, which is what makes a forgotten
password unrecoverable and a stolen disk uninteresting. It also means a page
reload leaves the client holding a valid session and nothing to decrypt with,
and it means a CLI runs a full ZK login — circuit download and proof — on every
invocation. Persisting the seed would fix both and give away the whole property.

A `device` factor is the middle path. A random key is generated locally, the
seed is wrapped under it, and **only the ciphertext goes to the vault**. The key
never leaves the machine that made it, and the server holds a blob it cannot
open. Revoking the factor makes that local key inert immediately — which a
stored seed can never be, because nothing can reach out and un-store it.

```typescript
// Pair once, while signed in. Store `deviceKey` with the tightest permissions
// available: for as long as the factor exists it is equivalent to the seed.
const { factorId, deviceKey } = await client.auth.zk.enrollDevice("Matt's laptop");

// Later, with no password typed: recovers the seed AND a session.
const user = await client.auth.zk.loginWithDevice(username, factorId, deviceKey);
//    └ { username, commitment }

// Seed only — for a host that already holds a session token on disk.
await client.auth.zk.unlockWithDevice(username, factorId, deviceKey);

await client.auth.zk.listDevices();           // [{ id, label, createdAt }], newest first
await client.auth.zk.revokeDevice(factorId);  // access withdrawn immediately
```

The two recovery methods are not interchangeable. `unlockWithDevice` establishes
the **encryption identity only**, which suits a CLI that already has a session
token on disk. A browser generally does not: its session expires while the
pairing is still perfectly valid, leaving it able to decrypt everything and
unable to make an authenticated call. `loginWithDevice` derives the ZK identity
from the recovered seed and proves it, exactly as `recoverWithPhrase` does — the
seed has always been sufficient to authenticate, and withholding that only meant
re-typing a password to prove something already known.

A revoked pairing throws **`DeviceRevokedError`**, exported from the package
root. It is typed because the correct response is specific and the wrong one is
harmful: discard the stored key and fall back to a password. Retrying cannot
succeed — the factor is gone from the vault — and silently re-pairing would undo
a revocation someone performed on purpose. A *wrong* key is distinguishable: it
fails to decrypt rather than failing to resolve.

```typescript
import { DeviceRevokedError } from "@muhkoo/connect";

try {
  await client.auth.zk.loginWithDevice(username, factorId, deviceKey);
} catch (err) {
  if (err instanceof DeviceRevokedError) {
    forgetStoredKey();     // never re-pair on the user's behalf
    showPasswordForm();
  } else throw err;
}
```

### Hosted sign-in (`client.auth.hosted`)

`client.auth.hosted` sends the browser to Muhkoo's own sign-in page (PKCE
authorization code in, session + seed out), so an app never handles a password
and gets passkeys, Google and recovery for free. `redirectUri` must be
registered for the app in the portal.

```typescript
await client.auth.hosted.login({ appId, redirectUri: "https://yourapp.com/callback" });
// …on the callback route:
if (client.auth.hosted.isCallback()) {
  const user = await client.auth.hosted.handleCallback();
}
```

A viewer who ticked *"Keep me signed in on this browser"* has a `device` factor
on the auth origin, so the hosted page can complete the flow without asking for
anything. That is the behaviour an app must be able to switch off at exactly one
moment — its own sign-out. Without `prompt`, clicking "sign in" straight after
signing out would resume the remembered pairing and look like the sign-out did
nothing:

```typescript
await client.auth.hosted.login({ appId, redirectUri, prompt: "login" });
// forces the credential screen even on a remembered browser
```

The name is borrowed from the OIDC parameter that solves the same problem. Note
that the remembered pairing lives on the auth origin only: `localStorage` is
per-origin, so sharing a registrable domain buys an app nothing here, and the
key that opens the seed is never handed to a developer app.

> The sections below document the lower-level building blocks the client is
> composed from (`BroadcastChannel`, `EncryptedSession`, `PersonalSpaceClient`,
> the Groth16 verifier, …). Reach for them directly only when you need control
> the client doesn't expose.

### Multi-peer encrypted room (chat-style)

```typescript
import { BroadcastChannel, BroadcastChannelEvents } from "@muhkoo/connect";

const channel = new BroadcastChannel({
  url: "wss://accelerator.example.dev/room/abc",
  myId: "alice@example.dev",
});

channel.on(BroadcastChannelEvents.MESSAGE, (e) => {
  const { from, text } = e.detail;
  console.log(`${from}: ${text}`);
});

channel.on(BroadcastChannelEvents.PEER_HANDSHAKE, (e) => {
  console.log("new peer ready:", e.detail.peerId);
});

await channel.connect();   // generates keys + opens WS
await channel.announce();  // broadcast our keyExchange (re-fires on reconnect)
await channel.send("hello room"); // fan-out one cipherMessage per peer
```

The wire protocol is JSON frames: `{ keyExchange: ... }`, `{ cipherMessage: ... }`,
plus arbitrary frames you ship with `channel.sendRaw(obj)` and receive via the
`RAW_FRAME` event.

### Bring-your-own-transport encrypted session

```typescript
import { EncryptedSession } from "@muhkoo/connect";

const session = new EncryptedSession({ myId: "alice" });
await session.initialize();

// outbound handshake
const kx = await session.getOwnKeyExchange();
yourTransport.send(JSON.stringify(kx));

// inbound frame
const result = await session.receive(JSON.parse(rawFrame));
if (result.kind === "plaintext") {
  console.log("from", result.from, ":", result.text);
} else if (result.kind === "handshake" && result.outbound) {
  yourTransport.send(JSON.stringify(result.outbound)); // reciprocate
}

// outbound message
const frames = await session.encrypt("hi");
for (const f of frames) yourTransport.send(JSON.stringify(f));
```

`EncryptedSession` assigns roles deterministically with
`isClient = (myId < peerId)` lexicographically and dedups handshake
reciprocation with an internal `sentHandshakeTo` set.

### ZK-gated personal storage

```typescript
import {
  PersonalSpaceClient,
  wrapWithPassphrase,
  unwrapWithPassphrase,
} from "@muhkoo/connect";

const client = new PersonalSpaceClient({
  baseUrl: "https://accelerator.example.dev",
  commitment, secret, salt, ecdsaPub, ecdsaPubHash, // decimal BigInt strings
  circuits: {
    wasmUrl: "/circuits/build/preimagePoK_js/preimagePoK.wasm",
    zkeyUrl: "/circuits/build/preimagePoK_0001.zkey",
  },
});

// Each call: POST /challenge -> reduce nonce -> snarkjs.groth16.fullProve -> POST gated endpoint
const wrapped = await wrapWithPassphrase("hunter2", new TextEncoder().encode("secret"));
await client.put("notes", wrapped);

const got = await client.get<typeof wrapped>("notes");
const plaintext = await unwrapWithPassphrase("hunter2", got!);
```

Identity derivation (deriving `commitment / secret / salt / ecdsaPub / ecdsaPubHash`
from a username + password) lives on the consumer side. The accelerator's chat
app uses PBKDF2(password, "muhkoo-zk-v1:" + username) -> 32-byte seed ->
HKDF-Expand for each material -> P-256 via `@noble/curves` -> Poseidon
commitment.

### Universal Groth16 verification (Workers / Node / browser)

```typescript
import {
  initBn128Wasm,
  verifyGroth16,
  PREIMAGE_POK_VERIFICATION_KEY,
} from "@muhkoo/connect";

const { instance, memory, initialPFree } = await initBn128Wasm();
const ok = await verifyGroth16(
  instance, memory, initialPFree,
  PREIMAGE_POK_VERIFICATION_KEY,
  proof, publicSignals,
);
```

Initialize once at boot. On an edge runtime, pass a pre-compiled
`WebAssembly.Module` to skip runtime compilation:
`await initBn128Wasm(myWasmModule)`.

## KeyStore

Singleton store for ECDH + ECDSA P-384 keypairs keyed by identity ID.

```typescript
import { KeyStore } from "@muhkoo/connect";

const ks = KeyStore.getInstance();
await ks.generateOwnKeyPair("alice");           // ECDH + ECDSA pair
const dehydrated = await ks.dehydrateKeyPair("alice"); // JWK -> string fields
await ks.hydrateKeyPair("bob", dehydrated);

await ks.storeRemotePublicKeys("carol", carolEcdhPub, carolEcdsaPub);
const packed = await ks.packDehydratedKeys("alice");    // base64 blob
await ks.hydrateFromPacked("alice", packed);
```

Dehydrated form is JWK-based; the personal-space wrap/unwrap helpers above are
how you'd persist the packed blob (passphrase-wrapped) into the accelerator's
ZK-gated KV layer.

## Repo layout

```
src/
  browser/        rollup entrypoint for the browser build
  server/         rollup entrypoint for the server / default build
  workers/        rollup entrypoint for the workers build (+ groth16-verifier + bundled bn128.wasm)
  core/           the unified Client: Client, HttpClient, Session, namespaces/
  auth/           ZK identity derivation, AuthClient, device/passkey stores
  spaces/         Space, SpaceCipher, SpaceKeyring (fan-out group encryption)
  crypto/         KeyStore, DoubleRatchet, DoubleRatchetManager, Authenticator, ZeroKnowledge
  sessions/       EncryptedSession, BroadcastChannel
  transport/      WSTransport
  personal/       PersonalSpaceClient + wrap.ts (excluded from workers build)
  storage/        FileStorage, ShardClient, SharedSpaceClient, Reed-Solomon codec
  vfs/  vcs/      the encrypted filesystem and its history (client.vfs / client.vcs)
  offline/  p2p/  CRDT offline sync; WebRTC peer shard exchange
  events/         EventCore + EventCoreEvents
  messaging/      Message, Packet, decorators
  types/          shared type defs (incl. zk.ts with PREIMAGE_POK_VERIFICATION_KEY)
  network/        legacy Network class (not exported from any build)
  utilities/      Logger, base58, ID generation, decorators
```

## Scripts

```bash
yarn build              # rm -rf dist && yarn rollup:browser && yarn rollup:server && yarn rollup:workers
yarn dev                # all three targets in watch mode (concurrently)
yarn rollup:browser     # one-off browser build
yarn rollup:server      # one-off server build
yarn rollup:workers     # one-off workers build
yarn build:dts          # complete .d.ts bundle -> dist/connect.d.ts
yarn build:docs         # typedoc -> docs/

yarn test               # vitest
yarn test:unit          # vitest --run (no integration tests)
yarn test:integration   # TEST_TYPE=integration vitest --run tests/integration
yarn lint               # eslint ./src
```

## Compatibility

- Node >= 20
- All three builds rely on globalThis-level WebCrypto (`crypto.subtle`,
  `crypto.getRandomValues`), available natively in modern browsers, Node 16+,
  Bun, Deno, and edge runtimes.
- The bn128.wasm verifier needs runtime `WebAssembly.compile()` available
  (true for all of the above; on an edge runtime, hand in a module compiled at
  build time if you want to skip the startup cost).

## License

MIT — see `LICENSE`.
