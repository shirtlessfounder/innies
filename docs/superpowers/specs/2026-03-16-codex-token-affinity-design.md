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

A preferred token is the exact upstream credential Innies should try first for a session when that credential is still healthy and still reserved for that session.

Preference is:

- per exact credential, not just per provider
- provider-local
- temporary
- rebuilt naturally after restart

Preference is not exclusivity in the general sense. It is a short-lived first-right claim that protects the token from floating users only while the preferred session is active or still inside the grace window.

### Floating Session

A floating session is a session that does not currently have a preferred token. Its requests use the existing request-by-request routing behavior.

### Active Stream

An active stream is a currently running streaming request. While a preferred session has an active stream on its token, floating users should avoid that token.

### Grace Window

After activity ends, the preferred token stays protected for a short configurable grace period. When the grace expires, the token becomes unowned again.

## User-Facing Requirements

- If a session has a healthy preferred token, Innies should keep using it.
- If a session does not have a preferred token and an unowned token is available, Innies should claim that token before dispatching the request.
- If no preferred token is available, Innies should not block the user.
- Extra users should continue to work by floating on the existing request-by-request routing path.
- When a preferred token later becomes free, the next floating request can claim it.
- Innies must never switch a request to a different token mid-stream.
- Stickiness should be invisible to normal users; the CLI should generate the session identifier automatically.

## Session Identity

### Canonical Header

`x-innies-session-id` is the canonical session identifier for this feature.

### CLI Behavior

`innies codex` should:

- generate one random session ID per CLI process start
- send that same session ID on every request from that process

There is no user-facing session-ID override in v1.

### OpenClaw / Other Clients

The server should accept `x-innies-session-id` as canonical, but also map existing OpenClaw session fields into the same internal concept when present.

If no usable session identifier is available:

- do not fail the request
- fall back to current request-by-request routing behavior

## Preferred Ownership Model

### Cardinality

- one session can have at most one preferred token per provider lane
- one token can have at most one preferred session per provider lane

### Protection Rules

If token `T` is preferred by session `S`:

- if `S` is actively streaming on `T`, floating users must not use `T`
- if `S` is no longer actively streaming but is still inside the grace window, floating users must still not use `T`
- after grace expires, `T` becomes unowned and claimable again

### Overflow Behavior

If all tokens already have preferred owners:

- do not queue
- do not reject
- do not block
- route extra sessions using the current request-by-request behavior

This means overflow users continue working, but without a preferred token until they happen to claim one later.

## Routing Behavior

For each incoming Codex/OpenAI token-mode request with a usable session ID:

1. Check whether the session already has a preferred token for this provider.
2. If it does, and that token is still healthy and still reserved for the session, route to it.
3. Otherwise, look for an unowned token that is currently claimable.
4. If one exists, claim it for the session before request dispatch, then route to it.
5. If none exists, route the request using the existing request-by-request behavior.

### Initial Assignment

When multiple claimable tokens exist, use the current routing order / rotation logic for v1.

### Floating Requests

Floating requests should continue to use the current request-by-request behavior. There is no fairness queue or waiting list in v1.

### Re-entry To Preferred Mode

If a floating session makes a request at a moment when a token is claimable, that request can claim the token before dispatch and the session returns to preferred mode.

The winner is purely opportunistic:

- whichever floating session makes the next request first gets the newly available token

## Streaming vs Non-Streaming

Streaming activity drives preference protection.

Rules:

- streaming requests can create preferred ownership
- streaming requests mark the token as actively busy
- non-streaming requests may reuse an existing preferred token
- non-streaming requests should refresh the grace timer if they use the preferred token
- non-streaming requests do not need to create the entire affinity mechanism by themselves when no preferred assignment exists

## Concurrent Requests From The Same Session

If the same session sends overlapping requests:

- if it already has a preferred token, overlapping requests from that same session may use that same preferred token

V1 does not need extra anti-fanout logic for same-session overlap.

## Lifecycle Rules

### On Request Start

- if preferred token exists and is valid, use it
- else if a claimable token exists, claim it before dispatch
- else route as floating

### On Stream Start

- record active-stream state for the preferred session and credential

### On Normal Stream Completion

- clear active-stream state
- start or refresh the grace window

### On Successful Non-Streaming Request Against Preferred Token

- refresh the grace window

### On Transport / Stream Breakage

- clear active-stream state
- drop preferred ownership for that session

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

### On Process Restart

It is acceptable in v1 for preferred ownership and active-stream state to disappear and rebuild naturally from future requests.

## Data Model

V1 should use Postgres-backed state, not process memory.

The design needs two distinct kinds of state:

### Preferred Assignment State

Purpose:

- answer “who currently has first claim on this token?”

Suggested fields:

- `provider`
- `credential_id`
- `session_id`
- `state`
- `last_activity_at`
- `grace_expires_at`
- `created_at`
- `updated_at`

Required invariants:

- one preferred assignment per `(provider, credential_id)`
- one preferred assignment per `(provider, session_id)`

### Active Stream State

Purpose:

- answer “is this preferred token actively busy right now?”

Suggested fields:

- `provider`
- `credential_id`
- `session_id`
- `request_id`
- `state`
- `started_at`
- `last_touched_at`
- `ended_at`

Required behavior:

- active state should be cheap to create and clear
- active state should expire quickly if the stream dies or the process crashes

## Health Interaction

Existing token health remains canonical for provider/API-side failures.

This feature should not replace:

- `status`
- `rate_limited_until`
- maxing behavior
- existing provider health exclusion logic

Instead, affinity validity should be layered on top:

- if a preferred token is still healthy and still reserved, use it
- if it becomes unhealthy/unusable under existing rules, stop treating it as preferred

## Observability

V1 should expose minimal but truthful debug visibility.

Need to see:

- which session currently prefers which token
- which tokens are actively busy
- which sessions are floating
- when a preference was claimed
- when a preference was cleared and why

Suggested routing/debug reasons:

- `preferred_token_reused`
- `preferred_token_claimed`
- `preferred_token_unavailable_floating`
- `preferred_token_cleared_transport_failure`
- `preferred_token_cleared_health_invalid`
- `preferred_token_expired`

This visibility can begin as logs and routing-event metadata, with fuller dashboard work later.

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
   - claim unowned token
   - float otherwise
4. Add lifecycle cleanup on completion, breakage, health invalidation, and grace expiry.
5. Add minimal debug visibility.
6. Canary on Codex/OpenAI traffic with both CLI and OpenClaw session IDs.

## Verification Requirements

Implementation is complete only if all of the following are true:

1. `innies codex` emits one stable session ID per CLI process.
2. The API accepts `x-innies-session-id` as canonical and maps OpenClaw session identity into the same concept.
3. A session with a healthy preferred token reuses it on subsequent requests.
4. A session without a preferred token claims an unowned token before dispatch when one is available.
5. When no unowned token is available, the session continues via floating request-by-request routing instead of blocking.
6. A token with an active preferred stream is not used by floating requests.
7. A token inside the preferred owner’s grace window is not used by floating requests.
8. After grace expiry, the token becomes claimable again.
9. Transport/stream breakage clears preferred ownership for future requests.
10. Existing provider/API health logic still determines token health and eligibility.
11. Minimal debug output can explain why a request reused, claimed, floated, or lost preference.

## Open Questions

None.
