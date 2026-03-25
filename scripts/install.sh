#!/usr/bin/env bash
set -euo pipefail

CURRENT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${HOME}/.local/bin"

resolve_install_root() {
  if [[ -n "${INNIES_INSTALL_ROOT:-}" ]]; then
    printf '%s\n' "$INNIES_INSTALL_ROOT"
    return
  fi

  if [[ "$CURRENT_ROOT" == /tmp/* || "$CURRENT_ROOT" == /private/tmp/* ]]; then
    local canonical_root="${HOME}/innies"
    if [[ -f "${canonical_root}/scripts/install.sh" ]]; then
      printf '%s\n' "$canonical_root"
      return
    fi
  fi

  printf '%s\n' "$CURRENT_ROOT"
}

ROOT_DIR="$(resolve_install_root)"

mkdir -p "$BIN_DIR"

ln -sf "${ROOT_DIR}/scripts/innies-token-add.sh" "${BIN_DIR}/innies-token-add"
ln -sf "${ROOT_DIR}/scripts/innies-token-rotate.sh" "${BIN_DIR}/innies-token-rotate"
ln -sf "${ROOT_DIR}/scripts/innies-token-pause.sh" "${BIN_DIR}/innies-token-pause"
ln -sf "${ROOT_DIR}/scripts/innies-token-label-set.sh" "${BIN_DIR}/innies-token-label-set"
ln -sf "${ROOT_DIR}/scripts/innies-token-contribution-cap-set.sh" "${BIN_DIR}/innies-token-contribution-cap-set"
ln -sf "${ROOT_DIR}/scripts/innies-token-refresh-token-set.sh" "${BIN_DIR}/innies-token-refresh-token-set"
ln -sf "${ROOT_DIR}/scripts/innies-token-probe-run.sh" "${BIN_DIR}/innies-token-probe-run"
ln -sf "${ROOT_DIR}/scripts/innies-token-usage-refresh.sh" "${BIN_DIR}/innies-token-usage-refresh"
ln -sf "${ROOT_DIR}/scripts/innies-buyer-key-create.sh" "${BIN_DIR}/innies-buyer-key-create"
ln -sf "${ROOT_DIR}/scripts/innies-org-buyer-key-recover.sh" "${BIN_DIR}/innies-org-buyer-key-recover"
ln -sf "${ROOT_DIR}/scripts/innies-buyer-preference-set.sh" "${BIN_DIR}/innies-buyer-preference-set"
ln -sf "${ROOT_DIR}/scripts/innies-buyer-preference-get.sh" "${BIN_DIR}/innies-buyer-preference-get"
ln -sf "${ROOT_DIR}/scripts/innies-buyer-preference-check.sh" "${BIN_DIR}/innies-buyer-preference-check"
ln -sf "${ROOT_DIR}/scripts/innies-slo-check.sh" "${BIN_DIR}/innies-slo-check"
ln -sf "${ROOT_DIR}/scripts/innies-diagnose-loop.sh" "${BIN_DIR}/innies-diagnose-loop"
ln -sf "${ROOT_DIR}/scripts/innies-diagnose-prod-journal.sh" "${BIN_DIR}/innies-diagnose-prod-journal"
ln -sf "${ROOT_DIR}/scripts/innies-diagnose-local-replay.sh" "${BIN_DIR}/innies-diagnose-local-replay"
ln -sf "${ROOT_DIR}/scripts/innies-diagnose-direct-anthropic.sh" "${BIN_DIR}/innies-diagnose-direct-anthropic"
ln -sf "${ROOT_DIR}/scripts/innies-diagnose-anthropic-pool.sh" "${BIN_DIR}/innies-diagnose-anthropic-pool"
ln -sf "${ROOT_DIR}/scripts/issue80-local-replay.sh" "${BIN_DIR}/innies-issue80-local-replay"
ln -sf "${ROOT_DIR}/scripts/issue80-direct-anthropic.sh" "${BIN_DIR}/innies-issue80-direct-anthropic"
ln -sf "${ROOT_DIR}/scripts/issue80-prod-journal.sh" "${BIN_DIR}/innies-issue80-prod-journal"

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
echo "  ${BIN_DIR}/innies-token-label-set -> ${ROOT_DIR}/scripts/innies-token-label-set.sh"
echo "  ${BIN_DIR}/innies-token-contribution-cap-set -> ${ROOT_DIR}/scripts/innies-token-contribution-cap-set.sh"
echo "  ${BIN_DIR}/innies-token-refresh-token-set -> ${ROOT_DIR}/scripts/innies-token-refresh-token-set.sh"
echo "  ${BIN_DIR}/innies-token-probe-run -> ${ROOT_DIR}/scripts/innies-token-probe-run.sh"
echo "  ${BIN_DIR}/innies-token-usage-refresh -> ${ROOT_DIR}/scripts/innies-token-usage-refresh.sh"
echo "  ${BIN_DIR}/innies-buyer-key-create -> ${ROOT_DIR}/scripts/innies-buyer-key-create.sh"
echo "  ${BIN_DIR}/innies-org-buyer-key-recover -> ${ROOT_DIR}/scripts/innies-org-buyer-key-recover.sh"
echo "  ${BIN_DIR}/innies-buyer-preference-set -> ${ROOT_DIR}/scripts/innies-buyer-preference-set.sh"
echo "  ${BIN_DIR}/innies-buyer-preference-get -> ${ROOT_DIR}/scripts/innies-buyer-preference-get.sh"
echo "  ${BIN_DIR}/innies-buyer-preference-check -> ${ROOT_DIR}/scripts/innies-buyer-preference-check.sh"
echo "  ${BIN_DIR}/innies-slo-check -> ${ROOT_DIR}/scripts/innies-slo-check.sh"
echo "  ${BIN_DIR}/innies-diagnose-loop -> ${ROOT_DIR}/scripts/innies-diagnose-loop.sh"
echo "  ${BIN_DIR}/innies-diagnose-prod-journal -> ${ROOT_DIR}/scripts/innies-diagnose-prod-journal.sh"
echo "  ${BIN_DIR}/innies-diagnose-local-replay -> ${ROOT_DIR}/scripts/innies-diagnose-local-replay.sh"
echo "  ${BIN_DIR}/innies-diagnose-direct-anthropic -> ${ROOT_DIR}/scripts/innies-diagnose-direct-anthropic.sh"
echo "  ${BIN_DIR}/innies-diagnose-anthropic-pool -> ${ROOT_DIR}/scripts/innies-diagnose-anthropic-pool.sh"
echo "  ${BIN_DIR}/innies-issue80-local-replay -> ${ROOT_DIR}/scripts/issue80-local-replay.sh"
echo "  ${BIN_DIR}/innies-issue80-direct-anthropic -> ${ROOT_DIR}/scripts/issue80-direct-anthropic.sh"
echo "  ${BIN_DIR}/innies-issue80-prod-journal -> ${ROOT_DIR}/scripts/issue80-prod-journal.sh"
if [[ "$ROOT_DIR" != "$CURRENT_ROOT" ]]; then
  echo
  echo "Canonicalized install root: ${CURRENT_ROOT} -> ${ROOT_DIR}"
  echo 'Override with INNIES_INSTALL_ROOT=/absolute/path if needed.'
fi
echo
echo 'If command not found, add ~/.local/bin to PATH:'
echo '  export PATH="$HOME/.local/bin:$PATH"'
