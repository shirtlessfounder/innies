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

FAILING_BUNDLE_PATH="${1:-${INNIES_COMPAT_REQUEST_BUNDLE_DIFF_FAILING_PATH:-}}"
KNOWN_GOOD_BUNDLE_PATH="${2:-${INNIES_COMPAT_REQUEST_BUNDLE_DIFF_KNOWN_GOOD_PATH:-}}"
require_nonempty 'failing bundle path' "$FAILING_BUNDLE_PATH"
require_nonempty 'known-good bundle path' "$KNOWN_GOOD_BUNDLE_PATH"

if [[ ! -e "$FAILING_BUNDLE_PATH" ]]; then
  echo "error: failing bundle path not found: $FAILING_BUNDLE_PATH" >&2
  exit 1
fi

if [[ ! -e "$KNOWN_GOOD_BUNDLE_PATH" ]]; then
  echo "error: known-good bundle path not found: $KNOWN_GOOD_BUNDLE_PATH" >&2
  exit 1
fi

if [[ -d "$FAILING_BUNDLE_PATH" ]]; then
  DEFAULT_OUT_DIR="${FAILING_BUNDLE_PATH%/}/diff"
else
  DEFAULT_OUT_DIR="$(cd "$(dirname "$FAILING_BUNDLE_PATH")" && pwd)/diff"
fi

OUT_DIR="${3:-${INNIES_COMPAT_REQUEST_BUNDLE_DIFF_OUT_DIR:-$DEFAULT_OUT_DIR}}"
mkdir -p "$OUT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo 'error: node is required for innies-compat-request-bundle-diff.sh' >&2
  exit 1
fi

node "${SCRIPT_DIR}/innies-compat-request-bundle-diff.mjs" \
  "$FAILING_BUNDLE_PATH" \
  "$KNOWN_GOOD_BUNDLE_PATH" \
  "$OUT_DIR"

SUMMARY_FILE="$OUT_DIR/summary.txt"
cat "$SUMMARY_FILE"
printf 'summary_file=%s\n' "$SUMMARY_FILE"
