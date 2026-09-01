#!/usr/bin/env bash
# ---
# relationships:
#   builds: apps/server
#   calls:
#     - .github/fork/set-package-version.mjs
#     - .github/fork/public-config.mjs
#     - .github/fork/verify-base-version.sh
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
package_backup="$(mktemp)"
node_pty_prebuild_directory="$(mktemp -d)"
node_pty_prebuild="${node_pty_prebuild_directory}/pty.node"
upstream_bundle="${node_pty_prebuild_directory}/upstream-bin.mjs"
upstream_version="$(sed -n '/^[^#]/p' "${repo_root}/.github/fork/upstream-version")"
"${repo_root}/.github/fork/verify-base-version.sh" "$version" "$upstream_version"

cleanup() {
  cp "$package_backup" "$package_json"
  rm -f "$package_backup"
  rm -rf "$node_pty_prebuild_directory"
}
trap cleanup EXIT

cp "$package_json" "$package_backup"
node "${repo_root}/.github/fork/set-package-version.mjs" "$package_json" "$version"

config_fields=()
while IFS= read -r -d '' field; do
  config_fields+=("$field")
done < <(
  node "${repo_root}/.github/fork/public-config.mjs" package "$upstream_version" \
    --format env0 --bundle-output "$upstream_bundle" --overrides
)
for ((index = 0; index < ${#config_fields[@]}; index += 2)); do
  name="${config_fields[index]}"
  if [[ ! -v "$name" ]]; then
    declare -gx "$name=${config_fields[index + 1]}"
  fi
done

vp run --filter t3 build
"${repo_root}/.github/fork/assert-build-config.sh" \
  "${repo_root}/apps/server/dist/bin.mjs" "$upstream_bundle"

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
trap - EXIT

if ! git diff --quiet -- apps/server/package.json; then
  echo "Build did not restore apps/server/package.json." >&2
  exit 1
fi
