#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
while [[ -L "$SCRIPT_PATH" ]]; do
  SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_PATH")" && pwd)"
  SCRIPT_PATH="$(readlink "$SCRIPT_PATH")"
  [[ "$SCRIPT_PATH" != /* ]] && SCRIPT_PATH="${SCRIPT_DIR}/${SCRIPT_PATH}"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_PATH")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/_common.sh"

build_journal_url() {
  local host="$1"
  local env_name="$2"
  local unit_name="$3"
  local since_value="${4:-}"

  host="${host%/}"
  local url="${host}/devops/v1/journal?env=${env_name}&unit=${unit_name}"
  if [[ -n "$since_value" ]]; then
    url="${url}&since=${since_value}"
  fi
  printf '%s' "$url"
}

usage() {
  cat >&2 <<'EOF'
usage: issue80-prod-journal.sh [options] [pattern...]

Fetch Innies prod journal logs from the devops API, save raw output, and
optionally filter locally by request id / process / error pattern.

options:
  --since <iso8601>    optional server-side lower bound
  --host <url>         default: https://admin.spicefi.xyz
  --env <name>         default: prod
  --unit <name>        default: innies-api
  --out <file>         save raw journal to this path
  --tail <n>           tail lines when no patterns match; default: 120
  --context <n>        local filter context lines; default: 4
  --help               show this message

env:
  DEVOPS_JOURNAL_USER
  DEVOPS_JOURNAL_PASSWORD
  DEVOPS_JOURNAL_HOST
EOF
  exit 1
}

prompt_password() {
  local label="$1"
  local value
  if ! read -rs -p "$label: " value; then
    echo >&2
    return 1
  fi
  echo >&2
  printf '%s' "$value"
}

ensure_devops_user() {
  DEVOPS_JOURNAL_USER="${DEVOPS_JOURNAL_USER:-${SPICEFI_DEVOPS_USER:-}}"
  if [[ -z "${DEVOPS_JOURNAL_USER}" ]]; then
    DEVOPS_JOURNAL_USER="$(prompt 'devops username')"
  fi
  require_nonempty 'devops username' "$DEVOPS_JOURNAL_USER"
}

ensure_devops_password() {
  DEVOPS_JOURNAL_PASSWORD="${DEVOPS_JOURNAL_PASSWORD:-${SPICEFI_DEVOPS_PASSWORD:-}}"
  if [[ -z "${DEVOPS_JOURNAL_PASSWORD}" ]]; then
    DEVOPS_JOURNAL_PASSWORD="$(prompt_password 'devops password')"
  fi
  require_nonempty 'devops password' "$DEVOPS_JOURNAL_PASSWORD"
}

filter_output() {
  local file="$1"
  local context_lines="$2"
  shift 2
  local patterns=("$@")

  if [[ "${#patterns[@]}" -eq 0 ]]; then
    tail -n "${TAIL_LINES}" "$file"
    return 0
  fi

  if command -v rg >/dev/null 2>&1; then
    local -a rg_cmd
    rg_cmd=(rg -n -C "$context_lines")
    for pattern in "${patterns[@]}"; do
      rg_cmd+=(-e "$pattern")
    done
    rg_cmd+=("$file")
    "${rg_cmd[@]}" && return 0
    return 1
  fi

  local joined=''
  local pattern
  for pattern in "${patterns[@]}"; do
    joined="${joined:+${joined}|}${pattern}"
  done
  grep -nE "$joined" "$file"
}

main() {
  local host="${DEVOPS_JOURNAL_HOST:-https://admin.spicefi.xyz}"
  local env_name='prod'
  local unit_name='innies-api'
  local since_value=''
  local out_file=''
  local context_lines=4
  TAIL_LINES="${TAIL_LINES:-120}"
  local -a patterns=()

  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --since)
        [[ "$#" -ge 2 ]] || usage
        since_value="$2"
        shift 2
        ;;
      --host)
        [[ "$#" -ge 2 ]] || usage
        host="$2"
        shift 2
        ;;
      --env)
        [[ "$#" -ge 2 ]] || usage
        env_name="$2"
        shift 2
        ;;
      --unit)
        [[ "$#" -ge 2 ]] || usage
        unit_name="$2"
        shift 2
        ;;
      --out)
        [[ "$#" -ge 2 ]] || usage
        out_file="$2"
        shift 2
        ;;
      --tail)
        [[ "$#" -ge 2 ]] || usage
        TAIL_LINES="$2"
        shift 2
        ;;
      --context)
        [[ "$#" -ge 2 ]] || usage
        context_lines="$2"
        shift 2
        ;;
      --help|-h)
        usage
        ;;
      *)
        patterns+=("$1")
        shift
        ;;
    esac
  done

  ensure_devops_user
  ensure_devops_password

  local journal_url
  journal_url="$(build_journal_url "$host" "$env_name" "$unit_name" "$since_value")"

  if [[ -z "$out_file" ]]; then
    local stamp
    stamp="$(date -u +%Y%m%dT%H%M%SZ)"
    out_file="${TMPDIR:-/tmp}/innies_prod_journal_${env_name}_${unit_name}_${stamp}.log"
  fi

  mkdir -p "$(dirname "$out_file")"
  curl -sS -u "${DEVOPS_JOURNAL_USER}:${DEVOPS_JOURNAL_PASSWORD}" "$journal_url" > "$out_file"

  echo "journal_url=${journal_url}"
  echo "out_file=${out_file}"
  if [[ -n "$since_value" ]]; then
    echo "since=${since_value}"
  fi
  if [[ "${#patterns[@]}" -gt 0 ]]; then
    echo "patterns=$(IFS=,; printf '%s' "${patterns[*]}")"
  fi
  echo

  if [[ ! -s "$out_file" ]]; then
    echo 'journal_status=empty_file'
    return 0
  fi

  if [[ "$(head -n 1 "$out_file")" == "-- No entries --" ]]; then
    echo 'journal_status=no_entries'
    cat "$out_file"
    return 0
  fi

  if filter_output "$out_file" "$context_lines" "${patterns[@]}"; then
    return 0
  fi

  echo 'filter_status=no_matches'
  echo "showing_tail=${TAIL_LINES}"
  tail -n "${TAIL_LINES}" "$out_file"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
