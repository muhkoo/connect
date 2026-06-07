# @muhkoo/connect

Client SDK for the Muhkoo Accelerator. The headline surface is a single
**`Client`** that hangs everything off its namespaces —
`client.auth` / `client.kv` / `client.storage` / `client.message` /
`client.space` / `client.agents` / `client.functions` — backed by
end-to-end-encrypted messaging (fan-out group channels with history, plus Double
Ratchet + ECDH P-384 for direct messages), ZK identity + personal/shared spaces,
server-side Programmable Agents, developer-authored serverless functions, and a
Cloudflare-Workers-compatible Groth16 verifier — all bundled from a single
TypeScript source tree.

See [`CHANGELOG.md`](./CHANGELOG.md) for what's new.

> Status: alpha. The library is consumed in tree by `../accelerator` and the
> `../web` SPA.

## What's in the box

- **`Client`** — the unified entry point. `new Client({ apiKey, baseUrl })`
  exposes `auth` (ZK register/login), `storage` (per-user encrypted KV +
  files), and `message` (pub/sub + E2E direct messages) over one shared
  session. This is the supported surface; everything below is a building block
  it composes.

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
- **`wrapWithPassphrase` / `unwrapWithPassphrase`** — PBKDF2-SHA256 (200k
  iterations) + AES-256-GCM passphrase wrap. Pairs naturally with
  `PersonalSpaceClient` for client-side payload encryption.
- **`verifyGroth16` / `initBn128Wasm`** — universal Groth16 verifier driven by
  bn128.wasm. Runs anywhere WebAssembly does (Node, browsers, CF Workers).
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
and other APIs workerd doesn't expose):

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
`verifyGroth16` / `initBn128Wasm` works under workerd; importing
`PersonalSpaceClient` and calling it in a worker will fail at runtime.

### Bare specifiers and snarkjs

Browser and server builds externalize bare specifiers — the consumer's bundler
(or an import map for direct browser use) resolves them. The accelerator's
chat app provides `snarkjs` via an esm.sh import map; Node consumers add
`snarkjs` as a peer dependency.

## Installation

```bash
npm install @muhkoo/connect
# or: yarn add @muhkoo/connect / pnpm add @muhkoo/connect
```

ESM-only, with bundled type declarations. `snarkjs` is an **optional peer
dependency** — install it only if you use the ZK-proof features
(`PersonalSpaceClient`, shared-space writes, client-side proof generation):

```bash
npm install snarkjs
```

## Quick start

### The unified client (recommended)

`Client` is the supported entry point. One object, one app key, three
namespaces — `auth`, `storage`, `message` — all sharing a single session.

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

// Storage — per-user persistent KV (collection + id), encrypted at rest.
await client.storage.set("todos", "t1", { title: "Buy groceries", completed: false });
const todo = await client.storage.get("todos", "t1");
const ids  = await client.storage.list("todos");
await client.storage.delete("todos", "t1");

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
app's **keeper** — a trusted, always-available member that re-issues the group
key — so a channel is joinable even when no one else is online. The relay stays
blind (it only ever sees opaque, ECIES-wrapped key blobs). The space handle was
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
Cloudflare Workers AI: an app editor gives an agent a persona (system prompt), a
model, and **triggers** (e.g. reply on @-mention), then enables it per-Space;
members chat with it inside that Space. Management is session-authed (owner or
Space editor) and **paid-tier-only**. Enabling an agent on a Space makes that
Space readable by the app's keeper (per-Space opt-in); every other Space stays
blind.

```typescript
const { config } = await client.agents.create(appId, {
  handle: "@assistant",
  displayName: "Assistant",
  model: "@cf/meta/llama-3.1-8b-instruct",
  systemPrompt: "You are a concise, friendly teammate in this Space.",
  triggers: [{ type: "mention" }],
});
await client.agents.enable(appId, config.agentId, space.id);  // per-Space opt-in
// list / update / delete / disable also available.
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

Initialize once at boot. For CF Workers, pass a pre-compiled
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
  crypto/         KeyStore, DoubleRatchet, DoubleRatchetManager, Authenticator, ZeroKnowledge
  sessions/       EncryptedSession, BroadcastChannel
  transport/      WSTransport
  personal/       PersonalSpaceClient + wrap.ts (excluded from workers build)
  events/         EventCore + EventCoreEvents
  messaging/      Message, Packet, decorators
  types/          shared type defs (incl. zk.ts with PREIMAGE_POK_VERIFICATION_KEY)
  network/        legacy Network class (not exported from any build)
  storage/        Reed-Solomon Storage (not exported from any build)
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
  Bun, Deno, and CF Workers.
- The bn128.wasm verifier needs runtime `WebAssembly.compile()` available
  (true for all of the above; on CF Workers, pre-compile via wrangler's
  `.wasm` import if you want to skip startup cost).

## Related

- [`muhkoo/accelerator`](https://github.com/muhkoo/accelerator) — the CF
  Workers + DOs backend this SDK targets, including the personal-space DO,
  message-bus DO, and the bn128.wasm-driven `verifyZkAuthProof`.

## License

GPL-3.0 — see `LICENSE`.
