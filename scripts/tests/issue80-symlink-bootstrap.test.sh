#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_usage_via_symlink() {
  local target="$1"
  local link_name="$2"
  local mode="$3"
  local tmp_dir output status

  tmp_dir="$(mktemp -d)"
  ln -sf "$target" "${tmp_dir}/${link_name}"

  set +e
  case "$mode" in
    no_args)
      output="$("${tmp_dir}/${link_name}" 2>&1)"
      ;;
    help)
      output="$("${tmp_dir}/${link_name}" --help 2>&1)"
      ;;
    *)
      fail "unsupported mode: $mode"
      ;;
  esac
  status=$?
  set -e

  if [[ "$mode" == 'no_args' ]]; then
    [[ $status -ne 0 ]] || fail "${link_name} unexpectedly exited 0"
  fi
  [[ "$output" == *"usage:"* ]] || fail "${link_name} did not print usage: ${output}"
  [[ "$output" != *"_common.sh"* ]] || fail "${link_name} failed before bootstrap resolution: ${output}"
  rm -rf "$tmp_dir"
}

main() {
  assert_usage_via_symlink "${ROOT_DIR}/scripts/innies-diagnose-local-replay.sh" 'innies-diagnose-local-replay' no_args
  assert_usage_via_symlink "${ROOT_DIR}/scripts/innies-diagnose-direct-anthropic.sh" 'innies-diagnose-direct-anthropic' no_args
  assert_usage_via_symlink "${ROOT_DIR}/scripts/innies-diagnose-prod-journal.sh" 'innies-diagnose-prod-journal' help
  assert_usage_via_symlink "${ROOT_DIR}/scripts/innies-diagnose-anthropic-pool.sh" 'innies-diagnose-anthropic-pool' help
  assert_usage_via_symlink "${ROOT_DIR}/scripts/issue80-local-replay.sh" 'innies-issue80-local-replay' no_args
  assert_usage_via_symlink "${ROOT_DIR}/scripts/issue80-direct-anthropic.sh" 'innies-issue80-direct-anthropic' no_args
  assert_usage_via_symlink "${ROOT_DIR}/scripts/issue80-prod-journal.sh" 'innies-issue80-prod-journal' help
}

main "$@"
