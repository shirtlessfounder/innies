#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
while [[ -L "$SCRIPT_PATH" ]]; do
  SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_PATH")" && pwd)"
  SCRIPT_PATH="$(readlink "$SCRIPT_PATH")"
  [[ "$SCRIPT_PATH" != /* ]] && SCRIPT_PATH="${SCRIPT_DIR}/${SCRIPT_PATH}"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_PATH")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

if [[ $# -lt 1 ]]; then
  echo "usage: $(basename "$0") <artifact-summary-dir-or-summary.json> [more paths...]" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo 'error: node is required' >&2
  exit 1
fi

OUT_DIR="${INNIES_COMPAT_ARTIFACT_CANDIDATES_OUT_DIR:-/tmp/innies-compat-artifact-candidates-$(date +%s)}"
mkdir -p "$OUT_DIR"

TMP_INPUTS="$(mktemp)"
cleanup() {
  rm -f "$TMP_INPUTS"
}
trap cleanup EXIT

for input in "$@"; do
  if [[ -d "$input" ]]; then
    while IFS= read -r summary_path; do
      printf '%s\n' "$summary_path"
    done < <(find "$input" -type f -name 'summary.json' | sort)
    continue
  fi

  if [[ -f "$input" ]]; then
    printf '%s\n' "$input"
    continue
  fi

  echo "error: input path not found: $input" >&2
  exit 1
done | awk '!seen[$0]++' >"$TMP_INPUTS"

if [[ ! -s "$TMP_INPUTS" ]]; then
  echo 'error: no summary.json files found in input paths' >&2
  exit 1
fi

SUMMARY_PATHS=()
while IFS= read -r summary_path; do
  SUMMARY_PATHS+=("$summary_path")
done <"$TMP_INPUTS"
node "${ROOT_DIR}/scripts/innies-compat-artifact-candidates.mjs" "$OUT_DIR" "${SUMMARY_PATHS[@]}"
cat "$OUT_DIR/summary.txt"
