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

  if [[ -f "$source" ]]; then
    printf '%s' "$source"
    return
  fi

  if [[ -d "$source" ]]; then
    local candidate
    for candidate in direct-request.json upstream-request.json request.json; do
      if [[ -f "$source/$candidate" ]]; then
        printf '%s' "$source/$candidate"
        return
      fi
    done
    echo "error: no direct request JSON found in bundle directory: $source" >&2
    exit 1
  fi

  echo "error: source path not found: $source" >&2
  exit 1
}

default_out_file() {
  local source_arg="$1"
  local source_file="$2"

  if [[ -d "$source_arg" ]]; then
    printf '%s/direct-headers.tsv' "$source_arg"
    return
  fi

  local dir base
  dir="$(cd "$(dirname "$source_file")" && pwd)"
  base="$(basename "$source_file")"
  base="${base%.json}"
  printf '%s/%s.tsv' "$dir" "$base"
}

SOURCE_PATH="${1:-${INNIES_DIRECT_HEADER_TSV_SOURCE:-}}"
OUT_PATH="${2:-${INNIES_DIRECT_HEADER_TSV_OUT:-}}"
require_nonempty 'source path' "$SOURCE_PATH"

SOURCE_FILE="$(resolve_source_file "$SOURCE_PATH")"
if [[ -z "$OUT_PATH" ]]; then
  OUT_PATH="$(default_out_file "$SOURCE_PATH" "$SOURCE_FILE")"
fi

OUT_DIR="$(dirname "$OUT_PATH")"
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
OUT_PATH="${OUT_DIR}/$(basename "$OUT_PATH")"

SUMMARY_PATH="${INNIES_DIRECT_HEADER_SUMMARY_OUT:-}"
if [[ -z "$SUMMARY_PATH" ]]; then
  SUMMARY_PATH="$OUT_PATH"
  if [[ "$SUMMARY_PATH" == *.tsv ]]; then
    SUMMARY_PATH="${SUMMARY_PATH%.tsv}.summary.txt"
  else
    SUMMARY_PATH="${SUMMARY_PATH}.summary.txt"
  fi
fi

node - "$SOURCE_FILE" "$OUT_PATH" "$SUMMARY_PATH" <<'NODE'
const fs = require('fs');

const [sourceFile, outPath, summaryPath] = process.argv.slice(2);
const skippedHeaderNames = new Set(['authorization', 'content-length', 'host']);

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

let record;
try {
  record = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
} catch (error) {
  fail(`could not parse JSON file ${sourceFile}: ${error.message}`);
}

if (!record || typeof record !== 'object' || Array.isArray(record)) {
  fail(`expected request JSON object in ${sourceFile}`);
}

const headers = record.headers;
if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
  fail(`missing headers object in ${sourceFile}`);
}

const writtenLines = [];
const skipped = [];
for (const [rawName, rawValue] of Object.entries(headers)) {
  const name = String(rawName ?? '').trim().toLowerCase();
  if (!name) continue;
  if (name.startsWith(':') || skippedHeaderNames.has(name)) {
    skipped.push(name);
    continue;
  }

  let value = rawValue;
  if (value === null || value === undefined) {
    value = '';
  } else if (Array.isArray(value)) {
    value = value.join(', ');
  } else if (typeof value === 'object') {
    value = JSON.stringify(value);
  } else if (typeof value !== 'string') {
    value = String(value);
  }

  writtenLines.push(`${name}\t${value}`);
}

if (writtenLines.length === 0) {
  fail(`no reusable headers remained after filtering ${sourceFile}`);
}

fs.writeFileSync(outPath, `${writtenLines.join('\n')}\n`);

const summaryLines = [
  `source_file=${sourceFile}`,
  `request_id=${record.request_id ?? ''}`,
  `target_url=${record.target_url ?? ''}`,
  `body_bytes=${record.body_bytes ?? ''}`,
  `body_sha256=${record.body_sha256 ?? ''}`,
  `headers_written=${writtenLines.length}`,
  `skipped_headers=${skipped.sort().join(',')}`,
  `out_file=${outPath}`
];

fs.writeFileSync(summaryPath, `${summaryLines.join('\n')}\n`);
NODE

cat "$SUMMARY_PATH"
printf 'summary_file=%s\n' "$SUMMARY_PATH"
