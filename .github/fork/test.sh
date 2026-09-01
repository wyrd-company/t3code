#!/usr/bin/env bash
# ---
# relationships:
#   verifies:
#     - .github/fork/check-allowlist.sh
#     - .github/fork/assert-build-config.sh
#     - .github/fork/public-config.mjs
#     - .github/fork/read-upstream-version.sh
#     - .github/fork/verify-base-version.sh
#     - .github/fork/verify-upstream-base-pin.sh
#     - .github/fork/test-public-config-names.mjs
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

unset \
  T3CODE_RELAY_URL \
  T3CODE_CLERK_PUBLISHABLE_KEY \
  T3CODE_CLERK_CLI_OAUTH_CLIENT_ID \
  T3CODE_RELAY_CLIENT_OTLP_TRACES_URL \
  T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET \
  T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN

assert_fails() {
  local test_name="$1"
  shift
  if "$@" >"${fixture_root}/${test_name}.out" 2>&1; then
    echo "FAIL ${test_name}: command succeeded" >&2
    return 1
  fi
  echo "PASS ${test_name}"
}

assert_fails_with() {
  local test_name="$1"
  local expected="$2"
  shift 2
  assert_fails "$test_name" "$@"
  if ! grep --fixed-strings --quiet -- "$expected" "${fixture_root}/${test_name}.out"; then
    echo "FAIL ${test_name}: missing error: ${expected}" >&2
    return 1
  fi
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
no_overrides="${fixture_root}/no-overrides.json"
printf '{}\n' >"$no_overrides"
node "${repo_root}/.github/fork/public-config.mjs" bundle "$upstream_bundle" >/dev/null
echo "PASS extractor-accepts-complete-bundle"

missing_anchor_bundle="${fixture_root}/missing-anchor.mjs"
sed '/const buildTimeClerkPublishableKey/d' "$upstream_bundle" >"$missing_anchor_bundle"
assert_fails_with extractor-rejects-absent-anchor \
  'Missing public configuration anchor: buildTimeClerkPublishableKey' \
  node "${repo_root}/.github/fork/public-config.mjs" bundle "$missing_anchor_bundle"

duplicate_anchor_bundle="${fixture_root}/duplicate-anchor.mjs"
cp "$upstream_bundle" "$duplicate_anchor_bundle"
printf '%s\n' \
  'const buildTimeClerkPublishableKey = readBuildTimeValue("pk_test_duplicate");' \
  >>"$duplicate_anchor_bundle"
assert_fails_with extractor-rejects-duplicate-anchor \
  'Duplicate public configuration anchor: buildTimeClerkPublishableKey' \
  node "${repo_root}/.github/fork/public-config.mjs" bundle "$duplicate_anchor_bundle"

assert_fails_with extractor-rejects-missing-format-option-value \
  'Missing value for --format' \
  node "${repo_root}/.github/fork/public-config.mjs" bundle "$upstream_bundle" --format
assert_fails_with extractor-rejects-missing-bundle-output-option-value \
  'Missing value for --bundle-output' \
  node "${repo_root}/.github/fork/public-config.mjs" package '0.0.37' --bundle-output

npm_failure="${fixture_root}/npm-failure"
cat >"$npm_failure" <<'STUB'
#!/usr/bin/env bash
echo 'offline registry failure' >&2
exit 23
STUB
chmod +x "$npm_failure"
assert_fails_with extractor-reports-package-fetch-failure \
  'Failed to fetch t3@0.0.37: offline registry failure' \
  env NPM_COMMAND="$npm_failure" \
    node "${repo_root}/.github/fork/public-config.mjs" package '0.0.37'

upstream_version="$("${repo_root}/.github/fork/read-upstream-version.sh" \
  "${repo_root}/.github/fork/upstream-version")"
"${repo_root}/.github/fork/verify-base-version.sh" \
  "${upstream_version}-wyrd.1" "$upstream_version"
echo "PASS release-base-version-matches-recorded-upstream-version"
assert_fails release-base-version-rejects-mismatch \
  "${repo_root}/.github/fork/verify-base-version.sh" '0.0.99-wyrd.1' "$upstream_version"

malformed_version="${fixture_root}/malformed-version"
printf '0.0.37\n0.0.38\n' >"$malformed_version"
assert_fails upstream-version-rejects-multiple-values \
  "${repo_root}/.github/fork/read-upstream-version.sh" "$malformed_version"

api_stub="${fixture_root}/github-api"
cat >"$api_stub" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  */ref/tags/*) printf '{"object":{"type":"tag","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}\n' ;;
  */tags/*) printf '{"object":{"type":"commit","sha":"%s"}}\n' "$STUB_COMMIT" ;;
  *) exit 1 ;;
esac
STUB
chmod +x "$api_stub"
base_pin="${fixture_root}/base-pin"
printf '%s\n' 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' >"$base_pin"
GITHUB_API_COMMAND="$api_stub" \
STUB_COMMIT='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' \
  "${repo_root}/.github/fork/verify-upstream-base-pin.sh" "$upstream_version" "$base_pin" \
  >/dev/null
echo "PASS upstream-version-tag-resolves-to-base-pin"
assert_fails upstream-version-tag-rejects-different-base-pin \
  env GITHUB_API_COMMAND="$api_stub" \
    STUB_COMMIT='cccccccccccccccccccccccccccccccccccccccc' \
    "${repo_root}/.github/fork/verify-upstream-base-pin.sh" "$upstream_version" "$base_pin"

"${repo_root}/.github/fork/assert-build-config.sh" \
  "$upstream_bundle" "$upstream_bundle" "$no_overrides" >/dev/null
echo "PASS build-config-matches-upstream-derived-values"

mismatched_bundle="${fixture_root}/mismatched.mjs"
sed 's#https://relay.t3.codes#https://different.example.invalid#' \
  "$upstream_bundle" >"$mismatched_bundle"
assert_fails build-config-rejects-value-different-from-upstream \
  "${repo_root}/.github/fork/assert-build-config.sh" \
    "$mismatched_bundle" "$upstream_bundle" "$no_overrides"

empty_built_bundle="${fixture_root}/empty-built.mjs"
sed 's#https://relay.t3.codes# #' "$upstream_bundle" >"$empty_built_bundle"
assert_fails build-config-rejects-empty-built-value \
  "${repo_root}/.github/fork/assert-build-config.sh" \
    "$empty_built_bundle" "$upstream_bundle" "$no_overrides"

empty_upstream_bundle="${fixture_root}/empty-upstream.mjs"
sed 's#https://relay.t3.codes# #' "$upstream_bundle" >"$empty_upstream_bundle"
assert_fails build-config-rejects-empty-derived-value \
  node "${repo_root}/.github/fork/resolve-public-config.mjs" \
    "$empty_upstream_bundle" "$no_overrides"

operator_overrides="${fixture_root}/operator-overrides.json"
T3CODE_RELAY_URL='https://override.example.invalid' \
  node "${repo_root}/.github/fork/capture-public-config-overrides.mjs" "$operator_overrides"
override_warning="${fixture_root}/override-warning"
node "${repo_root}/.github/fork/resolve-public-config.mjs" \
  "$upstream_bundle" "$operator_overrides" >"${fixture_root}/effective.json" 2>"$override_warning"
grep --fixed-strings --quiet \
  'WARNING: T3CODE_RELAY_URL overrides upstream value' "$override_warning"
override_bundle="${fixture_root}/declared-override.mjs"
sed 's#https://relay.t3.codes#https://override.example.invalid#' \
  "$upstream_bundle" >"$override_bundle"
if ! "${repo_root}/.github/fork/assert-build-config.sh" \
  "$override_bundle" "$upstream_bundle" "$operator_overrides" >/dev/null 2>&1; then
  echo "FAIL environment-override-takes-precedence-over-derived-value" >&2
  exit 1
fi
echo "PASS environment-override-takes-precedence-over-derived-value"

T3CODE_RELAY_URL='' \
  node "${repo_root}/.github/fork/capture-public-config-overrides.mjs" "$operator_overrides"
test "$(cat "$operator_overrides")" = '{}'
echo "PASS empty-environment-override-uses-derived-value"

wrong_bundle="${fixture_root}/all-values-wrong.mjs"
sed \
  -e 's#https://relay.t3.codes#https://wrong.example.invalid#' \
  -e 's#pk_live_Y2xlcmsudDMuY29kZXMk#pk_test_wrong#' \
  -e 's#hzxSgY2cH10sDU2r#oauth-wrong#' \
  -e 's#https://api.axiom.co/v1/traces#https://wrong.example.invalid/v1/traces#' \
  -e 's#t3-code-relay-traces-prod#wrong-traces#' \
  -e 's#xaat-8933d243-83eb-4ce0-86ba-8cdd018387c5#token-wrong#' \
  "$upstream_bundle" >"$wrong_bundle"
assert_fails build-config-rejects-six-undeclared-environment-values \
  env T3CODE_RELAY_URL='https://wrong.example.invalid' \
    T3CODE_CLERK_PUBLISHABLE_KEY='pk_test_wrong' \
    T3CODE_CLERK_CLI_OAUTH_CLIENT_ID='oauth-wrong' \
    T3CODE_RELAY_CLIENT_OTLP_TRACES_URL='https://wrong.example.invalid/v1/traces' \
    T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET='wrong-traces' \
    T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN='token-wrong' \
    "${repo_root}/.github/fork/assert-build-config.sh" \
    "$wrong_bundle" "$upstream_bundle" "$no_overrides"

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
node "${repo_root}/.github/fork/test-public-config-names.mjs"
