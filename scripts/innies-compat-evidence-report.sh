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

if [[ "$#" -eq 0 ]]; then
  echo 'error: provide at least one issue-80 summary file or artifact root' >&2
  exit 1
fi

FIRST_INPUT="$1"
if [[ ! -e "$FIRST_INPUT" ]]; then
  echo "error: evidence report input path not found: $FIRST_INPUT" >&2
  exit 1
fi

if [[ -f "$FIRST_INPUT" ]]; then
  BASE_DIR="$(cd "$(dirname "$FIRST_INPUT")" && pwd)"
else
  BASE_DIR="$(cd "$FIRST_INPUT" && pwd)"
fi

OUT_DIR="${INNIES_COMPAT_EVIDENCE_REPORT_OUT_DIR:-${BASE_DIR%/}/analysis}"
mkdir -p "$OUT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo 'error: node is required for innies-compat-evidence-report.sh' >&2
  exit 1
fi

node "${SCRIPT_DIR}/innies-compat-evidence-report.mjs" "$OUT_DIR" "$@"

SUMMARY_FILE="$OUT_DIR/summary.txt"
cat "$SUMMARY_FILE"
printf 'summary_file=%s\n' "$SUMMARY_FILE"
