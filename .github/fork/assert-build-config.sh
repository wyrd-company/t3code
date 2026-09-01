#!/usr/bin/env bash
# ---
# relationships:
#   verifies: apps/server/vite.config.ts
#   used_by: .github/fork/build-release.sh
# ---
set -euo pipefail

bundle_path="${1:-apps/server/dist/bin.mjs}"
required=(
  T3CODE_RELAY_URL
  T3CODE_CLERK_PUBLISHABLE_KEY
  T3CODE_CLERK_CLI_OAUTH_CLIENT_ID
)

if [[ ! -f "$bundle_path" ]]; then
  echo "Built server bundle is missing: $bundle_path" >&2
  exit 1
fi

for variable_name in "${required[@]}"; do
  value="${!variable_name-}"
  if [[ -z "${value//[[:space:]]/}" ]]; then
    echo "Required public build configuration is empty: ${variable_name}" >&2
    exit 1
  fi

  if ! grep --fixed-strings --quiet -- "$value" "$bundle_path"; then
    echo "Built server bundle does not contain ${variable_name}." >&2
    exit 1
  fi
done

echo "Built server bundle contains every required non-empty public configuration value."
