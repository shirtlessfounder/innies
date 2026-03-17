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

absolute_path() {
  local path="$1"
  if [[ -d "$path" ]]; then
    (
      cd "$path"
      pwd
    )
    return
  fi

  if [[ -e "$path" ]]; then
    local dir base
    dir="$(cd "$(dirname "$path")" && pwd)"
    base="$(basename "$path")"
    printf '%s/%s\n' "$dir" "$base"
    return
  fi

  echo "error: path not found: $path" >&2
  exit 1
}

summary_value() {
  local key="$1"
  local file="$2"
  awk -F'=' -v target="$key" '$1 == target { print substr($0, index($0, "=") + 1) }' "$file" | tail -1
}

write_summary() {
  local file="$1"
  shift
  printf '%s\n' "$@" >"$file"
}

PAYLOAD_PATH="${1:-${INNIES_DIRECT_PAYLOAD_PATH:-}}"
SOURCE_PATH="${2:-${INNIES_DIRECT_REQUEST_SOURCE:-}}"
require_nonempty 'payload path' "$PAYLOAD_PATH"
require_nonempty 'source path' "$SOURCE_PATH"

if [[ ! -f "$PAYLOAD_PATH" ]]; then
  echo "error: payload file not found: $PAYLOAD_PATH" >&2
  exit 1
fi

if [[ ! -e "$SOURCE_PATH" ]]; then
  echo "error: source path not found: $SOURCE_PATH" >&2
  exit 1
fi

OUT_DIR="${INNIES_DIRECT_BUNDLE_FROM_REQUEST_OUT_DIR:-${TMPDIR:-/tmp}/innies-compat-direct-bundle-from-request-$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

SOURCE_ABS="$(absolute_path "$SOURCE_PATH")"
DIRECT_HEADERS_TSV="$OUT_DIR/direct-headers.tsv"
DIRECT_HEADERS_SUMMARY="$OUT_DIR/direct-headers.summary.txt"
DIRECT_BUNDLE_DIR="$OUT_DIR/direct-bundle"
DIRECT_BUNDLE_SUMMARY="$DIRECT_BUNDLE_DIR/summary.txt"
SUMMARY_FILE="$OUT_DIR/summary.txt"

INNIES_DIRECT_HEADER_SUMMARY_OUT="$DIRECT_HEADERS_SUMMARY" \
  "$SCRIPT_DIR/innies-compat-direct-header-tsv.sh" "$SOURCE_PATH" "$DIRECT_HEADERS_TSV"

INNIES_DIRECT_BUNDLE_OUT_DIR="$DIRECT_BUNDLE_DIR" \
  "$SCRIPT_DIR/innies-compat-direct-request-bundle.sh" "$PAYLOAD_PATH" "$DIRECT_HEADERS_TSV"

SUMMARY_LINES=(
  "source_path=$SOURCE_ABS"
  "direct_headers_tsv=$DIRECT_HEADERS_TSV"
  "direct_header_summary_file=$DIRECT_HEADERS_SUMMARY"
  "direct_bundle_dir=$DIRECT_BUNDLE_DIR"
  "direct_bundle_summary_file=$DIRECT_BUNDLE_SUMMARY"
  "request_id=$(summary_value 'request_id' "$DIRECT_BUNDLE_SUMMARY")"
  "target_url=$(summary_value 'target_url' "$DIRECT_BUNDLE_SUMMARY")"
  "body_bytes=$(summary_value 'body_bytes' "$DIRECT_BUNDLE_SUMMARY")"
  "body_sha256=$(summary_value 'body_sha256' "$DIRECT_BUNDLE_SUMMARY")"
  "direct_status=$(summary_value 'direct_status' "$DIRECT_BUNDLE_SUMMARY")"
  "provider_request_id=$(summary_value 'provider_request_id' "$DIRECT_BUNDLE_SUMMARY")"
)
write_summary "$SUMMARY_FILE" "${SUMMARY_LINES[@]}"
printf '%s\n' "${SUMMARY_LINES[@]}"
echo "summary_file=$SUMMARY_FILE"
