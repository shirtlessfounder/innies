#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
while [[ -L "$SCRIPT_PATH" ]]; do
  SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_PATH")" && pwd)"
  SCRIPT_PATH="$(readlink "$SCRIPT_PATH")"
  [[ "$SCRIPT_PATH" != /* ]] && SCRIPT_PATH="${SCRIPT_DIR}/${SCRIPT_PATH}"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_PATH")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

usage() {
  cat >&2 <<'EOF'
usage: scripts/innies-compat-wire-diff.sh <left-request-bundle.json|dir> <right-request-bundle.json|dir>

Compares two captured Anthropic first-pass request bundles and writes summary.txt plus diff.json.
Set INNIES_WIRE_DIFF_OUT_DIR to control the output directory.
EOF
}

if [[ $# -ne 2 ]]; then
  usage
  exit 1
fi

LEFT_INPUT="$1"
RIGHT_INPUT="$2"

if [[ ! -e "$LEFT_INPUT" ]]; then
  echo "error: request bundle not found: $LEFT_INPUT" >&2
  exit 1
fi

if [[ ! -e "$RIGHT_INPUT" ]]; then
  echo "error: request bundle not found: $RIGHT_INPUT" >&2
  exit 1
fi

OUT_DIR="${INNIES_WIRE_DIFF_OUT_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/innies-wire-diff.XXXXXX")}"
mkdir -p "$OUT_DIR"

node "${ROOT_DIR}/scripts/innies-compat-wire-diff.mjs" "$LEFT_INPUT" "$RIGHT_INPUT" "$OUT_DIR"
