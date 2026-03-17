#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ $# -ne 2 ]]; then
  echo "usage: $(basename "$0") <matrix-input-dir> <output-dir>" >&2
  exit 1
fi

node "$ROOT_DIR/scripts/innies-compat-exact-case-minimal-delta.mjs" "$1" "$2"

echo "summary_file=$(cd "$2" && pwd)/minimal-delta.txt"
echo "json_file=$(cd "$2" && pwd)/minimal-delta.json"
