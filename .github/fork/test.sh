#!/usr/bin/env bash
# ---
# relationships:
#   verifies:
#     - .github/fork/check-allowlist.sh
#     - .github/fork/assert-build-config.sh
#     - .github/fork/set-package-version.mjs
# ---
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
fixture_root="$(mktemp -d)"
trap 'rm -rf "$fixture_root"' EXIT

assert_fails() {
  local test_name="$1"
  shift
  if "$@" >"${fixture_root}/${test_name}.out" 2>&1; then
    echo "FAIL ${test_name}: command succeeded" >&2
    return 1
  fi
  echo "PASS ${test_name}"
}

allowlist_repo="${fixture_root}/allowlist"
mkdir -p "${allowlist_repo}/.github/fork" "${allowlist_repo}/apps/server/src/mcp"
git -C "$allowlist_repo" init --quiet
git -C "$allowlist_repo" config user.name "Fork Guard Test"
git -C "$allowlist_repo" config user.email "fork-guard@example.invalid"
printf 'upstream\n' >"${allowlist_repo}/upstream.txt"
printf 'base\n' >"${allowlist_repo}/apps/server/src/mcp/existing.ts"
git -C "$allowlist_repo" add upstream.txt apps/server/src/mcp/existing.ts
git -C "$allowlist_repo" commit --quiet -m base
git -C "$allowlist_repo" tag v0.0.37
cp "${repo_root}/.github/fork/check-allowlist.sh" "${allowlist_repo}/.github/fork/"
printf 'v0.0.37\n' >"${allowlist_repo}/.github/fork/base-tag"
printf 'apps/server/src/mcp/\n' >"${allowlist_repo}/.github/fork/allowlist.txt"
printf 'allowed\n' >"${allowlist_repo}/apps/server/src/mcp/registration.ts"
printf 'modified\n' >"${allowlist_repo}/apps/server/src/mcp/existing.ts"
git -C "$allowlist_repo" add .github apps
git -C "$allowlist_repo" commit --quiet -m allowed

(
  cd "$allowlist_repo"
  .github/fork/check-allowlist.sh >/dev/null
)
echo "PASS allowlist-accepts-added-and-listed-paths"

printf 'outside allowlist\n' >"${allowlist_repo}/upstream.txt"
git -C "$allowlist_repo" add upstream.txt
git -C "$allowlist_repo" commit --quiet -m rejected

assert_fails allowlist-rejects-upstream-edit \
  env FORK_BASE_TAG_FILE="${allowlist_repo}/.github/fork/base-tag" \
    FORK_ALLOWLIST_FILE="${allowlist_repo}/.github/fork/allowlist.txt" \
    bash -c 'cd "$1" && .github/fork/check-allowlist.sh' _ "$allowlist_repo"

bundle="${fixture_root}/bin.mjs"
printf '%s\n' 'https://relay.example.invalid' 'pk_test_generic' 'oauth-client-generic' >"$bundle"
T3CODE_RELAY_URL='https://relay.example.invalid' \
T3CODE_CLERK_PUBLISHABLE_KEY='pk_test_generic' \
T3CODE_CLERK_CLI_OAUTH_CLIENT_ID='oauth-client-generic' \
  "${repo_root}/.github/fork/assert-build-config.sh" "$bundle" >/dev/null
echo "PASS build-config-accepts-populated-bundle"

assert_fails build-config-rejects-empty-value \
  env T3CODE_RELAY_URL='' \
    T3CODE_CLERK_PUBLISHABLE_KEY='pk_test_generic' \
    T3CODE_CLERK_CLI_OAUTH_CLIENT_ID='oauth-client-generic' \
    "${repo_root}/.github/fork/assert-build-config.sh" "$bundle"

package_fixture="${fixture_root}/package.json"
printf '{"name":"generic","version":"1.0.0"}\n' >"$package_fixture"
node "${repo_root}/.github/fork/set-package-version.mjs" \
  "$package_fixture" '0.0.37-wyrd.1'
node -e \
  'const p = require(process.argv[1]); if (p.version !== process.argv[2]) process.exit(1)' \
  "$package_fixture" '0.0.37-wyrd.1'
echo "PASS package-version-is-fork-distinguishable"

assert_fails package-version-rejects-upstream-version \
  node "${repo_root}/.github/fork/set-package-version.mjs" "$package_fixture" '0.0.37'
