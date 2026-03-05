# Codex Parity Matrix (Agent 3)

Purpose: verify Codex/OpenAI behavior is contract-compatible with existing Anthropic token-mode behavior before Phase 1 rollout.

## Scope
- token credential lifecycle parity (`create`, `rotate`, `revoke`, `maxed`, `probe`, `reactivate`)
- non-streaming proxy parity
- streaming proxy parity (if supported in current adapter)
- error mapping parity (`401/403/429/5xx/timeout`)
- metering + routing event parity

## Test Matrix
| Area | Anthropic Baseline | Codex/OpenAI Expected | Validation Method | Status | Notes |
|---|---|---|---|---|---|
| Token credential create | succeeds with deterministic idempotency | same | route/integration test | TODO | |
| Token credential rotate | prior active -> revoked, new active, rotation increments | same | route/integration test | TODO | |
| Token credential revoke | status transitions to revoked | same | route/integration test | TODO | |
| Maxing policy (`401`) | increments failures, maxes at threshold | same | proxy + repo tests | TODO | |
| Probe/reactivation | maxed credential probed + reactivated on success | same | job tests + canary | DONE | `tokenCredentialHealthJob` now supports `openai/codex` probes |
| Non-streaming success passthrough | upstream status/body passthrough | same | canary + integration test | TODO | |
| Streaming behavior | passthrough or synthetic bridge per upstream content-type | adapter-defined, must be deterministic | canary + integration test | TODO | |
| `401` handling | refresh/retry/failover policy | same policy | proxy test matrix | TODO | |
| `403` handling | compat blocked retry behavior (if applicable) | provider-appropriate equivalent | proxy test matrix | TODO | |
| `429` handling | backoff + failover | same | proxy test matrix | TODO | |
| `5xx`/network handling | failover/retry behavior | same | proxy test matrix | TODO | |
| Routing event fields | attempt + provider/model + reason codes | same required fields | DB query check | TODO | |
| Metering writes | usage ledger row created with expected source/note semantics | same | DB query check | TODO | |

## Required Evidence
- API test output (`npm test` in `api`)
- canary request/response logs (request id, provider, attempt no, outcome)
- DB evidence:
  - `in_routing_events`
  - `in_usage_ledger`
  - `in_token_credentials` lifecycle fields

## Exit Rule
Do not mark Codex support ready until all rows are `DONE` or explicitly `WAIVED` with rationale and approver.
