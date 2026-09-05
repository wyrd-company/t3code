#!/usr/bin/env bash
# ---
# relationships:
#   uses:
#     - .github/fork/resolve-base.sh
#     - .github/fork/allowlist.txt
#   used_by: FORK.md
# ---
# Reports what this fork changes about upstream, as evidence for a reviewer.
#
# Run on demand, not in CI. Which files the fork modifies is a judgement about
# how expensive the next rebase will be, not a statement about whether the
# fork works — and that judgement cannot be held in a static list. When
# upstream restructures, files on the list stop existing and files we now need
# are absent from it, so a list that fails the build blocks legitimate work at
# exactly the moment the fork is being reshaped.
#
# Whether the fork works is answered by the tests. This answers a different
# question: what did we take on, and is it still the smallest set that does
# the job. A reviewer reads this and decides.
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
allowlist_file="${FORK_ALLOWLIST_FILE:-${repo_root}/.github/fork/allowlist.txt}"
target="${FORK_DIFF_TARGET:-HEAD}"

base_commit="$(FORK_DIFF_TARGET="$target" "${repo_root}/.github/fork/resolve-base.sh")"

mapfile -t allowlist < <(
  sed -e 's/[[:space:]]*#.*$//' -e '/^[[:space:]]*$/d' "$allowlist_file"
)

path_is_allowed() {
  local path="$1" entry
  for entry in "${allowlist[@]}"; do
    if [[ "$entry" == */ ]]; then
      [[ "$path" == "$entry"* ]] && return 0
    elif [[ "$path" == "$entry" ]]; then
      return 0
    fi
  done
  return 1
}

added=()
modified=()
undeclared=()
other=()

while IFS= read -r -d '' status; do
  IFS= read -r -d '' path
  case "$status" in
    A) added+=("$path") ;;
    M)
      modified+=("$path")
      path_is_allowed "$path" || undeclared+=("$path")
      ;;
    R* | C*)
      IFS= read -r -d '' destination
      other+=("${status} ${path} -> ${destination}")
      ;;
    *) other+=("${status} ${path}") ;;
  esac
done < <(git diff --name-status -z "${base_commit}...${target}")

printf 'Fork surface relative to %s\n\n' "$base_commit"

printf 'Upstream files modified (%d)\n' "${#modified[@]}"
printf '  %s\n' "${modified[@]:-（none）}"

printf '\nFiles added (%d)\n' "${#added[@]}"
printf '  %s\n' "${added[@]:-（none）}"

if (( ${#other[@]} > 0 )); then
  printf '\nRenames, copies and deletions (%d)\n' "${#other[@]}"
  printf '  %s\n' "${other[@]}"
fi

if (( ${#undeclared[@]} > 0 )); then
  printf '\nModified but not declared in allowlist.txt (%d)\n' "${#undeclared[@]}"
  printf '  %s\n' "${undeclared[@]}"
  printf '\nEach of these widens the fork. Record on the task what upstream change\n'
  printf 'forced it, what was tried instead, and why carrying the file is cheaper\n'
  printf 'than the alternative, then add it to allowlist.txt.\n'
  exit 1
fi

printf '\nEvery modified upstream file is declared.\n'
