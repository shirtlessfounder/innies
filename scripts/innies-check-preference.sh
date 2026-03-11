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

ensure_buyer_token
export INNIES_BUYER_API_KEY="$BUYER_TOKEN"
expected_provider="$(choose_provider 'expected provider')"
fallback_provider="$(alternate_provider "$expected_provider")"
echo "expectedPreferredProvider: $(display_provider_name "$expected_provider")"
echo "expectedFallbackProvider: $(display_provider_name "$fallback_provider")"
export INNIES_EXPECTED_PREFERRED_PROVIDER="$expected_provider"
exec "${ROOT_DIR}/api/scripts/provider_preference_canary.sh"
