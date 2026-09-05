#!/usr/bin/env bash
# ---
# relationships:
#   used_by:
#     - .github/fork/check-allowlist.sh
#     - .github/fork/test.sh
# ---
# Prints the upstream commit this fork branch is built on.
#
# Derived, not recorded. The branch is our commits replayed onto one upstream
# release, so the point where our history and the mirror last agreed is that
# release — git already knows it, and asking git cannot disagree with the
# history it describes. A file recording the same commit is a second copy that
# has to be maintained and can drift; keeping one in step with a rebase is
# where this fork's automation kept failing.
#
# The mirror, not upstream's tag: we deliberately never push upstream tags to
# origin, so a CI checkout of this repository cannot resolve `v0.0.38`. It can
# always resolve `origin/main`, which is the pristine upstream mirror.
#
# That the base is a *stable release* rather than an arbitrary upstream commit
# is asserted where upstream's tags are reachable — in the rebase workflow,
# before anything is pushed. Nothing here can check it.
set -euo pipefail

mirror_ref="${FORK_MIRROR_REF:-origin/main}"
target="${FORK_DIFF_TARGET:-HEAD}"

if ! git rev-parse --verify --quiet "${mirror_ref}^{commit}" >/dev/null; then
  echo "Cannot resolve the upstream mirror ${mirror_ref}." >&2
  echo "A shallow checkout cannot answer this; fetch with depth 0." >&2
  exit 1
fi

if ! base="$(git merge-base "$target" "$mirror_ref")"; then
  echo "No common history between ${target} and ${mirror_ref}." >&2
  exit 1
fi

printf '%s\n' "$base"
