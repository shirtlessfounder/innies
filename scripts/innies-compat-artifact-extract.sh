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

ARTIFACT_PATH="${1:-${INNIES_CAPTURED_RESPONSE_HTML:-${INNIES_CAPTURED_LOG_PATH:-}}}"
REQUEST_ID="${2:-${INNIES_CAPTURED_REQUEST_ID:-}}"

require_nonempty 'captured artifact path' "$ARTIFACT_PATH"
require_nonempty 'captured request id' "$REQUEST_ID"

if [[ ! -f "$ARTIFACT_PATH" ]]; then
  echo "error: captured artifact file not found: $ARTIFACT_PATH" >&2
  exit 1
fi

OUT_DIR="${INNIES_EXTRACT_OUT_DIR:-${TMPDIR:-/tmp}/innies-compat-artifact-${REQUEST_ID}}"

ARTIFACT_PATH="$ARTIFACT_PATH" \
REQUEST_ID="$REQUEST_ID" \
OUT_DIR="$OUT_DIR" \
node "${SCRIPT_DIR}/innies-compat-artifact-extract.mjs"
