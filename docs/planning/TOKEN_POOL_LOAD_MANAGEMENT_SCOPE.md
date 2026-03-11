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
- Routing eligibility from [api/src/repos/tokenCredentialRepository.ts](../../api/src/repos/tokenCredentialRepository.ts) filters by status, expiry, and monthly contribution limits only.
- `innies codex` already injects a stable `x-request-id` per wrapped process via [cli/src/commands/codex.js](../../cli/src/commands/codex.js), so one Codex session is already pseudo-sticky.
- [api/src/services/orgQueue.ts](../../api/src/services/orgQueue.ts) exists, but it is not wired into token-mode runtime in [api/src/services/runtime.ts](../../api/src/services/runtime.ts).
- The production issue is no longer just "bad truncation handling"; it is also "too many concurrent long-lived streams sharing one credential."

## Product / Runtime Decisions
- The placement unit is the active session / live stream, not the user.
- A new session gets a sticky lease to one credential for the session lifetime or TTL.
- Default `max_live_streams_per_credential = 1` for OpenAI/Codex token-mode streaming in v1.
- No mid-session credential migration in v1.
- New sessions should route to the healthiest least-loaded credential, not request-id rotation.
- If every healthy credential is at cap, Innies should wait briefly for capacity, then fail clearly with retry guidance instead of silently over-admitting.
- Credentials that hit `429`, auth failures, or stream truncation should enter a cooldown window before new assignments.
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
- reuse the existing CLI `x-request-id` as the session key for `innies codex`
- if token-mode callers later need multiple independent streams inside one wrapper session, add an explicit `x-innies-session-id`

Non-goal for v1:
- redesign the full request-id/correlation model for every client

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
- if all healthy credentials are full, wait briefly for a slot
- if the wait budget expires, return an explicit capacity error with retry guidance and `Retry-After`

Design constraint:
- queueing is only to smooth brief overlap and release races
- queueing is not a substitute for unbounded concurrency

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
- upstream `429`
- auth failure / invalid session state
- repeated mid-stream truncation
- repeated transport resets before terminal event

Required behavior:
- prevent immediate reassignment to a hot/bad credential
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
