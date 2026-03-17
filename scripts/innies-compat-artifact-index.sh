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

ARTIFACT_PATH="${1:-${INNIES_COMPAT_ARTIFACT_INDEX_INPUT:-}}"
PROVIDER_FILTER="${2:-${INNIES_COMPAT_ARTIFACT_INDEX_PROVIDER:-}}"
STATUS_FILTER="${3:-${INNIES_COMPAT_ARTIFACT_INDEX_STATUS:-}}"

require_nonempty 'compat artifact path' "$ARTIFACT_PATH"

if [[ ! -f "$ARTIFACT_PATH" ]]; then
  echo "error: artifact not found: $ARTIFACT_PATH" >&2
  exit 1
fi

artifact_dir="$(cd "$(dirname "$ARTIFACT_PATH")" && pwd)"
artifact_name="$(basename "$ARTIFACT_PATH")"
artifact_stem="${artifact_name%.*}"
DEFAULT_OUT_DIR="${artifact_dir}/${artifact_stem}-artifact-index"
OUT_DIR="${INNIES_COMPAT_ARTIFACT_INDEX_OUT_DIR:-$DEFAULT_OUT_DIR}"
mkdir -p "$OUT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo 'error: node is required for innies-compat-artifact-index.sh' >&2
  exit 1
fi

node "${SCRIPT_DIR}/innies-compat-artifact-index.mjs" \
  "$ARTIFACT_PATH" \
  "$OUT_DIR" \
  "$PROVIDER_FILTER" \
  "$STATUS_FILTER"

SUMMARY_FILE="$OUT_DIR/summary.txt"
cat "$SUMMARY_FILE"
printf 'summary_file=%s\n' "$SUMMARY_FILE"
