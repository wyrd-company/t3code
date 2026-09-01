#!/usr/bin/env bash
# ---
# relationships:
#   reads:
#     - .github/fork/base-tag
#     - .github/fork/allowlist.txt
#   used_by:
#     - .github/workflows/fork-ci.yml
#     - .github/workflows/fork-release.yml
# ---
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
base_tag_file="${FORK_BASE_TAG_FILE:-${repo_root}/.github/fork/base-tag}"
allowlist_file="${FORK_ALLOWLIST_FILE:-${repo_root}/.github/fork/allowlist.txt}"
diff_target="${FORK_DIFF_TARGET:-HEAD}"

read_value_file() {
  sed -e 's/[[:space:]]*#.*$//' -e '/^[[:space:]]*$/d' "$1" | tail -n 1
}

base_tag="$(read_value_file "$base_tag_file")"
if [[ -z "$base_tag" ]]; then
  echo "Fork base tag is empty: $base_tag_file" >&2
  exit 1
fi

base_commit="$(git rev-parse --verify "${base_tag}^{commit}")"
git rev-parse --verify "${diff_target}^{commit}" >/dev/null

mapfile -t allowlist < <(
  sed -e 's/[[:space:]]*#.*$//' -e '/^[[:space:]]*$/d' "$allowlist_file"
)

path_is_allowed() {
  local path="$1"
  local entry

  for entry in "${allowlist[@]}"; do
    if [[ "$entry" == */ ]]; then
      [[ "$path" == "$entry"* ]] && return 0
    elif [[ "$path" == "$entry" ]]; then
      return 0
    fi
  done

  return 1
}

violations=()
while IFS= read -r -d '' status; do
  IFS= read -r -d '' path

  case "$status" in
    A)
      ;;
    M)
      if ! path_is_allowed "$path"; then
        violations+=("${status} ${path}")
      fi
      ;;
    R* | C*)
      IFS= read -r -d '' destination
      violations+=("${status} ${path} -> ${destination}")
      ;;
    *)
      violations+=("${status} ${path}")
      ;;
  esac
done < <(git diff --name-status -z "${base_commit}...${diff_target}")

if (( ${#violations[@]} > 0 )); then
  printf 'Fork diff contains paths or operations outside the allowlist:\n' >&2
  printf '  %s\n' "${violations[@]}" >&2
  exit 1
fi

echo "Fork diff is within the allowlist relative to ${base_tag} (${base_commit})."
