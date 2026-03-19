# Credential Recovery and Benched Status Design

## Goal

Recover refreshable parked credentials without operator rotation, keep provider-usage exhaustion distinct from auth validity, and make the operator/dashboard language truthful.

## Context

Two separate failure modes are getting conflated today:

- auth-valid credentials can be shown as `maxed` because provider-usage analytics say the account is exhausted
- auth-failed parked credentials stay stuck because the recovery path either probes stale tokens or uses the wrong recovery mechanism

That creates the operator experience seen in production:

- Codex/OpenAI credentials get parked after auth failures and stay stuck even though a refresh token exists
- Anthropic OAuth credentials can get parked from a single provider-usage auth-shaped failure and then stay stuck because the parked recovery path uses a generic `/v1/messages` probe
- manual probe output says "probe ok" even when the upstream usage payload is actually saying "auth valid, but no capacity"
- dashboard/UI text calls multiple different bench states `maxed`, which reads like a hard backend truth even when the raw row is still `active`

## Scope

In scope:

- parked OpenAI/Codex OAuth recovery
- parked Anthropic OAuth recovery after provider-usage auth failures
- richer manual probe / provider-usage-refresh outcomes
- preserving root-cause reasons on parked rows
- operator-script output updates
- dashboard/UI wording change from `maxed` to `benched` for operator-facing derived status text

Out of scope:

- `#132` fallback routing
- cross-provider or same-provider retry policy
- DB enum rename from `maxed` to another stored status
- automatic credential rotation

## Requirements

### Recovery Truth

- A parked credential must only reactivate after the recovery path proves it is both auth-valid and currently available for routing.
- A refreshable auth-stale OpenAI/Codex OAuth credential must attempt refresh before probing stale token material.
- A parked Anthropic OAuth credential whose parked reason is auth-shaped must recover through provider-usage refresh, not through the generic Anthropic message probe.

### Operator Truth

- Manual probe must distinguish:
  - auth valid and available
  - auth valid but usage exhausted
  - auth failed
- Manual provider-usage refresh must distinguish:
  - usage refreshed and available
  - usage refreshed but still exhausted
  - auth failure
  - fetch/backoff failure
- Operator-facing display strings should say `benched` instead of `maxed` for backend parked and derived exhaustion states.

### Root-Cause Preservation

- When a credential is parked because of a meaningful upstream cause such as `upstream_401_provider_usage_refresh`, later background/manual probe failures must not erase that row-level cause with a generic `probe_failed:*` string.
- Probe-failure events should still be recorded in the event log.

## Design

### 1. Shared OpenAI/Codex Recovery Outcome

Extend the probe layer so OpenAI/Codex OAuth probing does not stop at HTTP success.

The OpenAI/Codex WHAM usage probe must classify the upstream result into:

- `auth_valid_available`
- `auth_valid_usage_exhausted`
- `auth_failed`
- existing transport or unsupported failures

For WHAM payloads:

- HTTP `200` plus usage payload showing available capacity means probe success
- HTTP `200` plus usage payload showing exhausted capacity means auth is valid but routing should remain benched
- non-`200` still behaves as auth/network failure

Preferred fields on the probe outcome:

- `authValid: boolean | null`
- `availabilityOk: boolean | null`
- `usageExhausted: boolean`
- `usageExhaustedWindow: '5h' | '7d' | 'unknown' | null`
- `usageResetAt: Date | null`

### 2. Refresh Before Probe for Parked OpenAI/Codex OAuth

Add a shared recovery helper used by both:

- `tokenCredentialHealthJob`
- admin manual probe route

Behavior:

1. If the credential is OpenAI/Codex OAuth, has a refresh token, and is clearly auth-stale, attempt OAuth refresh first.
2. Persist refreshed token material while preserving parked state if the row was already `maxed`.
3. After refresh:
   - if auth-valid and available, reactivate
   - if auth-valid but usage-exhausted, keep parked and schedule next check at the provider reset when known
   - if refresh or probe auth fails, keep parked and schedule retry

Auth-stale trigger conditions:

- locally expired OpenAI OAuth access token
- parked row with `lastFailedStatus` `401` or `403`

### 3. Parked Anthropic OAuth Recovery via Provider Usage

Auth-failed parked Anthropic OAuth credentials should not go through the generic `probeAndUpdateTokenCredential()` path.

Instead, when the parked credential is Anthropic OAuth and availability says auth failed:

1. run `refreshAnthropicOauthUsageWithCredentialRefresh(...)`
2. if the refresh path still returns `401/403`, keep it parked and schedule retry
3. if usage refresh succeeds but provider exhaustion is still active, keep it parked until the known reset window
4. if usage refresh succeeds and availability is healthy, reactivate from parked

This makes parked Anthropic recovery match the mechanism that originally parked the key.

### 4. Anthropic Parking Threshold

Current provider-usage auth-failure parking for Anthropic OAuth uses threshold `1`.

This patch does not change the threshold. It keeps the current aggressive parking behavior, but fixes the recovery path so a single bad auth cycle does not force manual rotation. If threshold tuning is needed later, that should be a separate decision with incident data.

### 5. Preserve Row-Level Cause

Change parked probe failure persistence so generic follow-up probe failures do not clobber meaningful existing parked causes.

Required behavior:

- event log still records each `probe_failed`
- row-level `last_refresh_error` remains unchanged when it already contains a non-generic upstream reason
- row-level `last_refresh_error` may still be written when empty or already generic

### 6. Admin Response Shape

Manual probe and manual provider-usage-refresh responses should surface the recovery truth directly.

Add or standardize fields:

- `authValid`
- `availabilityOk`
- `usageExhausted`
- `usageExhaustedWindow`
- `usageResetAt`
- `refreshAttempted`
- `refreshSucceeded`
- `refreshReason`
- `refreshedCredential`
- `reactivated`

Manual probe semantics:

- `probeOk` should mean auth-valid and available
- `probeOk: false` with `authValid: true` and `usageExhausted: true` means "benched for capacity, not for auth"

Manual provider-usage-refresh semantics:

- `refreshOk` can remain the top-level transport/result field
- but the availability/auth fields above must explain whether the credential is routable now

### 7. Operator Scripts

Reuse the existing scripts and routes:

- `scripts/innies-token-probe-run.sh`
- `scripts/innies-token-usage-refresh.sh`

Update them to print plain-English summaries such as:

- `AUTH VALID, AVAILABLE`
- `AUTH VALID, USAGE EXHAUSTED`
- `AUTH FAILED`
- `REACTIVATED`
- `STILL BENCHED`

### 8. Benched Labeling

Keep the stored DB value `status = 'maxed'`.

Change only operator-facing derived strings:

- `maxed, source: backend_maxed` -> `benched, source: backend_maxed`
- `maxed, source: cap_exhausted` -> `benched, source: cap_exhausted`
- `maxed, source: usage_exhausted` -> `benched, source: usage_exhausted`

This applies to:

- API dashboard status derivation
- UI fallback status derivation
- table badges and labels that render the compact status

## Testing

Add tests for:

- OpenAI/Codex manual probe reporting usage exhaustion on `200` WHAM payloads
- parked OpenAI/Codex refresh-before-probe recovery
- parked Anthropic auth-failed recovery using provider-usage refresh instead of generic probe
- parked rows preserving root-cause `last_refresh_error`
- admin probe/provider-usage responses including the new truth fields
- dashboard status derivation showing `benched`
- operator script output for usage-exhausted and reactivated flows

## Risks

- parsing WHAM payload semantics too narrowly could misclassify new payload variants
- preserving parked status during refresh must not accidentally leave healthy active manual probes in a stale state
- changing display strings to `benched` touches both API and UI fallback logic; drift between them would be confusing

## Recommendation

Implement this as a recovery-truth patch separate from `#132`: teach recovery paths to distinguish auth from availability, recover parked OAuth credentials through the right mechanism, preserve the real parked cause, and rename operator-facing `maxed` displays to `benched`.
