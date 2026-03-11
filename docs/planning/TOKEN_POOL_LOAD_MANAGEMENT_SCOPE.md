# Token Pool Load Management Scope

Date: 2026-03-11

## Objective
Ship a shared-capacity scheduler for token-mode streams that prevents pooled OAuth/session credentials from being overloaded by concurrent long-lived coding sessions.

Success means:
- materially fewer `Stream disconnected before completion` failures during concurrent Codex usage
- no random mid-session credential switching
- explicit overload behavior (short wait or clear rejection), not ambiguous truncated streams
- routing, health, and metering distinguish admitted/completed streams from rejected or truncated ones

## Problem Statement
- The recent live-SSE passthrough fixes address stream truncation handling, but they do not solve credential contention.
- Current token credential routing is request-seeded rotation, not load-aware placement.
- Codex sessions are long-lived, bursty, and uneven; simple rotation is the wrong scheduler for this workload.
- Multiple active agents can land on the same upstream credential and compete for the same upstream session/rate bucket, causing reconnects, 429s, auth churn, or mid-stream resets.

## Current State (2026-03-11)
- Token credential ordering is request-id rotation via [api/src/routes/proxy.ts](../../api/src/routes/proxy.ts).
- Routing eligibility from [api/src/repos/tokenCredentialRepository.ts](../../api/src/repos/tokenCredentialRepository.ts) already filters by status, expiry, `rate_limited_until`, and monthly contribution limits.
- `innies codex` already injects a stable `x-request-id` per wrapped process via [cli/src/commands/codex.js](../../cli/src/commands/codex.js), so one Codex session is already pseudo-sticky.
- `request_id` is still treated as request identity throughout routing events, request log, idempotency, and usage metering; there is not yet a distinct lease/session identifier for token-mode routing.
- Existing credential health/cooldown state already exists for provider-side failures:
  - `rate_limited_until` exclusion during routing
  - 429 cooldown / auto-maxing
  - consecutive failure auto-maxing
- [api/src/services/orgQueue.ts](../../api/src/services/orgQueue.ts) exists, but it is not wired into token-mode runtime in [api/src/services/runtime.ts](../../api/src/services/runtime.ts).
- The production issue is no longer just "bad truncation handling"; it is also "too many concurrent long-lived streams sharing one credential."

## Product / Runtime Decisions
- The placement unit is the active session / live stream, not the user.
- `request_id` remains request identity for logs, idempotency, and metering. Session affinity must use a distinct session key.
- A new session gets a sticky lease to one credential for the session lifetime or TTL.
- Default `max_live_streams_per_credential = 1` for OpenAI/Codex token-mode streaming in v1.
- No mid-session credential migration in v1.
- New sessions should route to the healthiest least-loaded credential, not request-id rotation.
- Preserve current provider-plan semantics for unpinned buyer traffic:
  - if preferred provider has no immediate admissible slot, try the alternate provider immediately
  - only queue/reject after no provider in the plan can admit the request
  - pinned traffic queues/rejects only within its pinned provider lane
- If every admissible provider in the plan is full, Innies should wait briefly for capacity, then fail clearly with retry guidance instead of silently over-admitting.
- Existing credential health remains canonical for provider/API-side failures (`401/403/429`, `rate_limited_until`, `maxed`). Scheduler-local cooldowns are only for transport/stream-level instability not already represented by current credential state.
- Shared admission state must live outside process memory. Postgres-backed state is the default v1 choice because Innies already depends on Postgres.
- The architecture should be provider-agnostic, but rollout priority is OpenAI/Codex token-mode streams first because that is the current user-facing incident.

## V1 Scope

### 1. Shared Lease State
Add a DB-backed lease table for active token-mode streams.

Suggested shape:
- `lease_id`
- `org_id`
- `provider`
- `credential_id`
- `session_id`
- `request_id`
- `status` (`active|released|expired|failed`)
- `acquired_at`
- `heartbeat_at`
- `expires_at`
- `released_at`
- `failure_reason`

Required behavior:
- exactly one active lease per live session
- cheap lookup by `session_id`
- cheap active-count lookup by `credential_id`
- TTL expiry for crashed workers / dropped processes

### 2. Session Identity
Use session-level affinity, not per-user pinning.

V1 rule:
- introduce a distinct `session_id` / lease key instead of reusing `request_id`
- wrappers should send `x-innies-session-id`
- OpenClaw traffic should use `x-openclaw-session-id` / `openclaw_session_id` when present
- if a caller does not provide a session identifier, treat the request as a one-request ephemeral session with no lease reuse guarantee

Non-goal for v1:
- redesign every request/correlation field in the system

### 3. Load-Aware Credential Selection
Replace request-id rotation for token-mode streaming with lease-aware placement.

Required behavior:
- if a session already has an active lease, reuse that credential
- otherwise choose the healthiest credential with the lowest active-stream count
- tie-break by existing health / rotation ordering
- skip credentials in cooldown
- reject or queue instead of exceeding the live-stream cap

Recommended scheduler:
- full least-loaded scan for current small pools
- optional future upgrade to power-of-two-choices if pool size grows materially

### 4. Admission Control and Short Queue
Add a short queue in front of credential admission.

V1 behavior:
- if a credential slot is immediately available, admit the stream
- for unpinned traffic, preserve the current provider plan:
  - try the preferred provider first
  - if preferred has no immediate admissible slot, try the alternate provider immediately
  - only queue once no provider in the plan can admit immediately
- for pinned traffic, queue only within the pinned provider lane
- if every admissible provider is full, wait briefly for a slot
- if the wait budget expires, return an explicit capacity error with retry guidance and `Retry-After`

Design constraint:
- queueing is only to smooth brief overlap and release races
- queueing is not a substitute for unbounded concurrency
- queueing must not silently replace today's immediate cross-provider fallback contract for unpinned buyer traffic

### 5. Stream Lifecycle Integration
Tie leases to the actual lifetime of the downstream stream.

Required behavior:
- acquire lease before upstream stream dispatch
- heartbeat while the stream remains active
- release on normal terminal stream completion
- release on downstream disconnect
- release on upstream truncation / synthetic terminal failure path
- do not meter a truncated stream as a normal success

Primary code areas:
- [api/src/routes/proxy.ts](../../api/src/routes/proxy.ts)
- [api/src/utils/openaiSyntheticStream.ts](../../api/src/utils/openaiSyntheticStream.ts)

### 6. Credential Cooldowns and Penalties
Add cooldown-aware health penalties for credentials that misbehave under load.

Penalty triggers:
- repeated mid-stream truncation
- repeated transport resets before terminal event
- other transport-level churn that is not already represented by current credential health state

Required behavior:
- keep existing credential health state canonical for provider/API failures:
  - `401/403/429` continue through current credential failure / cooldown / maxing logic
  - `rate_limited_until` and `maxed` stay authoritative for eligibility
- use a separate short-lived scheduler/admission cooldown for stream/transport instability
- prevent immediate reassignment to a hot/bad credential after scheduler-level transport failures
- back off more aggressively for repeated failures
- keep cooldown decisions observable in routing events and admin views

### 7. Observability and Admin Visibility
Expose enough state to debug capacity and imbalance directly.

Need visibility into:
- active streams per credential
- queued streams per org/provider
- average queue wait
- lease reuse vs new assignment
- admission rejects
- cooldown state and recent penalty reason
- stream truncation rate by credential

Suggested event/reason additions:
- `lease_reused`
- `lease_assigned`
- `capacity_queued`
- `capacity_rejected`
- `credential_cooldown`
- `stream_truncated`

### 8. Tests and Validation
Add coverage for concurrency and crashy stream lifecycle behavior.

Required tests:
- two concurrent sessions prefer different credentials when capacity exists
- repeated requests from the same session reuse the same credential
- queue wait succeeds when a lease releases within budget
- queue wait fails cleanly when no slot frees up
- expired leases are reclaimed after crash/no-heartbeat
- truncated streams release capacity and are not metered as plain successes
- cooldowned credentials are skipped for new admission

Manual validation:
- run multiple simultaneous `innies codex` sessions against a small token pool
- verify slot spreading, queueing, rejection, and recovery after release
- verify no random mid-session credential change

## Out of Scope
- per-user hard sharding of credentials
- cross-provider routing redesign
- seller-mode capacity scheduling
- predictive capacity modeling / demand forecasting
- live migration of already-running sessions
- raising per-credential concurrency above `1` by default in v1

## Recommended V1 Defaults
Starting defaults, subject to tuning after canary data:
- `max_live_streams_per_credential = 1`
- `max_queue_wait_ms = 3000`
- `lease_heartbeat_ms = 5000`
- `lease_ttl_ms = 15000`
- `cooldown_truncation_ms = 15000`
- `cooldown_429_ms = 30000`

## Implementation Shape
Expected work areas:
- new migration for lease state
- new repository/service for lease acquisition, heartbeat, release, and expiry cleanup
- wrapper/header changes to send a distinct `x-innies-session-id` for provider-pinned CLI sessions
- token-mode routing changes in [api/src/routes/proxy.ts](../../api/src/routes/proxy.ts)
- runtime wiring in [api/src/services/runtime.ts](../../api/src/services/runtime.ts)
- optional admin/debug read endpoint for live capacity state
- regression tests in `api/tests/proxy.tokenMode.route.test.ts` and new lease/service tests

Suggested new modules:
- `api/src/repos/tokenCredentialLeaseRepository.ts`
- `api/src/services/tokenCredentialScheduler.ts`

## Rollout Plan
1. Land migration + lease repository/service.
2. Wire token-mode OpenAI/Codex streaming through lease-aware admission behind a feature flag.
3. Add admin/debug visibility for live lease counts and queue state.
4. Canary against internal Codex usage with a deliberately small pool.
5. Tune queue/cooldown defaults from real concurrent-session data.
6. Enable by default for token-mode OpenAI/Codex streams.
7. Evaluate extending the same scheduler to other token-mode provider lanes.

## Definition Of Done
- Concurrent Codex sessions spread across available credentials instead of piling onto one by request-id rotation.
- When the pool is full, users see short queueing or a clear capacity rejection instead of ambiguous reconnect churn.
- Active streams keep stable credential affinity for their lifetime.
- Truncated streams release capacity promptly and do not look like plain routing successes in analytics.
- Operators can inspect live per-credential load and recent admission/cooldown decisions without reading raw logs.
