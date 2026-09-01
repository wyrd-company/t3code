#!/usr/bin/env bash
# ---
# relationships:
#   verifies:
#     - .github/fork/base-tag
#     - .github/fork/upstream-version
#   used_by:
#     - .github/fork/build-release.sh
#     - .github/fork/test.sh
# ---
set -euo pipefail

if (( $# != 2 )); then
  echo "Usage: verify-upstream-base-pin.sh <upstream-version> <base-pin-file>" >&2
  exit 2
fi

version="$1"
mapfile -t base_pins < <(sed -n '/^[^#]/p' "$2")
if (( ${#base_pins[@]} != 1 )) || [[ ! "${base_pins[0]}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Base pin file must contain exactly one full commit SHA." >&2
  exit 1
fi
base_pin="${base_pins[0]}"
api_root="${GITHUB_API_ROOT:-https://api.github.com/repos/pingdotgg/t3code/git}"

api_get() {
  if [[ -n "${GITHUB_API_COMMAND:-}" ]]; then
    "$GITHUB_API_COMMAND" "$1"
  else
    curl --fail --silent --show-error "$1"
  fi
}

object_json="$(api_get "${api_root}/ref/tags/v${version}")"
object_type="$(node -e 'const value=JSON.parse(process.argv[1]); process.stdout.write(value.object?.type ?? "")' "$object_json")"
object_sha="$(node -e 'const value=JSON.parse(process.argv[1]); process.stdout.write(value.object?.sha ?? "")' "$object_json")"
while [[ "$object_type" == tag ]]; do
  object_json="$(api_get "${api_root}/tags/${object_sha}")"
  object_type="$(node -e 'const value=JSON.parse(process.argv[1]); process.stdout.write(value.object?.type ?? "")' "$object_json")"
  object_sha="$(node -e 'const value=JSON.parse(process.argv[1]); process.stdout.write(value.object?.sha ?? "")' "$object_json")"
done

if [[ "$object_type" != commit || ! "$object_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Upstream tag v${version} did not resolve to a commit." >&2
  exit 1
fi
if [[ "$object_sha" != "$base_pin" ]]; then
  echo "Upstream tag v${version} resolves to ${object_sha}, not base pin ${base_pin}." >&2
  exit 1
fi
echo "Upstream tag v${version} resolves to base pin ${base_pin}."
