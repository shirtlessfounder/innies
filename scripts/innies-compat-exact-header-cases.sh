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

resolve_source_file() {
  local source="$1"
  local mode="$2"

  if [[ -f "$source" ]]; then
    printf '%s' "$source"
    return
  fi

  if [[ -d "$source" ]]; then
    local candidate
    case "$mode" in
      compat)
        for candidate in upstream-request.json request.json direct-request.json; do
          if [[ -f "$source/$candidate" ]]; then
            printf '%s' "$source/$candidate"
            return
          fi
        done
        ;;
      direct)
        for candidate in direct-request.json upstream-request.json request.json; do
          if [[ -f "$source/$candidate" ]]; then
            printf '%s' "$source/$candidate"
            return
          fi
        done
        ;;
      *)
        echo "error: unsupported source mode: $mode" >&2
        exit 1
        ;;
    esac

    echo "error: no request JSON found in bundle directory: $source" >&2
    exit 1
  fi

  echo "error: source path not found: $source" >&2
  exit 1
}

COMPAT_SOURCE="${1:-${INNIES_COMPAT_HEADER_CASE_SOURCE:-}}"
DIRECT_SOURCE="${2:-${INNIES_DIRECT_HEADER_CASE_SOURCE:-}}"
OUT_DIR="${3:-${INNIES_EXACT_HEADER_CASES_OUT_DIR:-${TMPDIR:-/tmp}/innies-compat-exact-header-cases-$(date -u +%Y%m%dT%H%M%SZ)}}"

require_nonempty 'compat source path' "$COMPAT_SOURCE"
require_nonempty 'direct source path' "$DIRECT_SOURCE"

COMPAT_FILE="$(resolve_source_file "$COMPAT_SOURCE" compat)"
DIRECT_FILE="$(resolve_source_file "$DIRECT_SOURCE" direct)"
mkdir -p "$OUT_DIR"

node "${SCRIPT_DIR}/innies-compat-exact-header-cases.mjs" "$COMPAT_FILE" "$DIRECT_FILE" "$OUT_DIR"

SUMMARY_FILE="$OUT_DIR/summary.txt"
cat "$SUMMARY_FILE"
printf 'summary_file=%s\n' "$SUMMARY_FILE"
