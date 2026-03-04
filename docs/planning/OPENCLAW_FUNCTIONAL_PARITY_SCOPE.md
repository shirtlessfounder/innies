# OpenClaw Functional Parity Scope (Innies)

## Goal
Make OpenClaw behavior through Innies match direct Anthropic behavior across streaming, tool/link workflows, auth stability, and retry/rate-limit behavior, without reducing capability or changing normal OpenClaw UX.

## Parity Baseline (Pinned)
All parity comparisons in this scope must use:
1. OpenClaw exact version and commit SHA (recorded in evidence bundle)
2. Anthropic JS SDK exact version (recorded in evidence bundle; no wildcard/family pins)
3. Model: `claude-opus-4-6`
4. Same prompt/tool/session cohort replayed to:
   - vanilla OpenClaw -> Anthropic
   - OpenClaw -> Innies -> Anthropic
5. Same upstream account/rate-limit envelope for both paths (or runs are invalid for parity gating)

## Parity Principle (Hard Constraint)
Only ship changes that close a measured divergence from vanilla OpenClaw + Anthropic.
If behavior is already the same as vanilla, do not add new logic.

## Problem Statement (Observed)
As of March 3, 2026, Telegram sessions show long silent windows after URL/repo prompts (for example, 5:54 PM -> 6:02 PM and 6:02 PM -> 6:07 PM) with messages like "loading the repo" / "fetching the repo." This feels worse than direct Anthropic usage.

## Non-Negotiables
1. No disabling automatic tool/link workflows.
2. No "just timeout and skip" as primary behavior.
3. Preserve full tool capability and fidelity.
4. Maintain Cloudflare-on deployment.
5. No UX/product behavior changes beyond parity with vanilla OpenClaw.
6. No speculative hardening unless A/B traces prove a parity gap.

## Ownership and Repos
This scope spans two codebases and must be executed with explicit ownership:
1. Innies repo (`/Users/dylanvu/innies`): stream transport parity, retry/auth telemetry, routing behavior.
2. OpenClaw runtime repo (external): tool lifecycle instrumentation and runtime orchestration parity checks.
3. No workstream is complete without linked evidence from both sides for matched runs.

## Pre-Run Drift Gate (Required Before Any Parity Batch)
All commands/artifacts below are mandatory. If any item fails, parity run is invalid.

1. Vanilla repo drift check (OpenClaw runtime repo):
```bash
git -C /path/to/openclaw status -sb
git -C /path/to/openclaw rev-parse HEAD
git -C /path/to/openclaw rev-parse origin/main
```
Requirement:
- working tree clean
- `HEAD == origin/main` (or explicitly documented pinned commit used for both direct and Innies paths)

2. Runtime config snapshot + hash capture:
```bash
shasum -a 256 ~/.openclaw/openclaw.json
shasum -a 256 ~/.openclaw/agents/main/agent/auth-profiles.json
systemctl --user cat openclaw-gateway.service
ls -la ~/.config/systemd/user/openclaw-gateway.service.d
```
Requirement:
- attach hashes and service/override contents to parity evidence bundle.

3. Model fallback drift control:
Requirement:
- fallbacks must be disabled (`[]`) for parity batch, or fixed/pinned list documented and identical across direct and Innies paths.

4. Channel/runtime behavior snapshot:
Requirement:
- capture OpenClaw runtime/channel knobs relevant to message dispatch/streaming (queue/debounce/transport settings) and include in evidence bundle.

## Current Evidence
1. Innies request path is healthy once called:
   - `/v1/messages` returns `200` SSE repeatedly with first-byte around 4.3s-4.8s.
2. Innies stream mode is frequently `synthetic_bridge` for OpenClaw traffic.
3. Intermittent retry/rate-limit exists (`429` then successful retry on same request_id).
4. OpenClaw logs have shown separate failure windows (`401 all token credentials unauthorized or expired`) and restart events.
5. Routing events show intermittent `429 rate_limited` first-attempt then `200` retry on same request_id, adding user-visible jitter.

Inference: end-user silence is not solely model latency. Parity gaps likely involve stream/tool execution flow before/around upstream calls.

## Scope

## Execution Snapshot (March 3, 2026)
Completed in Innies (C1 partial):
1. Token-mode streaming upstream requests now include `Accept: text/event-stream` to bias native Anthropic SSE passthrough.
2. Stream telemetry now logs `upstream_content_type` on both `stream_mode=passthrough` and `stream_mode=synthetic_bridge`.
3. Targeted regression suite passed after change:
   - `tests/anthropicCompat.route.test.ts`
   - `tests/proxy.tokenMode.route.test.ts`

Audit implication:
- We can now distinguish true upstream JSON responses (expected bridge path) from unexpected bridge usage when upstream already returns SSE.

### C1: Streaming Parity (Primary)
Ensure `stream=true` requests match Anthropic-native streaming semantics for OpenClaw tool workflows.

Required:
1. Prefer true upstream streaming passthrough for API-key/OpenClaw happy-path.
2. Keep bridge only for explicit fallback branches (compat retry branches).
3. Preserve Anthropic event sequence and event types on passthrough.
4. Add explicit telemetry tags:
   - `stream_mode=passthrough|synthetic_bridge`
   - `synthetic_stream_bridge=true|false`
   - `metering_source`
5. Track bridge ratio per cohort (OpenClaw API-key traffic).

Acceptance target:
- `synthetic_stream_bridge <= 1%` on non-retry happy-path (OpenClaw API-key cohort).

### C2: Tool Execution Parity
Eliminate "silent fetch" behavior by matching direct-Anthropic tool orchestration semantics.

Required:
1. Build direct A/B evidence for the same prompt/tool path:
   - vanilla OpenClaw + Anthropic
   - OpenClaw + Innies
   Compare phase timing and terminal states.
2. Instrument tool lifecycle around URL/repo work with per-run IDs:
   - `tool_start`, `tool_end`, `tool_error`, duration.
3. Fix only the specific divergence proven by A/B traces (no broad runtime redesign).
4. Maintain full tool invocation behavior and observable UX.

Acceptance target:
- For matched prompts in canary window, Innies-only silent gaps `>30s` are `<= 1%` of tool/link turns and must trend to `0` before full rollout.

### C3: Auth/Token Stability for Parity Windows
401 churn during active chats breaks parity perception.

Required:
1. Correlate OpenClaw run errors with `in_token_credentials` status transitions.
2. Add structured auth-failure audit linking runId/requestId/tokenCredentialId.
3. Validate healthcheck/revocation logic does not flap active pool under valid traffic.

Acceptance target:
- `0` unexplained credential-pool collapse incidents during matched test windows.
Definition:
- explained = attributable to explicit operator action, planned rotation, or verified upstream credential invalidation with timestamped evidence.
- unexplained = status flips/revocations without one of the above proofs.

### C4: Retry/Rate-Limit Parity
Intermittent first-attempt `429` with delayed successful retry creates latency spikes that feel worse than direct usage.

Required:
1. Build direct A/B evidence for matched prompts on:
   - vanilla OpenClaw + Anthropic
   - OpenClaw + Innies
2. Verify token routing on `429` is deterministic and avoids hot-spotting one credential.
3. Ensure retry logic is bounded and parity-aligned with direct behavior expectations.
4. Emit structured retry telemetry per attempt:
   - org_id
   - request_id
   - openclaw_run_id (mandatory run correlation key)
   - openclaw_session_id (if available)
   - attempt_no
   - credential_id
   - model
   - upstream_status
   - retry_reason

Acceptance target:
- Retry latency tax at P95 is not worse than direct baseline by more than `+500ms` on matched cohorts.

## Out of Scope
1. Lowering model quality/capability.
2. Disabling tools or link handling by default.
3. Cloudflare bypass exceptions as core fix.
4. New behavior that vanilla OpenClaw does not exhibit.
5. Reliability/perf hardening not tied to a proven parity delta.

## Ingress/SSE Parity Checklist (Validation Only)
Ingress/CDN behavior can confound parity conclusions. For every parity run, record:
1. Response headers include expected SSE transport (`content-type: text/event-stream`, `cache-control: no-cache, no-transform`).
2. No buffering/transformation artifacts observed in first-event timing traces.
3. Hold Innies ingress/CDN policy state constant across all Innies runs in the parity batch.
4. Record direct Anthropic path transport observations separately (no Innies ingress in direct path).
This checklist is a measurement guardrail, not a separate optimization workstream.

## Vanilla Drift Watchlist (Re-check Every Audit)
These are high-impact parity surfaces and must be re-verified each re-audit:

1. OpenClaw Anthropic extra-params/beta/header behavior:
- verify OAuth and default beta injection behavior has not changed unexpectedly.

2. Exact Anthropic SDK version used by OpenClaw:
- verify lockfile/package pin remains identical to baseline parity batch.

3. OpenClaw changelog entries affecting Anthropic auth/beta/tool-streaming:
- re-check for newly introduced behavior changes since last parity run.

4. Innies upstream header preservation contract:
- verify inbound `anthropic-version` / `anthropic-beta` behavior remains parity-aligned.

## Implementation Plan

### Workstream 1: Stream Contract Hardening
Files:
- `api/src/routes/proxy.ts`
- `api/tests/anthropicCompat.route.test.ts`

Tasks:
1. Gate bridge usage to explicit fallback branches.
2. Keep passthrough as default for OpenClaw API-key stream traffic.
3. Add assertions for event ordering/types parity on passthrough.

### Workstream 2: Tool Lifecycle Observability
Files:
- OpenClaw runtime integration surface (where tool/repo actions are dispatched)
- Innies telemetry fields if request metadata is passed through

Tasks:
1. Add structured lifecycle logs with run correlation IDs.
2. Add phase timing breakdown:
   - pre_tool_ms
   - tool_exec_ms
   - post_tool_to_upstream_ms
3. Emit explicit terminal states for each tool invocation.
4. Patch runtime behavior only where traces show Innies-path divergence from vanilla.

### Workstream 3: Auth Churn Correlation
Files:
- `api/src/routes/proxy.ts`
- token credential healthcheck job surfaces

Tasks:
1. Attach request-level token decision data to compat audit logs.
2. Add queries/dashboard snippets for rapid incident triage.
3. Verify revocation/expiry transitions against observed 401 windows.

### Workstream 4: Retry/Rate-Limit Parity
Files:
- `api/src/routes/proxy.ts`
- token routing / repository selection surfaces
- `api/tests/proxy.tokenMode.route.test.ts`

Tasks:
1. Add attempt-level telemetry for every retry decision.
2. Validate credential selection distribution under rate-limit conditions.
3. Patch only parity-divergent retry behavior proven by A/B evidence.

## Test Plan

### Automated
1. Stream parity tests:
   - passthrough branch preserves Anthropic event sequence.
   - bridge branch only when fallback reason is present.
2. Tool-flow tests:
   - simulated URL/repo tool invocation emits start/end/error with durations.
   - no state where tool is active but neither progress nor terminal event is emitted.
3. Auth churn tests:
   - retry behavior with mixed credential pool (active/revoked/limited) remains stable.
4. Rate-limit parity tests:
   - first-attempt 429 behavior and retry path are deterministic.
   - telemetry includes attempt-level decision details.
5. Ingress parity checks:
   - SSE headers and first-event timing collection present for all matched runs.

### Manual (Production-like)
Sample size requirement:
- Minimum `N=100` matched turns total:
  - `N>=30` URL/repo turns
  - `N>=30` non-URL tool turns
  - `N>=40` plain chat turns
- Same agent/session profile across both direct and Innies paths.

1. Replay same OpenClaw-shaped payload to:
   - direct Anthropic
   - Innies
   Compare first event timing and event sequence class.
2. URL/repo prompt runs:
   - run matched prompts on both paths.
   - capture timeline from user send -> first progress signal -> first model token.
   - record any Innies-only stall window.
3. Verify `in_routing_events` and OpenClaw logs align for each incident window.
4. Compare `429` incidence and added latency tax between direct and Innies paths for matched prompts.

## Metrics and SLOs
1. OpenClaw stream happy-path bridge ratio: `<= 1%`.
2. P95 first token (OpenClaw -> Innies) `<= direct baseline + 500ms` on the same matched cohort window.
3. Silent tool window `>30s`: `<= 1%` on matched tool/link turns in canary; target `0` for full rollout.
4. Unexplained auth-failure rate (401 class) in canary: `<= 1 per 100 matched turns`; full rollout target: `0`.
5. Retry latency tax from first-attempt 429: P95 `<= +500ms` versus direct baseline for matched cohorts.

Computation rules (mandatory for all SLOs above):
1. Use one fixed canary batch of `N=100` matched turns (as defined in Manual test plan), not rolling windows.
2. Compute latency percentiles on successful turns only (`upstream_status=200`) for each path.
3. Apply identical filtering rules to direct and Innies cohorts.
4. Include all tool/link turns in silent-gap and auth-failure rate calculations.

## Go/No-Go
Go when all are true:
1. Stream parity tests pass.
2. Tool lifecycle observability meets canary gate (`Innies-only silent gaps >30s <= 1%`) and shows trend to zero.
3. No regression in 401/403/429 behavior beyond known upstream limits.
4. Manual parity run confirms behavior comparable to direct Anthropic for URL/repo workflow.
5. Matched-prompt rate-limit/retry profile is parity-aligned versus direct path.
6. Baseline pin evidence includes exact OpenClaw commit SHA and exact Anthropic SDK version.

Full-rollout promotion gate (after canary):
1. Silent tool gaps `>30s`: `0` in promotion validation batch.
2. Unexplained auth-failure incidents: `0` in promotion validation batch.

## Rollout
1. Deploy behind feature flags for parity instrumentation.
2. Canary on one OpenClaw agent/session.
3. Observe 24 hours.
4. Promote globally if SLOs hold.

## Risks
1. Hidden runtime differences in OpenClaw tool orchestration outside Innies.
2. Upstream Anthropic rate-limit variance masking parity improvements.
3. Cloudflare/network transient effects introducing noise in side-by-side parity runs.
4. Upstream account-level rate-limit variance can mask retry parity improvements.

## Deliverable
A parity evidence bundle with:
1. Before/after event timelines.
2. Stream mode ratio report.
3. Tool lifecycle trace for URL/repo turns.
4. Incident matrix for any remaining silent windows.
5. 401/429 incident correlation report (request-level and credential-level).
