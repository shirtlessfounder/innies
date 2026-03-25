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

usage() {
  cat <<'EOF'
Usage:
  innies-org-buyer-key-recover --org <slug> (--membership <id> | --github <login>) [--json]

Rotates an org member buyer key through the admin API and prints the new plaintext key once.
Requires INNIES_ADMIN_API_KEY or interactive admin key entry.
Uses INNIES_BASE_URL when set; otherwise defaults to the shared scripts base URL.
EOF
}

require_jq() {
  if ! command -v jq >/dev/null 2>&1; then
    echo 'error: jq is required for this command' >&2
    exit 1
  fi
}

cleanup_files=()
cleanup() {
  if (( ${#cleanup_files[@]} > 0 )); then
    rm -f "${cleanup_files[@]}"
  fi
}
trap cleanup EXIT

request_status=''
request_body_file=''
request_headers_file=''

perform_request() {
  local method="$1"
  local url="$2"
  local payload="${3:-}"

  local body_file headers_file status
  body_file="$(mktemp)"
  headers_file="$(mktemp)"
  cleanup_files+=("$body_file" "$headers_file")

  local -a cmd
  cmd=(curl -sS -D "$headers_file" -o "$body_file" -w '%{http_code}' -X "$method" "$url")
  cmd+=(-H "Authorization: Bearer $ADMIN_TOKEN")
  cmd+=(-H 'Content-Type: application/json')
  if [[ "$method" != 'GET' ]]; then
    cmd+=(-H "Idempotency-Key: $(gen_idempotency_key)")
  fi
  if [[ -n "$payload" ]]; then
    cmd+=(--data-binary "$payload")
  fi

  if ! status="$("${cmd[@]}")"; then
    echo "error: failed to contact admin API at $url" >&2
    exit 1
  fi

  request_status="$status"
  request_body_file="$body_file"
  request_headers_file="$headers_file"
}

extract_error_message() {
  local body_file="$1"
  local message=''

  message="$(
    jq -r '
      if type == "object" then
        (.message // .error // .code // empty)
      else
        empty
      end
    ' "$body_file" 2>/dev/null || true
  )"
  message="$(trim "$message")"

  if [[ -n "$message" && "$message" != 'null' ]]; then
    printf '%s' "$message"
    return
  fi

  tr -d '\r' < "$body_file" | head -c 200
}

fail_api_response() {
  local context="$1"
  local status="$2"
  local body_file="$3"
  local message=''

  message="$(extract_error_message "$body_file")"
  if [[ -n "$message" ]]; then
    echo "error: ${context} (${status}): ${message}" >&2
  else
    echo "error: ${context} (${status})" >&2
  fi
  exit 1
}

org_slug=''
membership_input=''
github_input=''
output_json='false'

while (($# > 0)); do
  case "$1" in
    --org)
      [[ $# -ge 2 ]] || {
        echo 'error: --org requires a value' >&2
        exit 1
      }
      org_slug="$2"
      shift 2
      ;;
    --membership)
      [[ $# -ge 2 ]] || {
        echo 'error: --membership requires a value' >&2
        exit 1
      }
      membership_input="$2"
      shift 2
      ;;
    --github)
      [[ $# -ge 2 ]] || {
        echo 'error: --github requires a value' >&2
        exit 1
      }
      github_input="$2"
      shift 2
      ;;
    --json)
      output_json='true'
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      echo >&2
      usage >&2
      exit 1
      ;;
  esac
done

org_slug="$(trim "$org_slug")"
membership_input="$(trim "$membership_input")"
github_input="$(trim "$github_input")"

require_nonempty '--org' "$org_slug"

if [[ -n "$membership_input" && -n "$github_input" ]]; then
  echo 'error: provide exactly one of --membership or --github' >&2
  exit 1
fi

if [[ -z "$membership_input" && -z "$github_input" ]]; then
  echo 'error: provide exactly one of --membership or --github' >&2
  exit 1
fi

ensure_admin_token
require_jq

perform_request GET "${BASE_URL%/}/v1/admin/orgs/${org_slug}/members"
if [[ "$request_status" != '200' ]]; then
  fail_api_response "unable to list members for org '${org_slug}'" "$request_status" "$request_body_file"
fi

member_json=''
if [[ -n "$membership_input" ]]; then
  member_json="$(
    jq -c --arg membership_id "$membership_input" '
      (.members // [])
      | map(select((.membershipId // "") == $membership_id))
      | .[0] // empty
    ' "$request_body_file"
  )"
else
  member_json="$(
    jq -c --arg github_login "$github_input" '
      (.members // [])
      | map(
          select(
            ((.githubLogin // "") | ascii_downcase)
            == ($github_login | ascii_downcase)
          )
        )
      | .[0] // empty
    ' "$request_body_file"
  )"
fi

if [[ -z "$member_json" ]]; then
  if [[ -n "$membership_input" ]]; then
    echo "error: member not found in org '${org_slug}' for membership '${membership_input}'" >&2
  else
    echo "error: member not found in org '${org_slug}' for github login '${github_input}'" >&2
  fi
  exit 1
fi

membership_id="$(printf '%s' "$member_json" | jq -r '.membershipId // empty')"
github_login="$(printf '%s' "$member_json" | jq -r '.githubLogin // empty')"

if [[ -z "$membership_id" || -z "$github_login" ]]; then
  echo 'error: malformed member payload from admin members route' >&2
  exit 1
fi

perform_request POST "${BASE_URL%/}/v1/admin/orgs/${org_slug}/members/${membership_id}/buyer-key/rotate"
if [[ "$request_status" != '200' ]]; then
  fail_api_response "unable to rotate buyer key for membership '${membership_id}'" "$request_status" "$request_body_file"
fi

response_membership_id="$(jq -r '.membershipId // empty' "$request_body_file")"
api_key_id="$(jq -r '.apiKeyId // empty' "$request_body_file")"
plaintext_key="$(jq -r '.plaintextKey // empty' "$request_body_file")"

if [[ -z "$response_membership_id" || -z "$plaintext_key" ]]; then
  echo 'error: malformed rotate response from admin API' >&2
  exit 1
fi

if [[ "$response_membership_id" != "$membership_id" ]]; then
  echo "error: rotate response membership mismatch: expected '${membership_id}', got '${response_membership_id}'" >&2
  exit 1
fi

if [[ "$output_json" == 'true' ]]; then
  jq -n \
    --arg orgSlug "$org_slug" \
    --arg membershipId "$membership_id" \
    --arg githubLogin "$github_login" \
    --arg apiKeyId "$api_key_id" \
    --arg plaintextBuyerKey "$plaintext_key" \
    '{
      orgSlug: $orgSlug,
      membershipId: $membershipId,
      githubLogin: $githubLogin,
      apiKeyId: (if $apiKeyId == "" then null else $apiKeyId end),
      plaintextBuyerKey: $plaintextBuyerKey
    }'
  exit 0
fi

echo "orgSlug: $org_slug"
echo "membershipId: $membership_id"
echo "githubLogin: $github_login"
if [[ -n "$api_key_id" ]]; then
  echo "apiKeyId: $api_key_id"
fi
echo "buyerKey: $plaintext_key"
echo 'note: plaintext buyer key is only shown once; store it now.'
