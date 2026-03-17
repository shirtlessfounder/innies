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

out_dir="${INNIES_EXTRACT_OUT_DIR:-/tmp/innies-compat-artifact-extract-${request_id}}"
mkdir -p "$out_dir"

node "${SCRIPT_DIR}/innies-compat-artifact-extract.mjs" "$artifact_path" "$request_id" "$out_dir"

echo "output_dir=${out_dir}"
