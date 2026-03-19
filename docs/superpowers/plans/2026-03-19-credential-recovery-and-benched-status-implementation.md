# Credential Recovery and Benched Status Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make parked credential recovery self-heal for OpenAI/Codex and Anthropic OAuth, surface auth-vs-availability truth in admin tools, and relabel operator-facing parked/exhausted states as `benched`.

**Architecture:** Extend the probe/recovery layer to return richer auth and availability outcomes, route parked Anthropic auth recovery through provider-usage refresh, and preserve meaningful parked reasons in the repository. Keep the DB enum unchanged, but update derived dashboard/UI/operator labels and scripts to say `benched`.

**Tech Stack:** TypeScript, Vitest, Express admin routes, bash helper scripts

---

## File Map

- Modify: `api/src/services/tokenCredentialProbe.ts`
- Modify: `api/src/services/tokenCredentialOauthRefresh.ts`
- Modify: `api/src/services/tokenCredentialProviderUsage.ts`
- Modify: `api/src/jobs/tokenCredentialHealthJob.ts`
- Modify: `api/src/jobs/tokenCredentialProviderUsageJob.ts`
- Modify: `api/src/routes/admin.ts`
- Modify: `api/src/repos/tokenCredentialRepository.ts`
- Modify: `api/src/services/dashboardTokenStatus.ts`
- Modify: `ui/src/lib/analytics/server.ts`
- Modify: `ui/src/components/analytics/AnalyticsTables.tsx`
- Modify: `scripts/innies-token-probe-run.sh`
- Modify: `scripts/innies-token-usage-refresh.sh`
- Test: `api/tests/tokenCredentialProbe.test.ts`
- Test: `api/tests/tokenCredentialHealthJob.test.ts`
- Test: `api/tests/tokenCredentialProviderUsageJob.test.ts`
- Test: `api/tests/admin.tokenCredentials.route.test.ts`
- Test: `api/tests/tokenCredentialRepository.test.ts`
- Test: `api/tests/dashboardTokenStatus.test.ts`

## Chunk 1: Probe Outcome Truth

### Task 1: Extend probe tests for OpenAI/Codex usage exhaustion

**Files:**
- Modify: `api/tests/tokenCredentialProbe.test.ts`
- Modify: `api/src/services/tokenCredentialProbe.ts`

- [ ] **Step 1: Write failing tests for OpenAI/Codex `200` WHAM exhaustion**

Add tests that expect:

- `probeOk`-equivalent outcome stays false when WHAM says auth is valid but capacity is exhausted
- returned metadata includes `authValid`, `availabilityOk`, `usageExhausted`, `usageExhaustedWindow`, `usageResetAt`
- parked rows schedule the next check instead of reactivating

- [ ] **Step 2: Run the focused test file and verify RED**

Run: `npm run test:unit -- api/tests/tokenCredentialProbe.test.ts`

Expected: FAIL because the current probe layer treats any `200` as plain success.

- [ ] **Step 3: Implement minimal probe parsing**

Update `api/src/services/tokenCredentialProbe.ts` to:

- parse OpenAI/Codex WHAM payloads
- distinguish auth-valid availability from auth-valid exhaustion
- carry richer outcome metadata without breaking Anthropic/basic probe callers

- [ ] **Step 4: Re-run the focused test file and verify GREEN**

Run: `npm run test:unit -- api/tests/tokenCredentialProbe.test.ts`

Expected: PASS.

## Chunk 2: Parked Recovery Paths

### Task 2: Add failing health-job and provider-usage-job recovery tests

**Files:**
- Modify: `api/tests/tokenCredentialHealthJob.test.ts`
- Modify: `api/tests/tokenCredentialProviderUsageJob.test.ts`
- Modify: `api/src/jobs/tokenCredentialHealthJob.ts`
- Modify: `api/src/jobs/tokenCredentialProviderUsageJob.ts`
- Modify: `api/src/services/tokenCredentialOauthRefresh.ts`

- [ ] **Step 1: Write failing health-job tests for refresh-before-probe**

Cover:

- parked OpenAI/Codex OAuth with expired-local auth attempts refresh first
- successful refresh plus available probe reactivates
- successful refresh plus usage exhaustion keeps row parked

- [ ] **Step 2: Write failing provider-usage-job tests for Anthropic parked auth recovery**

Cover:

- auth-failed parked Anthropic OAuth uses provider-usage refresh, not generic probe
- provider exhaustion keeps it parked until reset
- healthy usage refresh reactivates

- [ ] **Step 3: Run the focused recovery tests and verify RED**

Run:

- `npm run test:unit -- api/tests/tokenCredentialHealthJob.test.ts`
- `npm run test:unit -- api/tests/tokenCredentialProviderUsageJob.test.ts`

Expected: FAIL because current recovery paths do not implement this behavior.

- [ ] **Step 4: Implement minimal recovery helpers**

Update:

- `api/src/services/tokenCredentialOauthRefresh.ts` to support refresh persistence that can preserve parked state
- `api/src/jobs/tokenCredentialHealthJob.ts` to use the richer probe/recovery path
- `api/src/jobs/tokenCredentialProviderUsageJob.ts` to route parked Anthropic auth recovery through provider-usage refresh

- [ ] **Step 5: Re-run the focused recovery tests and verify GREEN**

Run the same commands as Step 3.

Expected: PASS.

## Chunk 3: Repository Cause Preservation

### Task 3: Add failing repository tests for parked refresh persistence and cause preservation

**Files:**
- Modify: `api/tests/tokenCredentialRepository.test.ts`
- Modify: `api/src/repos/tokenCredentialRepository.ts`

- [ ] **Step 1: Write failing repository tests**

Cover:

- refreshing a parked credential can preserve `status = 'maxed'`
- `markProbeFailure()` does not overwrite a meaningful existing parked cause with generic `probe_failed:*`

- [ ] **Step 2: Run the focused repository tests and verify RED**

Run: `npm run test:unit -- api/tests/tokenCredentialRepository.test.ts`

Expected: FAIL because current SQL always sets `status = 'active'` during refresh and always rewrites `last_refresh_error` on probe failure.

- [ ] **Step 3: Implement minimal repository changes**

Update `api/src/repos/tokenCredentialRepository.ts` to:

- support refresh-in-place with a preserve-status option for parked credentials
- preserve meaningful `last_refresh_error` row state while still inserting `probe_failed` events

- [ ] **Step 4: Re-run the focused repository tests and verify GREEN**

Run: `npm run test:unit -- api/tests/tokenCredentialRepository.test.ts`

Expected: PASS.

## Chunk 4: Admin Route Truth Surface

### Task 4: Add failing admin route tests for richer manual probe and provider-usage responses

**Files:**
- Modify: `api/tests/admin.tokenCredentials.route.test.ts`
- Modify: `api/src/routes/admin.ts`

- [ ] **Step 1: Write failing manual probe tests**

Cover:

- probe response includes auth/availability/usage fields
- usage-exhausted OpenAI/Codex response says auth valid but not available
- refresh-attempted fields appear when recovery path performs refresh

- [ ] **Step 2: Write failing provider-usage-refresh tests**

Cover:

- Anthropic and OpenAI/Codex manual provider-usage refresh responses include auth/availability truth
- usage-exhausted responses expose reset timing

- [ ] **Step 3: Run the focused admin route tests and verify RED**

Run: `npm run test:unit -- api/tests/admin.tokenCredentials.route.test.ts`

Expected: FAIL because current responses do not include the new fields and still treat probe success too narrowly.

- [ ] **Step 4: Implement minimal route wiring**

Update `api/src/routes/admin.ts` to pass through the richer recovery outcome fields and log them in audit metadata.

- [ ] **Step 5: Re-run the focused admin route tests and verify GREEN**

Run: `npm run test:unit -- api/tests/admin.tokenCredentials.route.test.ts`

Expected: PASS.

## Chunk 5: Operator-Facing Benched Labels

### Task 5: Add failing dashboard/UI status derivation tests

**Files:**
- Modify: `api/tests/dashboardTokenStatus.test.ts`
- Modify: `api/src/services/dashboardTokenStatus.ts`
- Modify: `ui/src/lib/analytics/server.ts`
- Modify: `ui/src/components/analytics/AnalyticsTables.tsx`

- [ ] **Step 1: Write failing dashboard status tests**

Cover:

- backend parked => `benched, source: backend_maxed`
- cap exhaustion => `benched, source: cap_exhausted`
- usage exhaustion => `benched, source: usage_exhausted`

- [ ] **Step 2: Run the focused dashboard test and verify RED**

Run: `npm run test:unit -- api/tests/dashboardTokenStatus.test.ts`

Expected: FAIL because current output still says `maxed`.

- [ ] **Step 3: Implement minimal status-label changes**

Update API and UI fallback derivation to emit `benched`, and update badge rendering so `benched` uses the same visual treatment the UI currently reserves for `maxed`.

- [ ] **Step 4: Re-run the focused dashboard test and verify GREEN**

Run: `npm run test:unit -- api/tests/dashboardTokenStatus.test.ts`

Expected: PASS.

## Chunk 6: Operator Script Output

### Task 6: Update manual probe and provider-usage helper scripts

**Files:**
- Modify: `scripts/innies-token-probe-run.sh`
- Modify: `scripts/innies-token-usage-refresh.sh`

- [ ] **Step 1: Add script expectations to existing route-driven tests if practical**

If there are no direct script tests, keep the change small and rely on manual execution after route tests pass.

- [ ] **Step 2: Update `innies-token-probe-run.sh`**

Print plain-English outcomes for:

- reactivated
- auth valid and available
- auth valid but usage exhausted
- auth failed and still benched

- [ ] **Step 3: Update `innies-token-usage-refresh.sh`**

Print plain-English availability/auth state and reset timing when usage remains exhausted.

- [ ] **Step 4: Manually verify scripts against mocked/local responses or existing admin surfaces**

Use the same admin routes the scripts already call.

## Chunk 7: Final Verification

### Task 7: Run the focused verification suite

**Files:**
- No code changes

- [ ] **Step 1: Run the focused unit tests**

Run:

- `npm run test:unit -- api/tests/tokenCredentialProbe.test.ts`
- `npm run test:unit -- api/tests/tokenCredentialHealthJob.test.ts`
- `npm run test:unit -- api/tests/tokenCredentialProviderUsageJob.test.ts`
- `npm run test:unit -- api/tests/tokenCredentialRepository.test.ts`
- `npm run test:unit -- api/tests/admin.tokenCredentials.route.test.ts`
- `npm run test:unit -- api/tests/dashboardTokenStatus.test.ts`

- [ ] **Step 2: Run one broader analytics/admin safety pass**

Run:

- `npm run test:unit -- api/tests/analytics.route.test.ts`

- [ ] **Step 3: Summarize residual risks**

Document any untested script edge cases or production-only payload assumptions before handoff.

Plan complete and saved to `docs/superpowers/plans/2026-03-19-credential-recovery-and-benched-status-implementation.md`. Ready to execute?
