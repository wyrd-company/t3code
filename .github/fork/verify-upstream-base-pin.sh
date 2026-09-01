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
    curl_arguments=(--fail --silent --show-error)
    if [[ -n "${GITHUB_TOKEN:-}" ]]; then
      curl_arguments+=(--header "Authorization: Bearer ${GITHUB_TOKEN}")
    fi
    curl "${curl_arguments[@]}" "$1"
  fi
}

parse_object() {
  # The JavaScript template expression belongs to Node.
  # shellcheck disable=SC2016
  node -e '
    try {
      const value = JSON.parse(process.argv[1]);
      const { type, sha } = value.object ?? {};
      if (typeof type !== "string" || typeof sha !== "string") process.exit(1);
      process.stdout.write(`${type} ${sha}`);
    } catch { process.exit(1); }
  ' "$1"
}

if ! object_json="$(api_get "${api_root}/ref/tags/v${version}")"; then
  echo "Failed to resolve upstream tag v${version} for base pin file $2." >&2
  exit 1
fi
if ! parsed_object="$(parse_object "$object_json")"; then
  echo "GitHub returned an invalid object for upstream tag v${version} and base pin file $2." >&2
  exit 1
fi
read -r object_type object_sha <<<"$parsed_object"

tag_depth=0
while [[ "$object_type" == tag && "$tag_depth" -lt 4 ]]; do
  if ! object_json="$(api_get "${api_root}/tags/${object_sha}")"; then
    echo "Failed to dereference upstream tag v${version} for base pin file $2." >&2
    exit 1
  fi
  if ! parsed_object="$(parse_object "$object_json")"; then
    echo "GitHub returned an invalid object while dereferencing upstream tag v${version}." >&2
    exit 1
  fi
  read -r object_type object_sha <<<"$parsed_object"
  ((tag_depth += 1))
done
if [[ "$object_type" == tag ]]; then
  echo "Upstream tag v${version} exceeds the four-hop annotated-tag limit." >&2
  exit 1
fi

if [[ "$object_type" != commit || ! "$object_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Upstream tag v${version} did not resolve to a commit." >&2
  exit 1
fi
if [[ "$object_sha" != "$base_pin" ]]; then
  echo "Upstream tag v${version} resolves to ${object_sha}, not base pin ${base_pin}." >&2
  exit 1
fi
echo "Upstream tag v${version} resolves to base pin ${base_pin}."
