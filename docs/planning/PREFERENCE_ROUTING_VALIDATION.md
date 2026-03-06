# Provider Preference Validation (Agent 3)

Purpose: define pass/fail validation for the current Feature 2 runtime contract.

## Preconditions
- Token mode enabled for the target org.
- Full validation requires DB access to `in_routing_events` (`DATABASE_URL` + `psql`).
- Use `/v1/proxy/*` for preference-path checks.
- `/v1/messages` is compat mode and should still honor buyer-key preference and fallback routing.
- CLI/session pin validation should send `x-innies-provider-pin: true` (or metadata `innies_provider_pin=true`).

## Current Runtime Contract
- Buyer-key preference source of truth is the authenticated key’s persisted preference (`req.auth.preferredProvider`).
- Canonical runtime/storage providers are `anthropic` and `openai`; `codex` normalizes to `openai` at ingress.
- `provider` in the proxy body selects the requested provider, but provider pinning is controlled by pin signal (`x-innies-provider-pin` / metadata) or provider-specific CLI wrappers.
- Compat requests (`/v1/messages`) stay Anthropic-shaped at ingress but can translate to OpenAI Responses upstream when buyer preference resolves to `openai`.

## Route Decision Metadata
- `reason`
- `provider_selection_reason`
- `provider_preferred`
- `provider_effective`
- `provider_plan`
- `provider_fallback_from`
- `provider_fallback_reason`

## Required Reason Values
- `preferred_provider_selected`
- `fallback_provider_selected`
- `cli_provider_pinned`

## Required Fallback Reason Values
- `auth_failure`
- `capacity_unavailable`
- `upstream_error`

## Required Scenarios
| Scenario | Expected Result | Evidence |
|---|---|---|
| Buyer key has preferred provider and at least one eligible key | Request emits `preferred_provider_selected` and `provider_preferred`/`provider_effective` match the preferred path | `in_routing_events.route_decision` |
| Preferred provider hits supported fallback trigger and secondary is eligible | Secondary attempt emits `fallback_provider_selected` with `provider_fallback_from` and `provider_fallback_reason` populated | `attempt_no`, provider sequence, route decision metadata |
| Pinned session requests | Repeated requests in the same session stay on one provider and emit `cli_provider_pinned` | session query over `openclaw_session_id` |
| Compat requests (`/v1/messages`) with buyer pref=`openai` | Requests emit translated routing metadata and return Anthropic-shaped JSON/SSE | compat route events + translated route decision metadata |
| Compat requests (`/v1/messages`) with buyer pref=`anthropic` or fallback to anthropic | Requests stay on Anthropic lane and still emit coherent preferred/effective metadata | compat route events |
| No explicit preference configured | Routing remains deterministic for the key and still emits coherent metadata | route decision metadata + request shape |

## Validation Commands
- API automated tests: `cd api && pnpm test`
- Preference check: `bash api/scripts/provider_preference_canary.sh`
- Debug queries: `docs/planning/PREFERENCE_ROUTING_QUERY_SNIPPETS.sql`

## Pass Rule
Agent 3 validation passes only if:
- preferred-path requests emit the expected reason + metadata fields
- fallback cases emit `fallback_provider_selected` plus `provider_fallback_*`
- pinned-session requests stay on one provider and emit `cli_provider_pinned`
