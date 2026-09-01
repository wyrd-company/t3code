#!/usr/bin/env bash
# ---
# relationships:
#   verifies: apps/server/vite.config.ts
#   uses:
#     - .github/fork/public-config.mjs
#     - .github/fork/resolve-public-config.mjs
#   used_by: .github/fork/build-release.sh
# ---
set -euo pipefail

if (( $# != 3 )); then
  echo "Usage: assert-build-config.sh <built-bundle> <upstream-bundle> <operator-overrides-json>" >&2
  exit 2
fi

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
built_json="$(node "${script_directory}/public-config.mjs" bundle "$1")"
expected_json="$(node "${script_directory}/resolve-public-config.mjs" "$2" "$3")"

node - "$built_json" "$expected_json" <<'NODE'
const built = JSON.parse(process.argv[2]);
const expectedConfig = JSON.parse(process.argv[3]);
for (const [name, expected] of Object.entries(expectedConfig)) {
  if (built[name] !== expected) {
    console.error(`Built public configuration differs from expected value: ${name}`);
    process.exit(1);
  }
}
NODE

echo "Built server bundle matches upstream public configuration and declared operator overrides."
