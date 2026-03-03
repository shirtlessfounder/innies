# OpenClaw Latency Scope (No UX/Fidelity Regressions)

## Goal
Reduce time from user send -> first visible token when OpenClaw uses Innies, without changing OpenClaw UX semantics or model fidelity.

Success metrics:
- Median `first_byte_ms` reduced by >=25% vs baseline.
- P95 `first_byte_ms` reduced by >=20%.
- No regression in stream contract correctness.
- No regression in auth/blocked/error class rates.

## Hard Invariants
1. `stream=true` success responses must always be Anthropic-compatible SSE (`text/event-stream`), never JSON.
2. Existing compat behavior must remain intact:
   - OAuth-safe normalization paths
   - 401/403 retry/fallback behavior
   - Anthropic header passthrough rules
3. No Cloudflare exceptions/rule relaxations for this project.
4. No OpenClaw source-code modifications.

## Non-Goals
- No model switching.
- No prompt-quality degradation.
- No fidelity-reducing truncation strategy.

## Current Bottlenecks (from incident evidence)
1. Some requests run in `synthetic_stream_bridge` mode.
2. Hot-path synchronous work (logging/writes) can delay first byte.
3. Potential connection setup overhead may recur (must be measured first).
4. Large OpenClaw request payloads/history materially increase latency.
5. Ingress/proxy transport behavior can dominate perceived first-byte if buffering/timeouts are wrong.

## Scope: Technical Work Items

## 1) Stream Contract and Passthrough/Bridge Behavior (Priority)
Objective:
- Enforce deterministic stream contract and minimize bridge overhead on happy path.

Plan:
- Prefer upstream true SSE passthrough for `stream=true` where supported.
- Keep JSON->SSE bridge as fallback branch only.
- Define explicit retry/bridge interaction:
  - If OAuth-safe retry requires non-stream upstream, server must bridge to Anthropic SSE before client response.
  - Anthropic event sequence must remain valid in both passthrough and bridge modes.
- Add metric fields:
  - `stream_mode: passthrough|synthetic_bridge`
  - `synthetic_stream_bridge: boolean`
  - `metering_source: payload_usage|stream_usage|stream_estimate`

Metering source mapping (required):
- Passthrough stream with upstream usage frames present -> `stream_usage`
- Passthrough stream without usage frames -> `stream_estimate`
- Synthetic bridge from non-stream upstream JSON with usage -> `payload_usage`
- Synthetic bridge from non-stream upstream JSON without usage -> `stream_estimate`
- Retry case: use metering source from the winning attempt only; failed attempts must not create billable usage entries.

Acceptance:
- `stream=true` success always returns SSE in automated tests.
- Both passthrough and bridged branches pass stream contract tests.
- Synthetic bridge ratio target measured by cohort:
  - Happy-path cohort target (<10%)
  - Retry cohort tracked separately (informational, not same threshold)

## 2) First-Byte Critical Path + Write Durability Split
Objective:
- Move non-critical work after first byte without risking billing/security correctness.

Plan:
- Critical pre-first-byte writes (must remain sync):
  - auth/org decision artifacts required for security
  - idempotency decision state required for correctness
  - minimum routing record fields required for audit linkage (`request_id`, org, selected credential, initial route context)
- Async/post-first-byte allowed work:
  - verbose request-shape logs
  - non-critical enrichments
  - secondary analytics and derived usage rollups
- Add async retry for deferred writes keyed by `request_id`.

Acceptance:
- First byte can emit even if async enrichment path is delayed/failing.
- No data-loss/regression for required billing/security records.

## 3) Connection Reuse (Measure-First)
Objective:
- Reduce connect/setup overhead only if it is a proven contributor.

Plan:
- First measure:
  - `upstream_connect_ms` distribution
  - connection reuse ratio
- Only if setup cost is material, tune/standardize keep-alive pooling settings.
- Track reset/error deltas after tuning.

Acceptance:
- Connection tuning ships only with evidence of ROI.
- No regression in upstream network error rates.

## 4) Hot-Path Processing Reduction (No Security/Compat Regression)
Objective:
- Remove avoidable pre-upstream overhead while preserving required checks.

Plan:
- Classify pre-forward work:
  - required: auth, org scope, token route, required compat normalization.
  - deferrable: verbose logs, non-critical enrichments.
- Ensure parse/normalize executes once (no duplicate heavy transforms).
- Keep guardrails for payload correctness; do not drop required compat checks.

Acceptance:
- Reduced pre-upstream latency with no auth/compat/security regressions.

## 5) Ingress/Proxy Transport Requirements (Required)
Objective:
- Ensure app optimizations are not masked by SSE buffering/timeout misconfig.

Required transport settings for `/v1/messages` SSE path:
- buffering disabled
- long read/send timeouts suitable for long streams
- chunked transfer preserved
- no response transformation for SSE
- no compression/transcoding that delays chunk flush for SSE

Acceptance:
- Verified ingress config checklist in staging/prod-like env.
- No added first-byte delay from proxy buffering.

## 6) Payload/Context Guardrails (Fidelity-Safe)
Objective:
- Prevent pathological latency from unbounded payload size while preserving answer quality.

Plan:
- Add explicit guardrails and deterministic behavior:
  - max request bytes limit
  - max message-count limit
- Behavior on exceed:
  - deterministic error response (do not silently truncate content)
  - clear error code/message so caller can compact/retry intentionally

Acceptance:
- Large-payload requests fail deterministically when over limit.
- No silent truncation path introduced.

## Observability Schema (Fixed)
Required per-request structured fields (bounded cardinality where applicable):
- `request_id`
- `org_id`
- `credential_id`
- `upstream_status`
- `error_type`
- `stream_mode`
- `synthetic_stream_bridge`
- `pre_upstream_ms`
- `upstream_ttfb_ms`
- `bridge_build_ms` (bridge only)
- `post_stream_write_ms`

Timing boundary definitions (mandatory):
- `pre_upstream_ms`: request admitted -> upstream request dispatch start.
- `upstream_ttfb_ms`: emitted per attempt (`attempt_no` scoped) from upstream dispatch start -> first upstream byte received; expose aggregate request-level winner metric separately if needed.
- `bridge_build_ms`: first upstream byte received -> first downstream SSE byte written (bridge branch only).
- `post_stream_write_ms`: first downstream SSE byte written -> stream completion/termination.
For passthrough branch: `bridge_build_ms = null`.

## Benchmark and Load-Test Plan
Baseline before changes:
- >=100 real OpenClaw requests.
- Record all schema fields above.

Realistic load profile (must match OpenClaw shape):
- `stream=true`
- tools present
- `anthropic-beta` present
- thinking on/off cohorts
- high message counts / large bodies
- burst/concurrency representative of production usage

Compare after each change:
- Median/P95 `first_byte_ms`
- stage timing deltas
- stream parse failure rate
- blocked/auth/timeout rate deltas

## Error Budgets and Regression Limits
- No increase in timeout rate.
- No regression in `401` rate from compat normalization paths.
- No regression in blocked `403` rate baseline (do not require absolute zero).
- No increase in OpenClaw-side stream parse failures.

## Idempotency + Streaming Abort Semantics
- For compat endpoint on streaming path when `Idempotency-Key` is present:
  - partial stream + reconnect with same key remains deterministic non-replay behavior (`409 proxy_replay_not_supported`), unless explicit replay support is designed later.
- When `Idempotency-Key` is missing:
  - no replay contract/persistence guarantee.
- Documented to avoid replay ambiguity.

## Rollout Strategy (Technical)
- Feature flags per work item.
- Canary org first.
- Gate on metrics and error budgets, not anecdotal success.
- Sequence may vary by implementation constraints, but item 1 and item 5 are mandatory before declaring latency work complete.

## Test Plan
Required automated:
1. `stream=true` success never returns JSON.
2. Passthrough branch stream contract tests.
3. Bridge branch stream contract tests.
4. OAuth retry -> bridge path preserves Anthropic event sequence.
5. Async deferred-write failures do not block first byte.
6. Compat normalization/headers regression tests unchanged.
7. Idempotency streaming abort behavior deterministic (`409`) for duplicates.

Required manual:
1. OpenClaw realistic session (tools + stream + long history).
2. Validate no regression in blocked/auth/timeout rates.
3. Validate required billing/security records still present.
4. Validate ingress settings checklist is applied and effective.

## Exit Criteria
- Latency targets met on canary with realistic OpenClaw traffic.
- Error budgets all green.
- Stream contract invariants green.
- No user-visible OpenClaw behavior change except faster response start.
