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

### Preconditions

- `PILOT_GITHUB_ALLOWLIST_LOGINS` and / or `PILOT_GITHUB_ALLOWLIST_EMAILS` include Darryn.
- The routing reserve-floor migration adapter is configured. If it is not, `/v1/admin/pilot/cutover` fails closed and records freeze errors instead of committing the cutover.
- The buyer keys and token credentials you plan to move are identified up front.

### Step 1 — Start the cutover

```bash
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  "$BASE_URL/v1/admin/pilot/cutover" \
  -d '{
    "sourceOrgId": "org_innies",
    "targetOrgSlug": "fnf",
    "targetOrgName": "Friends & Family",
    "targetUserEmail": "darryn@example.com",
    "targetUserDisplayName": "Darryn",
    "targetGithubLogin": "darryn",
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
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
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
