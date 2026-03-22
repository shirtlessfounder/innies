# Incident Runbook

Operator playbooks for the three most common incidents. Each uses `curl` against the analytics API.

For agent-led end-to-end diagnosis and local-fix loops, see [INNIES_DIAGNOSIS_LOOP.md](./INNIES_DIAGNOSIS_LOOP.md).

## Setup

```bash
export BASE_URL="${INNIES_BASE_URL:-http://localhost:4010}"
export ADMIN_TOKEN="${INNIES_ADMIN_API_KEY}"
```

All commands below assume these two variables are set. Append `?window=5h` (or `24h`, `7d`, `1m`, `all`) to any endpoint to change the time range. Default is `24h` unless noted.

---

## 1. Latency Spike

Goal: identify which token(s) or provider(s) are slow.

### Step 1 — Check system-wide latency

```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$BASE_URL/v1/admin/analytics/system?window=5h" | jq '{
    latencyP50Ms, latencyP95Ms, ttfbP50Ms, ttfbP95Ms, errorRate, fallbackRate
  }'
```

If `latencyP95Ms` is elevated, drill into per-token data.

### Step 2 — Per-token latency breakdown

```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$BASE_URL/v1/admin/analytics/tokens/routing?window=5h" | jq '.tokens
    | sort_by(-.latencyP95Ms)
    | .[:10]
    | .[] | {debugLabel, credentialId, latencyP50Ms, latencyP95Ms, ttfbP95Ms, errorCount, totalAttempts}'
```

Look for tokens with a `latencyP95Ms` much higher than the system average. Cross-reference `errorCount` — high latency paired with errors often means the provider is degraded.

### Step 3 — Filter by provider

```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$BASE_URL/v1/admin/analytics/tokens/routing?window=5h&provider=anthropic" | jq '.tokens
    | sort_by(-.latencyP95Ms)
    | .[:5]
    | .[] | {debugLabel, credentialId, latencyP95Ms, errorCount}'
```

Replace `anthropic` with `openai` to compare. If one provider's tokens are uniformly slow, the issue is upstream.

### Step 4 — Check time series for when it started

```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$BASE_URL/v1/admin/analytics/timeseries?window=24h" | jq '.series
    | .[] | {ts: .timestamp, p95: .latencyP95Ms, errors: .errorCount}'
```

Look for the inflection point where p95 jumped. Correlate with events (see Step 5).

### Step 5 — Check recent events for context

```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$BASE_URL/v1/admin/analytics/events?window=5h&limit=20" | jq '.events[]
    | select(.severity != "info")
    | {type, severity, credentialLabel, summary, createdAt}'
```

`probe_failed`, `maxed`, or `rate_limited` events around the latency spike time pinpoint the culprit.

---

## 2. Failure Wave

Goal: detect a burst of errors and identify the source.

### Step 1 — Check system error rate

```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$BASE_URL/v1/admin/analytics/system?window=5h" | jq '{
    errorRate, fallbackRate, totalRequests, maxedTokens, activeTokens
  }'
```

`errorRate` above 0.05 (5%) is abnormal. `maxedTokens` climbing means tokens are hitting limits.

### Step 2 — Per-token error breakdown

```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$BASE_URL/v1/admin/analytics/tokens/routing?window=5h" | jq '.tokens
    | sort_by(-.errorCount)
    | .[:10]
    | .[] | {debugLabel, credentialId, provider, errorCount, totalAttempts, errorBreakdown, authFailures24h, rateLimited24h}'
```

Key signals:
- `authFailures24h > 0` — token credential is bad or expired
- `rateLimited24h > 0` — token is being throttled upstream
- `errorBreakdown` shows error types (e.g. `{"429": 15, "500": 3}`)

### Step 3 — Token health status

```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$BASE_URL/v1/admin/analytics/tokens/health?window=7d" | jq '.tokens
    | map(select(.status != "active"))
    | .[] | {debugLabel, credentialId, status, consecutiveFailures, lastFailedAt, maxedAt, rateLimitedUntil}'
```

Tokens not in `active` status are the likely problem. States to watch:
- `maxed` — hit usage cap, will recover on its own
- `paused` — manually paused, needs operator action to unpause
- `expired` / `revoked` — dead, needs replacement

### Step 4 — Check anomalies

```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$BASE_URL/v1/admin/analytics/anomalies?window=5h" | jq .
```

If `ok` is `false`, look at `checks`:
- `nullCredentialIdsInRouting > 0` — routing is broken for some requests
- `missingDebugLabels > 0` — tokens without labels (low priority but noisy)
- `staleAggregateWindows > 0` — aggregate data is lagging

### Step 5 — Recent error events

```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$BASE_URL/v1/admin/analytics/events?window=5h&limit=50" | jq '.events[]
    | select(.severity == "error" or .severity == "warn")
    | {type, severity, credentialLabel, summary, statusCode, reason, createdAt}'
```

Look for clusters of `probe_failed` or `maxed` events on the same credential.

---

## 3. Bad Key Detection

Goal: find and remove a problematic token.

### Step 1 — Check anomalies for obvious issues

```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$BASE_URL/v1/admin/analytics/anomalies?window=24h" | jq .
```

`unresolvedCredentialIdsInTokenModeUsage > 0` can indicate orphaned or invalid credentials.

### Step 2 — Find tokens with high error rates

```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$BASE_URL/v1/admin/analytics/tokens/routing?window=24h" | jq '.tokens
    | map(select(.totalAttempts > 0))
    | map(. + {errorRate: (.errorCount / .totalAttempts)})
    | sort_by(-.errorRate)
    | .[:5]
    | .[] | {debugLabel, credentialId, provider, errorRate, errorCount, totalAttempts, authFailures24h, errorBreakdown}'
```

A token with `errorRate` near 1.0 and `authFailures24h > 0` is likely a bad key.

### Step 3 — Check the suspect token's health

```bash
# Replace CREDENTIAL_ID with the suspect token's credentialId
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$BASE_URL/v1/admin/analytics/tokens/health?window=7d" | jq --arg id "CREDENTIAL_ID" '.tokens[]
    | select(.credentialId == $id)
    | {debugLabel, credentialId, status, consecutiveFailures, lastFailedStatus, lastFailedAt, authDiagnosis, maxedEvents7d}'
```

Key signals:
- `consecutiveFailures` climbing — provider is rejecting this key
- `lastFailedStatus: 401` or `403` — auth is broken
- `authDiagnosis` not null — the system already flagged this key

### Step 4 — Pause the token

```bash
# Replace CREDENTIAL_ID with the bad token's credentialId
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  "$BASE_URL/v1/admin/token-credentials/CREDENTIAL_ID/pause"
```

Or use the script:

```bash
scripts/innies-token-pause.sh pause
```

### Step 5 — Verify errors resolve

Wait 2-3 minutes, then re-check:

```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$BASE_URL/v1/admin/analytics/system?window=5h" | jq '{errorRate, fallbackRate}'
```

If `errorRate` drops, the paused token was the problem. If not, repeat from Step 2 — there may be multiple bad keys.

### Step 6 — Check events to confirm

```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$BASE_URL/v1/admin/analytics/events?window=5h&limit=20" | jq '.events[]
    | select(.type == "paused" or .type == "probe_failed")
    | {type, credentialLabel, summary, createdAt}'
```

You should see a `paused` event for the token you just paused. If `probe_failed` events continue on other tokens, investigate those too.

---

## 4. Darryn Pilot Cutover / Rollback

Goal: move Darryn between `innies` and `fnf` without admitting new traffic during the ownership swap, and recover cleanly if the cutover fails before commit.

For a sacrificial pre-launch rehearsal with a non-Darryn test user, use `docs/ops/DARRYN_PILOT_REHEARSAL_CHECKLIST.md` first. Do not use Darryn's identities, buyer keys, token credentials, payment methods, or withdrawal destinations for that dry run.

### Preconditions

- `PILOT_GITHUB_ALLOWLIST_LOGINS` and / or `PILOT_GITHUB_ALLOWLIST_EMAILS` include Darryn.
- The routing reserve-floor migration adapter is configured. If it is not, `/v1/admin/pilot/cutover` fails closed and records freeze errors instead of committing the cutover.
- The buyer keys and token credentials you plan to move are identified up front.

### Step 1 — Start the cutover

```bash
curl -s -X POST -H "x-api-key: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  "$BASE_URL/v1/admin/pilot/cutover" \
  -d '{
    "sourceOrgId": "org_innies",
    "targetOrgSlug": "fnf",
    "targetOrgName": "Friends & Family",
    "targetUserEmail": "darryn@example.com",
    "targetUserDisplayName": "Darryn",
    "buyerKeyIds": ["BUYER_KEY_ID"],
    "tokenCredentialIds": ["TOKEN_CREDENTIAL_ID"]
  }'
```

Expected result:
- `200`
- `cutoverId`
- `targetOrgId`
- `targetUserId`

What happens:
- active buyer-key and token-credential freezes are written first
- base-table `org_id` ownership and F&F ownership mappings move inside one transaction
- reserve-floor migration runs before the cutover transaction commits

### Step 2 — Verify admissions are no longer frozen

Successful cutover releases the active freezes automatically. New buyer-key auth should stop returning `423 cutover_in_progress`, and token routing should stop excluding the moved credentials for freeze reasons.

### Step 3 — If cutover fails before commit

Symptoms:
- the API returns an error instead of `200`
- buyer-key auth stays fail-closed with `423 cutover_in_progress`
- token routing keeps excluding the migrating credentials

Operator action:
- inspect the error returned by `/v1/admin/pilot/cutover`
- fix the underlying issue, most commonly the missing reserve-floor adapter
- re-run the same cutover request once the dependency is healthy

Cutover-access records the failure message on the active freeze rows; it does not silently reopen admissions after a failed pre-commit cutover.

### Step 4 — Roll back to `innies`

```bash
curl -s -X POST -H "x-api-key: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  "$BASE_URL/v1/admin/pilot/rollback" \
  -d '{
    "sourceCutoverId": "CUTOVER_ID",
    "targetOrgId": "org_innies",
    "buyerKeyIds": ["BUYER_KEY_ID"],
    "tokenCredentialIds": ["TOKEN_CREDENTIAL_ID"]
  }'
```

Expected result:
- `200`
- `rollbackId`

What happens:
- the same admission surfaces freeze first
- buyer-key and token-credential base ownership moves back to the reverted target org
- F&F ownership rows are updated to match the reverted state
- the rollback marker is written
- the active freezes are released only after the rollback commits

---

## 5. Wallet Projector Backlog Recovery

Goal: detect wallet ledger projection rows that did not finalize and safely requeue one after the underlying issue is fixed.

### Step 1 — List wallet projector backlog

```bash
curl -s -H "x-api-key: $ADMIN_TOKEN" \
  "$BASE_URL/v1/admin/metering/projectors/wallet?limit=20" | jq '.rows[]
    | {meteringEventId: .metering_event_id, state, retryCount: .retry_count, lastError: .last_error_message, updatedAt: .updated_at}'
```

Expected result:
- rows in `pending_projection` or `needs_operator_correction`
- `lastError` populated for rows that already failed projection

### Step 2 — Retry one wallet projection

```bash
IDEMPOTENCY_KEY="$(uuidgen)"
curl -s -X POST -H "x-api-key: $ADMIN_TOKEN" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
  "$BASE_URL/v1/admin/metering/projectors/wallet/METERING_EVENT_ID/retry"
```

Expected result:
- `200`
- `ok: true`
- the returned row is back in a retryable state

If the same event returns to `needs_operator_correction`, inspect the canonical metering row and wallet dependencies before retrying again.

---

## 6. Earnings Projector Backlog Recovery

Goal: find financially served requests whose contributor accrual projection is stuck and replay them after the root cause is fixed.

### Step 1 — List earnings projection backlog

```bash
curl -s -H "x-api-key: $ADMIN_TOKEN" \
  "$BASE_URL/v1/admin/pilot/earnings/projections?limit=20" | jq '.projections[]
    | {meteringEventId, requestId, contributorUserId, routingMode, earningsMinor: .contributorEarningsMinor, state, retryCount, nextRetryAt, updatedAt}'
```

Expected result:
- backlog rows identify the metering event and request that still need projection

### Step 2 — Retry one earnings projection

```bash
curl -s -X POST -H "x-api-key: $ADMIN_TOKEN" \
  "$BASE_URL/v1/admin/pilot/earnings/projections/METERING_EVENT_ID/retry"
```

Expected result:
- `200`
- `ok: true`
- the event is re-projected immediately

If replay keeps failing, fetch the matching request explanation and verify the request truly used `team-overflow-on-contributor-capacity` with a non-null capacity owner before retrying again.

---

## 7. Stripe Payment And Auto-Recharge Recovery

Goal: distinguish processor failure, webhook normalization failure, and wallet-recording failure for manual top-ups and auto-recharge.

### Step 1 — Inspect recent payment attempts

```bash
psql "$DATABASE_URL" -c "
select id, wallet_id, kind, trigger, status, amount_minor, processor_payment_intent_id, processor_effect_id, last_error_code, last_error_message, created_at
from in_payment_attempts
where wallet_id = '$WALLET_ID'
order by created_at desc
limit 20;
"
```

Interpretation:
- `status = failed` means Stripe rejected the charge or setup path; the error columns hold the normalized reason
- `status in ('pending', 'processing')` means wait for or replay the webhook path
- `status = succeeded` means look for the matching payment outcome and wallet recording state next

### Step 2 — Inspect payment outcomes and webhook events

```bash
psql "$DATABASE_URL" -c "
select processor_effect_id, processor_event_id, effect_type, amount_minor, wallet_recorded_at, created_at
from in_payment_outcomes
where wallet_id = '$WALLET_ID'
order by created_at desc
limit 20;
"
```

```bash
psql "$DATABASE_URL" -c "
select processor_event_id, event_type, received_at, processed_at
from in_payment_webhook_events
order by received_at desc
limit 20;
"
```

Interpretation:
- outcome row present with `wallet_recorded_at is null`: the webhook normalized successfully, but wallet recording failed before the route could mark the event processed
- webhook row present with `processed_at is null`: the webhook can be replayed safely after the wallet-side issue is fixed because the processor effect is unique and wallet recording is idempotent
- no outcome row after a succeeded attempt: investigate Stripe event delivery and webhook signature/config first

### Step 3 — Replay the Stripe event after the underlying issue is fixed

Re-send the original Stripe event from Stripe or Stripe CLI to:

```text
POST /v1/payments/webhooks/stripe
```

Expected result:
- the webhook route normalizes the event again
- wallet recording completes
- `wallet_recorded_at` becomes non-null
- the webhook row gets `processed_at`

If auto-recharge remains failed after replay, paid admissions stay blocked until a later successful recharge or a manual top-up restores positive balance.

---

## 8. Withdrawal Review And Settlement Operations

Goal: review pilot-user withdrawal requests, move them through manual payout states, and preserve truthful ledger state for settlement failures and adjustments.

### Step 1 — List withdrawals for the pilot org

```bash
curl -s -H "x-api-key: $ADMIN_TOKEN" \
  "$BASE_URL/v1/admin/pilot/withdrawals?ownerOrgId=ORG_FNF" | jq '.withdrawals[]
    | {id, contributorUserId: .contributor_user_id, amountMinor: .amount_minor, status, requestedAt: .created_at, reviewedAt: .reviewed_at, settlementReference: .settlement_reference, settlementFailureReason: .settlement_failure_reason}'
```

### Step 2 — Approve or reject

Approve:

```bash
curl -s -X POST -H "x-api-key: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  "$BASE_URL/v1/admin/pilot/withdrawals/WITHDRAWAL_ID/actions" \
  -d '{"action":"approve","reason":"manual review passed"}'
```

Reject:

```bash
curl -s -X POST -H "x-api-key: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  "$BASE_URL/v1/admin/pilot/withdrawals/WITHDRAWAL_ID/actions" \
  -d '{"action":"reject","reason":"destination details invalid"}'
```

### Step 3 — Mark settlement result

Settled:

```bash
curl -s -X POST -H "x-api-key: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  "$BASE_URL/v1/admin/pilot/withdrawals/WITHDRAWAL_ID/actions" \
  -d '{"action":"mark_settled","settlementReference":"usdc-tx-or-bank-ref","adjustmentMinor":0}'
```

Settlement failed with optional adjustment:

```bash
curl -s -X POST -H "x-api-key: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  "$BASE_URL/v1/admin/pilot/withdrawals/WITHDRAWAL_ID/actions" \
  -d '{"action":"mark_settlement_failed","settlementFailureReason":"bank rejected account","adjustmentMinor":0}'
```

Expected result:
- `mark_settled` posts a `payout_settlement` ledger effect
- `mark_settlement_failed` releases the reserved amount back to `withdrawable`
- re-approving a `settlement_failed` withdrawal reserves the funds again before another payout attempt
