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

artifact_path="${1:-}"
request_id="${2:-}"
direct_headers_tsv_path="${3:-${INNIES_DIRECT_HEADERS_TSV:-}}"

if [[ -z "$artifact_path" || -z "$request_id" ]]; then
  echo "usage: $(basename "$0") <artifact-path> <request-id> [direct-headers-tsv]" >&2
  exit 1
fi

if [[ ! -f "$artifact_path" ]]; then
  echo "error: artifact not found: $artifact_path" >&2
  exit 1
fi

if [[ -n "$direct_headers_tsv_path" && ! -f "$direct_headers_tsv_path" ]]; then
  echo "error: direct headers TSV not found: $direct_headers_tsv_path" >&2
  exit 1
fi

extract_bin="${INNIES_ARTIFACT_EXTRACT_BIN:-${SCRIPT_DIR}/innies-compat-artifact-extract.sh}"
bundle_diff_bin="${INNIES_BUNDLE_DIFF_BIN:-${SCRIPT_DIR}/innies-compat-first-pass-bundle-diff.sh}"
direct_request_bundle_bin="${INNIES_DIRECT_REQUEST_BUNDLE_BIN:-${SCRIPT_DIR}/innies-compat-direct-request-bundle.sh}"

out_dir="${INNIES_EVIDENCE_OUT_DIR:-${TMPDIR:-/tmp}/innies-compat-first-pass-evidence-${request_id}}"
extract_dir="${out_dir}/extract"
diff_dir="${out_dir}/diff"
direct_dir="${out_dir}/direct"
direct_diff_dir="${out_dir}/direct-diff"
summary_file="${out_dir}/summary.txt"

mkdir -p "$out_dir"

prefix_summary_lines() {
  local prefix="$1"
  local file="$2"
  local line

  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" != *=* ]] && continue
    printf '%s%s\n' "$prefix" "$line"
  done <"$file"
}

INNIES_EXTRACT_OUT_DIR="$extract_dir" "$extract_bin" "$artifact_path" "$request_id"
INNIES_DIFF_OUT_DIR="$diff_dir" "$bundle_diff_bin" "$extract_dir"

extract_summary="${extract_dir}/summary.txt"
diff_summary="${diff_dir}/summary.txt"
direct_summary=''
direct_diff_summary=''
payload_path=''

if [[ ! -f "$extract_summary" ]]; then
  echo "error: extract helper did not write summary: $extract_summary" >&2
  exit 1
fi

if [[ ! -f "$diff_summary" ]]; then
  echo "error: diff helper did not write summary: $diff_summary" >&2
  exit 1
fi

if [[ -n "$direct_headers_tsv_path" ]]; then
  payload_path="${extract_dir}/payload.json"
  if [[ ! -f "$payload_path" ]]; then
    echo "error: extract helper did not write payload: $payload_path" >&2
    exit 1
  fi

  INNIES_DIRECT_BUNDLE_OUT_DIR="$direct_dir" \
    "$direct_request_bundle_bin" \
    "$payload_path" \
    "$direct_headers_tsv_path"
  direct_summary="${direct_dir}/summary.txt"

  if [[ ! -f "$direct_summary" ]]; then
    echo "error: direct request helper did not write summary: $direct_summary" >&2
    exit 1
  fi

  INNIES_DIFF_OUT_DIR="$direct_diff_dir" \
    "$bundle_diff_bin" \
    "${extract_dir}#upstream" \
    "${direct_dir}#upstream"
  direct_diff_summary="${direct_diff_dir}/summary.txt"

  if [[ ! -f "$direct_diff_summary" ]]; then
    echo "error: direct diff helper did not write summary: $direct_diff_summary" >&2
    exit 1
  fi
fi

{
  printf 'artifact_path=%s\n' "$artifact_path"
  printf 'request_id=%s\n' "$request_id"
  cat "$extract_summary"
  cat "$diff_summary"
  printf 'extract_dir=%s\n' "$extract_dir"
  printf 'diff_dir=%s\n' "$diff_dir"
  if [[ -n "$direct_headers_tsv_path" ]]; then
    printf 'direct_headers_tsv_path=%s\n' "$direct_headers_tsv_path"
    printf 'direct_payload_path=%s\n' "$payload_path"
    prefix_summary_lines 'direct_' "$direct_summary"
    prefix_summary_lines 'compat_upstream_vs_direct_' "$direct_diff_summary"
    printf 'direct_dir=%s\n' "$direct_dir"
    printf 'direct_diff_dir=%s\n' "$direct_diff_dir"
  fi
} >"$summary_file"

cat "$summary_file"
printf 'summary_file=%s\n' "$summary_file"
