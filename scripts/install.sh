#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${HOME}/.local/bin"

mkdir -p "$BIN_DIR"

ln -sf "${ROOT_DIR}/scripts/innies-token-add.sh" "${BIN_DIR}/innies-token-add"
ln -sf "${ROOT_DIR}/scripts/innies-token-rotate.sh" "${BIN_DIR}/innies-token-rotate"
ln -sf "${ROOT_DIR}/scripts/innies-token-pause.sh" "${BIN_DIR}/innies-token-pause"
ln -sf "${ROOT_DIR}/scripts/innies-token-contribution-cap-set.sh" "${BIN_DIR}/innies-token-contribution-cap-set"
ln -sf "${ROOT_DIR}/scripts/innies-token-refresh-token-set.sh" "${BIN_DIR}/innies-token-refresh-token-set"
ln -sf "${ROOT_DIR}/scripts/innies-token-probe-run.sh" "${BIN_DIR}/innies-token-probe-run"
ln -sf "${ROOT_DIR}/scripts/innies-token-usage-refresh.sh" "${BIN_DIR}/innies-token-usage-refresh"
ln -sf "${ROOT_DIR}/scripts/innies-compat-artifact-extract.sh" "${BIN_DIR}/innies-compat-artifact-extract"
ln -sf "${ROOT_DIR}/scripts/innies-compat-artifact-index.sh" "${BIN_DIR}/innies-compat-artifact-index"
ln -sf "${ROOT_DIR}/scripts/innies-buyer-key-create.sh" "${BIN_DIR}/innies-buyer-key-create"
ln -sf "${ROOT_DIR}/scripts/innies-buyer-preference-set.sh" "${BIN_DIR}/innies-buyer-preference-set"
ln -sf "${ROOT_DIR}/scripts/innies-buyer-preference-get.sh" "${BIN_DIR}/innies-buyer-preference-get"
ln -sf "${ROOT_DIR}/scripts/innies-buyer-preference-check.sh" "${BIN_DIR}/innies-buyer-preference-check"
ln -sf "${ROOT_DIR}/scripts/innies-slo-check.sh" "${BIN_DIR}/innies-slo-check"

rm -f \
  "${BIN_DIR}/innies-admin" \
  "${BIN_DIR}/innies-admin-advanced" \
  "${BIN_DIR}/innies-checks" \
  "${BIN_DIR}/innies-canaries" \
  "${BIN_DIR}/innies-add-token" \
  "${BIN_DIR}/innies-rotate-token" \
  "${BIN_DIR}/innies-pause-token" \
  "${BIN_DIR}/innies-set-contribution-cap" \
  "${BIN_DIR}/innies-set-refresh-token" \
  "${BIN_DIR}/innies-requeue-token-probe" \
  "${BIN_DIR}/innies-refresh-token-usage" \
  "${BIN_DIR}/innies-create-buyer-key" \
  "${BIN_DIR}/innies-set-preference" \
  "${BIN_DIR}/innies-get-preference" \
  "${BIN_DIR}/innies-check-preference"

echo 'Installed:'
echo "  ${BIN_DIR}/innies-token-add -> ${ROOT_DIR}/scripts/innies-token-add.sh"
echo "  ${BIN_DIR}/innies-token-rotate -> ${ROOT_DIR}/scripts/innies-token-rotate.sh"
echo "  ${BIN_DIR}/innies-token-pause -> ${ROOT_DIR}/scripts/innies-token-pause.sh"
echo "  ${BIN_DIR}/innies-token-contribution-cap-set -> ${ROOT_DIR}/scripts/innies-token-contribution-cap-set.sh"
echo "  ${BIN_DIR}/innies-token-refresh-token-set -> ${ROOT_DIR}/scripts/innies-token-refresh-token-set.sh"
echo "  ${BIN_DIR}/innies-token-probe-run -> ${ROOT_DIR}/scripts/innies-token-probe-run.sh"
echo "  ${BIN_DIR}/innies-token-usage-refresh -> ${ROOT_DIR}/scripts/innies-token-usage-refresh.sh"
echo "  ${BIN_DIR}/innies-compat-artifact-extract -> ${ROOT_DIR}/scripts/innies-compat-artifact-extract.sh"
echo "  ${BIN_DIR}/innies-compat-artifact-index -> ${ROOT_DIR}/scripts/innies-compat-artifact-index.sh"
echo "  ${BIN_DIR}/innies-buyer-key-create -> ${ROOT_DIR}/scripts/innies-buyer-key-create.sh"
echo "  ${BIN_DIR}/innies-buyer-preference-set -> ${ROOT_DIR}/scripts/innies-buyer-preference-set.sh"
echo "  ${BIN_DIR}/innies-buyer-preference-get -> ${ROOT_DIR}/scripts/innies-buyer-preference-get.sh"
echo "  ${BIN_DIR}/innies-buyer-preference-check -> ${ROOT_DIR}/scripts/innies-buyer-preference-check.sh"
echo "  ${BIN_DIR}/innies-slo-check -> ${ROOT_DIR}/scripts/innies-slo-check.sh"
echo
echo 'If command not found, add ~/.local/bin to PATH:'
echo '  export PATH="$HOME/.local/bin:$PATH"'
