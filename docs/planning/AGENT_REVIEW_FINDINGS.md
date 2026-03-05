# Agent Review Findings

Purpose: centralize cross-agent review concerns before patching code/docs.

Status: open
Owner: tbd
Last updated: 2026-03-05

## Patch Plan (3 Agents)

### Agent 1: Routing Core
- Scope:
  - runtime preference resolution in token-mode routing
  - explicit-provider pinning rules
  - provider alias canonicalization at proxy ingress
  - fallback/re-entry control flow
  - emitted routing metadata contract
- Primary files:
  - `api/src/routes/proxy.ts`
  - `api/tests/proxy.tokenMode.route.test.ts`
- Assigned findings:
  - `Buyer-key preference API not wired into runtime routing selection`
  - `Provider preference is bypassed for most proxy requests`
  - ``codex` alias is normalized in admin APIs but not in proxy routing/credential lookup`
  - `Preferred-provider preflight eligibility errors bypass fallback handling`

### Agent 2: Data / Control Plane
- Scope:
  - buyer-key preference data-path hardening
  - auth compatibility during migration rollout
  - admin/read-write endpoint alignment with runtime contract
  - migration safety
- Primary files:
  - `api/src/repos/apiKeyRepository.ts`
  - `api/src/middleware/auth.ts`
  - `api/src/routes/admin.ts`
  - `docs/migrations/009_buyer_key_provider_preference.sql`
  - `docs/migrations/009_buyer_key_provider_preference_no_extensions.sql`
- Assigned findings:
  - `API key auth query now depends on migration order`

### Agent 3: Validation / Docs / Ops
- Scope:
  - canary correctness
  - debug SQL alignment
  - validation criteria alignment
  - final API/docs/runbook consistency
- Primary files:
  - `api/scripts/provider_preference_canary.sh`
  - `docs/planning/PREFERENCE_ROUTING_QUERY_SNIPPETS.sql`
  - `docs/planning/PREFERENCE_ROUTING_VALIDATION.md`
  - `docs/API_CONTRACT.md`
- Assigned findings:
  - `Provider preference canary does not validate preference logic`
  - `Routing metadata keys mismatch between code and debug SQL`
  - `Validation criteria require reason codes not currently emitted`

## Merge Order
1. Agent 2: remove migration/auth fragility first.
2. Agent 1: patch routing behavior on top of stable auth/preference inputs.
3. Agent 3: align canaries/docs/queries after runtime contract is final.

## Locked Decisions
- Canonical runtime/storage providers are `anthropic` and `openai`.
- `codex` is an ingress alias only and must normalize to `openai`.
- Buyer-key preference source of truth is DB-backed preference (`req.auth.preferredProvider` or equivalent persisted read path), not the env map.
- Provider pinning is only for explicit session/CLI/compat cases, not merely because proxy JSON includes a `provider` field.
- Routing metadata shape must be finalized by Agent 1 before Agent 3 updates validation/docs.

## Submission Format (for all agents)
Use this exact block per finding:

```md
### [Severity] Short title
- Agent: <name>
- Area: <api|cli|ui|docs|ops>
- Summary: <1-2 lines>
- Evidence:
  - `path/to/file:line`
  - `path/to/file:line`
- Impact: <why this matters>
- Proposed fix: <short concrete action>
- Status: open
```

## Current Findings

### [High] Buyer-key preference API not wired into runtime routing selection
- Agent: codex
- Area: api
- Summary: Admin endpoints persist/read buyer key provider preference, and auth already loads `req.auth.preferredProvider`, but proxy routing still resolves preference from env (`BUYER_PROVIDER_PREFERENCES`) instead of the DB-backed key preference.
- Evidence:
  - `api/src/middleware/auth.ts:33`
  - `api/src/middleware/auth.ts:37`
  - `api/src/routes/admin.ts:136`
  - `api/src/routes/admin.ts:165`
  - `api/src/repos/apiKeyRepository.ts:48`
  - `api/src/repos/apiKeyRepository.ts:65`
  - `api/src/routes/proxy.ts:152`
  - `api/src/routes/proxy.ts:192`
  - `api/src/routes/proxy.ts:2155`
- Impact: `PATCH /v1/admin/buyer-keys/:id/provider-preference` can succeed but have no effect on live routing behavior.
- Proposed fix: Resolve provider plan from persisted preference (prefer `req.auth.preferredProvider`, with repo lookup only if needed), and demote the env map to an explicit override or remove it.
- Status: open

### [High] Provider preference is bypassed for most proxy requests
- Agent: codex
- Area: api
- Summary: Proxy treats any request body that includes `provider` as explicitly pinned, and the current proxy contract normally includes `provider`, so buyer-key preference-first routing is skipped on most real requests.
- Evidence:
  - `api/src/routes/proxy.ts:178`
  - `api/src/routes/proxy.ts:185`
  - `api/src/routes/proxy.ts:2149`
  - `docs/API_CONTRACT.md:40`
- Impact: The feature can appear implemented while having little or no effect for existing proxy clients, which is a behavioral mismatch with the Phase 1 scope.
- Proposed fix: Narrow pinning to explicit session/CLI cases, or introduce a separate signal for provider pinning so normal proxy requests can still use buyer preference routing.
- Status: open

### [High] `codex` alias is normalized in admin APIs but not in proxy routing/credential lookup
- Agent: codex
- Area: api
- Summary: Admin preference/token APIs normalize `codex` to `openai`, but proxy request handling only lowercases the provider and then looks up compatibility and token credentials using the raw value.
- Evidence:
  - `api/src/routes/admin.ts:12`
  - `api/src/routes/proxy.ts:174`
  - `api/src/routes/proxy.ts:184`
  - `api/src/routes/proxy.ts:2207`
  - `api/src/repos/tokenCredentialRepository.ts:166`
- Impact: Requests sent with `provider: "codex"` can miss `openai` token credentials and fail routing/capacity checks even though admin state stores the equivalent provider as `openai`.
- Proposed fix: Canonicalize provider aliases at proxy ingress before compatibility checks, provider-plan construction, and credential lookup; if needed, retain the original alias separately for response/debug metadata.
- Status: open

### [High] API key auth query now depends on migration order
- Agent: codex
- Area: api
- Summary: API key lookup now selects `preferred_provider` unconditionally, which will fail before migration `009_buyer_key_provider_preference` is applied.
- Evidence:
  - `api/src/repos/apiKeyRepository.ts:28`
  - `api/src/middleware/auth.ts:27`
  - `docs/migrations/009_buyer_key_provider_preference.sql:1`
- Impact: Deploying application code before the migration can break all API-key-authenticated requests at startup/runtime.
- Proposed fix: Either ship migration before app rollout with an explicit gate, or make auth lookup backward-compatible until the column is guaranteed present.
- Status: open

### [Medium] Provider preference canary does not validate preference logic
- Agent: codex
- Area: ops
- Summary: Canary script sends explicit provider values, and explicit-provider requests bypass preference routing path.
- Evidence:
  - `api/scripts/provider_preference_canary.sh:69`
  - `api/scripts/provider_preference_canary.sh:73`
  - `api/src/routes/proxy.ts:185`
  - `api/src/routes/proxy.ts:2149`
- Impact: Canary can pass without testing preference-first/fallback behavior.
- Proposed fix: Add at least one scenario with no explicit `provider` in request body and assert provider selection from preference metadata/events.
- Status: open

### [Medium] Preferred-provider preflight eligibility errors bypass fallback handling
- Agent: codex
- Area: api
- Summary: Provider eligibility validation runs before the per-provider `try/catch`, and the fallback reason mapper does not treat `model_invalid` or `suspended` as fallback-eligible outcomes.
- Evidence:
  - `api/src/routes/proxy.ts:208`
  - `api/src/routes/proxy.ts:230`
  - `api/src/routes/proxy.ts:2166`
  - `api/src/routes/proxy.ts:2220`
- Impact: If the preferred provider is disabled or model-incompatible, the request can fail immediately instead of attempting the next provider in the preference plan.
- Proposed fix: Move eligibility validation inside the fallback-controlled `try/catch` path and decide explicitly which preflight failures should advance to the next provider.
- Status: open

### [Medium] Routing metadata keys mismatch between code and debug SQL
- Agent: codex
- Area: docs
- Summary: SQL snippets query camelCase fields that are not emitted by routing code (code emits snake_case keys).
- Evidence:
  - `api/src/routes/proxy.ts:596`
  - `docs/planning/PREFERENCE_ROUTING_QUERY_SNIPPETS.sql:42`
- Impact: Debug queries return null/misleading outputs for preference/fallback fields.
- Proposed fix: Align SQL snippets to emitted keys (`provider_preferred`, `provider_effective`, `provider_fallback_reason`, etc.) or adjust emitted keys.
- Status: open

### [Medium] Validation criteria require reason codes not currently emitted
- Agent: codex
- Area: docs
- Summary: Validation doc requires specific reason-code taxonomy, but route decision currently keeps `reason=token_mode_round_robin` and emits fallback metadata separately.
- Evidence:
  - `docs/planning/PREFERENCE_ROUTING_VALIDATION.md:22`
  - `api/src/routes/proxy.ts:588`
- Impact: Agent-3 validation cannot pass as written, even when behavior is correct.
- Proposed fix: Either emit required reason-code taxonomy in routing events or revise validation doc to match current metadata contract.
- Status: open

## Closed / Superseded

### [Closed] Missing dedicated admin buyer-preference endpoint tests
- Agent: codex
- Area: api
- Summary: This gap is no longer current; dedicated tests now cover the admin buyer-preference GET/PATCH routes, including default behavior, `codex` normalization, and not-found handling.
- Evidence:
  - `api/tests/admin.buyerProviderPreference.route.test.ts:119`
  - `api/tests/admin.buyerProviderPreference.route.test.ts:152`
  - `api/tests/admin.buyerProviderPreference.route.test.ts:181`
  - `api/tests/admin.buyerProviderPreference.route.test.ts:233`
- Impact: Test coverage exists for the admin endpoints, so this should not remain in the open findings list.
- Proposed fix: Keep these tests and extend them only if additional authz/idempotency edge cases need coverage.
- Status: closed
