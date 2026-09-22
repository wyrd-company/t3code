#!/usr/bin/env bash
# ---
# relationships:
#   builds: apps/server
#   calls:
#     - .github/fork/set-package-version.mjs
#     - apps/server/scripts/cli.ts
#     - scripts/build-cli-archive.ts
#     - scripts/smoke-cli-archive.ts
#   depends_on: .github/fork/build-release.sh
#   used_by: .github/workflows/fork-release.yml
# ---
#
# Packages the server as upstream's self-contained Linux x64 CLI archive:
# the single-executable, the web client, the resource monitor, and the
# runtime-external native packages beside it. Nothing in the archive needs
# Node, npm, or a compiler on the machine that unpacks it, which is what lets
# the server's own service launcher and self-update path run it.
#
# Runs after build-release.sh, which leaves apps/server/dist/client and
# apps/server/dist/resource-monitor/linux-x64 behind. The executable is built
# with the fork version set in apps/server/package.json, the same window
# build-release.sh uses, so the archive reports the fork version.
set -euo pipefail

if (( $# != 2 )); then
  echo "Usage: build-archive.sh <fork-version> <output-directory>" >&2
  exit 2
fi

version="$1"
output_directory="$2"
repo_root="$(git rev-parse --show-toplevel)"
package_json="${repo_root}/apps/server/package.json"
web_client="${repo_root}/apps/server/dist/client/index.html"
resource_monitor="${repo_root}/apps/server/dist/resource-monitor/linux-x64/t3-resource-monitor"
archive="${output_directory}/t3-${version}-linux-x64.tar.gz"
work_directory="$(mktemp -d)"
package_backup="${work_directory}/package.json"
package_changed=false

cleanup() {
  if [[ "$package_changed" == true ]]; then
    cp "$package_backup" "$package_json"
  fi
  rm -rf "$work_directory"
}
trap cleanup EXIT

if [[ "${version%%-wyrd.*}" == "$version" ]]; then
  echo "Release version ${version} does not carry a -wyrd counter." >&2
  exit 1
fi

for input in "$web_client" "$resource_monitor"; do
  if [[ ! -f "$input" ]]; then
    echo "Missing ${input}; run build-release.sh first." >&2
    exit 1
  fi
done

cp "$package_json" "$package_backup"
package_changed=true
node "${repo_root}/.github/fork/set-package-version.mjs" "$package_json" "$version"

(
  cd "$repo_root"
  node apps/server/scripts/cli.ts build-exe --verbose
  node scripts/build-cli-archive.ts \
    --platform linux \
    --arch x64 \
    --version "$version" \
    --output-dir "$output_directory"
  node scripts/smoke-cli-archive.ts --archive "$archive" --expect-version "$version"
)

if [[ ! -f "$archive" ]]; then
  echo "Archive build did not produce ${archive}." >&2
  exit 1
fi

cleanup
package_changed=false
trap - EXIT

if ! git diff --quiet HEAD -- "$package_json"; then
  echo "Build did not restore apps/server/package.json." >&2
  exit 1
fi

printf '%s\n' "$archive"
