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

INPUT_PATH="${1:-${INNIES_DIRECT_PAYLOAD_SUMMARY_INPUT:-}}"
require_nonempty 'direct payload summary input path' "$INPUT_PATH"

if [[ ! -e "$INPUT_PATH" ]]; then
  echo "error: payload summary input path not found: $INPUT_PATH" >&2
  exit 1
fi

INPUT_DIR="$INPUT_PATH"
if [[ -f "$INPUT_PATH" ]]; then
  INPUT_DIR="$(cd "$(dirname "$INPUT_PATH")" && pwd)"
fi

OUT_DIR="${2:-${INNIES_DIRECT_PAYLOAD_SUMMARY_OUT_DIR:-${INPUT_DIR%/}/analysis}}"
mkdir -p "$OUT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo 'error: node is required for innies-compat-direct-payload-summary.sh' >&2
  exit 1
fi

node "${SCRIPT_DIR}/innies-compat-direct-payload-summary.mjs" "$INPUT_PATH" "$OUT_DIR"

SUMMARY_FILE="$OUT_DIR/summary.txt"
cat "$SUMMARY_FILE"
printf 'summary_file=%s\n' "$SUMMARY_FILE"
