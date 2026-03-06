#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${HOME}/.local/bin"

mkdir -p "$BIN_DIR"

ln -sf "${ROOT_DIR}/scripts/innies-add-token.sh" "${BIN_DIR}/innies-add-token"
ln -sf "${ROOT_DIR}/scripts/innies-rotate-token.sh" "${BIN_DIR}/innies-rotate-token"
ln -sf "${ROOT_DIR}/scripts/innies-set-refresh-token.sh" "${BIN_DIR}/innies-set-refresh-token"
ln -sf "${ROOT_DIR}/scripts/innies-set-preference.sh" "${BIN_DIR}/innies-set-preference"
ln -sf "${ROOT_DIR}/scripts/innies-get-preference.sh" "${BIN_DIR}/innies-get-preference"
ln -sf "${ROOT_DIR}/scripts/innies-check-preference.sh" "${BIN_DIR}/innies-check-preference"

rm -f \
  "${BIN_DIR}/innies-admin" \
  "${BIN_DIR}/innies-admin-advanced" \
  "${BIN_DIR}/innies-checks" \
  "${BIN_DIR}/innies-canaries"

echo 'Installed:'
echo "  ${BIN_DIR}/innies-add-token -> ${ROOT_DIR}/scripts/innies-add-token.sh"
echo "  ${BIN_DIR}/innies-rotate-token -> ${ROOT_DIR}/scripts/innies-rotate-token.sh"
echo "  ${BIN_DIR}/innies-set-refresh-token -> ${ROOT_DIR}/scripts/innies-set-refresh-token.sh"
echo "  ${BIN_DIR}/innies-set-preference -> ${ROOT_DIR}/scripts/innies-set-preference.sh"
echo "  ${BIN_DIR}/innies-get-preference -> ${ROOT_DIR}/scripts/innies-get-preference.sh"
echo "  ${BIN_DIR}/innies-check-preference -> ${ROOT_DIR}/scripts/innies-check-preference.sh"
echo
echo 'If command not found, add ~/.local/bin to PATH:'
echo '  export PATH="$HOME/.local/bin:$PATH"'
