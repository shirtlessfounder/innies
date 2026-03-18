# Codex Parked Refresh Recovery Design

## Goal

Recover parked OpenAI/Codex OAuth credentials that are refreshable but stuck in `maxed` because the current parked-token recovery path only probes with the stale access token.

## Problem

Innies already attempts OpenAI OAuth refresh in the live proxy request path after auth failures. That is not the gap.

The gap is what happens after a credential has already been parked:

- normal routing no longer selects the credential because routing only uses `active` credentials
- the background parked-token health job only probes with the stored access token
- the manual admin probe path also only probes with the stored access token

That means a parked Codex OAuth credential can have:

- a valid stored refresh token
- a locally provable expired access token
- a recoverable auth failure state

and still remain parked forever until an operator rotates it manually.

## Scope

In scope:

- parked-credential recovery for OpenAI/Codex OAuth credentials
- shared recovery logic used by:
  - the background parked-token health job
  - the manual admin probe route
- refresh-before-probe when the credential is clearly in an auth-stale state
- explicit response fields in the manual probe route showing refresh behavior
- tests for refresh-before-probe success/failure paths

Out of scope:

- changes to the live proxy auth-failure retry flow
- Anthropic parked-credential recovery changes
- reactivating a credential on refresh success alone
- changing the meaning of `maxed` in analytics
- rotating credentials automatically when refresh fails

## User-Facing Requirements

- Manual probe must explicitly surface whether refresh was attempted before probe.
- Manual probe must explicitly surface whether refresh succeeded.
- Manual probe must stop after a failed refresh attempt instead of probing with a token already known to be stale.
- A parked OpenAI/Codex OAuth credential must only return to `active` after a successful probe.
- Background recovery must use the same recovery rules as manual probe so operator behavior matches autonomous behavior.

## Current Behavior Summary

### Live Proxy Path

The live proxy path already does the right thing for in-flight auth failures:

1. upstream returns `401` or `403`
2. Innies records the failure
3. Innies attempts OAuth refresh once
4. if refresh succeeds, Innies persists the new token material and retries

This design does not change that path.

### Parked Recovery Paths

Today the two parked recovery paths only probe:

- background health job
- manual admin probe route

Neither path attempts OAuth refresh before using the stored token, even when:

- local token expiry is provable
- the parked state is clearly auth-shaped
- a refresh token is present

## Trigger Rules

Refresh-before-probe applies only when all of the following are true:

- provider is `openai` or `codex`
- credential is an OpenAI OAuth access-token credential
- a stored refresh token exists

Additional trigger rules by path:

- background health job:
  - only for `maxed` credentials
- manual admin probe:
  - for `active` or `maxed` credentials

Refresh-before-probe is attempted when either:

- the stored access token is provably expired locally
- the credential is `maxed` and its parked state is auth-shaped:
  - `lastFailedStatus` is `401` or `403`

If neither condition is true, recovery falls through to the existing probe-first behavior.

## Design

### Shared Recovery Helper

Add a shared recovery helper in the token-credential probe/recovery layer. Preferred shape:

- `probeAndRecoverTokenCredential(repo, credential, options?)`

Responsibilities:

1. decide whether refresh-before-probe is applicable
2. if applicable, attempt OpenAI OAuth refresh first
3. persist refreshed credential material with parked-state-aware semantics
4. if refresh succeeds, probe using the refreshed credential
5. if refresh fails, stop there and return an explicit refresh-failed outcome
6. if refresh is not applicable, defer to the existing probe behavior

Keep the existing `probeAndUpdateTokenCredential(...)` helper as the lower-level probe primitive.

### Persisting Refreshed Token Material

The existing `refreshInPlace(...)` repository method is not sufficient for parked recovery because it immediately sets the credential status to `active`.

That conflicts with the agreed rule that:

- refresh success alone must not re-admit a parked credential
- successful probe is still required before reactivation

Add parked-state-aware persistence for refreshed token material. Preferred shape:

- extend `refreshInPlace(...)` with a status-preservation option, or
- add a narrow companion method such as `refreshTokenMaterialPreservingStatus(...)`

Required behavior for previously `maxed` credentials:

- persist the new access token
- persist the new refresh token when present
- update expiry fields
- clear stale auth-failure markers that would poison the next probe
- keep `status = 'maxed'` until probe succeeds
- preserve parked semantics until `reactivateFromMaxed(...)` is called after a successful probe

Required behavior for previously `active` credentials in the manual probe path:

- existing active-state refresh semantics can remain unchanged

### Refresh-Before-Probe Semantics

If refresh-before-probe applies:

1. attempt OpenAI OAuth refresh
2. if refresh succeeds:
   - persist new access token
   - persist new refresh token if the upstream response returned one
   - if the credential was previously `maxed`, persist the refreshed token material while preserving parked state
   - if the credential was previously `active`, persist the refreshed token material with the normal active-state refresh behavior
   - immediately run the normal upstream probe with the refreshed credential
3. if refresh fails:
   - do not probe with the old token
   - return a refresh-failed result
   - if the credential was already `maxed`, leave it parked and move `nextProbeAt` forward

### Reactivation Rule

Refresh success alone is not sufficient to reactivate a parked credential.

Reactivation requires:

- refresh succeeded
- a subsequent probe succeeded

If refresh succeeds but the probe fails, the credential stays parked.

## Manual Probe API Changes

### Response Fields

Extend the manual admin probe response with:

- `refreshAttempted: boolean`
- `refreshSucceeded: boolean | null`
- `refreshReason: string | null`
- `refreshedCredential: boolean`

Preferred semantics:

- `refreshAttempted`
  - `true` when refresh-before-probe was attempted
  - `false` otherwise
- `refreshSucceeded`
  - `true` when refresh returned new token material and it was persisted
  - `false` when refresh was attempted but failed
  - `null` when refresh was not attempted
- `refreshReason`
  - `access_token_expired_local`
  - `parked_auth_failure`
  - `refresh_not_applicable`
  - `refresh_failed`
- `refreshedCredential`
  - `true` when new token material was persisted before the probe result
  - `false` otherwise

### Response Outcomes

#### Refresh succeeded, probe succeeded

- return `probeOk: true`
- if previously `maxed`, return `reactivated: true`
- include `refreshAttempted: true`
- include `refreshSucceeded: true`

#### Refresh succeeded, probe failed

- return `probeOk: false`
- return `reactivated: false`
- keep credential parked if it was previously `maxed`
- include explicit refresh success plus probe failure

#### Refresh failed

- return `refreshAttempted: true`
- return `refreshSucceeded: false`
- return `refreshReason: "refresh_failed"`
- do not probe with the old token
- if previously `maxed`, keep the credential parked and move `nextProbeAt` forward

#### Refresh not attempted

- preserve current probe behavior

## Background Job Changes

Update the parked-token health job to use the shared recovery helper for parked OpenAI/Codex OAuth credentials.

Behavior:

- background job still only processes parked credentials
- for eligible OpenAI/Codex OAuth creds, attempt refresh-before-probe under the trigger rules above
- on refresh failure:
  - keep credential `maxed`
  - advance `nextProbeAt`
  - log refresh failure explicitly
- on refresh success followed by probe success:
  - reactivate the credential through the existing probe/reactivation path

## Logging

Add structured recovery logs for the background path with fields such as:

- `credentialId`
- `credentialLabel`
- `provider`
- `refreshAttempted`
- `refreshSucceeded`
- `refreshReason`
- `probeAttempted`
- `probeOk`
- `reactivated`

This keeps parked-token recovery debuggable without requiring DB inspection.

## Failure Semantics

### Why Probe Is Skipped After Failed Refresh

When refresh-before-probe was triggered because the access token is locally expired or because the parked state is clearly auth-shaped, probing with the old token adds noise rather than evidence.

The design therefore treats failed refresh as terminal for that recovery attempt:

- manual probe reports refresh failure explicitly
- background recovery logs refresh failure explicitly
- no dead-token probe is attempted afterward

### Why Successful Probe Is Still Required

Successful refresh proves only that token exchange worked. It does not prove the refreshed credential is actually usable against the upstream probe endpoint.

Requiring a successful probe before reactivation avoids false recovery.

## Testing

Add targeted tests for the shared recovery helper:

- expired-local auth diagnosis + refresh succeeds + probe succeeds
- expired-local auth diagnosis + refresh succeeds + probe fails
- expired-local auth diagnosis + refresh fails and probe is skipped
- parked auth failure (`401`) + refresh succeeds + probe succeeds
- parked auth failure (`403`) + refresh succeeds + probe fails
- missing refresh token => refresh not attempted
- non-OAuth credential => refresh not attempted

Update manual probe route tests to assert the new response fields:

- `refreshAttempted`
- `refreshSucceeded`
- `refreshReason`
- `refreshedCredential`

Update health-job tests to assert:

- parked OpenAI/Codex OAuth creds use refresh-before-probe
- successful refresh alone does not reactivate
- refresh failure leaves the credential parked and advances `nextProbeAt`
- successful refresh plus successful probe reactivates

## Risks

- changing the parked recovery helper could accidentally change manual probe semantics for non-Codex creds if the provider gating is not strict
- parked token refresh persistence must not accidentally re-admit a credential before the follow-up probe succeeds
- response-shape changes in the admin probe route require test updates to avoid silent API drift

## Recommendation

Implement a shared parked-credential recovery helper for OpenAI/Codex OAuth credentials, use it in both the background parked-token job and the manual admin probe route, and explicitly surface refresh behavior in the manual response.

This closes the current self-healing gap without changing the already-correct live proxy refresh path.
