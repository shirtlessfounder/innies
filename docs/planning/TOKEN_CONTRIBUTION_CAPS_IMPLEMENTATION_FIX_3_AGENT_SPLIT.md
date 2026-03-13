# Token Contribution Caps Implementation Fix 3-Agent Split

Date: 2026-03-13
Source: [TOKEN_CONTRIBUTION_CAPS_IMPLEMENTATION_AUDIT.md](./TOKEN_CONTRIBUTION_CAPS_IMPLEMENTATION_AUDIT.md)

## Goal
Clear the current implementation audit with 3 low-conflict workstreams.

Primary constraint:
- keep schema/repository safety work in one lane
- keep proxy/poller lifecycle work in one lane
- keep analytics/dashboard/docs work in one lane
- do not split ownership of the Claude repeated-`429` runtime path across multiple agents

## Shared Invariants
All 3 agents should treat these as fixed:
- rollout must be code-before-migration safe; missing migration state must not `500` live paths
- provider-reported Anthropic usage remains the authoritative Claude quota signal
- Claude repeated `429` handling must stay local/reversible, not durable auth-style `maxed`
- auth-like Claude `401` / `403` maxing and probe behavior stays intact
- reserved Claude tokens must not silently fail open forever when provider-usage state is missing or hard-stale
- non-Claude contribution-cap API fields stay `null`; UI-only `0%` placeholders remain presentation-only
- dashboard/docs work should consume the final warning/reason names emitted by runtime rather than inventing parallel semantics

## Recommended Merge Order
1. Agent 1 lands first.
2. Agent 2 branches from Agent 1 and lands second.
3. Agent 3 can prep after Agent 1, but final merge should come after Agent 2 settles warning/reason names and repeated-`429` recovery semantics.

Reason:
- Agent 1 fixes the broken migration and defines the repository compatibility contract the other agents need.
- Agent 2 depends on Agent 1 for safe repo/table behavior and any shared credential-selection primitives.
- Agent 3 depends on Agent 1 for schema/read safety and on Agent 2 for final warning semantics.

## File Ownership
Use these ownership rules to reduce conflicts.

### Agent 1 Owns
- `docs/migrations/014_token_contribution_caps.sql`
- `docs/migrations/014_token_contribution_caps_no_extensions.sql`
- `api/src/repos/tokenCredentialRepository.ts`
- `api/src/repos/tokenCredentialProviderUsageRepository.ts`
- `api/src/repos/tableNames.ts`
- `api/src/services/runtime.ts` if repo/runtime wiring changes are needed
- `api/src/routes/admin.ts`
- `api/tests/tokenCredentialRepository.test.ts`
- `api/tests/tokenCredentialProviderUsageRepository.test.ts`
- `api/tests/admin.tokenCredentials.route.test.ts`

### Agent 2 Owns
- `api/src/services/tokenCredentialProviderUsage.ts`
- `api/src/jobs/tokenCredentialProviderUsageJob.ts`
- `api/src/jobs/registry.ts`
- `api/src/routes/proxy.ts`
- `api/tests/proxy.tokenMode.route.test.ts`
- `api/tests/tokenCredentialProviderUsageJob.test.ts`

### Agent 3 Owns
- `api/src/repos/analyticsRepository.ts`
- `api/src/repos/analyticsDashboardSnapshotRepository.ts`
- `api/src/routes/analytics.ts`
- `api/tests/analyticsRepository.test.ts`
- `ui/src/lib/analytics/server.ts`
- `ui/src/lib/analytics/types.ts`
- `ui/src/lib/analytics/present.ts`
- `ui/src/lib/analytics/sort.ts`
- `ui/src/components/analytics/AnalyticsTables.tsx`
- `ui/src/app/analytics/AnalyticsDashboardClient.tsx`
- `docs/API_CONTRACT.md`
- `docs/ANALYTICS.md`
- `api/tests/analytics.route.test.ts`

## Agent 1
### Scope
Schema correctness, repository compatibility, and shared credential-selection contract.

### Deliverables
- fix migration `014` in both variants so `in_token_credential_provider_usage.token_credential_id` matches `in_token_credentials.id` as `uuid`
- make the token-credential repository code-before-migration safe for the new reserve columns:
  - missing reserve columns must not crash `listActiveForRouting(...)`
  - missing reserve columns must not crash `listActiveOauthByProvider(...)`
  - missing reserve columns must not crash `listMaxedForProbe(...)`
- make provider-usage repository reads code-before-migration safe for a missing `in_token_credential_provider_usage` table
- align Claude OAuth candidate selection used by the poller with the runtime in-scope semantics:
  - do not rely on stored `auth_scheme = 'bearer'` as the only poller gate
  - future admin create/rotate behavior should not keep producing mismatched Claude OAuth rows by default
- if Agent 2 or Agent 3 need persisted fetch-failure visibility via existing credential state such as `last_refresh_error`, add the shared repository primitive here rather than having them patch repo files ad hoc

### Suggested Files
- `docs/migrations/014_token_contribution_caps.sql`
- `docs/migrations/014_token_contribution_caps_no_extensions.sql`
- `api/src/repos/tokenCredentialRepository.ts`
- `api/src/repos/tokenCredentialProviderUsageRepository.ts`
- `api/src/repos/tableNames.ts`
- `api/src/services/runtime.ts`
- `api/src/routes/admin.ts`

### Acceptance Criteria
- both `014` migration variants apply cleanly
- unmigrated environments degrade without `500` from token-credential repo reads
- unmigrated environments degrade without `500` from provider-usage repo reads
- Claude OAuth credentials that are in-scope for routing are also discoverable by the poller
- admin create/rotate no longer reinforces the OAuth classification mismatch

### Verification
- `npm test -- admin.tokenCredentials.route.test.ts tokenCredentialRepository.test.ts tokenCredentialProviderUsageRepository.test.ts`

## Agent 2
### Scope
Proxy/poller hardening and Claude lifecycle behavior.

### Deliverables
- make `refreshAnthropicOauthUsageNow(...)` resilient to snapshot persistence failures:
  - repo write failures must not turn an upstream Claude `429` into a proxy `500`
  - repo write failures in the minute poller must be logged and the loop must continue
- complete the repeated-Claude-`429` safeguard:
  - healthy immediate refresh should clear the long backoff on the request path
  - unhealthy / failed / stale immediate refresh must not silently reopen the token solely because the timer expired
  - once a fresh snapshot shows the provider-reported `5h` / `7d` window has rolled over and the token is back under threshold, runtime should stop excluding it without requiring manual intervention
  - preserve the documented fail-open behavior only where the scope explicitly allows it
- explicitly handle legacy Claude credentials already stranded in old durable `maxed` state from the previous lifecycle:
  - define whether runtime/poller should recover them automatically from provider-usage state or via an explicit one-time path
  - use Agent 1 repo primitives only if additional read/write support is required
- add per-token retry/backoff behavior for Anthropic quota-endpoint failures / `429`s instead of re-fetching every minute forever
- finalize the canonical operator/runtime reason names for:
  - missing snapshot
  - soft stale
  - hard stale
  - provider-usage fetch failure
  - contribution-cap exclusion
  - repeated-`429` local backoff
- keep non-Claude routing behavior unchanged
- consume Agent 1’s compatibility-safe repo APIs instead of reimplementing missing-table/column handling in `proxy.ts`

### Suggested Files
- `api/src/services/tokenCredentialProviderUsage.ts`
- `api/src/jobs/tokenCredentialProviderUsageJob.ts`
- `api/src/jobs/registry.ts`
- `api/src/routes/proxy.ts`

### Acceptance Criteria
- snapshot write failures are contained and logged, not surfaced as proxy `500`s in the Claude `429` path
- poller continues processing remaining credentials after one provider-usage write/fetch failure
- repeated Claude `429`s no longer reopen on timer expiry without the intended health signal
- fresh provider-reported window rollover via `five_hour_resets_at` / `seven_day_resets_at` can make an eligible token routable again
- legacy Claude credentials stuck in old `maxed` state have an explicit recovery path and are not left requiring manual DB cleanup
- quota-endpoint retry/backoff is per-token and prevents minute-by-minute hammering
- final warning/reason names are stable enough for Agent 3 to consume in analytics/dashboard/docs

### Verification
- `npm test -- proxy.tokenMode.route.test.ts tokenCredentialProviderUsageJob.test.ts`

## Agent 3
### Scope
Analytics read wiring, dashboard/operator visibility, UI consistency, and contract/docs cleanup.

### Deliverables
- wire the analytics read path end to end:
  - `getTokenHealth()` must read the reserve columns
  - `getTokenHealth()` must join/select current provider-usage snapshot fields
  - dashboard/token-health payloads must expose the raw Claude fields the UI already expects
- make analytics/dashboard reads code-before-migration safe as well:
  - missing reserve columns or provider-usage table must degrade to `null` / no-warning behavior instead of crashing dashboard endpoints
- surface operator-visible provider-usage warnings using the semantics finalized by Agent 2
- keep non-Claude provider-usage / contribution-cap fields `null` in the API while preserving UI-only `0%` cap placeholders
- fix the `5H CAP` / `7D CAP` sort mismatch so placeholder `0%` rows do not sort like hidden `null`s
- update docs so the shipped contract matches runtime:
  - document `PATCH /v1/admin/token-credentials/:id/contribution-cap` and its request/response semantics
  - Claude repeated `429`s do not auto-`max`
  - provider-usage fields are real Claude quota signals
  - legacy empirical maxing-cycle fields remain credential-health analytics, not primary Claude quota state

### Suggested Files
- `api/src/repos/analyticsRepository.ts`
- `api/src/repos/analyticsDashboardSnapshotRepository.ts`
- `api/src/routes/analytics.ts`
- `ui/src/lib/analytics/server.ts`
- `ui/src/lib/analytics/types.ts`
- `ui/src/lib/analytics/present.ts`
- `ui/src/lib/analytics/sort.ts`
- `ui/src/components/analytics/AnalyticsTables.tsx`
- `ui/src/app/analytics/AnalyticsDashboardClient.tsx`
- `docs/API_CONTRACT.md`
- `docs/ANALYTICS.md`

### Acceptance Criteria
- `/v1/admin/analytics/tokens/health` and `/v1/admin/analytics/dashboard` populate live Claude provider-usage fields when snapshots exist
- analytics/dashboard endpoints stay up in unmigrated environments and return safe fallback values
- dashboard warnings reflect the final runtime warning semantics from Agent 2
- CAP sort order matches what the operator sees in the rendered cells
- API/docs explicitly cover `PATCH /v1/admin/token-credentials/:id/contribution-cap`
- docs no longer describe the old Claude repeated-`429` auto-max behavior

### Verification
- `npm test -- analytics.route.test.ts analyticsRepository.test.ts`
- `npm run build`
  - run in `api/`
  - run in `ui/`

## Cross-Agent Handoffs
Agent 1 -> Agent 2:
- final migration schema and FK types
- final compatibility-safe repo behavior for missing reserve columns / missing provider-usage table
- final Claude OAuth poll-candidate rule
- any shared repo primitive for persisted fetch-failure state

Agent 1 -> Agent 3:
- final reserve-column names and compatibility behavior
- final provider-usage table/read contract

Agent 2 -> Agent 3:
- final warning/reason strings
- final repeated-`429` recovery semantics
- final definition of which provider-usage states should surface as operator warnings

## Coordination Notes
- Agent 1 exclusively owns `tokenCredentialRepository.ts` and `tokenCredentialProviderUsageRepository.ts`
- Agent 2 must not patch repository files directly to solve runtime problems; hand those back to Agent 1
- Agent 3 must not invent warning names in the UI layer; consume Agent 2 output
- if Agent 3 needs extra persisted warning data that is not already available from Agent 1/2 outputs, stop and explicitly hand the repo/storage change back to Agent 1
- do not split the repeated-Claude-`429` control flow across Agent 1 and Agent 2; Agent 1 owns only repo primitives, Agent 2 owns the end-to-end runtime behavior

## Final Integration Checklist
- both `014` migration variants apply cleanly
- unmigrated runtime paths no longer `500`
- Claude OAuth classification is consistent across admin input, poller selection, and routing in-scope checks
- Claude repeated-`429` handling is resilient to snapshot write failures
- quota-endpoint retry/backoff is no longer hammering every minute
- analytics/dashboard now read and expose live Claude provider-usage state
- operator warnings and docs match shipped semantics
