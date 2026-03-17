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

MATRIX_DIR="${1:-${INNIES_EXACT_CASE_MINIMAL_DELTA_MATRIX_DIR:-}}"
CASES_DIR="${2:-${INNIES_EXACT_CASE_MINIMAL_DELTA_CASES_DIR:-}}"
require_nonempty 'matrix dir' "$MATRIX_DIR"

OUT_DIR="${INNIES_EXACT_CASE_MINIMAL_DELTA_OUT_DIR:-${MATRIX_DIR%/}/minimal-delta}"
mkdir -p "$OUT_DIR"

node "${SCRIPT_DIR}/innies-compat-exact-case-minimal-delta.mjs" "$MATRIX_DIR" "$CASES_DIR" "$OUT_DIR"

cat "$OUT_DIR/summary.txt"
printf 'summary_file=%s\n' "$OUT_DIR/summary.txt"
