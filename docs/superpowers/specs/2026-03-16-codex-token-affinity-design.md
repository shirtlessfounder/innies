# Codex Token Affinity Design

## Goal

Improve Codex/OpenAI token-mode stability by giving sessions a preferred token when possible, without blocking extra users when all preferred slots are already occupied.

## Problem

The current token-mode routing behavior is still effectively request-by-request. That works poorly for Codex-style workloads, where one ongoing coding run behaves more like a session than a series of unrelated requests.

Today this creates two different failure patterns:

- the first few users may bounce between tokens instead of staying on one
- extra users can pile onto already-busy credentials unpredictably because there is no lightweight session affinity model

The original load-management scope framed this as a strict scheduler problem with queueing and overload rejection. That is not the desired product behavior.

The desired behavior is softer:

- prefer stable token affinity when capacity exists
- never block an extra user just because all preferred slots are taken
- let overflow users continue with current request-by-request routing
- allow overflow users to naturally step into preferred ownership when a token becomes available later

## Scope

In scope:

- Codex/OpenAI token-mode affinity behavior
- a session identifier for token-mode clients
- Postgres-backed preferred-token state
- Postgres-backed active-stream tracking
- routing rules for preferred vs floating sessions
- lifecycle rules for claiming, holding, and clearing preference
- minimal observability for debugging affinity behavior

Out of scope:

- hard queueing
- hard admission rejection because all preferred slots are occupied
- strict one-live-session-per-credential enforcement
- mid-stream migration
- changing provider-plan semantics for unpinned buyer traffic
- seller-mode scheduling
- full Anthropic rollout in v1
- polished dashboard productization

## Applicability

V1 applies to Codex/OpenAI token-mode traffic that supplies a usable session identifier.

This includes:

- `innies codex`
- OpenClaw Codex/OpenAI traffic when it provides session identity that can be mapped into the same canonical concept

V1 does not need to apply to Anthropic traffic yet, but the data model and routing shape should remain provider-agnostic enough to extend later.

## Definitions

### Session

A session is the long-lived logical coding run that should prefer one token when possible.

For CLI traffic:

- one CLI process start creates one session

For non-CLI traffic:

- the caller must provide a session identifier, or Innies falls back to current request-by-request behavior

### Preferred Token

A preferred token is the exact upstream credential Innies should try first for a session when that credential is still healthy, still eligible, and still reserved for that session.

Preference is:

- per exact credential, not just per provider
- local to one org's provider pool
- temporary
- rebuilt naturally after restart

Preference is not exclusivity in the general sense. It is a short-lived first-right claim that protects the token from floating users only while the preferred session is active or still inside the grace window.

### Floating Session

A floating session is a session that does not currently have a preferred token. Its requests use the existing request-by-request routing behavior.

### Active Stream

An active stream is a currently running streaming request. While a preferred session has an active stream on its token, floating users should avoid that token.

### Protected Token

A protected token is a preferred token whose owner is either actively streaming or still inside the grace window.

Protected means “skip this token if another healthy option exists,” not “hard-block all overflow traffic forever.”

### Claimable Token

A claimable token is a healthy token in the current affinity partition that is not actively busy and is not still protected by another session's preference.

In v1, “claimable” effectively means:

- healthy under existing routing rules
- no live active-stream row currently exists for that credential
- not actively protected by another session
- available to become a new preferred token for this session

### Grace Window

After activity ends, the preferred token stays protected for a short configurable grace period. When the grace expires, the token becomes unowned again.

## User-Facing Requirements

- If a session has a healthy and currently eligible preferred token, Innies should keep using it.
- If a streaming request arrives for a session that does not have a preferred token, and a claimable token is available, Innies should claim that token before dispatching the request.
- If no preferred token is available, Innies should not block the user.
- Extra users should continue to work by floating on the existing request-by-request routing path.
- When a preferred token later becomes free, the next floating streaming request can claim it.
- Innies must never switch a request to a different token mid-stream.
- Stickiness should be invisible to normal users; the CLI should generate the session identifier automatically.

## Session Identity

### Canonical Header

`x-innies-session-id` is the canonical session identifier for this feature.

`x-request-id` remains request-scoped. `x-innies-session-id` is the longer-lived affinity/session identity.

### CLI Behavior

`innies codex` should:

- generate one random session ID per CLI process start
- send that same session ID on every request from that process

There is no user-facing session-ID override in v1.

### OpenClaw / Other Clients

The server should accept `x-innies-session-id` as canonical, but also map existing OpenClaw session fields into the same internal concept when present.

### Resolution Contract

Innies should resolve session identity in this order:

1. `x-innies-session-id`
2. `x-openclaw-session-id`
3. `openclaw-session-id`
4. `x-session-id`
5. `metadata.openclaw_session_id`
6. `payload.metadata.openclaw_session_id`

Usable means:

- string value after trimming
- not empty after trimming
- length at or below 256 characters in v1
- preserved exactly after trimming; no case-folding or semantic rewriting

If a candidate value is not usable, ignore it and continue the fallback search.

If no usable session identifier is available:

- do not fail the request
- fall back to current request-by-request routing behavior

## Preferred Ownership Model

### Affinity Boundary

Affinity only applies after Innies has already resolved which upstream provider this request is using.

That means:

- buyer-key provider preference and provider pinning still decide the provider first
- this feature only chooses which credential to use inside that org-scoped resolved provider pool
- in v1, the affinity partition key is `(org_id, provider)`

### Cardinality

- one session can have at most one preferred token per `(org_id, provider)`
- one token can have at most one preferred session per `(org_id, provider)`

### Claim Semantics

Preferred-token claims are atomic Postgres compare-and-set operations, not best-effort hints.

Required claim behavior:

- exactly one session can win a given `(org_id, provider, credential_id)` claim
- a session can hold at most one preferred token per `(org_id, provider)`
- if two requests from the same session race, one may create the preference and the other should re-read session ownership and reuse it when present
- if a request loses a claim race and still has no preferred token after one re-read, it should continue on the floating path for that request
- v1 does not queue, busy-wait, or hold claim retries open

### Protection Rules

If token `T` is preferred by session `S`:

- if `S` is actively streaming on `T`, floating users should skip `T` while another healthy unprotected token exists
- if `S` is no longer actively streaming but is still inside the grace window, floating users should still skip `T` while another healthy unprotected token exists
- if every healthy token is currently protected, floating users may still route on the normal request-by-request path as a last resort
- last-resort floating use of `T` does not transfer or clear preferred ownership
- after grace expires, `T` becomes unowned and claimable again

### Overflow Behavior

If all tokens already have preferred owners:

- do not queue
- do not reject
- do not block
- route extra sessions using the current request-by-request behavior

This means overflow users continue working, but without a preferred token until they happen to claim one later.

If at least one healthy unprotected token exists, floating requests should use that healthier non-protected path first.

If every healthy token is currently protected, floating requests still go through as last-resort spillover on the existing routing path instead of blocking.

## Routing Behavior

### Routing Boundary

This feature sits between provider selection and the existing credential picker.

That boundary is:

- normal provider selection still decides which upstream provider this request is using
- the affinity layer either:
  - forces one exact credential because the session already prefers it
  - claims and then forces one exact credential
  - or hands the existing picker a filtered floating candidate set
- the existing request-by-request picker still chooses within that supplied candidate set and keeps today's health and rotation behavior

Preferred reuse never bypasses normal routing eligibility. A preferred credential is only reusable if it is still inside the current eligible candidate set for that `(org_id, provider)` pool.

For each incoming Codex/OpenAI token-mode request with a usable session ID, after provider selection has already resolved the upstream provider:

1. Check whether the session already has a preferred token in this `(org_id, provider)` partition.
2. If it does, and that token is still healthy, still eligible, and still reserved for the session, route to it.
3. Otherwise, if this request is streaming, look for a claimable token in that same partition.
4. If one exists, claim it for the session before request dispatch, then route to it.
5. Otherwise, route the request using the floating path.

### Initial Assignment

When multiple claimable tokens exist, use the current routing order / rotation logic for v1.

### Floating Requests

Floating requests should continue to use the current request-by-request behavior. There is no fairness queue or waiting list in v1.

Floating path rule for v1:

- first try the existing request-by-request routing logic across healthy unprotected tokens
- if no healthy unprotected token exists, fall back to the existing request-by-request routing logic across all healthy tokens

That fallback is intentional. It preserves the “do not block overflow users” rule even when all preferred owners are currently active or still inside grace.

### Re-entry To Preferred Mode

If a floating session makes a streaming request at a moment when a token is claimable, that request can claim the token before dispatch and the session returns to preferred mode.

The winner is purely opportunistic:

- whichever floating session makes the next request first gets the newly available token

## Streaming vs Non-Streaming

Streaming activity drives preference protection.

Innies should classify streaming after ingress normalization, not from client flavor alone.

Rules:

- wrapped proxy requests use the normalized `streaming` boolean
- Anthropic-native requests are streaming when `stream === true`
- OpenAI Responses-native requests are streaming unless `stream === false`
- streaming requests can create preferred ownership
- any routed streaming request creates active-stream busy state for that credential while it is live
- streaming requests mark the token as actively busy
- non-streaming requests may reuse an existing preferred token
- non-streaming requests should refresh the grace timer if they use the preferred token
- non-streaming requests do not create first-time preferred ownership when no preferred assignment already exists

## Concurrent Requests From The Same Session

If the same session sends overlapping requests:

- if it already has a preferred token, overlapping requests from that same session may use that same preferred token
- active-stream state is tracked per request
- token protection stays active while at least one active-stream row still exists for that session and credential
- grace starts only after the last active-stream row for that preferred token ends

V1 does not need extra anti-fanout logic for same-session overlap.

## Lifecycle Rules

### On Request Start

- if preferred token exists and is valid, use it
- else if this is a streaming request and a claimable token exists, claim it before dispatch
- else route as floating

### On Stream Start

- record active-stream state for the routed request and credential
- active-stream rows are created for preferred-owner streams and for floating spillover streams
- recording busy state for a floating spillover stream does not create preferred ownership by itself

### While Stream Is Open

- refresh active-stream freshness from stream activity or a lightweight heartbeat

### On Claimed Request Failure Before First Successful Use

- if a request claims preference but fails before stream start, clear that newly created preference immediately
- if a future non-streaming claim path is ever added, the same rule applies until it reaches a successful terminal response
- do not start grace for a claim that never reached successful use

### On Normal Stream Completion

- clear that request's active-stream state
- if the completed stream belonged to the preferred owner of that credential, start or refresh the grace window
- if the completed stream was floating spillover, do not create or refresh preferred grace

### On Successful Non-Streaming Request Against Preferred Token

- refresh the grace window

### On Transport / Stream Breakage

- clear that request's active-stream state
- if the broken stream belonged to the preferred owner of that credential, drop preferred ownership for that session
- if the broken stream was floating spillover, do not clear another session's preferred ownership

Transport / stream breakage includes cases like:

- upstream reset before terminal event
- downstream disconnect handling that should end ownership
- truncated stream behavior that indicates this token should no longer be treated as preferred for the next request

### On Provider / API Failure

Do not create a second competing health model here.

Instead:

- `401/403/429` and similar provider/API failures continue to use existing credential health logic
- if that existing logic makes the token unhealthy or unusable, preferred ownership should no longer be treated as valid for future requests

### On Grace Expiry

- clear preferred ownership
- token becomes unowned again

### On Active-Stream Freshness Expiry

- treat stale active-stream state as abandoned stream breakage
- clear the stale active-stream row
- if the stale row belonged to the preferred owner of that credential, also clear preferred ownership for that session and credential
- do not preserve protection beyond stale expiry unless a fresh request rebuilds it

### On Process Restart

V1 does not need perfect recovery of in-flight streams across restart.

Instead:

- preferred-assignment and active-stream rows remain Postgres-backed state
- active-stream protection is only honored while its freshness signal is still valid
- stale active-stream rows can age out quickly and stop protecting the token
- sessions may rebuild preference naturally on later requests after restart or crash cleanup

## Data Model

V1 should use Postgres-backed state, not process memory.

The design needs two distinct kinds of state:

### Preferred Assignment State

Purpose:

- answer “who currently has first claim on this token?”

Suggested fields:

- `org_id`
- `provider`
- `credential_id`
- `session_id`
- `last_activity_at`
- `grace_expires_at`
- `created_at`
- `updated_at`

Required invariants:

- one preferred assignment per `(org_id, provider, credential_id)`
- one preferred assignment per `(org_id, provider, session_id)`

In v1, `(org_id, provider)` is the full affinity-partition key because affinity only chooses a credential inside one org's already-resolved provider pool.

### Active Stream State

Purpose:

- answer “is this credential actively busy right now?”

Suggested fields:

- `org_id`
- `provider`
- `credential_id`
- `session_id`
- `request_id`
- `started_at`
- `last_touched_at`
- `ended_at`

Required behavior:

- active state should be cheap to create and clear
- active state should expire quickly if the stream dies or the process crashes
- active state should use `last_touched_at` plus a short configurable stale threshold
- stale active rows may be cleared by opportunistic cleanup during reads/claims and/or a lightweight background sweeper

Recommended starting values:

- grace window: about 5 seconds
- active-stream stale threshold: about 30 seconds

In v1, active-stream rows use the same `(org_id, provider)` affinity partition as preferred assignments.

## Health Interaction

Existing token health remains canonical for provider/API-side failures.

This feature should not replace:

- `status`
- `rate_limited_until`
- maxing behavior
- existing provider health exclusion logic

Instead, affinity validity should be layered on top:

- if a preferred token is still healthy, still reserved, and still eligible in the current routing candidate set, use it
- if it becomes unhealthy/unusable under existing rules, stop treating it as preferred

## Observability

V1 should expose minimal but truthful debug visibility.

Affinity visibility should live in a dedicated routing-metadata object, not overload existing provider-selection reason fields.

Suggested shape:

- `routeDecision.affinity.mode`
- `routeDecision.affinity.reason`
- `routeDecision.affinity.sessionIdPresent`
- `routeDecision.affinity.partitionKey`
- `routeDecision.affinity.preferredCredentialId`

Need to see:

- which session currently prefers which token
- which tokens are actively busy
- which sessions are floating on each routing event
- when a preference was claimed
- when a preference was cleared and why

Suggested routing/debug reasons:

- `preferred_token_reused`
- `preferred_token_claimed`
- `preferred_token_unavailable_floating`
- `preferred_token_protected_spillover`
- `preferred_token_cleared_transport_failure`
- `preferred_token_cleared_health_invalid`
- `preferred_token_expired`

This visibility can begin as logs and routing-event metadata, with fuller dashboard work later.

V1 does not need a separate durable floating-session table. Floating visibility can come from routing-event logs and debug metadata.

## Non-Goals

V1 should not attempt:

- hard concurrency admission control
- queueing before floating
- hard overload rejection because preferred slots are occupied
- fairness queues for floating users
- mid-stream reassignment
- durable ownership recovery across restart
- full cross-provider scheduling redesign
- Anthropic rollout in the first release

## Why This Supersedes The Existing Load-Management Scope

The earlier load-management framing assumed the product should:

- give each live session a hard slot
- queue when full
- reject clearly when no slot frees up

That is not the intended UX.

The intended UX is:

- give stable affinity when possible
- protect active and recently-active preferred sessions briefly
- let extra users continue via current routing behavior instead of blocking them

This design therefore supersedes the strict queue/rejection model for the Codex-first v1 implementation.

## Rollout Shape

Recommended rollout order:

1. Add canonical session identity plumbing.
2. Add Postgres-backed preferred-assignment and active-stream state.
3. Wire Codex/OpenAI token-mode routing to:
   - reuse preferred token
   - claim a token on first streaming assignment
   - float otherwise
4. Add lifecycle cleanup on completion, breakage, health invalidation, and grace expiry.
5. Add minimal debug visibility.
6. Canary on Codex/OpenAI traffic with both CLI and OpenClaw session IDs.

## Verification Requirements

Implementation is complete only if all of the following are true:

1. `innies codex` emits one stable session ID per CLI process.
2. The API accepts `x-innies-session-id` as canonical and maps OpenClaw session identity into the same concept.
3. A session with a healthy preferred token reuses it on subsequent requests.
4. A streaming request without a preferred token claims a claimable token before dispatch when one is available.
5. A non-streaming request without a preferred token stays floating instead of creating first-time preference.
6. When no claimable token is available, the session continues via floating request-by-request routing instead of blocking.
7. Floating routing prefers healthy unprotected tokens first, but still has a last-resort spillover path when every healthy token is currently protected.
8. After grace expiry, the token becomes claimable again.
9. Transport/stream breakage clears preferred ownership for future requests.
10. Existing provider/API health logic still determines token health and eligibility.
11. Minimal debug output can explain why a request reused, claimed, floated, spilled over, or lost preference.

## Open Questions

None.
