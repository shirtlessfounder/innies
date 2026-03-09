# Analytics

## Purpose
Current-state reference for the analytics Innies actually persists and exposes today.

This is intentionally implementation-shaped. It documents shipped behavior, not aspirational dashboard metrics.

Primary code references:
- `api/src/repos/analyticsRepository.ts`
- `api/src/routes/analytics.ts`
- `api/src/utils/analytics.ts`
- `api/src/routes/proxy.ts`

## Scope
- All analytics endpoints are admin-only under `/v1/admin/analytics/*`.
- Canonical windows: `24h`, `7d`, `1m`, `all`.
- Request alias: `30d` is accepted and normalized to `1m`.
- Provider filter: `anthropic|openai|codex` where `codex` normalizes to `openai`.
- Source filter: `openclaw|cli-claude|cli-codex|direct`.

## Raw Signals We Persist

### `in_routing_events`
One row per routing attempt.

Tracked fields:
- `org_id`, `api_key_id`, `request_id`, `attempt_no`
- `seller_key_id` for seller-mode attempts
- `provider`, `model`, `streaming`
- `upstream_status`, `error_code`
- `latency_ms`
- `ttfb_ms`
- `route_decision` JSON

Important `route_decision` fields currently written:
- `reason`
- `provider_selection_reason`
- `request_source`
- `openclaw_run_id`
- `openclaw_session_id`

Token-mode-only routing metadata:
- `tokenCredentialId`
- `tokenCredentialLabel`
- `tokenAuthScheme`
- `provider_preferred`
- `provider_effective`
- `provider_plan`
- `provider_fallback_from`
- `provider_fallback_reason`

Compat-translation metadata when a request is translated across providers:
- `translated`
- `translation_strategy`
- `original_provider`
- `original_model`
- `original_path`
- `translated_path`
- `translated_model`

Notes:
- `ttfb_ms` is persisted for both token-mode and seller-mode attempts.
- Routing events are the main source for source attribution, fallback attribution, latency, TTFB, and per-attempt status metrics.

### `in_usage_ledger`
One row per usage/metering write.

Tracked fields used by analytics:
- `org_id`, `api_key_id`, `request_id`, `attempt_no`
- `seller_key_id`
- `provider`, `model`
- `input_tokens`, `output_tokens`
- `usage_units`
- `retail_equivalent_minor`

Analytics joins usage rows to routing rows on:
- `(org_id, request_id, attempt_no)`

### `in_token_credentials`
Current token-credential state, used by health and inventory views.

Tracked fields used by analytics:
- `id`, `provider`, `debug_label`, `status`
- `consecutive_failure_count`
- `last_failed_status`, `last_failed_at`
- `maxed_at`
- `next_probe_at`, `last_probe_at`
- `monthly_contribution_limit_units`
- `monthly_contribution_used_units`
- `monthly_window_start_at`
- `created_at`, `expires_at`

### `in_token_credential_events`
Durable token lifecycle history.

Currently used by analytics for:
- exact rolling `maxed` event counts (`maxedEvents7d`)

Not currently surfaced as derived analytics:
- `reactivated`
- `probe_failed`

### `in_request_log`
Preview-only request/response logging.

Tracked fields:
- `org_id`, `request_id`, `attempt_no`
- `provider`, `model`
- `prompt_preview`
- `response_preview`

Current behavior:
- written only for successful upstream responses
- previews are truncated to 500 chars
- keyed by `(org_id, request_id, attempt_no)`
- retained for 30 days by cleanup job

Present in schema but not part of the shipped Phase 1 contract:
- `full_prompt_encrypted`
- `full_response_encrypted`

### `in_daily_aggregates`
Exists, but the current analytics endpoints do not depend on it. Current admin analytics queries use raw routing and usage tables for fidelity.

## Source Classification
Analytics source attribution prefers explicit routing metadata.

Current logic (TS utility `classifyAnalyticsSource()`):
- if `route_decision.request_source` exists and is a known source, use it
- otherwise, if `provider_selection_reason = 'cli_provider_pinned'`:
  - `openai` -> `cli-codex`
  - non-`openai` -> `cli-claude`
- otherwise, if `openclaw_run_id` exists -> `openclaw`
- otherwise -> `direct`

Known divergence: the SQL `SOURCE_CASE` in `analyticsRepository.ts` uses `coalesce(nullif(request_source, ''), ...)` which accepts any non-empty `request_source` value without validating against the known set. The TS utility validates with `ANALYTICS_SOURCES.has()`. If an unknown `request_source` value is written, SQL queries would use it as-is while the TS utility would fall through to the CASE logic.

Tracked sources:
- `openclaw`
- `cli-claude`
- `cli-codex`
- `direct`

## Counting Semantics
This is the easiest place to get confused.

Distinct request counts:
- `system.totalRequests`
- `system.byProvider[*].requests`
- `system.byModel[*].requests`
- `system.bySource[*].requests`
- `system.topBuyers[*].requests`
- `timeseries[*].requests`

Attempt counts:
- `tokens[*].requests`
- `tokens[*].bySource[*].requests`
- `tokens/routing[*].totalAttempts`
- `tokens/routing[*].successCount`
- `tokens/routing[*].errorCount`
- `tokens/routing[*].fallbackCount`
- `tokens/routing[*].authFailures24h`
- `tokens/routing[*].rateLimited24h`
- `/requests` rows

Exact event counts:
- `tokens/health[*].maxedEvents7d`
- `system.maxedEvents7d`

Why the split exists:
- system and timeseries views are trying to describe top-line request volume, so they de-duplicate by `request_id`
- token usage and routing views are credential-attributed and attempt-shaped, so retries/fallbacks remain visible

## Admin Analytics Endpoints

### `GET /v1/admin/analytics/tokens`
Per-token usage rollup keyed by `route_decision.tokenCredentialId`.

Fields:
- `credentialId`
- `debugLabel`
- `provider`
- `status`
- `requests`
- `usageUnits`
- `retailEquivalentMinor`
- `inputTokens`
- `outputTokens`
- `bySource`

Semantics:
- `requests` is an attempt count attributed to that credential
- `bySource` uses the same attribution and request-count semantics
- token identity is always token credential id, not seller key id

### `GET /v1/admin/analytics/tokens/health`
Current credential state plus exact `maxedEvents7d`.

Fields currently populated:
- `credentialId`
- `debugLabel`
- `provider`
- `status`
- `consecutiveFailures`
- `lastFailedStatus`
- `lastFailedAt`
- `maxedAt`
- `nextProbeAt`
- `lastProbeAt`
- `monthlyContributionLimitUnits`
- `monthlyContributionUsedUnits`
- `monthlyWindowStartAt`
- `maxedEvents7d`
- `createdAt`
- `expiresAt`

Fields currently returned as `null`:
- `requestsBeforeMaxedLastWindow`
- `avgRequestsBeforeMaxed`
- `avgUsageUnitsBeforeMaxed`
- `avgRecoveryTimeMs`
- `estimatedDailyCapacityUnits`
- `maxingCyclesObserved`
- `utilizationRate24h`

Semantics:
- returns all pool credentials, not just recently-routed credentials
- `maxedEvents7d` is sourced from `in_token_credential_events`
- `source` filter is accepted by the route layer but has no effect — health queries only `in_token_credentials` and `in_token_credential_events`, neither of which is source-shaped. The utilization CTE that previously joined routing data was removed when `utilizationRate24h` was descoped.

### `GET /v1/admin/analytics/tokens/routing`
Per-token routing quality and latency view.

Fields:
- `credentialId`
- `debugLabel`
- `provider`
- `totalAttempts`
- `successCount`
- `errorCount`
- `errorBreakdown`
- `latencyP50Ms`
- `latencyP95Ms`
- `ttfbP50Ms`
- `ttfbP95Ms`
- `fallbackCount`
- `authFailures24h`
- `rateLimited24h`

Semantics:
- built from routing attempts, not deduplicated requests
- `fallbackCount` uses `provider_selection_reason = 'fallback_provider_selected'`
- `authFailures24h` and `rateLimited24h` are always 24-hour side counts, even when the main endpoint window is broader

### `GET /v1/admin/analytics/system`
Pool-wide summary.

Fields:
- `totalRequests`
- `totalUsageUnits`
- `latencyP50Ms`
- `latencyP95Ms`
- `ttfbP50Ms`
- `ttfbP95Ms`
- `errorRate`
- `fallbackRate`
- `activeTokens`
- `maxedTokens`
- `totalTokens`
- `maxedEvents7d`
- `byProvider`
- `byModel`
- `bySource`
- `translationOverhead`
- `topBuyers`

Semantics:
- `totalRequests` is `count(distinct request_id)`
- `errorRate` is attempt-based
- `fallbackRate` is attempt-based and driven by routing metadata, not upstream 5xx status
- `topBuyers[*].percentOfTotal` is a `0..1` ratio
- `translationOverhead` currently returns `null`
- token inventory counts are provider-filterable, but not source-shaped

### `GET /v1/admin/analytics/timeseries`
Chart bucket view.

Fields:
- `date`
- `requests`
- `usageUnits`
- `errorRate`
- `latencyP50Ms`

Semantics:
- `requests` is `count(distinct request_id)`
- `errorRate` is attempt-based within the bucket
- `granularity` is `hour` or `day`

### `GET /v1/admin/analytics/requests`
Recent request drilldown view built from routing rows plus joined usage and preview logs.

Fields:
- `requestId`
- `createdAt`
- `credentialId`
- `credentialLabel`
- `provider`
- `model`
- `source`
- `translated`
- `streaming`
- `upstreamStatus`
- `latencyMs`
- `ttfbMs`
- `inputTokens`
- `outputTokens`
- `usageUnits`
- `prompt` (mapped from `prompt_preview` by route normalization)
- `response` (mapped from `response_preview` by route normalization)

Semantics:
- sourced from routing attempts, so the same `requestId` can appear more than once across retries/fallbacks
- `prompt`/`response` are preview-truncated strings from `in_request_log`, not full-body logs
- `translated` is request-level metadata only; it is not yet rolled up into system translation metrics

### `GET /v1/admin/analytics/anomalies`
Operator confidence checks.

Implemented checks:
- `missingDebugLabels`
- `unresolvedCredentialIdsInTokenModeUsage`
- `nullCredentialIdsInRouting`

Deferred checks currently returned as `null`:
- `staleAggregateWindows`
- `usageLedgerVsAggregateMismatchCount`

Semantics:
- `ok` only fails on implemented non-zero checks
- deferred `null` checks do not make the endpoint fail closed

## What We Are Not Tracking Yet
These fields are present in the API shape but intentionally not implemented yet.

Currently `null`:
- `translationOverhead`
- `requestsBeforeMaxedLastWindow`
- `avgRequestsBeforeMaxed`
- `avgUsageUnitsBeforeMaxed`
- `avgRecoveryTimeMs`
- `estimatedDailyCapacityUnits`
- `maxingCyclesObserved`
- `utilizationRate24h`
- `staleAggregateWindows`
- `usageLedgerVsAggregateMismatchCount`

Present in storage but not part of the shipped analytics contract:
- full encrypted request/response bodies in `in_request_log`

## Short Version
If someone asks "what analytics do we have today?", the answer is:

- per-attempt routing analytics with status, latency, TTFB, fallback, and source attribution
- per-attempt usage/metering analytics with input/output/usage unit totals
- per-token usage, health, and routing views
- pool-wide system summary, timeseries, recent-request drilldown, and anomaly checks
- exact 7-day maxed-event counts from durable token lifecycle events
- preview-only request/response logging for successful requests

And the answer is not:

- real translation-overhead analytics
- maxing-cycle/capacity estimation analytics
- true utilization-rate analytics
- stale-aggregate or raw-vs-aggregate mismatch analytics
- full-content request/response archival as part of the public admin analytics contract
