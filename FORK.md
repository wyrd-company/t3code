---
relationships:
  references:
    - .github/fork/resolve-base.sh
    - .github/fork/fork-surface.sh
    - .github/fork/allowlist.txt
    - LICENSE
---

# Wyrd Company T3 Code fork

This repository keeps `main` as a pristine mirror of `pingdotgg/t3code`. Fork changes live on branches that are rebased directly onto upstream release tags:

- `mcp-external-registration` publishes the Linux server package.
- `web-image` publishes the unmodified web client container image.

Do not merge the fork branches together. Do not merge upstream into either branch.

## Invariants

Stock clients are not impacted. `web-image` publishes the unmodified upstream
web client and it runs against this fork's server; the mobile client likewise.
Nothing the fork does requires a client change, or changes what a stock client
receives or has to understand.

The shared contract is outside the fork's surface. `packages/contracts`,
`packages/client-runtime`, `packages/shared`, `apps/web`, `apps/mobile`, and
the WebSocket, orchestration, and persistence layers are upstream's. The fork
adds server-side surfaces of its own under `apps/server/src/mcp/` instead.

## Base and rebase

Each fork branch is our commits replayed onto one upstream release, so the
point where the branch and `main` last agreed is the release it is built on.
[.github/fork/resolve-base.sh](.github/fork/resolve-base.sh) reports it:

```bash
.github/fork/resolve-base.sh
```

It derives the commit from `origin/main`, the pristine mirror, rather than
from upstream's tag: upstream `v*.*.*` tags are never pushed to `origin`, so a
checkout of this repository cannot resolve one. A shallow checkout cannot
answer at all; fetch with depth 0.

Nothing records the base in a file. A second copy of a commit git already
knows has to be moved by hand on every rebase, and a copy that falls out of
step is worse than no copy: the boundary check then measures against the wrong
release and reports upstream's own changes as ours.

Rebasing onto a new upstream release:

```bash
git fetch upstream --tags
git switch mcp-external-registration
git rebase refs/tags/<new-upstream-tag>
.github/fork/fork-surface.sh
```

That the branch sits on a _stable_ release rather than an arbitrary upstream
commit is asserted by the rebase workflow, where upstream's tags are
reachable, before anything is pushed.

The `upstream` remote push URL must remain `DISABLED`. Do not push upstream `v*.*.*` tags to `origin`.

## Server branch boundary

The diff from the base can contain any added file. Modifications are limited to:

- `apps/server/src/mcp/**`
- `apps/server/src/provider/Layers/ClaudeAdapter.ts`
- `apps/server/src/provider/Layers/CodexAdapter.ts`
- `apps/server/src/provider/Layers/CodexSessionRuntime.ts`
- `apps/server/src/provider/Layers/CursorAdapter.ts`
- `apps/server/src/provider/Layers/GrokAdapter.ts`
- `apps/server/src/provider/Layers/OpenCodeAdapter.ts`
- `apps/server/package.json`
- `pnpm-lock.yaml`

The executable source of this list is [.github/fork/allowlist.txt](.github/fork/allowlist.txt). Deletions, renames, copies, and modifications to any other upstream-authored file fail CI.

## Server release

Server tags use `server/<upstream-version>-wyrd.<release>`, for example `server/0.0.37-wyrd.1`. This namespace cannot match upstream's `v*.*.*` release trigger. A tag builds the server and Linux x64 resource monitor, packs `t3-<version>.tgz`, and publishes it as a public GitHub Release asset. The tarball bundles a Linux x64 `node-pty` prebuild produced on Debian so installation does not require Python or a C++ toolchain.

The branch declares `@modelcontextprotocol/sdk` directly in `apps/server/package.json` for Cursor's outbound gateway clients. The build temporarily changes only the package version in the runner worktree so that `t3 --version` reports the fork version, then restores the committed manifest before publication.

The public client configuration is derived from the upstream package version carried by the release tag: `server/0.0.37-wyrd.1` is by construction a build of upstream `0.0.37`. The release build extracts the relay, Clerk, and relay client OTLP traces values from the Linux x64 executable that exact public npm package installs (`@t3code/t3-linux-x64`) and verifies the built bundle matches them. This deliberately reproduces upstream's complete telemetry configuration, including its public traces token.

Repository variables named for any of the six public configuration values are optional overrides for deliberate divergence; none are required. Any variable left non-empty shadows derivation. The release logs a warning that names the variable, upstream value, and override value when they differ, then rejects the divergence unless `T3CODE_ALLOW_PUBLIC_CONFIG_DIVERGENCE` is `1`. The built bundle must contain a non-empty value for every field and match the upstream package unless an override is explicitly captured before derivation.

Pull request CI resolves the recorded upstream version through the GitHub API and requires its tag commit to equal the base pin. This external check fails closed so a mismatch cannot survive until an immutable release tag.

The release tarball includes the upstream MIT [LICENSE](LICENSE) and keeps the package repository attribution to `pingdotgg/t3code`.

## External MCP registration

The server branch accepts authenticated `PUT` and `DELETE` requests at
`/api/mcp/provider-session`. Both operations require the
`orchestration:operate` environment scope. Registration accepts a thread ID,
an HTTP or HTTPS endpoint, a Bearer authorization header, and an optional
lower-case server name. Omitting the name selects the stable `external`
default. Successful responses are empty and never return the authorization
header. The reserved internal name `t3-code` cannot be registered externally.

An external registration is additive to T3's internal browser-tool MCP entry
for that thread. Registering or clearing an external entry does not rotate,
replace, revoke, or suppress the internal credential. External endpoints reach
Claude Agent, Codex, Grok, and OpenCode alongside the internal `t3-code` entry
through each driver's existing native MCP configuration. Cursor receives one
`t3-code` loopback entry backed by a provider-session-scoped gateway that
snapshots and connects all entries, rejects raw tool-name collisions, and routes
each call to its owning downstream without exposing an external Bearer to Cursor.
Callers must register before starting the provider session. The new external
configuration attaches only when the provider session next starts. Clearing an
external registration does not reconfigure a running session.

External registrations record browser-tools availability as false. Thread-level
browser-tools availability is true only while the internal `t3-code` entry is
present and its credential grants the `preview` capability. Codex carries that
value into its developer instructions instead of inferring browser-tool
availability from the presence of any MCP server. Claude Agent receives no
separate browser-availability signal.

Grok receives each endpoint as an ACP HTTP MCP server. OpenCode adds each
endpoint as a remote MCP server through the SDK. Cursor's loopback gateway is
authenticated by the existing internal provider credential and closes its
downstream clients on provider stop or credential revocation. These drivers
receive no separate browser-availability signal from the registry.

The gateway preserves MCP tool name, title, description, input schema, output
schema, annotation hints, and `_meta`. Effect's inbound MCP tool model does not
represent the SDK's `icons` or `execution` fields and folds an annotation
`title` into the tool title, so those fields do not reach Cursor through this
compatibility gateway.

OpenCode installs per-thread MCP configuration only into a server process owned
by that provider session. It does not install the endpoint into a configured
external OpenCode server because that server can be shared across threads and
would expose one thread's authorization header to other sessions.

### Live coexistence probe

The opt-in live probe starts real provider harnesses and verifies that an agent
calls an authenticated external fixture tool while T3's internal browser-tool
MCP service remains available in the same thread. It also exercises both
registration orders and verifies that clearing the external entry leaves the
internal entry available on the next session start.

Run it from the repository root in a developer environment where the provider
CLIs are installed and authenticated:

```bash
T3_EXTERNAL_MCP_LIVE_PROBE=1 pnpm exec vp test run apps/server/src/mcp/ExternalMcpLiveProbe.test.ts
```

The probe is deliberately excluded from CI. With
`T3_EXTERNAL_MCP_LIVE_PROBE` unset, the live tests are skipped.

### Consumer-path live probe

The probe above drives the server in-process. It proves the registration
behaviour, but it never crosses the boundary a consumer crosses, so it cannot
see a fault in packaging, publication, or transport.

`apps/server/scripts/consumer-live-probe.sh` closes that gap. It builds a clean
container that installs T3 Code the way a consumer does — the published
`t3code-server` devcontainer Feature, resolving this fork's own latest release —
and then, entirely from outside the server process:

- issues a bearer session token with `t3 auth session issue`, the headless
  entry point a consumer uses;
- confirms unauthenticated external MCP registration is refused;
- registers an MCP endpoint for a thread over `PUT /api/mcp/provider-session`;
- starts a project and a turn over the RPC socket with
  `orchestration.dispatchCommand`;
- requires the agent to call the registered tool, evidenced by the fixture
  server's own record of a call carrying that run's nonce;
- requires the provider process to have received T3's internal `t3-code`
  server alongside the external one, read from the provider's own argv.

```bash
apps/server/scripts/consumer-live-probe.sh
```

It needs Docker, the devcontainer CLI, and Codex credentials at
`~/.codex/auth.json`, which are mounted read-only into the container. Run it on
demand. It is never a CI or release gate: it spends real provider credentials
and depends on a harness this repository does not control.

## Native provider session lookup

The server branch answers authenticated `GET` requests at
`/api/mcp/provider-session`. The operation requires the
`orchestration:operate` environment scope and uses the same bearer
authentication and the same failure responses as the `PUT` and `DELETE`
operations on that path. It introduces no credential and no scope of its own.

The request carries the T3 thread ID as the `threadId` query parameter. A
missing, empty, or malformed thread ID is rejected with `400` and the shared
`invalid_external_mcp_registration` body, the validation the `PUT` operation
applies to its own thread ID.

A thread whose live provider session has announced its harness identifier is
answered with `200` and the JSON body `{"nativeSessionId": "<value>"}`. The
value is the identifier exactly as the harness gave it, never trimmed or
normalized. An unknown thread, a thread with no provider session, and a
session that has not announced an identifier yet are each answered with `404`
and `{"error": "native_session_unknown"}`. No response carries a credential,
an authorization header, a resume cursor, or anything about session content.

The identifier is the one a harness gives its own hooks, so a consumer holding
a Stop hook's `session_id` can map it back to the thread it started. Claude
Agent announces the SDK `session_id` carried by every durable message. Codex
announces the native thread ID its start and resume responses carry. Cursor,
Grok, and OpenCode have no hook session identifier of their own in this
integration and announce nothing, so a lookup for one of their threads is
answered with `404`.

An announcement belongs to one occurrence of one provider session on one
thread. Starting a session opens a new occurrence and discards what the
previous one knew, so a replaced session stops being answered for before its
replacement announces anything. An announcement or a stop that quotes a
retired occurrence is ignored, so a delayed event can neither restore a
replaced identifier nor reach another thread. Later turns in a live session
re-announce the same identifier, and stopping a session clears it.

The record is held in the server process. A restart loses it, and the thread
is answered with `404` until its provider session starts again, which is the
earliest moment a harness hook can fire. Persisting it would mean changing
upstream's persistence and migrations, which are outside the fork's surface.
