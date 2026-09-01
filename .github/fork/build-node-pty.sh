#!/usr/bin/env bash
# ---
# relationships:
#   builds: node-pty
#   used_by: .github/fork/build-release.sh
# ---
set -euo pipefail

if (( $# != 1 )); then
  echo "Usage: build-node-pty.sh <output-file>" >&2
  exit 2
fi

if [[ "$(uname -m)" != "x86_64" ]]; then
  echo "The server release supports only Linux x64." >&2
  exit 1
fi

output_file="$1"
repo_root="$(git rev-parse --show-toplevel)"
source_directory="$(realpath "${repo_root}/apps/server/node_modules/node-pty")"
output_directory="$(dirname "$output_file")"
output_name="$(basename "$output_file")"
mkdir -p "$output_directory"

docker run --rm \
  --volume "${source_directory}:/source:ro" \
  --volume "${output_directory}:/output" \
  node:24-bookworm \
  bash -ceu '
    cp -a /source/. /tmp/node-pty
    cd /tmp/node-pty
    rm -rf build node_modules
    npm install --ignore-scripts --omit=dev
    npm_config_build_from_source=true npm run install
    install -m 0755 build/Release/pty.node "/output/$1"
  ' _ "$output_name"

if [[ ! -s "$output_file" ]]; then
  echo "node-pty prebuild was not produced: $output_file" >&2
  exit 1
fi
