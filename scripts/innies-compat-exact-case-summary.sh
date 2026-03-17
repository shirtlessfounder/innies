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

INPUT_DIR="${1:-${INNIES_EXACT_CASE_SUMMARY_INPUT_DIR:-}}"
require_nonempty 'exact-case matrix input dir' "$INPUT_DIR"

if [[ ! -d "$INPUT_DIR" ]]; then
  echo "error: matrix input dir not found: $INPUT_DIR" >&2
  exit 1
fi

OUT_DIR="${2:-${INNIES_EXACT_CASE_SUMMARY_OUT_DIR:-${INPUT_DIR%/}/analysis}}"
mkdir -p "$OUT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo 'error: node is required for innies-compat-exact-case-summary.sh' >&2
  exit 1
fi

node "${SCRIPT_DIR}/innies-compat-exact-case-summary.mjs" "$INPUT_DIR" "$OUT_DIR"

SUMMARY_FILE="$OUT_DIR/summary.txt"
cat "$SUMMARY_FILE"
printf 'summary_file=%s\n' "$SUMMARY_FILE"
