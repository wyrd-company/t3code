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
  T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN \
  T3CODE_ALLOW_PUBLIC_CONFIG_DIVERGENCE

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

npm_multiple="${fixture_root}/npm-multiple"
cat >"$npm_multiple" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' '[{"filename":"first.tgz"},{"filename":"second.tgz"}]'
STUB
chmod +x "$npm_multiple"
assert_fails_with extractor-rejects-multiple-pack-results \
  'Unexpected npm pack response for t3@0.0.37' \
  env NPM_COMMAND="$npm_multiple" \
    node "${repo_root}/.github/fork/public-config.mjs" package '0.0.37'

upstream_version="$("${repo_root}/.github/fork/read-upstream-version.sh" \
  "${repo_root}/.github/fork/upstream-version")"
documented_base_pin="$(sed -n '/^[^#]/p' "${repo_root}/.github/fork/base-tag")"
if ! grep --fixed-strings --quiet -- \
  "currently commit \`${documented_base_pin}\` from upstream tag \`v${upstream_version}\`" \
  "${repo_root}/FORK.md"; then
  echo "FAIL fork-doc-base-pin-matches-executable-records" >&2
  exit 1
fi
echo "PASS fork-doc-base-pin-matches-executable-records"
"${repo_root}/.github/fork/verify-base-version.sh" \
  "${upstream_version}-wyrd.1" "$upstream_version"
echo "PASS release-base-version-matches-recorded-upstream-version"
assert_fails release-base-version-rejects-mismatch \
  "${repo_root}/.github/fork/verify-base-version.sh" '0.0.99-wyrd.1' "$upstream_version"

malformed_version="${fixture_root}/malformed-version"
printf '0.0.37\n0.0.38\n' >"$malformed_version"
assert_fails upstream-version-rejects-multiple-values \
  "${repo_root}/.github/fork/read-upstream-version.sh" "$malformed_version"

invalid_semver="${fixture_root}/invalid-version"
printf 'release-37\n' >"$invalid_semver"
assert_fails upstream-version-rejects-invalid-semver \
  "${repo_root}/.github/fork/read-upstream-version.sh" "$invalid_semver"

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

multiple_base_pins="${fixture_root}/multiple-base-pins"
printf '%s\n%s\n' \
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' \
  'cccccccccccccccccccccccccccccccccccccccc' >"$multiple_base_pins"
assert_fails upstream-base-pin-rejects-multiple-values \
  "${repo_root}/.github/fork/verify-upstream-base-pin.sh" \
    "$upstream_version" "$multiple_base_pins"

api_failure="${fixture_root}/github-api-failure"
printf '%s\n' '#!/usr/bin/env bash' 'exit 22' >"$api_failure"
chmod +x "$api_failure"
assert_fails_with upstream-base-pin-reports-api-failure \
  "Failed to resolve upstream tag v${upstream_version} for base pin file" \
  env GITHUB_API_COMMAND="$api_failure" \
    "${repo_root}/.github/fork/verify-upstream-base-pin.sh" "$upstream_version" "$base_pin"

curl_stub_directory="${fixture_root}/curl-stub"
mkdir -p "$curl_stub_directory"
cat >"${curl_stub_directory}/curl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >"$STUB_CURL_ARGUMENTS"
if [[ "${STUB_EXPECT_STDIN:-}" == 1 ]]; then cat >"$STUB_CURL_STDIN"; fi
if [[ " $* " == *' --fail '* && "${STUB_CURL_FAIL_ON_FAIL_FLAG:-}" == 1 ]]; then
  exit 22
fi
printf '{"object":{"type":"commit","sha":"%s"}}\n' "$STUB_COMMIT"
STUB
chmod +x "${curl_stub_directory}/curl"
curl_arguments="${fixture_root}/curl-arguments"
curl_stdin="${fixture_root}/curl-stdin"
assert_fails upstream-base-pin-wires-curl-fail-option \
  env PATH="${curl_stub_directory}:$PATH" \
    STUB_CURL_ARGUMENTS="$curl_arguments" \
    STUB_CURL_FAIL_ON_FAIL_FLAG=1 \
    STUB_COMMIT='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' \
    "${repo_root}/.github/fork/verify-upstream-base-pin.sh" "$upstream_version" "$base_pin"

PATH="${curl_stub_directory}:$PATH" \
GITHUB_TOKEN='generic-token' \
STUB_CURL_ARGUMENTS="$curl_arguments" \
STUB_CURL_STDIN="$curl_stdin" \
STUB_EXPECT_STDIN=1 \
STUB_COMMIT='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' \
  "${repo_root}/.github/fork/verify-upstream-base-pin.sh" "$upstream_version" "$base_pin" \
  >/dev/null
if grep --fixed-strings --quiet -- 'generic-token' "$curl_arguments" || \
  ! grep --fixed-strings --quiet -- 'Authorization: Bearer generic-token' "$curl_stdin"; then
  echo "FAIL upstream-base-pin-authenticates-github-api-request" >&2
  exit 1
fi
echo "PASS upstream-base-pin-authenticates-github-api-request"
if ! grep --fixed-strings --quiet -- \
  "https://api.github.com/repos/pingdotgg/t3code/git/ref/tags/v${upstream_version}" \
  "$curl_arguments"; then
  echo "FAIL upstream-base-pin-uses-upstream-github-api-root" >&2
  exit 1
fi
echo "PASS upstream-base-pin-uses-upstream-github-api-root"

api_invalid_json="${fixture_root}/github-api-invalid-json"
printf '%s\n' '#!/usr/bin/env bash' "printf '%s\\n' '<html>rate limited</html>'" \
  >"$api_invalid_json"
chmod +x "$api_invalid_json"
assert_fails_with upstream-base-pin-rejects-invalid-api-response \
  "GitHub returned an invalid object for upstream tag v${upstream_version}" \
  env GITHUB_API_COMMAND="$api_invalid_json" \
    "${repo_root}/.github/fork/verify-upstream-base-pin.sh" "$upstream_version" "$base_pin"

api_non_commit="${fixture_root}/github-api-non-commit"
printf '%s\n' '#!/usr/bin/env bash' \
  "printf '%s\\n' '{\"object\":{\"type\":\"blob\",\"sha\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"}}'" \
  >"$api_non_commit"
chmod +x "$api_non_commit"
assert_fails upstream-base-pin-rejects-non-commit-object \
  env GITHUB_API_COMMAND="$api_non_commit" \
    "${repo_root}/.github/fork/verify-upstream-base-pin.sh" "$upstream_version" "$base_pin"

api_tag_loop="${fixture_root}/github-api-tag-loop"
printf '%s\n' '#!/usr/bin/env bash' \
  "printf '%s\\n' '{\"object\":{\"type\":\"tag\",\"sha\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}}'" \
  >"$api_tag_loop"
chmod +x "$api_tag_loop"
assert_fails_with upstream-base-pin-bounds-annotated-tag-dereference \
  'exceeds the four-hop annotated-tag limit' \
  env GITHUB_API_COMMAND="$api_tag_loop" \
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

empty_upstream_bundle="${fixture_root}/empty-upstream.mjs"
sed 's#https://relay.t3.codes# #' "$upstream_bundle" >"$empty_upstream_bundle"
assert_fails build-config-rejects-empty-derived-value \
  node "${repo_root}/.github/fork/resolve-public-config.mjs" \
    "$empty_upstream_bundle" "$no_overrides"

operator_overrides="${fixture_root}/operator-overrides.json"
T3CODE_RELAY_URL='https://override.example.invalid' \
  node "${repo_root}/.github/fork/capture-public-config-overrides.mjs" "$operator_overrides"
override_warning="${fixture_root}/override-warning"
assert_fails_with divergent-environment-override-requires-acknowledgement \
  'Public configuration divergence requires T3CODE_ALLOW_PUBLIC_CONFIG_DIVERGENCE=1' \
  node "${repo_root}/.github/fork/resolve-public-config.mjs" \
    "$upstream_bundle" "$operator_overrides"
assert_fails_with divergent-environment-override-rejects-true-acknowledgement \
  'Public configuration divergence requires T3CODE_ALLOW_PUBLIC_CONFIG_DIVERGENCE=1' \
  env T3CODE_ALLOW_PUBLIC_CONFIG_DIVERGENCE=true \
    node "${repo_root}/.github/fork/resolve-public-config.mjs" \
    "$upstream_bundle" "$operator_overrides"
T3CODE_ALLOW_PUBLIC_CONFIG_DIVERGENCE=1 \
  node "${repo_root}/.github/fork/resolve-public-config.mjs" \
    "$upstream_bundle" "$operator_overrides" >"${fixture_root}/effective.json" 2>"$override_warning"
if ! grep --fixed-strings --quiet \
  'WARNING: T3CODE_RELAY_URL overrides upstream value' "$override_warning"; then
  echo "FAIL divergent-environment-override-emits-warning" >&2
  exit 1
fi
echo "PASS divergent-environment-override-emits-warning"
override_bundle="${fixture_root}/declared-override.mjs"
sed 's#https://relay.t3.codes#https://override.example.invalid#' \
  "$upstream_bundle" >"$override_bundle"
if ! T3CODE_ALLOW_PUBLIC_CONFIG_DIVERGENCE=1 \
  "${repo_root}/.github/fork/assert-build-config.sh" \
  "$override_bundle" "$upstream_bundle" "$operator_overrides" >/dev/null 2>&1; then
  echo "FAIL environment-override-takes-precedence-over-derived-value" >&2
  exit 1
fi
echo "PASS environment-override-takes-precedence-over-derived-value"

T3CODE_RELAY_URL='' \
  node "${repo_root}/.github/fork/capture-public-config-overrides.mjs" "$operator_overrides"
if [[ "$(cat "$operator_overrides")" != '{}' ]]; then
  echo "FAIL empty-environment-override-uses-derived-value" >&2
  exit 1
fi
echo "PASS empty-environment-override-uses-derived-value"

T3CODE_RELAY_URL=' ' \
  node "${repo_root}/.github/fork/capture-public-config-overrides.mjs" "$operator_overrides"
assert_fails_with public-config-rejects-whitespace-override \
  'Public configuration override is empty: T3CODE_RELAY_URL' \
  node "${repo_root}/.github/fork/resolve-public-config.mjs" \
    "$upstream_bundle" "$operator_overrides"

printf '{"UNDECLARED_PUBLIC_CONFIG":"value"}\n' >"$operator_overrides"
assert_fails_with public-config-rejects-unknown-override-name \
  'Unknown public configuration override: UNDECLARED_PUBLIC_CONFIG' \
  node "${repo_root}/.github/fork/resolve-public-config.mjs" \
    "$upstream_bundle" "$operator_overrides"

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

release_stubs="${fixture_root}/release-stubs"
release_repo="${fixture_root}/release-repo"
mkdir -p "$release_stubs" "${fixture_root}/release-output" \
  "${release_repo}/.github" "${release_repo}/apps/server"
cp -R "${repo_root}/.github/fork" "${release_repo}/.github/fork"
printf '{"name":"generic","version":"0.0.36"}\n' \
  >"${release_repo}/apps/server/package.json"
git -C "$release_repo" init --quiet
git -C "$release_repo" config user.name "Release Orchestration Test"
git -C "$release_repo" config user.email "release-orchestration@example.invalid"
git -C "$release_repo" add .github apps/server/package.json
git -C "$release_repo" commit --quiet -m fixture

assert_release_case_fails_with() {
  local test_name="$1"
  shift
  assert_fails_with "$test_name" "$@"
  if ! git -C "$release_repo" diff --quiet -- apps/server/package.json; then
    echo "FAIL release-build-restores-package-after-failure" >&2
    return 1
  fi
}
npm_release_stub="${release_stubs}/npm-pack"
cat >"$npm_release_stub" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
destination=''
while (( $# > 0 )); do
  if [[ "$1" == --pack-destination ]]; then
    destination="$2"
    break
  fi
  shift
done
test -n "$destination"
package_root="$(mktemp -d)"
mkdir -p "${package_root}/package/dist"
cp "$STUB_UPSTREAM_BUNDLE" "${package_root}/package/dist/bin.mjs"
tar -czf "${destination}/t3-0.0.37.tgz" -C "$package_root" package
printf '%s\n' '[{"filename":"t3-0.0.37.tgz"}]'
STUB
chmod +x "$npm_release_stub"
cp "$npm_release_stub" "${release_stubs}/npm"
PATH="${release_stubs}:$PATH" \
STUB_UPSTREAM_BUNDLE="$upstream_bundle" \
  env -u NPM_COMMAND node "${repo_root}/.github/fork/public-config.mjs" \
    package "$upstream_version" >/dev/null
echo "PASS extractor-uses-default-npm-command"
cat >"${release_stubs}/vp" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
repo_root="$(git rev-parse --show-toplevel)"
built_bundle="${repo_root}/apps/server/dist/bin.mjs"
mkdir -p "$(dirname "$built_bundle")"
if [[ "${STUB_FORCE_WRONG_BUNDLE:-}" == 1 ]]; then
  cp "$STUB_WRONG_BUNDLE" "$built_bundle"
  exit
fi
node - "$STUB_UPSTREAM_BUNDLE" "$built_bundle" <<'NODE'
const fs = require("node:fs");
const [sourcePath, outputPath] = process.argv.slice(2);
const replacements = [
  ["T3CODE_RELAY_URL", "https://relay.t3.codes"],
  ["T3CODE_CLERK_PUBLISHABLE_KEY", "pk_live_Y2xlcmsudDMuY29kZXMk"],
  ["T3CODE_CLERK_CLI_OAUTH_CLIENT_ID", "hzxSgY2cH10sDU2r"],
  ["T3CODE_RELAY_CLIENT_OTLP_TRACES_URL", "https://api.axiom.co/v1/traces"],
  ["T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET", "t3-code-relay-traces-prod"],
  ["T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN", "xaat-8933d243-83eb-4ce0-86ba-8cdd018387c5"],
];
let source = fs.readFileSync(sourcePath, "utf8");
for (const [name, original] of replacements) {
  source = source.replace(JSON.stringify(original), JSON.stringify(process.env[name] ?? ""));
}
fs.writeFileSync(outputPath, source);
NODE
STUB
chmod +x "${release_stubs}/vp"
cat >"${release_stubs}/cargo" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${STUB_CARGO_SUCCEED:-}" == 1 ]]; then
  repo_root="$(git rev-parse --show-toplevel)"
  monitor="${repo_root}/native/resource-monitor/target/release/t3-resource-monitor"
  mkdir -p "$(dirname "$monitor")"
  printf '%s\n' '#!/usr/bin/env bash' 'exit 0' >"$monitor"
  chmod +x "$monitor"
  exit 0
fi
echo 'cargo must not run before public configuration assertion' >&2
exit 29
STUB
chmod +x "${release_stubs}/cargo"
cat >"${release_repo}/.github/fork/build-node-pty.sh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf 'fixture node pty\n' >"$1"
STUB
chmod +x "${release_repo}/.github/fork/build-node-pty.sh"
cat >"${release_repo}/.github/fork/pack-server.mjs" <<'STUB'
#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
const [version, outputDirectory] = process.argv.slice(2);
fs.mkdirSync(outputDirectory, { recursive: true });
const tarball = path.join(outputDirectory, `t3-${version}.tgz`);
fs.writeFileSync(tarball, "fixture tarball\n");
console.log(tarball);
STUB
chmod +x "${release_repo}/.github/fork/pack-server.mjs"
cat >"${release_repo}/.github/fork/verify-release-package.mjs" <<'STUB'
#!/usr/bin/env node
process.exit(0);
STUB
chmod +x "${release_repo}/.github/fork/verify-release-package.mjs"
git -C "$release_repo" add .github/fork/build-node-pty.sh \
  .github/fork/pack-server.mjs .github/fork/verify-release-package.mjs
git -C "$release_repo" commit --quiet -m 'stub post-assertion release tools'
cat >"${release_stubs}/run-release" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
cd "$STUB_RELEASE_REPO"
exec .github/fork/build-release.sh "$@"
STUB
chmod +x "${release_stubs}/run-release"
release_base_pin="$(sed -n '/^[^#]/p' "${repo_root}/.github/fork/base-tag")"
release_built_bundle="${release_repo}/apps/server/dist/bin.mjs"
mkdir -p "$(dirname "$release_built_bundle")"
cp "$wrong_bundle" "$release_built_bundle"
assert_release_case_fails_with release-build-exports-derived-config-to-build-environment \
  'cargo must not run before public configuration assertion' \
  env PATH="${release_stubs}:$PATH" \
    NPM_COMMAND="$npm_release_stub" \
    STUB_UPSTREAM_BUNDLE="$upstream_bundle" \
    STUB_WRONG_BUNDLE="$wrong_bundle" \
    STUB_RELEASE_REPO="$release_repo" \
    GITHUB_API_COMMAND="$api_stub" \
    STUB_COMMIT="$release_base_pin" \
    "${release_stubs}/run-release" \
    "${upstream_version}-wyrd.1" "${fixture_root}/release-output"

assert_release_case_fails_with release-build-applies-acknowledged-operator-override \
  'cargo must not run before public configuration assertion' \
  env PATH="${release_stubs}:$PATH" \
    NPM_COMMAND="$npm_release_stub" \
    STUB_UPSTREAM_BUNDLE="$upstream_bundle" \
    STUB_WRONG_BUNDLE="$wrong_bundle" \
    STUB_RELEASE_REPO="$release_repo" \
    GITHUB_API_COMMAND="$api_stub" \
    STUB_COMMIT="$release_base_pin" \
    T3CODE_RELAY_URL='https://override.example.invalid' \
    T3CODE_ALLOW_PUBLIC_CONFIG_DIVERGENCE=1 \
    "${release_stubs}/run-release" \
    "${upstream_version}-wyrd.1" "${fixture_root}/release-output"
override_built_json="$(
  node "${repo_root}/.github/fork/public-config.mjs" bundle "$release_built_bundle"
)"
if ! node -e \
  'const value=JSON.parse(process.argv[1]); if (value.T3CODE_RELAY_URL !== process.argv[2]) process.exit(1)' \
  "$override_built_json" 'https://override.example.invalid'; then
  echo "FAIL release-build-uses-captured-operator-overrides" >&2
  exit 1
fi
echo "PASS release-build-uses-captured-operator-overrides"

assert_release_case_fails_with release-build-rejects-undeclared-built-config-divergence \
  'Built public configuration differs from expected value: T3CODE_RELAY_URL' \
  env PATH="${release_stubs}:$PATH" \
    NPM_COMMAND="$npm_release_stub" \
    STUB_UPSTREAM_BUNDLE="$upstream_bundle" \
    STUB_WRONG_BUNDLE="$wrong_bundle" \
    STUB_FORCE_WRONG_BUNDLE=1 \
    STUB_RELEASE_REPO="$release_repo" \
    GITHUB_API_COMMAND="$api_stub" \
    STUB_COMMIT="$release_base_pin" \
    "${release_stubs}/run-release" \
    "${upstream_version}-wyrd.1" "${fixture_root}/release-output"

assert_release_case_fails_with release-build-rejects-version-mismatched-with-upstream \
  'Release base version 0.0.36 does not match upstream version' \
  env PATH="${release_stubs}:$PATH" \
    NPM_COMMAND="$npm_release_stub" \
    STUB_UPSTREAM_BUNDLE="$upstream_bundle" \
    STUB_WRONG_BUNDLE="$wrong_bundle" \
    STUB_RELEASE_REPO="$release_repo" \
    GITHUB_API_COMMAND="$api_stub" \
    STUB_COMMIT="$release_base_pin" \
    "${release_stubs}/run-release" \
    '0.0.36-wyrd.1' "${fixture_root}/release-output"

assert_release_case_fails_with release-build-rejects-upstream-tag-mismatched-with-base-pin \
  "not base pin ${release_base_pin}" \
  env PATH="${release_stubs}:$PATH" \
    NPM_COMMAND="$npm_release_stub" \
    STUB_UPSTREAM_BUNDLE="$upstream_bundle" \
    STUB_WRONG_BUNDLE="$wrong_bundle" \
    STUB_RELEASE_REPO="$release_repo" \
    GITHUB_API_COMMAND="$api_stub" \
    STUB_COMMIT='dddddddddddddddddddddddddddddddddddddddd' \
    "${release_stubs}/run-release" \
    "${upstream_version}-wyrd.1" "${fixture_root}/release-output"
echo "PASS release-build-restores-package-after-failure"

if ! PATH="${release_stubs}:$PATH" \
  NPM_COMMAND="$npm_release_stub" \
  STUB_UPSTREAM_BUNDLE="$upstream_bundle" \
  STUB_WRONG_BUNDLE="$wrong_bundle" \
  STUB_RELEASE_REPO="$release_repo" \
  STUB_CARGO_SUCCEED=1 \
  GITHUB_API_COMMAND="$api_stub" \
  STUB_COMMIT="$release_base_pin" \
  "${release_stubs}/run-release" \
  "${upstream_version}-wyrd.1" "${fixture_root}/release-output"; then
  echo "FAIL release-build-completes-success-path" >&2
  exit 1
fi
if [[ "$(node -p "require('${release_repo}/apps/server/package.json').version")" != '0.0.36' ]] || \
  ! git -C "$release_repo" diff --quiet -- apps/server/package.json; then
  echo "FAIL release-build-restores-package-after-success" >&2
  exit 1
fi
echo "PASS release-build-completes-success-path"
echo "PASS release-build-restores-package-after-success"

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
