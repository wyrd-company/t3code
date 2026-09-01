---
relationships:
  references:
    - .github/fork/base-tag
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
.github/fork/check-allowlist.sh
```

The `upstream` remote push URL must remain `DISABLED`. Do not push upstream `v*.*.*` tags to `origin`.

## Server branch boundary

The diff from the base pin can contain any added file. Modifications are limited to:

- `apps/server/src/mcp/**`
- `apps/server/src/provider/Layers/ClaudeAdapter.ts`
- `apps/server/src/provider/Layers/CodexAdapter.ts`
- `apps/server/src/provider/Layers/CursorAdapter.ts`

The executable source of this list is [.github/fork/allowlist.txt](.github/fork/allowlist.txt). Deletions, renames, copies, and modifications to any other upstream-authored file fail CI.

## Server release

Server tags use `server/<upstream-version>-wyrd.<release>`, for example `server/0.0.37-wyrd.1`. This namespace cannot match upstream's `v*.*.*` release trigger. A tag builds the server and Linux x64 resource monitor, packs `t3-<version>.tgz`, and publishes it as a public GitHub Release asset. The tarball bundles a Linux x64 `node-pty` prebuild produced on Debian so installation does not require Python or a C++ toolchain.

The build temporarily changes the package version in the runner worktree so that `t3 --version` reports the fork version. The build restores `apps/server/package.json` before publication; the fork carries no committed edit to that upstream file.

The public client configuration was harvested from the upstream `t3@0.0.37` bundle. Store it as repository variables named `T3CODE_RELAY_URL`, `T3CODE_CLERK_PUBLISHABLE_KEY`, and `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID`. The release job rejects empty values and verifies the built bundle contains each value. The OTLP traces token is a secret and is intentionally absent.

The release tarball includes the upstream MIT [LICENSE](LICENSE) and keeps the package repository attribution to `pingdotgg/t3code`.
