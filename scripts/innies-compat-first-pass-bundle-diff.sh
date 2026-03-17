#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
while [[ -L "$SCRIPT_PATH" ]]; do
  SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_PATH")" && pwd)"
  SCRIPT_PATH="$(readlink "$SCRIPT_PATH")"
  [[ "$SCRIPT_PATH" != /* ]] && SCRIPT_PATH="${SCRIPT_DIR}/${SCRIPT_PATH}"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_PATH")" && pwd)"

usage() {
  cat >&2 <<'EOF'
usage:
  innies-compat-first-pass-bundle-diff.sh <artifact-bundle-dir>
  innies-compat-first-pass-bundle-diff.sh <left-bundle-or-json[#ingress|#upstream]> <right-bundle-or-json[#ingress|#upstream]>

single-arg mode compares <bundle>/ingress.json against <bundle>/upstream-request.json.
two-arg mode compares the two supplied bundle specs. Directories default to #upstream.
EOF
  exit 1
}

if [[ "$#" -ne 1 && "$#" -ne 2 ]]; then
  usage
fi

if [[ "$#" -eq 1 ]]; then
  LEFT_SPEC="$1#ingress"
  RIGHT_SPEC="$1#upstream"
else
  LEFT_SPEC="$1"
  RIGHT_SPEC="$2"
fi

OUT_DIR="${INNIES_DIFF_OUT_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/innies-compat-first-pass-bundle-diff.XXXXXX")}"
mkdir -p "$OUT_DIR"

node "$SCRIPT_DIR/innies-compat-first-pass-bundle-diff.mjs" "$LEFT_SPEC" "$RIGHT_SPEC" "$OUT_DIR"

echo "wrote diff artifacts to $OUT_DIR"
