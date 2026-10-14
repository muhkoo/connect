# E2E channels (final): server-blind group keys with active-attack protection (consolidated design)

## Executive summary (for the product owner)

This is the final version of the plan to make every channel on Muhkoo end-to-end encrypted. It keeps
the design Matt chose (our own protocol, not MLS) and folds in the fixes for the problems the second,
third and fourth reviews found; §12 lists the rest for planning. Nothing is built, deployed or committed.

### A. What becomes true, and what stays readable

What becomes true once the rollout finishes:
- Muhkoo's servers no longer keep a usable copy of any channel's key. Members' apps hand the key to
  each other, sealed so that only the recipient can open it.
- An invite link carries the secret part of the key after the "#" in the address, which browsers
  never send to a server. The server still checks that the link is valid, unexpired and not used up,
  but it cannot use the link by itself.
- Every channel, public ones included, can have a standing link.
- Someone joining without a link waits, and the first member who comes online lets them in automatically.
- In a private space only the owner, or an editor the owner appointed, can add people. Members' apps
  check the signature on each addition, so the server cannot slip anyone in.
- Each app checks the identity key of everyone it hands a key to. It remembers the key it first saw
  for each person; if that key changes, it stops and asks the user to compare safety numbers.
- When someone is removed from a private space, the server cuts them off, every invite link made
  before the removal stops working (the owner or an editor makes a new one), and members' apps stop
  sending until a new key is in place.
- Agents and functions are members like anyone else, with their own copy of the key. An agent
  decrypts only the messages addressed to it, and its memory of the conversation is stored encrypted.

What stays readable, and by whom:
- The platform can read: the per-app server log space; any space while an agent or function is a
  member of it (the platform holds that member's key); and the metadata of every message (sender,
  time, size, and which messages went to an agent), plus each space's membership list.
- The AI model and the developer's code receive the text of every message an agent or function decrypts.
  An agent decrypts only messages addressed to it; a function that watches every message decrypts all
  of them. That code, and the tools an agent is given, can store the text. Files are never passed on.
- Anyone using an app can see, in its public channels, which messages were addressed to an agent.
- Messages sent before the upgrade stay readable by the platform until that space changes its key
  after the old server copy is retired (step R). A space still on its old key says so.
- In a space where some members still run an old app version, those old apps can be tricked into
  handing over the key. The protection is complete only once everyone in the space has upgraded.

### B. Trust model

- **Adding people.** Private spaces: the owner adds anyone; an editor adds viewers. Public channels:
  anyone in the app may join, and every join is visible to members.
- **Adding agents and functions.** The app's owner, or an editor the owner has confirmed by name in
  the app's editor list, can add one to any space in the app, private ones included. Members are not
  asked. Members' apps check that owner's or editor's signature before they give the agent the key.
- **Identity.** Each person has one identity key, derived from their account secret. The first time
  an app needs someone's key it asks Muhkoo's directory; after that it remembers it. Safety numbers
  let two people confirm they see the same keys.
- **A malicious server can:** see all metadata; delay or drop messages, admissions and key changes
  (so it can stop a space from sending); lie at first contact about who someone is or who owns an
  app; show members of a quiet space different member lists, and keep an app that has not yet seen a
  removal unaware of it; read any space with an agent in it; serve modified code for the apps it
  hosts; trick old app versions into handing it keys; and deliver messages a removed member writes
  under the old key, which members can still read.
- **It cannot, in a space where everyone has upgraded:** read messages; add a member, agent or
  function by itself; swap in its own key for a member; plant a fake group key; make an app that has
  seen a removal keep sending under a key the removed member holds, even by rolling back the member
  list it shows; or use an invite link without the part after the "#".
- **A stolen session** (the login token, without the account secret) cannot sign anything. So it
  cannot add members, publish the editor list, replace a verified member's key, tie a
  different identity key to the account in any space, or open any key, and after step E it cannot
  add agents or functions. Two gaps remain until the old
  server copy is switched off (step K), as today: for an account that has never opened a space in the
  new version, it can get the old server helper to hand it that space's key; and with an app owner's
  or editor's login it can add an agent or function without a signature until step E, which updated
  apps never give the key but the old server helper does in a space still on its pre-upgrade key. With
  a developer's login it can also change what an existing agent or function does with the messages it
  decrypts, because the signature covers the member's keys, not its code.
- **A locked session** (signed in, account secret not unlocked) never takes part and never uses a
  throwaway key; it shows "locked" with a sign-in button.
- **Removal is enforced twice:** the server cuts the removed person off, and even if it lies, apps
  that have seen the removal refuse to send under a key the removed person holds.

### C. What users see

- **Joining by link:** open the link, sign in if needed (the link survives the round trip), and you are
  in at once. If the link lost its "#" part: "This link is missing its key part", and nothing is granted.
- **Joining without a link:** "Waiting for a member to let you in…". If nobody who could let them in
  has ever been there: "You'll be let in when a member opens this channel". If a private space's owner
  has not upgraded yet: "Waiting for the space owner to open this space in an updated app". Waiting
  costs almost nothing: the app listens for a signal and checks at most every five minutes.
- **Removal (private spaces):** the owner or an editor removes someone, and that person's connection
  closes. Invite links made before the removal stop working. Until a member's app has replaced the
  key, others see "A member was removed. Sending is paused until a member's app replaces this space's
  key." Reading continues. If the server shows an app a member list older than one it has already
  seen, that app also pauses sending and says the list couldn't be verified.
- **Talking to an agent:** writing @assistant marks the message for the agent. Only those messages are
  decrypted for it, and the app can show "shared with @assistant".
- **Locked session:** "Sign in again to read this channel", with a button that goes through the
  normal sign-in page and comes back. A password box appears only for accounts that have a password.
- **Developers:** adding an agent asks the developer's app to sign. The portal shows "Review app
  editors" when its editor list changes, and publishes the list only when the owner clicks.

### D. Release order and gates

Every step goes to staging first. Production, and publishing the SDK or CLI to npm, happen only when
Matt asks, every time. Every gate is checked by probing the live service, never by reading git.
1. **Release train.** The new SDK ships on its own, without the DM protocol's wire change or the vault
   change, so moving the npm tag back is a real rollback.
2. **I, foundation.** Identity lookup (with its own rate limit), the signed membership log, the
   removal cut-off, identity-key checks, and the quota exemption for identity data. Inert until an
   upgraded app writes a log. Gate: tests green; endpoints answer on staging and in production.
3. **A0a, additive server pieces.** No behaviour change. Gate: the old-app test matrix passes on
   staging; live in production for 24 hours, because it is A0b's rollback target.
4. **A0b, server behaviour changes** while the old server copy of keys is still on. Gate: migration
   report reviewed; the old-app "locked reload" tests pass on staging before production; for 24 hours
   no old-app member whose key changed is left without a key.
5. **S, SDK 0.15.** Gate: I and A0b are live in production, probed, before the npm release.
6. **P, apps one at a time.** Web first; then the other apps and the CLI; the portal last, after web
   has run a day. A staging drill first records what an app rollback does; after an app's first
   upgraded deploy, its rollback target is its previous upgraded build. Owners then re-sign existing
   agents and confirm their editors.
7. **E, signatures required** for new agent enrolments. Gates K1–K8 are measured here for 7 days:
   nobody still depends on the server copy, agents use their own keys, old-app @mentions and unsigned
   agents are accounted for, the sole-copy report is reviewed, and identity data is never refused.
8. **K, server copy off;** agents answer only addressed messages. Its one remaining use: in a space
   where the server's copy is the only one, a returning member who proves their identity is let back
   in from it. 48-hour soak. Last step that can be rolled back to old behaviour.
9. **R, old server copies deleted,** app by app. Spaces where that copy is the only one are kept until
   Matt accepts them one space at a time. One-way door.
10. **D, docs and privacy copy,** once K is live and the private-space cut-off is confirmed live.

### E. Residual risks

- **First contact is trusted:** the first time an app learns someone's identity or an app's owner,
  or opens a space's history without a link, it believes the server. Safety numbers and links catch
  this; a developer identity built into the app removes it for the app owner.
- **Hosted apps:** Muhkoo serves the code that performs these checks.
- **Old app versions** hand keys to whatever the server asks, until everyone in a space upgrades.
- **Quiet spaces:** the server can show members different histories until their views cross. An app
  that has not yet seen a removal can keep sending under the old key.
- **A former editor working with the server** can backdate an agent enrolment.
- **Agents and functions are platform-held keys:** while one is a member, the platform can read that
  space's current messages, and earlier ones under the same key where history is kept.
- **Migration:** each private space's existing members are trusted as the server presents them when
  the owner upgrades, for that space only; it never grants app-wide authority.
- **Live invite links:** anyone holding one receives new keys until it is revoked, or, in a private
  space, until someone is removed or leaves.
- **Stale tabs:** an old-version tab left open on a private space its user was removed from
  reconnects every 3 seconds, about 1,200 metered requests an hour, until reloaded.
- **Stalled removal:** a malicious server can keep a space from sending after a removal; it cannot
  make it leak.
- **Old keys:** spaces keep their pre-upgrade key until the retirement signal at R; a platform that
  never sends it leaves them there, and the space shows it.
- **Absent owners:** if a private space's owner disappears and there is no editor, nobody can be
  added. Ownership transfer is deferred.
- **Sole copies:** spaces whose only copy of the key is on the server (or in members' own old caches)
  are kept until Matt accepts them one by one. Until then, a returning member of such a space who
  proves their identity is let back in from that copy, and the space stops depending on it.

---

Status: **design for review (final).** No repo file has been edited, deployed or committed.

Final version: `design-v4.md` with the three blocking findings of the final critic pass
(`critiques-v4.md`) applied as the critics specified, and every remaining finding of that pass listed
in §12 (known issues to resolve during planning). Matt accepted the defaults of Q19 and Q20 on
2026-09-27 (§11.4). v4's sources, all read in full: Appendix A (decisions 1–11; 8–11 are Matt's
round-2 decisions and override anything that conflicts), `design-v3.md` (the base of v4),
`critiques-v3.md` (17 round-3 findings, 7 blocking), and the two round-4 change-sets `r4-security.md`
(closing SEC8–SEC12) and `r4-availcompat.md` (R4-1–R4-11, closing AV8–AV14 and CP7–CP11). v4 applies
both change-sets to v3 and keeps v3's section structure; superseded text is replaced, not annotated.
§11.6 records round 3's merge and §11.7 round 4's; the body describes only the kept text. Where a fix
conflicted with a Matt decision or the context, the decision won and §11.3 and §11.8 say so. Matt
keeps this custom design (not MLS).

Baselines re-read 2026-09-26: accelerator `66be602` (working tree), connect `8053400`
(`0.14.0-alpha.9`), portal, web, cli, theater-transcoder working trees. Paths are relative to
`/Users/matt/GitHub/muhkoo/`; `acc/` = `accelerator/src/`, `con/` = `connect/src/`, **SpecA** =
`connect/docs/superpowers/specs/2026-09-24-dm-protocol-design.md`. Every "today" claim cites a line
re-read for this consolidation.

Hard constraints honoured throughout: no Durable Object class is renamed (new behaviour lives in
facets); no persisted key format or wire shape changes without a reader shipped first; staging first,
production (including `npm run release` and `npm publish`) only when Matt asks, every time.

---

## 0. Canonical names (read this first)

The three v2 files used different names for the same thing. These are the names used everywhere below.

| Concept | Canonical name | Replaces |
|---|---|---|
| User identity key: P-256 ECDSA public key derived from the seed | **IK** (`b64 rawP256`, 65 bytes) | — |
| Chat keys: the P-384 ECDH/ECDSA pair Spaces wrap to and sign with | **chat keys** | "space signing key" (v2-keys) |
| Certificate by the IK over the chat keys | **`keyCert`** (type `ChatKeyCert`) | `cert` (v2-identity) |
| Per-Space hash-chained membership log | **membership log**, entries `MembershipEntry`, relay facet `MembershipLogFacet` | "IdentityFacet", "link-join" statements (v2-keys) |
| Signed statement that a committed epoch's key is `K` | **`EpochCommit`**, stored `meta:epochCommit:<e>`, tag field **`keyCommit`** (32 bytes) | `keyId` (16 bytes) and `meta:epochcommit:<e>` (v2-identity) |
| Signed agent/function enrolment | **`svc` log entry** (with `mode`) | `SvcEnrolment` / `SvcRemoval`, `svcenrol:` / `svcremoved:` (v2-agents) |
| App-editor delegation | **`AppRoster`**, referenced from `svc` by `rosterSeq` | `authority` / `verifyAppAuthority` (v2-agents) |
| Proof of the link fragment | **`lsig`**: a signature by the link-sign key `ls` derived from `d` | `linkAuth` / `authHash`, `signKeyBox`, `grantSig` (v2-keys) |
| Link grant | **`link` log entry** (carries `keyCommits`) | `grant` JSON (v2-keys) |
| Addressing header | **`packet.headers.to`** | — |
| Release steps | **I, A0a, A0b, S, P, E, K, R, D** (§8) | v1 steps 0–5; "steps 0–2", "step 3", "step 4" in v2-keys |
| Membership head sent with a rotation | **`membershipHead: {seq, hash}`**; inside `EpochCommit` as `headSeq`, `headHash` | — |
| Highest epoch this client may seal under | **`E*`** (§4.2.8): the highest epoch accepted **with a commitment** (an `EpochCommit`, or a genesis `legacyCommits` entry) | "sending epoch = highest accepted epoch" (v2) |
| Commitments to legacy keys in a migration genesis | **`legacyCommits`** (§3.5) | — |
| Relay-local binding of a member to an IK | **`ikbind:<m>`** (§3.6, §3.10) | — |
| A stored `keyCert` whose `ik` equals `ikbind:<m>` | **`hasCert(m)`**, "certified" (§4.1.3) | "has a `keyCert`" |
| Fingerprint of the key a stored blob was wrapped to | **`tfp`** (§6.5 row 8); a blob with a matching `tfp` and `hasCert` is **`holdsVerified`** (§4.1.3) | — |
| Critic findings | Round 2: **SEC1–SEC7** (security), **AV1–AV7** (availability), **CP1–CP6** (compat), in `critiques-v2.md` order. Round 3 continues the numbering: **SEC8–SEC12**, **AV8–AV14**, **CP7–CP11**, in `critiques-v3.md` order. Round-1 findings keep **S/A/C** numbers. | — |
| The account's registered IK, carried by the verified session context | **session IK** (`ResolvedUserContext.ik`, §3.6) | — |
| Per-Space local high-water record | **`hw = {seq, hash, humanRemovalSeq}`** (§3.7) | high-water `{seq, hash}` (v3) |

Mapping of v2-keys' hooks to the modules that implement them:

| Hook (v2-keys §9) | Implemented by |
|---|---|
| H1 `IdentityGate.bindingsFor(entries)` | `con/spaces/trust/IdentityGate.ts` (new): verifies `keyCert` under the IK the log binds to the member, pinned in `identity-v1` (§3.4). Batched. |
| H2 `IdentityGate.signerFor(memberId)` | Not needed as a separate hook: commits and link entries are signed by the IK, which the log binds (§3.5). |
| H3 `MembershipLog.head / isMember / membersAt / canAdmit` | `con/spaces/trust/MembershipLog.ts` |
| H4 `MembershipLog.acceptLinkJoin` | Replaced by the `redeem` / `join{via}` log entry (§4.4) |
| H5 `ServiceEnrolment.verify` | `MembershipLog.activeService(memberId)` (§5.3) |
| H6 server `member:<m>.keyCert` | as named |
| H7 server `IdentityFacet.currentHead()` | `MembershipLogFacet.head()` |
| H8 `ensureStableIdentity()` | `SpaceNamespace.ensureIdentity` rewrite (§3.3) |

---

## 1. Goal, non-goals, and what stays readable

### 1.1 What becomes true

"All-0.15 Space" means a Space whose every key-holding client runs connect ≥ 0.15. Published SDKs
wrap to whatever a `joinRequest` frame names (`con/spaces/Space.ts:754-762`), so no server change can
extend the active-attack guarantees to Spaces where they still hold keys (§2.1 and §9.3, residual X3).

| # | After the rollout | Today (cited) | § |
|---|---|---|---|
| G1 | The server stores no usable group key for any member Space. Exceptions are listed in §1.2. | `keeper:gk:<spaceId>:<e>` holds the plaintext key (`acc/durable-objects/app/keeper.ts:54-56`), seeded by `createChannel` (`con/core/namespaces/SpaceNamespace.ts:186-193`). | §4, §8 |
| G2 | Keys move only as ECIES wraps made by key holders. A 0.15 client wraps only to chat keys certified by the recipient's pinned IK (T1). | The keeper wraps for every joiner (`acc/durable-objects/space/keyring.ts:73`, `:169`, `:398-419`). Published SDKs wrap to the key inside any `joinRequest` frame (`Space.ts:760`). | §3, §4.5 |
| G3 | Private Spaces: a 0.15 member admits only joiners whose membership the owner or an editor signed (T2). The server cannot replay a stale entry or drop a removal from a client that has seen a later head (T3). After a removal, no 0.15 member that has applied it seals under a key the removed member held, including across a log rollback; every link minted before the removal dies; and an honest server gives the removed member no socket, history, posting or link redemption (T8). | The allowlist is the whole gate, and any allowlisted member can add any username (`keyring.ts:80-90`). Sockets, `/history` and posting check no membership (`acc/durable-objects/SharedSpaceDO.ts:166-168`, `:196-218`; `acc/durable-objects/space/wsProtocol.ts:499`). | §3.5–3.7, §4.2.8 |
| G4 | The server cannot inject a group key: committed epochs carry a signed `keyCommit` (T5); legacy epochs are committed by the migration genesis (`legacyCommits`), and a legacy key without a commitment is read-only; the local key cache is sealed under the seed. | `pullKeys` adopts anything that unwraps (`con/spaces/SpaceKeyring.ts:257-278`); the cache is `encrypt:false` (`con/core/Client.ts:392-395`). | §3.5, §4.2, §4.3 |
| G5 | An invite link carries the key in `#lk=`. A keyed redeem must carry a signature by a key derived from the fragment (`lsig`) before the server writes anything. Redeem is idempotent. | The token alone admits (`keyring.ts:145-171`); a repeat redeem consumes a use (`:156`). | §4.4 |
| G6 | Every channel can have a standing link, public channels included. | Only the creator can mint (`keyring.ts:319-321`), and public channels record no creator (`acc/durable-objects/space/history.ts:34-40`). | §4.4 |
| G7 | A joiner without a link waits, and the first key holder who comes online admits them, including key holders on published SDKs (server replay). When nobody who could let them in exists, the joiner sees `orphaned`. | Stored `joinreq:` rows are picked up only by `Space.create()` (`Space.ts:585`). | §4.5 |
| G8 | Agents and functions are ordinary members with their own wrapped copy. The app owner or an editor signs each enrolment, and members verify it (T4). Agents decrypt only messages addressed to them; functions in mode `all` decrypt every message. Transcripts are sealed. | The runtime decrypts every pushed message with the keeper key (`acc/durable-objects/app/agentRuntime.ts:47-53`); transcripts are plaintext (`:104`, `:194`); enrolment is an unsigned server vouch (`acc/durable-objects/space/agentControl.ts:47-78`). | §5 |
| G9 | No rotation can strand a Space: an epoch counts only once a second **certified** human holds it (or no other certified human exists), a rotation that cannot commit is not started, and a stalled rotation can be superseded. | Any wrap at a fresh epoch establishes it (`keyring.ts:232`); `/rotate` has no authority check (`:289-311`). | §4.2 |
| G10 | A locked session never takes part. It shows `locked`, never an ephemeral member (T7). | A locked session mints and publishes an ephemeral pair (`SpaceNamespace.ts:341-342`). | §3.3 |
| G11 | Messages sent after a Space's first **committed** rotation past `escrowedThroughEpoch` (and past the genesis `baseEpoch`) use keys the server never saw. 0.15 clients run that rotation when the platform signals escrow retirement (R), or earlier when another rotation is owed. Until then the Space reports `detail:"legacy-key"`. (v1 G7, reworded per critic S7 and SEC3.) | n/a | §4.2.8 |

### 1.2 What stays readable by the platform (the copy must say so)

| What | Why | Decision |
|---|---|---|
| `__logs__` Spaces | Server-produced text, server-keyed (`keeper:gk:<logSpaceId>:<e>`; minted `acc/durable-objects/app/logs.ts:74-76`) | 6 |
| Any Space while an agent or function is enrolled | The platform holds `agent:identity:<id>` / `fn:identity:<id>` as plaintext JWKs (`acc/durable-objects/app/keys.ts:30`, `:40`) and the member's wrapped copies. **Capability, not policy.** | 5, 8 |
| What Muhkoo's software decrypts | An agent: only packets addressed to it (`headers.to`), and until step K also legacy packets from published SDKs. A function in mode `all`: every packet. Text goes to the AI model or the developer's function code, which may store it. Files are never passed on. | 9, 11 |
| Routing metadata | Sender, time, size, epoch and `headers.to`, persisted with the message. The platform reads all of it. In log-enabled private Spaces, members also see it (§3.6 gate). In public channels, anyone who can load the app sees it, because `/history` needs only the publishable key. | 9 |
| Membership metadata | Log entries (who joined, who added or removed whom, links, service enrolments) are readable by members; in public channels by any signed-in app user | 10 |
| Legacy-keyed Spaces | History under legacy epochs, and new messages while a Space still sends under a legacy key (`detail:"legacy-key"`), until that Space's first committed rotation past `baseEpoch`. 0.15 clients run that rotation when the platform signals escrow retirement (R) or another rotation is owed. A platform that never signals leaves the Space on its legacy key, and the app can show this. AppDOv1 and SharedSpaceDO are SQLite-backed, so deleted keeper rows are recoverable by point-in-time restore for 30 days. | 1, 7 |
| Sole-copy keeper rows | Kept by step R until Matt accepts that Space by id (§8.3). Until then the keeper reads them only to re-admit an existing member whose certificate is signed by their registered IK, while the Space has no verified holder (§4.5.2 rescue row); that member's copy then makes the Space no longer sole-copy. A Space is sole-copy when no member holds a relay copy the relay saw wrapped to their current certified key; members may still hold copies in their own v1 cache, which the relay cannot see. | 1 |

### 1.3 Non-goals

- Removing a human from a **public** channel (anyone may rejoin). Removal from private Spaces is now
  in scope (`remove` / `leave` entries, §3.5), superseding v1 §1.3 and v2-keys §3.7.
- Ownership transfer for private Spaces (none exists today). An absent owner freezes membership unless
  an editor exists (§3.5); transfer is a follow-up (§11.5).
- "Knock" requests to private Spaces (Q9).
- Multi-space invite bundles (discord-clone servers); the DM protocol itself (SpecA); vault custody
  (Spec B); file-manifest sealing (sub-project 3). SpecA's identity lookup, pin map, safety number,
  signer and locked state are **shared prerequisites** built here once (§3.1).
- Encrypting `agent:identity` / `fn:identity` at rest (follow-up).
- Out-of-band head gossip, ZK-attested directory, per-wrap signatures.

---

## 2. Architecture overview

### 2.1 Adversary and guarantees

Adversary **A1**: a malicious or compromised platform (SpecA §2). It controls every response, the
relay, personal KV, the identity directory and, for hosted apps, the served bundle.

| # | Guarantee, in an all-0.15 Space | Mechanism |
|---|---|---|
| T1 | A member never wraps a group key to a chat key the named member's pinned IK has not certified. | `keyCert` (§3.2), pins (§3.4) |
| T2 | In a private Space, a member admits only joiners with an owner- or editor-signed `add`, or a link-authenticated `redeem`. | Membership log (§3.5) |
| T3 | The server cannot replay a stale entry or silently drop a removal from a client that has seen a later head: that client refuses to wrap, adopt or send until the served log passes its high-water again. An entry that chains but breaks its rule is a no-op, never a way to brick a Space. | Hash chain, high-water heads, commit heads (§3.7) |
| T4 | An agent or function receives a key only with a `svc add` signed by the pinned app owner or an owner-listed editor. | `svc` entry, `AppRoster` (§5.3) |
| T5 | A client adopts a key for a committed epoch only if it matches a `keyCommit` signed by a member entitled at that point, and seals under a legacy key only if the migration genesis committed to it. | `EpochCommit` (§4.2), `legacyCommits` (§3.5, §4.2.5) |
| T6 | Rotators and joiners use only link keys whose `link` entry the link's creator signed. | `link` entry + `lsig` (§4.4) |
| T7 | A session without its stable identity never participates. | `locked` (§3.3) |
| T8 | A 0.15 member that has applied a private-Space removal never seals under a key the removed member held, or could obtain through a link minted before the removal, even if the server later rolls back or forks the log it serves. An honest server gives the removed member no socket, history, posting or link redemption. | Sealable rule with the persisted removal floor and integrity (§4.2.8, §3.7); link liveness (§3.5); transport gate and the `removed` redeem check (§3.6, §4.4.4) |

Residuals X1–X9 (stated in docs and commits, §9.3): TOFU at first contact (directory, genesis
without a link, app owner without `trustAnchor`); the hosted bundle; published SDKs harvest keys
(X3); log forks in quiet Spaces, and devices that lost their local high-water;
ex-editor plus server backdating an `svc`; platform-held service keys at the current epoch; migration
TOFU, per Space; live link fragments; stale published-SDK tabs reconnecting to a private Space they
may not enter (X9).

### 2.2 Who holds which secret (after step R)

| Secret | Held by | At rest | Server can use it? |
|---|---|---|---|
| Group key `K_e`, member Space | Member clients | Client memory; `space-keys-v2/<spaceId>` sealed under the seed (§4.3); `keyring:<m>:<e>` wrapped to each member | No |
| Seed (→ IK private key, chat-key vault) | The user | Vault (Spec B) | No |
| Chat-key private keys | Member client | `chat-keys`, seed-wrapped (`con/core/ChatKeyVault.ts`) | No |
| Link secret `d` | Holders of the URL; the minter through `ownerWrap` | Fragment only; `ownerWrap` sealed to the minter's chat ECDH key | No |
| Service identity (agent, function) | AppDOv1 | `agent:identity:<id>`, `fn:identity:<id>` plaintext | **Yes**, with that member's `keyring:<svc>:<keyedEpoch>` (older copies are deleted at each commit, §4.2.3) |
| `__logs__` key | AppDOv1 | `keeper:gk:<logSpaceId>:<e>` | **Yes**, by design |
| Legacy keeper escrow | AppDOv1 | `keeper:gk:*` until R; `keeper:identity` becomes a tombstone | Until R (sole-copy rows until accepted) |

### 2.3 Trust roots

| Root | How a 0.15 client obtains it | Pinned in |
|---|---|---|
| A user's IK | `POST /api/auth/identity` (SpecA §4.1), or an owner/editor-signed `add` naming it | `muhkoo.pins/identity-v1` (SpecA §4.2), shared with DMs |
| A Space's genesis | Link-authenticated prefix (§4.4), else TOFU on first open | `muhkoo.pins/spaces-v1` entry `s:<hash(spaceId)>` |
| An app's owner | `trustAnchor` built into the app, else TOFU via `GET /api/app/trust` | `spaces-v1` entry `ao:<appId>` |
| An app's editors | `AppRoster` signed by the owner IK | `spaces-v1` entry `ar:<appId>` (seq high-water) |
| A link | `lsig` under `ls = derive(d)` over the `link` entry | not pinned; authenticated by `d` |

### 2.4 Flows

```
CREATE   bootstrapNew → connect → POST /keyring/log {genesis, ec(0)} → join-request {keyCert}
         → self-wrap epoch 0 (fulfils own waiting row) → sweep

LINK     URL <base>?<app params>#space=S&t=T&lk=d
         → (private) POST /keyring/redeem-preview {token} → verify link entry with ls(d)
         → POST /keyring/redeem {token, keyCert, entry: redeem|join(via) + lsig}
         → server: lsig verified before any write → returns link blobs + commits
         → client: unwrap with d, check keyCommit → self-wrap → keyring:<me>:<e>

WAIT     (public: POST /keyring/log {join}) → join-request {keyCert}
         → relay verifies keyCert against ikbind:<J> → waiting:<J>
         → unmetered joinRequest frame (a trigger only) to published sockets + ≤ 3 certified holders
         → a 0.15 key holder: sweep → /pending → IdentityGate + log checks → /keyring/wraps
         → waiting:<J> deleted, `admitted` broadcast, targeted keyringReady → J pulls, checks commit

ROTATE   rotateDue (removal, escrow retired, conflict, legacy gap) or owed-from-log
         → pre-check: a second certified copy is possible (else rotation-blocked, no epoch burned)
         → POST /keyring/rotate {v:2, ifCurrent, membershipHead}
         → one pre-commit batch (self + ≤8 humans + services + ≤16 links), invisible to others
         → POST /keyring/rotate-commit {epoch, ec} (needs a second certified copy, or sole)
         → keyedEpoch moves, services' older copies deleted, backfill waiting:, background fan-out

REMOVE   (private) owner/editor signs `remove` → relay: allow: deleted, every link minted before it
         revoked, ikbind.removedSeq set, its sockets closed (4403), /history, posting and redeem
         refused → rotateDue
         → members' sends paused ("securing") until a rotation commits (sealable rule, removal floor)

ENABLE   SDK agents.enable → GET …/enable/prepare → sign `svc add` with IK
         → POST …/enable {entry} → AppDOv1 → relay /agent/enroll (vouch + append entry)
         → members' sweep verifies svc entry (owner, or an editor in the owner-published AppRoster)
         → wrap keyedEpoch to the agent

MESSAGE  sender sets headers.to from @mentions → relay forwards only packets at keyedEpoch, with
         keys only for targets → AppDOv1 unwraps its own copy, opens, runs, seals reply at keyedEpoch
```

---

## 3. Identity, pinning and signed membership

### 3.1 Today (cited)

| Fact | Evidence |
|---|---|
| The IK is seed-derived: `HKDF(seed, "ecdsa-priv")`, the same on every device | `con/auth/identity.ts:187-193` |
| It is written once, at registration, to `user:<lower>` on the singleton `UserAuth` DO | `acc/durable-objects/userAuth/zk.ts:307`; singleton `acc/durable-objects/clients/userAuthDo.ts:38` |
| The circuit's `ecdsaPubHash` is destructured and never compared; the commitment is never handed out, so clients cannot check the IK against it. The directory is TOFU (SpecA §7.1). | `zk.ts:190`; `zk.ts:401-404` |
| Chat keys are random P-384 pairs, seed-wrapped in personal KV `chat-keys`, not bound to the IK anywhere | `con/core/ChatKeyVault.ts`; no certificate field in `con/spaces/types.ts` |
| The member id is the session username | `keyring.ts:25-27` |
| `member:<m>` is overwritten by every `join-request` and `redeem` with whatever keys were posted | `keyring.ts:70`, `:160` |
| A published SDK wraps to the key inside any `joinRequest` frame | `Space.ts:754-762` (`:760`) |
| `pullKeys` adopts any blob that unwraps and moves its sending epoch to the maximum held | `SpaceKeyring.ts:257-278` (`:273`) |
| A locked session silently mints an ephemeral chat pair; a vault error is swallowed | `SpaceNamespace.ts:322-348` (`:336-338`, `:341-342`) |
| The key cache is `encrypt:false`; anyone who can write personal KV can plant a key | `Client.ts:387-395` |
| Private Spaces: any allowlisted member can add any username; only the creator sets roles and mints links | `keyring.ts:80-90`, `:178-187`, `:319-321` |
| App editors are config-Space members with role `editor`; the owner is `developerCommitment`. `AppRecord` has no owner username. | `acc/platform/controllers/apps/authorize.ts:84`, `:134`; `acc/durable-objects/app/types.ts:9`, `:38` |

### 3.2 Identity key and `keyCert`

- **IK** is the one key that is pinned. `fp(IK) = b64(SHA-256(raw))`, as in SpecA's pin entries.
- **Chat keys** may change legitimately (a lost vault blob, a provisioning race), but only under a
  certificate from the IK:

```
ChatKeyCert { v:1, ik, ecdh, ecdsa, sig }
certBytes := LP("muhkoo-chatkey-v1") ‖ LP(lower(memberId)) ‖ LP(ik) ‖ LP(ecdh) ‖ LP(ecdsa)
sig       := b64 P1363 ECDSA-P256-SHA256(IK_priv, certBytes)
```

- `ecdh` / `ecdsa` are the **exact** base64url JWK strings posted as `identityEcdhPub` /
  `identityEcdsaPub` (SpecA §3.1: sign transmitted strings, never re-exports).
- Minted in memory at unlock through `IdentitySigner` (SpecA §6.1 `KxSigner`, never the seed). Not
  stored client-side. Global, not per Space.
- **The relay verifies it against `ikbind:<m>`** (§3.6, §3.10): a WebCrypto P-256 verify over
  `certBytes` with `lower(memberId)` and the exact posted `identityEcdhPub` / `identityEcdsaPub`
  strings. There is no extra `UserAuth` call: the IK comes from the log, or, for a first binding,
  must equal the registered IK that the verified session context already carries (§3.6 Session IK).
  From step I a certificate is stored only after it verifies (§11.6 M4). It lives in
  `member:<m>.keyCert` (≤ `MAX_KEYCERT_BYTES`), and is returned by `/keyring/roster`,
  `/keyring/pending` and `waiting:` rows. Published SDKs read only `memberId` and `identityEcdhPub`
  from those (`Space.ts:755-761`, `KeyringClient.ts:63-66`). Clients still verify it against their
  own pins (§3.4).
- Service members (`__agent__:*`, `__fn__:*`) have no IK; the `svc` entry vouches for their keys
  (§5.3). Machine principals (`__machine__:<appId>`) cannot take part in Spaces under 0.15.

### 3.3 Stable identity required; `locked`

`SpaceNamespace.ensureIdentity` (`:322-348`) is rewritten:
- `session.seed` null → throw `IdentityLockedError` (SpecA §6.6, shared type).
- `chatKeys.ensure` fails → throw `IdentityUnavailableError` (retryable). Today the error is
  swallowed (`:336-338`).
- `generateOwnKeyPair` is never called (`:341-342` deleted).
- Returns `{ecdhPub, ecdsaPub, keyCert}`.

| Call while locked | 0.15 behaviour |
|---|---|
| `createChannel`, `createSpace` (messaging on) | Throws `IdentityLockedError`: a Space needs a signed genesis |
| `createSpace({messaging:false})` (the VFS content Space, `con/core/Client.ts:331`) | **Unchanged.** No keyring, no genesis, no identity needed; file chunks carry their own keys |
| `joinChannel`, `space.get`, `joinByInvite` | Returns a `Space` with `admission:"locked"`. No `join-request`, no `member:` write, no blob, no sweep, no self-escrow. `join()` resolves `false` immediately. File ops that need no group key keep working. |
| On `client.auth.zk.unlock()`, a passkey or device factor, or a completed hosted sign-in (`client.auth.hosted.login({…, returnTo})` → `handleCallback()`) | Locked Spaces resume: identity → `keyCert` → log sync → join. `waitForKey()` spans the unlock; after a hosted round trip the app reopens the Space at `returnTo` (CS-5). |
| Rotate, mint a link, sign an entry, enable an agent | Impossible without the IK (`IdentityLockedError`) |
| Any call on a separately constructed `Client` restored from a stored session (today's portal per-app clients, `portal/src/lib/spaceInvites.ts:53-65`) | Always `locked`: `restore()` never yields a seed (`con/core/Session.ts:136-139`). A second Client for another app key must be built with `client.withAppKey(pk)` (§6.9, SEC8). |

This applies to **every** locked session, not only known members (strengthens critic A2 per decision
10). Web must gate on it before opening any Space (§7).

### 3.4 Pinning

- **`muhkoo.pins/identity-v1`** is SpecA §4.2's document, unchanged: username → `fp(IK)`, signed by
  the owner's IK, monotonic `counter`, written by direct `http.post` (not `kv.set`), IndexedDB
  high-water, hard-fail on rollback or deletion. One pin serves DMs and Spaces.
- **`muhkoo.pins/spaces-v1`** is a second document with the same format, code path and hard-fail
  table, and a different label:

```
signed bytes := LP("muhkoo-spacepins-v1") ‖ LP(ownerCommitment) ‖ LP(dec(counter)) ‖ LP(sorted entries…)
entries:  "s:"  + b64url(SHA-256(utf8(spaceId)))  → genesis hash (b64)
          "ao:" + appId                           → lower(owner username)
          "ar:" + appId                           → dec(highest AppRoster seq seen)
```

| Source of an IK for username `u` | Pinned? | Checked against |
|---|---|---|
| Owner adds `u` by username | Yes, when a `keyCert` from `u` first verifies under it (SpecA §4.3: never pin a decoy) | directory (`POST /api/auth/identity`), TOFU by the owner |
| An owner/editor-signed `add` names `u`'s IK | Before the first wrap to `u` | existing pin; mismatch is a conflict. No directory call: the Space authority vouches. |
| A self-signed public `join` or private `redeem` by `u` | Before the first wrap, after the directory agrees | directory, then pin |
| A DM handshake | SpecA rules | — |
| Only seen as a message sender | Not pinned; verified against the log (§3.9) | — |

- Pin writes are batched, one per sync, as a direct POST whose body carries `hlc` = `dec(counter)`
  zero-padded to 16 digits (CP9). PersonalSpaceDO refuses a stamp that is not greater than the stored
  one (`{ok:true, applied:false}`, `PersonalSpaceDO.ts:389-391`, `:429-432`), so two writers of one
  counter cannot both apply. On `applied:false` the writer re-reads, re-verifies, merges (union of
  entries; the same peer with a different IK takes the `identity-changed` row below, never an
  overwrite), increments `counter` and retries at most 3 times, then fails closed for that operation
  only. A pin write without `hlc` is a bug: it would clear the stamp (`:462-463`). A pin read is
  checked against the high-water mark read **before** that read was sent, so another tab raising the
  mark meanwhile is not a rollback. SpecA §4.2 (write path, rollback row) and §6.4 are amended the
  same way in the connect release that first ships `PinStore` (Q15). The pin documents are reserved
  SDK keys (§6.6a) and are never refused by the Free op cap. A 5xx on the pin read/write, or a 5xx or 429 on the directory,
  refuses new wraps and new trust for that operation only (fail closed); held keys keep working.
- The directory lookup has its own per-caller bucket (§6.1), so Space traffic can never lock anyone
  out of signing in. `IdentityGate.bindingsFor` sends one batch call per ≤ 64 unpinned names and is
  never called per member when a Space opens: log entries carry IKs (§3.5). It needs two additions to
  SpecA's endpoint: the batch form with its own bucket (SpecA §4.1 must be amended to match, Q15), and
  normalising a stored **hex** key to b64 raw (legacy portal sign-ups stored hex; the server already
  decodes both, `zk.ts:29-43`).

| Change seen | Behaviour | Event |
|---|---|---|
| New chat keys with a valid `keyCert` under the pinned IK | Silent; the sweep wraps to the new key (§4.5.4 replace rule) | `member-rekeyed {memberId}` |
| IK differs from the pin (entry, cert or directory) | Hard stop for that member: no wrap, no pin update, messages `verified:false` | `identity-changed {memberId, pinnedFingerprint, newFingerprint, safetyNumber}` |
| An `add` names an IK that differs from **my** IK | Joiner state `identity-mismatch` | `admission` |
| Recovery | Only `client.trust.unpin(username)` (SpecA's `client.message.unpin` delegates to it), after comparing safety numbers | — |

`client.trust.safetyNumber(username)` and `space.safetyNumber(memberId)` use SpecA §4.4 and give the
same number as the DM one for the same pair. Both are methods (no api-surface churn).

### 3.5 The membership log

One append-only, hash-chained log per Space, for private **and** public Spaces; the rules differ by
visibility. A chain (not signed rows, not a signed snapshot) is chosen because dropping any entry
forks every later signature and every `EpochCommit` that names a later head.

```
MembershipEntry {
  v:1, spaceId, seq, prev,      // seq 0 = genesis, prev "" at genesis
  op, by, ik, at,               // by = signer member id; ik = signer IK; at = signer clock (informational)
  body: {…per op…},
  sig,                          // b64 P1363 ECDSA-P256-SHA256 by ik over entryBytes ("" only for retire)
  lsig?                         // link, redeem, join-with-via: P-256 signature by ls (§4.4) over entryBytes
}
entryBytes := LP("muhkoo-mlog-v1") ‖ LP(spaceId) ‖ LP(dec(seq)) ‖ LP(prev) ‖ LP(op) ‖ LP(by)
            ‖ LP(ik) ‖ LP(dec(at)) ‖ LP(opBytes)
hash       := b64(SHA-256(entryBytes))     // never over sig bytes: ECDSA is malleable
```

| op | `opBytes` (concatenated `LP`s, in this order) |
|---|---|
| `genesis` | `visibility` (`private`\|`public`), `policy` (`static`\|`rotate`), `appId`, `dec(baseEpoch)`, `legacyCommits`. `baseEpoch` is −1 for a new Space, or the relay's `currentEpoch` at migration. `legacyCommits` is the concatenation, over epochs ascending, of `LP(dec(e)) ‖ LP(keyCommit(e, K_e))` for the epochs `≤ baseEpoch` whose key the signer holds, at most the highest 64; `""` for a new Space. In the JSON body it is `legacyCommits: {[e]: b64url32}`. |
| `add` | `member`, `memberIk`, `role` |
| `role` | `member`, `role` |
| `remove` | `member` |
| `leave` | (empty) |
| `join` | `via` (linkId or `""`) |
| `link` | `linkId`, `role`, `standing` (`"1"`\|`"0"`), `dec(expiresAt)`, `dec(maxUses)`, `linkEcdhPub` (`""` if keyless), `linkSignPub`, `keyCommits` = concat over epochs ascending of `LP(dec(e)) ‖ LP(keyCommit(e))` |
| `unlink` | `linkId` |
| `redeem` | `linkId` |
| `svc` | `member`, `action` (`add`\|`remove`), `ecdhPub`, `ecdsaPub`, `mode` (`addressed`\|`all`), `dec(rosterSeq)` |
| `retire` | `member`, `reason`. Server-written: `by`, `ik`, `sig` are `""`. Only for `__agent__:*` / `__fn__:*`. It can only reduce access. |

**Authorisation, evaluated at the entry's position.** Replaying the verified prefix gives `S_{n-1}`;
entry `n` is valid only if its rule holds there. `prev` pins the position, so a stale entry cannot be
replayed later, and an editor demoted at seq 10 cannot validly `add` at seq 11.

| op | Private Space | Public channel |
|---|---|---|
| `genesis` | `by` = the owner (becomes `S.owner`) | any `by`; grants no authority (server checks: the founder for a new Space; at migration a verified key holder of a committed legacy epoch, §3.6 step 4) |
| `add` | owner (any role), or editor (`role:"viewer"` only); target not a member. Re-signing a pre-log `allow:` member (§3.8 step 2) is the owner's alone: an editor's `add` of a target that still holds `allow:` is refused (D24) | not allowed |
| `role` | owner only; target a non-owner member | not allowed |
| `remove` | owner (any non-owner), or editor (viewers only). Kills every link minted before it (link liveness, below). | not allowed |
| `leave` | `by` is a member and not the owner. Kills every link minted before it. | `by` has joined; kills nothing |
| `join` | not allowed | `by` = self, not already joined. With `via≠""`: that link is live at `n-1` and `lsig` verifies. |
| `link` | owner, or editor (`role:"viewer"` only); valid `lsig` | any joined member; valid `lsig` |
| `unlink` | the link's creator, or the owner | the link's creator |
| `redeem` | the link is live at `n-1` (link liveness, below); `by` is not a member; `by ∉ S.removed`; valid `lsig` | not used (public link joiners `join` with `via`) |
| `svc` | §5.3 | §5.3 |
| `retire` | always valid | always valid |

**Link liveness** (`MembershipLog.linkLive(linkId, n)`, the one definition used by `redeem` and
`join{via}` validity, rotation targets (§4.2.7), §4.4.5, §4.4.6 and §4.5.9 step 5). A `link` entry is
live at position `n` when it has not been unlinked, its creator is still entitled,
`redeems(linkId) < maxUses` when `maxUses > 0`, `at ≤ expiresAt + 5 min`, and, in a private Space,
**its seq is greater than `S.lastHumanRemovalSeq`**. A private `remove` or `leave` therefore kills
every link minted before it, the owner's standing link included: any of them could have reached the
departing member, and a fragment cannot be taken back. The owner or an editor mints a new one (SEC9).

State: `S = {owner, visibility, policy, appId, baseEpoch, legacyCommits, members{id → {ik, role,
since, via}}, services{id → {ecdhPub, ecdsaPub, mode, addedBy, rosterSeq}}, links{linkId → entry},
removed, lastRemovalSeq, lastHumanRemovalSeq, lastSvcRosterSeq}`.
- **`removed`** (member ids): a private `remove` of `m` adds `m`; a later valid `add` of `m` deletes
  it. A `leave` does not, so someone who left may come back through a new link.
- **Removal-type** entries set `lastRemovalSeq`. In private Spaces these are `remove`, `leave`,
  `svc remove` and `retire`. In public channels only `svc remove` and `retire` count: a human who
  leaves a public channel can rejoin at will, so rotating buys nothing.
- **Human-removal** entries also set `lastHumanRemovalSeq`: private `remove` and `leave` only (−1 when
  there are none). They drive the sealable rule (§4.2.8, SEC1).

**Owner absence (CS-9).** Only the owner can change roles, add editors or rotate at will, and the
owner cannot `leave`. If the owner is gone and no editor exists, the membership is frozen: current
members keep reading and sending, and nobody can be added. Owners should appoint an editor (the
portal suggests it when a team Space has none). Ownership transfer is a follow-up (§11.5). Ordinary
members can no longer add anyone, as they can today (`keyring.ts:80-90`): decision 10 requires
owner- or editor-signed membership.

### 3.6 Relay handling: `MembershipLogFacet` (a facet, not a DO class)

New facet in `acc/durable-objects/space/mlog.ts`, added to `SpaceFacets`
(`acc/durable-objects/SharedSpaceDO.ts:45-51`, constructed at `:72-78`); pure encoders and the
validator in `acc/durable-objects/space/mlogCanonical.ts`. A Space is **log-enabled** once
`meta:mlogHead` exists.

**Session IK (SEC10).** The verified session context carries the account's registered IK. UserAuth
`/verify` (`acc/durable-objects/userAuth/sessions.ts:89-97`) also returns `ecdsaPublicKey`, read from
the session record, which already stores it (`zk.ts:531-539`, copied at login from `user:<lower>`,
written once at registration). `resolveUserContext` (`acc/platform/services/userResolution.ts:64-87`)
normalises it to b64 raw P-256 (stored hex accepted by the rule of `decodeRawPubKey`, `zk.ts:29-43`)
and keeps it as `ResolvedUserContext.ik`, in the 60 s `usersess:<token>` cache entry and in the
`X-Muhkoo-User-Context` header; `SpaceDO.extractUserContext` returns `ik?`. There is no new
`UserAuth` call. The relay never binds a member to an IK on its own evidence: every self-sourced
**first** binding (step 3, §3.10 Valid) requires the posted IK to equal the session IK, compared as
decoded bytes. A context without `ik` refuses the binding with
`503 {code:"identity-context-unavailable"}` and `Retry-After: 60`, writing nothing; that happens only
for a cache entry written before the deploy (≤ 60 s) or a machine principal, which cannot take part
anyway (§3.2).

`POST /api/spaces/:id/keyring/log {entry, ec?}`:
1. Structure: `v === 1` (else `400 {code:"malformed"}`); `spaceId === meta:spacePubKey` (else
   `400 {code:"wrong-space"}`); size ≤ `MAX_MLOG_ENTRY_BYTES` (4096) (else `400 {code:"too-large"}`);
   `seq === head.seq + 1 && prev === head.hash`, or `seq === 0` with no head. Else
   **`409 {error:"Log moved", head}`** (step-I plan D22).
2. `by` equals the session user. `op` is not `svc` or `retire`: those are appended only by the
   internal `/agent/enroll` and `/agent/unenroll` facet calls, never through this route
   (`403 {code:"internal-op"}`). No genesis travels through `/agent/enroll` (SEC3, SEC4).
3. `sig` verifies under `entry.ik`, and `lsig` under the link-sign key (stored
   `invite:<token>.linkSignPub` for `redeem`/`join{via}`, or `body.linkSignPub` for `link`);
   WebCrypto P-256 `raw` import. **`entry.ik === ikbind:<by>.ik` when `by` is bound**, else
   `403 {code:"identity-bound"}`. When `by` is unbound, only binding ops may proceed (private or
   public `genesis`, `join`, `redeem`), and only when `entry.ik` equals the session IK (else
   `403 {code:"identity-not-registered"}`, nothing written); they bind in step 5. Any other op gets
   403 `identity-bound`. `svc` entries appended by the internal `/agent/enroll` and
   `/agent/unenroll` calls skip steps 2–3's session and binding checks: the enable controller has
   already checked that `ik` is the signer's registered IK (§5.3.3); the relay still verifies `sig`,
   and never binds from them.
4. Authority against the server's mirror (`meta:creator`, `role:`, `allow:`, `meta:founder`,
   `isKeyHolder`, the log state). This is the honest-server copy of §3.5 and protects published
   SDKs from third parties. **Genesis** (SEC3): it must match `meta:visibility`; when `baseEpoch ≥ 0`
   it must equal `currentEpoch`, and a new-Space genesis (`baseEpoch === -1`) needs `currentEpoch === 0`
   (else `409 {code:"base-epoch-mismatch", currentEpoch}`; step-I plan, G4 refinement 5);
   `legacyCommits` has unique ascending epochs in `[0, baseEpoch]`, at most 64, each value 32 bytes.
   Private: `by === meta:creator`. Public migration: `legacyCommits` is non-empty and
   `holdsVerified(by, e)` (§4.1.3) for some `e` in it. Public new Space: the founder (§4.1.4).
5. Store `mlog:<seq, 16-digit zero-padded>` and `meta:mlogHead = {seq, hash}`; run the mirror
   effects below; then record bytes-at-rest (not enforced: membership must not fail on a storage
   quota; wraps today are also unenforced, `keyring.ts:258-260`). The effects come first because
   the bytes-at-rest call reaches the Billing DO, which lets other requests into the object; a
   removed member's sockets are closed before then (D29). Mirror effects, in the same request:

| op | Mirror effect |
|---|---|
| `genesis` (private) | bind `ikbind:<by>` to `ik` when unbound; `closeNonMembers()` |
| `genesis` (public), `join` | bind `ikbind:<by>` to `ik` only when `by` is unbound; `join` changes nothing else (public membership is open) |
| `add` | write `allow:<m>`, `role:<m>`; bind `ikbind:<member>` to `memberIk`, overwriting any binding (the owner's or editor's signature vouches; a wrong binding is corrected by `remove`, then `add`); the overwrite also clears `removedSeq`, and `mlogmember:<member>.removedSeq` is cleared too (step-I plan D16) |
| `redeem` | write `allow:<m>`, `role:<m>`; bind `ikbind:<by>` to `ik` only when unbound |
| `role` | write `role:<m>` |
| `remove`, `leave` (private) | delete `allow:<m>`, `role:<m>`; **revoke every live link**: the §4.4.8 cascade for each `linkidx:*`, listed once (≤ `MAX_LINKS_PER_SPACE`), deleting in batches of 128 keys; merge `meta:rotateDue {reason:"remove"}`; broadcast `rotateDue`; `closeNonMembers()`. `remove` additionally sets `ikbind:<m>.removedSeq = seq` when `<m>` is bound, and `mlogmember:<m>.removedSeq = seq` always, so a member allowed before the genesis (no `ikbind:` row) still carries the marker (KI9; step-I plan D16) |
| `link`, `unlink` | via `/keyring/link`, `/keyring/link-revoke` (§4.4) |
| `svc`, `retire` | via `/agent/enroll`, `/agent/unenroll` only (§5.3, §5.5) |

`ikbind:<m> = {ik, src:"log"|"cert", seq?, removedSeq?}` changes in no other way, except that a
private `remove` sets `removedSeq`; in particular a self-signed entry never rebinds a bound member. A
`src:"cert"` binding comes from the member's first verified `keyCert`, whose `ik` equals the session
IK (§3.10). Every self-sourced binding therefore holds the account's registered IK; only an owner's
or editor's `add` can bind another IK, and `remove` then `add` corrects it.

6. `genesis` with `baseEpoch === -1` must carry `ec` for epoch 0 (§4.2.4); both stored atomically,
   and only while `currentEpoch === 0` and `keyedEpoch === 0` with no `meta:epochCommit:0`. A migration genesis whose
   `legacyCommits` is empty, or whose highest committed epoch is below `baseEpoch`, also merges
   `meta:rotateDue {epoch: baseEpoch, reason:"legacy-epoch-gap"}` and broadcasts `rotateDue`; under
   §4.2.1 any key holder, or the private owner, may then rotate.
7. Broadcast `{"mlog":{"seq","hash"},"timestamp"}` **unmetered**. Published SDKs ignore unknown frames
   (`Space.ts:705-769` falls through).

Other routes: `GET /keyring/log?since=<seq>&limit=<≤500>` → `{entries, head}` (private gate;
public: any authenticated app user). `POST /keyring/redeem-preview {token}` → `{linkEntry, entries,
head}`, authorised by a live token; added to the gate's exempt list next to `join-request` and
`redeem` (`keyring.ts:47-53`). A `meta:mlogHead` row that exists but does not parse answers `500`
on both, and on relay `/agent/enroll-prepare`, exactly as the append paths do, never `head:null` (D30).

**Transport gate for log-enabled private Spaces (SEC1).** "Gated" means `meta:mlogHead` exists
**and** `meta:visibility === "private"`. `__logs__` Spaces never get a genesis, so the owner's log
reader (`acc/platform/controllers/apps/LogsController.ts:64-80`) and every non-log Space are
unaffected. Helpers in the sibling `TransportGateFacet` (`acc/durable-objects/space/transportGate.ts`): `gated(): Promise<boolean>` and
`isAllowed(user?): Promise<boolean>` (`allow:<user>` exists).
- **`/websocket`** (`SharedSpaceDO.ts:196-218`). On a gated Space, an upgrade whose ticket carries no
  username (an upgrade that carries the app-key header instead of a ticket counts as anonymous), or
  whose user is not allowed, is refused over HTTP before the upgrade: 401 for an anonymous caller,
  403 `{error:"Not a member of this private channel"}` for a non-member (D31). A client that asks
  with the query parameter `refuse=close` (0.15 does, §6.9) is instead accepted **without**
  hibernation (`pair[1].accept()`, never `state.acceptWebSocket`), closed with
  `close(4403, "not-member")`, and answered 101. Either way it never enters `sessions`, gets no
  backlog or broadcast, and is never rehydrated. It logs `space socket refused` with
  `mode:"http"|"close"` (§6.8).
- **`/history`** (`SharedSpaceDO.ts:166-168` passes `request` to `handleHistory(url, request)`). On a
  gated Space: no user context → `401 {error:"Authentication required"}`; a user without `allow:` →
  `403 {error:"Not a member of this private channel"}` (the keyring gate's answers, `keyring.ts:25-26`,
  `:46-53`; AV12).
- **`spaceMessage`, `editSpaceMessage`, `deleteSpaceMessage`** (`wsProtocol.ts:473-564`). Straight
  after the existing `!session.authUser` check: on a gated Space, a socket whose `authUser` has no
  `allow:` gets `{error:"Not a member of this private channel"}`; nothing is stored, broadcast or
  pushed to agents. `pub` and DM frames are unchanged: every open socket on a gated Space is a member.
- **`closeNonMembers()`** closes with 4403 every socket in `sessions` whose `authUser` is absent or
  has no `allow:`, and broadcasts `quit` once per **named** socket it closed — none for a socket still
  mid-handshake (no name yet) — unmetered (§4.5.5; step-I plan D17). It runs as a mirror effect of a
  private `genesis`, `remove` and `leave`. `sessions` is rebuilt from hibernation in the constructor, so it needs no new
  state.

Published SDKs send the session on HTTP and in the ticket mint (`con/core/HttpClient.ts:127-139`,
`con/core/namespaces/SpaceNamespace.ts:359-366`, `acc/platform/routes/wsTicket.ts:29-38`), so only
anonymous and non-member sockets on log-enabled private Spaces are affected. A published tab refused
this way retries every 3 s without limit (`Space.connect` passes `maxReconnectAttempts: 0`) and mints a
metered ticket each time (`con/spaces/Space.ts:228-239`, `con/transport/WSTransport.ts:198-206`):
residual X9. Refusing it before the upgrade (D31) does not end that loop, but its socket never opens,
so it never flaps connected/disconnected and never holds a socket it could send on. 0.15 sends
`refuse=close`, and stops only after `GET /keyring/state` confirms the 4403 with a 403 (§6.9).

**On a log-enabled Space the legacy membership mutations return 409**, so `allow:` is written only
by signed entries:

| Legacy route | 409 body |
|---|---|
| `/keyring/invite` (`keyring.ts:80-90`) | `{code:"signed-membership-required"}` |
| `/keyring/role` (`:178-187`) | `{code:"signed-membership-required"}` |
| `/keyring/link` on a private Space: any body in step I, a body without `entry` from A0a (step-I plan D5) | `{code:"signed-membership-required"}` |
| `/keyring/redeem` of a record without `linkSignPub` on a private Space (every record in step I, before A0a's v2 path; step-I plan D5) | `{code:"link-needs-upgrade"}` (Q3) |
| `/keyring/rotate` without `v:2` | `{code:"signed-rotation-required"}` (§4.2.9) |

Caps: `MAX_JOINS_PER_MEMBER` (20) bounds **`leave`** entries per member per public Space: the 21st
`leave` returns `409 {code:"leave-cap"}` and the member stays joined. A `join` is never refused by a cap
(KI10).

### 3.7 Client verification and heads

`con/spaces/trust/MembershipLog.ts`:
1. **Incremental sync** `GET log?since=<localHead.seq>`: recompute each hash, check `prev` and `seq`
   continuity, apply §3.5. An `mlog` frame only marks the log stale; a stale log is synced at most
   once per `LOG_SYNC_MIN_MS` (10 s) in the background, and immediately (ignoring the interval)
   before a wrap, a commit check, a rotation, or a send (§4.2.8) (CS-6). An `EpochCommit` whose
   `headSeq` exceeds the local head triggers one immediate sync before it is judged (AV13). A
   commit's `headHash` must equal this client's hash at `headSeq` (§4.2.5).
2. **Genesis trust**, in order: pinned `s:<hash(spaceId)>` (mismatch = hard fail); else a
   link-authenticated prefix (§4.4.5); else TOFU with the owner's IK checked against the directory
   and pinned, safety number offered. `genesis.appId` must equal this client's app.
3. **Heads and the removal floor** (SEC11, AV13).
   - Per `(ownerCommitment, spaceId)` the client keeps `hw = {seq, hash, humanRemovalSeq}` in
     IndexedDB `muhkoo.trust`. `{seq, hash}` moves with the verified head; `humanRemovalSeq` is the
     highest seq of a private `remove` or `leave` this client has applied (−1 if none) and only
     increases. `hw` is copied into the sealed cache (§4.3) whenever the cache is written, and the
     cache is also written when this client first applies a removal-type entry (§3.5). On open the
     client takes the field-wise maximum of the two copies.
   - **`integrity:"broken"`** is set by a sync whose head is below the `hw.seq` read **before that
     request was sent** (another tab may raise `hw` meanwhile), by a different hash at `hw.seq`, or by
     an `EpochCommit` whose `headSeq` still exceeds the head of a `GET /keyring/log` issued after that
     commit arrived (item 1).
   - While it is set the client wraps nothing, rotates nothing, adopts no new key and **seals
     nothing**: `sealMessage` throws `SpaceTrustError{code:"integrity"}`; frames already sealed and
     queued still go out. It keeps reading with the keys it holds.
   - It is re-evaluated on every sync and clears only when a sync's verified chain passes through
     `hw.seq` with `hw.hash`. The only other exit is `client.trust.resetSpacePins(spaceId)`, after the
     user confirms (§6.9).
   - A device that lost IndexedDB relies on the sealed cache, which the server can replay at an older
     AEAD-valid version; it is protected only as a new device is (X4).
4. **Lazy signatures in public channels.** Hashes and the chain are checked eagerly; a public `join`
   signature is checked only when that member is relied on (wrap target, displayed sender, commit
   signer). Authority entries (`genesis`, `link`, `svc`, every private entry) are verified eagerly.
5. **Invalid entries (SEC4).** An entry that chains correctly (seq, `prev`, hash) but fails its §3.5
   rule, its signature or its IK binding is a **no-op**: the chain and head advance and `S` is
   unchanged. It never sets `integrity`. An honest server never appends one (§3.6 steps 3–4), so the
   server mirror and clients cannot diverge through it, and a malicious server that inserts one gains
   nothing. An IK that differs from this client's pin still follows §3.4 (`identity-changed` for that
   member), not integrity.

### 3.8 Genesis for new and existing Spaces

| Case | Writer | Content |
|---|---|---|
| New Space, 0.15 `create()` | creator (private) / founder (public) | `baseEpoch:-1`, with `ec(0)` (§4.5.10) |
| Existing **private** Space (in practice the portal team Space, `portal/src/lib/spaceInvites.ts:68-74`) | only `meta:creator`, on its first 0.15 open | see **Private migration** below |
| Existing public channel | the first 0.15 key holder, after the one-time v1 import (§4.3), self-escrow and its own certificate post (§4.5.9 step 2); it needs no other member to be certified or online (CP7) | `baseEpoch = currentEpoch`; `legacyCommits` over the writer's held epochs (never empty). Members self-`join` on their first 0.15 open. An app owner or editor cannot write it through enable (SEC3): an enable on an unlogged public channel returns `needsSignature:[{spaceId, reason:"space-not-migrated"}]`. |
| `__logs__` Spaces, `messaging:false` Spaces | none | server-keyed / no keyring |

**Private migration**, in order, on the owner's first 0.15 open:
1. Genesis with `baseEpoch = currentEpoch` and `legacyCommits` over the owner's held epochs (after the
   v1 import, §4.3), possibly none.
2. One owner-signed `add` per `allow:` member, with the directory IK and `role:`. Only the owner
   re-signs a legacy member: the relay refuses an editor's `add` of a target that still holds
   `allow:` (`target-member`, D24). The owner does **not** pin an IK until a `keyCert` verifies
   under it, so a decoy for a never-registered username is never pinned; such a member simply can
   never be admitted, and a later real registration shows `identity-mismatch` until the owner
   re-adds. TOFU at migration, for this Space only (X7).
3. When `legacyCommits` is empty or stops below `baseEpoch`, the owner rotates in the same flow
   (§4.2.7 lets the private owner rotate without holding the key). Until that commits, 0.15 members
   read and cannot send (`rotation-pending`).
4. Emits `membership-bootstrapped {members}`.

Before the owner migrates a private Space, a 0.15 member of it is `legacy-unverified`: it reads with
legacy keys and wraps to no one.

### 3.9 Join visibility and sender verification

- `member-joined {memberId, kind:"user"|"agent"|"function", addedBy?, via?, seq}` for every new valid
  `add`, `redeem`, `join` or `svc add` after the first sync (which emits one `membership-synced
  {count}`); `member-removed` for `remove`, `leave`, `svc remove`, `retire`. The relay's `admitted`
  frame (§6.4) shows when a joiner received a key. Agents appear like any member; no banner.
- `SpaceMessageEvent.verified: boolean` is true when the packet signature (`canonicalMessage`,
  unchanged) verifies under chat ECDSA keys that are either certified by the IK the log binds to
  `from`, or the `ecdsaPub` of the sender's active `svc` entry. Legacy uncertified senders are
  delivered with `verified:false` (dropping them would break mixed-version Spaces during P).

### 3.10 Chat-key changes at the relay: `member:<m>` overwrite policy

"Same keys" means both `ecdhPub` and `ecdsaPub` equal. `member:<m>` is read before any write (today
it is overwritten unconditionally, `keyring.ts:70`, `:160`).

| Existing `member:<m>` | Posted | `member:<m>` | `joinreq:` | `waiting:<m>` | Broadcast | Status |
|---|---|---|---|---|---|---|
| any; private and not allowlisted | — | — | — | — | — | 403 (unchanged) |
| same keys; blob at `keyedEpoch`; no `reason` | — | unchanged (adds a Valid `keyCert` if none is stored) | unchanged | deleted | no | `admitted` |
| same keys; `reason ∈ {unwrap-failed, commit-mismatch}` | — | unchanged (adds a Valid `keyCert` if none is stored) | refreshed | written, `needsReplace:true` | yes (≥ 60 s since last) | `waiting` |
| same keys; no blob | — | unchanged (adds a Valid `keyCert` if none is stored) | written | written | yes | `waiting` |
| absent, or present **without** `keyCert` (legacy) | any | overwritten (today's behaviour) | written | written; `needsReplace` if a blob exists | yes | `waiting`, `keyChange:"accepted"` |
| **with** `keyCert`, keys differ | carries a `keyCert` | overwritten | written | written, `needsReplace:true` | yes | `waiting`, `keyChange:"accepted"` |
| **with** `keyCert`, keys differ | **no** `keyCert` | **unchanged** | **not written** | written, `uncertified:true` | **no** | `waiting`, `keyChange:"refused-uncertified"` |

In this table "with `keyCert`" means `hasCert(m)` (§4.1.3): a stored certificate whose `ik` equals
`ikbind:<m>.ik`. Before applying the table, `join-request` and `redeem` classify a posted `keyCert`
(SEC4):
- **Valid**: `v === 1`; `ecdh` and `ecdsa` equal the posted strings; `sig` verifies under
  `keyCert.ik` over `certBytes`; and `keyCert.ik === ikbind:<m>.ik` when `m` is bound, or, when `m`
  is unbound, `keyCert.ik` equals the session IK (§3.6), in which case it binds
  (`ikbind:<m> = {ik, src:"cert"}`). A certificate under any other IK is Invalid. A context without
  `ik` returns 503 `identity-context-unavailable` before any write (SEC10).
- **Invalid**: anything else. The request takes the **refused-uncertified** row whatever `member:<m>`
  holds: no `member:` write, no `joinreq:`, no broadcast, `waiting:{uncertified:true}`,
  `keyChange:"refused-uncertified"`. (During I–A0a, before this table ships, an invalid certificate is
  simply not stored and `member:` follows today's overwrite.)

Other rules:
- A post with **no** `keyCert` follows the table as before (the published-SDK path).
- The three "same keys" rows apply whether or not a `keyCert` is stored, and take precedence over the
  row "absent, or present **without** `keyCert`", which applies only when `member:<m>` is absent or
  the keys differ (CP7). This relay half ships in I, where certificate storage starts.
- Storing a `keyCert` for a member whose blob at `keyedEpoch` has a matching `tfp` counts that member
  in `keyHolders` (§4.5.7) and marks its sockets `certified` (§4.5.5).
- The last table row is decision 10 on the server side: a certified member's key is never replaced by
  one the bound IK did not certify, whether it came from a published-SDK locked tab, a stolen session
  or a substituted request. No `joinreq:` means no 10-minute replace window; no broadcast means
  published admitters are not invited to wrap to it. Redeem applies the same `member:` column.
- Never erase a stored `keyCert` for the same keys (mirrors the signing-key rule at
  `agentControl.ts:69-70`).
- A change of `member:<m>` keys makes blobs wrapped to the old key unverified (`tfp`, §4.1.3) and
  decrements `keyHolders` if the member was counted (§4.5.7).

---

## 4. Key distribution

### 4.1 Epoch bookkeeping

#### 4.1.1 Today (cited)

| Fact | Where |
|---|---|
| `/rotate` advances `currentEpoch` by 1 to `MAX_EPOCH_JUMP` (8) with no authority check beyond the keyring gate | `keyring.ts:289-311`; `acc/durable-objects/space/consts.ts:34` |
| `/wrap` refuses only `e > currentEpoch`; replace needs self, the creator, or a `joinreq:` younger than 10 min; every accepted wrap broadcasts `keyringReady` to every socket | `keyring.ts:232`, `:251-256`, `:346-358`, `consts.ts:43`, `keyring.ts:261` |
| `/pending` returns every `joinreq:` ever written | `keyring.ts:266-270` |
| `canSeedKeeper` binds `meta:keeperSeeder` trust-on-first-use in public Spaces | `keyring.ts:331-338` (write `:336`) |
| `keeperAdmit` overwrites `keyring:<m>:<e>` | `keyring.ts:398-419` (`:411-412`) |
| `broadcast` and `sendToMember` count every delivery against the message quota | `acc/durable-objects/SpaceDO.ts:206-218` (`:212`), `:220-249` (`:231`) |
| Free tier: `requestLimit 10_000`, `messageLimit 1_000`, hard | `acc/billing/tiers.ts:48-60` |
| `/metadata` GET is routed before the keyring gate; any holder of the publishable key can read it | `acc/durable-objects/SharedSpaceDO.ts:159-163`; `history.ts:47-53` |
| The metadata POST carries the user session (`X-Muhkoo-Session`) | `SpaceNamespace.ts:117-122`; `con/core/HttpClient.ts:139` |
| SDK `rotate` skips self and stops at the first failed POST; `KeyringClient.post` throws on non-2xx | `SpaceKeyring.ts:334-348` (`:341`); `con/spaces/KeyringClient.ts:32-40` |
| No app calls `rotate` | grep across web, portal, discord-clone, theater, cloud-drive, spotify, app-builder (v2-keys §1) |

#### 4.1.2 SharedSpaceDO `meta:*` keys

All written through `metaPut` (JSON under `meta:<key>`, `SpaceDO.ts:325-327`); builders in the new
`acc/durable-objects/space/keys.ts`, golden-tested.

| Key | Value | Meaning |
|---|---|---|
| `meta:currentEpoch` | number | unchanged counter |
| `meta:keyedEpoch` | number | highest **committed** epoch; every fulfilment, service copy, agent seal and link bound is judged against it |
| `meta:rotation` | `{v:2, epoch, by, at, prevKeyed, membershipHead:{seq,hash}, committedAt?, supersededAt?}` or `{v:1, epoch, by, at, legacy:true}` | in flight when `v:2` and neither `committedAt` nor `supersededAt` |
| `meta:rotateDue` | `{epoch, since, removed:string[], reason:"unenroll"\|"remove"\|"escrow-retired"\|"legacy-epoch-gap"\|"key-conflict", escrowRetired?:true}` | a rotation past `epoch` is owed; merges union `removed` |
| `meta:epochCommit:<e>` | `EpochCommit` (§4.2.4) | the signed key commitment of a committed epoch |
| `meta:mlogHead` | `{seq, hash}` | membership log head (§3.6) |
| `meta:founder` | username | first metadata POST of a **public** Space with a user session (§4.1.4) |
| `meta:keyHolders` | `{epoch, count}` | distinct humans with `holdsVerified` at `keyedEpoch` (§4.5.7) |
| `meta:lastKeyHolderAt` | ms | last connect of a key holder |
| `meta:admissionIndexV1` | `true` | lazy backfill done |
| `meta:svcCleanupV1` | `true` | lazy service-copy cleanup done (§5.5) |
| `meta:escrowedThroughEpoch` | number, only increases | written at R |
| `meta:keeperSeeder` | string | no longer written; read only by the bridge and `legacyKeyedEpoch` |

#### 4.1.3 Predicates

- **`hasCert(m)`**: `member:<m>.keyCert` is present and its `ik` equals `ikbind:<m>.ik`. The relay
  stores a certificate only after it verifies (§3.10), so this is a verified certificate bound to the
  member's IK. Everywhere in §4 and §6, "certified" means `hasCert` (§11.6 M4).
- **`holdsVerified(m, e)`** (CS-3): `keyring:<m>:<e>` exists, its `tfp` (§6.5 row 8) equals
  `b64url(SHA-256(utf8(member:<m>.ecdhPub)))`, and `hasCert(m)`. A §3.10 key change makes earlier
  blobs unverified automatically. A blob written before A0a has no `tfp` and never counts.
- **`isKeyHolder(m)`**: `holdsVerified(m, keyedEpoch)`. Used for due rotations, superseding a stall,
  minting keyed links in public channels, `/pending links[]`, link heal blobs, migration genesis of
  public channels, and the `joinRequest` trigger targets (§4.5.5). All of these are 0.15-only actions.
- **`isBridgeHolder(m)`**: `keyring:<m>:<keyedEpoch>` exists (verified or not) or
  `m ∈ {creator, founder, keeperSeeder}`. Used **only** to decide whether to replay waiting joiners to
  a published-SDK socket (§4.5.6): a published member may hold a working copy the relay cannot verify,
  and a replay is cheap.
- **`isOwner(m)`**: `m === meta:creator` (private Spaces only). Governs discretionary rotation.
  `keeperSeeder` is no longer an owner.
- **Active human member**: a `member:<m>` row that is not `__agent__:*`, `__fn__:*`, `__log__*`,
  `__keeper__`, `__link__:*` or `__machine__:*`, and — private — has `allow:<m>`.
- **Certified human member** (CS-8): an active human member with `hasCert(m)`. These are the only
  humans a 0.15 rotator may wrap to, and the only ones the copy rule counts (§4.2.3).

#### 4.1.4 Blob visibility, `founder`, lazy backfill, keeper seeding

**Blob visibility** (`GET /keyring/blobs/<m>`, today `keyring.ts:205-213`). On a log-enabled Space a
blob at `e` is returned when `e ≤ genesis.baseEpoch`, or `meta:epochCommit:<e>` exists, or
`?pending=1` comes from `rotation.by` for `rotation.epoch` (resume after restart). On a Space without
a log it is returned when `e ≤ currentEpoch` and `e` is not an in-flight v2 rotation's epoch (keeps
pre-v2 legacy blobs visible). A **superseded** epoch is an uncommitted `e` in
`(baseEpoch, currentEpoch]` other than the in-flight rotation's epoch; its rows are deleted lazily
here (CS-8: this replaces v2's `meta:orphanRanges`). The response returns each blob as stored
(including `tfp`) and adds `commits:{[e]:EpochCommit}` for the returned epochs; published SDKs read
only `blobs` (`KeyringClient.ts:52-57`).

**`meta:founder`** (critic C6). In `handleMetadataPut`'s first-write branch (`history.ts:23-40`), for
a public Space, when `extractUserContext` yields a username that is neither reserved
(`isReservedServicePrincipal`, `acc/durable-objects/space/members.ts:73-81`) nor `__machine__:*`,
write `meta:founder` once. It counts for `isBridgeHolder`, may seed the keeper during A0a–E, and may
write a new public Space's genesis. It has no rotation or link authority.

**Lazy one-time backfill** (first keyring request while `meta:admissionIndexV1` is absent):

```
legacyKeyedEpoch :=
  0                      if currentEpoch == 0            // every real Space today
  else max({0}
       ∪ { e ≤ currentEpoch : keeper holds keeper:gk:<spaceId>:<e> }   // A0a–E, via POST https://app/keeper/epochs
       ∪ { e ≤ currentEpoch : keyring:<creator>:<e> exists }
       ∪ { e ≤ currentEpoch : keyring:<keeperSeeder>:<e> exists })
```

A blob for any other member is **never** evidence (critic S1: a public user could `/rotate` then plant
`keyring:<self>:1`). If `currentEpoch > legacyKeyedEpoch`, merge `rotateDue {reason:"legacy-epoch-gap"}`;
gap epochs stay readable, no 0.15 client seals at them. Live `joinreq:` rows are copied into
`waiting:` (§4.5.2), skipping rows the §4.5.3 filter would drop. From A0b the same first-touch hook
also runs the service-copy cleanup (§5.5), recorded separately by `meta:svcCleanupV1`, because it
deletes blobs and A0a must not change behaviour. `/keeper/epochs` is best effort (timeout = "holds
nothing") and is deleted at K.

**Keeper seeding A0a–E, without TOFU.** `canSeedKeeper` becomes
`creator ? caller === creator : founder ? caller === founder : seeder ? caller === seeder : false`;
the TOFU write at `keyring.ts:336` is deleted. **connect 0.15 never seeds the keeper** (§11.1 V1):
published SDKs keep seeding until K turns `/api/app/keeper` off.

### 4.2 Rotation

#### 4.2.1 Who may call `POST /keyring/rotate {v:2, ifCurrent, membershipHead}`

| Caller ↓ / state → | Idle | `rotateDue` pending | v2 in flight, not stalled | v2 in flight, **stalled** (`now − rotation.at > ROTATION_STALL_MS`) |
|---|---|---|---|---|
| `isOwner` | allowed | allowed | 409 `{error:"Rotation in progress", rotation}`; `rotation.by` may restart its own | allowed (supersede) |
| other `isKeyHolder` | 403 `"Only the owner can rotate"` | allowed | 409 as left | allowed (supersede) |
| anyone else | 403 | 403 | 403 | 403 |

Checked before any write:
- The Space is log-enabled, else `409 {code:"log-required"}`. A 0.15 client makes a public channel
  log-enabled on open (§3.8) and a private one is migrated by its owner, so this only blocks
  unmigrated private Spaces, whose 0.15 members cannot wrap anyway.
- `member:<caller>.keyCert` present, else `409 {code:"identity-uncertified"}` (server echo of T7).
- `membershipHead` equals `meta:mlogHead`, else `409 {error:"Membership moved", head}`.
- `ifCurrent === currentEpoch`, else `409 {error:"Epoch moved", epoch}`.
- `next = currentEpoch + 1`, always (v2 never creates gaps).

Effects: `currentEpoch = next`; `meta:rotation = {v:2, epoch:next, by, at, prevKeyed:keyedEpoch,
membershipHead}`. Superseding a stalled rotation `R` sets `R.supersededAt` and deletes every
`keyring:<m>:<R.epoch>` listed under `rotwrap:<R.epoch>:*` (bytes-at-rest reduced). A superseded
epoch is never served or wrappable again, because it has no `meta:epochCommit` (§4.1.4, §6.5 row 3).
Response `{epoch, keyedEpoch, linkTargets, superseded?}`.

Public channels have no owner, so they rotate only when owed.

#### 4.2.2 Pre-commit wraps

A wrap at `e > keyedEpoch` is accepted only while a v2 rotation is in flight, `e === rotation.epoch`,
the caller is `rotation.by`, and fewer than `MAX_WRAPS_PER_BATCH` (64) `rotwrap:<e>:*` rows exist.
It stores `keyring:<t>:<e>` plus `rotwrap:<e>:<t>`, sends no frame, fulfils nothing, counts no
holder, and answers `{ok, pending:true}`. These blobs are invisible to their targets until the
commit (§4.1.4). Anything else at `e > keyedEpoch` → `409 "Epoch not established"`.

#### 4.2.3 `POST /keyring/rotate-commit {epoch, ec}`

Accepted when all hold (in this order):
1. A v2 rotation is in flight, `epoch === rotation.epoch`, caller `=== rotation.by`. Else
   `409 {code:"superseded"}` (moved or superseded) or 403.
2. `keyring:<caller>:<epoch>` exists. Else `409 {code:"no-self-wrap"}`.
3. **Copy rule** (CS-8). Another **certified** human member has `holdsVerified(m, epoch)` (§4.1.3), or
   `ec.sole` and either no other certified human member exists or the caller `isOwner`. Service and
   link blobs do not count (neither can admit a human). Else `409 {code:"needs-second-copy"}`. The
   handler lists active members once and uses that list for this rule and for effect 3. Uncertified
   members (published SDK, or inactive since before P) still get a backfill row (effect 3) and are
   admitted when they return on 0.15 (W10).
4. `ec` is consistent: `ec.epoch`, `ec.by === caller`, `ec.prevKeyed === rotation.prevKeyed`,
   `ec.headSeq/headHash === rotation.membershipHead`; `ec.sig` verifies under `ec.ik`;
   `ec.ik === ikbind:<caller>.ik` (SEC4). Else 400. (Bug-catching only; clients verify.)
5. No removal-type entry (§3.5) has `seq > ec.headSeq`. Else
   `409 {code:"membership-removed", head}`: the rotator discards `K` and restarts its own rotation.
   Additions after `ec.headSeq` are fine; the backfill covers them.

Effects, in one request (the DO input gate serialises them):
1. `meta:epochCommit:<epoch> = ec`; `meta:keyedEpoch = epoch`; `rotation.committedAt = now`.
2. Delete `meta:rotateDue` if `rotateDue.epoch < epoch`.
3. **Rekey backfill**: for every active member (humans per §4.1.3, plus enrolled service members)
   other than the caller: no blob at `epoch` → write `waiting:<m> {…, reason:"rekey"}` unless one
   exists; a blob exists → delete `waiting:<m>`. Blob reads use `storage.get([...])` in batches of 128.
4. `meta:keyHolders = {epoch, count}`, counting verified human blobs (§4.5.7).
5. For each `rotwrap:<epoch>:<m>`: unmetered targeted `keyringReady` to `m`; delete the index row.
6. Broadcast `{"epochCommitted":{"epoch"},"timestamp"}` unmetered.
7. Cascade expired and exhausted links (§4.4.8).
8. **Service copies (SEC5).** For every enrolled service member `s` (`agentmember:*`), delete
   `keyring:<s>:<e>` for every `e < epoch` (listed by prefix `keyring:<s>:`); bytes-at-rest reduced.

Response `{ok, keyedEpoch, backfilled}`.

#### 4.2.4 `EpochCommit` (T5)

```
EpochCommit { v:1, spaceId, epoch, prevKeyed, keyCommit, headSeq, headHash, sole, by, ik, at, sig }

keyCommit(e, K) := b64url( HKDF-SHA256( ikm = K, salt = utf8("epoch:" + e),
                                        info = utf8("muhkoo/space/key-commit/v1\n" + spaceId), L = 32 ) )
ecBytes := LP("muhkoo-epoch-commit-v1") ‖ LP(spaceId) ‖ LP(dec(epoch)) ‖ LP(dec(prevKeyed))
         ‖ LP(keyCommit) ‖ LP(dec(headSeq)) ‖ LP(headHash) ‖ LP(sole ? "1" : "0")
         ‖ LP(by) ‖ LP(ik) ‖ LP(dec(at))
sig     := b64 P1363 ECDSA-P256-SHA256(IK_priv of `by`, ecBytes)
```

- HKDF is one-way and domain-separated from the wrap info (`muhkoo/space/keywrap/v1`,
  `con/spaces/SpaceCipher.ts:43`) and the transcript key (§5.4). 32 bytes, not v2-identity's 16:
  a hostile rotator who wants two keys with one tag faces 2^128 work rather than 2^64.
- **Epoch 0 of a new Space**: `ec(0)` travels with the `genesis` entry (§3.6 step 6): `prevKeyed:-1`,
  `headSeq:0`, `headHash = hash(genesis)`, `sole:true`. No `rotate-commit` call is needed.
- Returned by `GET /keyring/blobs/<me>` (`commits`), redeem (`link.commits`) and `GET /keyring/state`
  (`commit`).

#### 4.2.5 Accepting a key (client, replaces `SpaceKeyring.ts:257-278`)

For a log-enabled Space, when any blob is unwrapped (pull, link adoption, the one-time v1 import;
cache entries were checked when first adopted and are AEAD-sealed):

| Epoch | Rule |
|---|---|
| `e ≤ baseEpoch`, `legacyCommits[e]` present and `keyCommit(e, K) === legacyCommits[e]` | Adopt with `legacyKey:true`; eligible for `E*` (§4.2.8). A link's `keyCommits[e]`, when present, must also match. |
| `e ≤ baseEpoch`, `legacyCommits[e]` present, mismatch | Reject, as in the mismatch row below (`reason:"commit-mismatch"`, `key-conflict`) |
| `e ≤ baseEpoch`, no `legacyCommits[e]` | Adopt **read-only** (`legacyKey:true, readOnly:true`): it decrypts history, is never `E*`, is never wrapped to another member or a link, and is never listed in a link's `keyCommits` (SEC3) |
| any `ec(e)` with `e ≤ baseEpoch` | Ignored: no honest flow signs one (v2 rotations start at `currentEpoch + 1 > baseEpoch`); `legacyCommits` governs those epochs |
| `e > baseEpoch` with `ec(e)` | Adopt only if all hold: `ec.headSeq ≤` the verified head (after the §3.7 item 1 re-sync) **and `ec.headHash` equals the hash of this client's verified entry at `ec.headSeq`**; `ec.by` is entitled in the state after that entry (a private member, or a public joined member) with `ec.ik` bound to `by` in the log; `ec.sig` verifies; `keyCommit(e, K) === ec.keyCommit`. **Adopting makes the key available for decryption only; whether this client may seal under it is decided solely by the §4.2.8 sealable rule** (SEC2). |
| `e > baseEpoch` with `ec(e)` whose `headHash` differs from this client's verified hash at `ec.headSeq` | Reject: the key is not adopted, so it is never used to decrypt, wrapped, healed into a link or sealed under. Emit `integrity-error {reason:"commit-fork", epoch}`. Nothing is stored; the signed commit proves the server showed its signer another history. |
| `e > baseEpoch` with `ec(e)` but mismatch | Reject; `POST /keyring/key-conflict {epoch}`; re-request with `reason:"commit-mismatch"`; emit `key-conflict` |
| `e > baseEpoch` without `ec(e)` | Reject (a server-planted epoch). A link blob may instead match the `link` entry's `keyCommits[e]` |

**Replayed commits (SEC2).** A commit signed by a member at a head before that member's removal
verifies, but its `headSeq` is below `lastHumanRemovalSeq`, so it is never a sealable epoch and it
pauses sending until a later rotation commits. No 0.15 client ever seals under it. An honest server
never accepts such a commit: the remove mirror deletes `allow:<m>`, and the private keyring gate
(`keyring.ts:47-53`) then answers 403 to that member's `/rotate` and `/rotate-commit`. Residual: a
removed member colluding with the platform can still deliver messages under keys it held, and clients
decrypt them; it cannot make any 0.15 client seal under such a key.

In a Space that is not log-enabled (legacy, or unmigrated private), keys are adopted as legacy and
the Space reports `legacy-unverified`. The sending epoch is `E*` (§4.2.8), never the highest held blob
(today `:273`).

#### 4.2.6 Stall escape and key conflict

- **Stalled**: a v2 rotation in flight with `now − rotation.at > ROTATION_STALL_MS` (2 min).
  `GET /keyring/state` reports `rotation.stalled:true`; any `isKeyHolder` (a holder of
  `prevKeyed === keyedEpoch`) or the owner may supersede with `ifCurrent`. Nothing waits behind an
  uncommitted epoch: admission continues at `keyedEpoch`. 2 min rather than critic A1's 10 min,
  because a short stall costs only redone work.
- **Key conflict** (a rotator commits `K` but wraps garbage to others): `POST /keyring/key-conflict
  {epoch}` from a member with a `keyCert`, a blob at `epoch`, and `≠ ec.by`. The server writes
  `conflict:<epoch>:<m>`; at `min(2, activeHumans − 1)` distinct reporters with
  `epoch === keyedEpoch` it merges `rotateDue {reason:"key-conflict"}` and broadcasts `rotateDue`.
  A conflict rotation may be run by a holder of `ec.prevKeyed`. A commit is never undone.

#### 4.2.7 SDK rotation (`SpaceKeyring.rotate({ifCurrent?, reason?})`)

**Preconditions** (throw, send nothing): stable identity (`IdentityLockedError`); holds `keyedEpoch`,
or `ec.prevKeyed` for a conflict rotation, or is the private owner (`NotKeyedError` otherwise; SEC3);
server supports v2, i.e. `/keyring/state` exists (`ServerTooOldError`); integrity not broken
(`SpaceTrustError{code:"integrity"}`).

**Pre-check** (CS-8). From `/keyring/roster` (already fetched for targets) and the verified log: if
the rotator has no verified human target, other certified humans exist, and it is not `isOwner`, it
does not call `/rotate`, so no epoch is burned. It emits `rotation-blocked {reason:"no-verifiable-peer"}`
and records `rotationBlocked:{spaceId, reason, headSeq, at}` in IndexedDB `muhkoo.trust`; the same
record is written on `rotation-blocked` after step 4. A recorded Space is retried when the log head
moves, an `admitted` frame names another member, or `ROTATION_BLOCKED_RETRY_MS` (24 h) passes. A
rotation owed by a **human removal** runs the same pre-check but retries on the §4.2.8 triggers
instead of waiting 24 h, because its sends are paused (§11.6 M2).

**Targets**, computed from the verified log at head `H` before calling `/rotate`:
- humans: `MembershipLog.membersAt(H)` (private) or joined members ∩ `roster.active` (public), kept
  only if `IdentityGate.bindingsFor` accepts them. Before `/rotate`, the rotator looks up only the
  ≤ 32 human candidates its pre-commit batch and retries can use (steps 3–4), in one call; the
  background fan-out (step 6) looks up the rest in batches of 64 and stops at the first 429, leaving
  them to the backfill rows (CS-7). Others are skipped with `unverified-member`;
- services: `MembershipLog.activeService` entries, wrapped at the entry's `ecdhPub`;
- links: `linkTargets` for which `MembershipLog.linkLive` holds at `H` (§3.5).

**Steps**:
1. `POST /keyring/rotate {v:2, ifCurrent, membershipHead:H}`. `"Epoch moved"`, `"Rotation in
   progress"` or `"Membership moved"` → `pullKeys()` / re-sync, then return.
2. Mint `K`; compute `keyCommit` and `ec` (signed with the IK via `IdentitySigner`).
3. **One pre-commit batch** (`POST /keyring/wraps`, ≤ 64 items): the self-wrap, up to 8 humans
   (`online` first), every verified service target, up to 16 link targets. Self-wrap fails → discard.
4. `POST /keyring/rotate-commit {epoch, ec}`. `sole:true` only when step 3 had no human target (the
   pre-check guarantees that then no other certified human exists, or the caller is the owner).
   `needs-second-copy` → next 8 humans, ≤ 3 times, then `rotation-blocked` (it will stall and can be
   superseded). `superseded` → discard, `pullKeys()`. `membership-removed` → discard, restart.
5. Adopt `K` (`keys.set`, `epoch = e`), `persist()`.
6. **Background fan-out**: remaining targets in batches of 64, ≤ 2 requests in flight, order:
   services, links, online humans, the rest. Failures are logged, never thrown; the backfill covers
   misses. Agents never rotate.

#### 4.2.8 Sending

- **Sending epoch `E*`** (SEC1). The highest epoch whose key this client accepted **with a
  commitment**: an `EpochCommit` (§4.2.5) or a matching genesis `legacyCommits` entry. Keys adopted
  read-only never count. `head(E*)` is `ec(E*).headSeq`, or the genesis seq (0) when `E* ≤ baseEpoch`.
  On a Space without a log every held key is legacy and `E*` is the highest held epoch
  (`legacy-unverified`); there is no removal to honour there (§11.6 M3).
- **Floor.** The client seals at `E*` only when `E* ≥` the `keyedEpoch` it last saw from the server.
  Otherwise one `pullKeys`; still below → `NotKeyedError` and the Space goes to `waiting` when it does
  not hold `keyedEpoch`, or `rotation-pending` when it holds it only read-only. It never seals at an
  older epoch.
- **Sealable rule** (T8). `E*` is sealable iff it exists, integrity is not broken (§3.7 item 3), and
  `head(E*) ≥ max(S.lastHumanRemovalSeq, hw.humanRemovalSeq)`. The persisted term keeps the rule
  safe when `S` is not current: if the pre-send sync (§3.7 item 1) fails or the client is offline, it
  seals only under this rule with the last `S` it verified, so a removal this device applied in an
  earlier session is still honoured (SEC11).
  `sealMessage` (`con/spaces/Space.ts:776`) checks it before `cipher.seal`; that one check covers
  `sendMessage`, `editMessage` and the offline queue, which stores only frames already sealed
  (`Space.ts:356-374`). When the floor fails, `sealMessage` throws
  `SpaceTrustError{code:"rotation-pending"}`, sets `admission.detail = "securing"` and schedules the
  owed rotation; when integrity fails it throws `SpaceTrustError{code:"integrity"}`, sets admission
  `integrity` and schedules nothing. Nothing is queued unsealed:
  plaintext never reaches IndexedDB. Frames sealed and queued before the removal was seen go out as
  sealed, equivalent to a send made just before the removal. Before a send, a log marked stale by an
  `mlog` frame is synced first (§3.7 item 1).
- **Removal-owed rotation** (the sealable rule fails). `sendMessage` / `editMessage` start the
  rotation (§4.2.7) if none is in flight, wait up to 10 s for its commit, then seal at the new `E*` or
  reject with `rotation-pending`; they never go out at the old epoch. Retries run on the `mlog` frame
  that carries the removal, on `{ready}`, `rotateDue`, `epochCommitted` and `admitted` frames, and on
  a refused send, coalesced to at most one attempt per `REMOVAL_ROTATE_RETRY_MS` (60 s) per Space, each
  behind the §4.2.7 pre-check. A stalled rotation is superseded after `ROTATION_STALL_MS` (§4.2.6).
  The member who signed the `remove` rotates at once: `Space.remove(memberId)` resolves
  `{seq, epoch}` only after that rotation commits, else rejects with
  `SpaceTrustError{code:"rotation-blocked", seq}`; the removal stands, and the Space stays `securing`
  until some member's rotation commits.
- **Other owed rotations never delay a send** (CS-8, §11.6 M1). They are: a service removal
  (`svc remove`, `retire`: `S.lastRemovalSeq > head(E*)`), and `rotateDue` with reason
  `escrow-retired` (when `E* ≤ escrowedThroughEpoch`), `legacy-epoch-gap` or `key-conflict`. The
  rotation starts in the background after the send, behind the §4.2.7 pre-check and
  `rotationBlocked` record; sends go out at `E*` until it commits. The platform already held a removed
  service's key (X6), and escrowed and legacy keys were known to it before; the §5.8 copy says the old
  key stays in use until an app replaces it.
- **`legacy-key`** (SEC3). While `E* ≤ baseEpoch`, `admission.detail = "legacy-key"`: that key existed
  before the Space was upgraded, and the platform may know it. It clears on the first committed
  rotation past `baseEpoch`. 0.15 clients run that rotation on the R signal
  (`rotateDue.escrowRetired`) or when another rotation is owed. Decision 7 keeps it tied to R:
  rotating every migrated Space on its first 0.15 send would cut off published-SDK members and
  transcoder 0.3.9 before gate K4 (§11.3.2 SEC3).
- **G11 wording**: "Messages sent after that Space's first committed rotation past
  `escrowedThroughEpoch` use keys the server never saw."

#### 4.2.9 Rotation obligations and the legacy path

| Source of `meta:rotateDue` | `reason` | Step |
|---|---|---|
| Service unenroll, except `__log__*` (§5.5) | `unenroll`, `removed += [svc]` | A0b |
| Private `remove` / `leave` mirror (§3.6) | `remove` | I (inert until a log exists) |
| Service-copy cleanup (§5.5) | `unenroll` | A0b |
| `/agent/escrow-retired` | `escrow-retired`, `escrowRetired:true` | R |
| Lazy backfill gap (§4.1.4) | `legacy-epoch-gap` | A0a |
| Migration genesis without full `legacyCommits` (§3.6 step 6) | `legacy-epoch-gap` | I (inert until a 0.15 genesis) |
| Key-conflict quorum | `key-conflict` | A0a |

Clients derive removal obligations from the log (§4.2.8), so a server that hides a removal's
`rotateDue` must truncate the log to do so, which the head checks catch (§3.7). The escrow-retired
signal is not derivable from the log: a platform that never sends it leaves the Space on its legacy
key, visible as `legacy-key` (§4.2.8, §1.2).

**Legacy one-phase rotate** (a `/rotate` body without `v:2`, from published SDKs,
`KeyringClient.ts:73-75`): allowed only for `isOwner`, only on a Space that is **not** log-enabled,
with no v2 rotation in flight; `next` as today (`keyring.ts:306-309`); writes `meta:rotation
{v:1, legacy:true}`; the first wrap at `next` by `by` commits it without an `EpochCommit`. On a
log-enabled Space it returns `409 {code:"signed-rotation-required"}`, because 0.15 clients would
refuse an uncommitted epoch (§4.2.5). No app calls `rotate` today, so nothing breaks.

### 4.3 Seed-sealed key cache

- New collection `space-keys-v2/<spaceId>`; the old `space-keys` collection stays for published SDKs
  (`Client.ts:392-395`) and is read once by 0.15 (below).
- `ck = HKDF-SHA256(seed, salt=utf8("space:"+spaceId), info="muhkoo/space/keycache/v2", L=32)`;
  value `{v:2, iv, ct}`, `ct = AES-256-GCM(ck, JSON{keys:{[e]:b64K}, legacy:[e…], readOnly:[e…],
  genesis, headSeq, headHash, humanRemovalSeq, v1Imported?:true}, aad=utf8("space-keys-v2:"+spaceId))`.
- Written with `kv.set(…, {encrypt:false})` because it is already sealed. The server cannot forge an
  entry without the seed; a failed AEAD check is a cache miss. It can replay an older AEAD-valid
  value; the field-wise maximum with IndexedDB (§3.7 item 3) makes that harmless unless IndexedDB was
  lost as well. Needs the unlocked seed, which §3.3
  already requires. The cache is written only when the set of held epochs changes (adoption,
  rotation, import) or a removal-type entry is first applied (§3.7 item 3), never on a head move alone
  (CS-4). A refused or failed write is ignored (the relay blob is the durable copy, §4.5.9); a read
  error is a cache miss. `space-keys-v2/*` is a reserved SDK key class (§6.6a).
- **One-time v1 import (CS-2).** When a Space opens on a stable identity and the sealed cache is
  absent or lacks `v1Imported:true`, the client reads `space-keys/<spaceId>` once (reserved, §6.6a)
  and unwraps each entry with the vault chat ECDH private key. Entries that fail to unwrap (wrapped to
  an ephemeral key by a locked published session) are skipped silently. Each unwrapped `K_e` is offered
  to §4.2.5 exactly as a relay blob would be: on a log-enabled Space it is adopted only for
  `e ≤ baseEpoch` (committed when `legacyCommits[e]` matches, else read-only), never above; on a
  Space without a log, at any epoch as legacy (`legacy-unverified`). If a history packet at `e` is
  already loaded, the key must open it, else that epoch is dropped (no extra request is made). On an
  unlogged Space the import runs before self-escrow and before this client writes a migration genesis,
  so the genesis `legacyCommits` include imported keys (§11.6 M6). Imported epochs then go through the
  ordinary self-escrow (§4.5.9 step 2), and the sealed cache is written with `v1Imported:true`. The
  client never writes or deletes `space-keys`. The import counts as done after any successful read,
  including an empty one; a read error leaves it pending, so a transient failure retries on the next
  open.

### 4.4 Links (invite and standing)

#### 4.4.1 Model and derived secrets

A keyed link is the pseudo-member `__link__:<linkId>` with a P-384 ECDH pair whose private scalar `d`
lives only in the URL fragment. Its blobs are ordinary `keyring:__link__:<linkId>:<e>`
(`WrappedKey`, info `muhkoo/space/keywrap/v1`). Anyone holding `K_e` can re-seal it to the public key
at a new epoch without knowing `d`.

```
d           : 48 random bytes, the P-384 scalar, carried as #lk=<base64url(d)>
ls          : P-256 link-sign key; scalar = HKDF-SHA256(ikm=d, salt=utf8("link:"+linkId),
              info=utf8("muhkoo/space/link-sign/v1"), L=32); public point via @noble/curves p256,
              as con/auth/identity.ts:97-125 does
linkSignPub : b64 rawP256(ls.pub)
ownerWrap   : ECIES seal of d to the minter's chat ECDH key; HKDF info "muhkoo/space/link-owner/v1",
              salt utf8("link:"+linkId), AES-256-GCM, v:1; stored in invite:<token>, returned only
              to createdBy
```

A **membership-only** link (the portal team Space, which carries no messages) still has `d` and `ls`
but `linkEcdhPub:""` and no blobs.

#### 4.4.2 Who may manage links

| | Private Space | Public channel |
|---|---|---|
| Mint | owner (any role); editor (`role:"viewer"` links only). Widened from creator-only (`keyring.ts:319-321`) because an editor may sign viewer membership. | a joined member who `isKeyHolder` (keyed links) |
| Standing link | one per minter (`standing:<m>`) | one per minter |
| List | owner sees all; others their own | own only |
| Revoke | owner any; creator own | creator own |
| `role` | `viewer` / `editor` | normalised to `viewer` |

Caps: `MAX_LINKS_PER_MEMBER` 16, `MAX_LINKS_PER_SPACE` 256 (live links). On a log-enabled Space a
record without `linkSignPub` is not live: it counts toward neither cap, cannot be redeemed
(`409 link-needs-upgrade`, §4.4.4) and is listed with `legacy:true` (AV14). The SDK refuses to mint
without a stable identity (`InviteLinkError("identity-locked")`) or `keyedEpoch`
(`"no-group-key"`).

#### 4.4.3 Mint (`POST /keyring/link`)

Body: `{expiresInSec?, maxUses?, role?, standing?, supersedeStanding?, linkId, linkEcdhPub,
ownerWrap, wrapped:[WrappedKey], entry}` where `entry` is the `link` log entry at `head+1`, signed by
the minter's IK (`sig`) and by `ls` (`lsig`). `keyCommits` covers every epoch in `wrapped`,
**including committed legacy epochs** (which match the genesis `legacyCommits`), so a link joiner
always has a signed commitment to check against. Read-only legacy epochs (§4.2.5) are never wrapped
to a link or listed (SEC3).

Server validation (before any write): `linkId` matches `^[0-9a-f]{32}$` and is unused;
`linkEcdhPub` ≤ 1 KiB and imports (or `""`); `ownerWrap` ≤ 2 KiB; `wrapped` has 1–256 entries with
unique epochs at served epochs ≤ `keyedEpoch` (0 entries when `linkEcdhPub:""`); the entry passes
§3.6 steps 1–4; its body equals the request fields, with `expiresAt` within ±5 min of
`now + expiresInSec`; `keyCommits` has exactly the epochs of `wrapped`; §4.4.2 authority; caps.
Then atomically: `invite:<token>` (today's fields plus `linkId, standing, ecdhPub, linkSignPub,
grantSeq, ownerWrap`), `linkidx:<linkId>`, `standing:<m>` if standing, the blobs, the log entry.
For a standing link that already exists the server returns it (`existing:true`, `ownerWrap`).
A body without `entry` on a public or non-log-enabled Space behaves exactly as today
(`keyring.ts:100-117`); on a log-enabled private Space it gets 409 (§3.6).

#### 4.4.4 Redeem (`POST /keyring/redeem`) — the fragment is required (decision 2; v1 Q2 = no)

Each step returns before any write when it fails.
1. The token record exists and parses (`keyring.ts:147-151`).
2. **v2 record** (has `linkSignPub`): require `entry` — a `redeem {linkId}` (private) or
   `join {via:linkId}` (public) — at `head+1`, with `by` = the session user, `sig` valid under
   `entry.ik`, and `lsig` valid under the stored `linkSignPub`. Missing or invalid →
   `409 {error:"This link needs its key part", code:"link-key-required"}` and **no** `allow:`,
   `member:`, `joinreq:`, `role:`, `uses` or log write. The server holds only `linkSignPub`, so it
   still cannot recover `d`. A record without `linkSignPub` on a log-enabled private Space →
   `409 {code:"link-needs-upgrade"}`. On a private Space, a caller whose `ikbind:<caller>.removedSeq`
   exists gets `403 {error:"You were removed from this space", code:"removed"}`; only an owner's or
   editor's `add` clears it (SEC9). The removal cascade has deleted every link record that predates
   the removal, so step 3 can no longer serve a removed or departed member either.
3. **Idempotency** (critic A8): if `linkuse:<linkId>:<caller>` exists, skip steps 4–5 (no use counted,
   no entry appended) and go to 6. Otherwise lazy expiry (with the §4.4.8 cascade) and the `maxUses`
   check (`:152-156`).
4. `uses += 1`; `linkuse:<linkId>:<caller> = now`; `exhaustedAt = now` when `uses === maxUses`.
5. Append the entry (409 `Log moved` → the client re-previews and re-signs); mirror effects
   (`allow:`, `role:` only if absent); `member:<caller>` per §3.10 with the posted `keyCert`.
6. Response `{ok, joined:true, status:"linked", seq, keyedEpoch, link:{linkId, ecdhPub, blobs,
   commits}}`: every served link blob in a static Space, the newest in a rotate Space; `blobs:[]`
   once `exhaustedAt + LINK_EXHAUST_GRACE_MS` (1 h) has passed. No `waiting:`, no broadcast, no
   keeper call — unless there is no link blob at `keyedEpoch` (stale link), in which case write
   `waiting:<caller> {reason:"link-stale"}` and broadcast an unmetered `joinRequest`.
7. **Legacy record** (no `linkSignPub`, not log-enabled private): today's behaviour plus the
   §4.5.2 `waiting:` rules; the keeper call stays until K.

Published SDKs can redeem only legacy records; a v2 link opened in an old bundle gets a non-2xx,
which `KeyringClient.ts:32-40` throws. That is correct for decision 2.

#### 4.4.5 Joiner unlock (`SpaceKeyring.adoptLinkKeys`)

1. Private: `POST /keyring/redeem-preview {token}` → `{linkEntry, entries, head}`. Public:
   `GET /keyring/log`.
2. Verify the `link` entry's `lsig` under `ls` derived from `d`. The server cannot produce it without
   `d`, so the link entry — and by the hash chain every entry before it back to genesis — is
   authenticated **without TOFU**; pin the genesis in `spaces-v1`. Check the creator's authority at
   the entry's position (§3.5).
3. Import `d` with `x`, `y` from `linkEcdhPub` and check that the pair matches.
4. Build the `redeem` / `join{via}` entry at `head+1`, sign with the IK and `ls`, post the redeem.
5. Unwrap each blob; check `K_e` against `commits[e]`, else the link entry's `keyCommits[e]`; for
   `e ≤ baseEpoch` the genesis `legacyCommits[e]` must match as well (§4.2.5). An epoch with no
   matching commitment is rejected.
6. Self-wrap every adopted epoch in one `/keyring/wraps` batch; `persist()`.
7. Any failure in 2–5 → discard, fall back to `requestKey()` (`waiting`, detail `link-unverified`),
   emit `link-unverified`. If step 4 succeeded the joiner is already a signed member.

#### 4.4.6 Rotation and link heal (critic A6)

- `/rotate` returns `linkTargets:[{memberId:"__link__:<id>", linkEcdhPub, linkSeq}]` for live,
  unexhausted links. The rotator uses them only as a hint and cross-checks each with `linkLive` at
  the verified head (§3.5).
- `GET /keyring/pending` returns `links:[{memberId, linkEcdhPub, linkSeq, missingEpochs}]` (≤ 32)
  **only to `isKeyHolder` callers**: rotate Spaces `[keyedEpoch]` when absent; static Spaces the
  committed epochs up to 16 back that are absent.
- **Link wrap rule** (§6.5 row 4): 404 unless `linkidx:<id>` is live and not exhausted; the epoch is
  served or a pre-commit wrap by `rotation.by`; **create** by any `isKeyHolder` or `rotation.by`;
  **replace** only by the link's creator or the private owner (409 otherwise); no frames, no
  fulfilment.
- The sweep heals `links[]` (§4.5.9 step 5). A hostile holder racing to create a garbage blob is
  detected by the joiner's `keyCommit` check; the creator can replace it; meanwhile joiners wait.

#### 4.4.7 `ownerWrap`, `linkKeyState`, **New link** (critic A9)

`listInviteLinks()` sets `linkKeyState`: `"ok"` (the `ownerWrap` unwraps to a `d` whose public key
equals `ecdhPub`), `"locked"` (identity locked; UI "Sign in again to copy"), `"lost"` (no `ownerWrap`, or it
fails on a stable identity). **New link** on a lost standing link:
`POST /keyring/link {…, standing:true, supersedeStanding:true, entry}` mints a new link, points
`standing:<m>` at it, rewrites the old record with `standing:false` (it stays live), and returns
`supersededToken`; the UI then offers **Revoke old link**. Nothing in the UI revokes a link as a side
effect; v1's "Replace" is removed.

#### 4.4.8 Revoke, expiry, exhaustion, removal

`link-revoke {token, entry?}` (on a log-enabled Space `entry` is a required `unlink`) cascades:
`invite:<token>`, `linkidx:<linkId>`, `standing:<createdBy>` if it points here, every
`keyring:__link__:<linkId>:*`, every `linkuse:<linkId>:*`; bytes-at-rest reduced. The same cascade
runs on lazy expiry, on exhaustion (every `linkuse` member holds a `keyedEpoch` blob, or
`now > exhaustedAt + 1 h`), and on a private `remove` / `leave` for **every** live link, whoever
created it (§3.5 link liveness; critic S8, widened by SEC9). Clients apply the same rules from the
log, so a server that keeps a revoked link alive gets no new wraps to it. Checks run lazily in
`redeem`, `links`, `rotate`, `pending` and commit step 7. A record without `linkSignPub` on a
log-enabled Space is revoked without an entry, by its `createdBy` or the owner (every legacy record
is the owner's, `keyring.ts:100-115`); the cascade deletes only `invite:<token>`, because such a
record has no `linkidx:`, `linkuse:`, blobs or log entry (AV14).

Residual X8: anyone holding a live link's `d` receives future epochs through it until it is
unlinked, its creator is removed, or (private) any member is removed or leaves.

#### 4.4.9 URL and capture

- **v2 link**: `<base>?<app params>#space=<spaceId>&t=<token>&lk=<d>`. The token moves into the
  fragment too (critic S4, optional part), so hosting request logs never see it.
  `parseInviteUrl` reads `space`/`t` from the fragment first, then `space`/`token` from the query
  (legacy links). `lk` is read **only** from the fragment.
- `captureInvite()` stashes `{v:1, spaceId, token, linkKey?, params, capturedAt}` in
  `sessionStorage["muhkoo.invite.v1"]` (30 min TTL) and scrubs the address bar with
  `history.replaceState` (as `con/core/namespaces/HostedAuth.ts` does). Signed-out visitors go through
  `hosted.login({returnTo})`; `handleCallback()` returns `returnTo` (same-origin paths only: start
  with `/`, not `//`). Join routes set `Referrer-Policy: no-referrer` and load no third-party scripts.
- `lk` cannot clash with hosted auth's `#k`, nor with web chat's `/chat#room` (the join route is
  `/join`).

#### 4.4.10 Portal team links (supersedes v1 D17)

A private-Space redeem must carry `lsig` (§4.4.4), so **every** portal team link carries `#lk=` too
(`linkEcdhPub:""`, no blobs). Without it the server, which knows the token, could redeem on anyone's
behalf. The portal therefore needs the same capture/`returnTo` flow as web: `/join` moves outside
`RequireAuth` (`portal/src/App.tsx:96`) and `inviteUrl` (`portal/src/lib/spaceInvites.ts:79-88`) is
replaced by `buildInviteUrl`. Existing keyless team links get `409 link-needs-upgrade` once the team
Space is log-enabled (Q3).

### 4.5 Waiting joiners and the member sweep

#### 4.5.1 Gates before any automatic wrap (decision 10)

1. **Identity** — `IdentityGate.bindingsFor([{memberId, ecdhPub, ecdsaPub, keyCert}])` (batched):
   the `keyCert` verifies under the IK the log binds to the member (a private `add`/`redeem`/`genesis`,
   or a public `join`/`genesis`), and that IK agrees with the `identity-v1` pin (directory check on
   first contact for self-asserted `join`/`redeem`).
2. **Membership** — private: `MembershipLog.isMember(memberId)` at the verified head; public: the
   member has a `join` (or `genesis`) entry.
3. **Service** — `MembershipLog.activeService(memberId)` with the roster keys equal to the `svc` entry
   (decision 8, §5.3).
4. **Integrity** is not `broken`.

A failure wraps nothing and emits `join-request {memberId, verification:"uncertified"|
"pinned-key-changed"|"not-signed-member"|"not-joined"|"enrolment-unsigned"|"lookup-failed"}` (or
`service-member-unverified` for services). **A live `joinRequest` frame is only a trigger**: the new
SDK never wraps to the key inside it (today's behaviour at `Space.ts:760`); it schedules a sweep, and
the sweep reads `/pending`, which carries `keyCert`. A public joiner posts its `join` entry
**before** `join-request`, so a holder triggered by the request finds it in the log sync it makes
before any wrap (§3.7 item 1); when the channel has no log yet, the joiner posts `join` on the first
`mlog` frame (AV10).

**Published SDKs never run these gates** (`Space.ts:754-762`), and a malicious server can send
`joinRequest` frames whether or not the bridge exists. Protection against A1 therefore holds only in
all-0.15 Spaces (X3). Not fixable server-side; the copy says so.

#### 4.5.2 Waiting index (`AdmissionFacet`, `acc/durable-objects/space/admission.ts`)

`waiting:<m> = {memberId, identityEcdhPub, identityEcdsaPub?, keyCert?, ts, reason?:"rekey"|
"link-stale"|"unwrap-failed"|"commit-mismatch", needsReplace?:true, uncertified?:true, unsigned?:true}`.

| Event | Effect |
|---|---|
| `join-request` | §3.10 |
| Legacy (keyless) `redeem` | as `join-request` |
| v2 `redeem` | none, unless the link is stale at `keyedEpoch` (`reason:"link-stale"`) |
| Service enrol (§5.3) | written; `unsigned:true` when the enrolment carries no signed `svc` entry on a log-enabled Space |
| `rotate-commit` backfill | written `reason:"rekey"` for active members missing the epoch; deleted for holders |
| A stored wrap at `e === keyedEpoch` to `m` | deleted (fulfilled); `admitted` broadcast |
| `POST /keyring/join-cancel` | deleted for the caller |
| TTL `JOIN_REQUEST_TTL_MS` (14 d) | skipped and deleted lazily |
| Keeper admit (A0a–E; from K only on `join-request`, through the rescue row) at `keyedEpoch` | Runs **after** the §3.10 decision, wraps to the stored `member:<m>.ecdhPub` (never the posted key), and decides with `keeperAdmitDecision` (below). A write deletes `waiting:<m>` (fulfilled), broadcasts `admitted`, and sends a targeted `keyringReady`. |

A pre-commit wrap does not fulfil (the row would be lost if the rotation were superseded).

`keeperAdmitDecision({mode, via, status, member, memberExisted, blobAtKeyedEpoch, waiting, kind,
keyHolders, logSpace, sessionIk})`, pure, in `acc/durable-objects/space/admission.ts` (CS-1, AV8).
`mode` is the constant `KEEPER_ADMIT_MODE` (`space/consts.ts`): `"escrow"` in builds A0a–E,
`"rescue"` from K (the K deploy flips it with `AGENT_LEGACY_UNADDRESSED`).

| Condition, first match | Result |
|---|---|
| `mode === "rescue"` | **write** only if all hold, else **skip** (no later row is read): `via === "join-request"`; `logSpace` is false (`meta:creator` is not `__log__:*`); `meta:keyHolders` is `{epoch: keyedEpoch, count: 0}`; `memberExisted` (`member:<m>` was stored before this request); §3.10 did not return `refused-uncertified` and `hasCert(m)` holds after it; `member:<m>.keyCert.ik` equals the session IK (§3.6) |
| §3.10 returned `refused-uncertified` | skip |
| `kind` is a service member (`__agent__:*`, `__fn__:*`) | write only if no blob (create-only at enrol, as before) |
| no blob at `keyedEpoch` | write |
| not `hasCert(m)` (legacy member) | write, replacing the blob (today's overwrite) |
| `waiting:<m>.needsReplace` and `waiting.identityEcdhPub === member:<m>.ecdhPub` (§4.5.4 rule 3) | write, replacing the blob |
| otherwise | skip |

The keeper holds only legacy epochs (connect 0.15 never seeds it, §11.1 V1), all of which the server
already knows, so a replace adds no exposure. Certified members are protected by §3.10: an invalid or
missing certificate is never stored over a certified key. A session thief can still point the keeper
at its own key for a **legacy** member until K, exactly as today.

**Rescue (from K, AV8).** The row needs no list: after R the keeper holds rows only for listed
sole-copy Spaces and log Spaces, and between K and R "holds `keyedEpoch`, no verified holder" is the
retire probe's own definition of sole-copy (§8.3 step 2.3). The keeper answers 404 when it holds no
`keeper:gk:<spaceId>:<keyedEpoch>` (`keeper.ts:68-69`), so a Space whose rows R purged is closed with
no flag. A rescue write is a keeper admit: it stores `tfp` (§6.5 row 8) and counts in `keyHolders`
(§4.5.7), so the row stops applying to that Space at that write and the next retire run purges its
rows. It wraps `keyedEpoch` only; every real legacy Space has `currentEpoch 0` (§4.1.4). A stolen
session cannot use it: the certificate must be signed by the account's registered IK, which only the
seed can do. Nothing new is escrowed (`/api/app/keeper` stays retired, `__keeper__` wraps stay 410).

#### 4.5.3 `/pending` filter (critic C2 item 3)

A `waiting:` row is listed in `pending[]` only when it is live, not `__keeper__`, allowlisted in a
private Space, not `uncertified`, not `unsigned`, and some non-self wrap **could fulfil it**: no blob
at `keyedEpoch`, or `needsReplace` with `row.identityEcdhPub === member:<m>.ecdhPub`. Stale rows are
deleted. Uncertified rows appear only in `refused:[{memberId, ts}]` so the new SDK can show "X's new
device is not verified". Published `admitPending` loops (`SpaceKeyring.ts:319-328`) read only
`pending` and therefore never abort on a guaranteed 409.

#### 4.5.4 Replace rule (`canReplaceKeyringBlob`, today `keyring.ts:346-358`)

A caller may replace `keyring:<t>:<e>` when: (1) the caller is `t` (self-escrow, link adoption);
(2) the caller is the private creator (kept; `keyCommit` makes a bad replace detectable);
(3) **`waiting:<t>` is live with `needsReplace` and `waiting.identityEcdhPub === member:<t>.ecdhPub`**
— no time limit (critic C2: a member who waited 11 minutes can still be fulfilled), and reachable only
for the same bound key re-requesting or a certified key change; (4) the legacy `joinreq:` window
(10 min, `consts.ts:43`) for published admitters, reachable only when §3.10 wrote `joinreq:`. A
different key is never a reason to replace unless §3.10 accepted it into `member:<t>`.

#### 4.5.5 Unmetered, targeted protocol frames (critic A4)

`SpaceDO.sendToMember(id, msg, opts?: {metered?: boolean})` and `broadcast(msg, opts?)`
(`SpaceDO.ts:206`, `:220`) skip `pendingMessages++` with `metered:false`. Both parameters are
optional; the class is not renamed; `PersonalSpaceDO` is unaffected. Every §6.4 frame uses it. The
live `joinRequest` (from `join-request`, a stale-link `redeem`, and a signed `enroll`,
`agentControl.ts:76`, metered today) is no longer a plain broadcast (CS-6). It goes to (a) every
socket whose `authUser` is absent or whose session is not marked `certified` — today's broadcast, for
published SDKs — and (b) at most `JOIN_TRIGGER_TARGETS` (3) other sockets, one per user, chosen at
random among up to `JOIN_TRIGGER_SAMPLE` (16) sampled certified users for whom `isKeyHolder` holds. A
session is marked `certified` in its socket attachment at the `{ready}` handshake when `hasCert` holds
for its `authUser`, and when §3.10 stores a `keyCert` for that user; the mark is only an optimisation
(a stale unmarked session merely receives the published broadcast). `keyringReady` goes only to its
target (replacing the broadcast at `keyring.ts:261`);
published SDKs pull only their own blobs, so they lose nothing. Abuse bounds: one join-request
broadcast per member per `JOIN_REBROADCAST_MIN_MS` (60 s); replay at most once per row and at most
`REPLAY_MAX` (20) rows per socket connection (§4.5.6). Wraps are batched (`/keyring/wraps`, 64 per metered request),
against the Free tier's 10,000 requests.

#### 4.5.6 Legacy bridge (permanent)

| Trigger | Condition | Sends |
|---|---|---|
| **N** connect nudge, after `{ready:true}` (`acc/durable-objects/space/wsProtocol.ts:438`) | `isBridgeHolder(authUser)` | targeted `keyringReady` for `keyedEpoch`; updates `lastKeyHolderAt` |
| **T1** `GET /keyring/blobs/<U>` | `isBridgeHolder(U)` | replay to U's sockets |
| **T3** a `spaceMessage` from U (`wsProtocol.ts:473-513`) | allowlisted in a private Space | replay to that socket |

Replay frame `{"joinRequest":{"memberId","identityEcdhPub"},"timestamp","replay":true}`, reading the
§4.5.3-filtered list (services first, then oldest; U's own row excluded), always with the stored
`member:` key. Unsigned service rows and uncertified rows are never replayed. `meta:founder` makes an
old-SDK public-channel creator reachable (critic C6).

**Bound (CP8).** A socket is sent a given `waiting:` row at most once per connection, and at most
`REPLAY_MAX` (20) rows per connection: its attachment keeps `replayed: string[]` (≤ 20 entries, each
the first 16 hex characters of SHA-256(`memberId@ts`) of the row); a new connection starts empty. A
user U with no blob at `keyedEpoch` is sent replays only while `meta:epochCommit:<keyedEpoch>` is
absent: before any 0.15 commit a creator, founder or seeder may hold the key in memory only; after
one it cannot hold it without a blob. A published client's reaction to a replay (one forced roster
GET and one wrap per held epoch, `Space.ts:754-762`, `SpaceKeyring.ts:301-312`) is therefore bounded
by rows per connection, not by time. There is no roster-GET trigger: that GET is the reaction, so it
cannot also be a wake-up.

#### 4.5.7 `keyHolders`, `bridgeHolders`, `lastKeyHolderAt`, `orphaned` (critic A7)

`keyHolders` = `meta:keyHolders.count` when its epoch is `keyedEpoch`: the number of distinct humans
with `holdsVerified(m, keyedEpoch)` (CS-3). Incremented when §6.5 row 8 stores a verified human blob
at `keyedEpoch` whose previous value was absent or unverified, or when §3.10 stores a `keyCert` for a
member whose blob at `keyedEpoch` has a matching `tfp` (CP7); decremented when §3.10 changes the keys
of a counted member, and by `remove`/`leave` of a counted member; recomputed from verified blobs at
commit (effect 3 already reads every active member's blob) and in the lazy backfill.
`bridgeHolders` = members of {creator, founder, keeperSeeder} that are not `isKeyHolder`.
Returned by `join-request` and `/keyring/state`. Joiner state `orphaned` when both are 0 ("No one who
can let you in has been here yet. You'll be let in when a member opens this channel."), else
`waiting` (apps may show "last active …" from `lastKeyHolderAt`).

#### 4.5.8 The joiner's own posts

- `join-request {identityEcdhPub, identityEcdsaPub, keyCert, reason?}` → status and holders (§6.2).
- Public, log-enabled, not yet joined: sync the log and `POST /keyring/log {join}` **before**
  `join-request` (409 → re-sync, ≤ 3 retries). Public with no log yet: post `join` on the first
  `mlog` frame (the genesis) (AV10).
- `reason:"unwrap-failed"|"commit-mismatch"` when a blob at `keyedEpoch` exists but fails; the server
  sets `needsReplace` (§3.10).

#### 4.5.9 The sweep (`SpaceKeyring.sweep(): Promise<string[]>`)

0. `admission === "locked"` or integrity broken → return `[]`.
1. `state = fetchState()`. Not holding `keyedEpoch` → `pullKeys()` (commit-checked). Still not held:
   blob present but failed → `requestKey({reason})`; no blob → `requestKey()` unless live. Return `[]`.
2. **Self-escrow and self-certification** (critic A7, CS-3, CP7). Read `member:<me>` from
   `/keyring/roster`.
   a. If it is absent or shows other keys, post `join-request {identityEcdhPub, identityEcdsaPub,
      keyCert}` first.
   b. **Self-escrow**, only when `member:<me>` now shows my keys: rotate Spaces self-wrap
      `keyedEpoch`, static Spaces every held, served epoch (read-only legacy epochs included: the
      wrap is to myself, §11.6 M7), **whenever my blob there is missing, fails to unwrap, or lacks a
      `tfp` equal to the fingerprint of my own `ecdhPub`** (§4.5.4 rule 1 already lets me replace my
      own blob); one `/wraps` batch. Also run once on open, after the one-time v1 import (§4.3).
   c. If `member:<me>` shows my keys but no `keyCert` whose `ik` is my IK, post `join-request` with
      `keyCert` once per open, after (b). My blob at `keyedEpoch` now exists, so it lands on §3.10's
      "same keys; blob at `keyedEpoch`" row: the certificate is stored, `waiting:<me>` deleted,
      nothing broadcast, status `admitted`. A failure is retried on the next open.
   d. Only then, for an unlogged public channel, write the genesis with `legacyCommits` over my held
      epochs (§3.8). §3.6 step 4's `holdsVerified(by, e)` passes on my own blob and certificate: no
      other member needs to be certified, online, or ever to have opened the channel on 0.15.
3. `p = fetchPending()`.
4. Humans and services in `p.pending`: skip my own `memberId` with my keys (the v1 "admit my other
   devices" clause is **dropped** — devices share the vault-backed pair; critic A2(3)), rows handled
   in the last 60 s, and rows with an `admitted` frame seen. Run §4.5.1 gates in one batched call.
   A row refused for a transient reason (`not-joined`, `lookup-failed`) is kept in memory and
   re-evaluated once, bypassing the 60 s skip: a `not-joined` row on this client's next log sync that
   advances the head, a `lookup-failed` row once the directory's `Retry-After` has passed. The set is
   dropped when the Space closes; no request, frame or stored key is added (AV10).
5. Links in `p.links`: keep only those for which `linkLive` holds (§3.5), then wrap `missingEpochs`.
6. Wrap in ascending epoch order, `keyedEpoch` last: static Spaces every held **non-read-only** epoch
   up to `keyedEpoch`; rotate Spaces, services and links `keyedEpoch` only. Batches of 64, ≤ 2 in
   flight; a 409 item counts as done.

`admit(memberId, ecdhPub)` runs steps 4 and 6 for one target. Triggers: **S1** on becoming keyed
(cache load, `create()`, first successful pull) and inside `reconcile()` (web already calls it,
`web/src/hooks/useChatChannel.ts:298`); **S2** on every `{ready}`; **S3** on a live or replayed
`joinRequest` after 0–1.5 s jitter; after the jitter and before any request or lookup, it re-checks and
skips if an `admitted` frame for that member has arrived (CS-6). S1/S2 coalesce to once per 10 s.
`autoAdmit:false` emits events and wraps nothing.

#### 4.5.10 `create()` order (critic C2 item 2)

`bootstrapNew()` → metadata POST (records `creator` or `founder`) → `connect()` →
`POST /keyring/log {genesis(baseEpoch:-1), ec(0)}` → `requestKey({keyCert})` (writes `member:<me>` and
`waiting:<me>`) → self-wrap epoch 0 (fulfils and deletes `waiting:<me>`) → `sweep()`. Result:
`/pending` is empty, `requestKey` reports `admitted`, and the creator has a recovery blob and
`isKeyHolder`.

#### 4.5.11 Frames the client cannot decrypt yet (critic A5)

In `Space.onRawFrame`, before `decodeFrame`: a packet at an epoch not held with
`epoch ≤ keyedEpoch + 1` is queued in `pendingByEpoch[epoch]` (≤ 200 per epoch, ≤ 4 epochs, 10 min
TTL, oldest dropped) and triggers one coalesced `pullKeys()`. When `pullKeys` accepts epoch `e`, the
queue drains in arrival order. This replaces the silent drop at `Space.ts:834` for live frames;
history pages re-fetch.

#### 4.5.12 Joiner API

`Space.admission: AdmissionState` = `"locked" | "requesting" | "waiting" | "orphaned" | "keyed" |
"not-member" | "identity-mismatch" | "integrity" | "legacy-unverified"`, with
`detail?: "rekey" | "link-unverified" | "key-conflict" | "link-stale" | "not-joined" |
"owner-migration" | "securing" | "legacy-key"` (§11.6 M10):
- `securing` (keyed): a human removal is not yet covered by a committed rotation; sends are refused
  with `rotation-pending` (§4.2.8, SEC1).
- `legacy-key` (keyed): the Space still sends under a pre-upgrade key (`E* ≤ baseEpoch`, §4.2.8,
  SEC3). `securing` takes precedence when both hold.
- `owner-migration` (waiting): a private Space with no log (`GET /keyring/log` → `head:null`); 0.15
  members of such a Space wrap to no one (§3.8), so after K only the owner's migration or a
  published-SDK holder can admit (CS-9).

`onAdmission(h)`, `waitForKey({timeoutMs?, signal?})`, `cancelJoin()`. `join()` still resolves
`Promise<boolean>` at `timeoutMs` (15 s default, as `Space.ts:559-573`) and keeps waiting afterwards
(CS-6). It pulls on a targeted `keyringReady`, an `admitted` naming itself, an `epochCommitted`, and
once per `{ready}` (so each reconnect pulls once). Timer fallback: one pull 2 s after the join request
(covers a wrap stored before the socket was ready), then one pull every `KEY_POLL_MS` (5 min) while the
socket is open **and** the document is visible (`document.visibilityState === "visible"`; non-browser
runtimes count as visible). No timer while hidden, while the socket is closed, or in `orphaned`; in
`orphaned` a `{ready}`, `mlog`, `epochCommitted` or `rotateDue` frame triggers one `/keyring/state` +
pull, coalesced to once per `LOG_SYNC_MIN_MS`. It re-posts when `now > expiresAt − 24 h`. It stops on
key, cancel, 403 (`not-member`), a 4403 close that `/keyring/state` confirms with a 403 (§6.9), or
disconnect. A locked `join()` resolves `false` immediately.

---

## 5. Agents and functions

### 5.0 Today (cited)

| Fact | Where |
|---|---|
| The relay pushes every member message to the app runtime whenever any service member is enrolled (`agentCount > 0`); edits never push | `wsProtocol.ts:503-512` (push `:512`); `agentControl.ts:297-313`; edit path `wsProtocol.ts:538-564` |
| The runtime reads the plaintext keeper key at the packet's epoch and decrypts **every** pushed message before evaluating any trigger | `acc/durable-objects/app/agentRuntime.ts:47-53`, triggers `:64-70` |
| Agent triggers: `mention` (case-insensitive **substring** of the handle), `keyword`, `regex`, `always`; function Space triggers: `keyword`, `regex`, `always` | `acc/services/agentRuntime.ts:39-68` (mention `:49-51`); `acc/services/agentConfig.ts:19`; `acc/services/functionConfig.ts:29` |
| Replies are sealed at the **packet's** epoch | `agentRuntime.ts:68`, `:177` |
| Transcript: plaintext `ChatMessage[]`, read at `:104`, written at `:194`; a non-array breaks `for (const m of transcript)` | `agentRuntime.ts:104`, `:194`; `acc/services/agentRuntime.ts:95` |
| Enrolment writes `member:`, `allow:`, `agentmember:` on an app vouch, then broadcasts `joinRequest` | `agentControl.ts:47-78` (`:69-72`, `:76`) |
| The **agent** vouch checks keys only; the **function** vouch also requires `enabledSpaces ∋ space`. An app-key holder can enrol the app's agent into any Space. | `agentControl.ts:213-218` vs `:222-229` (`:228`) |
| An idempotent re-enrol short-circuits the vouch | `agentControl.ts:186-200` |
| Relay `/agent/*` is reachable from outside as `/api/spaces/:id/agent/*` with scope `ai:infer`; each sub-route authorises itself | `acc/platform/scopes.ts:72`; `SharedSpaceDO.ts:182-184` |
| Enable reads `body.spaceId` for the editor's config Space, but the SDK sends `space` | `acc/platform/controllers/apps/AgentsController.ts:102-104`; `con/core/namespaces/AgentsNamespace.ts:159-164` |
| The portal and CLI call the enable route **directly**, not through the SDK | `portal/src/lib/api.ts:604-616`; `cli/src/commands/agents.js:71-80`; `cli/src/commands/provision.js:238` |
| Delete-agent never unenrols; delete-function does | `acc/durable-objects/app/agents.ts:160-169`; `app/functions.ts:175-181` |
| `postUnenroll` returns `void` and swallows errors | `acc/durable-objects/app/context.ts:154-171` |
| `extractText` falls back to `JSON.stringify(body)`, so file-manifest chunk keys reach prompts and functions | `acc/services/agentRuntime.ts:12-25` (`:22`) |
| `/agent/seal` and `/agent/open` are routed but have no caller | `acc/durable-objects/AppDOv1.ts:119-120`; `app/agents.ts:58`, `:84` |
| Packet headers are scalars; `cid` is already an unsigned cleartext hint outside the signed canonical form | `con/messaging/Packet.ts:11-13`; `Space.ts:783-785` |

### 5.1 Addressing (decision 9)

#### 5.1.1 Wire field `packet.headers.to`

| Property | Value |
|---|---|
| Location | `packet.headers.to`, beside `cid`; outside the ciphertext and the signed canonical form |
| Type / grammar | string; `""`, or 1–8 member ids separated by single spaces, each passing `classifyServiceMember` with kind `agent` or `fn` (`members.ts:24`); ≤ 640 bytes |
| `""` | a 0.15 sender addressed no service member |
| absent | a published-SDK sender ("legacy packet") |
| Signed? | **No.** Every published verifier recomputes the six-field canonical form; signing `to` would fail verification on old clients. Only the relay can change `to` on another member's packet, and it gains nothing: it already holds every enrolled service member's key. `to` is routing policy for honest server code, not a control against the operator. |

Edits carry `to:""` and never trigger (as today). Server-built replies carry no `to` and go through
`/agent/post`, which never pushes (`agentControl.ts:119-133`).

#### 5.1.2 SDK (connect 0.15)

`Space.sendMessage(payload, {channel?, contentType?, to?: string[] | "mentions"})`:
- **Default `"mentions"`**: `text = extractMessageText(payload)` (§5.6 rule); scan
  `/(?:^|[^A-Za-z0-9_@-])@([A-Za-z0-9_-]{1,30})(?![A-Za-z0-9_-])/g`; lowercase, prefix `@`, resolve
  against `serviceMembers()` entries with `kind:"agent"`, `active`, `enrolmentVerified` and equal
  `handle` (normalised as `acc/services/agentConfig.ts:133-134`); dedupe; cap 8; else `""`. A token
  match, stricter than today's substring (`@assistants` no longer fires `@assistant`). An unresolved
  `@token` with a directory older than 60 s forces one `refreshDirectory`.
- **Explicit `to: string[]`**: `@…` resolves as a handle, anything else as a member id; an entry that
  is not an active, verified service member throws `AddressingError{code:"unknown"|"unverified"|
  "inactive"}`; `to:[]` sends `""`. This is how an app sends every message in a room to one agent,
  and its UI must say so.
- Offline sends seal `to` at send time.
- Receive: `SpaceMessageEvent.to?: string[]` (`[]` for `""`, `undefined` when absent), so apps can
  show "shared with @assistant".
- `Space.serviceMembers(): Promise<ServiceMember[]>`, `ServiceMember = {memberId, kind:"agent"|"fn",
  handle?, mode:"addressed"|"all", active, enrolmentVerified, reason?}` (§5.3.6).

#### 5.1.3 Relay filtering

`stampAndRoute` replaces the `stampSource` call at `wsProtocol.ts:503` and returns
`{sealed, epoch, to: string[] | null}`; `stampSource` (`:648`) keeps its signature for edits and
`/agent/post`. A malformed `to` routes as `[]` and logs `log.warn("bad routing header",
{where:"SharedSpaceDO", spaceId})`; the stored packet is never rewritten.

```
maybePushAgentEvent(sealed, route):                      // replaces agentControl.ts:297-313
  if agentCount ≤ 0: return
  if route.epoch ≠ keyedEpoch: return                    ← never forward a packet at any other epoch
  enrolled := agentmember:* rows, excluding __log__*
  mode(m)  := member:<m>.mode ?? (kind(m) = fn ? "all" : "addressed")
  target(m):= m ∈ route.to ∨ mode(m) = "all" ∨ (route.to = null ∧ AGENT_LEGACY_UNADDRESSED)
  targets  := enrolled.filter(target);  if ∅: return     ← the packet never leaves the relay
  keys[m]  := keyring:<m>:<keyedEpoch> for m ∈ targets   (no other epoch is ever read)
  POST https://app/agent/event {spaceId, packetJson, keyedEpoch, legacy: route.to = null,
                                targets:[{memberId, addressed: m ∈ route.to}], keys}
```

`AGENT_LEGACY_UNADDRESSED` lives in `acc/services/agentAddressing.ts`, imported by relay and runtime,
so one deploy flips both: `true` until K, `false` from K.

**Replays (SEC5).** A replay is attributed to whoever re-posts it: the relay stamps `source`
(`wsProtocol.ts:503`) and the runtime uses it (`agentRuntime.ts:57-79`). With the epoch filter above,
the deletion of services' older copies (§4.2.3 effect 8) and the posting gate on private Spaces
(§3.6), a replayer is a member re-sending a current-epoch packet it can already read, which is the
same as typing the text itself. No replay cache is kept.

#### 5.1.4 Runtime (replaces `handleAgentEvent`, `agentRuntime.ts:38-84`)

1. Free-tier gate unchanged (`:44`). A body without `targets` (a pre-A0 relay isolate during rollout)
   is a legacy push while the flag is on, dropped after.
2. Candidates: agent configs with `enabledSpaces ∋ spaceId` in `targets`; live function configs
   (prefix `fn:config:`) likewise. Effective function mode = `min(svc entry mode, config mode)`.
   Dropped **before any decryption** when an agent's target is `addressed:false` and the packet is not
   a legacy packet inside the legacy window, or the effective mode is `addressed` and the target is
   `addressed:false`. None left → `{handled:false, reason:"not addressed"}`.
3. **Epoch guard, then decrypt once** (SEC5). If the packet's `headers.epoch !== body.keyedEpoch`, drop
   it before any unwrap (`{handled:false, reason:"epoch"}`). Otherwise unwrap `K_keyedEpoch` from a
   candidate's own `keys` entry with that candidate's identity (`acc/services/spaceKeyWrap.ts`), and
   open the packet. **A0b–E only**: fall back to `keeper:gk:<spaceId>:<keyedEpoch>` when no candidate
   holds a copy; no other `keeper:gk` epoch is read. Log `log.info("agent group key",
   {where:"AgentRuntime", appId, spaceId, epoch, source})`, `source ∈ member|keeper|none`.
4. `extractText` (§5.6); `null` → nothing fires. Service-source guard stays (`:57`).
5. Agents: addressed → always fires; `matchTrigger` only chooses the skill. Legacy (until K):
   today's `matchTrigger` gate, logged `log.info("agent legacy match", {where:"AgentRuntime", appId,
   spaceId, agentId, fired})`. Functions: mode `all` runs `matchFunctionTrigger` as today; an
   `addressed` trigger fires iff `addressed:true`.
6. Replies sealed at **`keyedEpoch`** with the member's own `keyedEpoch` copy (A0b–E: or the keeper's).
   No copy → skipped, one rate-limited app log per (member, Space, epoch) per hour: "<handle> is
   waiting for a channel member to share the key".
7. Self-heal: a target no config enables here (not `__log__`) → background `postUnenroll`.
8. Transcript (§5.4) only for agent turns that replied.

| Packet | A0a → E | From K |
|---|---|---|
| Legacy, @mention or trigger match for an agent | fires as today (`agent legacy match`) | **agent silent**: not forwarded, never decrypted (gate K3) |
| Legacy, function mode `all` | fires | fires |
| Legacy, function with only `addressed` triggers | does not fire | does not fire |

### 5.2 Key path at execution

v1 §4.1 stands with these changes: keys travel only for `targets`; service members hold `keyedEpoch`
only (wraps below it get `200 dropped`, §6.5 row 5, and older copies are deleted at each commit,
§4.2.3 effect 8, and by the §5.5 cleanup); the relay forwards only packets at `keyedEpoch` (SEC5);
replies seal at `keyedEpoch`; the
keeper fallback lasts through E. At A0a `handleAgentSeal`/`handleAgentOpen` and their routes
(`AppDOv1.ts:119-120`) are deleted. **Invariant** (router test): no platform route forwards to
`https://app/agent/*`. Every relay route added here authorises itself through the app vouch or the
intent handshake (`context.ts:154-180`), generalised from `pendingUnenroll` to an in-memory
`pendingIntents` set of `"<spaceId>|<tag>"` answered by the existing
`GET https://app/agent/unenroll-intent?space=&member=<tag>`.

### 5.3 Signed enrolment (decision 8, with decision 10)

App owners and editors can add agents and functions to **any** Space in their app, private ones
included, and members' apps hand over the key automatically. **There is no space-owner approval
step** (decision 8 overrides critic S2's fix). What changes: the enabler's client signs the addition,
and 0.15 members verify it before wrapping, so the server alone cannot plant a service member.

#### 5.3.1 Trust root: the app owner and `AppRoster`

- **Owner.** `AppRecord` gains optional `ownerUsername` (additive; `app/types.ts`), written at app
  create from the owner's session and backfilled in `resolveConfigAccess`'s owner branch
  (`authorize.ts:84`) when absent. `GET /api/app/trust` (pk-scoped, `messages:read` or `:write`,
  beside `/api/app/keeper` in `acc/platform/routes/appPublic.ts:44-58`) →
  `{appId, ownerUsername|null, roster|null}`. The client pins `ao:<appId>` in `spaces-v1` and the
  owner's IK in `identity-v1` (directory, SpecA §4.1); a later mismatch is a hard fail
  (`app-owner-changed`). Optional build-time anchor:
  `new Client({appKey, trustAnchor:{appId, owner, ownerFingerprint?}})`, written by the app-builder
  template and `muhkoo provision` (Q2). While `ownerUsername` is null, every service member is
  unsigned.
- **Editors.**

```
AppRoster { v:1, appId, seq, owner, ownerIk, editors:[{u, ik}], at, sig }
rosterBytes := LP("muhkoo-approster-v1") ‖ LP(appId) ‖ LP(dec(seq)) ‖ LP(lower(owner)) ‖ LP(ownerIk)
             ‖ LP( concat over editors sorted by lower(u) of LP(lower(u)) ‖ LP(ik) ) ‖ LP(dec(at))
sig := b64 P1363 ECDSA-P256-SHA256(owner IK, rosterBytes)
```

  Stored in AppDOv1 as `trust:roster` (latest) and `trust:roster:<seq>` (history), golden-tested.
  `PUT /api/apps/:appId/trust/roster {roster}` requires an owner session, `seq === stored + 1`,
  `owner === session.username`, **`ownerIk` equal to the owner's registered IK** (the session IK,
  §3.6, carried by `ResolvedSession.ik` in `acc/platform/controllers/session.ts`, KI5; a session without
  it → `503 {code:"identity-context-unavailable"}` with `Retry-After: 60`; else
  `403 {code:"owner-ik-mismatch"}`, SEC4), and a signature valid under `ownerIk`.
  `GET /api/app/trust/roster?seq=n` (pk-scoped). Editors only, never viewers; visible to the app's
  users (Q1). Clients verify the owner signature, `ownerIk` equal to the pinned owner IK, and `seq ≥`
  the `ar:<appId>` high-water (lower = rollback, hard fail).
- **Editors are confirmed by the owner, one by one (SEC6).** The portal computes the candidates: the
  config Space's editors (`authorize.ts:134`) in that Space's **verified** log. When they differ from
  the latest `AppRoster`, it shows **"Review app editors (N changes)"**. The dialog lists each added
  candidate with username, how they became an editor (the entry's seq and signer, or "carried over
  from before the upgrade" for migration `add`s) and `client.trust.safetyNumber(username)`. Added
  candidates are **unticked**; removals are pre-ticked. **Publish** calls
  `client.trust.publishAppRoster(appId, editors)` with the ticked set. No SDK or portal code path
  publishes a roster without that click. A config-Space editor who is not in the `AppRoster` keeps
  editor rights in the config Space, but cannot sign `svc` entries (§5.3.2) or pass the enable
  controller's roster check (`roster-required`); the portal shows them "Waiting for the app owner to
  confirm you as an editor" (CS-9).

#### 5.3.2 The `svc` entry

In the target Space's log (§3.5), body `member, action, ecdhPub, ecdsaPub, mode, rosterSeq`. Valid
when:
- `by` is the pinned owner (`ik` = owner IK; any `rosterSeq`), or an editor with that `ik` in
  `AppRoster(rosterSeq)`;
- `rosterSeq ≥ S.lastSvcRosterSeq` (no backdating within a log);
- `add`: member not active; `ecdhPub`/`ecdsaPub` exactly the strings the relay stores in
  `member:<svc>`; `mode` `addressed` for agents, `addressed`\|`all` for functions (§5.7);
- `remove`: member active.

Members wrap to a service member **only** at the `ecdhPub` of its active `svc add`, and verify its
messages only under that `ecdsaPub`. The handle is not signed (an agent PATCH would otherwise need a
new signature per Space); residual R5.

#### 5.3.3 Enable flow

| Step | Route / call | Notes |
|---|---|---|
| Prepare | `GET /api/apps/:appId/{agents,functions}/:id/enable/prepare?targetSpaceId=&space=` | `authorizeFeature(requireEditor)` as enable. AppDOv1 asks the relay (`POST https://space/agent/enroll-prepare {memberId}`, intent tag `prepare:<memberId>`) → `{memberId, ecdhPub, ecdsaPub, mode, handle?, head:{seq,hash}\|null, genesisHash\|null, visibility, keyedEpoch, rosterSeq, isOwner}` (no `needsGenesis`, SEC3) |
| Sign | `client.agents.enable(appId, agentId, spaceId, {space?})`, `client.functions.enable(…)` | Signs `svc add` at `head+1` with `IdentitySigner`. The signer needs no read access to the Space: its authority is app ownership, and the entry commits to `prev`. Locked → `IdentityLockedError`. |
| Commit | `POST …/enable {targetSpaceId, space?, entry}` | Controller: reads `body.space ?? body.spaceId` (fixes the ignored editor Space); paid tier; `entry.by === session.username`; keys and `mode` equal AppDOv1's (else `409 {code:"enrolment-stale"}`); `sig` valid under `ik`, and `ik` equal to the session IK (§3.6; no `UserAuth` lookup); owner, or an editor in the latest `trust:roster` with `entry.rosterSeq === roster.seq` (else `409 {code:"roster-required"}`). Failures → `400 {error:"Enrolment signature invalid", code}`. A session without `ik` → `503 {code:"identity-context-unavailable"}` with `Retry-After: 60`, never 400 or 403 (KI5). |
| AppDOv1 | `handleAgentEnable` (`agents.ts:171-187`), `handleFunctionEnable` | Adds `enabledSpaces`, stores the index `agent:enrol:<agentId>:<spaceId>` / `fn:enrol:<functionId>:<spaceId>` = `{seq, hash, by, mode, at}`, calls relay `/agent/enroll {memberId, identityEcdhPub, identityEcdsaPub, entry?}`, with an `entry` inside the intent `enroll:<memberId>:<entryHash>` (D8) |
| Relay | `/agent/enroll` | Vouch: `GET https://app/agent/identity/<id>?space=<spaceId>` → `{memberId, ecdhPub, ecdsaPub, handle, mode, enabled}`; **requires `enabled === true`** (the new agent fix, matching functions `:228`); functions add `mode` to `…/identity?env=&space=`. The short-circuit at `:186-200` is removed. Appends `entry` (§3.6 checks, keys equal to the vouch); `409 Log moved` is returned, and the SDK re-prepares (≤ 3). Writes `member:<m> = {ecdhPub, ecdsaPub, agent:true, handle, mode}` (additive), `allow:`, `agentmember:`, `waiting:<m>`. Sends the unmetered `joinRequest` trigger (§4.5.5) **only if** the entry was signed or the Space is not log-enabled. |
| Response | enable | `{config, enrolled, keyed, signed, memberId, ecdhPub, needsSignature?:[{spaceId, reason:"unsigned"\|"space-not-migrated"}]}` |

**Unsigned enable** (published portal/CLI, no `entry`): accepted until E. On a log-enabled Space the
relay writes `agentmember:`/`allow:`/`waiting:{unsigned:true}` but no broadcast, and returns
`signed:false`; 0.15 members never wrap to it and replay never offers it; the keeper bridge
(create-only `keeperAdmit` at enrol, §4.5.2) supplies the key until K. **A Space without a log** — a
private one until its owner migrates it, a public one until a member who holds its key opens it on
0.15 (§3.8) — cannot take an `svc` entry. The SDK sends an **intent** instead: the §5.3.2 `svc add`
entry with `seq:-1` and `prev:""`, signed by the enabler's IK. The controller checks it exactly like a
log entry:
- `sig` verifies under `ik`;
- `ik` equals the session IK (§3.6);
- `by` is the session user;
- keys and `mode` equal AppDOv1's;
- the enabler is the owner, or an editor in the latest roster.

It is never stored or appended. No log position is negative, so it can never be replayed into a log.
The relay enrols the member as an unsigned enable did before E: no `unsigned:true` on a Space without
a log, so the enrol `joinRequest` goes out. The response is `signed:false,
needsSignature:[{spaceId, reason:"space-not-migrated"}]`. Once the Space has a log, this is an
existing unsigned row: 0.15 members wrap to it only after the owner or an editor signs it through the
re-sign banner or `authorize` (§5.3.7). Counted in gate K5. An intent sent for a Space that already has a log is refused with `409 {code:"log-entry-required"}`: that Space takes a real `svc` log entry.

#### 5.3.4 Disable and delete

`POST …/disable {targetSpaceId, space?, entry?}` with an optional signed `svc remove`. Disabling never
requires a signature (a downgraded account must always be able to switch agents off). The relay
appends the entry if valid, otherwise a server-written `retire {member, reason:"unenrolled"}` on a
log-enabled Space (§5.5).

#### 5.3.5 What a 0.15 member checks before wrapping to a service member

Sweep, `admit`, a live `joinRequest` and rotation fan-out alike:
1. An active `svc add` for the member in the verified log, with `ecdhPub`/`ecdsaPub` equal to the
   roster entry byte for byte, and the Space's `genesis.appId` equal to this client's app.
2. `by` resolves per §5.3.2 against the pinned owner and a verified `AppRoster`.
3. No later `svc remove` or `retire`.
4. `active` in the roster.

Failure → no wrap, `service-member-unverified {memberId, reason:"unsigned"|"bad-signature"|
"not-authorised"|"removed"|"key-mismatch"|"lookup-failed"}`. **Always on in 0.15**, public and private
alike, independent of any server flag (a server switch would let A1 turn it off). 0.15 never wraps to
`__keeper__` (§11.1 V1). Agent replies verify against the `svc` entry's `ecdsaPub` (§3.9).

#### 5.3.6 Directory entries

`ServiceMember.enrolmentVerified` / `reason` are §5.3.5's result. Mention resolution (§5.1.2) considers
only verified entries, so a planted agent can never be addressed.

#### 5.3.7 Existing enrolments, portal and CLI

- Existing enrolments have no signature and the server cannot create one. The `agents-e2e` report
  lists `enrolments.unsigned:[{memberId, spaceId}]`; `GET /api/apps/:appId/agents` and `…/functions`
  add `enrolments:{[spaceId]:{signed, seq?, by?}}` from the AppDOv1 index.
- `client.agents.authorize(appId, agentId?)` / `client.functions.authorize(…)` sign an `svc add` for
  every `enabledSpaces` entry whose log lacks one. Portal banner: **"Confirm agents and functions
  (N need your signature)"**; CLI `muhkoo agents resign <appId>` / `muhkoo functions resign <appId>`.
- **The portal and CLI must switch to the SDK** for enable/disable (today they POST directly,
  `portal/src/lib/api.ts:604-616`, `cli/src/commands/agents.js:71-80`, `provision.js:238`). The CLI
  signs with the device-factor identity; the portal sends a locked owner through hosted sign-in with
  `returnTo` (§7.2, CS-5).
- A function whose triggers widen from `addressed` to `all` keeps its signed mode at the relay until
  re-signed; the update response gains `resignRequired:[spaceId]`.

#### 5.3.8 Why every Space, not only private ones

Signed enrolment is the only thing binding an agent's roster keys to the developer. Without it the
server could relabel any member as "the app's agent" in a public channel and draw @mentions to it.
The cost is the one-time re-sign. (v2-agents Q1 and v2-identity §7.3 agree; resolved, not open.)

#### 5.3.9 Residuals (security notes, not marketing copy)

| # | Residual |
|---|---|
| R1 | Published SDKs wrap to any `joinRequest` the server sends (`Space.ts:754-762`); the guarantee holds only in all-0.15 Spaces (X3). Step P moves first-party apps; third-party apps are named at gate K3/K5. |
| R2 | The app owner is TOFU without `trustAnchor` (X1). |
| R3 | A removed service member cannot be re-added by replaying its old entry (the log pins position); a server can only show a client a fork (X4). This supersedes v2-agents' pinned removal-seq scheme. |
| R4 | An editor's signatures stay valid after the editor loses the role; removing the service member revokes. An ex-editor colluding with the server can backdate within the monotonic `rosterSeq` rule (Q5). |
| R5 | Handles are unsigned: a server can misroute a mention only between already-verified service members. |
| R6 | A stolen owner or editor session can enable unsigned service members until E (keyed by the keeper in legacy-keyed Spaces until K), and can always change an enrolled member's code, tools or prompt (X10). |
| R7 | **Closed in step I by the entry-bound intent (D8).** What it was: while AppDOv1's `enroll:<m>` intent was pending (§5.3.3's D8 window), a caller who only holds the app's publishable key could race the same DO and append an `svc add` for `<m>` with the public keys but arbitrary `by`/`ik`/`rosterSeq`. That either raised `S.lastSvcRosterSeq` (blocking the pending signed entry behind §5.3.2's "no backdating" floor) or left an entry 0.15 clients reject outright — a per-Space denial of service against that agent until A0b's `svc remove` cleared it. It was first accepted as a residual of D8/D27. The intent tag now names the exact entry: `enroll:<m>:<entryHash>`, the hash of the entry the enable controller verified, which the relay recomputes from the entry it received. Any other entry for `<m>` matches no pending intent and is refused `403 internal-op` before anything is written. |

### 5.4 Transcript at rest: addressed turns only, sealed

The key `agent:transcript:<agentId>:<spaceId>` does not change (golden in `tests/app-keys.test.ts`).

| Build | Writes | Reads |
|---|---|---|
| **A0a** (reader only) | plaintext array, as today | array → use; **any non-array → `[]`**, reply still posted |
| **A0b → E** | `{v:1, epoch, iv, ct}` | array → delete, start empty; `v:1` at an epoch in `keys` → open; else `[]` |
| **K on** | `{v:2, epoch, iv, ct}`, addressed turns only | `v:2` at a held epoch → open; `v:1` or array → delete, start empty; else `[]` |

```
tk = HKDF-SHA256(ikm = K_epoch, salt = utf8("epoch:"+epoch),
                 info = utf8("muhkoo/agent/transcript/v"+n+"\n"+agentId+"\n"+spaceId), L = 32)
ct = AES-256-GCM(tk, iv = 12 random bytes,
                 aad = utf8("agent:transcript:"+agentId+":"+spaceId+"|v"+n+"|"+epoch),
                 pt  = utf8(JSON.stringify(ChatMessage[])))
```

Writes reseal at the reply's `keyedEpoch`; each turn ≤ 4,000 characters; 20 turns
(`acc/services/agentRuntime.ts:204-208`). Resets at each epoch boundary (deliberate) and once at K.
Retention unchanged (deleted on disable and agent delete, `agents.ts:166`, `:203`). A0a exists because
a pre-A0 reader hands `{v:1}` to `for (const m of transcript)` (`acc/services/agentRuntime.ts:95`),
which throws, so every agent that replied after A0b would go mute after a rollback: **A0b rolls back
to A0a only** (critic C3).

### 5.5 Removal rotates the key

**Unenroll** (extends `agentControl.ts:97-114`; body `{memberId, entry?}`), after the existing
deletes of `agentmember:` and `allow:`:
1. Delete every `keyring:<svc>:*` and `waiting:<svc>`; subtract bytes. Keep `member:<svc>` so old
   signatures verify.
2. Log-enabled: append the valid `svc remove` from the body, else `retire {member,
   reason:"unenrolled"}`.
3. Unless `__log__*`: merge `meta:rotateDue {epoch: currentEpoch, reason:"unenroll", removed += svc}`;
   unmetered `rotateDue` broadcast.
4. Return `{ok, unenrolled: wasEnrolled}`.

`postUnenroll` returns `Promise<boolean>` (`res.ok` and body `ok`); disable and delete responses gain
`unenrolled`. **Delete-agent fix**: `handleDeleteAgent` (`agents.ts:160-169`) reads the config and
`postUnenroll`s every `enabledSpaces` entry before deleting (as functions already do).

**Cleanup of copies left by earlier removals (critic S5).** Disabled-but-not-deleted agents still have
working `keyring:<svc>:*` rows and those Spaces never got `rotateDue`.
- **Explicit pass at A0b**: relay `POST /agent/svc-cleanup {dryRun}` (intent tag `__svc_cleanup__`).
  For each distinct `<svc>` among `keyring:__agent__:*` / `keyring:__fn__:*` (split at the last `:`)
  with no `agentmember:<svc>`, excluding `__log__*`: delete rows, subtract bytes, merge `rotateDue`,
  append `retire` on log-enabled Spaces; return `{blobsDeleted, members, rotateDueSet}`. The per-app
  migration calls it for every Space id in the union of `keeper:gk:*` rows, `channel:{live,test}:*`,
  every config's `enabledSpaces`, and `agent:transcript:*:<spaceId>` keys.
- **Lazy pass** from A0b, on the first keyring access to a Space (the §4.1.4 hook), recorded by `meta:svcCleanupV1`.
- Both passes also delete `keyring:<s>:<e>` with `e < keyedEpoch` for **enrolled** service members
  (SEC5); `blobsDeleted` counts them. From then on, effect 8 of every commit (§4.2.3) keeps service
  members at `keyedEpoch` only.

**Why a member client rotates, not the server**: a server-minted key would be known to the server,
defeating both the rotation and decision 1.

### 5.6 `extractText` (`acc/services/agentRuntime.ts:12-25`)

A string body returns the string; otherwise the first string among `contents`, `text`, `content`;
otherwise **`null`** (nothing fires; the body is never serialised). `tests/agent-runtime.test.ts:28`
(`'{"a":1}'`) changes to `null`. connect exports the same rule as `extractMessageText` for the
mention scan. Changelog: structured bodies no longer reach functions.

### 5.7 Functions

- `FunctionTriggerType` (`acc/services/functionConfig.ts:29`) gains `"addressed"` (no pattern). Config
  mode is `addressed` when every Space trigger is `addressed`, else `all` (default and existing
  behaviour: **decrypts every message**, decision 9). A pre-A0 runtime ignores the unknown type (the
  switch has no default), so a rollback makes such a function silent, never broader.
- Functions have no handle; they are addressed with explicit `to` using ids from `serviceMembers()`.
- Payload (`buildSpaceEventPayload`, `acc/services/functionRuntime.ts:77`) gains `addressed: boolean`
  (additive); sent only for text bodies.
- Unwrapped with `fn:identity:<id>` (live), already the dispatch identity.
- **Refuse** Space enablement for `env=test` (`app/functions.ts:201`): the runtime evaluates live
  configs only, so such a function would silently never run.

### 5.8 Product copy (decisions 8, 9, 11)

For `docs` (`reference/agents.mdx` "Privacy model", `patterns/agents.mdx`, `reference/functions.mdx`,
`patterns/functions.mdx`, `concepts/spaces.mdx`) and the portal Agents and Functions cards. No
infrastructure brand names (CLAUDE.md).

> **Who can add one.** An app's developer — its owner, or an editor they appointed — can add an agent
> or a function to any Space in the app, including private Spaces. Members are not asked. The
> developer's app signs each addition, and members' apps check that signature before they give the
> agent or function the Space's key. So Muhkoo's servers cannot add one on their own, provided everyone
> in the Space uses an up-to-date app and the app knows its developer's identity (built in, or learned
> from Muhkoo the first time it is used).
>
> **What an agent reads.** An agent is a member with its own key, but it decrypts only messages
> addressed to it: messages that @mention it, or that the app sends to it directly. Muhkoo's servers
> can see which messages were addressed to the agent, and in a public channel so can anyone using the
> app. They do not decrypt the other messages for it. The agent remembers only the messages addressed
> to it and its own replies, and that memory is stored encrypted.
>
> **What a function reads.** A function that responds to messages decrypts every message in the
> Space, so it can decide whether to respond, unless it is set to respond only to messages addressed
> to it.
>
> **Where the text goes.** The text of each message an agent or function decrypts is passed to the AI
> model (for an agent) or to the developer's function code (for a function). That code can store it,
> for example in the app's database. An agent can also save the text, or pass it to the developer's
> functions, through the tools the developer gives it (for example, writing to the app's database).
> Files are never passed on.
>
> **What this is not.** While an agent or function is a member, the platform holds its key. The
> limits above describe how Muhkoo's software behaves; the encryption does not enforce them. If the
> Space keeps full history, the key also opens messages sent before the agent was added. For apps that
> Muhkoo hosts, Muhkoo also serves the app's code, so these checks assume that code is the
> developer's.
>
> **Removing one.** Removing an agent or function deletes its copies of the key and asks members' apps
> to replace the Space's key. Messages sent after that replacement cannot be read with the removed
> member's key. Until a member's app replaces it, the old key stays in use, and in a Space where every
> member uses an older app version it is never replaced.

**Never claim**: that "the platform cannot read" a Space with an agent or function, or that it is
"server-blind"; "decrypted only while it runs", "only in memory", "content never leaves memory"; that
an agent "reads every message" (false from K); that "only mentions" is enforced by encryption; that
"a function only sees messages that match"; that only the AI model sees the text; "verified against
the developer's ZK identity" (it is TOFU); "Muhkoo cannot add an agent to your Space" without the
up-to-date-app qualifier; "only the Space owner can add an agent"; "removal is immediate" or "revokes
past messages"; "enabling exposes only future messages"; "files are shared with the AI".

**Guard**: `docs/scripts/check-claims.mjs` in the docs `prebuild` fails on case-insensitive
`decrypted only while it runs`, `only in memory`, `never leaves memory`, `server-blind` within 200
characters of `agent`/`function`/`log`, `cannot read` in `reference/agents.mdx`, `decrypts every
message` within 200 characters of `agent`, **`only the AI model` within 200 characters of `agent`**,
and **`cannot add` within 60 characters of `agent`, `function` or `one` unless `up-to-date app`
appears within 200 characters** (SEC7). The same list runs as a grep step over app-builder skill docs
and the web and portal copy strings. `docs/scripts/check-claims.test.mjs` (new): a fixture with each
forbidden phrase fails; the copy above passes.

**Timing.** The "members only" half of the private-Space routing claim depends on the §3.6 `/history`
gate, which ships in I; D ships after K, so the claim is true when the copy ships. The D row in §8.1
carries the probe.

### 5.9 Theater `@scanner`

Today theater and the separately published transcoder (`0.3.9`, pinning connect `0.10.11-alpha.0`,
`theater-transcoder/package.json:3`, `:28`) post `@scanner scan …` to the public `scanner` channel; the
transcoder falls back to `createChannel("scanner")` when joining fails
(`theater-transcoder/src/worker.js:183`). The channel was seeded by a throwaway user; after K nobody
reliably holds its key.

1. **`scan` function** in `theater/spec.base.json`: HTTP trigger, user session required,
   `media.owner` must equal the caller's commitment, title cleaned with `MUHKOO_AI`, then the existing
   `search-tmdb` lookup.
2. **Theater**: `requestScan` → `client.functions.invoke({name:"scan", slug}, {body:{mediaId, file}})`.
3. **Transcoder 0.4.0**: connect 0.15; same `requestScan`; **drop the `createChannel("scanner")`
   fallback**; fix the "always-online keeper" comment (`src/client.js:4-5`); README/CHANGELOG
   "versions before 0.4.0 lose poster enrichment after <K date>". `npm publish` is a production
   action (Matt asks).
4. **Retire without deleting** at K: disable `@scanner` on `scanner` (unenrol, copies deleted) and
   **keep `channel:live:scanner`**, so old clients resolve it, fail to get a key and skip enrichment
   (fail closed) instead of recreating a user-owned channel. Delete `scanner-admin.mjs create`;
   rewrite `test` to call `scan`. Delete the `@scanner` config only after R.

---

## 6. Server and SDK reference

**New fields are in bold.** Old clients ignore unknown response fields. The "Step" column is the
release step that ships it (§8). New keyring and log sub-routes inherit `messages:read` /
`messages:write` (`acc/platform/scopes.ts:73`); no scope-table change. New platform routes are added
to the ordered table in `acc/platform/router.ts` and their positions pinned in
`tests/platform-router.test.ts`.

### 6.1 Platform routes

| Route | Change | Step |
|---|---|---|
| `POST /api/auth/identity` **new** (SpecA §4.1, amended by CS-7) | `{username}` → `{identityKey}` (unchanged), or **`{usernames:[1–64]}` → `{keys:{[lower(u)]: identityKey}}`**; b64 raw, stored hex normalised; a deterministic decoy for each unknown name. **Own rate-limit bucket, one hit per call:** `rl:idl:user:<lower(session username)>` `IDLOOKUP_USER_LIMIT` (120) per `RL_WINDOW_MS`, and `rl:idl:ip:<ip>` `IDLOOKUP_IP_LIMIT` (600); a call without a session uses only `rl:idl:ip:<ip>` at `IDLOOKUP_ANON_IP_LIMIT` (30). Never keyed by a looked-up name; never reads or writes `chal:*`. 429 with `Retry-After`. Constants beside `acc/durable-objects/userAuth/rateLimit.ts:12-17`; the handler reuses `rateAllow` (`:31-42`). | I |
| `GET /api/app/trust` **new** (pk; `messages:read`\|`:write`) | → `{appId, ownerUsername\|null, roster\|null}` | I |
| `GET /api/app/trust/roster?seq=` **new** (pk) | → `{roster}`; 404 | I |
| `PUT /api/apps/:appId/trust/roster` **new** (owner session) | `{roster}` → `{ok, seq}`; 403 not owner; 403 `owner-ik-mismatch`; 409 seq | I |
| `GET /api/apps/:appId/{agents,functions}/:id/enable/prepare` **new** (editor gate) | `?targetSpaceId=&space=` → prepare body (§5.3.3) | I |
| `POST /api/apps/:appId/{agents,functions}/:id/enable` | body **`space?` read (fix), `entry?`** → **`enrolled, keyed, signed, memberId, ecdhPub, needsSignature?`**; 400 `Enrolment signature invalid`; 409 `enrolment-stale` / `roster-required` / `Log moved`; an unlogged Space → `needsSignature:[{reason:"space-not-migrated"}]`; **from E: 400 `enrolment-required` without a verifying `entry` (a log entry, or an intent on a Space without a log)** | I (entry), A0b (`keyed`), E (required) |
| `POST …/disable` | **`unenrolled`** (A0a); **`entry?`**, a signed `svc remove` appended through relay `unenroll` (A0b). Step I reads `space ?? spaceId` and ignores an `entry` (step-I plan D18) | A0a, A0b |
| `DELETE /api/apps/:appId/agents/:id` | unenrols every `enabledSpaces` entry first → **`unenrolled`** | A0a |
| `GET /api/apps/:appId/{agents,functions}` | **`enrolments:{[spaceId]:{signed, seq?, by?}}`** | I |
| `PATCH` function config | **`resignRequired?:[spaceId]`** | A0a |
| `GET /api/app/keeper` (`appPublic.ts:44-58`) | K: `200 {pubkey:null, retired:true}`, kept forever; published `createChannel` then skips seeding silently (`SpaceNamespace.ts:188-190`) | K |
| `POST /api/admin/accounts/:c/apps/:appId/agents-e2e` **new** (ADMIN_API_KEY; precedent `AdminController.ts:121-123`) | `{dryRun}` → report (§8.3) | A0b |
| `POST /api/admin/accounts/:c/apps/:appId/keeper-retire` **new** | `{dryRun, acceptSoleCopy?: string[]}` (Space ids; no blanket form, CS-3) → report; a real run before K → `409 {code:"keeper-still-on"}` | A0b (dry run), R |

### 6.2 Relay routes (`/api/spaces/:id/…`)

| Route | Request | Response | Errors | Step |
|---|---|---|---|---|
| `GET /websocket` (upgrade) | ticket; + query `refuse=close` (0.15) | log-enabled **private** Space: an upgrade without a ticket username, or whose user has no `allow:`, is refused before the upgrade (401/403); with `refuse=close` it is accepted and then closed `4403 "not-member"`. No backlog either way (§3.6, D31) | — | I |
| `GET /history` | unchanged | unchanged | log-enabled **private** Space: no user context → `401`; a user without `allow:` → `403 {error:"Not a member of this private channel"}` (§3.6) | I |
| `GET /metadata` | — | + **`keyedEpoch, rotateDue:{epoch, escrowRetired?}\|null, escrowedThroughEpoch`** (no member ids: ungated, `SharedSpaceDO.ts:159-163`) | — | A0a |
| `POST /metadata` | unchanged | unchanged; writes **`meta:founder`** (public) | — | A0a |
| `GET /keyring/log` **new** | `?since&limit≤500` | `{entries, head\|null}` | private gate 403 | I |
| `POST /keyring/log` **new** | `{entry, ec?}` | `{ok, head}` | 400; 403 authority; 403 `identity-bound`; 403 `identity-not-registered`; 403 `internal-op` (`svc`, `retire`); 409 `{error:"Log moved", head}`; 409 `base-epoch-mismatch`; 503 `identity-context-unavailable` | I |
| `POST /keyring/redeem-preview` **new** | `{token}` | `{linkEntry, entries, head}` | 404/403 as redeem | I |
| `POST /keyring/join-request` | + **`keyCert?, reason?:"unwrap-failed"\|"commit-mismatch"`** | `{ok,` **`status:"waiting"\|"admitted", keyChange?, ts, expiresAt, keyedEpoch, keyHolders, bridgeHolders, lastKeyHolderAt`**`}` | 403 private; 503 `identity-context-unavailable` | I (stored), A0b |
| `POST /keyring/join-cancel` **new** | `{}` | `{ok, cancelled}` | private gate | A0a |
| `GET /keyring/pending` | — | `{pending:[{memberId, identityEcdhPub,` **`identityEcdsaPub?, keyCert?, ts, reason?, needsReplace?`**`}],` **`refused:[{memberId, ts}], links:[…], keyedEpoch`**`}` | `links` only for `isKeyHolder` | A0b |
| `POST /keyring/wrap` | unchanged | `{ok,` **`fulfilled?, dropped?, pending?`**`}` | 409 `Epoch not established` / `Epoch abandoned` / replace; link 403/404/409; `__keeper__` 410 from K | A0b |
| `POST /keyring/wraps` **new** | `{fromMemberId, wraps:[{targetMemberId, wrapped}]}` (1–64) | `{results:[{targetMemberId, epoch, status, ok, fulfilled?, dropped?, pending?, error?}]}` | 400 malformed; each item runs §6.5; one metered request | A0a |
| `POST /keyring/rotate` | `{nextEpoch}` (legacy) or **`{v:2, ifCurrent, membershipHead}`** | `{epoch,` **`keyedEpoch, linkTargets, superseded?`**`}` | §4.2.1; legacy on log-enabled 409 `signed-rotation-required` | A0a (v2), A0b (legacy owner-only) |
| `POST /keyring/rotate-commit` **new** | `{epoch, ec}` | `{ok, keyedEpoch, backfilled}` | 400; 403; 409 `superseded`/`no-self-wrap`/`needs-second-copy`/`membership-removed` | A0a |
| `POST /keyring/key-conflict` **new** | `{epoch}` | `{ok, reporters, due}` | 403; 409 not `keyedEpoch` | A0a |
| `GET /keyring/state` **new** (gated) | — | `{currentEpoch, keyedEpoch, rotateDue, rotation:{epoch, by, at, stalled, committed}\|null, commit\|null, membershipHead\|null, keyHolders, bridgeHolders, lastKeyHolderAt, conflict}` | private gate | A0a |
| `GET /keyring/blobs/:m` | **`?pending=1`** | `{blobs,` **`commits`**`}` (§4.1.4 filter; blobs as stored, with **`tfp`**) | 403 as today | A0a |
| `GET /keyring/roster` | — | entries + **`active, online, keyCert?, handle?, mode?`** | — | A0a |
| `POST /keyring/link` | legacy body, or + **`standing?, supersedeStanding?, linkId, linkEcdhPub, ownerWrap, wrapped, entry`** | + **`linkId, standing, existing, ownerWrap?, supersededToken?`** | 400; 403 §4.4.2; 409 `Log moved`; 409 `signed-membership-required` | I/A0a |
| `GET /keyring/links` | — | + **`keyedEpoch`**; links + **`linkId?, standing?, keyed?, epochs?, ownerWrap?, exhaustedAt?, entrySeq?, legacy?`** | own links only (§4.4.2) | A0a |
| `POST /keyring/link-revoke` | + **`entry?`** (`unlink`; required on a log-enabled Space for a record with `linkSignPub`) | `{ok}` | §4.4.8 cascade | A0a |
| `POST /keyring/redeem` | + **`keyCert?, entry?`** (`keyed` ignored) | + **`status?, seq?, keyedEpoch?, link?:{linkId, ecdhPub, blobs, commits}`** | 409 `link-key-required` / `link-needs-upgrade`; 403 `removed` (private, §4.4.4); 503 `identity-context-unavailable`; 403/404 as today | A0a |
| `POST /keyring/invite`, `/keyring/role` | unchanged | unchanged | 409 `signed-membership-required` when log-enabled | I |

### 6.3 Internal Durable Object routes

| Route | Change | Step |
|---|---|---|
| UserAuth `POST /verify` | + `ecdsaPublicKey` (from the session record; SEC10) | I |
| Platform `resolveUserContext` → `X-Muhkoo-User-Context` | + optional `ik` (b64 raw P-256; §3.6) | I |
| Platform `resolveSession` (`acc/platform/controllers/session.ts`) → `ResolvedSession` | + optional `ik` (the `/verify` `ecdsaPublicKey`, normalised by the §3.6 rule), read by the roster PUT and the enable controller (KI5) | I |
| AppDOv1 `POST /agent/event` | body `{spaceId, packetJson, keyedEpoch, legacy, targets, keys}` (no `packetEpoch`: only `keyedEpoch` packets are forwarded, SEC5); tolerates the old body | A0a (tolerant), A0b |
| AppDOv1 `GET /agent/identity/<id>?space=` | + `handle, mode, enabled` | A0a |
| AppDOv1 `GET /functions/<id>/identity?env=&space=` | + `mode` | A0a |
| AppDOv1 `GET /agent/unenroll-intent?space=&member=<tag>` | answers any `pendingIntents` tag (`<memberId>`, `prepare:<memberId>`, `enroll:<memberId>:<entryHash>`, `__keeper__`, `__svc_cleanup__`) | A0a |
| AppDOv1 `POST /agent/seal`, `/agent/open` | **deleted** (`AppDOv1.ts:119-120`) | A0a |
| AppDOv1 `POST /agent/migrate-e2e` **new** | `{dryRun?}` → `{transcriptsPurged, reenrolled, enrolments, svcCleanup}` | A0b |
| AppDOv1 `POST /keeper/epochs` **new** | `{spaceId}` → `{epochs}` | A0a; deleted at K |
| AppDOv1 `POST /keeper/ingest` | **deleted** (`AppDOv1.ts:99-100`) | K |
| AppDOv1 `POST /keeper/admit` | unchanged; from K called only by the relay's rescue row (§4.5.2); reads only kept `keeper:gk:*` rows | kept |
| AppDOv1 `GET /keeper/pubkey` | `{pubkey:null, retired:true}`; never mints (today `keeper.ts:16-23` mints when absent); writes the tombstone lazily | K |
| AppDOv1 `POST /keeper/retire` **new** | `{dryRun, acceptSoleCopy?: string[]}` → `keeper:retired` shape + `soleCopySpaces`, `spacesWithServiceMembers`, `unmigratedPrivateWaiting`, `unloggedPublicWaiting` | A0b (dry run), R |
| relay `POST /agent/enroll` | + `entry?` (no genesis, SEC3) → + `keyed, signed`; vouch requires `enabled`; no short-circuit | I (entry), A0a (vouch fix), A0b (`waiting:`, keeper bridge) |
| relay `POST /agent/enroll-prepare` **new** | `{memberId}` (intent `prepare:<memberId>`) → `{head, genesisHash, visibility, keyedEpoch, lastSvcRosterSeq}` | I |
| relay `POST /agent/unenroll` | + `entry?` → `{ok, unenrolled}`; §5.5 cleanup | A0b |
| relay `POST /agent/svc-cleanup` **new** | `{dryRun}` (intent `__svc_cleanup__`) → `{blobsDeleted, members, rotateDueSet}` | A0a (called at A0b) |
| relay `POST /agent/escrow-retired` **new** | `{epoch, dryRun?}` (intent `__keeper__`) → `{ok, escrowedThroughEpoch}`, or with `dryRun` `{holders:{[e]:count}, logEnabled, visibility, waiting}` (`holders` counts only `holdsVerified` humans; `waiting` = live `waiting:` rows; CS-3, CS-9) | A0a (called at R) |

### 6.4 WebSocket frames (server → client), all **unmetered** (§4.5.5)

| Frame | Sent to | When |
|---|---|---|
| `{"keyringReady":{"epoch","targetMemberId"}}` | the target's sockets only | a stored wrap at a served epoch; each pre-commit target at commit; the connect nudge N |
| `{"joinRequest":{"memberId","identityEcdhPub"},"timestamp"}` | published and uncertified sockets, plus ≤ 3 certified key holders (§4.5.5) | join-request (≥ 60 s apart), stale-link redeem, signed enrol (or enrol on a Space without a log) |
| … `,"replay":true` | one socket | bridge T1, T3; once per row per connection (§4.5.6) |
| `{"admitted":{"memberId","epoch"},"timestamp"}` **new** | broadcast | a wrap fulfils a waiting row |
| `{"epochCommitted":{"epoch"},"timestamp"}` **new** | broadcast | `rotate-commit` |
| `{"rotateDue":{"epoch"},"timestamp"}` **new** | broadcast | any §4.2.9 source |
| `{"mlog":{"seq","hash"},"timestamp"}` **new** | broadcast | a log append |

Published SDKs ignore unknown frames (`Space.ts:705-769`) and pull on any `keyringReady`
(`:765-768`). No new client → server frames; `spaceMessage` packets gain `headers.to` inside the
packet string.

Not a frame: on a log-enabled private Space the relay closes non-member and anonymous sockets with
WebSocket close code **4403** (`"not-member"`, §3.6), sent only to a client that asked with
`refuse=close`; every other refused upgrade is answered 401/403 before it opens (D31). Published SDKs
keep retrying either way (X9); 0.15 stops only after `/keyring/state` answers 403 (§6.9).

### 6.5 Wrap pipeline (`/keyring/wrap` and every `/keyring/wraps` item), in order

| # | Check | Result |
|---|---|---|
| 1 | Malformed | 400 / item error |
| 2 | Target `__keeper__` | A0a–E: forwarded when the caller is creator, founder or seeder (§4.1.4). From K: `410 {"error":"The keeper has been retired; members admit new members"}` |
| 3 | `e > currentEpoch` → 409 ahead (`keyring.ts:232`); log-enabled and `baseEpoch < e ≤ keyedEpoch` with no `meta:epochCommit:<e>` → 409 `Epoch abandoned` (CS-8, replaces `orphanRanges`); `e > keyedEpoch` → pre-commit rule (§4.2.2) or the legacy commit-on-first-wrap (§4.2.9), else 409 `Epoch not established` | — |
| 4 | Target `__link__:<id>` | §4.4.6 rule |
| 5 | Target `__agent__:*`/`__fn__:*` with no `agentmember:`, or `e < keyedEpoch`, or (log-enabled) no active signed `svc add` | `200 {ok:true, dropped:true}` |
| 6 | Private Space without `allow:<target>` | `200 {ok:true, dropped:true}` |
| 7 | A blob exists and §4.5.4 forbids a replace | 409 |
| 8 | Store; bytes-at-rest | The stored value is the posted `WrappedKey` plus the additive field **`tfp`** = `b64url(SHA-256(utf8(member:<t>.ecdhPub)))`, set **only** when the caller is `t` itself, `hasCert(caller)`, or the write is a keeper admit (§4.5.2); otherwise stored without `tfp` (CS-3). Published SDKs ignore it (`unwrapSpaceKey` reads four named fields, `con/spaces/SpaceCipher.ts:194-213`). Pre-commit: index row, no frames. `e === keyedEpoch`: fulfil (delete `waiting:<t>` **before** the `recordBytesAtRest` await, `SpaceDO.ts:414-431`), broadcast `admitted`, adjust `keyHolders` (§4.5.7), targeted `keyringReady`. `e < keyedEpoch` (history): targeted `keyringReady` only. |

Rows 5–6 return 200 because published SDK loops abort on the first non-2xx (`SpaceKeyring.ts:307-311`,
`:340-345`).

### 6.6 Storage

No key is renamed. No existing value changes shape except the transcript (reader first, §5.4) and
`keeper:identity` (tombstone, read safely by the pre-K build, §8.3); the rest are new keys or
additive optional fields. All builders are golden-tested: SharedSpaceDO in the new
`acc/durable-objects/space/keys.ts` / `tests/space-keys.test.ts` (which also pins today's `invite:`,
`member:`, `keyring:`, `joinreq:` spellings); AppDOv1 in `acc/durable-objects/app/keys.ts` /
`tests/app-keys.test.ts`.

**SharedSpaceDO**

| Key | Value | Status |
|---|---|---|
| `mlog:<seq, 16-digit zero-padded>` | `MembershipEntry` JSON | new (I) |
| `meta:mlogHead`, `meta:epochCommit:<e>`, `meta:keyedEpoch`, `meta:rotation`, `meta:rotateDue`, `meta:founder`, `meta:keyHolders`, `meta:lastKeyHolderAt`, `meta:admissionIndexV1`, `meta:svcCleanupV1`, `meta:escrowedThroughEpoch` | §4.1.2 | new |
| `waiting:<m>` | §4.5.2 | new |
| `rotwrap:<e>:<m>` | `1` (≤ 64 per rotation) | new |
| `conflict:<e>:<m>` | ts | new |
| `linkidx:<linkId>` | `"<token>"` | new |
| `standing:<m>` | `"<token>"` | new |
| `linkuse:<linkId>:<m>` | ts | new |
| `ikbind:<m>` | `{ik, src:"log"\|"cert", seq?, removedSeq?}` (`ik` b64 raw P-256; §3.6, §3.10) | new (I); builder `spaceKeys.ikBind(m)` |
| `mlogmember:<m>` | `{joined, joins, leaves, svcActive, svcSeq?, removedSeq?}`, derived from the log: public join/leave counters (KI10), the active `svc add`, and the `removedSeq` every private `remove` leaves, bound or not (cleared by `add`; step-I plan D1, D16) | new (I); builder `spaceKeys.mlogMember(m)` |
| `meta:mlogState` | `{lastRemovalSeq, lastHumanRemovalSeq, lastSvcRosterSeq}`, derived from the log (step-I plan D1) | new (I) |
| `keyring:<m>:<e>` | `WrappedKey` + optional **`tfp`** (§6.5 row 8) | additive (A0a) |
| `keyring:__link__:<linkId>:<e>` | `WrappedKey` | existing format, new member namespace |
| `invite:<token>` | + optional `linkId, standing, ecdhPub, linkSignPub, grantSeq, ownerWrap, exhaustedAt` | additive |
| `member:<m>` | + optional `keyCert` (humans), `handle`, `mode` (services) | additive |
| `joinreq:*`, `allow:*`, `role:*`, `agentmember:*`, `meta:currentEpoch`, `meta:creator`, `meta:visibility`, `meta:agentCount` | unchanged | — |
| `meta:keeperSeeder` | no longer written | inert |

**AppDOv1**

| Key | Value | Step |
|---|---|---|
| `app:meta` (`AppRecord`) | + optional `ownerUsername` | I |
| `trust:roster`, `trust:roster:<seq>` | `AppRoster` | I |
| `agent:enrol:<agentId>:<spaceId>` | `{seq, hash, by, mode, at}` (index; the log is authoritative) | I |
| `fn:enrol:<functionId>:<spaceId>` / `fn:test:enrol:…` (`appKeys.fnEnrol(env, …)`, same pattern as `fnConfig`, `keys.ts:75`) | as above | I |
| `agent:transcript:<agentId>:<spaceId>` | array → `{v:1,…}` (A0b) → `{v:2,…}` (K) | A0b, K |
| `keeper:identity` | JWK pair → tombstone `{v:1, retired:true, encodedPub:null, at}` (`appKeys.keeperTombstone()`) | K (if absent), R |
| `keeper:retired` | `{v:1, at, purgedSpaces, purgedKeys, orphaned, soleCopy:[spaceId], failed:[spaceId], keptLogSpaces:[spaceId]}` | R |
| `keeper:gk:<spaceId>:<e>` | unchanged format; after R only log Spaces and kept sole-copy Spaces | R |

New prefixes do not collide with existing list prefixes (`agent:config:`, `agent:identity:`,
`agent:transcript:`, `agent:usage:`, `keys.ts:30-33`; the `fn:*` builders, `:75-86`).

**Personal KV and device**

| Store | Key | Value |
|---|---|---|
| Personal KV | `chat-keys` | unchanged; reserved SDK key (§6.6a) |
| Personal KV | `muhkoo.pins/identity-v1` | SpecA §4.2 (shared); reserved |
| Personal KV | `muhkoo.pins/spaces-v1` | §3.4; reserved |
| Personal KV | `space-keys-v2/<spaceId>` | §4.3; reserved (cache class) |
| Personal KV | `space-keys/<spaceId>` | unchanged; read once per Space by 0.15 (§4.3), never written or deleted by it; reserved (cache class) |
| IndexedDB | `muhkoo.trust` | pin-doc high-water marks (SpecA), per-Space `{genesis, hw}` (§3.7), per-app roster seq, `rotationBlocked:{spaceId, reason, headSeq, at}` (§4.2.7) |
| Platform KV (KEYS_CACHE) | `usersess:<token>` (60 s TTL) | `{username, commitment}` + optional `ik` (additive, I; key spelling unchanged, readers use named fields) |
| `sessionStorage` | `muhkoo.invite.v1` | captured invite, 30 min |

**UserAuth** (the singleton's rate-limit rows)

| Key | Value |
|---|---|
| `rl:idl:user:<lower(username)>`, `rl:idl:ip:<ip>` | directory-lookup buckets (§6.1), the existing `rateAllow` row shape; never `chal:*` |

### 6.6a Personal KV: reserved SDK keys (CS-4)

New pure module `acc/durable-objects/personalKv/reserved.ts`, golden-tested:

```ts
export const SDK_IDENTITY_KV_KEYS = ["chat-keys", "muhkoo.pins/identity-v1", "muhkoo.pins/spaces-v1"] as const;
export const SDK_CACHE_KV_PREFIXES = ["space-keys/", "space-keys-v2/"] as const;
export const MAX_SDK_IDENTITY_VALUE_BYTES = 256 * 1024;
export function sdkKvClass(key: string): "identity" | "cache" | "app";
```

`PersonalSpaceDO` counts but never refuses these keys. The precedents are KV delete, which is metered
and never refused (`acc/durable-objects/PersonalSpaceDO.ts:522-524`), and relay wraps, whose
bytes-at-rest are unenforced (`keyring.ts:258-260`).
- `handleKvGet` (`:483-484`) and `handleKvPut` (`:449-450`): the op is metered exactly as today; the
  `quota.over` 402 is returned only when `sdkKvClass(key) === "app"`.
- `handleKvPut` bytes-at-rest check (`:443-445`): skipped for class `identity` when the value is
  ≤ `MAX_SDK_IDENTITY_VALUE_BYTES` (three fixed keys per user, so it cannot be used as storage); the
  bytes are still recorded. Class `cache` stays subject to the storage cap: a refused cache write is
  already ignored (§4.3), because the relay self-escrow blob is the durable copy.
- `handleList` and `handleKvDelete`: unchanged.
- Every 402 logs `personal kv quota refused` (§6.8).

Metering and billing are unchanged, so paid tiers see no difference. Residual: an app can store its
own data under `space-keys-v2/…` to dodge the Free op cap; it is still metered, storage-capped and
visible in usage. Accepted.

### 6.7 Constants (`acc/durable-objects/space/consts.ts`)

| Constant | Value | | Constant | Value |
|---|---|---|---|---|
| `JOIN_REQUEST_TTL_MS` | 14 d | | `MAX_LINKS_PER_MEMBER` | 16 |
| `JOIN_REBROADCAST_MIN_MS` | 60 s | | `MAX_LINKS_PER_SPACE` | 256 |
| `REPLAY_MAX` | 20 | | `KEY_HOLDER_TOUCH_MS` | 10 min |
| `KEEPER_ADMIT_MODE` | `"escrow"` (A0a–E), `"rescue"` (from K) | | `MAX_KEYCERT_BYTES` | 4 KiB |
| `ROTATION_STALL_MS` | 2 min | | `MAX_MLOG_ENTRY_BYTES` | 4096 |
| `MAX_WRAPS_PER_BATCH` | 64 | | `MAX_JOINS_PER_MEMBER` | 20 |
| `LINK_EXHAUST_GRACE_MS` | 1 h | | `MLOG_PAGE_MAX` | 500 |
| `LINK_MEMBER_PREFIX` | `"__link__:"` | | `NOT_MEMBER_CLOSE_CODE` | 4403 |
| `JOIN_TRIGGER_TARGETS` | 3 | | `JOIN_TRIGGER_SAMPLE` | 16 |

`MAX_ORPHAN_RANGES` is deleted with `meta:orphanRanges` (CS-8). Elsewhere: `IDLOOKUP_USER_LIMIT` 120,
`IDLOOKUP_IP_LIMIT` 600 and `IDLOOKUP_ANON_IP_LIMIT` 30 in `acc/durable-objects/userAuth/rateLimit.ts`;
`MAX_SDK_IDENTITY_VALUE_BYTES` 256 KiB in `acc/durable-objects/personalKv/reserved.ts`. Client
constants (`con/spaces/consts.ts`): `KEY_POLL_MS` 5 min, `LOG_SYNC_MIN_MS` 10 s,
`REMOVAL_ROTATE_RETRY_MS` 60 s, `ROTATION_BLOCKED_RETRY_MS` 24 h, `NOT_MEMBER_RECHECK_MS` 60 s.

`isReservedServicePrincipal` (`members.ts:73-81`) also matches the exact names `__link__`, `__agent__`,
`__fn__` and the prefix `__link__:`; `classifyServiceMember` returns `null` for link ids.

### 6.8 Log lines (stable phrases, values in fields; used by gates)

| `msg` | Fields | Step |
|---|---|---|
| `keeper admit` | `where:"SharedSpaceDO", appId, spaceId, epoch, via:"join-request"\|"redeem"\|"enroll"\|"rescue", hit, wrote, certified, keyChanged, hadBlobAtKeyedEpoch` (`hit`: the keeper holds `keyedEpoch`; `wrote`: a blob was stored; `certified`: the post-decision `member:<m>` satisfies `hasCert`). Emitted for every evaluation, skips included (CS-1). | A0a (`wrote`/`certified` from A0b) |
| `agent group key` | `where:"AgentRuntime", appId, spaceId, epoch, source:"member"\|"keeper"\|"none"` | A0b |
| `agent legacy match` | `where:"AgentRuntime", appId, spaceId, agentId, fired` | A0a |
| `unsigned service member` | `where:"SharedSpaceDO", appId, spaceId, memberId, via:"enroll"\|"keeper-bridge"` | I |
| `bad routing header` (warn) | `where:"SharedSpaceDO", spaceId` | A0a |
| `epoch committed` | `where:"SharedSpaceDO", spaceId, epoch, sole, backfilled, reason` | A0a |
| `key conflict due` (warn) | `where:"SharedSpaceDO", spaceId, epoch, reporters` | A0a |
| `space socket refused` | `where:"SharedSpaceDO", spaceId, reason:"anonymous"\|"not-member", mode:"http"\|"close"` (§3.6, D31; measures X9 at P) | I |
| `personal kv quota refused` (warn) | `where:"PersonalSpaceDO", appId, keyClass:"identity"\|"cache"\|"app", kind:"read"\|"write"\|"storage"` (§6.6a; gate K8) | I |

### 6.9 SDK surface (the connect release for step S: `0.15.0-alpha.0` unless SpecA step 3 ships first; see the release-train row in §8.1)

| Surface | Change |
|---|---|
| `Client` options | `trustAnchor?: {appId, owner, ownerFingerprint?}` |
| `client.withAppKey(pk: string): Client` (new, SEC8) | A second Client for another app's publishable key that uses **this** client's identity. It copies the parent's options except `apiKey` (becomes `pk`) and `accessToken` (unset); `baseUrl` cannot be overridden, so the session token never goes to another origin. It shares **by reference** the parent's `SessionState` (token, username, commitment, in-memory identity and seed), `ChatKeyVault`, `PinStore` and `IdentitySigner`; its own session store is a no-op, so it persists nothing and never exports the seed. It is locked exactly when the parent is, and a parent `unlock()` or `logout()` applies to it at once; a Space it opened while locked stays `locked` until reopened. Requests carry `X-Muhkoo-Key: pk`, so its traffic is metered to that app. The offline layer is per Client. |
| `client.trust` (new) | `safetyNumber(username)`, `unpin(username)`, `fingerprint()`, `appTrust()`, `publishAppRoster(appId, editors)` (an explicit call only: nothing in the SDK calls it implicitly, SEC6), `resetSpacePins(spaceId?)` (with `spaceId`: removes only that Space's `s:` pin and its `muhkoo.trust` record, which clears its `integrity`; the next open re-establishes genesis trust per §3.7 item 2; apps call it only after the user confirms, SEC11) |
| `client.space.createChannel`, `createSpace` | no `/api/app/keeper` call (removes `SpaceNamespace.ts:186-193`); genesis + `ec(0)`; `IdentityLockedError` when locked; `messaging:false` unchanged. `KEEPER_MEMBER_ID` stays exported `@deprecated`. |
| `client.space.createInviteLink(id, {expiresInSec?, maxUses?, role?, keyed?=true, standing?})` | builds `d`, `ls`, blobs, `ownerWrap`, the signed `link` entry; `keyed:false` → membership-only (still has `d`) |
| `client.space.standingLink(id, {role?})`, `newLink(id, token)` | new |
| `client.space.listInviteLinks(id)` | + `linkKey?`, `linkKeyState`, `spaceId`; heals missing link epochs (best effort) |
| `client.space.setMemberRole(id, u, role)`, `revokeInviteLink(id, token)` (CP11) | On a log-enabled Space `setMemberRole` signs a `role` entry and never calls `/keyring/role` (owner only; others get the relay's 403), and `revokeInviteLink` signs `unlink` for a record with `linkSignPub` and sends none for a legacy record (§4.4.8). Both throw `IdentityLockedError` when locked. On a Space without a log they behave as today. |
| `client.space.joinByInvite(id, token, {linkKey?, timeoutMs?})`, `acceptInvite(invite = pendingInvite(), {timeoutMs?})` | preview → signed redeem → adopt → fall back to waiting; a v2 link without a key → `InviteLinkError("no-link-key")` with no request |
| Standalone exports | `buildInviteUrl`, `parseInviteUrl`, `captureInvite`, `pendingInvite`, `clearPendingInvite`, `extractMessageText` |
| Errors / types | `IdentityLockedError` (shared with SpecA), `IdentityUnavailableError`, `SpaceTrustError{code}` (codes include `"integrity"`, `"rotation-pending"`, `"rotation-blocked"`), `NotKeyedError`, `ServerTooOldError`, `InviteLinkError{code:"no-group-key"\|"identity-locked"\|"no-link-key"\|"link-stale"\|"link-unverified"}`, `AddressingError{code}`, `AdmissionTimeoutError`, `AdmissionDeniedError`; types `AdmissionState`, `ChatKeyCert`, `MembershipEntry`, `EpochCommit`, `AppRoster`, `MembershipView`, `ServiceMember`, `SpaceKeyState` |
| `Space` | `admission`, `onAdmission`, `waitForKey`, `cancelJoin`, `join({…, signal})`, `membership()`, `add(username, {role})`, `remove(memberId): Promise<{seq, epoch}>` (resolves after its rotation commits, else rejects `rotation-blocked`, §4.2.8), `leave()`, `safetyNumber(memberId)`, `serviceMembers()`, `rotate()` (owner, two-phase); `invite(u)` becomes an alias of `add(u, {role:"viewer"})`; `sendMessage(payload, {…, to?})` |
| `Space` events | `join-request {memberId, verification}`, `admitted`, `member-joined`, `member-removed`, `member-rekeyed`, `identity-changed`, `unverified-member`, `service-member-unverified`, `membership-synced`, `membership-bootstrapped`, `integrity-error`, `key-conflict`, `rotation-blocked {reason}`, `link-unverified` |
| `SpaceMessageEvent` | + `verified: boolean`, `to?: string[]` |
| `SpaceKeyring` | `sweep()`, `rotate({ifCurrent?, reason?})`, `selfEscrow()`, `mintLink`, `adoptLinkKeys`, `verifyEpochKey(e, K)`; `admit()` runs the gates; `admitPending()` deprecated alias of `sweep()` |
| `KeyringTransport` (`SpaceKeyring.ts:52-67`) | new **optional** methods (custom and test transports still compile): `postWraps?`, `rotateCommit?`, `fetchState?`, `reportConflict?`, `cancelJoinRequest?`, `fetchLog?`, `postLogEntry?`, `redeemPreview?`; `rotate(nextEpoch, opts?)` → `{epoch, keyedEpoch?, linkTargets?}`; `postJoinRequest` may return a status |
| `KeyringClient.redeemInvite` | returns the body (today `void`) |
| Types | `SpaceMetadata` + `keyedEpoch?, rotateDue?, escrowedThroughEpoch?`; `RosterMember` + `active?, online?, keyCert?, handle?, mode?`; `JoinRequest` + `keyCert?, reason?`; `InviteLink` + `linkId?, standing?, linkKeyState?, exhaustedAt?, linkKey?, spaceId?, legacy?` |
| `SpaceCipher` | `wrapLinkSecret` / `unwrapLinkSecret` over a private `eciesWrap(bytes, pub, info, salt)` that `wrapSpaceKey` also calls; `wrapSpaceKey` bytes unchanged |
| `client.auth.hosted` | `login({…, returnTo?})`; `handleCallback()` returns `returnTo?` |
| `client.agents.enable/disable/authorize`, `client.functions.enable/disable/authorize` | prepare → sign → commit (§5.3.3) |
| Modules | `con/core/trust/{PinStore,IdentitySigner}.ts` (shared with SpecA); `con/spaces/trust/{canonical,chatCert,MembershipLog,epochCommit,IdentityGate}.ts`. `canonical.ts` has no npm dependencies and is not on the workers surface. |
| api-surface | both snapshots regenerated (`UPDATE_API_SURFACE=1`) and reviewed |
| `WSTransport` (`con/transport/WSTransport.ts:198-206`; the `BroadcastChannel` options pass it through) | new option `terminalCloseCodes?: number[]` (default `[]`): on a listed close code the transport schedules no reconnect and emits `DISCONNECTED` with `{code}`; new method `resume()` restarts reconnecting through `urlProvider`. `Space.connect` adds `refuse=close` to every upgrade URL it builds (D31), passes `[4403]` and on a 4403 calls `GET /keyring/state` once (after `HttpClient`'s 401 recovery): **403** → `admission:"not-member"`, the transport stays stopped; **401** → `locked`; **2xx, 5xx or a network error** → `resume()`, at most once per `NOT_MEMBER_RECHECK_MS` per Space (AV12). For a keyring Space, `buildUrl` called as the `urlProvider` on a reconnect throws when `fetchTicket()` returns `null` while the session holds a token, so the transport's scheduled retry runs (`WSTransport.ts:151-158`, `:324-345`) instead of an anonymous upgrade; the first connect keeps today's path. |
| Constants (`con/spaces/consts.ts`) | `KEY_POLL_MS` 5 min, `LOG_SYNC_MIN_MS` 10 s, `REMOVAL_ROTATE_RETRY_MS` 60 s, `ROTATION_BLOCKED_RETRY_MS` 24 h, `NOT_MEMBER_RECHECK_MS` 60 s |

### 6.10 Canonical byte strings and KDF labels (registry)

| Label | Used by | § |
|---|---|---|
| `LP("muhkoo-chatkey-v1")` | `keyCert` | 3.2 |
| `LP("muhkoo-mlog-v1")` | log entries (`sig`, `lsig`, `hash`); the enable intent uses the same bytes with `seq:-1` encoded as `dec(-1)` (§5.3.3) | 3.5, 5.3.3 |
| `LP("muhkoo-epoch-commit-v1")` | `EpochCommit` | 4.2.4 |
| `LP("muhkoo-spacepins-v1")` | `spaces-v1` pin doc | 3.4 |
| `LP("muhkoo-approster-v1")` | `AppRoster` | 5.3.1 |
| `LP("muhkoo-pinmap-v1")`, `LP("muhkoo-safety-v1")` | SpecA, reused | 3.4 |
| HKDF `muhkoo/space/key-commit/v1\n<spaceId>` | `keyCommit` | 4.2.4 |
| HKDF `muhkoo/space/link-sign/v1` | `ls` | 4.4.1 |
| HKDF `muhkoo/space/link-owner/v1` | `ownerWrap` | 4.4.1 |
| HKDF `muhkoo/space/keycache/v2` | sealed cache | 4.3 |
| HKDF `muhkoo/agent/transcript/v<n>\n<agentId>\n<spaceId>` | transcript | 5.4 |
| HKDF `muhkoo/space/keywrap/v1` | existing ECIES wraps (`SpaceCipher.ts:43`), unchanged | — |

`LP` is SpecA §3.1's `uint32be(len) ‖ bytes`; every signature is over the exact transmitted strings.
A shared fixture, `connect/tests/fixtures/mlog-v1.json` copied to
`accelerator/tests/fixtures/mlog-v1.json`, holds entries, commits, a `keyCert`, a roster and one
enable intent (`seq:-1`, §5.3.3) with expected bytes, hashes and valid signatures; both repos assert
byte-identical encoders against it.

---

## 7. App and surface changes

### 7.1 Published pins and the identity gate

| Surface | Pin today | Identity gate before opening a Space? |
|---|---|---|
| web | `0.13.0-alpha.0` (`web/package.json:28`) | **No.** `useChatChannel` calls `client.space.get` (`web/src/hooks/useChatChannel.ts:266`) whether or not `resume()` unlocked (`web/src/auth/AuthContext.tsx:124-133`), so every reload without a passkey mints a throwaway key |
| portal | `0.13.1-alpha.0` (`portal/package.json:27`) | Has `isUnlocked()` (`portal/src/auth/AuthContext.tsx:158-160`). Its team-Space and App Config calls run on a second, per-app Client that has no seed; under 0.15 that client is `getClient().withAppKey(pk)`, and the team-Space, App Config, JoinSpace and agent pages check `isUnlocked()` first (§7.2) |
| discord-clone | `0.13.0-alpha.0` (`discord-clone/package.json:23`) | Yes: signed in only when unlocked (`discord-clone/src/auth/AuthContext.tsx:57`) |
| spotify | `0.10.11-alpha.0` (`spotify/package.json:23`) | Yes: `needsUnlock` (`spotify/src/auth/AuthContext.tsx:52`) |
| theater | `0.10.14-alpha.0` (`theater/package.json:31`) | Yes (`theater/src/auth/AuthContext.tsx:121`) |
| cloud-drive | `0.10.14-alpha.0` (`cloud-drive/package.json:23`) | Yes (`cloud-drive/src/App.tsx:53`) |
| theater-transcoder (npm bin on users' machines) | `0.10.11-alpha.0` (`theater-transcoder/package.json:28`) | logs in with a password, so unlocked |
| cli, ide | `0.14.0-alpha.9` (`cli/package.json:43`, `ide/package.json:25`) | — |
| app-builder template | `^0.7.0-alpha.4` (`templates/starter-app/package.json:23`) | template-dependent |

### 7.2 Per repository (step P unless stated)

| Repo | Change |
|---|---|
| **web** | Bump to 0.15. **Before opening any Space**, `useChatChannel` returns early with state `locked` while `client.auth.zk.identity` is null; `ChatPage` shows "Sign in again to read this channel". Its button calls `startHostedLogin` (`web/src/auth/AuthContext.tsx:386-392`), extended to pass `returnTo: location.pathname + location.search + location.hash`; `completeHostedLogin` navigates to the returned `returnTo`. An inline password field is shown **only** when `listFactors()` returns a factor with `type:"password"`, wired to the existing `unlock()` (`AuthContext.tsx:484-496`) (CS-5). `/join` route outside `RequireAuth` (`web/src/App.tsx:57`): capture → sign in (`returnTo`) → `acceptInvite` → `navigate("/chat#"+room)`; `RequireAuth` and the auth callback honour `returnTo`. "Share channel" in `RoomHeader` (`standingLink` + `buildInviteUrl`). Composer @-autocomplete from `serviceMembers()`; "shared with @assistant" from `e.to`; `verified` badge; `identity-changed` banner with safety number; the `securing` notice on the composer (§9.1). Waiting copy "Waiting for a member to let you in…" / `orphaned` / `owner-migration` copy, driven by `space.onAdmission`; the 500 ms `setInterval(attemptAdmit)` (`web/src/hooks/useChatChannel.ts:300-323`) is replaced by `space.waitForKey()` (CS-6). The `/chat#room` grammar is untouched. |
| **portal** | Bump to 0.15. **Per-app client** (SEC8): delete `spaceClient` (`lib/spaceInvites.ts:53-65`) and use `getClient().withAppKey(pk)`, one per `pk`, memoised for the page's lifetime and dropped on logout, at every call site (`pages/AppDetail.tsx:111,131,146,167,182`, `pages/SharedSpace.tsx:78,130,143,157`, `pages/JoinSpace.tsx:32`). Collaborators, App Config and JoinSpace check `isUnlocked()` before building it; when locked they make no Space call and show "Sign in again to manage this space", whose button runs the hosted sign-in with `returnTo` (§3.3, CS-5); JoinSpace keeps the captured invite (§4.4.9). **Team Space migration** on the owner's first 0.15 load, only through that client (genesis with `legacyCommits`, then `add` per member, then a rotation when the owner holds no committed key; §3.8). Membership actions become signed entries (`Space.add`; `setMemberRole` → `role`; `remove`; link revoke through `revokeInviteLink` → `unlink`, CP11). After `remove()` resolves, re-read `listInviteLinks()` and show "Invite links made before this removal were turned off." with a **New invite link** button (`standingLink()` mints a fresh standing link; the cascade deleted `standing:<m>`, SEC9). **Team links carry `#lk=`** (§4.4.10): `/join` moves outside `RequireAuth` (`portal/src/App.tsx:96`), capture + `returnTo`, `JoinSpace` calls `acceptInvite` (membership only). Legacy team links show "This link needs to be re-created" (409 `link-needs-upgrade`). **Agents/Functions cards call the SDK** (`client.agents.enable/disable`, signing) instead of `api.ts:604-616`; when locked, the same hosted sign-in with `returnTo`, and a password field only when `listFactors()` has a password factor (CS-5). **"Review app editors (N changes)"** banner and dialog (§5.3.1, SEC6): a roster is published only on the owner's click, each editor ticked individually beside a safety number. Editor banner **"Waiting for the app owner to confirm you as an editor"** when the signed-in user is a config-Space editor absent from the latest `AppRoster`; a suggestion to appoint an editor when a team Space has none (CS-9). Banner **"Confirm agents and functions (N need your signature)"**. Function editor: the `addressed` trigger with mode text; agent editor: "answers only messages addressed to it; triggers choose which skill answers", warning on `keyword`/`regex`/`always`. §5.8 copy on both cards. Delete `seedDefaultChannel` (`Dashboard.tsx`), which has no session. Remove "server-blind" wording in `components/ToolsFab.tsx` and `lib/logsReader.ts`. |
| **cli** | Bump. `agents enable/disable`, `functions enable/disable` and `provision --enable` sign through the SDK with the device-factor identity (today raw `devCall`, `cli/src/commands/agents.js:71-80`, `provision.js:238`). New `agents resign <appId>`, `functions resign <appId>`. `needsSignature` / `enrolment-required` print the upgrade hint. `provision` writes `trustAnchor` into the app env (Q2). Publishing `@muhkoo/cli` is a production action. |
| **discord-clone** | Bump. Replace the 25 s give-up and "could not obtain channel key" (`src/features/ChatView.tsx:155-173`) with `onAdmission`. Its DB-backed `?invite=` links stay membership-by-app (follow-up: bundles). |
| **spotify** | Bump. Same replacement at `src/features/NowPlayingFeed.tsx:92-107`. |
| **theater** | Bump. `scan` function and `requestScan` via `functions.invoke` (§5.9). Keep the key wait only for the `jobsig` path. |
| **theater-transcoder** | Release 0.4.0 (§5.9). With a stable 0.15 identity it reads its own self-escrowed blob without the browser online. |
| **cloud-drive** | Bump. `putFile` must not depend on the 25 s `awaitKey` (`src/lib/drive.ts:31-52`): shards need no group key. |
| **app-builder** | Pin the template to exact `0.15.0-alpha.0`. `ChannelChat.tsx` uses `waitForKey` / `onAdmission`; template sets `trustAnchor`. Rewrite `scaffolds/api-space.md`, `scaffolds/api-agents.md` (addressing, signed enable) and `references/platform.md` (keeper and "server-blind `__logs__`" passages). Rewrite `references/provisioning.md` (lines 49, 51, 153-154): the raw `POST …/{agents,functions}/:id/enable {targetSpaceId}` rows become `muhkoo provision --spec app.json --enable` (which signs) or `client.agents.enable` / `client.functions.enable`. The skill ships as an installed plugin, so it is republished before E, when Matt asks (a production action) (CP11). |
| **ide** | Run `scripts/sync-docs.mjs` after app-builder. |
| **docs** (step D) | `concepts/spaces.mdx`, `reference/space.mdx` (links, admission, `to`, `serviceMembers`, membership APIs, trust), `guides/messaging.mdx`, `examples/chat.mdx`, `reference/building-blocks.mdx` (`KEEPER_MEMBER_ID` deprecated), `reference/agents.mdx`, `patterns/agents.mdx`, `reference/functions.mdx`, `patterns/functions.mdx` (§5.8), `guides/server-logs.mdx` ("server-blind" is false). New "Verify a contact / safety numbers" page (SpecA §4.4 deliverable, shared). `check-claims.mjs`. |
| **website / changelogs** (step D) | `updates/index.html` entry; connect `CHANGELOG.md` (the `to` header, `serviceMembers`, `AddressingError`, signed enable, `IdentityLockedError` from Space APIs, `extractText` no longer forwarding structured bodies, links, admission states, trust namespace). |

---

## 8. Release order, gates, compatibility, rollback

"Expand, switch, contract." Every step goes to staging first. Production deploys, `npm run release`
of connect or the CLI (which moves `latest` for every app), and `npm publish` of the transcoder each
happen only when Matt asks, every time. Deploys come from the working tree, so every gate is checked
by **probing the deployed endpoint**, never by reading git.

### 8.1 Steps

| Step | What ships | Repos | Gate before the next step | Rollback |
|---|---|---|---|---|
| **Release train (connect)** (CS-11) | S is a connect minor release on its own. It contains neither SpecA step 3 (the DM wire break) nor Spec B release 3 (the vault flip); Spec B release 1 (loud failure, no behaviour change) may ride along. The shared modules S introduces (`con/core/trust/PinStore.ts`, `IdentitySigner.ts`, `IdentityLockedError`, the `identity-v1` document format, `POST /api/auth/identity` as amended by CS-7) are **frozen at their first release**: SpecA step 3 and Spec B release 3 ship in later connect releases, each with its own gate and rollback note, and consume them unchanged. If SpecA step 3 is ready first, it ships first and owns those modules; S then takes the next minor and consumes them unchanged (Q16). SpecA §9 step 2 (the endpoint) is this design's step I in either order. | connect, accelerator | On staging, two tabs of one app and a second app on the same account pin new peers concurrently 50 times: every operation applies or fails closed; the stored `counter` equals the highest counter any writer saw applied; no tab reports rollback; every pinned peer is present (CP9). Whichever of S and SpecA step 3 ships second repeats it with a DM session and a Space open under one unlock. | S's dist-tag rollback is valid because S carries no DM wire break and no vault mode change; SpecA's and Spec B's rollbacks are defined in their own specs. |
| **I. Identity and log foundation** (shared with SpecA) | `POST /api/auth/identity` (hex normalised, decoy, **own per-caller bucket, batch form**, §6.1). `MembershipLogFacet`: log routes, `redeem-preview`, mirror effects (incl. `remove` → `rotateDue`), 409s on log-enabled Spaces, **`ikbind:<m>` from the log and from the first verified `keyCert`, the `identity-bound` / `internal-op` / `base-epoch-mismatch` checks, `legacyCommits` validation** (SEC3, SEC4). **Private transport gate and `closeNonMembers()`** (SEC1). `keyCert` **verified before it is stored** (§11.6 M4). **The session context carries `ik`, and every first binding must equal it** (SEC10); §3.10's "same keys" rows store a missing certificate (CP7). `/api/app/trust`, roster routes (**`ownerIk` = registered IK**), `ownerUsername` write + backfill. Enable `prepare`, `entry` verification and pass-through, relay `enroll-prepare` and enroll `entry` (no genesis). `enrolments` in list responses. `unsigned service member` and `space socket refused` logs. The `metered:false` option on `broadcast`/`sendToMember`, pulled forward from A0a because I sends `mlog` and `rotateDue` frames (step-I plan D12). **Reserved SDK keys in `PersonalSpaceDO`** (§6.6a; SpecA's pins need it too). **Inert until a 0.15 client writes a genesis**, except the lookup bucket and the KV exemption, which only relax limits. | accelerator | SpecA §10 endpoint tests, unit and server suites green. Probes on staging **and prod**: identity returns keys and decoys, singly and in a batch; `GET /api/spaces/<id>/keyring/log` answers 200/403, not 404; a Free app over its KV op cap still reads `chat-keys`; a `join` signed by a key other than the account's IK → 403 `identity-not-registered`. | Redeploy the previous build. Safe while 0.15 is not on `latest`: log keys are inert to the old build, and a 0.15 client facing a server without log routes wraps to no one (fails closed). |
| **A0a. Additive, no behaviour change** | Transcript tolerant reader (§5.4). `keeper admit` log. `meta:founder`. `stampAndRoute` with the legacy flag **on**; `/agent/event` tolerant of both bodies. Roster fields. `/keyring/state`, `/keyring/wraps`, `/keyring/join-cancel`, v2 `rotate`, `rotate-commit` (**certified-only copy rule; effect 8 deletes services' older copies**), `key-conflict`, blob visibility **by commit record (no `orphanRanges`)** and `commits` (reachable only by v2 bodies). **`tfp` written on stored blobs** (additive, §11.6 M9). Link v2 fields, v2 redeem path, `linkuse:` idempotency (v2 records only). (`metered:false` shipped in I.) Agent vouch `enabled` fix. `/agent/seal`/`open` deleted. `postUnenroll` boolean; delete-agent fix; test-env guard. `/agent/svc-cleanup`, `/agent/escrow-retired` (**dry run reports verified holders, `logEnabled`, `visibility`, `waiting`**), `/keeper/epochs` present, called only by admin routes. Lazy backfill (`admissionIndexV1`). | accelerator | Suites green. Legacy matrix (§10.4) green on staging. **A0a live in prod ≥ 24 h**, because it is A0b's rollback target. | Redeploy the previous build; new keys and the `tfp` field are inert. |
| **A0b. Behaviour, escrow still on** | Transcript writer `v:1`. Member-copy key push with keeper fallback and `agent group key` metric; per-target forwarding **only at `keyedEpoch`, one key per target, runtime epoch guard** (SEC5). `extractText` → `null`. Unenroll cleanup + `rotateDue` + `retire`. Enrol writes `waiting:` + create-only keeper bridge for services. `/pending` filter, fulfilment, `admitted`, targeted `keyringReady`, unmetered frames, **`joinRequest` to published sockets + ≤ 3 certified holders** (CS-6). §3.10 `member:` policy **with the invalid-certificate row**. **`holdsVerified` holder counts** (CS-3). Legacy rotate owner-only and refused on log-enabled Spaces. `keeperSeeder` TOFU removed; **`keeperAdmit` runs after §3.10 and follows `keeperAdmitDecision`** (§4.5.2, CS-1). Bridge N, T1, T3 (§4.5.6 bound). Admin `agents-e2e`, `keeper-retire` (dry run). Then `e2e-channels-migrate.mjs agents`: dry run, review, `CONFIRM=`. | accelerator | Migration report reviewed. Runbook a–c (§10.8). **The §10.4 locked-reload rows for `0.13.0` and `0.10.14` pass on staging before A0b goes to prod** (CS-1). **A0b live in prod**: `/metadata.keyedEpoch` present; `/api/app/keeper` still returns a key; `keeper admit` with `hit:true, keyChanged:true, certified:false, wrote:false` = 0 on staging and in prod for 24 h (legacy key changes are always re-admitted). | **Roll back to A0a only**, never to a pre-A0 build (§5.4). |
| **S. connect 0.15.0-alpha.0** (numbering per the release-train row) | Everything in §6.9, including the sealable rule (with the removal floor and the integrity pause, which ship together with the AV13 race fixes), `withAppKey`, `hlc`-stamped pin writes, the 4403 state check, the v1 import, frame-driven waiting and the rotation pre-check. **No keeper seed** (V1). | connect | api-surface snapshots reviewed. Tarball smoke-tested against staging. Staging apps built from `file:../connect` first. **Before `npm run release`: I and A0b live in prod** — probes: `POST /api/auth/identity` 200; `GET /keyring/log` 200/403; `GET /keyring/state` not 404; `/metadata.keyedEpoch` present. 0.15 has **no degrade path**: falling back when routes are missing would be a downgrade A1 could trigger. | `npm dist-tag add @muhkoo/connect@0.14.0-alpha.9 latest`; apps pin exact versions. A dist-tag rollback un-migrates nothing: log-enabled Spaces, stored `keyCert`s, `ikbind:` rows, `waiting:` rows and signed enrolments stay, and apps already on 0.15 are unaffected (CS-10). An old portal then gets 409 on `invite`/`role` in log-enabled Spaces. |
| **P. Apps and tools** | In order, each canaried on its own: **web** (identity gate and hosted sign-in first); discord-clone, theater + `scan` function + transcoder 0.4.0, cloud-drive, spotify, app-builder, IDE sync; **cli**; **portal last** (per-app client through `withAppKey`, team migration, "Review app editors", SDK signing, fragment team links, re-sign banner), only after web has run 24 h in prod with no rollback (CS-10). The P-0 staging drill (§10.8) runs first. Then **re-sign every existing enrolment** (banner or `resign`) and owners review their app editors. | apps, cli, transcoder | Per-app Playwright checks (§10.8). Every first-party 0.15 build **live in prod**, probed by the served bundle's connect version string. `space socket refused` counts reviewed (X9). Portal: the P-0 portal drill and the §10.7 portal Playwright rows pass with `withAppKey`, including a Google-only owner who reloads locked. | Before an app's first 0.15 deploy: per-app hosting rollback (or dist-tag rollback) as usual. **After it, the rollback target is that app's previous 0.15 build, never a pre-0.15 bundle**, for **web** (a pre-0.15 bundle's locked reloads are `refused-uncertified`, and v2 links it handed out stop working), **portal** (the team Space is log-enabled; an old portal gets 409 on every membership action and on both kinds of team link) and **cli from E on** (older CLIs get 400 `enrolment-required`). discord-clone, spotify, theater and cloud-drive gate on an unlocked identity, so their old bundles post the same keys and a pre-0.15 rollback still works, with their users back to published-SDK behaviour (X3, W10). Transcoder: dist-tag back to 0.3.9 loses poster enrichment only. |
| **E. Enforce signatures** | A new enable/enrol without a verifying signature → `400 {code:"enrolment-required"}`: a log entry on a log-enabled Space, or an intent (`seq:-1`, §5.3.3) on a Space without a log. Existing unsigned rows are left alone. Before E: the app-builder plugin with the signed-enable docs is republished (Matt asks), and the D-step grep finds no `/enable` beside `targetSpaceId` in app-builder or IDE-synced docs (CP11). | accelerator | Gates K1–K8 (§8.2), measured during E. | Redeploy the A0b-level build; 0.15 client checks are unaffected. |
| **K. Keeper off** | `/api/app/keeper` → `{pubkey:null, retired:true}` (tombstone written lazily when `keeper:identity` is absent). `__keeper__` wrap → 410. `KEEPER_ADMIT_MODE = "rescue"`: `keeperAdmit` runs only through the rescue row, from `join-request`; none in redeem or enrol (AV8). No runtime keeper fallback. `/keeper/ingest` and `/keeper/epochs` deleted; `/keeper/admit` kept for the rescue row. **`AGENT_LEGACY_UNADDRESSED = false`.** Transcript writer `v:2`. Ops: disable `@scanner` on `scanner`. | accelerator, ops | 48 h soak: no rise in `agent group key source:"none"` or `service-member-unverified` app logs; no support reports. `keeper admit` with `via:"rescue", wrote:true` reported per app (expected to fall as rescued Spaces gain a holder). | Redeploy the E build: escrow, keeper admission and legacy matching resume where `keeper:identity` is intact (lazily tombstoned apps had no keeper). **Last rollback point before R.** |
| **R. Retire** | `e2e-channels-migrate.mjs retire-keeper` per app (§8.3): dry run, review, real run, re-run purging 0. Sets `escrowRetired` rotations. Sole-copy Spaces are accepted **by id**, later and separately (Q7). | accelerator | Report reviewed; runbook h–k. | **One-way door.** The tombstone makes an accidental pre-K deploy fail closed (§8.3). Point-in-time restore of AppDOv1 is for emergencies only (it rewinds all app state). |
| **D. Docs and copy** | API reference ships with S. §5.8 privacy copy once K is in prod **and the §3.6 gate is live in prod** (probe: `/history` returns 403 for a non-member of a log-enabled private Space; SEC7). The claim "the server holds no usable key for member Spaces" only after R leaves no non-log `keeper:gk` rows outside a sole-copy list Matt accepted. | docs, website, connect | — | Revert the docs deploy. |

### 8.2 Gates before K

Checked in production for 7 consecutive days during E unless noted.

| Gate | Requirement |
|---|---|
| K1 | `keeper admit` with `hit:true, wrote:true, certified:false` = 0 per app, or Matt accepts a per-app list. It measures published-SDK clients that still rely on the keeper. It **cannot** see users who are inactive during E; they are covered by the verified sole-copy report (K6) and, after K, by the v1 import (§4.3), any key holder, and, in a Space with no verified holder, the rescue row (§4.5.2). First 0.15 opens (`certified:true`) are the intended rescue and are reported, not gated (CS-3). |
| K1b | `keeper admit` with `hit:true, keyChanged:true, certified:false` = 0 per app, or Matt accepts a per-app list (published-SDK members whose key changed, mostly web users without a passkey before P; after K they wait for a key holder). Standup is expected on the list: it runs 0.13.0 with no identity gate and, per the context, is left unchanged (CP10). |
| K2 | `agent group key` with `source:"keeper"` = 0 |
| K3 | `agent legacy match` with `fired:true` = 0 per app, or Matt accepts a list (old-SDK senders whose @mentions stop working) |
| K4 | cloud-drive, theater (with `scan` deployed and transcoder 0.4.0 published) and spotify 0.15 builds live in prod; web's identity gate live in prod |
| K5 | `agents-e2e` dry run: `enrolments.unsigned` = 0 on Spaces with an enrolled member (including `space-not-migrated`); `unsigned service member` log = 0; every app with agents has `ownerUsername` and, if it has editors, an `AppRoster` the owner published through the review dialog — or Matt accepts the list. Known noise, not a defect: an unsigned re-enable of an already-signed member also logs `unsigned service member` (residual of D8/D27; read the count against `enrolments.unsigned`, not the raw log count, when triaging this gate). |
| K6 | `retire-keeper` dry run reviewed, including `soleCopySpaces` (verified holders only) and `unmigratedPrivateWaiting` (joiners who will wait for an owner after K) (CS-9) and `unloggedPublicWaiting` (public Spaces without a log whose joiners wait after K until a key holder opens them on 0.15) (CP7) |
| K7 | Staging runbook f–g pass |
| K8 | `personal kv quota refused` with `keyClass:"identity"` = 0 over 7 days; with `keyClass:"cache"` reviewed (CS-4) |

### 8.3 Migration tooling, per-app retire, tombstone

**One script**: `accelerator/scripts/e2e-channels-migrate.mjs <agents|retire-keeper|report>
[--app <appId>] [--accept-sole-copy=<spaceId>[,<spaceId>…]]`. There is no blanket form: each
sole-copy Space is accepted by id, from a reviewed dry-run report (CS-3). Default is a dry run; a real
run needs
`CONFIRM=E2E-MIGRATE-<STAGING|PRODUCTION>` (the `wipe:staging` guard pattern). Apps come from the
durable `slug:` reservations in KEYS_CACHE (`acc/lib/kvKeys.ts`), walked as
`scripts/backfill-slug-reservations.mjs` does, unioned with `GET /api/admin/accounts`; apps found in
only one source are printed; soft-deleted apps are included (`developerDo.apps()`,
`acc/durable-objects/clients/developerDo.ts:21`). One admin route per app with
`Authorization: Bearer $ADMIN_API_KEY`. **Never smoke-test a real run**; read it, run only dry runs
outside a planned step.

| Admin route | Body → report |
|---|---|
| `…/agents-e2e` | `{dryRun}` → `{agents:[{agentId, handle, triggerTypes, enabledSpaces, answersOnlyWhenAddressedAfterK}], functions:[{functionId, name, mode, enabledSpaces}], enrolments:{total, signed, unsigned:[{memberId, spaceId, reason}]}, reenrolled:[{memberId, spaceId, keyed}], transcriptsPurged, svcCleanup:{spacesScanned, spacesCleaned, blobsDeleted, rotateDueSet, sources:{keeperRows, directory, enabled, transcripts}}}` |
| `…/keeper-retire` | `{dryRun, acceptSoleCopy?: string[]}` → the `keeper:retired` shape plus `soleCopySpaces:[{spaceId, epochsWithoutHolder}]` (verified holders only, §4.1.3), `spacesWithServiceMembers`, `unmigratedPrivateWaiting:[{spaceId, waiting}]` (private, not log-enabled, `waiting > 0`; CS-9), `unloggedPublicWaiting:[{spaceId, waiting}]` (public, not log-enabled, `waiting > 0`, filtered from the same probe fields; CP7) |

`report` re-runs both as dry runs across all apps and prints one table for the gate reviews.

**Per-app retire** (`KeeperFacet.handleRetire`):
1. Log-Space set `L` = `log:spaceId:{live,test}` ∪ the space in `channel:{live,test}:__logs__`.
2. Group `keeper:gk:` rows by Space. For each group not in `L`:
   1. Second signal: `GET space/access?member=__log__:<spaceId>` answering `creator:true` → skip.
   2. `spaceOwnerContext` null → delete rows, count `orphaned`.
   3. Sole-copy probe: intent `${spaceId}|__keeper__`, `POST /agent/escrow-retired {epoch:max,
      dryRun:true}` → `{holders:{[e]:count}, logEnabled, visibility, waiting}`, counting only humans
      with `holdsVerified(m, e)` (§4.1.3); the relay stops counting an epoch at its first holder. A
      blob written before A0a has no `tfp` and never counts (CS-3).
   4. Any escrowed epoch with 0 verified holders, for a Space whose id is not in `acceptSoleCopy` →
      keep rows, record in `soleCopy`. A private Space that is not log-enabled and has live `waiting:`
      rows is also listed in `unmigratedPrivateWaiting`. Kept rows are read only by the rescue row
      (§4.5.2); a Space rescued since the last run has a verified holder, so the next run purges them.
   5. Else `POST /agent/escrow-retired {epoch:max}` → sets `meta:escrowedThroughEpoch`, merges
      `rotateDue{reason:"escrow-retired", escrowRetired:true}` when `keyedEpoch ≤ max`.
   6. **Only on 2xx**, delete the rows and call `/agent/svc-cleanup`; else add to `failed`.
3. **Always** overwrite `keeper:identity` with the tombstone.
4. Delete leftover transcript arrays and `v:1` values; write `keeper:retired`.

**Tombstone** `{v:1, retired:true, encodedPub:null, at}` (`appKeys.keeperTombstone()`, golden). The
K build's `getKeeperIdentity()` returns it and never mints over it. Against it, **today's**
`KeeperFacet` returns `{pubkey:null}` from `handleKeeperPubkey` (published SDKs skip seeding,
`SpaceNamespace.ts:188-190`), fails ingest (no private key, 400), and finds no `gk` rows on admit:
the one-way door fails **closed** (critic C7).

**Point-in-time restore** of a SharedSpaceDO that has a log rolls the log back below its members'
high-water marks: their apps stop sending until each user confirms **Reset trust for this space**
(§9.1, SEC11).

### 8.4 Compatibility with published SDKs

Behaviours relied on (connect HEAD): keeper seeding is best effort (`SpaceNamespace.ts:186-193`);
`join()` returns false after 15 s (`Space.ts:559-573`); any `joinRequest` frame is auto-admitted
(`:754-763`) and any `keyringReady` triggers a pull (`:765-768`); non-2xx throws
(`KeyringClient.ts:32-40`); unknown frames and packet headers are ignored; `fetchBlobs`,
`fetchPending`, `fetchRoster` read one named field each (`KeyringClient.ts:52-71`).

| Client ↓ / server → | I … E | K onward |
|---|---|---|
| Published `createChannel` | seeds the keeper | gets `pubkey:null`, skips silently; the channel works |
| 0.15 `createChannel` | genesis + `ec(0)` + self-wrap; **no keeper seed** | same |
| Published join, nobody online | keeper admits at epoch 0; also in `waiting:` | `join()` false at 15 s; admitted when any key holder connects (N → T1) or posts; web polls forever, discord-clone and spotify need a reload until P |
| Published key holder | admits live and replayed frames; inactive or non-allowlisted targets get `200 dropped` | same |
| Published key holder in a log-enabled Space | still wraps to any frame the server sends (X3); an honest server broadcasts only certified humans and signed services | same |
| Published locked tab of a **certified** member | `refused-uncertified`: waits until updated or unlocked; its certified blob intact | same |
| Published locked tab of a legacy member | overwritten as today; the keeper re-admits | waits for a key holder (gate K1b) |
| Published redeem of a legacy link | allowlist, role, keeper admit, waiting; **on a log-enabled private Space: 409 `link-needs-upgrade`** | same, without keeper |
| Published redeem of a v2 link | non-2xx (correct for decision 2) | same |
| Published `invite` / `role` / `rotate` on a log-enabled Space | 409 (only the portal calls `invite`/`role`; no app rotates) | same |
| Published `admitPending` | reads the filtered `pending`; never aborts on a guaranteed 409 | same |
| Published member when a 0.15 client rotates the Space | **not wrapped** (it has no `keyCert`, so 0.15 rotators skip it with `unverified-member`); its backfill row lets another published holder of the new epoch admit it, and otherwise it regains access after its app upgrades. Rotations happen only when owed; within one app every user runs the same bundle, so this bites cached old bundles and the transcoder (gate K4). | same |
| Published sender @mentions an agent | legacy match fires when the packet is at `keyedEpoch`; after a 0.15 rotation a published sender holding only the older epoch is not forwarded (it cannot read the new epoch either, W10) | **agent silent** (K3) |
| Published sender, function in mode `all` | fires | fires |
| Published portal/CLI enable | unsigned; accepted until E; keeper bridge supplies the key | 400 `enrolment-required` |
| Published SDK receives `headers.to`, new frames, new response fields | ignored | ignored |
| 0.15 member, unsigned enrolment | no wrap; keeper supplies | agent deaf until re-signed (K5) |
| 0.15 against a pre-I server | unreachable in prod (release gate); on staging `ServerTooOldError`, no wraps | — |
| Transcoder 0.10.11, scan | works through the channel | enrichment lost silently (README) |
| Transcoder 0.10.11, media Space | keeper or personal cache | cache, or its own self-escrowed blob once theater 0.15 opened the Space |
| Template `^0.7.0-alpha.4` scaffolds | as a published SDK | same |
| Function code | payload gains `addressed` (additive) | same |
| VFS content Space (`messaging:false`) | unchanged | unchanged |
| Published tab of a removed member or non-member, log-enabled **private** Space (from P, when owners migrate) | an open socket is closed with 4403 at the removal; every later upgrade is refused before it opens (403); `/history` 403, posts refused; the tab retries every 3 s until reloaded (X9) | same |
| Published anonymous socket (app-key header, no ticket), log-enabled private Space | refused before the upgrade (401) | same |
| Published member of a log-enabled private Space | unchanged: it sends a session on HTTP and in its ticket | same |
| Published SDK in a Free app over its KV op cap | reserved SDK keys (`chat-keys`, `space-keys/*`) still read and write (§6.6a) | same |
| Published member with a v1 cache, first 0.15 open | the v1 cache is imported for legacy epochs and self-escrowed (§4.3) | same; the import is the recovery path once the keeper is off |
| 0.15 member whose own copies are dead, in a Space with no verified holder | the keeper re-admits (escrow rows) | re-admitted by the rescue row while the Space's rows are kept (§4.5.2); otherwise waits for a key holder |

**Stored data.** No Durable Object class is renamed or touched. No key is renamed. Value changes,
each with its reader first: the transcript (A0a reader, then A0b and K writers) and `keeper:identity`
(tombstone; the pre-K reader fails closed). Everything else is new keys or optional fields (including
`tfp` on stored blobs, which published SDKs ignore); the old `space-keys` collection is read once per
Space by 0.15 (§4.3 import) and never written or deleted by it. AppDOv1 and SharedSpaceDO are
SQLite-backed: point-in-time
restore can bring deleted keeper rows back for 30 days, and the docs say so.

---

## 9. Failure modes and UX states

### 9.1 UX states

| State / event | Copy / behaviour |
|---|---|
| `waiting` | "Waiting for a member to let you in…" (decision 4); expires after 14 days, re-posted on next open |
| `waiting` + `owner-migration` | "Waiting for the space owner to open this space in an updated app." (CS-9) |
| `orphaned` | "No one who can let you in has been here yet. You'll be let in when a member opens this channel." |
| `locked` | "Sign in again to read this channel." The action is the app's hosted sign-in (it returns here); a password field only for accounts with a password factor (CS-5). |
| `not-member` | "You're not a member of this private channel. Ask the owner to add you." Shown only after `/keyring/state` answers 403; a 4403 close alone never shows it (AV12). |
| `identity-mismatch` | "The owner added a different identity for you. Ask them to re-add you." |
| `integrity` | "This space's member list couldn't be verified. You can still read messages you already have; sending is paused." Optional action behind a confirmation, **Reset trust for this space**: "Only do this if you were told this space was restored from a backup. Your app will trust the member list it is shown now." It calls `client.trust.resetSpacePins(spaceId)` (SEC11). |
| `legacy-unverified` | "This space hasn't been upgraded by its owner yet. You can read it, but can't let anyone in." |
| `securing` | "A member was removed. Sending is paused until a member's app replaces this space's key." Reading continues; clears on the commit (SEC1). |
| `legacy-key` | Optional app label: "This space still uses its key from before the upgrade." Clears on the first committed rotation (SEC3). |
| `remove()` rejected with `rotation-blocked` | "Removed. Sending stays paused until a member's app can replace the key." |
| After a private removal or leave | "Invite links made before this change were turned off. Create a new link to keep inviting people." (SEC9) |
| Redeem refused `removed` | "You were removed from this space. Ask the owner to add you again." Admission `not-member`. |
| `identity-changed` (a peer) | "<name>'s identity key changed. Compare safety numbers before trusting them again." |
| Lookup or pin 5xx, directory 429 | "Couldn't verify members right now; retrying." |
| `refused` row | "<name>'s new device isn't verified yet." |
| Link without its fragment (409 `link-key-required`) | "This link is missing its key part. Ask for the full link." No membership is granted. |
| Link revoked, expired or used up | "This invite link is no longer valid." |
| Legacy link on a migrated private Space | "This link needs to be re-created by the space owner." |
| `link-unverified` | "This link couldn't be verified. Waiting for a member to let you in." |
| Link list `linkKeyState` | `locked`: "Sign in again to copy"; `lost`: **New link** (old stays live), then **Revoke old link** |
| Minting while locked | "Sign in again to create or copy invite links." |
| Agent enabled, `keyed:false` | CLI/portal: "…will start answering once a channel member comes online"; app log "<handle> is waiting for a channel member to share the key" |
| Agent enabled unsigned | CLI: "Enabled, but members' apps need your signature: run `muhkoo agents resign <appId>`."; portal banner |
| Agent on a space not yet upgraded | "The agent can join once a member (for a private space, its owner) opens this space in an updated app." (SEC3) |
| Agent in the member list | an ordinary member row; no banner (decision 5); "shared with @assistant" on addressed messages |
| Portal: the config Space's editor set differs from the latest `AppRoster` | Owner: banner **"Review app editors (N changes)"**; publishes only on click (SEC6) |
| Portal: signed-in editor not in the latest `AppRoster` | "Waiting for the app owner to confirm you as an editor." (CS-9) |
| Pin document missing | "Your saved trust records are missing." then `client.trust.resetSpacePins()` after confirmation |

### 9.2 Failure modes

| # | Situation | Handling |
|---|---|---|
| I1 | Server substitutes a joiner's chat key in pending, roster or frame | `keyCert` check fails; no wrap; `join-request {verification:"uncertified"}`. An honest relay also refuses a certificate the bound IK did not sign (§3.10). |
| I2 | Server adds an unsigned member or service member | not in the verified log; no wrap |
| I3 | Server drops or rolls back log entries | high-water or commit-head mismatch → `integrity`: no wraps, adoptions, rotations or sends until a sync passes through the high-water; reading continues |
| I4 | Server forks the log per client in a quiet Space | undetected until the forks meet (X4) |
| I5 | Server injects a group key (blob, v1 cache or v2 cache) | `keyCommit`/`ec`/`legacyCommits` or AEAD mismatch → rejected, re-request; a legacy key without a commitment is read-only |
| I6 | A pinned IK changes | hard stop, `identity-changed` |
| I7 | My `add` names a different IK | `identity-mismatch` |
| I8 | 5xx on pin doc, directory or log; 429 on directory | fail closed for new trust; reading continues with held keys. A 5xx on `chat-keys` is `IdentityUnavailableError`, retried on the next open (CS-4). |
| I9 | Log append race | 409 → re-sync, re-sign, ≤ 3 retries with jitter, then retry on the next frame |
| I10 | `ownerUsername` null | service members unsigned; portal banner for the owner |
| I11 | Two devices race `chat-keys` provisioning (`ChatKeyVault.ts`) | both keys certified; the loser re-provisions next session |
| I12 | Pin document deleted while a high-water mark exists | hard fail; `resetSpacePins()` after confirmation |
| I13 | Stolen session posts a garbage `keyCert`, or a log entry signed by a foreign key, or an `svc`/`retire` | relay: refused-uncertified with no `member:`/`joinreq:`/frame; 403 `identity-bound`; 403 `internal-op` (§3.6, §3.10); a first binding under an IK other than the account's registered IK → 403 `identity-not-registered` (log) or refused-uncertified (`keyCert`), and nothing is bound (SEC10) |
| I14 | An entry chains correctly but breaks its rule | no-op for clients and the mirror; never `integrity` (§3.7 item 5) |
| I15 | Server deletes or replays the sealed cache and serves a log below a removal this device applied | the IndexedDB `hw` wins → `integrity`, no seal; if IndexedDB was lost too, the device is protected only as a new device is (X4) |
| I16 | The pre-send log sync fails, or the client is offline | seals only if `head(E*) ≥ hw.humanRemovalSeq` and integrity is not broken; otherwise `rotation-pending` |
| I17 | Server shows a member a fork (a removal replaced by another chained entry) | that member rejects every commit made on the real chain past the fork, so it never holds, wraps or heals a post-removal key; commits it signs on its branch are rejected by everyone else (`commit-fork`, §4.2.5) |
| RT1 | Rotator dies before or after its self-wrap, before the commit | `keyedEpoch` unchanged, admission continues; after 2 min any holder supersedes; the superseded epoch is never served again and its blobs are deleted; a restarted rotator may resume via `?pending=1` |
| RT2 | Rotator dies after the commit, during fan-out | backfill `waiting:` rows; the next key holder's sweep heals; links heal via `/pending links[]` |
| RT3 | Two clients answer the same `rotateDue` | `ifCurrent`: one wins, the other pulls |
| RT4 | Hostile rotator commits `K` but wraps garbage | victims' `keyCommit` check fails → conflict reports → quorum → `rotateDue` → a holder of `prevKeyed` rotates. Detected and recovered, not prevented. |
| RT5 | Public rotator finds no verifiable second human | if other certified humans exist, the pre-check blocks before `/rotate` (no epoch burned) and the client waits for the head to move, a new admission, or 24 h; if none exist, it commits `sole` (CS-8) |
| RT6 | A removal lands between `rotate` and `rotate-commit` | 409 `membership-removed` → discard `K`, restart |
| RT7 | Old-SDK owner rotates | only on non-log-enabled Spaces (legacy one-phase); 409 on log-enabled |
| RT8 | Legacy Space with `currentEpoch > legacyKeyedEpoch` | `rotateDue{legacy-epoch-gap}`; gap epochs readable, never sealed at by 0.15 |
| RT9 | A removal-owed rotation cannot commit (the server 409s, or there is no second certified copy) | sends are refused with `rotation-pending` (fail closed); reading continues; retries per §4.2.8. A malicious server can keep a Space unable to send, as it can by dropping frames; it cannot make a 0.15 client seal under a key a removed member holds (SEC1). |
| RT10 | A removed member replays a commit signed at a pre-removal head | adopted for decryption only; never sealed under; sending waits for an honest commit (§4.2.5, SEC2) |
| W1 | No key holder ever comes online | `waiting`, or `orphaned` when none exists (decision 4) |
| W2 | Only old-SDK holders and none connects | bridge never fires; the joiner waits |
| W3 | A replayed frame reaches an old client before its cache loads | ignored; the next trigger catches it (bridge is best effort; the 0.15 sweep is reliable) |
| W4 | Two members admit at once | input gate serialises; the second gets 409 = done; `admitted` suppresses most duplicates |
| W5 | A member's blob no longer unwraps | `reason:"unwrap-failed"` → `needsReplace` → any holder replaces, however long the member waited; a member that still holds the key replaces its own blob at self-escrow (CS-3) |
| W6 | Old-SDK locked tab of a certified member | `refused-uncertified`; the tab waits for an update or unlock |
| W7 | Server substitutes or plants a joiner | 0.15 holders refuse; **old-SDK holders can still be induced to wrap** (X3) |
| W8 | Hostile member wraps a wrong key to a waiting joiner | committed epoch or committed legacy epoch: detected, re-requested; uncommitted legacy epoch: read-only, never sealed under |
| W9 | Allowlisted but no signed entry in a private Space | only during the migration window; 0.15 members report `not-signed-member`; legacy routes 409 afterwards |
| W10 | A published-SDK member when a 0.15 client rotates | skipped (no `keyCert`); reads resume after its app upgrades (§8.4) |
| W11 | A v1 cache entry is wrapped to a dead ephemeral key | skipped; the member recovers through the relay blob, the keeper (A0b–E, §4.5.2) or any key holder (`needsReplace`) (CS-2) |
| W12 | The server plants a v1 cache entry at a legacy epoch | adopted only where a planted relay blob would be (legacy epochs, whose keys the keeper already held), and sealed under only if the genesis commits to it; rejected if a loaded history packet at that epoch fails to open. Covered by X7. |
| W13 | Removed member's or non-member's socket on a log-enabled private Space | an open socket is closed with 4403; a new upgrade is refused before it opens (401/403), or closed with 4403 when it asked with `refuse=close`; no backlog, `/history` or posting (§3.6, D31) |
| W14 | Returning 0.15 member of a sole-copy Space after K | rescue row: keyed on its first `join-request`; the Space then has a verified holder, which admits later joiners (AV8) |
| L1 | Fragment stripped | 409 `link-key-required`; no membership |
| L2 | Same user redeems twice (reload, StrictMode) | idempotent via `linkuse:`; same blobs; no use counted, no second entry |
| L3 | Single-use link consumed, client crashes before unlocking | repeat redeem within 1 h returns the blobs; later it waits as a signed member |
| L4 | Link stale after a rotation, minter gone | any key holder's sweep heals it |
| L5 | Hostile holder heals a link with garbage | joiner's `keyCommit` check fails → waits, `link-unverified`; the creator may replace |
| L6 | Server plants a fake link target | no verified `link` entry → nobody wraps to it |
| L7 | Minter lost their identity | `linkKeyState:"lost"` → **New link**; old link live until revoked |
| L8 | Anyone holds a live link's `d` | receives future epochs until the link is unlinked, its creator is removed, or (private) any member is removed or leaves (X8) |
| L9 | Fragment exposure | never in a request or `Referer`; visible to page JavaScript, to wherever the URL is pasted, and possibly to local browser history |
| L10 | A removed member redeems any link, or a server appends its `redeem` | honest server: `403 removed`, no write; clients: `by ∈ S.removed` makes the entry a no-op, so no wrap; links minted before the removal are dead on both sides (SEC9) |
| M1 | Protocol traffic on the Free tier | unmetered frames; wraps batched 64 per metered request |
| M2 | Replay amplification in a large public channel | each waiting row is replayed to a socket at most once per connection, ≤ 20 rows per connection, only while someone waits; frames are unmetered, and a published holder's reaction (one roster GET plus one wrap per held epoch per row) is bounded by rows, not by time (CP8) |
| M3 | Undecryptable-frame queue overflows | oldest dropped; history paging recovers |
| M4 | Directory lookups rate-limited | own per-caller bucket; one batch call per 64 names; a 429 skips those targets and their backfill rows stay for a later sweep; sign-in is unaffected (CS-7) |
| M5 | Free-tier KV op cap | reserved SDK keys (§6.6a) are metered but never refused; identity keys also bypass the storage cap; cache writes happen only when the held-epoch set changes or a removal is applied (CS-4) |
| M6 | A 0.15 joiner waits for hours | frames drive it; one pull per reconnect and at most one per 5 min while visible; ≤ 20 metered requests an hour; `joinRequest` reaches ≤ 3 certified holders (CS-6) |
| M7 | A published tab is refused on a private Space | its upgrades are refused before they open, and it retries every 3 s, one metered ticket each (about 1,200 an hour) until reloaded (X9, D31) |
| G1 | Sender's directory stale, mention unresolved | one forced refresh, then `to:""`; the agent stays silent; no "shared with" marker |
| G2 | Published sender after K | agent does not fire (K3) |
| G3 | Malformed `to` | routed as unaddressed and logged; message still stored and broadcast |
| G4 | Unsigned enrolment, every online holder on 0.15 | no wraps; keeper covers until K; after K deaf until re-signed (K5) |
| G5 | Signer's IK changed | `service-member-unverified {reason:"lookup-failed"\|"bad-signature"}`; re-sign |
| G6 | A function's triggers widen without a re-sign | relay keeps the signed mode; update returns `resignRequired` |
| G7 | Relay → app push fails | best effort, no retry (as today) |
| G8 | First message after K in an idle agent Space | the agent may lack its copy; rate-limited "waiting" log; the next holder's sweep fixes it |
| G9 | Partial unenroll during delete | `unenrolled:false`; runtime self-heal; retry disable/delete |
| G10 | Old theater or transcoder builds after K | sends fail without a key; enrichment skipped; uploads unaffected |
| G11 | Rollback from A0b to a pre-A0 build | forbidden; roll back to A0a |
| G12 | App-key holder calls `/api/spaces/<S>/agent/enroll` for a Space the agent is not enabled on | refused by the vouch `enabled` check (today accepted, `agentControl.ts:213-218`) |
| G13 | `https://app/agent/event` reachable from outside | forged `keys` could drive tools; the router invariant test pins it closed |
| G14 | Log Space mistaken for a channel during retire | two independent signals; `postLog` and `/logs/admit` tested after retire |
| G15 | Retire partly fails for a Space | rows kept (after K read only by the rescue row), reported `failed`; re-run |
| G16 | A member re-posts an older or addressed packet to an agent | not forwarded unless at `keyedEpoch`; attributed to the replayer; non-members cannot post in private Spaces (§5.1.3, SEC5) |
| G17 | Enable on a Space with no log | An IK-signed intent is verified and not appended. The enrolment is unsigned (`space-not-migrated`), published holders key it, and 0.15 members wait for the re-sign once the Space has a log. No genesis through enable (SEC3). |

### 9.3 What this does not close (write it this way in docs and commits)

| # | Residual |
|---|---|
| X1 | **TOFU at first contact**: the directory lookup, a genesis first seen without a link, and the app owner without `trustAnchor`. Safety numbers detect it, and links close the genesis case. An honest relay binds a member only to the IK registered for the account, which the verified session context carries (§3.6), so a stolen session cannot bind its own IK or lock the account out of any Space. A malicious relay can bind anything: 0.15 clients refuse it (directory and pin); published admitters do not (X3) (SEC10). |
| X2 | **The app bundle.** For hosted apps the platform serves the code that runs these checks; they defend against a hostile relay, directory and storage while the code is honest. A self-hosted `trustAnchor` is independent of the platform. |
| X3 | **Published SDKs harvest keys** for A1 until every key holder in a Space runs 0.15 (`Space.ts:754-762`). |
| X4 | **Log forks in quiet Spaces** become detectable when a later entry crosses them, or when a commit signed on the other branch reaches a client (rejected, §4.2.5); there is no out-of-band head gossip. An app that has not seen a removal can keep sealing under a key the removed member holds: a quiet Space shown a fork, or a device that lost IndexedDB and is served an older sealed cache (SEC11). |
| X5 | **An ex-editor colluding with the server** can backdate an `svc` within the monotonic `rosterSeq` rule (Q5). |
| X6 | **Service members are platform-held keys** (decisions 5, 8). While one is active, the platform can read that Space at its current epoch. In a `static` Space, that key also opens history sent under the same epoch (SEC5). |
| X7 | **Migration TOFU, per Space.** Existing private allowlists (with roles) and public-channel genesis are trusted as the server presents them at migration, for that Space only; the keeper made the server fully trusted before, so within that Space this is not a regression. Migration never confers app-wide authority: an editor reaches the `AppRoster` only when the owner ticks them in the roster dialog (§5.3.1). An IK substituted in the directory at migration shows up only as a safety-number mismatch (X1). (SEC6) |
| X8 | **Anyone holding a live link fragment** receives future epochs until the link is unlinked, its creator is removed, or (private) any member is removed or leaves. After a private removal only links minted later are live (SEC9). |
| X9 | **Stale published-SDK tabs.** A published-SDK tab of a removed member or non-member reconnects every 3 s to a log-enabled private Space it may not enter; each attempt mints a metered ticket, about 1,200 requests an hour, until the tab is reloaded onto 0.15. It happens only in stale tabs (removal needs a 0.15 owner or editor, and within one app every user runs one bundle) and is measured by the `space socket refused` log at P (SEC1, Q14). |
| X10 | **A stolen session** (§5.3.9 R6). Two gaps remain until the old server copy is switched off (step K), as today: for an account that has never opened a space in the new version, it can get the old server helper to hand it that space's key; and with an app owner's or editor's login it can add an agent or function without a signature until step E, which updated apps never give the key but the old server helper does in a space still on its pre-upgrade key. With a developer's login it can also change what an existing agent or function does with the messages it decrypts, because the signature covers the member's keys, not its code. |

---

## 10. Test plan

### 10.1 Shared fixture

`accelerator/tests/fixtures/mlog-v1.json`, generated once in step I by `accelerator/scripts/gen-mlog-fixture.mjs` (its own encoder) and copied to `connect/tests/fixtures/mlog-v1.json` at step S (step-I plan D21): entries of
every op, an `EpochCommit`, a `keyCert`, an `AppRoster` and one enable intent (`seq:-1`, §5.3.3),
each with expected bytes, hash and a valid signature. Both repos assert byte-identical encoders
against it (§6.10).

### 10.2 accelerator, unit (`yarn test:unit`)

| File | Cases |
|---|---|
| `tests/space-mlog.test.ts` (new; `mlogCanonical` + validator) | structure, CAS and signatures against the fixture; the §3.5 authority matrix for private and public; mirror effects (`allow:`, `role:`, link cascade, `rotateDue`); legacy routes 409 only when log-enabled; `genesis` visibility/creator checks; `MAX_JOINS_PER_MEMBER`; Round 3: `base-epoch-mismatch`; malformed `legacyCommits` (unordered, above `baseEpoch`, more than 64, wrong length); a public migration genesis with empty `legacyCommits`, or by a writer without `holdsVerified`, → 403; a gap genesis merges `rotateDue legacy-epoch-gap`; a user `POST` of `svc`/`retire` → 403 `internal-op`; an owner-session `add` signed by a foreign key → 403 `identity-bound` and no `allow:`; `add` rebinds a cert-sourced binding and clears `removedSeq`; `join` by a bound member under another IK → 403 and never rebinds; a non-binding op by an unbound signer → 403; the mirror writes `ikbind` per §3.6; `closeNonMembers()` runs on private `genesis`/`remove`/`leave` |
| `tests/space-admission.test.ts` (new; pure helpers in `space/admission.ts`) | `rotateAuthority` (every §4.2.1 cell, stalled supersede, `identity-uncertified`, `membershipHead` CAS, `log-required`, legacy body owner-only and refused when log-enabled, `keeperSeeder` not an owner); `wrapEpochDecision` (ahead, abandoned, not established, pre-commit only for `rotation.by` and ≤ 64, legacy commit-on-first-wrap); `commitDecision` (no self-wrap, `needs-second-copy`, `sole` for solo/owner, refused otherwise, `superseded`, `membership-removed` only for removal-type entries, `ec` field checks); `blobVisible`; `legacyKeyedEpoch` ignores a planted `keyring:<other>:1`, counts keeper/creator/seeder; `joinRequestDecision` (every §3.10 row); `canReplace` (§4.5.4 incl. an 11-minute wait with `needsReplace`, refusal of an uncertified key); `filterPending` (unfulfillable dropped and deleted, uncertified → `refused`, unsigned services excluded); `selectReplay`; `conflictQuorum`; `keyHolderCount`; `canSeedKeeper` (no TOFU, founder accepted); Round 3: `commitDecision` certified-only (`sole` accepted when every other member is uncertified; refused when a certified other lacks a blob; a certified other with an unverified blob does not satisfy it; `ec.ik` must equal `ikbind`); `joinRequestDecision` with certificates (a certified member's session posting other keys with a garbage `keyCert` → `member:` unchanged, no `joinreq:`, no frame; a valid cert under an IK other than `ikbind` → refused-uncertified; an unbound member's first valid cert binds `src:"cert"`; no `keyCert` → the old rows; a stored cert whose IK differs from the binding counts as absent); `keeperAdmitDecision`, one case per row; `hasCert`/`holdsVerified` (matching `tfp` and cert; a §3.10 key change unverifies an old blob and decrements `keyHolders`; a published-admitter wrap stores no `tfp` and does not count; `orphaned` when only unverified blobs exist and no creator/founder/seeder; `isBridgeHolder` true for an unverified blob); `blobVisible`/`wrapEpochDecision` without an orphan list (a superseded epoch is neither served nor wrappable; after 40 stall/supersede cycles a 41st rotation commits) |
| `tests/space-links-helpers.test.ts` (new) | `redeemDecision`: missing/invalid `lsig` → 409 with **no writes**; repeat by a `linkuse` member counts no use and appends nothing; a new user after exhaustion → 403; grace window; `link-needs-upgrade`; `canWrapLinkBlob` (create by a holder, replace only by the creator/owner); `standingSupersede`; link entry vs body consistency (`expiresAt` skew, `keyCommits` epochs) |
| `tests/space-keys.test.ts` (new) | goldens for every §6.6 SharedSpaceDO key and `meta:` builder, plus today's `invite:`, `member:`, `keyring:`, `joinreq:`; Round 3: `ikbind:<m>`; the stored blob value with and without `tfp`; no `meta:orphanRanges` builder |
| `tests/app-keys.test.ts` | + goldens `trust:roster`, `trust:roster:<seq>`, `agentEnrol`, `fnEnrol(env,…)`, `keeperTombstone()`, `keeperRetired()`; existing `keeperGroupKey` and transcript goldens unchanged |
| `tests/space-helpers.test.ts` | `isReservedServicePrincipal` matches `__link__`, `__link__:x`, `__agent__`, `__fn__`; `roster.active` derivation |
| `tests/spacedo-metering.test.ts` (new) | `broadcast`/`sendToMember` with `metered:false` leave `pendingMessages` unchanged |
| `tests/agent-addressing.test.ts` (new) | `parseRouting` (absent → null, `""` → [], valid, > 8 ids, > 640 bytes, `__log__` id → []); `selectTargets` (addressed agent, function `all`, legacy on/off, unaddressed agent excluded, `__log__` excluded); `effectiveMode`; Round 3: an addressed packet at `keyedEpoch − 1` is not pushed; `keys` never holds another epoch |
| `tests/agent-runtime-facet.test.ts` (new, fake `AppCtx`) | an unaddressed agent target never reaches `unwrapSpaceKey` (spy); legacy push only while the flag is on; skill selection for addressed; seal at `keyedEpoch`; no `keeper:gk` read once the fallback is off; transcript version per §5.4; non-text body → no AI call, no dispatch; stale target → `postUnenroll`; Round 3: a body whose packet epoch differs from `keyedEpoch` never reaches `unwrapSpaceKey` (spy); the keeper fallback reads only `keeper:gk:<s>:<keyedEpoch>` |
| `tests/agent-transcript.test.ts` (new) | v1/v2 round trips; wrong epoch, swapped AAD, flipped bit fail; **the A0a reader given `{v:1}`/`{v:2}` yields `[]` and still posts**; the K reader deletes v1; per-turn cap |
| `tests/agent-runtime.test.ts` | `:28` → `null`; property test: manifest key bytes never appear in `extractText` output |
| `tests/svc-enrolment.test.ts` (new) | controller: mismatched signer, space, keys or mode rejected; `roster-required`; `enrolment-stale`; `body.space ?? body.spaceId`; Round 3: `prepare` has no `needsGenesis`; an enable on an unlogged public channel → `needsSignature space-not-migrated` and no genesis; a roster PUT with a foreign `ownerIk` → 403 `owner-ik-mismatch` |
| `tests/space-agent-keyring.test.ts` (new, fake relay ctx) | vouch refuses a Space outside `enabledSpaces`; enroll appends a signed entry and broadcasts; unsigned on a log-enabled Space: `waiting:{unsigned}`, no broadcast, wraps `200 dropped`; unenroll deletes blobs and `waiting:`, appends `retire`/`svc remove`, sets `rotateDue` (not `__log__`), adjusts bytes; `svc-cleanup` touches only unenrolled members; intent handshake required; Round 3: both cleanup passes delete enrolled services' copies below `keyedEpoch` |
| `tests/keeper-retire.test.ts` (new) | both log-Space signals; sole-copy kept without `acceptSoleCopy`, purged with it; rows kept on relay failure; **tombstone always written**; `dryRun` writes nothing; idempotent; transcript arrays and `v:1` deleted; Round 3: an unverified (dead-key) blob does not count as a holder; a sole-copy Space is purged only when its id is in `acceptSoleCopy`; a boolean `acceptSoleCopy` is rejected; `unmigratedPrivateWaiting` lists a private unlogged Space with waiters |
| `tests/keeper-tombstone.test.ts` (new) | **today's** `KeeperFacet` over a tombstoned store returns `{pubkey:null}`, never writes `keeper:identity`, 400 on ingest, 404 on admit |
| `tests/keeper-admit-log.test.ts` (new) | `keyChanged` only when a prior `member:` has a different `ecdhPub`; `via` per caller; Round 3: `wrote` and `certified` per `keeperAdmitDecision` row; a skip logs `wrote:false` |
| `tests/space-founder.test.ts` (new) | written once for public Spaces with a user context; never for private; never overwritten |
| `tests/platform-router.test.ts` | positions of `app-trust`, roster, identity, prepare routes; no route forwards to `https://app/agent/*` |
| Source guards | after K, `app/agentRuntime.ts`, `app/functionRuntime.ts`, `app/agents.ts` do not import `KEEPER_GK_PREFIX` |
| `tests/space-private-gate.test.ts` (new, fake ctx; SEC1) | `gated()` is true only with `meta:mlogHead` and `private`. A `__logs__`-shaped Space (private, no head): an upgrade with an owner ticket and no `allow:` is accepted, and `/history` with no user context returns 200. `closeNonMembers()` closes exactly the non-allowlisted and anonymous sessions and broadcasts `quit`. A refused upgrade never calls `state.acceptWebSocket`. |
| `tests/space-join-trigger.test.ts` (new; pure `selectJoinTriggerSockets`; CS-6) | published and unmarked sockets always included; ≤ 3 certified key holders, one socket each; non-holders never chosen |
| `tests/personal-kv-reserved.test.ts` (new; CS-4) | golden list; `sdkKvClass` for each exact key and each prefix; look-alikes (`chat-keys2`, `muhkoo.pins/other`, `space-keys`) → `app` |
| `tests/auth-identity.test.ts` (new, handler over fake storage; CS-7) | the batch returns keys and decoys; 65 names → 400; the 121st call by one session in the window → 429; a lookup never writes a `chal:` or `rl:chal:` key; 30 concurrent lookups of one username by 30 callers leave that username able to get a login challenge |

Round-4 additions (accelerator unit):
- `tests/space-mlog.test.ts` (SEC9, SEC10): a private `remove` cascades every live link (the owner's
  standing link, an editor's link, a single-use link: their `invite:`, `linkidx:`, `standing:`,
  `keyring:__link__:*` and `linkuse:*` rows gone, bytes reduced); `leave` cascades the same way;
  `remove` sets `ikbind:<m>.removedSeq`, `leave` does not; a link minted after the removal survives.
  For an unbound member, a public `join`, a private `redeem` or a public genesis whose `entry.ik`
  differs from the session IK → 403 `identity-not-registered`, with no `ikbind:` and no `mlog:` row;
  an equal IK binds; a context without `ik` → 503, nothing written; the creator's private genesis over
  its own certificate binding succeeds.
- `tests/space-admission.test.ts`: `joinRequestDecision` — an unbound member's valid certificate
  under an IK other than the session IK is Invalid (refused-uncertified, no `ikbind:`), and the real
  user's later certificate binds `src:"cert"` (SEC10); each "same keys" row stores a posted valid
  certificate when none is stored (blob → `admitted`, no `joinreq:`, no frame; `unwrap-failed` →
  `needsReplace` as before; no blob → stored), a legacy member posting the same keys never takes the
  broadcasting row, and `keyHolderCount` increments over a matching-`tfp` blob only (CP7).
  `keeperAdmitDecision` with `mode:"rescue"` writes when every condition holds and skips when
  `keyHolders.count` is 1, when its epoch ≠ `keyedEpoch`, for a newcomer, on `refused-uncertified`,
  when `keyCert.ik` ≠ the session IK, for `via` `redeem` or `enroll`, and for a log Space;
  `mode:"escrow"` is unchanged (AV8). `selectReplay`: a row once per connection, not the 21st row,
  again on a new connection, none to a blob-less user once `meta:epochCommit:<keyedEpoch>` exists
  (CP8).
- `tests/space-links-helpers.test.ts`: `redeemDecision` — a caller with `removedSeq` → 403 `removed`
  and no write, even holding a `linkuse:` row on a post-removal link; a member who left may redeem a
  link minted after the leave (SEC9). On a log-enabled Space, 16 legacy records do not count toward
  `MAX_LINKS_PER_MEMBER` and a v2 mint succeeds; the owner revokes a legacy record without an entry;
  a viewer who did not create it gets 403; a v2 record without an entry keeps the existing refusal
  (AV14).
- `tests/user-resolution.test.ts` (SEC10): `/verify` returning `ecdsaPublicKey` in b64 or hex gives
  the same context `ik`; the header and the `usersess:` entry carry it; an entry without `ik` still
  resolves with `ik` undefined; `userContextToHeader` includes `ik` only when present;
  `handleVerify` returns `ecdsaPublicKey` from the record.
- `tests/space-bridge.test.ts` (new, fake ctx): a `GET /keyring/roster` produces no replay frame
  (CP8). `tests/personal-kv-hlc.test.ts` (new): a put whose `hlc` equals the stored stamp answers
  `applied:false` and leaves the value; a greater stamp applies (CP9). `tests/keeper-admit-log.test.ts`:
  a `hit:false` evaluation logs `wrote:false` and is excluded from the A0b and K1b predicates, which
  `e2e-channels-migrate.mjs report` computes per app (CP10). `tests/keeper-retire.test.ts`: a Space
  rescued before a run is not in `soleCopySpaces` and is purged; a public unlogged Space with waiters
  is listed in `unloggedPublicWaiting` (AV8, CP7). `tests/platform-router.test.ts`: no route forwards
  to `https://app/keeper/admit`. Source guard: after K, `space/keyring.ts` calls `keeperAdmit` only
  from `join-request` (AV8).

Final-pass additions (accelerator unit; enable intent, §5.3.3):
- `tests/svc-enrolment.test.ts`, E build: on an unlogged public channel, a valid intent → 200 with
  `signed:false`, `needsSignature space-not-migrated`, `agentmember:` and `waiting:` (no `unsigned`),
  a `joinRequest` sent, and no `mlog:` row. The same request without an intent → 400. An intent signed
  by a non-session IK → 400. An intent on a log-enabled Space → 409 (a log entry is required).

### 10.3 accelerator, server (`describeServer`)

- **Membership**: owner adds B → B admitted by a member; editor adds a viewer; editor adding an editor
  → 403; `/keyring/invite` on a log-enabled Space → 409; a v2 redeem without `lsig` → 409 with no
  `allow:` row; a legacy link on a migrated private Space → 409 `link-needs-upgrade`.
- **Rotation** (`tests/space-rotation.test.ts`, new): v2 rotate → pre-commit wrap invisible to its
  target → commit → visible with a targeted `keyringReady`; commit without a second copy → 409; stale
  head → 409; a `remove` between rotate and commit → 409 `membership-removed`; stall with an injected
  clock → a second holder supersedes, commits, and a waiting joiner is keyed; conflict quorum →
  `rotateDue`; legacy owner rotation still one-phase on a non-log Space.
- `tests/space-fanout.test.ts:185`: move to an owner private Space; add the v2 cases; keep the NaN
  assertion. `:256` "keeper admits…": A0a–E also asserts the `waiting:` lifecycle; from K the joiner
  waits, a holder's wrap fulfils it and `pending` empties. `:325`: non-allowlisted wrap → 200 dropped.
- **Links** (`tests/space-links.test.ts`, new): keyed mint and redeem (no `waiting:`, no broadcast,
  self-wrap accepted); repeat redeem returns the same blobs with `uses` unchanged; heal by a
  non-minter holder; `lost` → New link → the old token still redeems; revoke cascade incl. `linkuse`;
  single-use deletes blobs after grace; public key-holder mint, standing idempotent, own-links list,
  caps; a session named `__link__` → 403.
- **Agents**: signed enable with a member online → `keyed:true`, reply with a sealed transcript; with
  nobody online → `keyed:false` until a member connects; unsigned enable → `signed:false`, no broadcast;
  after E → 400; addressed @mention gets a reply; an unaddressed message produces no `agent group key`
  line; legacy packet fires before K and not after; disable → `retire` + `rotateDue` → a 0.15 member
  rotates → the next push omits the agent; delete → unenrolled everywhere; a file message fires nothing.
- **K**: `__keeper__` wrap → 410; `/api/app/keeper` → `pubkey:null`; `/agent/escrow-retired` → 403
  without intent, 200 with, then `/metadata.rotateDue` set.
- **Billing**: the message counter is unchanged across a join-request, a replay, a rotation, a commit
  and an `mlog` append.
- **Removal and the private gate** (`tests/space-removal.test.ts`, new; SEC1): owner O adds B; B
  connects; O's `remove(B)` entry closes B's socket with 4403. B's next upgrade never opens (403), or
  gets 4403 with `refuse=close`, and no backlog frame either way. B's `GET /history` returns 403. An
  upgrade without a session never opens (401), or gets 4403 with `refuse=close`. A socket opened before
  the private genesis by a non-member is closed at genesis. A non-member's `spaceMessage` gets the
  error frame, writes no `msg:` row and causes no agent push (the error frame and the agent push are unit cases in
  `tests/space-private-gate.test.ts`, because over the public API a non-member never holds an accepted socket; the
  server suite checks that a refused socket's early frame writes no `msg:` row; step-I plan D19). A log-enabled **public** channel still
  accepts anonymous sockets. The portal Logs proxy still returns history.
- **Rotation, round 3**: `rotate-commit` deletes `keyring:__agent__:x:<old>` and adjusts bytes (SEC5);
  a removed member's `/rotate` and `/rotate-commit` return 403 from the existing private gate (SEC2).
- **Tier enforcement** (`tests/tier-enforcement.test.ts`; CS-4): with the Free app's KV read and write
  counters over the cap, `chat-keys`, `muhkoo.pins/identity-v1` and `space-keys-v2/<id>` still read and
  write (200) and the counters still increase; a non-reserved key gets 402; over the storage cap,
  `chat-keys` still writes and `space-keys-v2/<id>` gets 402.
- **Billing, round 3** (CS-6): 20 online 0.15 clients plus one public join produce ≤ 2N + 5 metered
  requests (N = 20); a 0.15 joiner waiting 1 h makes ≤ 20.
- **Round 4.** `tests/space-removal.test.ts` (SEC9, AV12): O mints standing link L, M redeems L, O
  removes M → M's repeat redeem of L is 404; O mints L2 → M's redeem is 403 `removed` and a
  newcomer's is admitted; the removal rotation's `/rotate` lists no `linkTargets` for L; O's link
  list no longer shows L; after O's `add(M)`, M redeems L2. `/history` on a gated Space without a
  session → 401, with a non-member session → 403. `tests/space-stolen-session.test.ts` (new; SEC10,
  AV11): holding only victim V's session token, in three public channels, a `join-request` with a
  certificate under IK_T and a `join` signed by IK_T are refused; the log shows no `join` by V and the
  roster keeps V's earlier keys; V's later 0.15 open is keyed and appends `join` under V's IK, with no
  operator step and no more `/verify` calls than the baseline. `tests/space-keeper-rescue.test.ts`
  (new, K build; AV8): in a public channel created by the `0.13.0` alias with the keeper seeded, member
  M whose only blob is wrapped to a dead key opens on 0.15 → keyed, one `keeper admit via:"rescue"
  wrote:true`, `/keyring/state.keyHolders` 1; a second dead-blob member and a newcomer are not rescued
  and are admitted by M's sweep; a certificate under a thief's IK is not rescued; after
  `keeper-retire` with `acceptSoleCopy:[S]` a further dead-blob member waits.
  `tests/space-upgrade.test.ts` (new; CP7): in a `0.13.0`-alias public channel with members A and B,
  A opens on 0.15 → one certificate post, genesis 200, `keyHolders` 1, `standingLink` mints; B never
  opens; A answers an `escrow-retired` due with one `/rotate` that commits `sole`; on the K build a
  new 0.15 joiner is admitted by A. **Billing** (CP8): a `0.13.0`-alias creator, keyless after a
  locked reload and polling every 500 ms for 10 minutes while one user waits, receives one replay
  frame per connection and makes at most one replay-caused roster GET; after a 0.15 commit it
  receives none.
- **Agents, final pass** (enable intent, §5.3.3): after the §10.4 intent case, a 0.15 member then
  writes the genesis; `service-member-unverified {reason:"unsigned"}` until `authorize`; after it, the
  member wraps.

### 10.4 Legacy-SDK matrix (`tests/legacy-sdk.test.ts`, new)

npm-alias devDependencies: `connect-legacy-0-10-11: npm:@muhkoo/connect@0.10.11-alpha.0`, `…0-10-14`,
`…0-13-0`, `…0-13-1`, and the latest `0.7.x`. Cases, per pin, before and after K where it matters:
- old `createChannel` makes no `console.warn`;
- old join with nobody online resolves unkeyed, and a later old member's connect admits it (N → T1);
- **a locked member reloads with a new key while nobody else is online**: admitted before K, waiting
  after K; if the member is certified: `refused-uncertified` and the certified blob untouched; a legacy member's new key is re-admitted by the keeper, wrapping to the stored key. For `0.13.0` and `0.10.14` this row is a hard A0b gate on staging (§8.1, CS-1);
- an old member adopts a rekeyed epoch on connect (targeted `keyringReady`);
- old `admitPending` never sees an uncertified or unsigned row;
- an old redeem of a legacy link sets allow and role; an old redeem of a v2 link → non-2xx;
- a channel created by an old SDK after K, joiner arrives while the creator is offline, creator only
  reads → admitted (founder replay);
- an old sender's @mention fires before K and not after;
- an old key holder in a log-enabled public channel still admits an old joiner (documented X3); a 0.15
  member does not admit a certificate-less joiner;
- transcoder `0.10.11` scan fails closed after `@scanner` is disabled, with no `createChannel` side
  effect.
- a published tab of a removed member of a log-enabled private Space is closed with 4403, gets 403
  on `/history`, and its reconnects are counted by `space socket refused` (X9);
- a published SDK in a Free app over its KV op cap still reads and writes `chat-keys` (§6.6a);
- a published creator holding only the pre-commit epoch, with rekey rows waiting, receives no replay
  and makes no wrap (CP8);
- in a `0.13.0`-alias channel after E, the 0.15 CLI enables a function in mode `all` (an enable
  intent, §5.3.3); a published holder wraps to it and it fires.

### 10.5 connect, unit

- `trust/canonical.test.ts`: every op's `opBytes`; LP injectivity (`"a","bc"` vs `"ab","c"`); hash
  ignores `sig`.
- `trust/chatCert.test.ts`: round trip; wrong username; swapped `ecdh` string; cross-curve import; a
  P-384 signature on a P-256 key fails.
- `trust/MembershipLog.test.ts`: §3.5 matrix; demoted editor's later `add` invalid; `remove` makes a
  rotation owed, public `leave` does not; `redeem` over `maxUses`, after `unlink`, or without `lsig`
  invalid; `svc` by owner, editor, non-editor, regressed `rosterSeq`; `retire` on a human invalid;
  truncated head, same-seq different hash, missing genesis after a pin → `integrity`.
- `trust/epochCommit.test.ts`: `keyCommit` domain separation; a valid-ECIES blob with the wrong key
  rejected; commit by a non-member rejected; a commit with `headSeq` = local head + 1 while the server
  log has advanced → one sync, adopted, no integrity, and a server whose log stays below `headSeq`
  after that sync → `integrity` (AV13); `e ≤ baseEpoch`
  accepted as legacy; `e > baseEpoch` without `ec` rejected.
- `trust/pins.spaces.test.ts`: SpecA's rollback and deletion harness on `spaces-v1`; genesis pin
  mismatch; `ao:` mismatch; roster seq rollback.
- `SpaceKeyring.test.ts` (`MemTransport` + `state`, log, statuses): rotate — self + 8 peers in one
  batch → commit → background fan-out; locked throws; `needs-second-copy` → retry → `rotation-blocked`;
  `superseded` / `membership-removed` → `K` discarded; `sole` only with no human targets; send during a
  rotation resolves after the commit (latency independent of a 2,000-member roster); sweep — gate
  refusal → no wrap + event; the frame key is never used; self-escrow writes missing epochs and never
  replaces with a different key; other-device clause gone; links healed only when verified;
  `adoptLinkKeys` — bad `lsig`, wrong `keyCommit`, epoch without commitment each fall back; locked →
  no `join-request`, `createChannel` throws; v2 cache forgery ignored; v1 cache imported once, for legacy epochs only (`e ≤ baseEpoch`, or any epoch without a log), ignored above `baseEpoch`, skipped when an entry does not unwrap, and never written back (CS-2).
- `Space.admission.test.ts` (fake timers): every `AdmissionState`, detail values, `admitted` dedupe,
  backoff, re-post before `expiresAt`, `cancelJoin`, `waitForKey` resolve/timeout/abort.
- Addressing: `addressees()` tokens, case, email-like false positives, unknown handle, refresh-once,
  cap; explicit `to` errors; `SpaceMessageEvent.to` parsing; unverified service members never resolve.
- `agents.enable` signs, re-prepares on 409 ≤ 3, throws `IdentityLockedError` when locked; §5.3.5 every
  rejection reason.
- Invite helpers: `lk` and `t` only in the fragment; `parseInviteUrl` ignores `lk` in the query;
  `captureInvite` stashes and scrubs; `pendingInvite` expires after 30 min; `ls` derivation
  deterministic from `d`; `wrapLinkSecret` round trip and domain separation; `linkKeyState` three cases;
  a v2 link without a key → `no-link-key` with no request; hosted `returnTo` rejects non-same-origin.
- `create()` leaves `/pending` empty; `createChannel` never requests `/api/app/keeper`;
  `KEEPER_MEMBER_ID` still exported; api-surface snapshots regenerated.

Round-3 additions:
- `Space.sealable.test.ts` (new; SEC1): a commit head at or after the removal seals. A commit head
  before the removal throws `rotation-pending`, and a spy shows `cipher.seal` is never called. A legacy
  `E*` followed by a human removal throws `rotation-pending`. After a service removal the client still
  seals, with a background rotation started. `editMessage` is refused the same way. The offline queue
  receives no frame while the rule fails. `remove()` resolves after the commit and rejects with
  `rotation-blocked` when blocked. On a Space without a log, `E*` is the highest held epoch. A client
  holding `keyedEpoch` only read-only gets `rotation-pending`; one not holding it gets `NotKeyedError`.
- `WSTransport.test.ts`: a close with 4403 and `terminalCloseCodes:[4403]` schedules no reconnect and
  emits `DISCONNECTED {code:4403}`; `resume()` reconnects through a fresh `urlProvider` call; a close
  with 1006 reconnects (AV12).
- `trust/epochCommit.test.ts`: M is removed at seq 10 and signs `ec(e)` with `headSeq` 9: it verifies
  and is adopted for decryption; `E*` is not sealable; sending throws `rotation-pending` (spy: no seal).
  A later honest `ec(e+1)` at `headSeq` 12 resumes sending at `e+1` (SEC2). A `legacyCommits` match is
  eligible for `E*`, a mismatch is rejected, a missing entry is adopted read-only and never sealed at;
  an `ec(e)` with `e ≤ baseEpoch` is ignored (SEC3).
- `trust/MembershipLog.test.ts`: `lastHumanRemovalSeq` is set by private `remove` and `leave` only
  (`svc remove`, `retire` and public `leave` leave it unchanged); an invalid chained entry is a no-op:
  the head advances, `S` is unchanged and `integrity` is not set (SEC4); an owner `leave` is invalid;
  with no editor, a viewer's `add` is invalid (CS-9).
- `SpaceKeyring.test.ts`: the v1 import on a Space with no log adopts every unwrapping epoch as legacy;
  on a log-enabled Space adopts `e ≤ baseEpoch` (committed or read-only) and drops `e > baseEpoch`; an
  entry wrapped to another key is skipped; a key that fails to open a loaded history packet is dropped;
  the import runs once (`v1Imported`), and a 5xx on the read retries next open (CS-2). Self-escrow
  rewrites a blob that fails to unwrap and a blob with no or a foreign `tfp`, and leaves a matching one
  alone (CS-3). A read-only key is never wrapped by the sweep and never put in a link (SEC3). In a
  public channel with 3 uncertified members, 5 sessions answering one `escrow-retired` due make exactly
  1 `/rotate`, which commits; with a certified but unverifiable peer, 5 sessions make 0 `/rotate` calls
  and one `rotation-blocked` each; a send with a non-removal due is not delayed (CS-8). `bindingsFor`
  over 100 unpinned members makes 2 transport calls; a 429 mid-fan-out stops the fan-out and leaves
  `waiting:` rows (CS-7). Opening, pulling and a head move write the sealed cache zero times; a
  rotation writes it once; the first application of a removal entry writes it once (CS-4, §11.6 M8).
- `Space.admission.test.ts`: one waiting joiner with an open socket for 1 h issues ≤ 20 transport
  calls; none while hidden; none in `orphaned` without a frame; one per reconnect (CS-6). An
  allowlisted joiner of a private Space with no log reports `waiting` + `owner-migration` (CS-9).
  `securing` takes precedence over `legacy-key`.
- `publishAppRoster` is never called implicitly (spy over `enable`, `authorize` and migration; SEC6).

Round-4 additions:
- `core/Client.withAppKey.test.ts` (new; SEC8): child requests carry `X-Muhkoo-Key: <pk>` and the
  parent's session token; `child.auth.zk.identity === parent.auth.zk.identity`; parent locked → the
  child's `createChannel` throws `IdentityLockedError` and `space.get` returns `admission:"locked"`
  with no `join-request`; after `parent.unlock()` the child's `createChannel` succeeds and its genesis
  verifies under the parent's IK; pins written through both in one sync make one `identity-v1` write;
  the child's session store never saves; after `parent.logout()` the child is not authenticated; the
  child cannot change `baseUrl`; the api-surface snapshots list `withAppKey`.
- `Space.sealable.test.ts` (SEC11): with integrity set, `sendMessage` and `editMessage` throw
  `SpaceTrustError{code:"integrity"}` and `cipher.seal` is never called, while a frame sealed before
  still flushes. Rollback: C applies `remove(M)` at seq 10 and reloads with IndexedDB intact; the
  server deletes `space-keys-v2/<id>`, serves the log to seq 9 and a pre-removal blob with its commit
  → integrity, no seal, no adoption, no `/keyring/rotate`. Cache replay (`headSeq` 9) with IndexedDB
  intact → the maximum keeps 10 → integrity. Log GET 503 at send time with `hw.humanRemovalSeq` 10:
  `head(E*)` 9 → `rotation-pending`; 12 → seals. The offline outbox seals under the same floor.
- `trust/MembershipLog.test.ts`: `hw.humanRemovalSeq` moves only on private `remove`/`leave` and never
  decreases; integrity clears when a later sync passes through `hw` and not before, and persists
  across a reload; two logs sharing one high-water store — B's sync issued at mark 10, A raises it to
  11 before B's response (head 10) arrives → no integrity; a response below the pre-request mark →
  integrity (SEC11, AV13). `linkLive` is false after a private `remove` or `leave` for links minted
  before it and true for later ones; a public `leave` kills nothing; a `redeem` by a member in
  `S.removed` is a no-op that advances the head, and after `add` the same member's `redeem` of a new
  link is valid (SEC9).
- `trust/pins.spaces.test.ts`: `resetSpacePins(spaceId)` clears only that Space's record; the next
  open TOFUs its genesis and integrity clears (SEC11). `trust/PinStore.test.ts` (CP9): two instances
  over a fake store implementing the `hlc` rule end in the union with no rollback; four
  `applied:false` answers fail that operation closed while held keys keep working; a pin POST without
  `hlc` fails the test; a read issued at mark 10 whose response (counter 10) arrives after the other
  instance raised the mark to 12 is not a rollback; a response below the pre-read mark hard-fails.
- `SpaceKeyring.test.ts`: a pre-removal link listed in `linkTargets` and `/pending links[]` gets no
  wrap from the rotation or the sweep (SEC9); a legacy member keyed from its cache posts exactly one
  `join-request` with `keyCert` per open, after the self-escrow batch and before the genesis, and none
  once its certificate is in the roster; a member whose row shows other keys posts before self-escrow
  (CP7); a `not-signed-member` refusal is never re-evaluated, and a row re-evaluated once and refused
  again waits for a new trigger (AV10).
- `Space.admission.test.ts` (AV12): a 4403 with `/keyring/state` 200 → one `resume()`, keyed, never
  `not-member`; 403 → `not-member` and no further ticket request; 401 → `locked`; two 4403s within
  60 s with state 200 → the second `resume()` waits for the bound; a reconnect whose ticket mint
  returns `null` with a session opens no ticketless URL (spy on `WebSocket`) and connects once the
  mint succeeds.
- Namespace methods (CP11): on a log-enabled private Space `client.space.setMemberRole` posts a `role`
  entry and never calls `/keyring/role`; `revokeInviteLink` posts `unlink` for a v2 record and none
  for a legacy one; both throw `IdentityLockedError` when locked; on a Space without a log both call
  the legacy routes.

Final-pass additions:
- `trust/epochCommit.test.ts` (commit fork, §4.2.5): (a) the chain has `remove(M)` at 10 (`h10`);
  `ec(e2)` by member C2 has `headSeq` 10 and `headHash ≠ h10` → not adopted; `E*` stays `e1`; the
  `cipher.seal` spy sees only `e1`; one `commit-fork` event. (b) The chain has a no-op at 10 (`x10`):
  the honest `ec(e1) {10, h10}` is not adopted, and a sweep with M's row pending posts no wrap naming
  M. (c) A matching hash is adopted (regression). (d) An `ec` signed by M at `headSeq` 10 on M's own
  branch is rejected.
- `agents.enable` with prepare `head:null` signs `seq:-1` and never calls `/keyring/log` (§5.3.3).

### 10.6 connect, wire (`Space.wire.test.ts`, FakeSpaceServer)

Honest mode: nobody online → `join()` false → a member connects and sweeps → `waiting` → `keyed`; a
replayed frame admitted; two sweepers leave one key; `autoAdmit:false` emits only; a `rotateDue` frame
rotates exactly once; a cache hit schedules `reconcile`; the rotator dies after its self-wrap → another
member supersedes → the waiting joiner is keyed; the rotator is killed before the link step → another
holder's sweep restores instant joins; a queued undecryptable frame is emitted after `keyringReady`;
a locked open posts nothing.

**Malicious mode** (A1): substituted pending key → no wrap; planted blob at `e+1` → not adopted;
dropped `remove` → `integrity`; planted `__agent__` → no wrap; fake link target → not wrapped; forged
`ec` signer → rejected; rolled-back roster → hard fail.

Round-3 wire cases. **Honest mode:** the legacy-matrix scenario of AV1 (the last keeper admit went to
an ephemeral key, the v1 cache holds a stable-key entry, no other holder, A0b keeper on) → the 0.15
open is keyed via the import and self-escrows a blob with a matching `tfp` (CS-2). The remover dies
between the `remove` and the commit: C's send rejects with `rotation-pending` and no packet at the old
epoch reaches the server; after `ROTATION_STALL_MS` C supersedes and commits, and the send succeeds at
the new epoch; B's socket is closed with 4403 and B's transport stops (SEC1). Migration: the server
reports `currentEpoch` 5 while the signer holds only epoch 0 → the genesis has `baseEpoch` 5 and
`legacyCommits {0}`; a planted `K'` at epoch 3 is read-only, `E*` is 0 and sends go out at 0 (with
`keyedEpoch` 0); a keyless private owner writes empty `legacyCommits`, the relay sets `rotateDue
legacy-epoch-gap`, the owner's flow rotates, members' sends throw `rotation-pending` before the commit
and succeed after it; `legacy-key` shows at 0 and clears after a rotation (SEC3).
**Malicious mode:** the server 409s every `rotate-commit` after a removal → C never seals and B
receives nothing new; the server accepts removed M's rotation and wraps M's `K` to everyone → no client
seals under `K`, and the first honest commit restores sending (SEC2).

Round-4 wire cases. **Honest mode** (AV10, CP7): holder H online and idle; J joins a log-enabled
public channel without a link → J's `join` precedes its `join-request`, and J is keyed within 5 s with
no reload; J joins a channel with no log, H's open writes the genesis, J posts `join` on the `mlog`
frame and H re-evaluates J once and wraps; H's first directory batch gets 429 with `Retry-After: 2` →
H wraps to J after 2 s with exactly one more lookup. The AV1 scenario ends with the member certified
(`keyHolders` 1) and the public genesis written. **Malicious mode:** the server keeps link L alive
after M's removal and appends M's `redeem` of it → no 0.15 client wraps a post-removal epoch to L, and
M counts as a member for no client (SEC9); the server truncates the log to seq 9 and replaces the
cache after C saw the removal at seq 10 → C sends nothing and M receives nothing sealed after seq 10
(SEC11).

Final-pass wire case. **Malicious mode** (commit fork, §4.2.5): 4 clients; the server forks one of
them after `remove(M)`. M's transport never receives a blob that unwraps to a key any non-forked client
seals under.

### 10.7 Portal, CLI, apps

Portal: team-Space migration emits `membership-bootstrapped`; roster publish on editor change; re-sign
banner lists and clears; legacy team link shows the re-create copy. CLI: `resign` loops signed enables;
`400 enrolment-required` prints the upgrade hint. Web: locked reload shows "Sign in again" and posts no
join request.

Round 3. Portal (SEC6, CS-9): migration with a server-inserted `role:editor` row → no `AppRoster`
names it without a click, and an `svc` entry it signs is rejected by 0.15 members
(`service-member-unverified {reason:"not-authorised"}`); an editor-set change shows the review banner
and publishes nothing until the owner acts; unticked candidates are absent from the published roster;
the editor banner shows for an editor missing from the roster and clears after the owner publishes.
Web and portal, Playwright in Brave (CS-5, CS-6): a Google-only account reloads web chat → `locked` →
one hosted round trip → back on `/chat#<room>` → keyed, with no join request while locked; a
Google-only portal owner reloads and enables an agent through a hosted round trip, and the enable is
signed; an account with a password factor sees the inline field and a Google-only one does not; a
waiting web tab makes no request between frames for 60 s.

Round 4. Portal, Playwright in Brave (SEC8, SEC9, CP11): a Google-only owner reloads, so the portal is
locked, and opens Collaborators → "Sign in again" and no `/api/spaces` request; one hosted round trip
returns to Collaborators; the genesis and member `add`s appear in the log; the owner mints a team link
carrying `#lk=`; a second browser redeems it through JoinSpace; an App Config role change posts a
signed `role` entry and a link revoke posts `unlink`; a removal is a signed entry, after which the old
links are gone and **New invite link** works; a locked collaborator opening a team link goes through
one hosted round trip and joins with the link intact; 20 clicks across Collaborators and App Config
create one `withAppKey` client per `pk`; no console "locked" error. Docs grep (D, and before E): no
`/enable` together with `targetSpaceId` in `app-builder/skills/**` or the IDE-synced copy (CP11).

### 10.8 Staging runbook (probe the deployed endpoint; Playwright in Brave where possible)

| After | Check |
|---|---|
| I | `POST /api/auth/identity` returns keys and decoys; `GET /keyring/log` 200/403; `PUT …/trust/roster` works for the owner, 403 otherwise; a signed enable returns `signed:true` (`tests/signed-enrolment.test.ts` against staging; KI5) |
| A0a | `keeper admit` log with `keyChanged` on a staged reload; `meta:founder` on a new public channel; `/keyring/state` gated; `/metadata` carries no member ids |
| A0b | a. `/metadata` has `keyedEpoch`. b. Legacy matrix passes with `BASE_URL=<staging> E2E_STAGING=1`. c. Web chat's agent replies, logs show `source:"member"`, an unmentioned message produces no `agent group key` line. d0. The §10.4 locked-reload rows for `0.13.0` and `0.10.14` pass on staging before A0b goes to prod (CS-1). |
| P-0 (staging drill, before P; CS-10) | Deploy web 0.15 to staging; open two channels unlocked and one reload locked; redeploy the 0.13 bundle. Record: an unlocked reload is keyed (§3.10 "same keys"); a locked reload is `refused-uncertified` and waits; a v2 link → non-2xx. Portal on a scratch app: a Google-only owner reloads (locked); Collaborators shows "Sign in again" and makes no Space call; one hosted round trip lands back on Collaborators and the team Space migrates through the `withAppKey` client (`GET /keyring/log`: genesis, one `add` per member; `membership-bootstrapped`). The owner mints a team link; a second account opens it signed out, signs in and becomes a member; the owner changes its role, then removes it (its socket closes 4403; links made before the removal are gone). Then redeploy the old portal and record 409 on invite, role, link-mint and legacy redeem. Put the observed states in the runbook next to the P rollback cell. |
| P | d. A creates a channel and closes the tab; B sees `waiting`/`orphaned`; A reopens; B is admitted without reloading. e. Same with B on a pinned old bundle. Link: A shares, B signed out opens → signs in → joins with no wait; the `lk` value appears in no request URL, header or body (auth.muhkoo.dev included). A keyed link with the fragment removed → "missing its key part" and `/keyring/members` shows no new member. Private: owner adds B → admitted; C not added → `not-member`. Rotation: A's tab killed between batch and commit → after 2 min B supersedes and a waiting C is admitted. Agents: portal enable is signed and the agent replies; old-CLI enable → `needsSignature`. Web locked reload → "Sign in again" → one hosted round trip → keyed, no join request while locked (CS-5). A user with no passkey reloads locked, signs in on 0.15 in a channel with no other live holder, and is keyed (keeper replace before K); `/keyring/state.keyHolders` then counts them (CS-3). Removal: owner removes B; B's tab closes (4403); C's send while the rotation is blocked shows `securing` and succeeds after the commit (SEC1). A waiting tab makes no request between frames for 60 s (CS-6). `space socket refused` counts reviewed (X9). Portal re-sign banner clears. Theater upload enriched via `scan`; transcoder 0.4.0 scans with no browser open. A member who holds a pre-0.15 public channel's key opens it on web 0.15: it becomes log-enabled on that open, `keyHolders ≥ 1`, and Share channel works (CP7). |
| K | f. `/api/app/keeper` → null; `__keeper__` wrap → 410. g. A new join with nobody online waits; cloud-drive on a **second** fresh browser with a stable identity and no other member online: upload succeeds (critic A3 runbook, modified: cloud-drive already blocks locked sessions, `cloud-drive/src/App.tsx:53`). An old bundle's @mention gets no reply. The transcoder opens its media Space with no browser and no keeper. k2. A staging channel whose only key copy is the keeper's, the member's own blob dead: after K the member opens on 0.15 and is keyed, and the next retire dry run no longer lists the channel (AV8). |
| R | h. Dry run, real run, re-run with `purgedKeys:0`. i. Portal Tools → Logs still streams. j. Opening an old channel whose other members are all uncertified rotates it `sole` and commits once (`keyedEpoch > escrowedThroughEpoch`); with a certified other member offline, the pre-commit batch wraps to it and commits; an old-bundle client then reads at the new epoch only after upgrading (W10) (CS-8). k. Sampled dry run finds no non-log `keeper:gk` rows outside `soleCopy`. **30 days after R**: count Spaces with `keyedEpoch ≤ escrowedThroughEpoch` (still readable via point-in-time restore). |

---

## 11. Decision log and open questions

### 11.1 Conflicts between the three v2 files, resolved

| # | Topic | v2-identity | v2-keys | v2-agents-migration | **Kept** and why |
|---|---|---|---|---|---|
| V1 | Keeper seed in 0.15 `createChannel` | rejected (unvouched server key) | compatible with keeping it | **kept** (so the server decides retirement; critic C4 option 1) | **No seed.** Decision 10 ("server alone must not" get keys; protection ships now) wins: a seeding 0.15 would hand A1 every channel created between S and K and void T1–T5 for them. Critic C4 is closed by its other option, now mandatory: I and A0b live in prod before `npm run release`. Cost: between P and K, old-SDK joiners into 0.15-created channels rely on the bridge (K behaviour, arriving early, covered by the legacy matrix). |
| V2 | Membership representation | one hash-chained log incl. `svc`, `link`, `redeem` | `link-join` statements via hook H4 | standalone `SvcEnrolment`/`SvcRemoval`, `svcenrol:`/`svcremoved:`, pinned removal seqs | **The log.** One mechanism gives ordering, removal visibility and T3; it closes v2-agents' replay residual R3 without per-client removal pins. |
| V3 | Epoch commitment | `keyId` 16 B, IK signature, `meta:epochcommit:<e>`, head always | `keyCommit` 32 B, chat-key signature, `membershipHead` private only, `prevKeyed`, `sole` | — | **Merged `EpochCommit`**: 32-byte `keyCommit` (2^128 vs 2^64 collision work), IK signature (verifies straight against the log's binding), head for every log-enabled Space, `prevKeyed`, `sole`; key `meta:epochCommit:<e>` (camelCase like other `meta:` keys). |
| V4 | Head compare-and-set for rotation | commit must equal the **current** head, else 409 and re-sign | CAS at `rotate`; commit equals the rotation's head | — | CAS at `rotate`; the commit binds that head and fails only if a **removal-type** entry landed after it. Under v2-identity's rule a busy public channel (constant `join`s) might never commit; additions are covered by the backfill, removals still force a restart. |
| V5 | Proof of the link fragment | `lsig` over log entries, `ls` derived from `d` | `linkAuth`/`authHash`, `grant`+`grantSig`, `signKeyBox`, `link-join` | — | **`lsig`**: one mechanism the server checks before writes **and** members verify later; no stored hash or encrypted key box. Kept from v2-keys: `keyCommits` in the link entry, `linkuse:` idempotency, grace window, `linkKeyState`, New link, token in the fragment, heal by any holder, `/pending links[]`. |
| V6 | Portal team links | fragment required | keyless (v1 D17) | follows the others | **Fragment required** (decision 10: a token the server knows must not yield private membership). Portal gets capture/`returnTo`. |
| V7 | Legacy redeem on a log-enabled private Space | 409 `link-needs-upgrade` | allowlist but unsigned (F-A9) | — | **409.** An allowlisted-but-unsigned member is admitted by old clients and refused by new ones; the server alone must not grant private membership. Owner-approval alternative is Q3. |
| V8 | Uncertified key for a certified member | `joinreq:`/`waiting:` and legacy broadcast still written | no `joinreq:`, no broadcast, `waiting:{uncertified}` | — | **v2-keys**: no replace window, and an honest server never invites old admitters to wrap to it. |
| V9 | Certificate field | `cert` | `keyCert` | — | **`keyCert`** |
| V10 | Human removal | `remove`/`leave` ops, rotation owed | "future, out of scope" | — | **In scope for private log-enabled Spaces** (the log defines it, rotation handles it, critic S8 link revocation included). Public: none. |
| V11 | Where heads and commits are served | `/metadata` (`mlogHead`, `keyedCommit`) | gated `/keyring/state` | `/metadata.rotateDue.escrowRetired` | **`/keyring/state`** for member-identifying data; `/metadata` carries only `keyedEpoch`, `rotateDue:{epoch, escrowRetired?}`, `escrowedThroughEpoch` (it is readable with the publishable key). |
| V12 | Commits route | in blobs/redeem responses | `GET /keyring/commits` | — | In `blobs`, `redeem` and `state`; no separate route. |
| V13 | Uncommitted epochs after migration | rejected when `e > baseEpoch` | adopted as legacy | — | **Rejected** on log-enabled Spaces (else A1 could plant a "legacy" epoch); the legacy one-phase rotate is refused there so honest flows never create one. Non-log Spaces adopt as legacy (`legacy-unverified`). |
| V14 | Epoch 0 commit | `ec` with the genesis | `rotate-commit {epoch:0}` after the self-wrap | — | **With the genesis**: one atomic request, no special case in `rotate-commit`. |
| V15 | Broadcast of unsigned enrolments | no broadcast on log-enabled Spaces | — | keep broadcasting all enrolments | **No broadcast, replay or `pending` for unsigned** on log-enabled Spaces, and wraps to them `200 dropped`; signed ones broadcast (decision 8's automatic admission); the keeper bridge covers unsigned until K. |
| V16 | Where enrolment certificates live | entry via enroll body | — | `svcenrol:` from the vouch; full cert in AppDOv1 | **Log entry via the enroll body** (the signature and the `prev` binding are what matter; the vouch still checks keys and `enabled`). AppDOv1 keeps a small index for reports. |
| V17 | Editor authority | owner-signed `AppRoster` | — | opaque `authority`, `verifyAppAuthority` | **`AppRoster`** |
| V18 | `mode` in the signed enrolment | absent | — | present | **Added to `svc` `opBytes`** (the developer's disclosure of "reads every message" is authentic) |
| V19 | App-owner anchor source | `ownerUsername` + directory | — | suggested `DeveloperRecord.ecdsaPublicKey` | **`ownerUsername` + directory**: one IK directory for users and developers |
| V20 | How portal/CLI sign | "through the existing SDK calls" | — | "sign through the SDK" | Neither is true today: both POST directly (`portal/src/lib/api.ts:604-616`, `cli/src/commands/agents.js:71-80`). **They must switch to the SDK** (§5.3.7). |
| V21 | Enrolment preparation | `prepare` route | — | reads `GET …/agents/:id` | **`prepare`**: the signer needs the Space head, and an owner/editor need not be a Space member, so it goes AppDOv1 → relay `enroll-prepare`. |
| V22 | Private link-mint authority | owner; editor viewer-only | creator or any editor | — | **v2-identity**, consistent with `add` |
| V23 | Public keyed-link mint | any joined member | `isKeyHolder` | — | **Both**: server `isKeyHolder`, clients "joined at the entry's position" |
| V24 | Rotation on a Space without a log | — | allowed | — | **409 `log-required`** (new): every committed epoch has a head to bind |
| V25 | "Denied" state | `not-member` | `denied` | — | **`not-member`**, plus `AdmissionDeniedError` for `waitForKey` |
| V26 | `joinRequest` frame carries a cert | yes | frame is only a trigger | — | **Frame unchanged**; `keyCert` travels in `/pending` |
| V27 | Release naming and the npm gate | steps 0–2; gate "log routes in prod" | v1 steps 0–4 | I, A0a, A0b, S, P, E, K, R, D; gate "I and A0b in prod" | **I…D**; v2-identity's step 0 is split into I (identity and log) and A0a/A0b; the npm gate combines both probes. |

### 11.2 Status of v1 decisions D1–D21

| v1 | Status in v2 |
|---|---|
| D1 who may rotate | kept, now two-phase and log-required (§4.2.1) |
| D2 `ifCurrent` | kept; required for v2 |
| D3 `meta:rotation` | kept; `v:2` shape |
| D4 one `rotateDue` | kept; clients also derive "owed" from the log |
| D5 `roster[].active` | kept |
| D6 `/metadata` + frame | **modified**: gated `/keyring/state` + frame; `/metadata` minimal (V11) |
| D7 `waiting:` index + backfill | kept; backfill now at commit |
| D8 `keyedEpoch` everywhere | kept; now the highest **committed** epoch |
| D9 bridge union | kept with `isBridgeHolder` |
| D10 `200 dropped` | kept; row 5 also drops unsigned services on log-enabled Spaces |
| D11 creator self-wrap | kept; plus genesis + `ec(0)` |
| D12 enrol writes `waiting:` | kept (`unsigned:true` excluded from pending/replay) |
| D13 agents admitting joiners | not in this release |
| D14 theater `scan` function | kept; plus transcoder 0.4.0 and keep-the-directory retirement |
| D15 transitional key source | kept, through E |
| D16 one migration script | kept; `report` subcommand added |
| D17 portal team links keyless | **reversed** (V6, decision 10) |
| D18 public link mint by key holders | kept (V23) |
| D19 `revokeLinksCreatedBy` dropped | **reversed, then widened**: private `remove`/`leave` revoke every link minted before them (critic S8; round 4 SEC9) |
| D20 keeper endpoints after K | kept; plus tombstone (critic C7) |
| D21 smaller calls | kept |

### 11.3 Critic disposition

#### 11.3.1 Round 1 (all 24 v1 findings)

`S` = security, `A` = availability, `C` = compat, numbered in `critiques.md` order.

| Finding | Disposition | Why / where |
|---|---|---|
| **S1** [blocking] one rotator can strand the key; `keeperSeeder` TOFU; `legacyKeyedEpoch` from any blob | **Adopted, extended** | Two-phase `rotate` → pre-commit batch → `rotate-commit` with the copy rule (a second human copy) and a signed `EpochCommit`; admission continues at the old epoch until the commit; stall supersede after 2 min (§4.2). Rotation needs the IK, so locked sessions cannot rotate (§3.3). TOFU write removed, seeder not an owner, `legacyKeyedEpoch` from keeper/creator/seeder evidence only (§4.1.4). Added: key-conflict quorum for a rotator that commits honestly but wraps garbage. Tests §10.2, §10.3, §10.6. |
| **S2** [blocking] an app editor can plant a platform-held member into any private Space | **Rejected where it conflicts with decision 8; replaced** | Decision 8 wins: no Space-owner approval, no server drop of signed service wraps, no `service-member-waiting` confirmation. Instead the owner or an editor signs an `svc` entry that 0.15 members verify, so the server alone cannot plant one (§5.3); honest-server hardening: unsigned enrolments on log-enabled Spaces are never broadcast, replayed or wrappable (V15); the agent vouch `enabled` bug is fixed (G12). Copy says the developer can add to private Spaces (§5.8). |
| **S3** [important] recipient-key binding | **Adopted, stronger** (decision 10) | `keyCert` under the pinned IK before every automatic wrap; certified keys never overwritten by uncertified ones (§3.10); owner-signed membership, signed `svc`, signed links. Renaming the gap is moot: it ships. Residual X3 stated. |
| **S4** [important] keyed links: the token alone gets the key | **Adopted, better mechanism** | `lsig` by a key derived from `d` is required before any write (§4.4.4); v1 Q2 answered **no**; the token moves into the fragment; F19 softened (L9). |
| **S5** [important] disabled agents leave working copies | **Adopted, extended** | Explicit `svc-cleanup` at A0b over four Space-id sources plus a lazy pass; `rotateDue` and `retire` wherever something is deleted; counts in the report (§5.5). |
| **S6** [important] copy claims in-memory-only decryption | **Modified** (decisions 9, 11 win) | Agents decrypt only addressed messages; functions in mode `all` decrypt every message; text may be stored by the model call or function code; files never. Never-claim list and a docs build guard (§5.8). The critic's "decrypts every message" wording for agents is replaced by decision 9. |
| **S7** [minor] G7 not true until each Space rotates | **Adopted** | G11 wording; owed rotations from the signed log (§4.2.8: human removals gate sealing, the rest run in the background); 30-day runbook count; point-in-time restore noted (§8.4). |
| **S8** [minor] removal must revoke the removed member's links | **Adopted, widened in round 4** | Private `remove`/`leave` kill every link minted before them, on server and clients (§3.5, §3.6, §4.4.8; SEC9); fragment-holder residual X8. |
| **A1** [blocking] rotator dies after its self-wrap | **Adopted, modified** | (1) No identity-less rotation. (2) One pre-commit batch: self, ≤ 8 humans with `online` first, every service, ≤ 16 links; then background order services, links, online, rest. (3) Stall escape by commit state (2 min) instead of counting holders, since the copy rule already guarantees a second holder. (4) The agent packet-epoch exception is **rejected**: a committed epoch always has a second human copy and the agent's copy is in the pre-commit batch. |
| **A2** [blocking] a locked session becomes a waiting joiner and poisons `member:` | **Adopted and strengthened** (decision 10) | `locked` for **every** locked session, not only known members (§3.3); the server refuses uncertified overwrites of certified members (§3.10); `reason:"unwrap-failed"` re-request (§4.5.8); the "admit my other devices" clause dropped. Decision 10 overrides the critic's "brand-new locked joiners keep F9". |
| **A3** [important] step-3 gate misses keeper admissions and the 0.10.x apps | **Adopted** | `keeper admit` log at A0a; gates K1, K1b, K4 (§8.2); runbook g modified because cloud-drive already gates locked sessions. |
| **A4** [important] key-distribution frames are metered | **Adopted, extended** | `metered:false`, targeted `keyringReady`, unmetered `admitted`/`epochCommitted`/`rotateDue`/`mlog`, and `/keyring/wraps` batching because each wrap is also a metered request (§4.5.5). |
| **A5** [important] large-channel rotation latency; dropped live frames | **Adopted, modified** | Send waits for one batch plus the commit (the commit needs a second copy, so not the self-wrap alone); bounded background fan-out; per-epoch undecryptable queue (§4.2.7, §4.5.11). |
| **A6** [important] standing links go stale | **Adopted, modified** | `/pending links[]`; any key holder may create (not replace) a link blob; the joiner checks `keyCommit` (or the link entry's `keyCommits`) instead of opening a history packet, which also works with no history (§4.4.6). |
| **A7** [important] retiring the keeper can delete the only copy | **Adopted** | Self-escrow on open (§4.5.9); `keyHolders`/`bridgeHolders`/`orphaned` (§4.5.7); sole-copy probe through `escrow-retired {dryRun}` rather than a new public `/keyring/holders` route (relay routes are reachable from outside); `acceptSoleCopy`; `soleCopy` recorded (§8.3). |
| **A8** [minor] redeem not idempotent | **Adopted, modified** | `linkuse:<linkId>:<m>` rows instead of a `redeemedBy` array (bounded by real uses, works for unlimited links); 1 h grace; no second log entry (§4.4.4). |
| **A9** [minor] Replace kills a published link | **Adopted** | `linkKeyState`; **New link** leaves the old link live; nothing revokes as a side effect (§4.4.7). |
| **C1** [blocking] step 3 removes re-admission of changed-key members; web is ephemeral | **Adopted via decision 10** | 0.15 never mints ephemeral keys; web gets an identity gate before any Space opens (§7.2); certified key changes are admitted through `keyCert`/`needsReplace`; `keyChanged` log and gate K1b; locked-member matrix row for every pin (§10.4). |
| **C2** [blocking] a waiting member with an existing blob can be re-keyed only within 10 min | **Adopted, reconciled with decision 10** | `needsReplace` allows a replace with no time limit, but only for the same bound key or a certified change (§4.5.4); `create()` order fixed (§4.5.10); `/pending` drops rows no wrap could fulfil (§4.5.3). |
| **C3** [important] transcript rollback mutes agents | **Adopted** (split) | A0a reader, A0b writer; A0b rolls back only to A0a; unit test (§5.4). |
| **C4** [important] 0.15 released before the server is ready | **Gate option adopted and made mandatory; "keep keeper seeding" rejected** | Decision 10 wins over the preferred option (V1). `npm run release` of 0.15 requires I and A0b live in prod, probed (§8.1). |
| **C5** [important] theater-transcoder missed | **Adopted** | Transcoder 0.4.0 through `functions.invoke`; the channel is retired by disabling the agent and keeping the directory entry; README note; `0.10.11` in the matrix (§5.9, §10.4). |
| **C6** [minor] old-SDK public creators never recognised | **Adopted** | `meta:founder` at A0a; `isBridgeHolder` for N and T1; N's condition becomes `isBridgeHolder`; matrix case (§4.1.4, §4.5.6). The founder may write a new public genesis but has no authority. |
| **C7** [minor] deleting `keeper:identity` fails open | **Adopted** | Tombstone at K (when absent) and at R; the pre-K reader fails closed; test against today's facet (§8.3). |

Where a Matt decision overrode a critic: S2 (decision 8), S6 (decisions 9, 11), A2's "keep F9" and C1's
premise (decision 10), C4's preferred option (decision 10), v1 Q2's default (decision 2).

#### 11.3.2 Round 2 (all 20 findings of `critiques-v2.md`)

Per-item detail is in the change-sets (`r3-security.md` §8, `r3-availcompat.md` §14); this table is
the consolidated result, after the §11.6 merge.

| Finding | Disposition | Where / why |
|---|---|---|
| **SEC1** [blocking] private-Space removal fails open | **Adopted, modified** | Client sealable rule in `sealMessage`, human removals only (§4.2.8, T8); a refused send throws `rotation-pending` instead of being queued (the outbox holds sealed frames, so queuing would put plaintext in IndexedDB); `Space.remove()` resolves on commit or rejects `rotation-blocked`; fallback kept for service removal, escrow-retired, key-conflict and legacy-gap rotations. Honest-server gate for log-enabled private Spaces: `/websocket` accepted then closed 4403, `/history` 403, posting refused, `closeNonMembers()` at private genesis, `remove`, `leave` (§3.6). Retries bounded (frames, ≤ 1 per 60 s) instead of a loop. Residual X9. |
| **SEC2** [blocking] EpochCommit replay | **Adopted (iv) as SEC1's rule; (i)–(iii) and the server check rejected** | Adoption is decrypt-only; sealing is decided by the sealable rule (§4.2.5). (ii) would refuse every commit for joiners of `rotate` Spaces; (i) and (iii) are redundant with (iv); the server check already exists (the remove mirror deletes `allow:`, and the private keyring gate refuses the removed member's `/rotate` and `/rotate-commit`). No conflict report: the Space goes `securing` and rotates through the owed path. |
| **SEC3** [blocking] migration genesis trusts server-chosen epochs | **Adopted, modified; item (3) rejected — decision 7 wins** | `legacyCommits` in the genesis (§3.5); `baseEpoch = currentEpoch`, enforced by the relay (`base-epoch-mismatch`); uncommitted legacy keys are read-only and never sealed under or wrapped onward (§4.2.5); public genesis only by a verified key holder; the enable-path genesis removed (§5.3.3); a keyless private owner migrates and rotates in the same flow (§3.8). Rotating every migrated Space on its first 0.15 send would cut off published-SDK members and transcoder 0.3.9 before K4, so the trigger stays the R signal and the Space shows `legacy-key` (§4.2.8, §1.2, G11). |
| **SEC4** [important] stolen session bypasses honest-server checks | **Adopted** | `ikbind:<m>` from the log or the first verified certificate (§3.6); certificates verified with WebCrypto, no `UserAuth` call; invalid certificate → refused-uncertified (§3.10); log entries must use the bound IK (`identity-bound`); `svc`/`retire` refused on the user route (`internal-op`); roster PUT requires the registered owner IK (§5.3.1); an invalid chained entry is a no-op, never `integrity` (§3.7). Verification moved from A0b to I (§11.6 M4). Since round 4, a first binding must equal the session IK (SEC10, §11.8). |
| **SEC5** [important] agent as a decryption or replay oracle | **Adopted (1)–(3); (4) IV cache rejected** | Relay forwards only packets at `keyedEpoch`, with one key; runtime epoch guard; `packetEpoch` dropped (§5.1.3–5.1.4, §6.3); services' older copies deleted at every commit and in the cleanup (§4.2.3 effect 8, §5.5); non-members cannot post (§3.6). Replays are attributed to the replayer, who can then only replay what it can already read; an in-memory LRU would be lost on eviction anyway. X6 narrowed to the current epoch. |
| **SEC6** [important] migration trust becomes app-wide authority | **(1) modified; (2), (3) adopted** | The owner confirms editors one by one in a "Review app editors" dialog, each beside a safety number, never automatically (§5.3.1, §7.2). Signing migrated editors as viewers was rejected: it would demote every existing editor at P, and app-wide `svc` authority is already gated by the roster click. X7 is scoped per Space. Decision 8 is unaffected: the owner confirms editors, not agents. |
| **SEC7** [minor] copy inaccuracies | **Adopted; (c) done both ways** | §5.8 copy: tools can store or forward text, the up-to-date-app and developer-identity qualifier, the hosted-code sentence, public-channel `to` visibility; §1.2 routing row; two new `check-claims` rules with a test; D waits for the `/history` gate probe (§8.1). |
| **AV1** [blocking] dead ephemeral blobs count as holders | **Adopted; K1b modified** | v1 cache import for legacy epochs (§4.3); keeper admit replace rules (§4.5.2); additive `tfp` and `holdsVerified` (§4.1.3, §6.5 row 8); self-escrow repairs its own dead blob (§4.5.9); sole-copy probe counts verified holders and acceptance is per Space id (§8.3); `wrote`/`certified` log fields; the A0b gate checks legacy re-admission and K1b measures published key changes (§8.1, §8.2). |
| **AV2** [blocking] Free KV op cap becomes a messaging outage | **Modified** | Reserved SDK keys are metered but never refused; identity keys also bypass the storage cap (§6.6a); the sealed cache is written only when held epochs change or a removal is applied (§4.3). IndexedDB copies of `chat-keys` and pins rejected: with the 402 gone, a 5xx is a general outage and a second local trust store adds state. Gate K8. |
| **AV3** [important] locked → password only | **Adopted; locked-rate telemetry gate rejected** | Hosted sign-in with `returnTo` is the locked action; the password field appears only with a password factor (§3.3, §7.2, §9.1). "Remember this browser" is the hosted page's existing browser-SSO opt-in. A locked-rate P gate would need new telemetry; Playwright checks and K1b cover it. |
| **AV4** [important] metered polling | **Adopted; metering exemption for keyring GETs rejected** | Frame-driven joiner with a 2 s and then 5-min fallback, paused while hidden, none in `orphaned` without a frame (§4.5.12); web's 500 ms `setInterval` replaced (§7.2); `mlog` syncs coalesced to 10 s (§3.7); `joinRequest` to published sockets plus ≤ 3 certified holders (§4.5.5); billing tests (§10.3). Exempting GETs would change billing. |
| **AV5** [important] directory lookups share the login bucket | **Adopted; rotation lookup cap modified** | Own per-caller bucket, never `chal:*`; batch of 64 (§6.1, §3.4); S3 re-checks `admitted` before any lookup (§4.5.9); the rotation looks up ≤ 32 candidates before `/rotate` and the fan-out stops at the first 429 (§4.2.7). SpecA §4.1 must be amended (Q15). |
| **AV6** [important] owed rotations loop; orphan cap undefined | **Adopted; `certifiedHumans` field and the `≥ 2` gate rejected** | Certified-only copy rule (§4.2.3); a pre-check before `/rotate` and a `rotationBlocked` record (§4.2.7); non-removal rotations run in the background (§4.2.8); `meta:orphanRanges` removed (§4.1.4, §6.5). The rotator already has `keyCert`s from `/keyring/roster`; a `≥ 2` gate would keep escrowed keys forever in solo channels. |
| **AV7** [minor] ownership transfer and absent owners | **Freeze made visible; transfer deferred; "members can add" rejected — decision 10 wins** | Owner absence documented (§3.5); `owner-migration` detail (§4.5.12); `unmigratedPrivateWaiting` in the retire report and K6 (§8.2, §8.3); portal editor banner (§7.2). Signing the roster when minting an editor link was rejected: the redeemer's IK is unknown at mint time. Transfer is a follow-up (§11.5, Q18). |
| **CP1** [blocking] `keeperAdmit` create-only at A0b | **Adopted, merged with AV1 item 3** | `keeperAdmitDecision`: legacy targets keep today's overwrite, certified members only under `needsReplace`, refused-uncertified skipped, always wrapping to the stored key (§4.5.2); locked-reload matrix rows are a hard A0b gate (§8.1). |
| **CP2** [blocking] v1 cache never read | **Adopted; sole-copy condition modified** | One-time import through §4.2.5's legacy rows (§4.3); the creator-blob condition on `--accept-sole-copy` is replaced by verified holders plus per-Space acceptance by id; Q7 and K1 reworded (§8.2, §11.4). |
| **CP3** [important] KV quota under 0.15 | **Adopted, merged with AV2** | §6.6a with `space-keys/*` included, so the import cannot be refused; log line; K8; ships in I. |
| **CP4** [important] P rollback has one-way doors | **Adopted** | The P rollback cell names web, portal and (from E) CLI; P-0 staging drill; portal last; the S row states a dist-tag rollback un-migrates nothing (§8.1, §10.8). |
| **CP5** [important] escrow-retired rotation loop | **Adopted, merged with AV6; orphan-range merge and `409 orphan-limit` rejected** | The orphan list is removed; a 409 at a cap would itself strand rotation. `rotationBlocked` lives in IndexedDB, not the sealed cache (no metered write). Certified-only sole rule for public **and** private Spaces. |
| **CP6** [minor] release train vs SpecA and Spec B | **Adopted, modified** | S ships alone; the shared modules freeze at their first release; either order allowed; a one-writer staging check in whichever ships second (§8.1, Q16). |

Where a Matt decision overrode a round-2 critic: SEC3 item (3) (decision 7, published SDKs keep
running); AV7 "members can add" (decision 10, owner/editor-signed membership). No fix conflicted with
decision 8: agents still need no Space-owner approval.

Round 3's findings (SEC8–SEC12, AV8–AV14, CP7–CP11) are disposed in §11.8.

### 11.4 Open questions for Matt

| # | Question | Default |
|---|---|---|
| Q1 | The `AppRoster` shows editors' **usernames** (and IKs) to the app's users. Alternative: IKs only, which makes "added by" less readable. | usernames included |
| Q2 | Write `trustAnchor` by default in the app-builder template and `muhkoo provision`? It removes app-owner TOFU for self-hosted and CLI builds. | yes |
| Q3 | Legacy (keyless) portal team links on a migrated private Space: 409 and the owner re-mints, or build an owner-approval flow? | 409, re-mint |
| Q4 | Every public-channel member self-signs a `join` entry (~300 bytes each, lazy verification) for visibility and fork evidence, versus certificates only (smaller, but the server can hide a joiner from everyone except the admitter). | `join` entries |
| Q5 | Accept residual X5 (ex-editor plus server backdating an `svc`) rather than expiring every enrolment when an editor is removed? | accept |
| Q6 | Agents whose triggers are only `keyword`/`regex`/`always` stop answering unaddressed messages at K. Accept (with the portal warning and report column), or have the SDK auto-address from published keyword rules (invisible to users)? | accept |
| Q7 | When to accept a sole-copy Space after R? | Never by default. Accept a Space by id only when its dry-run row shows it has no recent members, or Matt judges its history expendable. The report's activity data covers only users active during E, so "no new holders" alone is not a reason (CS-3). A Space whose member returns is rescued and leaves the list on its own (AV8). |
| Q8 | Third-party apps whose owners never re-sign (K5) or upgrade (K3): accept a list at K, or email owners and wait a fixed period? | email, then wait 14 days |
| Q9 | Knock requests: does decision 4's "requesting a private space" mean non-members should be able to ask? As designed they get `not-member` and the owner adds by username or link. | no knock in this release |
| Q10 | Rotate when an agent is added, so the platform never gets pre-agent history in `static` Spaces? Costs a rotation per enable, and the agent waits for a member. The copy states the exposure. | later |
| Q11 | Label pre-migration history in web ("messages before <date> were readable by the platform") using `epoch ≤ escrowedThroughEpoch`, and show `legacy-key` for a Space still sending under a pre-upgrade key? | yes, after R |
| Q12 | Gate lengths: 24 h A0a in prod, 24 h of the A0b keeper-admit check, 7 days of K1–K8 during E, 48 h K soak, 24 h of web in prod before the portal. | as stated |
| Q13 | Ship the function `addressed` trigger in this release? | yes |
| Q14 | X9: accept that a stale published tab refused on a private Space reconnects every 3 s (about 1,200 metered requests an hour), or also refuse socket-ticket minting for users without `allow:` on gated Spaces (a platform-route change with a relay lookup)? | accept; measure `space socket refused` at P and revisit if non-trivial |
| Q15 | CS-7 amends SpecA §4.1 (own per-caller bucket, batch form); CP9 amends SpecA §4.2 and §6.4 (`hlc`-stamped pin writes, reads checked against the pre-read mark). SpecA's text must match before the step that ships each. | §4.1 with step I; §4.2 and §6.4 with the first connect release that ships `PinStore` |
| Q16 | Release order: S first (this design builds `PinStore`, `IdentitySigner`, `IdentityLockedError`), or SpecA step 3 first? | whichever is ready first; the modules freeze at their first release (§8.1) |
| Q17 | Accept that migrated Spaces keep sending under their pre-upgrade key (`legacy-key`) until the R signal, as decision 7 requires, rather than rotating on the first 0.15 send? | accept |
| Q18 | Ownership transfer for private Spaces is deferred (none exists today). Accept for this release, with the portal's "appoint an editor" suggestion? | accept |
| Q19 | A private removal or leave turns off every invite link made before it, the owner's standing link included (SEC9), so outstanding invites must be re-sent. Accept, rather than trying to track which links the departing member could have seen (impossible for a link pasted into the channel)? | accept. **Accepted by Matt, 2026-09-27.** |
| Q20 | Offer **Reset trust for this space** (§9.1) to every user, behind its confirmation? It is the only way out of `integrity` after an honest restore; a user who clicks it after a real rollback re-trusts what the server shows. Alternative: only through support. | every user, behind the confirmation. **Accepted by Matt, 2026-09-27.** |

Resolved here rather than asked: signed enrolment in public channels too (v2-agents Q1; §5.3.8); keeper
seeding in 0.15 (V1); v1 Q2 (no, decision 2); v1 Q3 Phase-2 integrity (shipped now, decision 10);
v1 Q6 legacy links (§4.4.4, Q3 for team links only); v1 Q9 ephemeral joiners (removed, decision 10).
Round 3, resolved: no IV replay cache (SEC5); no `certifiedHumans` field in `/keyring/state` (AV6); no
IndexedDB copies of `chat-keys` or pins (AV2); no metering exemption for keyring GETs (AV4).
Round 4, resolved: no `UserAuth` lookup for any registered-IK check (session IK, SEC10); no rescue
recheck interval or stored field (AV8); no roster-GET bridge trigger (CP8).
Decided by Matt on 2026-09-27: Q19 and Q20, defaults accepted.
Deferred, not open: agents admitting waiting joiners (v1 Q1, D13).

### 11.5 Follow-ups (not in this sub-project)

Encrypt `agent:identity` / `fn:identity` at rest under a Worker secret; multi-space invite bundles
(discord-clone); knock requests (Q9); out-of-band head gossip for fork detection (X4); enforce
`proofEcdsaHash` at login (SpecA §4.1 recommendation; does not change what clients can verify);
closing WebSocket and `/history` delivery to non-members of private Spaces that are not log-enabled
(unmigrated private Spaces; `__logs__` keeps its owner reader) (SEC1); ownership transfer for private
Spaces (a `role {member, role:"owner"}` entry signed by the owner, demoting the previous owner to
editor; CS-9, Q18); refusing socket tickets to non-members of gated Spaces if X9 proves costly (Q14);
a later SDK that removes the published-SDK keeper call path entirely.

### 11.6 Round-3 merge: conflicts between the two change-sets, resolved

`r3-security.md` (SEC) and `r3-availcompat.md` (CS) were written in parallel against v2. Where they
overlapped or disagreed, this is what v3 keeps.

| # | Topic | Security change-set | Avail/compat change-set | **Kept** and why |
|---|---|---|---|---|
| M1 | Which owed rotations may touch a send (§4.2.8) | Only **human** removals gate sealing; service removals, escrow-retired, key-conflict and legacy-gap rotations run in the background and sends go out at `E*` | Any **removal-type** owed rotation, service removals included, may delay a send up to 10 s; the rest run in the background | **SEC's split.** Service removals join the background group. The platform held the service's key anyway (X6) and an honest server has already deleted its copies, so a 10 s wait changes nothing about what the send is sealed under. CS-8's principle — never delay a send for a reason that does not need it — is kept and extended. |
| M2 | Retry cadence of a removal-owed rotation | Retry on frames (`mlog`, `{ready}`, `rotateDue`, `epochCommitted`) and on a refused send at most once per 60 s | Suggested ≤ 1 per `ROTATION_STALL_MS` and only while a send is queued; pre-check before `/rotate`; retry after head move, admission or 24 h | **Merged.** SEC's triggers (plus `admitted`), all coalesced to one attempt per `REMOVAL_ROTATE_RETRY_MS` (60 s) per Space, each behind CS-8's pre-check, so no epoch is burned when no commit is possible. The 24 h wait applies only to non-removal rotations: sending is paused, so the client keeps listening. Nothing is ever queued (SEC), so "while a send is queued" does not apply. |
| M3 | The sending floor | SEC's replacement text for §4.2.8 dropped v2's "never seals at an epoch older than `keyedEpoch`", and a literal `E*` would have stopped every Space without a log from sending | Non-removal sends "go out at `keyedEpoch`" until the commit | **Merged.** The client seals at `E*` only when `E* ≥` the last `keyedEpoch` it saw; otherwise it pulls, then fails `NotKeyedError` (not held) or `rotation-pending` (held read-only). CS-8's "at `keyedEpoch`" reads "at `E*`". On a Space without a log, `E*` is the highest held legacy epoch. |
| M4 | What "has a `keyCert`" means | Relay verifies certificates against `ikbind`, but ships verification at A0b; a stored certificate whose IK differs from the binding counts as absent | CS-1, CS-3, CS-6 and CS-8 all key off `keyCert` **presence** | **One predicate, `hasCert(m)`** (§4.1.3), used everywhere. Verification moves to **I**, where storage starts: from I a certificate is stored only if it verifies; the refused-uncertified consequence stays at A0b with the rest of §3.10. Without the move, a garbage certificate posted during I–A0a under a victim's (public) IK would count as certified at A0b. |
| M5 | Who may write a public migration genesis | `by` has a blob at one of the `legacyCommits` epochs | Holders are only blobs the relay saw wrapped to the member's certified key | **CS's definition**: `holdsVerified(by, e)` for some `e` in `legacyCommits` (§3.6 step 4). Self-escrow runs first, so an honest writer always qualifies. |
| M6 | The v1 import × `legacyCommits` | Uncommitted legacy keys are read-only | Imported keys are adopted "as legacy" | **Merged.** Imports pass through SEC's rows unchanged (committed → may be `E*`; uncommitted → read-only). On an unlogged Space the import runs before self-escrow and before this client writes a migration genesis, so a migrating signer's `legacyCommits` include imported keys. A server-planted v1 entry before migration is committed exactly as a planted relay blob would be (X7, W12). |
| M7 | Self-escrow × read-only keys | Read-only keys are never wrapped to another member or a link | Self-escrow wraps every held, served epoch in static Spaces | **Merged.** Self-escrow includes read-only epochs (the wrap is to oneself and keeps one's own history readable); the sweep's step 6 and link minting exclude them (§4.5.9, §4.4.3). |
| M8 | Heads in the sealed cache × the sealable rule | The sealable rule depends on the last human removal a device saw | The sealed cache is written only when held epochs change; "every removal forces a rotation and so a cache write" | **Merged.** The cache is also written when a removal-type entry is first applied (rare: one KV write per removal), so a device that loses IndexedDB still honours every removal it saw. CS-4's claim held only once the owed rotation had committed. **Round-4 correction (SEC11):** the server can replay an older AEAD-valid cache, so this holds only while IndexedDB survives; `hw.humanRemovalSeq` is persisted beside the head and integrity pauses sealing (§3.7). |
| M9 | Step placement of `tfp` | Effect 8 and `rotate-commit` ship at A0a | `tfp` in the A0b wrap pipeline, but the certified copy rule at `rotate-commit` (A0a) needs `holdsVerified` | **`tfp` is written from A0a** (an additive field published SDKs ignore), so blobs stored during A0a also count at R; each consumer of holder semantics applies it where it ships. |
| M10 | Admission `detail` values and `join()` stop conditions | Adds `securing`, `legacy-key`, and the 4403 terminal close | Adds `owner-migration`; rewrites `join()` wake-ups and fallback timers | **One union** (§4.5.12): `securing` takes precedence over `legacy-key`; `owner-migration` applies only while waiting; `join()` also stops on a 4403 close (since round 4, only once `/keyring/state` confirms it, AV12). |
| M11 | Two uses of the name `rotation-blocked` | `SpaceTrustError{code:"rotation-blocked", seq}` rejects `Space.remove()` | `rotation-blocked {reason}` event when a rotation is not started or cannot commit | **Both kept**: the error is what `remove()` rejects with; the event reports why a rotation did not run (§6.9). |

Composition notes (consistent, no conflict): SEC1's RT9 depends on CS-8's certified-only copy rule,
and both are adopted, so a non-owner remover in a Space whose other members are all uncertified can
commit `sole`. SEC6's explicit roster publish and CS-9's "waiting for the app owner" banner are the two
sides of one flow. SEC5's deletion of services' older copies does not touch holder counts, which
exclude services. SEC3's read-only keys and CS-2's import both preserve decision 7 (published SDKs keep
running): neither rotates a Space before R.

### 11.7 Round-4 merge: conflicts between the two change-sets, resolved

`r4-security.md` (SEC8–SEC12) and `r4-availcompat.md` (R4-1–R4-11) were written in parallel against
v3. Neither conflicts with decisions 1–11; the only precedence applied is the context's "ignore
standup" (CP10, §11.8). Where they overlapped, v4 keeps:

| # | Topic | Security change-set | Avail/compat change-set | **Kept** and why |
|---|---|---|---|---|
| N1 | Portal per-app client (SEC8 = AV9) | `client.withAppKey(pk)` sharing `SessionState`, `ChatKeyVault`, `PinStore` and `IdentitySigner` by reference; `baseUrl` inherited | Mechanism left to security; portal rollout; one client per `pk`, memoised | **Security's mechanism, avail's rollout** (§6.9, §7.2). Memoising is one clause and saves re-reading both pin documents and `chat-keys` on every click. |
| N2 | A child Space opened while the parent is locked | stays `locked` until reopened | the parent's `unlock()` resumes it (test) | **Security's.** The portal checks `isUnlocked()` before building a child, so no caller opens one locked; wiring the parent's unlock event into children is code with no user. The avail test line is dropped. |
| N3 | Portal action while locked | "Sign in again to manage this space" with a button | start the hosted sign-in | **The button**: the same pattern as web's `locked` state (§9.1), no redirect on page load, still one hosted round trip. |
| N4 | Source of the registered IK (SEC10 = AV11; AV8's rescue row) | the existing `/verify` response carries it into the session context; no new `UserAuth` call | a `registeredIk(username)` point read with `RESCUE_RECHECK_MS` and `waiting:<m>.rescueCheckedAt`; the critic's lookup per first binding | **Security's.** The rescue row runs on the member's own `join-request`, so it compares `keyCert.ik` with that request's session IK; the helper, constant and stored field are dropped. The roster PUT and the enable controller use the same field (security's optional simplification, adopted), which removes their lookups too. |
| N5 | Integrity trigger and exit (SEC11, AV13) | integrity pauses sealing; re-evaluated on every sync; per-Space reset; the commit re-sync folded in | the commit re-sync; heads compared with the mark read before the request (tabs share `hw`) | **One §3.7 item 3**: avail's trigger clauses (safe across tabs) with security's consequence, removal floor and exit. Both ship in S: without AV13's exact triggers, SEC11 would turn an honest race into a paused composer. |
| N6 | Removal cascade (SEC9) × legacy team links (AV14) | every `linkidx:*` at a private removal | legacy records not live, revoked without an entry | **Both.** Legacy records have no `linkidx:`, `linkuse:` or blobs and cannot be redeemed on a log-enabled private Space (409), so they carry nothing to a removed member. |
| N7 | Pin writers (SEC8 × CP9) | one shared `PinStore` per tab | `hlc`-stamped compare-and-set | **Both**: sharing removes the in-tab race; the stamp covers other tabs, apps and devices. |
| N8 | Step placement (SEC10 × CP7) | session-IK binding in I | the §3.10 "same keys" certificate cells in I, relying on SEC10 for a victim whose binding a thief took first | **Both in I.** A thief can no longer bind first, so CP7 has no victim case. |

### 11.8 Critic disposition, round 3 (all 17 findings of `critiques-v3.md`)

Per-item replacement text and tests are in `r4-security.md` §1–§7 and `r4-availcompat.md` R4-1–R4-11;
this is the consolidated result after the §11.7 merge.
Where the context or a Matt decision overrode a round-3 critic fix: CP10 (standup is listed, never
changed). No other fix conflicts with decisions 1–11, and none adds a Space-owner approval step for
agents (decision 8).

| Finding | Disposition | Where / why |
|---|---|---|
| **SEC8** [blocking] the portal's per-app `Client` never has the seed, so every team-Space and App Config call is `locked` | **Adopted, equivalent mechanism** | `client.withAppKey(pk)` instead of the critic's `identityFrom` option: it shares the parent's identity objects by reference and inherits `baseUrl`, so the session token cannot reach another origin; the portal uses one per `pk` behind an `isUnlocked()` gate (§3.3, §6.9, §7.1, §7.2, §8.1 P, §10.8 P-0). Decision 10: the identity is shared, never minted. |
| **SEC9** [blocking] a removed member keeps getting keys through a link it redeemed; `redeem` has no membership check | **Adopted, widened** | A private `remove` or `leave` kills every link minted before it: the relay cascades every `linkidx:*`, and clients add `seq > S.lastHumanRemovalSeq` to link liveness. `redeem` refuses `ikbind:<m>.removedSeq` (403 `removed`); clients add `S.removed` (§3.5, §3.6, §4.4.4, §4.4.8). Wider than "links created or redeemed", because a pasted link never shows in the log. Decisions 2 and 3 hold: the standing link is re-minted (Q19). |
| **SEC10** [blocking] a stolen session binds its own IK first and locks the victim out of public channels | **Adopted, smaller mechanism** | The existing `/verify` carries the registered IK into the session context; every self-sourced first binding must equal it (403 `identity-not-registered`), so the lockout cannot start. No rebinding, no relay state, no new `UserAuth` call; the private-genesis exception is deleted (§3.6, §3.10, §6.3). Decision 10. |
| **SEC11** [blocking] `integrity:"broken"` does not stop sealing, so a log rollback un-removes | **Adopted, plus one persisted integer** | Integrity pauses sealing, is re-evaluated on every sync and clears through `hw` or `resetSpacePins(spaceId)`; `hw.humanRemovalSeq` in IndexedDB and the sealed cache feeds the sealable rule, covering sends after a failed sync or offline; M8 corrected (§3.7, §4.2.8, §4.3, §9.1). Residual X4 restated. |
| **SEC12** [minor] disposition check (no defect) | **Noted** | Findings 1–4 adopted as above; nothing overrides decisions 8, 9 or 11; the §5.8 copy is unchanged. |
| **AV8** [blocking] sole-copy Spaces lose their only reader at K | **Adopted, modified** | One rescue row of `keeperAdmitDecision` after K, from `join-request` only; `/keeper/admit` kept. It compares `keyCert.ik` with the session IK (SEC10) instead of a lookup, so it needs no recheck interval or stored field; it closes itself per Space (§4.5.2, §8.1 K, §8.2 K1). Decision 1: it reads only rows §1.2 already keeps and escrows nothing new. |
| **AV9** [blocking] portal per-app client | **Deduplicated into SEC8; rollout adopted** | Memoised per `pk`, the unlock gate, the P-0 drill, the P gate and the tests (§7.2, §10.7, §10.8). |
| **AV10** [important] online holders refuse a public joiner as `not-joined` | **Adopted** | `join` before `join-request`; one in-memory re-evaluation of transient refusals (§4.5.1, §4.5.8, §4.5.9). |
| **AV11** [important] a stolen session binds first | **Deduplicated into SEC10** | The lookup-based fix is superseded; its two availability properties (the victim is keyed on its next open with no operator; no per-request `UserAuth` call) are tested (§10.3). |
| **AV12** [important] a ticket failure becomes a terminal `not-member` | **Adopted, modified** | A 4403 pauses the transport and `/keyring/state` decides; no ticketless reconnect (the first connect keeps today's path); `/history` answers 401 vs 403 (§3.6, §6.9, §9.1). |
| **AV13** [minor] an honest race sets `integrity` | **Adopted, extended; required by SEC11** | A commit check re-syncs first; heads are compared with the mark read before the request, which also covers two tabs (§3.7). |
| **AV14** [minor] legacy team links block a v2 mint | **Adopted** | Not live on a log-enabled Space, not counted, revocable without an entry (§4.4.2, §4.4.8). |
| **CP7** [blocking] existing members never become certified | **Adopted** | A 0.15 member posts its `keyCert` on first open even when keyed; the "same keys" rows store it and count it in `keyHolders`; a public migration needs only the migrating member; `unloggedPublicWaiting` reported (§3.10, §4.5.7, §4.5.9, §8.3). Closes consequences (1)–(6) of the finding. |
| **CP8** [important] the bridge forms a metered loop with published SDKs | **Adopted, simplified** | Trigger T2 and `REPLAY_COOLDOWN_MS` removed; each row replayed at most once per connection; no replay to a blob-less user after a 0.15 commit (§4.5.6). |
| **CP9** [important] the pin documents have no compare-and-set | **Adopted, extended** | `hlc = dec(counter)` makes the existing `applied:false` check a compare-and-set; reads compared with the pre-read mark; SpecA amended (Q15); a concurrency gate on staging (§3.4, §8.1). |
| **CP10** [minor] two gates cannot reach 0 | **Adopted; the context wins on standup** | `hit:true` in the A0b gate and K1b; K1b per app with an accepted list. Standup is expected on that list and is never changed (context: ignore standup) (§8.1, §8.2). |
| **CP11** [minor] namespace membership methods and app-builder docs missed | **Adopted** | `setMemberRole` and `revokeInviteLink` sign on log-enabled Spaces; `provisioning.md` uses signed enable; the plugin is republished before E, when Matt asks (§6.9, §7.2, §8.1 E). |

### 11.9 Step-I plan decisions (2026-09-28)

The step-I implementation plan (`accelerator/docs/superpowers/plans/2026-09-28-e2e-channels-step-i.md`,
File Structure, Decisions) settles these points where this document was silent or differed. The sections
above are amended where they named the behaviour.

| # | Decision |
|---|---|
| D1 | Two derived relay keys: `meta:mlogState` and `mlogmember:<m>` (§6.6), so the mirror never scans `mlog:`. |
| D2 | `POST /keyring/log` refuses `link`, `unlink`, `redeem` and `join` with `via ≠ ""` (400 `link-route-required`); they arrive through the link routes (A0a). |
| D3 | "genesis if and only if seq 0" is an authority rule (403 `not-authorised`, `genesis-seq`), not structure, so the §8.1 foreign-key probe reaches the identity check on a Space with no log. |
| D4 | The honest-server genesis check also requires `policy === meta:historyPolicy ?? "static"` and `appId === meta:owner.appId`. |
| D5 | In I, `/keyring/link` on a log-enabled private Space answers 409 `signed-membership-required` whatever the body, and `/keyring/redeem` there answers 409 `link-needs-upgrade` for every record. |
| D6 | A public genesis binds its writer but does not mark it `joined`; the writer sends its own `join`. |
| D7 | `redeem-preview` takes optional `since`/`limit` and never deletes an expired record. |
| D8 | A relay `/agent/enroll` carrying an `entry` requires the owning app's intent tag `enroll:<memberId>:<entryHash>`, where `entryHash` is the §3.5 `hash` of that exact entry. AppDOv1 computes it from the entry the enable controller verified, and the relay computes it from the entry it parsed, so the relay parses first (`400 malformed`) and then checks the intent (`403 internal-op`). A `seq:-1` intent is signed and verified like a log entry, so it is bound the same way; an enrol without `entry` publishes no intent. Both DOs build every tag (`prepare:<memberId>`, `enroll:<memberId>:<entryHash>`, the bare member id for unenroll) through one module, `acc/durable-objects/space/intentTags.ts`, so the spellings cannot drift. This closes R7 (§5.3.9). |
| D9 | `/api/auth/identity` is served by the UserAuth DO through the delegate; machine principals count as having no session. |
| D10 | `keyedEpoch` in the prepare response is `meta:keyedEpoch ?? 0` (informational); I writes `meta:epochCommit:0` for a new Space and never `meta:keyedEpoch`. |
| D11 | Functions enrol with `mode:"all"` in I. |
| D12 | `broadcast`/`sendToMember` gain `{metered?: boolean}` in I (§8.1). |
| D13 | Canonical encoders live in `acc/trust/*`, shared with the platform; `space/mlogCanonical.ts` holds the pure relay rules. |
| D14 | Anonymous identity lookups share `rl:idl:ip:<ip>` with session callers, checked against 30. |
| D15 | During I–A0a a certificate on an unbound member binds `src:"cert"` only when it verifies and its `ik` equals the session IK. |
| D16 | Every private `remove` writes `mlogmember:<m>.removedSeq`, bound or not (and `ikbind:<m>.removedSeq` when bound); `add` clears both; A0a's redeem `removed` check (§4.4.4) reads `mlogmember:<m>.removedSeq`. |
| D17 | The `quit` notices `closeNonMembers()` broadcasts are unmetered; a `quit` for a socket found dead during an ordinary broadcast stays metered. |
| D18 | `POST …/disable` ignores an `entry` in I; the signed `svc remove` arrives with relay `unenroll` in A0b (§6.1). |
| D19 | §10.3's non-member `spaceMessage` case is split between the unit suite (error frame, no agent push) and the server suite (a refused socket's early frame is never stored). |
| D20 | Existing log phrases are kept (`enrollAgentInSpace failed`, `enrollFunctionInSpace failed`, `unenroll intent check failed`); a `prepare:`/`enroll:` intent read-back failure logs `enroll intent check failed`. |
| D21 | The shared fixture originates in the accelerator and connect copies it at step S (§10.1). |
| D22 | `POST /keyring/log` step 1's structure checks answer `400`, not `409`: bad `v` → `malformed`, wrong `spaceId` → `wrong-space`, oversize → `too-large`. Only the CAS mismatch (`seq`/`prev` do not extend the head) answers `409 {error:"Log moved", head}` (§3.6 step 1). |
| D23 | `GET /keyring/log?since=` bounds `since` to ≤ `Number.MAX_SAFE_INTEGER − 1` and treats anything above it exactly like any other invalid `since`, so an absurd value cannot crash paging by overflowing the stored-key padding (§3.6 "Other routes"). |
| D24 | For `add`'s "target is already a member" (§3.5, §3.6 step 4), a **log member** means `allow:<m>` exists **together with** `ikbind:<m>` at `src:"log"` and no `removedSeq`, or the id is the creator/owner bound by the genesis. `allow:` alone is not enough (a legacy pre-log member is not yet a log member); the binding alone is not enough either, since a private `leave` deletes `allow:`/`role:` but leaves the binding untouched. This lets the owner re-sign a pre-migration `allow:` collaborator with `add` (§3.8 step 2, KI4) and lets someone who `leave`s come back later (§3.5's "someone who left may come back"); `role` and `remove` keep authorising off the `allow:` row, so an owner can still change role or cut off a legacy member without a prior `add`. **Migration re-signs are owner-only:** an editor's `add` whose target still holds an `allow:` row — a legacy member not yet re-signed, whatever its binding — is refused `403 not-authorised {reason:"target-member"}`, so an editor can neither rebind a legacy member's IK nor re-sign them at a lower role (§3.8 step 2, KI4). A member who left or was removed no longer holds `allow:`, so an editor can still add them back as a viewer. |
| D25 | On a log-enabled private Space, the legacy (no-`entry`) `/keyring/redeem` answers the D5 409 `link-needs-upgrade` **before** any invite-record lookup, so an unknown or corrupt token there also gets 409, never 404 or 500 — the redeem is refused either way, and checking first stops the response from revealing whether a token exists (§3.6 409 table). |
| D26 | §3.10's "a context without `ik` → 503 `identity-context-unavailable`" applies only to a member's **first** binding (an unbound member posting a verifying certificate, or the log's first self-sourced binding, SEC10). A already-bound member's certificate is checked against its existing `ikbind:` and needs no session `ik`. |
| D27 | The relay does not re-check the owner/roster rule when it appends a signed `svc` entry (§3.6 step 3): it has no owner IK or roster of its own to check against, and accepts the entry only inside the owning app's D8 `enroll:<memberId>:<entryHash>` intent naming that entry, after the enable controller (§5.3.3 Commit row) has already verified the signer is the pinned owner or a `trust:roster` editor. The guarantee that the server alone cannot plant an agent rests on 0.15 members verifying the `svc` signature against the pinned owner/roster themselves (§5.3), not on a second relay-side check. |
| D28 | A relay 403 or 500 during `/agent/enroll` (§5.3.3 Relay row) surfaces to the enable caller as `200 {enrolled:false, …}`, not as an error; only a 400 or 409 from the relay passes through as such. The enable itself still succeeds unsigned in step I, and `enrolled:false` tells the caller it was not signed in that Space. |
| D29 | An append's order after its atomic write is: the mirror effects (§4.4.8 cascade, the `rotateDue` frame, `closeNonMembers()`), then bytes-at-rest, then the `mlog` frame (§3.6 steps 5–7). Bytes-at-rest reaches the Billing DO, an outgoing call that lets other requests into the Space object, so a removed member's sockets are already closed by then. Residual for A0a: the §4.4.8 cascade makes its own bytes-at-rest call when it deletes `keyring:__link__:*` blobs, before `closeNonMembers()`. That call cannot run in step I: no step-I code writes a `linkidx:` row, so the cascade finds no links and returns first. A0a's v2 links write those rows. |
| D30 | `GET /keyring/log`, `POST /keyring/redeem-preview` and relay `/agent/enroll-prepare` read the head the way the append paths do: a `meta:mlogHead` row that exists but does not parse is `500 {error:"Membership log head is corrupt"}` (logged `mlog head corrupt`), never `head:null`, which a client would read as a Space with no log. |
| D31 | Matt, 2026-09-29: a refused upgrade on a gated Space is answered over HTTP before it opens (401 anonymous, 403 non-member), unless the client asks for the 4403 close with the query parameter `refuse=close`, which 0.15's `Space.connect` sends and treats as terminal. A published SDK's `Space.connect` retries without limit (`maxReconnectAttempts: 0`, every 3 s), so this does not end X9's loop; it keeps those tabs from flapping connected/disconnected, never gives them a socket they could send on, and costs the Space object no accept/close per attempt. The upgrade/remove race re-check still closes an already-accepted socket with 4403 whatever the parameter. |

---

## 12. Known issues to resolve during planning

The final critic pass (`critiques-v4.md`: security, availability and compat lenses) raised three
blocking findings. All three are applied in this version as the critics specified:
1. **EpochCommit fork** (security): a client adopts a commit only when `ec.headHash` equals its own
   verified hash at `ec.headSeq`, and rejects a mismatch as `commit-fork` (§3.7 item 1, §4.2.5,
   §9.2 I17, §9.3 X4; tests §10.5, §10.6).
2. **Stolen session and service members** (security; copy only, decision 8 wins over a mechanism
   fix): the executive summary §B names both gaps before K and E and the permanent "a developer's
   login can change an agent's code, tools or prompt" gap (§5.3.9 R6, §9.3 X10).
3. **Enable on a Space without a log after E** (compat): the SDK sends an IK-signed enrolment intent
   (`seq:-1`) that is verified and never stored or appended, instead of the enable being refused
   (§5.3.3, §6.1, §6.10, §8.1 E, §9.2 G17; tests §10.1–§10.5).

The rows below are the pass's remaining important and minor findings, one row each. The security and
availability findings about the `resetSpacePins` exit are merged into KI2. Each fix is the critic's
proposal, condensed; section references are to this document. None of them conflicts with decisions
1–11; the only precedence applied is the context's "ignore standup" (KI11). The implementation plan
must settle each row and write the test in its last column. KI1 is resolved (adopt its fix).

| # | Finding (lens, severity; sections) | Problem | Proposed fix (critic's, condensed) | Test that must pin it |
|---|---|---|---|---|
| KI1 | **RESOLVED 2026-09-27: adopt the proposed fix below as written; the plan implements it.** Runtimes without IndexedDB: CLI/Node, the transcoder, Workers (compat, important; §3.7 item 3, §4.2.7, §6.6, §6.9, §9.3 X4, exec summary §E, §8.2 K4) | Everything the anti-rollback rules read lives in IndexedDB `muhkoo.trust`: `hw = {seq, hash, humanRemovalSeq}`, the SpecA pin high-water marks and `rotationBlocked`. The design says nothing about runtimes without it, and they are in the release plan: theater-transcoder 0.4.0 (Node; a K4 gate that must open its media Space with no browser, runbook K g), the CLI (Node; signs enrolments on 0.15), headless workers, and browsers where `indexedDB.open` throws or never settles (private modes, sandboxed frames). A literal build throws in Node and blocks K4 and CLI signing. A silent fallback would hide that such clients keep `hw` only in the server-replayable sealed cache, so they are a new device after every restart and §B's "even by rolling back the member list it shows" overstates for them. | §6.6 IndexedDB row, append: when `indexedDB` is absent, or `open` throws or has not settled within 2 s, `muhkoo.trust` is an in-memory store for the life of the Client (Node CLIs and workers, restricted browser contexts), and `client.trust.persistent` reports `false`. §6.9 `client.trust`: add `persistent: boolean`. §3.7 item 3, append: with a non-persistent store, `hw` survives a restart only through the sealed cache, so the client is protected as a new device after each restart (X4). §9.3 X4, append: "… and clients without persistent local storage (command-line tools, headless workers) after each restart." Exec summary §E "Quiet spaces", append: "Apps that keep no local storage (scripts and command-line tools) are protected this way only within one run." No new option or stored data. KI6's per-seal read and KI14's entry cache then use the in-memory store. | connect unit: with `indexedDB` undefined, a Space opens, pins, signs a log entry and sends; an `indexedDB.open` that never settles falls back after 2 s; `persistent === false` in both cases. §10.8 K g (the transcoder opens its media Space with no browser) stays the end-to-end check. |
| KI2 | `resetSpacePins` does not survive a reload, and the `hw` merge can mis-pair fields (security and availability, important, merged; §3.7 item 3, §4.3, §6.9 `client.trust`, §8.3, §9.1 `integrity`, Q20, §10.5) | (a) `resetSpacePins(spaceId)` deletes only the `s:` pin and the IndexedDB record, but the sealed cache `space-keys-v2/<spaceId>` also carries `headSeq`, `headHash` and `humanRemovalSeq`, and every open merges the two copies. After the §8.3 point-in-time restore, each reload rebuilds the pre-restore `hw` and sets integrity again. The cache is rewritten only when held epochs change or a removal is first applied, which integrity blocks and a quiet Space may never do, so members can never send there again (reading continues). This contradicts §8.3 and Q20, which Matt accepted on 2026-09-27 as the exit. (b) "Field-wise maximum", read literally, pairs one copy's `seq` with the other's `hash`. IndexedDB normally runs ahead of the cache, so an honest log then shows "a different hash at `hw.seq`" and sets integrity with no exit. | §3.7 item 3, first bullet: "On open the client takes `{seq, hash}` from the copy with the higher `seq` (IndexedDB on a tie) and `humanRemovalSeq` as the larger of the two"; a cache without `hw` fields contributes nothing. §4.3 third bullet: "the §3.7 item 3 merge with IndexedDB"; add `resetSpacePins(spaceId)` to the cache-write triggers. §6.9 `client.trust`: with `spaceId`, the reset removes that Space's `s:` pin and `muhkoo.trust` record and rewrites `space-keys-v2/<spaceId>` keeping `keys`, `legacy`, `readOnly` and `v1Imported` and dropping `genesis`, `headSeq`, `headHash` and `humanRemovalSeq`; that clears its integrity. If the rewrite fails, the call rejects and integrity stays. Without `spaceId` it does the same for every Space in `muhkoo.trust`. §8.3 note, append: "The restored member list may include someone removed after the restore point; the owner removes them again." No new key, field or route. | `trust/MembershipLog.test.ts`: IndexedDB `{12, h12, 10}` and cache `{10, h10, 10}` over an honest log at 12 give `hw {12, h12, 10}` and no integrity. `trust/pins.spaces.test.ts`: IndexedDB and cache both `{10, h10, 10}`, the server log restored to 9 (or 8); after `resetSpacePins(spaceId)` the cache has no head fields, a reload TOFUs the genesis, integrity is clear, and a send seals at the restored `E*`. A server that replays the pre-reset (AEAD-valid) cache after the reset sets integrity again (RT9 allows that pause). A reset whose cache write returns 5xx rejects, and integrity stays set. |
| KI3 | A replayed old `keyCert` can destroy a sole copy (security, important; exec summary §B, §3.10, §4.5.2 rescue, §6.5 row 8, §8.3) | A `keyCert` has no counter or timestamp, and certificates are public (roster, pending and waiting rows). A stolen session can post the victim's older certified chat-key pair, and §3.10 overwrites `member:<victim>`. That is "replacing a verified member's key", which §B says a stolen session cannot do. In a sole-copy Space, the keeper admit (the rescue row after K, the escrow row before it) then wraps the kept key to the old key and stores `tfp`, so the retire probe counts a verified holder and the next retire run purges the keeper rows. Nobody holds that old private key, so the Space is lost if the run lands before the victim's next open. This needs a session thief, an old certificate and a retire run inside that window. | §B: "replace a verified member's key" → "replace a verified member's key with one that member's identity key never certified". §6.5 row 8: delete ", or the write is a keeper admit (§4.5.2)", so `tfp` is set only when the caller is the target or `hasCert(caller)`. §4.5.2 rescue paragraph: a keeper admit, rescue included, stores the blob without `tfp`, so it counts for nothing until the member's own self-escrow proves it could open the key (§4.5.9 step 2b rewrites a blob lacking its `tfp`); only then does `keyHolders` count it, the rescue row stop applying and the next retire run purge the rows. Honest 0.15 members self-escrow in the same sweep, so holder counts and gates K1/K6 are unchanged in practice. The §10.3 `space-keeper-rescue` expectation "`keyHolders` 1" then holds after M's self-escrow, not at the rescue write. | accelerator unit (admission): a keeper or rescue write stores no `tfp` and leaves `meta:keyHolders.count` at 0; the member's self-wrap sets `tfp` and count 1; `/agent/escrow-retired {dryRun}` reports 0 holders after a rescue with no self-wrap. connect: after a rescue, the first self-escrow batch rewrites the blob with its own `tfp`. |
| KI4 | The private migration cannot resume, and it signs `add`s for service principals (availability, important; §3.8 step 2, §9.2 W9, §5.3.1, §7.2 portal) | The migration runs only on the owner's first 0.15 open. Each `add` needs a directory lookup that fails closed on a 5xx or 429, and a closed tab stops it too. After the genesis the Space is log-enabled, so "first open" never recurs, and `/keyring/invite` and `/keyring/role` return 409. Every `allow:` collaborator left without an `add` keeps server-side access, cannot have their role changed through the log, and is refused by 0.15 members as `not-signed-member`. An editor in that state can never be confirmed in the `AppRoster`, so the portal shows "Waiting for the app owner to confirm you as an editor" forever. W9's "migration window" never closes. Separately, service enrolments write `allow:` rows too (`__agent__:*`, `__fn__:*`), so an owner-signed `add` of a reserved principal with a directory decoy IK can abort the migration or bind a decoy. | §3.8 step 2 → "One owner-signed `add` per active human `allow:` member (§4.1.3). Rows for `__agent__:*`, `__fn__:*`, `__log__*`, `__link__:*` and `__machine__:*` are skipped; services are re-signed through `svc` (§5.3.7). Each `add` carries the directory IK and the member's `role:`. **Step 2 resumes:** on every owner open of a log-enabled private Space whose entries after the genesis are all owner-signed `add`s (the migration prefix), the owner's client signs an `add` for each such `allow:` member that `S` does not list and `S.removed` does not contain. The first entry of any other op closes the migration; after that no `allow:` row is added automatically, so X7 stays limited to the migration." §9.2 W9: "only during the migration window" → "until the owner's next open resumes step 2, and only while the log is still the migration prefix". No server change; every `add` stays owner-signed (decision 10). | Portal and `MembershipLog`: the directory returns 503 on the second of three `add`s; the owner reopens → two more `add`s and one `membership-bootstrapped`. An `allow:__agent__:x` row produces no `add`. After a `link` entry is appended, a server-inserted `allow:` row is not added. |
| KI5 | **RESOLVED 2026-09-28 by the step-I plan (T12, T27, T30, T34, T36).** The roster PUT and the enable controller read the session IK from a resolver those routes never call (availability, important; §5.3.1, §5.3.3 Commit row, §6.3, §8.1 I, §10.8 I) | Both compare `ownerIk` / `entry.ik` with "the session IK", which §5.3.1 says `controllers/auth/session.ts:24-43` passes through. `/api/apps/*` never uses that resolver: it authorises through `resolveSession` in `acc/platform/controllers/session.ts`, which returns only `{commitment, username}`, and §6.3 adds `ik` only to UserAuth `/verify` and `resolveUserContext` (the relay path). Built as written, every roster PUT returns 403 `owner-ik-mismatch`, every signed enable (and every enable intent, blocking fix 3) returns 400, and from E no agent or function can be enabled or re-signed in any app, so K5 can never pass. The I staging runbook should catch it before production, but the rollout would stall. | §6.3, add a row: "Platform `resolveSession` (`acc/platform/controllers/session.ts:34-58`) → `ResolvedSession` + optional `ik` (the `/verify` `ecdsaPublicKey`, normalised by the §3.6 rule) \| I". §5.3.1: "which `controllers/auth/session.ts:24-43` passes through" → "carried by `ResolvedSession.ik` (`acc/platform/controllers/session.ts`, reached through `authorize.ts:240`, `:304`)". §5.3.3 Commit row, append: a session without `ik` → `503 {code:"identity-context-unavailable"}` with `Retry-After: 60`, never 400 or 403. One field, no new `UserAuth` call (SEC10's "no lookup" holds). | New `tests/session-resolve.test.ts`: `/verify` returning a b64 or a hex `ecdsaPublicKey` gives the same `ik`; a response without it gives `ik` undefined. Server suite on the I build: the owner's roster PUT returns 200 and a signed enable returns `signed:true`. Add the enable probe to the §10.8 I row. |
| KI6 | Tab races: a held pin read, and where the removal floor is read (security, minor; §3.4, §4.2.8) | (a) A pin document whose counter is below the current mark is accepted as long as it is not below the mark read before the request. The server can hold one tab's read until a sibling tab of the same app writes a new pin, then answer with the older document; that tab then runs the session without the new `s:` genesis pin (possibly link-authenticated in the sibling) or the raised `ar:` roster mark, and looks the sibling's new peer up in the directory again. (b) The sealable rule uses `hw.humanRemovalSeq` without saying where it is read, so a tab that kept its open-time copy misses a removal its sibling applied if the server withholds the `mlog` frame from it. | §3.4: replace the pre-read-mark sentence with "A pin read below the high-water mark read before it was sent is a rollback (hard fail). One at or above that mark but below the mark when the response arrives is stale, not a rollback: it is discarded and the document is re-read once; only a document at or above the current mark is used, and a second stale answer fails that operation closed." §4.2.8 sealable rule: after `hw.humanRemovalSeq` insert "(read from IndexedDB `muhkoo.trust` at each seal, so a removal another tab of this app applied counts)". The SpecA §4.2 amendment (Q15) must say the same. | `PinStore.test.ts`: the existing §10.5 round-4 case (read at mark 10, response 10 after the mark reaches 12) now re-reads and uses the counter-12 document; a second stale answer fails closed. `Space.sealable.test.ts`: two Space instances share one IndexedDB; B applies `remove` at 10; A, whose log is not marked stale, throws `rotation-pending` on send, and the spy shows no seal. |
| KI7 | §B and §E overclaim for a device that lost its saved data (security, minor; copy only; exec summary §B and §E) | §B says the server cannot make an app that has seen a removal keep sending under the removed member's key "even by rolling back the member list it shows". §3.7 item 3 and X4 say a device that lost IndexedDB is protected only as a new device is, because the server can replay an older AEAD-valid sealed cache together with an older log. §E does not say this. | §B: after "even by rolling back the member list it shows" add "(unless that device has also lost its saved data)". §E "Quiet spaces", append: "The same holds for a device that lost its saved data, if the server shows it an older member list." Apply together with KI1's §E sentence, and recount the summary's 150-line budget. | Copy only: no unit test. Checked at the D copy review against §9.3 X4; `check-claims` (§5.8) is unaffected. |
| KI8 | An absent `meta:keyHolders` is undefined for the rescue row (availability, minor; §4.5.2, §4.5.7, §8.1 A0a/A0b, §10.2) | The rescue row requires the stored `meta:keyHolders` to equal `{epoch: keyedEpoch, count: 0}`, and nothing says what an absent record means. The lazy backfill ships at A0a but holder counts at A0b, and `meta:admissionIndexV1` stops the backfill from running again, so an A0a backfill that did not write the counter leaves Spaces without it. A sole-copy Space has no verified write by definition, so nothing ever creates the record, and rescue then skips every returning member after K while the retire probe keeps the rows: a permanent loss for those Spaces, contradicting §E. | §4.5.7, append: "An absent `meta:keyHolders` reads as `{epoch: keyedEpoch, count: 0}`. This is exact: no blob can be verified before S, and from A0b every verified write creates the record (an increment on an absent record stores `{keyedEpoch, 1}`). The lazy backfill writes the record from A0a." §4.5.2 rescue row: replace the stored-record condition with "the effective `keyHolders` (§4.5.7) is 0 at `keyedEpoch`". | `space-admission.test.ts`: the rescue row writes when `meta:keyHolders` is absent; an increment on an absent record stores `{keyedEpoch, 1}`. `space-keeper-rescue.test.ts`: a Space backfilled by an A0a-only build, then the K build, still rescues a dead-blob member. |
| KI9 | **RESOLVED 2026-09-28 by the step-I plan (T22; the `rotateDue` frame in T34 `space-removal`); the `/keyring/state` and v2 `/rotate` halves of its test land with A0a.** A private `leave` must also raise `rotateDue` (availability, minor; §3.6 mirror row, §4.2.1, §4.2.9, §10.3) | The mirror row reads "`remove` only: set `ikbind:<m>.removedSeq`; merge `meta:rotateDue`; broadcast `rotateDue`; `closeNonMembers()`", which can scope `rotateDue` to `remove` alone. §4.2.9 lists `leave` as a source, and clients treat a private `leave` as a human removal that pauses sealing. A non-owner may `/rotate` only while `rotateDue` is pending (§4.2.1), so in a Space whose owner is gone a private `leave` built to the narrow reading pauses sending for every member permanently. The server tests cover only `remove`. | §3.6 mirror row `remove`, `leave` (private), effect cell: "delete `allow:<m>`, `role:<m>`; **revoke every live link** (the §4.4.8 cascade for each `linkidx:*`, listed once, deleted in batches of 128 keys); merge `meta:rotateDue {reason:"remove"}`; broadcast `rotateDue`; `closeNonMembers()`. `remove` additionally sets `ikbind:<m>.removedSeq = seq`." | `tests/space-removal.test.ts`: in a private Space whose owner is offline, viewer V `leave`s → `/keyring/state.rotateDue` is set; another member's v2 `/rotate` returns 200 and commits; a third member's `securing` clears and its send seals. |
| KI10 | **RESOLVED 2026-09-28 by the step-I plan (T18, T22); the over-the-wire test (20 leave/rejoin cycles) is carried into the A0a plan, because a public genesis needs `meta:founder`, which A0a writes.** The join cap can lock a member out of a public channel (availability, minor; §3.6 Caps, §3.5 public `join`/`leave`, §6.7) | `MAX_JOINS_PER_MEMBER` allows 20 `join` entries per member per Space, with no reset and no error code. A member who leaves and rejoins through `Space.leave()` 20 times (an app's "Leave channel" button) is refused on the 21st `join`, and holders then refuse that member's `waiting:` row as `not-joined` forever: a permanent loss of a public channel, against decision 3. | §3.6 Caps: "`MAX_JOINS_PER_MEMBER` (20) bounds **`leave`** entries per member per public Space: the 21st `leave` returns `409 {code:"leave-cap"}` and the member stays joined. A `join` is never refused by a cap." Log growth stays bounded at about 20 `join` plus 20 `leave` entries per member. The constant keeps its name (§6.7). | `MembershipLog` and server: after 20 leave/rejoin cycles, a 21st `leave` returns 409, the member is still joined and keyed, and a rejoin after the 20th `leave` is accepted. The §10.2 `space-mlog` `MAX_JOINS_PER_MEMBER` case changes to match. |
| KI11 | Standup at gates K3 and K5 (compat, minor; §8.2 K3, K5) | Standup stays on 0.13.0 with a mention-triggered @standup agent in `general`, and that channel never gets a log. K3 cannot reach 0 for it (its legacy @mentions fire until K, then the agent goes silent), nor can K5 (its enrolment stays unsigned, `space-not-migrated`). Both gates allow an accepted list, so nothing blocks, but the gate text does not say that @standup goes silent at K. The context ("ignore standup") wins; only the gate text changes. | §8.2 K3, append: "Standup is expected on this list (0.13.0, never upgraded, per the context): @standup stops answering at K." §8.2 K5, append: "Standup's @standup enrolment is expected as unsigned (`space-not-migrated`)." | `e2e-channels-migrate.mjs report` prints standup's K3 and K5 rows with `expected:true`. |
| KI12 | The A0a and A0b rollback cells have no time limit (compat, minor; §8.1) | The A0b cell names A0a as its rollback target with no limit, but after S the 0.15 clients depend on A0b behaviour: `waiting:` fulfilment, `admitted`, targeted `keyringReady`, the `join-request` status and holder counts, and the §3.10 refusal rows. Rolling the server back to A0a after P would break admission for every 0.15 app in production. The I cell already carries "Safe while 0.15 is not on latest"; A0a and A0b do not. | §8.1 A0b rollback cell: "Roll back to A0a only, never to a pre-A0 build (§5.4), and only while 0.15 is not on `latest`. From S on, the server's rollback floor is the A0b build; from E, the E row's target." A0a rollback cell, append: "Only while 0.15 is not on `latest`." | The P-0 drill (§10.8) records the S-era floor next to the S rollback cell. |
| KI13 | The portal has no way to re-add a removed member (compat, minor; §7.2 portal, §9.1 "Redeem refused removed", §10.7) | SEC9 makes an owner's or editor's `add` the only way to readmit a removed member: `redeem` answers `403 removed` until an `add` clears `removedSeq`. The portal has no add-by-username control today (its membership is links plus roles), and the portal row names `Space.add` without specifying any UI, so a collaborator removed by mistake and told "Ask the owner to add you again" cannot be readmitted through the portal. | §7.2 portal row, after "Membership actions become signed entries": "Collaborators and App Config get **Add by username** (`Space.add(u, {role})`, showing `client.trust.safetyNumber(u)`). It is the only way to readmit a removed member (§4.4.4)." | §10.7 Round 4 Playwright: the owner removes C; C's redeem of a new link shows the removed copy; the owner adds C by username; C opens Collaborators as a member. |
| KI14 | Every page load re-syncs each Space's log from seq 0 (compat, minor; §3.7 item 1, §6.6) | Only `{genesis, hw}` is persisted per Space, so the verified state `S` (members, links, services) is rebuilt from seq 0 on every page load. Each open of a public channel costs ceil(entries/500) metered `GET /keyring/log` requests, which grows with membership (Q4 adds one `join` per member) and counts against the Free tier's hard 10,000-request cap. About one page at today's channel sizes; the billing tests bound joins and waits, not opens. | §6.6 IndexedDB row, append: "… and the verified entries per Space, used only when the cached chain ends at `hw.seq` with `hw.hash`; otherwise the client syncs from 0." §3.7 item 1, prefix: "On open, `localHead` is the cached head when that holds." It is a local cache re-checked against `hw` on every use, so it adds no trust. | connect unit: open a public channel with 1,200 entries twice; the second open issues exactly one `GET /keyring/log` (`since` = the cached head). |
| KI15 | `withAppKey` copies `trustAnchor` (compat, minor; also SEC8's optional clause in the security disposition; §6.9) | `withAppKey` copies the parent's options except `apiKey` and `accessToken`, so a parent built with `trustAnchor{appId:A}` hands a child for app B an anchor for the wrong app, and §5.3.1 makes an owner mismatch a hard fail (`app-owner-changed`). The portal's parent has no `trustAnchor`, so there is no production effect today; third-party callers of the new API would be hit. | §6.9 `withAppKey` row: "except `apiKey` (becomes `pk`) and `accessToken` (unset)" → "except `apiKey` (becomes `pk`), `accessToken` and `trustAnchor` (both unset; the child learns `pk`'s owner from `GET /api/app/trust`)". | `Client.withAppKey.test.ts`: a parent with `trustAnchor{appId:"A"}` builds a child for B's `pk`; the child pins B's owner from `/api/app/trust` and raises no `app-owner-changed`. |

**Closure checks (no action).** Each lens also filed a disposition entry that claims no defect. They
verify every round-3 finding closed in v4 against the design and the code: SEC8–SEC12, AV8–AV14 and
CP7–CP11. Their residuals are the rows above or blocking fixes already applied: SEC8's `trustAnchor`
clause is KI15; the fork residual under SEC9 and SEC11 is blocking fix 1; AV8's is KI8; CP10's is
KI11. All three recommend adopting every finding of the pass, and none of the fixes adds a
Space-owner approval step (decision 8), changes addressing (decision 9) or weakens the copy rules
(decision 11). The compat lens asks that its code-fact table (session minting, `/api/ws-ticket`,
published SDKs' handling of `pubkey:null` and `tfp`, `headers.to` outside the signature, exact
first-party pins) be recorded beside §11.8; it is in `critiques-v4.md` and needs no change here.

---

## Appendix A. Binding product decisions (Matt)

Decisions 1–7 were made on 2026-09-26 before the first draft; 8–11 in the second round the same day; Q19 and Q20 defaults accepted 2026-09-27. Where they conflict, the later decision wins.

### Round 1
1. Messages in every space/channel must be end-to-end encrypted: the server must never hold a usable group key.
2. Invite links carry the group key in the URL `#fragment` (never sent to a server). The server still checks the invite token (`?token=`) for expiry, use limit, revocation and role; it only releases an *encrypted* copy of the key, which the fragment secret unlocks. A joiner needs both halves.
3. Every channel can have a **standing** join link (same mechanism), so public channels are instantly joinable by link holders.
4. Joining without a link (e.g. browsing a public channel list, or requesting a private space): the joiner **waits**; the first member who comes online admits them automatically (their client wraps the key to the joiner). UX: "waiting for a member to let you in".
5. AI agents and space-bound functions are **ordinary members**: each has its own identity key pair; it receives a wrapped copy of the group key like any member; content stays encrypted until the agent/function executes; it decrypts with its own copy only at execution time. The agent's conversation transcript must be stored **encrypted** at rest (today it is plaintext). Agents appear in the member list like any participant; no special banner. Removing an agent rotates the key.
6. The per-app `__logs__` server-log space is server-produced text and may stay server-keyed (it is not user messaging).
7. Deploy constraints: staging first; production only when Matt asks. Never rename a Durable Object class. Never change a persisted key format or wire shape without a migration. `@muhkoo/connect` is consumed by ~13 apps via npm (`latest` tag), so published SDK versions keep running after a server change.


### Round 2 (supersede round 1 where they conflict)
8. **Agents/functions in PRIVATE spaces:** app owner/editor can add them automatically, as today (members' apps hand over the key without asking). Do NOT add a space-owner approval step. The copy must say plainly that an app's developer can add an agent or function to any space in their app, including private ones, and it then receives the key. BUT with decision 10, the server alone must not be able to plant one: an agent/function enrolment must be signed by an app owner/editor identity that members' clients can verify.
9. **Agents decrypt only messages addressed to them.** The sending app marks a message as addressed to an agent (e.g. @mention) with a cleartext routing field outside the ciphertext; the runtime decrypts only those packets. The server learns that a message went to an agent, not its content. Space-bound functions that watch every message still decrypt every message, and the copy says so. Agent context = its own (encrypted) transcript of addressed turns only.
10. **Active-attack protection ships NOW, in this sub-project:** owner-signed membership for private spaces (members' clients admit only joiners whose membership entry is signed by the space owner/editor, verified against a pinned key), identity binding/pinning so members never wrap to a server-substituted key (reuse Spec A §4 identity lookup + pin map + safety numbers: connect/docs/superpowers/specs/2026-09-24-dm-protocol-design.md — that identity infrastructure becomes a shared prerequisite), and a stable identity is required to take part (no ephemeral-identity participation; a locked session gets a "locked/unlock" state instead of a new key). Public channels: anyone may join (no owner gate), but joins are visible and keys are still identity-bound.
11. Correction to copy: "decrypted only while it runs" is false today; with decision 9 the accurate agent copy is "decrypts only messages addressed to it"; functions that watch all messages decrypt all of them; text is passed to the AI model or the developer's function code, which may store it; files are never passed on.


## Appendix B. Review history

Four design rounds, each checked by independent security, availability and compatibility critics: v1 (6 blocking findings), v2 (7), v3 (6), v4 (3, applied in this version). The per-round drafts and critic reports were working files and are not kept in the repo; each round's disposition table is in §11.
