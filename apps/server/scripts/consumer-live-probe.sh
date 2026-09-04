#!/usr/bin/env bash

# Consumer-path live acceptance for the fork.
#
# Stands up a clean container that installs T3 Code the way a consumer does —
# the published devcontainer Feature, resolving the fork's own latest release —
# then proves the capability this fork exists to deliver: a client outside the
# server process registers its own MCP endpoint for a thread, starts a session
# over the RPC socket, and a real agent calls that tool while T3's internal MCP
# server remains available in the same session.
#
# On demand only. This is never a CI or release gate: it spends real provider
# credentials and depends on a harness this repository does not control.
#
# Usage: apps/server/scripts/consumer-live-probe.sh

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
name="t3-consumer-probe-${RANDOM}-$$"
image="t3-consumer-probe:${RANDOM}"
port=3773
host_port="${T3_CONSUMER_PROBE_HOST_PORT:-13773}"
feature="${T3_CONSUMER_PROBE_FEATURE:-ghcr.io/wyrd-company/devcontainers/t3code-server:latest}"
base_image="${T3_CONSUMER_PROBE_BASE_IMAGE:-ghcr.io/wyrd-company/devcontainers/base:noble}"
codex_auth="${T3_CONSUMER_PROBE_CODEX_AUTH:-${HOME}/.codex/auth.json}"
workspace="$(mktemp -d)"

fail() {
    printf '%s\n' "$1" >&2
    exit 1
}

cleanup() {
    docker rm -f "${name}" >/dev/null 2>&1 || true
    docker image rm -f "${image}" >/dev/null 2>&1 || true
    rm -rf "${workspace}"
}
trap cleanup EXIT

command -v devcontainer >/dev/null 2>&1 \
    || fail "The devcontainer CLI is required: npm install -g @devcontainers/cli"
[ -f "${codex_auth}" ] \
    || fail "A real agent turn needs Codex credentials at ${codex_auth}."

# Resolve images anonymously and without inheriting a host credential helper,
# so the run proves what an unauthenticated consumer can actually obtain.
DOCKER_CONFIG="${workspace}/docker"
export DOCKER_CONFIG
mkdir -p "${DOCKER_CONFIG}"
printf '{}' >"${DOCKER_CONFIG}/config.json"

mkdir -p "${workspace}/.devcontainer"
cat >"${workspace}/.devcontainer/devcontainer.json" <<EOF
{
    "image": "${base_image}",
    "features": {
        "${feature}": {
            "packageSource": "github:wyrd-company/t3code",
            "version": "latest",
            "serveMode": "web",
            "host": "0.0.0.0",
            "port": "${port}"
        },
        "ghcr.io/wyrd-company/devcontainers/codex-cli:latest": {}
    }
}
EOF

printf 'Building a clean consumer container from %s.\n' "${feature}"
devcontainer build --workspace-folder "${workspace}" --image-name "${image}" >/dev/null

# host-gateway lets the container reach the MCP fixture running out here, which
# is what makes the fixture genuinely external to the server under test.
docker run --detach --name "${name}" \
    --publish "127.0.0.1:${host_port}:${port}" \
    --add-host=host.docker.internal:host-gateway \
    --volume "${codex_auth}:/home/vscode/.codex/auth.json:ro" \
    "${image}" >/dev/null

for _ in $(seq 1 120); do
    if curl --fail --silent --output /dev/null "http://127.0.0.1:${host_port}/"; then
        break
    fi
    sleep 1
done
curl --fail --silent --output /dev/null "http://127.0.0.1:${host_port}/" \
    || fail "The console never served on port ${host_port}."

installed_version="$(docker exec "${name}" /usr/local/bin/t3 --version)"
printf 'Console served by %s.\n' "${installed_version}"

# The headless bearer path a consumer uses. Never printed.
token="$(docker exec --user vscode "${name}" \
    env HOME=/home/vscode /usr/local/bin/t3 auth session issue \
    --base-dir /home/vscode/.t3 --ttl 30m --label consumer-probe --token-only \
    2>/dev/null | tr -d '\r\n ')"
[ -n "${token}" ] || fail "Could not issue a bearer session token in the container."

cd "${repo_root}/apps/server"
T3_CONSUMER_PROBE_CONTAINER="${name}" \
    T3_CONSUMER_PROBE_HTTP_URL="http://127.0.0.1:${host_port}" \
    T3_CONSUMER_PROBE_WS_URL="ws://127.0.0.1:${host_port}/ws" \
    T3_CONSUMER_PROBE_TOKEN="${token}" \
    node --experimental-strip-types src/mcp/ConsumerRpcLiveProbe.ts
