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

if [[ -z "$artifact_path" || -z "$request_id" ]]; then
  echo "usage: $(basename "$0") <artifact-path> <request-id>" >&2
  exit 1
fi

if [[ ! -f "$artifact_path" ]]; then
  echo "error: artifact not found: $artifact_path" >&2
  exit 1
fi

extract_bin="${INNIES_ARTIFACT_EXTRACT_BIN:-${SCRIPT_DIR}/innies-compat-artifact-extract.sh}"
bundle_diff_bin="${INNIES_BUNDLE_DIFF_BIN:-${SCRIPT_DIR}/innies-compat-first-pass-bundle-diff.sh}"

out_dir="${INNIES_EVIDENCE_OUT_DIR:-${TMPDIR:-/tmp}/innies-compat-first-pass-evidence-${request_id}}"
extract_dir="${out_dir}/extract"
diff_dir="${out_dir}/diff"
summary_file="${out_dir}/summary.txt"

mkdir -p "$out_dir"

INNIES_EXTRACT_OUT_DIR="$extract_dir" "$extract_bin" "$artifact_path" "$request_id"
INNIES_DIFF_OUT_DIR="$diff_dir" "$bundle_diff_bin" "$extract_dir"

extract_summary="${extract_dir}/summary.txt"
diff_summary="${diff_dir}/summary.txt"

if [[ ! -f "$extract_summary" ]]; then
  echo "error: extract helper did not write summary: $extract_summary" >&2
  exit 1
fi

if [[ ! -f "$diff_summary" ]]; then
  echo "error: diff helper did not write summary: $diff_summary" >&2
  exit 1
fi

{
  printf 'artifact_path=%s\n' "$artifact_path"
  printf 'request_id=%s\n' "$request_id"
  cat "$extract_summary"
  cat "$diff_summary"
  printf 'extract_dir=%s\n' "$extract_dir"
  printf 'diff_dir=%s\n' "$diff_dir"
} >"$summary_file"

cat "$summary_file"
printf 'summary_file=%s\n' "$summary_file"
