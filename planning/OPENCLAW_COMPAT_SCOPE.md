# OpenClaw Compatibility Scope (Innies)

## Goal
Make `https://api.innies.computer` behave as an Anthropic-compatible base URL for OpenClaw (serving `POST /v1/messages`) with production-grade reliability.

Primary success condition:
- OpenClaw can use Innies as its Anthropic base URL with no special payload wrappers.
- Canonical OpenClaw Anthropic base URL guidance: `https://api.innies.computer` (no trailing `/v1`).
- Compatibility note: clients that provide `/v1` may still work if normalized; document and test this explicitly.

Scope boundary note:
- This scope is technical compatibility only.
- Policy/legal/provider-terms analysis is explicitly out of scope for this document.

## Why this matters
Innies is only valuable if it is a drop-in path for existing agent workflows. OpenClaw is your live control point. If protocol compatibility is partial, adoption friction kills throughput and invalidates the pooling thesis.

## Current state (as of March 3, 2026)
- `POST /v1/messages` exists.
- Non-streaming requests work.
- `stream=true` currently deterministic reject in C1.
- Token-mode routing + metering + auth gating are in place.

## Scope phases

## C1.5 (Immediate: OpenClaw functional parity)

Required:
1. SSE streaming support on `POST /v1/messages`.
- If upstream returns `text/event-stream`, passthrough stream bytes/chunks to client.
- Preserve upstream status and content-type.

2. Anthropic payload passthrough fidelity.
- Pass through these fields untouched in request body:
  - `system`
  - `tools`
  - `tool_choice`
  - `thinking`
  - `reasoning_content` (if present; not a primary contract dependency)
  - `metadata`
  - multimodal `messages` content blocks (including base64 images)

2b. Anthropic header passthrough fidelity.
- Preserve/pass through inbound Anthropic headers end-to-end:
  - `anthropic-version`
  - `anthropic-beta`
- Do not overwrite client-provided values unless explicitly documented.

3. Large-context readiness.
- Body size limit and parser settings updated to avoid rejecting valid large requests.
- Timeout defaults adjusted for long-running tool/thinking turns.

4. Error-shape compatibility.
- Preserve upstream Anthropic error body/status when provider responds.
- Keep Innies pre-routing errors in existing Innies envelope.

5. Streaming-safe idempotency behavior.
- If `Idempotency-Key` provided and duplicate detected: deterministic `409 proxy_replay_not_supported`.
- If missing key: no replay persistence contract.

6. OAuth compat profile (request-contract invariant).
- For Anthropic OAuth-backed token credentials, compatibility shaping must be deterministic and code-defined.
- Retry-driven OAuth compatibility is acceptable if deterministic and covered by route-level tests.
- If OAuth compatibility mode is required, normalize request shape on an explicit OAuth auth-error branch and retry once.

7. OAuth beta-header invariant.
- Required OAuth Anthropic beta headers must not be dropped on fallback/retry paths.
- Fallback logic may remove incompatible extras, but must preserve auth-critical betas for OAuth credentials.

8. No-silent-mutation invariant.
- Any compatibility normalization/mutation must be observable in logs.
- Compatibility path activation must emit deterministic machine-readable markers for incident correlation.

## C1.6 (Hardening before broader team rollout)

Required:
1. 429 + retry hints.
- Pass through `retry-after` when present.
- Keep upstream 429 response body intact.

2. Streaming lifecycle handling.
- Client disconnect handling without process leaks.
- Ensure response closes cleanly on upstream termination.

3. Observability and diagnostics.
- Correlation headers preserved:
  - `x-request-id`
  - `x-innies-token-credential-id` or `x-innies-upstream-key-id`
  - `x-innies-attempt-no`
- Log structured stream outcomes (success, disconnect, upstream error).
- Add structured per-attempt compat diagnostics for `/v1/messages`:
  - `requestId`, `attemptNo`, `credentialId`, `authScheme`
  - normalization flags (e.g. dropped tools/tool_choice, dropped thinking, forced non-stream)
  - effective outbound Anthropic beta header set
  - upstream `status`, upstream error `type`/`message` when present

4. Metering policy for stream mode documented.
- Best-effort usage extraction from stream usage frames.
- Fallback estimate policy if usage frames absent.
- Reconciliation note for later corrections.

5. Deterministic fallback matrix (fixed contract).
- `401` with OAuth-incompatible auth error signature:
  - apply OAuth-safe normalization and retry once on same credential.
- `401` other auth failures:
  - credential refresh once; if still failing, failover to next credential.
- `403` blocked-policy signature:
  - apply blocked-policy fallback branch per compat rules.
- `429`:
  - bounded backoff + failover.
- `5xx`/network/timeout:
  - failover to next credential.
- if all attempts fail:
  - return deterministic terminal error with preserved upstream semantics where applicable.

## C2 (Optional enhancements)

1. Prompt caching compatibility.
- Support anthropic caching headers/controls.

2. Extended thinking compatibility.
- Pass through thinking blocks/settings.

3. Additional Anthropic endpoint parity as needed.
- e.g. `/v1/messages/count_tokens` if OpenClaw starts requiring it.

## Non-goals (for C1.5/C1.6)
- OpenAI protocol compatibility work.
- New billing primitives.
- Provider-side quota introspection parity.

## API contract decisions

1. Auth
- Same as existing: `Authorization: Bearer` or `x-api-key`.
- Same org scoping via API key lookup.

2. Token-mode gating
- `/v1/messages` remains token-mode-only.
- If org not token-enabled: deterministic `403`.

3. Feature flag
- `ANTHROPIC_COMPAT_ENDPOINT_ENABLED=true` required.
- If false: deterministic `404` on `/v1/messages`.

4. Idempotency
- Optional for compat endpoint.
- Provided key: duplicate -> `409 proxy_replay_not_supported`.
- Missing key: request proceeds with no replay guarantee.

5. OAuth fallback semantics
- For OAuth-backed Anthropic credentials, payload-shape normalization is applied on explicit OAuth auth-error retry (`401` oauth-incompatible/authentication_error).
- Retry/fallback branches must preserve required OAuth auth headers while applying payload compatibility shaping.
- Error matching for OAuth-incompatible request mode must be robust to minor upstream message variations (not exact-string brittle).

6. Streaming/non-stream parity
- Any compatibility rule added for `/v1/messages` must be implemented identically for both streaming and non-streaming execution paths.

7. Shared normalizer implementation rule
- Compatibility normalization logic must live in one shared function/module consumed by both streaming and non-streaming execution paths.
- Duplicated branch-local normalization logic is out of scope for C1.6 acceptance.

## Test plan

## Required automated tests
1. Non-streaming success passthrough (`200`) with Anthropic-native payload.
2. Streaming success passthrough (`text/event-stream`) with chunk forwarding.
3. Upstream `4xx` passthrough body/status.
4. Upstream `5xx` passthrough body/status.
5. `stream=true` path now succeeds (replacing prior reject behavior).
6. Validation tests for required Anthropic fields.
7. Flag-off `404`.
8. Org not token-enabled `403`.
9. Idempotency duplicate `409` when key provided.
10. Extended thinking continuity:
- request with `thinking` fields is forwarded unchanged.
- follow-up turn with preserved thinking context/signatures succeeds.
- `reasoning_content` (if present) is forwarded unchanged.
11. Header passthrough fidelity:
- inbound `anthropic-version` is preserved to upstream.
- inbound `anthropic-beta` is preserved to upstream.
- server does not overwrite client-provided values for either header.
12. OAuth incompatibility regression (`/v1/messages` route-level, not proxy-only simulation):
- first upstream response: `401` auth error for OAuth-incompatible request mode.
- second attempt (or preflight-normalized first attempt, depending implementation) uses OAuth-safe payload shape.
- required OAuth beta headers remain present on the successful OAuth path (no auth-beta regression).
13. Streaming/non-stream parity regression:
- run equivalent OAuth-compat scenarios in both branches and assert same normalization + header behavior.
14. Fallback matrix contract tests:
- one test per matrix branch (`401 oauth-incompat`, `401 auth`, `403 blocked`, `429`, `5xx/network/timeout`) asserting deterministic branch behavior.
15. Failure-attribution logging tests:
- verify structured per-attempt fields are emitted for compat failures and retries.
16. No-silent-mutation test:
- when compat normalization is applied, assert deterministic marker/header/log field indicating normalization occurred.
17. Shared-normalizer parity test:
- assert both stream and non-stream handlers call the same normalization routine and produce identical normalized payload/header decisions for equivalent input.

## Manual OpenClaw smoke
1. Configure OpenClaw base URL = `https://api.innies.computer` (canonical Anthropic compat setting).
   - `/v1` variant may be tolerated depending client normalization; validate as a compatibility check.
2. Run non-streaming prompt -> success.
3. Run streaming/tool-use prompt -> success.
4. Verify DB writes in:
- `in_routing_events`
- `in_usage_ledger`

## Risks and mitigations

1. Stream proxy instability under disconnects.
- Mitigation: pipeline cancellation handling + explicit tests.

2. Memory pressure with large requests.
- Mitigation: body limit tuning + safe bounds + timeout controls.

3. Metering drift in streaming mode.
- Mitigation: explicit best-effort contract + reconciliation workflow.

4. Behavior divergence between `/v1/proxy/*` and `/v1/messages`.
- Mitigation: centralize shared execution path where safe.

## Exit criteria for this scope

C1.5 exit:
- OpenClaw can run both non-streaming and streaming requests through Innies without protocol-level failures.
- Anthropic payload features (system/tools/images/metadata) pass through unchanged.
- OAuth-backed OpenClaw traffic passes through deterministic compatibility handling without beta-header regressions.

C1.6 exit:
- No known high-severity incompatibility in staging/prod smoke.
- 429/5xx/error behavior predictable and documented.
- Observability sufficient to debug failed OpenClaw runs.
- Prod-like canary gate passed:
  - 4-case matrix (`tools on/off` x `stream on/off`) succeeds via `/v1/messages`.
  - no unresolved auth-class regressions (`401`/`403`) in canary run logs.

## Implementation order recommendation

1. Streaming passthrough in compat route (highest impact)
2. Large-body/timeout adjustments
3. Error/header fidelity pass
4. Test coverage completion
5. Deploy behind existing compat flag and smoke on OpenClaw host
