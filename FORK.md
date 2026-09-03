---
relationships:
  references:
    - .github/fork/base-tag
    - .github/fork/upstream-version
    - .github/fork/allowlist.txt
    - LICENSE
---

# Wyrd Company T3 Code fork

This repository keeps `main` as a pristine mirror of `pingdotgg/t3code`. Fork changes live on branches that are rebased directly onto upstream release tags:

- `mcp-external-registration` publishes the Linux server package.
- `web-image` publishes the unmodified web client container image.

Do not merge the fork branches together. Do not merge upstream into either branch.

## Base pin and rebase

The server branch base pin is [.github/fork/base-tag](.github/fork/base-tag), currently commit `cefec32d6fc5d14f03e110ebdde534bdbcc9b62b` from upstream tag `v0.0.37`. The executable pin is a full commit SHA so a checkout from `origin` does not require the upstream tag ref. Moving it is deliberate:

```bash
git fetch upstream --tags
new_base_tag=<new-upstream-tag>
new_base_commit="$(git rev-parse "refs/tags/${new_base_tag}^{commit}")"
git switch mcp-external-registration
git rebase "refs/tags/${new_base_tag}"
printf '%s\n' "$new_base_commit" > .github/fork/base-tag
printf '%s\n' "${new_base_tag#v}" > .github/fork/upstream-version
# Update the base pin sentence above to name the new commit and tag.
.github/fork/check-allowlist.sh
```

The `upstream` remote push URL must remain `DISABLED`. Do not push upstream `v*.*.*` tags to `origin`.

## Server branch boundary

The diff from the base pin can contain any added file. Modifications are limited to:

- `apps/server/src/mcp/**`
- `apps/server/src/provider/Layers/ClaudeAdapter.ts`
- `apps/server/src/provider/Layers/CodexAdapter.ts`
- `apps/server/src/provider/Layers/CursorAdapter.ts`
- `apps/server/src/provider/Layers/GrokAdapter.ts`
- `apps/server/src/provider/Layers/OpenCodeAdapter.ts`

The executable source of this list is [.github/fork/allowlist.txt](.github/fork/allowlist.txt). Deletions, renames, copies, and modifications to any other upstream-authored file fail CI.

## Server release

Server tags use `server/<upstream-version>-wyrd.<release>`, for example `server/0.0.37-wyrd.1`. This namespace cannot match upstream's `v*.*.*` release trigger. A tag builds the server and Linux x64 resource monitor, packs `t3-<version>.tgz`, and publishes it as a public GitHub Release asset. The tarball bundles a Linux x64 `node-pty` prebuild produced on Debian so installation does not require Python or a C++ toolchain.

The build temporarily changes the package version in the runner worktree so that `t3 --version` reports the fork version. The build restores `apps/server/package.json` before publication; the fork carries no committed edit to that upstream file.

The public client configuration is derived from the upstream package version in [.github/fork/upstream-version](.github/fork/upstream-version), which corresponds to the base pin. The release base version must match this record. The release build extracts the relay, Clerk, and relay client OTLP traces values from that exact public npm package and verifies the built bundle matches them. This deliberately reproduces upstream's complete telemetry configuration, including its public traces token.

Repository variables named for any of the six public configuration values are optional overrides for deliberate divergence; none are required. Any variable left non-empty shadows derivation. The release logs a warning that names the variable, upstream value, and override value when they differ, then rejects the divergence unless `T3CODE_ALLOW_PUBLIC_CONFIG_DIVERGENCE` is `1`. The built bundle must contain a non-empty value for every field and match the upstream package unless an override is explicitly captured before derivation.

Pull request CI resolves the recorded upstream version through the GitHub API and requires its tag commit to equal the base pin. This external check fails closed so a mismatch cannot survive until an immutable release tag.

The release tarball includes the upstream MIT [LICENSE](LICENSE) and keeps the package repository attribution to `pingdotgg/t3code`.

## External MCP registration

The server branch accepts authenticated `PUT` and `DELETE` requests at
`/api/mcp/provider-session`. Both operations require the
`orchestration:operate` environment scope. Registration accepts a thread ID,
an HTTP or HTTPS endpoint, and a Bearer authorization header. Successful
responses are empty and never return the authorization header.

An external registration is additive to T3's internal browser-tool MCP entry
for that thread. Registering or clearing an external entry does not rotate,
replace, revoke, or suppress the internal credential. External endpoints reach
Claude Agent, Codex, Cursor, Grok, and OpenCode alongside the internal `t3-code`
entry through each driver's existing native MCP configuration. Callers must
register before starting the provider session. The new external configuration
attaches only when the provider session next starts. Clearing an external
registration does not reconfigure a running session.

External registrations record browser-tools availability as false. Thread-level
browser-tools availability is true only while the internal `t3-code` entry is
present. Codex carries that value into its developer instructions instead of
inferring browser-tool availability from the presence of any MCP server. Claude
Agent receives no separate browser-availability signal.

Cursor and Grok receive the endpoint as an ACP HTTP MCP server. OpenCode adds it
as a remote MCP server through the SDK. These drivers receive no separate
browser-availability signal from the registry.

OpenCode installs per-thread MCP configuration only into a server process owned
by that provider session. It does not install the endpoint into a configured
external OpenCode server because that server can be shared across threads and
would expose one thread's authorization header to other sessions.
