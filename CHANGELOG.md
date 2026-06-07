# Changelog

All notable changes to `@muhkoo/connect` are documented here. This project
follows semantic versioning (pre-1.0: new backward-compatible features bump the
minor, fixes bump the patch/alpha).

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
  Workers-AI-backed agents from the SDK: `create`, `get`, `list`, `update`,
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
