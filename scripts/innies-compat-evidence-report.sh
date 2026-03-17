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

EXACT_CASE_SUMMARY="${INNIES_EXACT_CASE_SUMMARY:-}"
EXACT_CASE_MINIMAL_DELTA="${INNIES_EXACT_CASE_MINIMAL_DELTA:-}"
PAYLOAD_SUMMARY="${INNIES_DIRECT_PAYLOAD_SUMMARY:-}"
TOKEN_LANE_SUMMARY="${INNIES_DIRECT_TOKEN_LANE_SUMMARY:-}"
OUT_DIR="${INNIES_COMPAT_EVIDENCE_REPORT_OUT_DIR:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --exact-case-summary)
      EXACT_CASE_SUMMARY="${2:-}"
      shift 2
      ;;
    --exact-case-minimal-delta)
      EXACT_CASE_MINIMAL_DELTA="${2:-}"
      shift 2
      ;;
    --payload-summary)
      PAYLOAD_SUMMARY="${2:-}"
      shift 2
      ;;
    --token-lane-summary)
      TOKEN_LANE_SUMMARY="${2:-}"
      shift 2
      ;;
    --out-dir)
      OUT_DIR="${2:-}"
      shift 2
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$EXACT_CASE_SUMMARY" && -z "$EXACT_CASE_MINIMAL_DELTA" && -z "$PAYLOAD_SUMMARY" && -z "$TOKEN_LANE_SUMMARY" ]]; then
  echo 'error: at least one evidence input path is required' >&2
  exit 1
fi

for input_path in "$EXACT_CASE_SUMMARY" "$EXACT_CASE_MINIMAL_DELTA" "$PAYLOAD_SUMMARY" "$TOKEN_LANE_SUMMARY"; do
  if [[ -n "$input_path" && ! -e "$input_path" ]]; then
    echo "error: evidence input path not found: $input_path" >&2
    exit 1
  fi
done

if [[ -z "$OUT_DIR" ]]; then
  for input_path in "$EXACT_CASE_SUMMARY" "$EXACT_CASE_MINIMAL_DELTA" "$PAYLOAD_SUMMARY" "$TOKEN_LANE_SUMMARY"; do
    if [[ -n "$input_path" ]]; then
      if [[ -d "$input_path" ]]; then
        OUT_DIR="${input_path%/}/report"
      else
        OUT_DIR="$(cd "$(dirname "$input_path")" && pwd)/report"
      fi
      break
    fi
  done
fi

mkdir -p "$OUT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo 'error: node is required for innies-compat-evidence-report.sh' >&2
  exit 1
fi

node "${SCRIPT_DIR}/innies-compat-evidence-report.mjs" \
  "${EXACT_CASE_SUMMARY:-"-"}" \
  "${EXACT_CASE_MINIMAL_DELTA:-"-"}" \
  "${PAYLOAD_SUMMARY:-"-"}" \
  "${TOKEN_LANE_SUMMARY:-"-"}" \
  "$OUT_DIR"

SUMMARY_FILE="$OUT_DIR/summary.txt"
ISSUE_COMMENT_FILE="$OUT_DIR/issue-comment.md"
cat "$SUMMARY_FILE"
printf 'summary_file=%s\n' "$SUMMARY_FILE"
printf 'issue_comment_file=%s\n' "$ISSUE_COMMENT_FILE"
