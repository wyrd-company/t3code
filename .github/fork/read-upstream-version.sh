#!/usr/bin/env bash
# ---
# relationships:
#   reads: .github/fork/upstream-version
#   used_by:
#     - .github/fork/build-release.sh
#     - .github/fork/test.sh
# ---
set -euo pipefail

if (( $# != 1 )); then
  echo "Usage: read-upstream-version.sh <version-file>" >&2
  exit 2
fi

mapfile -t versions < <(sed -n '/^[^#]/p' "$1")
if (( ${#versions[@]} != 1 )) || [[ ! "${versions[0]}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Upstream version file must contain exactly one semantic version." >&2
  exit 1
fi
printf '%s\n' "${versions[0]}"
