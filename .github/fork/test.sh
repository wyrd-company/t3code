#!/usr/bin/env bash
# ---
# relationships:
#   verifies:
#     - .github/fork/check-allowlist.sh
#     - .github/fork/assert-build-config.sh
#     - .github/fork/public-config.mjs
#     - .github/fork/verify-base-version.sh
#     - .github/fork/set-package-version.mjs
#     - .github/fork/release-version.mjs
#     - .github/fork/bundle-node-pty.mjs
#     - .github/fork/test-packer.mjs
#     - .github/fork/test-release-package.mjs
#     - .github/fork/test-workflows.mjs
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
base_commit="$(git -C "$allowlist_repo" rev-parse HEAD)"
cp "${repo_root}/.github/fork/check-allowlist.sh" "${allowlist_repo}/.github/fork/"
printf '%s\n' "$base_commit" >"${allowlist_repo}/.github/fork/base-tag"
printf 'apps/server/src/mcp/\n' >"${allowlist_repo}/.github/fork/allowlist.txt"
printf 'allowed\n' >"${allowlist_repo}/apps/server/src/mcp/registration.ts"
printf 'modified\n' >"${allowlist_repo}/apps/server/src/mcp/existing.ts"
git -C "$allowlist_repo" add .github apps
git -C "$allowlist_repo" commit --quiet -m allowed

(
  cd "$allowlist_repo"
  test -z "$(git tag --list)"
  .github/fork/check-allowlist.sh >/dev/null
)
echo "PASS allowlist-accepts-reachable-commit-without-tag-ref"

git -C "$allowlist_repo" tag v0.0.37 "$base_commit"
printf 'v0.0.37\n' >"${allowlist_repo}/.github/fork/tag-base-pin"
# $1 belongs to the nested shell.
# shellcheck disable=SC2016
assert_fails allowlist-rejects-tag-name-as-base-pin \
  env FORK_BASE_TAG_FILE="${allowlist_repo}/.github/fork/tag-base-pin" \
    FORK_ALLOWLIST_FILE="${allowlist_repo}/.github/fork/allowlist.txt" \
    bash -c 'cd "$1" && .github/fork/check-allowlist.sh' _ "$allowlist_repo"

printf 'outside allowlist\n' >"${allowlist_repo}/upstream.txt"
git -C "$allowlist_repo" add upstream.txt
git -C "$allowlist_repo" commit --quiet -m rejected

# $1 belongs to the nested shell.
# shellcheck disable=SC2016
assert_fails allowlist-rejects-upstream-edit \
  env FORK_BASE_TAG_FILE="${allowlist_repo}/.github/fork/base-tag" \
    FORK_ALLOWLIST_FILE="${allowlist_repo}/.github/fork/allowlist.txt" \
    bash -c 'cd "$1" && .github/fork/check-allowlist.sh' _ "$allowlist_repo"

upstream_bundle="${repo_root}/.github/fork/fixtures/upstream-public-config.mjs"
node "${repo_root}/.github/fork/public-config.mjs" bundle "$upstream_bundle" >/dev/null
echo "PASS extractor-accepts-complete-bundle"

missing_anchor_bundle="${fixture_root}/missing-anchor.mjs"
sed '/const buildTimeClerkPublishableKey/d' "$upstream_bundle" >"$missing_anchor_bundle"
assert_fails extractor-rejects-absent-anchor \
  node "${repo_root}/.github/fork/public-config.mjs" bundle "$missing_anchor_bundle"

duplicate_anchor_bundle="${fixture_root}/duplicate-anchor.mjs"
cp "$upstream_bundle" "$duplicate_anchor_bundle"
printf '%s\n' \
  'const buildTimeClerkPublishableKey = readBuildTimeValue("pk_test_duplicate");' \
  >>"$duplicate_anchor_bundle"
assert_fails extractor-rejects-duplicate-anchor \
  node "${repo_root}/.github/fork/public-config.mjs" bundle "$duplicate_anchor_bundle"

"${repo_root}/.github/fork/verify-base-version.sh" '0.0.37-wyrd.1' '0.0.37'
echo "PASS release-base-version-matches-recorded-upstream-version"
assert_fails release-base-version-rejects-mismatch \
  "${repo_root}/.github/fork/verify-base-version.sh" '0.0.99-wyrd.1' '0.0.37'

"${repo_root}/.github/fork/assert-build-config.sh" "$upstream_bundle" "$upstream_bundle" >/dev/null
echo "PASS build-config-matches-upstream-derived-values"

mismatched_bundle="${fixture_root}/mismatched.mjs"
sed 's#https://relay.example.invalid#https://different.example.invalid#' \
  "$upstream_bundle" >"$mismatched_bundle"
assert_fails build-config-rejects-value-different-from-upstream \
  "${repo_root}/.github/fork/assert-build-config.sh" "$mismatched_bundle" "$upstream_bundle"

empty_bundle="${fixture_root}/empty.mjs"
sed 's/token-fixture/ /' "$upstream_bundle" >"$empty_bundle"
assert_fails build-config-rejects-empty-derived-value \
  "${repo_root}/.github/fork/assert-build-config.sh" "$empty_bundle" "$empty_bundle"

override_json="$({
  T3CODE_RELAY_URL='https://override.example.invalid' \
    node "${repo_root}/.github/fork/public-config.mjs" bundle "$upstream_bundle" --overrides
})"
node -e \
  'const value = JSON.parse(process.argv[1]); if (value.T3CODE_RELAY_URL !== process.argv[2]) process.exit(1)' \
  "$override_json" 'https://override.example.invalid'
echo "PASS environment-override-takes-precedence-over-derived-value"

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

release_version="$("${repo_root}/.github/fork/release-version.mjs" \
  'server/0.0.37-wyrd.1')"
if [[ "$release_version" != '0.0.37-wyrd.1' ]]; then
  echo "FAIL release-tag-yields-fork-version: ${release_version}" >&2
  exit 1
fi
echo "PASS release-tag-yields-fork-version"

assert_fails release-tag-rejects-upstream-namespace \
  "${repo_root}/.github/fork/release-version.mjs" 'v0.0.37'

node "${repo_root}/.github/fork/test-packer.mjs"
node "${repo_root}/.github/fork/test-release-package.mjs"
node "${repo_root}/.github/fork/test-workflows.mjs"
