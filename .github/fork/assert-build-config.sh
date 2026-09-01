#!/usr/bin/env bash
# ---
# relationships:
#   verifies: apps/server/vite.config.ts
#   uses: .github/fork/public-config.mjs
#   used_by: .github/fork/build-release.sh
# ---
set -euo pipefail

if (( $# != 2 )); then
  echo "Usage: assert-build-config.sh <built-bundle> <upstream-bundle>" >&2
  exit 2
fi

repo_root="$(git rev-parse --show-toplevel)"
built_json="$(node "${repo_root}/.github/fork/public-config.mjs" bundle "$1")"
upstream_json="$(node "${repo_root}/.github/fork/public-config.mjs" bundle "$2" --overrides)"

node - "$built_json" "$upstream_json" <<'NODE'
const built = JSON.parse(process.argv[2]);
const upstream = JSON.parse(process.argv[3]);
for (const [name, expected] of Object.entries(upstream)) {
  if (expected.trim() === "") {
    console.error(`Upstream derived public configuration is empty: ${name}`);
    process.exit(1);
  }
  if (built[name].trim() === "") {
    console.error(`Built public configuration is empty: ${name}`);
    process.exit(1);
  }
  if (built[name] !== expected) {
    console.error(`Built public configuration differs from upstream: ${name}`);
    process.exit(1);
  }
}
NODE

echo "Built server bundle matches every upstream public configuration value."
