#!/usr/bin/env bash
# ---
# relationships:
#   verifies: .github/fork/upstream-version
#   used_by:
#     - .github/fork/build-release.sh
#     - .github/fork/test.sh
# ---
set -euo pipefail

if (( $# != 2 )); then
  echo "Usage: verify-base-version.sh <fork-version> <upstream-version>" >&2
  exit 2
fi

release_base_version="${1%%-wyrd.*}"
if [[ "$release_base_version" != "$2" ]]; then
  echo "Release base version ${release_base_version} does not match upstream version $2." >&2
  exit 1
fi
