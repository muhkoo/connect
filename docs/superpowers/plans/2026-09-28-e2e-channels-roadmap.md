# E2E Channels — Roadmap of Implementation Plans

**Spec:** `connect/docs/superpowers/specs/2026-09-27-e2e-channels-design.md` (approved by Matt 2026-09-27;
open questions Q1–Q18 take the spec's defaults, Q19–Q20 accepted explicitly).
**Related specs:** SpecA `2026-09-24-dm-protocol-design.md` (DMs; its §4.1 identity endpoint ships in step I),
Spec B `2026-09-25-vault-poprf-design.md` (vault custody; independent release train).

The spec ships in nine release steps. Each step gets its **own plan**, written when the previous step
has landed, so every plan is written against the code that actually exists. A plan written further
ahead would go stale: later steps consume interfaces the earlier ones create.

Rules for every step:
- Staging first. Production deploys, `npm run release` of connect or the CLI, and `npm publish` of the
  transcoder happen **only when Matt asks, every time** (accelerator `CLAUDE.md`).
- Matt does all commits. Plans end tasks with a checkpoint, not a commit.
- Gates are checked by **probing the deployed endpoint**, never by reading git.

| Step | Plan | Repos | Ships | Gate before the next step (spec §8.1) | Status |
|---|---|---|---|---|---|
| **I** | `accelerator/docs/superpowers/plans/2026-09-28-e2e-channels-step-i.md` | accelerator (+ SpecA §4.1 text) | Identity lookup, session IK, membership log facet, private transport gate, app trust/roster, signed enrolment plumbing, reserved personal-KV keys. Inert until a 0.15 client writes a genesis. | Suites green; staging **and prod** probes (identity + decoys, `/keyring/log` 200/403, Free app over KV cap still reads `chat-keys`, foreign-IK `join` → 403). | implemented 2026-09-29 (36 tasks, uncommitted); staging gate passed 2026-09-29; **in prod 2026-10-02** (anonymous probes pass; signed-in probes owed) |
| **A0a** | to write after I lands | accelerator | Additive: tolerant transcript reader, keeper-admit log, founder, v2 rotate/commit/state/wraps, link v2 fields, `tfp`, admin dry runs. | Legacy matrix green on staging; **A0a live in prod ≥ 24 h** (A0b's rollback target). | — |
| **A0b** | after A0a | accelerator | Behaviour with escrow still on: transcript writer, member-copy key push, `extractText`, unenroll rotation, admission index, §3.10 policy, holder counts, `agents` migration script. | Migration report reviewed; locked-reload rows for 0.13.0/0.10.14 pass on staging; 24 h keeper-admit check in prod. Rollback **to A0a only**. | — |
| **S** | after A0b | connect | connect 0.15 (release-train numbering per §8.1): trust modules, sealable rule, `withAppKey`, v1 import, waiting UX, no keeper seed. | Tarball smoke-tested; **I and A0b live in prod** before `npm run release`. | — |
| **P** | after S | web, discord-clone, theater (+ scan fn, transcoder), cloud-drive, spotify, app-builder, ide, cli, **portal last** | Apps on 0.15, identity gate, share links, re-sign banner. | Per-app Playwright; every first-party 0.15 build live in prod; web 24 h before portal. | — |
| **E** | after P | accelerator | Signatures required for new enrolments (log entry or `seq:-1` intent). | K1–K8 measured for 7 days. | — |
| **K** | after E | accelerator, ops | Keeper off (rescue row only), addressed-only agents, transcript `v:2`. | 48 h soak. **Last rollback point.** | — |
| **R** | after K | accelerator | Retire keeper rows per app; sole-copy Spaces only by id (Q7). **One-way door.** | Report reviewed; runbook h–k. | — |
| **D** | after K (+R for the strongest claim) | docs, website, connect | Privacy copy and docs (§5.8); flip the site/policy to "end-to-end encrypted" for channels (sub-project 5). | — | — |

## Carried forward from step I (read before writing the A0a / A0b plans)

Step I was executed 2026-09-28/29 (36 tasks, each reviewed; rulings recorded in the design's §11.9).
These items were found during step I and belong to later steps:

- **A0a — wire tests that step I could not run.** Public genesis, public join/leave, the link
  cascade and a successful `redeem-preview` are reachable only from unit tests until `meta:founder`
  lands in A0a. A0a's plan must add the over-the-wire tests, including KI10 (after 20 leave/rejoin
  cycles the 21st `leave` is 409 and a rejoin is accepted).
- **A0a — returning members through a link.** The "log member" rule (design §11.9 D24) treats a
  member as on the log only with `allow:` plus a `src:"log"` binding. Once v2 `redeem` exists, a
  member who comes back through a link may stay cert-bound; revisit the rule then.
- **A0a — removal vs. a racing redeem (mostly closed in step I).** An append now runs its
  post-commit steps (link cascade, `rotateDue` frame, closing sockets) before the billing call that
  reopens the Durable Object's input gate (design §11.9 D29). One call is left: the cascade's own
  bytes-at-rest call when it deletes `keyring:__link__:*` blobs still runs before `closeNonMembers()`.
  It becomes reachable once A0a writes `linkidx:` rows, so reorder or defer it. At the same time,
  extract the per-link cascade as the single-link helper that A0a's revoke, expiry and exhaustion
  paths reuse (design §4.4.8). Two more cascade gaps: a throw in a later batch orphans a link whose
  `linkidx:` row an earlier batch already deleted, and the loop over links runs serially (about
  1,024 storage calls at the 256-link cap).
- **A0a — append hardening.**
  - `writeMlogAppend` leaves the head compare-and-swap to each caller; fold it into the helper.
  - After the crypto awaits, only the head is re-validated; the signer's binding and the
    authorisation facts are read before those awaits.
  - `{mlog}` frames can go out of `seq` order under concurrent appends.
  - Refuse reserved signers (`__machine__:`, `__link__:`) on the log. Refuse `__`-prefixed usernames
    at registration.
  - The enrol path reads `logEnabled()` before fetching the app's intent. A genesis landing in
    between lets a `seq:-1` intent enrol unsigned instead of getting 409 (unreachable until a 0.15
    genesis).
- **Step S — the refused socket (decided 2026-09-29, design D31).** A refused upgrade on a gated
  Space is now answered 401/403 before it opens, unless the client asks with `refuse=close`, which
  gets the 4403 close. Step S's `Space.connect` must add `refuse=close` to every upgrade URL and pass
  `terminalCloseCodes:[4403]`. Published tabs still retry every 3 s (X9), because `Space.connect`
  sets no retry cap, but they no longer flap connected/disconnected.
- **A0b — unsigned enrol broadcast.** An unsigned enrol on a log-enabled Space still broadcasts the
  metered `joinRequest`; design §5.3.3's "no broadcast" is part of the A0b row.
- **A0b — agent enrolment.**
  - Design §5.3.9 R7 was closed in step I: the enroll intent is now bound to the verified entry's
    hash, `enroll:<memberId>:<entryHash>`.
  - Still open: the §8.2 K5 note (an unsigned re-enable of an already signed member logs
    `unsigned service member`).
  - `enrolmentsFor` reports a present-but-corrupt index row as `signed:true`; it should say
    `signed:false`.
  - `AppDOv1`'s `postEnroll` computes the entry hash outside its try/catch, so a throw there would
    escape instead of answering `enrolled:false`. It is unreachable today, because controllers pass a
    parsed entry.
  - The agent and function controllers duplicate the entry-check block. Their error mapping also
    differs: an agent 5xx becomes 404, a function 5xx becomes 409. Extract one helper.
- **Before prod for step I — ops checks (done on staging 2026-09-29, version `fb3cf05a`).**
  - Probes: `scripts/probe-step-i.mjs` all pass; step-I server suites pass (22/22; `signed-enrolment`
    not run, it needs the staging admin key).
  - Load test of `/api/auth/identity` from one IP, with a sign-in `challenge` sampled every 3 s:
    - Idle sign-in challenge: p50 95–99 ms, p90 153–176 ms.
    - Under 2 and 8 accepted 64-name batch lookups/s, and under 50 and 200 refused lookups/s:
      p50 101–133 ms, p90 172–406 ms. The only p90 outside the idle band was at 8 batch/s,
      from 20 samples.
    - Full sign-ins under the 200 req/s flood matched idle. No 5xx.
  - Cost of a 64-name batch: about 10–20 ms of the singleton's CPU (0.1 ms per decoy locally).
    One IP can sustain only about 2 accepted lookups/s (600 per 5 min). Saturating sign-in would
    take roughly 50 IPs with sessions sending full batches.
  - Follow-up for the auth fan-out redesign: charge batch lookups per name, or move the
    directory off the singleton.
  - Existing suites on staging: `space-fanout` 15/15 (one timeout in a multi-file run, then
    3 clean runs alone), `ws-ticket` passes, `chat-e2e` fails as documented (fake signature at
    sign-in).
- **Live bug found by the step-I regression check (2026-09-29, happens with or without step I).**
  - Web chat re-opened after a reload is "locked": the account seed is in memory only. The SDK then
    creates a temporary signing key and re-joins each channel, which replaces the member's key in
    the member directory.
  - `Space.verifySender` checks every message against the member's one current key, so everything
    the member signed before is silently dropped for other members. Signing in again with the
    password swaps the key back, and then the messages signed with the temporary key are dropped.
  - Reproduced on connect 0.13.0-alpha.0 and 0.14.0-alpha.9. The server data is intact: the rows
    are stored and decrypt; only the signature check fails.
  - The fix belongs with the identity work in step S and the P "identity gate": web chat must hold
    the account's own key after a reload rather than a temporary one (design §3.10).
- **Test gaps worth closing when the code is next touched:**
  - a DO-level message, edit and delete through the real gate on a log-enabled Space;
  - `role`/`remove` on a reserved target and by a non-member;
  - a positive published-SDK `redeem`, checking the `member:` and `joinreq:` rows and the
    `joinRequest` frame;
  - the 502 `roster-publish-failed` branch;
  - a function-prepare call by a viewer, and one with no session (401);
  - that reserved personal-KV writes are metered;
  - the reason-to-message mapping for invite refusals is duplicated in `keyring.ts` and `mlog.ts`.

## Early web slice (planned 2026-09-29, ahead of the roadmap order)

Matt asked for chat to exercise step I on staging before A0a.
- The plan is `2026-09-29-e2e-channels-web-slice.md` (17 tasks, connect + web, staging only).
- It covers the locked-session rule (which fixes the live reload bug) and a signed member list for new private channels.
- It uses step-I endpoints only, with keeper admission (slice ruling S2) and removal as a relay cut-off (S4).
- connect is not released (S1).

**Status 2026-09-30: implemented and on staging (web only).**
- 16 tasks were done by subagents, each reviewed, followed by a final multi-lens review and one fix wave.
- Rulings P1–P43 are recorded in the plan's working notes and listed to Matt; deferred minors are in the plan's appendix.
- Staging web is `d1a6a10a`, carrying connect 0.15.0-alpha.0. That build is NOT published, and web depends on `file:../connect`.
- The Brave run passed 10/10: the reload bug is fixed, a non-member is refused, and a removed member is cut off in under 1 s with no reconnect loop.
- Production needs Matt's ask.
- **2026-10-02:** connect 0.15.0-alpha.0 and CLI 0.15.0-alpha.0 were published under the npm `alpha` tag ONLY. `latest` stays 0.14.0-alpha.9 until step I is in production, because private-channel creation fails against a production server without it.
- Web now depends on the published `@muhkoo/connect@0.15.0-alpha.0`. Staging web is `6337724a`, and the Brave run passed 10/10 again.
- **2026-10-02, production (Matt asked):** step I is live in prod (accelerator `7633692f`, then `8ce67fda` with
  `LEGAL_VERSION` 2026-09-25; fn-gateway `1c3b1431`). Web chat prod is `f836b3e2` on 0.15.0-alpha.0.
  Anonymous prod probes pass (identity lookup and stable decoys, keyring log route present, pre-upgrade socket
  refusal). Matt's signed-in prod check passed, and npm `latest` now points at 0.15.0-alpha.0 for connect and the
  CLI. Still owed: the prod slug backfill (accelerator security prerequisite, not part of this roadmap).

## Neighbouring sub-projects

- **Sub-project 3 — files with sealed keys** depends on this: file manifests will be sealed under the
  space group key, which is only server-blind after step K.
- **Sub-project 4 — DMs (SpecA)** shares step I's identity endpoint and the S-release trust modules
  (`PinStore`, `IdentitySigner`, `IdentityLockedError`), which freeze at their first release (Q16).
- **Sub-project 5 — flip the public claims** rides on step D, together with the `LEGAL_VERSION` bump.

## Before public "end-to-end" claims

The spec's custom group protocol should get a specialist review before step D copy goes live
(the connect Double Ratchet is already flagged for one).
