#!/usr/bin/env bash
# ---
# relationships:
#   builds: apps/server
#   calls:
#     - .github/fork/set-package-version.mjs
#     - .github/fork/capture-public-config-overrides.mjs
#     - .github/fork/public-config.mjs
#     - .github/fork/resolve-public-config.mjs
#     - .github/fork/read-upstream-version.sh
#     - .github/fork/verify-base-version.sh
#     - .github/fork/verify-upstream-base-pin.sh
#     - .github/fork/assert-build-config.sh
#     - .github/fork/build-node-pty.sh
#     - .github/fork/pack-server.mjs
#     - .github/fork/verify-release-package.mjs
#   used_by: .github/workflows/fork-release.yml
# ---
set -euo pipefail

if (( $# != 2 )); then
  echo "Usage: build-release.sh <fork-version> <output-directory>" >&2
  exit 2
fi

version="$1"
output_directory="$2"
repo_root="$(git rev-parse --show-toplevel)"
package_json="${repo_root}/apps/server/package.json"
work_directory="$(mktemp -d)"
package_backup="${work_directory}/package.json"
node_pty_prebuild="${work_directory}/pty.node"
upstream_bundle="${work_directory}/upstream-bin.mjs"
operator_overrides="${work_directory}/operator-overrides.json"
effective_config="${work_directory}/effective.env0"
package_changed=false

cleanup() {
  if [[ "$package_changed" == true ]]; then
    cp "$package_backup" "$package_json"
  fi
  rm -rf "$work_directory"
}
trap cleanup EXIT

upstream_version="$("${repo_root}/.github/fork/read-upstream-version.sh" "${repo_root}/.github/fork/upstream-version")"
"${repo_root}/.github/fork/verify-base-version.sh" "$version" "$upstream_version"
"${repo_root}/.github/fork/verify-upstream-base-pin.sh" \
  "$upstream_version" "${repo_root}/.github/fork/base-tag"

node "${repo_root}/.github/fork/capture-public-config-overrides.mjs" "$operator_overrides"
node "${repo_root}/.github/fork/public-config.mjs" package "$upstream_version" \
  --bundle-output "$upstream_bundle" >/dev/null
node "${repo_root}/.github/fork/resolve-public-config.mjs" \
  "$upstream_bundle" "$operator_overrides" env0 >"$effective_config"

config_fields=()
while IFS= read -r -d '' field; do
  config_fields+=("$field")
done <"$effective_config"
for ((index = 0; index < ${#config_fields[@]}; index += 2)); do
  name="${config_fields[index]}"
  declare -gx "$name=${config_fields[index + 1]}"
done

cp "$package_json" "$package_backup"
package_changed=true
node "${repo_root}/.github/fork/set-package-version.mjs" "$package_json" "$version"

vp run --filter t3 build
"${repo_root}/.github/fork/assert-build-config.sh" \
  "${repo_root}/apps/server/dist/bin.mjs" "$upstream_bundle" "$operator_overrides"

cargo build --locked --release --manifest-path "${repo_root}/native/resource-monitor/Cargo.toml"
monitor_target="${repo_root}/apps/server/dist/resource-monitor/linux-x64"
mkdir -p "$monitor_target"
install -m 0755 \
  "${repo_root}/native/resource-monitor/target/release/t3-resource-monitor" \
  "${monitor_target}/t3-resource-monitor"

"${repo_root}/.github/fork/build-node-pty.sh" "$node_pty_prebuild"
tarball="$(
  node "${repo_root}/.github/fork/pack-server.mjs" \
    "$version" "$output_directory" "$node_pty_prebuild"
)"
node "${repo_root}/.github/fork/verify-release-package.mjs" "$tarball" "$version"

cleanup
package_changed=false
trap - EXIT

if ! git diff --quiet -- apps/server/package.json; then
  echo "Build did not restore apps/server/package.json." >&2
  exit 1
fi
