# Token Contribution Caps 3-Agent Split

Date: 2026-03-12
Source: [TOKEN_CONTRIBUTION_CAPS_SCOPE.md](./TOKEN_CONTRIBUTION_CAPS_SCOPE.md)

## Goal
Turn the current scope into 3 low-conflict workstreams.

Primary constraint:
- keep file ownership clean enough that agents can work mostly in parallel
- keep Claude quota-state work separate from analytics/dashboard copy work
- avoid multiple agents editing the same hot files unless explicitly planned

## Shared Invariants
All 3 agents should treat these as fixed:
- V1 is Claude-only
- provider-reported Anthropic usage is authoritative for Claude quota state
- Claude quota exhaustion must not reuse durable auth-failure `maxed` semantics
- transient Claude `429`s can still cause temporary local rate limiting
- repeated Claude `429`s move to longer local backoff, not durable `maxed` + probe
- reserve enforcement uses both `5h` and `7d` windows
- non-Claude API fields stay `null` for Claude-only contribution-cap / provider-usage fields
- the UI may show `0%` placeholders only in the `5H CAP` / `7D CAP` table cells
- dashboard cap columns are derived from raw utilization + reserve values, not stored as separate provider fields
- legacy empirical Claude maxing-cycle fields are no longer primary quota/capacity signals

## Recommended Merge Order
1. Agent 1 lands schema, shared repository APIs, the Claude-specific repeated-`429` repo primitive, and admin write surface.
2. Agent 2 branches from Agent 1 or rebases early, then lands provider polling and routing/lifecycle behavior.
3. Agent 3 can prep in parallel after Agent 1, but final merge should come after Agent 2 settles routing/debug reasons and stale/missing-snapshot semantics.

Reason:
- Agent 1 defines the shared storage contract.
- Agent 2 also depends on Agent 1 owning the current Claude `429` repo transition point in `tokenCredentialRepository.ts`.
- Agent 3 depends on Agent 1 for field shape and Agent 2 for final runtime semantics.

## File Ownership
Use these ownership rules to reduce conflicts:

### Agent 1 Owns
- `docs/migrations/*` for this feature
- `api/src/repos/tokenCredentialRepository.ts`
- `api/src/repos/tableNames.ts`
- `api/src/services/runtime.ts` for provider-usage repo/runtime wiring
- new provider-usage repository file if added
- `api/src/routes/admin.ts`
- `api/tests/tokenCredentialRepository.test.ts`
- `api/tests/admin.tokenCredentials.route.test.ts`

### Agent 2 Owns
- `api/src/routes/proxy.ts`
- new Anthropic provider-usage fetcher/service files
- new polling job files
- `api/src/jobs/registry.ts`
- `api/src/jobs/scheduler.ts`
- `api/tests/proxy.tokenMode.route.test.ts`
- `api/tests/jobs.test.ts`
- `api/tests/tokenCredentialService.test.ts` if needed

### Agent 3 Owns
- `api/src/repos/analyticsRepository.ts`
- `api/src/repos/analyticsDashboardSnapshotRepository.ts`
- `api/src/routes/analytics.ts`
- `ui/src/lib/analytics/*`
- `ui/src/components/analytics/*`
- `ui/src/app/analytics/*`
- `docs/API_CONTRACT.md`
- `docs/ANALYTICS.md`
- analytics-focused tests

## Agent 1
### Scope
Data model, shared repository primitives, and admin write path.

### Deliverables
- add `five_hour_reserve_percent` and `seven_day_reserve_percent` to token credentials
- add current provider-usage snapshot storage for Claude tokens
- add repository methods to:
  - update per-token reserve percentages
  - read reserve fields needed by routing and analytics
  - list Claude credentials needed by the poller
  - persist and read the latest provider-usage snapshot
- if the new provider-usage repository is exposed through the runtime container, wire it through `api/src/services/runtime.ts`
- change the Claude-specific repeated-`429` repository transition so proxy/runtime code can apply longer local backoff without durable `maxed` + probe
- expose the repository API Agent 2 will call for Claude repeated-`429` escalation, including the return shape proxy needs to decide follow-up behavior
- add `PATCH /v1/admin/token-credentials/:id/contribution-cap`
- validate request payload semantics:
  - integer percent
  - `0..100`
  - patch does not mutate monthly contribution fields

### Suggested Files
- `docs/migrations/014_token_contribution_caps.sql`
- `docs/migrations/014_token_contribution_caps_no_extensions.sql`
- `api/src/repos/tokenCredentialRepository.ts`
- `api/src/repos/tableNames.ts`
- `api/src/services/runtime.ts`
- `api/src/repos/tokenCredentialProviderUsageRepository.ts`
- `api/src/routes/admin.ts`

### Acceptance Criteria
- reserve fields persist correctly
- latest provider snapshot can be upserted and read back by token id
- provider-usage repo/runtime wiring is stable and available to downstream runtime code without ad hoc integration edits
- Claude repeated-`429` repository handling exposes a non-`maxed` path Agent 2 can use from `proxy.ts`
- admin patch endpoint updates reserve fields without rotating token state
- non-Claude tokens can still exist unchanged in the data model

### Verification
- `npm test -- admin.tokenCredentials.route.test.ts tokenCredentialRepository.test.ts`

## Agent 2
### Scope
Provider usage polling plus routing/lifecycle behavior.

### Deliverables
- add Anthropic usage fetch path for Claude OAuth credentials
- poll all active Claude tokens every `1 minute`
- store latest snapshot through Agent 1 repository APIs
- enforce missing-snapshot bootstrap behavior:
  - reserved Claude tokens excluded until first successful snapshot
  - zero-reserve Claude tokens fail open while waiting for first snapshot
- enforce soft-stale vs hard-stale behavior
- gate pooled routing on both `5h` and `7d` thresholds
- keep transient Claude `429 -> rate_limited_until`
- replace repeated Claude `429 -> maxed -> probe` with longer local backoff
- keep auth-like Claude `401/403 -> maxed -> probe`
- keep non-Claude behavior unchanged
- emit request-level routing/debug reasons only for states that actually affect token eligibility, such as:
  - contribution-cap exhaustion
  - missing snapshot
  - hard-stale reserved snapshot exclusion
- emit operator-visible ops-log / health warnings for fetch failure and soft-stale conditions

### Suggested Files
- `api/src/routes/proxy.ts`
- `api/src/jobs/registry.ts`
- `api/src/jobs/scheduler.ts`
- `api/src/services/tokenCredentialService.ts`
- new Anthropic usage client/service file
- new provider-usage polling job file

### Acceptance Criteria
- Claude eligibility uses provider snapshot + reserve thresholds
- repeated Claude `429`s no longer produce durable `maxed` state
- quota recovery happens via refreshed provider state, not probe
- hard-stale reserved Claude tokens stop participating in pooled routing
- zero-reserve Claude tokens still fail open under hard-stale or missing-snapshot conditions

### Verification
- `npm test -- proxy.tokenMode.route.test.ts jobs.test.ts tokenCredentialService.test.ts`

## Agent 3
### Scope
Analytics read surface, dashboard presentation, contract/docs cleanup.

### Deliverables
- add raw provider-usage/reserve fields to analytics token health/dashboard payloads
- keep all Claude-only contribution-cap / provider-usage fields `null` for non-Claude rows
- compute `5H CAP` and `7D CAP` in the dashboard layer from raw utilization + reserve
- render `0%` placeholders only for non-Claude `5H CAP` / `7D CAP` cells
- surface snapshot freshness and operator warnings
- clarify analytics semantics:
  - Claude `maxed` / `reactivated` are credential-health lifecycle events
  - `maxedTokens` and `maxedEvents7d` are no longer routine Claude quota-exhaustion counters
  - legacy Claude empirical cycle fields are legacy credential-health analytics only
- update API/docs so current contract matches shipped behavior

### Suggested Files
- `api/src/repos/analyticsRepository.ts`
- `api/src/repos/analyticsDashboardSnapshotRepository.ts`
- `api/src/routes/analytics.ts`
- `ui/src/lib/analytics/server.ts`
- `ui/src/lib/analytics/types.ts`
- `ui/src/lib/analytics/present.ts`
- `ui/src/components/analytics/AnalyticsTables.tsx`
- `ui/src/app/analytics/AnalyticsDashboardClient.tsx`
- `docs/API_CONTRACT.md`
- `docs/ANALYTICS.md`

### Acceptance Criteria
- dashboard and token-health responses expose the raw Claude fields needed for display
- non-Claude API rows keep Claude-only fields `null`
- dashboard shows normalized cap columns for Claude rows
- dashboard shows `0%` only as UI placeholder for non-Claude cap cells
- docs no longer claim Claude repeated `15x 429` auto-maxes
- docs no longer imply Claude maxing-cycle fields are authoritative quota/capacity signals

### Verification
- `npm test -- analytics.route.test.ts analyticsRepository.test.ts analyticsRepository.anomalies.test.ts analyticsDashboardSnapshotRepository.test.ts analyticsUtils.test.ts`
- `npm run build`
  - run in `ui/`

## Cross-Agent Handoffs
Agent 1 -> Agent 2:
- final schema names
- final repository API for reading/upserting provider-usage snapshots
- final reserve field names and validation rules
- final Claude repeated-`429` repository method and return shape used by `proxy.ts`
- final runtime wiring path for accessing the provider-usage repository/service

Agent 1 -> Agent 3:
- final admin/read model field names
- final nullability for non-Claude rows

Agent 2 -> Agent 3:
- final routing/debug reason names
- final stale/missing/fetch-failure warning surfaces
- final semantics for repeated Claude `429` backoff and recovery

## Coordination Notes
- avoid parallel edits in `api/src/repos/tokenCredentialRepository.ts`; Agent 1 owns it
- avoid parallel edits in `api/src/repos/tableNames.ts`; Agent 1 owns it
- avoid parallel edits in `api/src/services/runtime.ts`; Agent 1 owns provider-usage repo/runtime wiring there
- avoid parallel edits in `api/src/routes/proxy.ts`; Agent 2 owns it
- avoid parallel edits in `docs/API_CONTRACT.md` and `docs/ANALYTICS.md`; Agent 3 owns them
- if Agent 2 discovers new raw fields are needed for analytics, add them through Agent 1-owned repository APIs instead of editing analytics docs directly
- if Agent 2 needs a changed Claude repeated-`429` repo contract, hand that back to Agent 1 instead of editing `tokenCredentialRepository.ts` directly
- if Agent 2 needs provider-usage runtime container changes, hand that back to Agent 1 instead of editing `runtime.ts` directly
- if Agent 3 needs extra routing reason strings, consume Agent 2 output rather than inventing new names in the UI layer

## Final Integration Checklist
- DB migrations applied cleanly in both extension and no-extension variants
- admin write surface works before routing feature flag is enabled
- routing behavior matches missing-snapshot, stale-snapshot, and repeated-`429` rules
- analytics/dashboard reads match API nullability rules
- UI placeholder behavior stays presentation-only
- `docs/API_CONTRACT.md` and `docs/ANALYTICS.md` match the implementation that ships
