# Phase 1 Implementation Scope (Internal PMF)

## Objective
Ship a reliable internal-only Innies experience with:
- Codex token support
- CLI wrappers for coding workflows (`innies claude`, `innies codex`)
- Internal observability + usage visibility
- Easy token onboarding into pool
- Per-buyer provider preference with deterministic fallback
- Per-token analytics for pool efficiency and maxing behavior

Product invariant:
- Buyer/admin API keys are only for authenticating callers into Innies.
- The upstream provider credentials Innies pools and rotates are OAuth/session tokens from Claude Code and Codex/OpenAI logins, not public provider API keys.

## In Scope
1. ✅ Provider support
- Anthropic (existing) + Codex/OpenAI token routing support in same pool framework.
- Compat translation layer: Anthropic Messages ↔ OpenAI Responses (request, response, streaming).
- Error envelope mapping for translated paths (401/429/5xx → Anthropic-shaped errors).
- 125 tests passing, deployed to production.

2. CLI integration
- `innies claude`
- `innies codex`
- Wrapper behavior remains compatible with current coding loop UX.

3. Internal dashboard (v1)
- Latency and success rates
- Routing/fallback visibility
- Token health state (`active/maxed/probe`) and rotation visibility
- Per-token usage and yield analytics

4. ✅ Token onboarding
- Internal admin flow for adding tokens (`POST /v1/admin/token-credentials`)
- Token rotation (`POST /v1/admin/token-credentials/rotate`)
- Token revocation (`POST /v1/admin/token-credentials/:id/revoke`)
- Debug labels for attribution
- Basic health checks + quarantine lifecycle operationalized (maxed/probe/reactivation)
- Shell scripts: `innies-add-token.sh`, `innies-rotate-token.sh`

5. ✅ Buyer preference routing
- Buyer-key policy: preferred provider + deterministic fallback
- `preferredProviderSource` distinguishes explicit vs default preference
- Fallback plan: `[preferred, alternate]` with translation when crossing provider boundary
- Admin endpoints: `GET/PUT /v1/admin/buyer-keys/:id/provider-preference`
- Shell scripts: `innies-set-preference.sh`, `innies-get-preference.sh`, `innies-check-preference.sh`
- No mid-session provider switching for CLI coding sessions

6. ✅ Developer docs baseline
- `docs/API_CONTRACT.md`: auth + key endpoints + request/response examples
- `docs/onboarding/OPENCLAW_ONBOARDING.md`: OpenClaw integration guide
- `docs/onboarding/CLAUDE_CODEX_OAUTH_TOKENS.md`: OAuth credential setup

## Priority Order (Execution)
1. ✅ Codex support.
2. ✅ Easy per-buyer-key provider preference.
3. 🚧 Per-token analytics gathering (aggregation jobs exist, no read endpoints/dashboard yet).
4. CLI support (`innies claude`, `innies codex`).
5. Internal usage dashboard.
6. ✅ Easy token onboarding.
7. ✅ Developer docs baseline.

## Canonical Planning Rule
- `docs/planning/ROADMAP.md` is the sequence/priority document.
- `docs/planning/PHASE1_IMPLEMENTATION_SCOPE.md` is the Phase 1 source of truth.
- `docs/planning/PHASE1_CLI_PARITY_SCOPE.md` is the isolated feature scope for Phase 1 feature `4) CLI support`.
- Durable runtime behavior belongs in `docs/API_CONTRACT.md`.
- Temporary agent coordination docs, patch queues, audit scratch docs, and one-off validation notes should be folded back into this file or durable docs, then deleted.

## Current Execution Focus (2026-03-06)
Active implementation focus:
3. Per-token analytics gathering (read endpoints + dashboard views).
4. CLI support (`innies claude`, `innies codex`).
   - isolated execution scope: `docs/planning/PHASE1_CLI_PARITY_SCOPE.md`
   - explicit sequencing exception: feature `4` is unblocked to run in parallel with feature `3`; each feature still needs its own validation gate and completion notes

Completed:
- ✅ Codex support (translation layer deployed to production)
- ✅ Per-buyer-key provider preference (deterministic fallback with translation)
- ✅ Token onboarding (admin endpoints + shell scripts)
- ✅ Developer docs baseline (API contract + onboarding guides)

Current gate status:
- `cd api && npx vitest run` → 19 files, 127 tests, all green
- Compat translation deployed to production (2026-03-06)
- OpenClaw verified compatible (anthropic-messages API, server-side translation transparent)

## Execution Protocol (Feature-by-Feature)
Use this exact loop for features `1 -> 7`:
1. Work only on the current feature (do not start next feature early).
2. Run Agent 1/2/3 subtasks for that feature in parallel.
3. Run cross-agent contract checkpoint before merge:
- schema/API contract agreement (request/response/event fields)
- routing contract agreement (fallback + reason codes)
- CLI contract agreement (flags/env/pinning behavior)
4. Merge subtask changes into one feature branch.
5. Run validation gate for that feature:
- automated tests
- targeted manual checks
- regression checks for previously completed features
6. Commit as one atomic feature commit.
7. Tag/share feature completion notes (what changed, how it was validated, any known caveats).
8. Move to the next feature only after gate pass.

Execution exception (2026-03-06):
- Features `3` and `4` may proceed in parallel.
- This exception is explicitly authorized by `## Current Execution Focus`.
- Parallel work does not waive per-feature validation, contract checkpoints, or atomic completion notes.

## 3-Agent Work Split (Per Feature)

### 1) Codex support
Agent 1 (API/provider adapter):
- Add Codex provider adapter + request/response mapping in Innies route layer.
- Normalize provider errors to Innies contract.
- Add regression tests for token-mode + streaming paths.

Agent 2 (credential/routing integration):
- Extend token credential selection to include Codex provider pool.
- Ensure lifecycle hooks (`active/maxed/probe/revoked`) apply identically.
- Add provider-specific health checks for Codex keys.

Agent 3 (validation + parity checks):
- Build parity test matrix for Anthropic vs Codex expected behavior.
- Run canary scripts, capture latency/success/failure deltas.
- Publish pass/fail report for codex-readiness.

Definition of done:
- Codex requests succeed end-to-end in internal env.
- Existing Anthropic behavior not regressed.

### 2) Easy per-buyer-key provider preference
Agent 1 (data model + API):
- Add buyer-key provider preference fields + admin API update/read endpoints.
- Add safe defaults for keys without explicit preference.

Intent:
- This feature primarily exists for OpenClaw and other model-agnostic clients.
- Goal: let buyer-key preference steer cross-provider routing without making the client pick a provider-specific lane up front.

Agent 2 (routing engine):
- Implement deterministic preference-first routing.
- Implement fallback triggers (`401/403/429/timeout/5xx/capacity`) + return-to-preferred checks.
- Emit fallback reason codes in route decision metadata.

Agent 3 (tests + guardrails):
- Add integration tests for preference behavior, fallback, and re-entry.
- Add “no random provider flip” checks for CLI sessions.
- Add dashboard/event query snippets for debugging preference behavior.

Definition of done:
- Preference works per buyer key.
- Fallback deterministic and observable.

### 3) Per-token analytics gathering
Agent 1 (metrics pipeline):
- Add/verify event fields needed for per-token metrics windows (`24h/7d/1m/all`).
- Implement aggregation jobs/views for required metrics.

Agent 2 (maxing/yield analytics):
- Add derived metrics: requests before maxed, maxed events, auth failure/rate-limit rates.
- Add provider + token-level rollups.

Agent 3 (data quality + export):
- Build validation queries to verify aggregation correctness against raw events.
- Add simple export/read helpers for dashboard + docs examples.
- Add anomaly checks (missing labels, null token IDs, stale windows).

Definition of done:
- Team can see per-token yield and health trends without raw log deep-dives.

### 4) CLI support (`innies claude`, `innies codex`)
Agent 1 (command wrappers):
- Build CLI wrappers and command argument passthrough.
- Pin provider behavior (`innies claude` -> Anthropic, `innies codex` -> Codex).

Agent 2 (session/runtime wiring):
- Wire env vars/profile config needed by wrappers.
- Ensure session behavior matches normal CLI coding loop (no Innies-only wrapper stalls).

Agent 3 (UX validation + troubleshooting):
- Create smoke-test scripts for both wrappers.
- Add clear failure messages for auth/capacity/maxed states.
- Validate compatibility on Dylan's machine (Phase 1 is internal-only).

Definition of done:
- Internal team can use both wrappers for normal coding sessions.

### 5) Internal usage dashboard
Agent 1 (backend endpoints):
- Build read-only metrics endpoints for provider/key/team-level stats.
- Add query filters for windows and provider/key labels.

Agent 2 (UI or terminal dashboard view):
- Build minimal internal dashboard surface for p50/p95 latency, success/error, fallback, token health.
- Add per-token and per-buyer panels.

Agent 3 (ops instrumentation):
- Add runbook queries for common incidents (latency spike, failure wave, bad key).
- Validate dashboard numbers match raw DB/event counts.
- Add alert thresholds for major regressions.

Definition of done:
- Internal team can monitor health/perf from one place.

### 6) Easy token onboarding
Agent 1 (admin flow):
- Implement/clean up token add flow for Anthropic + Codex.
- Ensure required metadata captured (`debug_label`, provider, expiry).

Agent 2 (safety + lifecycle):
- Auto-check for duplicate tokens and bad format before insert.
- Ensure new tokens enter correct lifecycle state and health probes.

Agent 3 (operator experience):
- Create one-command onboarding scripts/checklists for admin use.
- Add verification queries (“token added, active, routable”).
- Add offboarding/revoke checklist.

Definition of done:
- Admin can onboard/offboard keys quickly with low error risk.

### 7) Developer docs baseline
Agent 1 (API quickstart):
- Write concise auth + endpoint + examples doc (`/v1/messages`, `/v1/proxy/*`).
- Include Anthropic + Codex example payloads.

Agent 2 (ops docs):
- Document token lifecycle states, preference routing, fallback semantics, common failure modes.
- Add “how to debug with queries/logs” section.

Agent 3 (CLI/how-to docs):
- Document `innies claude` and `innies codex` setup/use/troubleshooting.
- Add onboarding docs for internal team first-use flow.

Definition of done:
- New internal dev can integrate + debug using docs only.

## Out of Scope
- External/public onboarding
- Stripe billing/payout productization
- Permissionless org creation
- Public community growth workflows

## Architecture Workstreams

### A) Provider Adapter Parity
Deliverables:
- Codex provider route compatibility matrix
- Error mapping parity to existing app contract
- Streaming parity checks for coding/tool flows

Acceptance:
- Internal can run preferred provider requests reliably
- Fallback behavior matches policy without silent failures

### B) Routing Policy + Preference Engine
Deliverables:
- Buyer key provider preference model
- Fallback state machine (deterministic)
- Policy persistence/read path

Acceptance:
- Preferred provider used when eligible
- Fallback engaged only when trigger conditions met
- Events/logs include reason codes for fallback

### C) Token Lifecycle + Pool Operations
Deliverables:
- Internal onboarding workflow + docs
- Credential health/quarantine/reprobe verified for all active providers in phase
- Label-based operational introspection

Acceptance:
- Bad credentials stop degrading pool latency repeatedly
- Re-activation path works without manual DB surgery

### D) CLI Wrapper Experience
Deliverables:
- `innies claude` and `innies codex` commands
- Environment wiring + compatibility behavior
- Troubleshooting hints for auth/capacity failures

Acceptance:
- Internal users can complete coding sessions from both wrappers
- No Innies-only stalls attributable to wrapper behavior

#### D1) CLI Parity Implementation Slice (2026-03-06)
Goal:
- Finish provider-specific wrapper parity without widening the CLI surface beyond Phase 1 needs.
- Detailed isolated scope: `docs/planning/PHASE1_CLI_PARITY_SCOPE.md`
- This slice includes any minimal API/request-shaping work required to make Codex wrapper traffic truly pinned and validation-visible.

In scope:
- `innies claude -- <claude args...>` as the Anthropic-pinned coding lane.
- `innies codex -- <codex args...>` as the Codex/OpenAI-pinned coding lane.
- Shared `innies login` config remains one buyer token + base URL + provider defaults.
- Shared `innies doctor` expands to report Claude-lane and Codex-lane readiness separately.
- Existing `innies link claude` remains supported.
- Argument passthrough after `--`, TTY-preserving execution, and exit-code parity with the wrapped binary.
- One-line runtime status output including proxy target + correlation/request id.
- Binary resolution + recursion guards for both wrappers:
  - `INNIES_CLAUDE_BIN`
  - `INNIES_CODEX_BIN`
  - `INNIES_CLAUDE_WRAPPED`
  - `INNIES_CODEX_WRAPPED`
- Shared Innies env wiring (`INNIES_TOKEN`, `INNIES_API_BASE_URL`, `INNIES_PROXY_URL`, `INNIES_MODEL`, `INNIES_CORRELATION_ID`) plus the provider-native env vars expected by the wrapped CLI.
- Explicit provider pin signal on every wrapper request so routing stays on the intended provider lane and emits `cli_provider_pinned`.
- Provider-specific default model selection:
  - Claude wrapper uses Anthropic default model config.
  - Codex wrapper uses Codex/OpenAI default model config.
- Actionable hints for:
  - token mode not enabled
  - unauthorized / expired upstream credential
  - capacity unavailable / maxed pool state

Validation gate:
- Local fake-binary smoke coverage for both wrappers.
- Real-env proof for both wrappers against `/v1/proxy/*`.
- Evidence for each wrapper includes:
  - successful routed request
  - token-credential attribution header/log evidence
  - routing reason `cli_provider_pinned`
- At least one real coding-session validation by Dylan on his local machine per wrapper.
- No provider flip during a pinned session.

Explicit non-goals for this slice:
- Generic preference-routed CLI entrypoint (for example `innies chat` or `innies code`).
- Mid-session cross-provider switching inside provider-specific wrappers.
- CLI-managed OAuth setup/login productization (`innies auth setup` belongs to Phase 2).
- Per-user provider/model override UI or config beyond Phase 1 defaults.
- Auto-installing or auto-updating Claude/Codex upstream binaries.
- Requiring `innies link codex` for Phase 1 exit; direct `innies codex` usage is sufficient.

Implementation order:
1. Add command parity (`innies codex`) using the same wrapper contract as `innies claude`.
2. Expand shared readiness/troubleshooting surfaces (`innies doctor`, usage text, error hints) so both lanes are first-class.
3. Extend smoke coverage to exercise both wrappers locally and in real-env proof mode.
4. Update CLI docs only after command behavior and smoke validation match the shipped contract.

### E) Internal Dashboard + Analytics
Deliverables:
- Unified internal dashboard panels:
  - latency p50/p95
  - success/error rates by provider
  - fallback rate
  - per-token throughput and yield
  - maxing frequency by token/day/week

Acceptance:
- Team can identify underperforming credentials and routing regressions without raw log spelunking

### F) Developer Documentation
Deliverables:
- API quickstart markdown with:
  - auth
  - `/v1/messages` + `/v1/proxy/*`
  - error model
  - sample cURL flows

Acceptance:
- A new internal dev can integrate from docs only

## Per-Token Analytics (Phase 1 Required)
Minimum metrics:
- `requests_per_token_24h`
- `success_rate_per_token_24h`
- `auth_failures_per_token_24h`
- `rate_limited_per_token_24h`
- `tokens_processed_per_token_24h`
- `maxed_events_per_token_7d`
- `requests_before_maxed_last_window`

## SLO Targets (Internal)
- First-byte latency p95 (canary window): `<= 8,000ms`
- Timeout rate (canary window): `<= 2.0%`
- Tool-loop success rate (canary window): `>= 95.0%`
- Fallback rate: investigate if `> 20%` or day-over-day increase `> 10pp`
- Full-window exit gate default: use the same thresholds as canary unless explicitly revised in this document before Phase 1 exit signoff.

## Rollout Plan
1. Implement behind internal flags.
2. Canary subset of buyer keys.
3. Validate Phase 1 exit criteria (SLO + tool-loop behavior + checklist artifact).
4. Expand to all internal keys.
5. Freeze Phase 1 and begin Phase 2 planning checkpoint.

## Risks
- Cross-provider response contract drift
- Hidden auth differences causing repeated retries
- Fallback policy ambiguity causing inconsistent behavior
- Missing analytics granularity for root-cause triage

## Dependencies
- Stable provider credentials for Anthropic and Codex
- Existing token credential lifecycle in production
- Internal dashboard backend aggregation support

## Resolved Decisions (Locked)
1. Fallback behavior with provider preference
- If preferred provider has at least one active/eligible key, keep traffic on preferred provider.
- If all preferred-provider keys are unavailable/failing, switch to secondary provider for requests.
- During fallback period, continue trying preferred provider on each turn as long as keys are still active (not maxed/expired/revoked).

2. Fallback trigger conditions
- Trigger fallback on any of:
  - `401`
  - `403`
  - `429`
  - timeout
  - `5xx`
  - capacity exhaustion

3. Re-entry to preferred provider
- Non-CLI requests: re-check preferred provider every turn.
- Non-CLI requests: if preferred provider is eligible again, route back to preferred provider.
- CLI requests: do not switch provider mid-session; provider pin takes precedence.

4. CLI wrapper behavior
- `innies claude` hard-pins Anthropic path for the session.
- `innies codex` hard-pins Codex/OpenAI path for the session.
- Goal: match normal CLI coding UX, with pooled keys underneath.
- Buyer-key provider preference is not the primary steering control for these wrappers; they are provider-specific entrypoints by design.

5. Codex model strategy (Phase 1)
- Single default Codex model for all internal usage in Phase 1.
- Default model is config-driven (env/config), not hard-coded in plan or runtime.
- Initial default target: `gpt-5.4`.
- Revalidate model choice at Phase 1 midpoint and before Phase 1 exit.

6. Dashboard scope cut
- Read-only for Phase 1.
- Show per-key, per-provider, and aggregate team stats.
- Include token maxed-status visibility.

7. Token onboarding UX
- Terminal/manual admin onboarding only in Phase 1.
- Team members send tokens to admin; admin adds them.

8. Maxing policy default
- Keep conservative default: auto-max on repeated `401` only.

9. Analytics windows
- Default windows: `24h`, `7d`, `1m`, `all`.

10. Documentation format
- Canonical markdown in repo only for Phase 1.

11. Exit gate artifact
- Keep formal “Phase 1 done” checklist artifact.

## Phase 1 Exit Checklist Artifact
Required file:
- `docs/planning/PHASE1_DONE_CHECKLIST.md`

Owner:
- Phase 1 lead (or delegated release owner).

Required sections:
- completion status for features `1 -> 7`
- validation evidence (commands, dashboards, or query links)
- canary + full-window SLO results
- known caveats + follow-up tickets
- explicit go/no-go decision + approver name/date
