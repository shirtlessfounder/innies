# Innies C1 Implementation Summary (Audit Handoff)

This doc summarizes exactly what changed in the current working tree so other agents can audit code quality, scope fidelity, and runtime correctness.

## 1) MVP outcomes implemented

- Token-mode pooling for a single org now supports **multiple active credentials** per `(org, provider)`.
- Routing in token mode is **request-distributed** across active credentials (not single latest token).
- Safety moved from org-level controls to **per-token monthly contribution limits**.
- Org-level spend-cap gate and per-org concurrency queue are removed from proxy routing path.
- Hard branding/data-model cutover from `headroom/hr_*` to `innies/in_*` is implemented.

## 2) Code changes by area

### API routing

- `api/src/routes/proxy.ts`
  - Added deterministic request-based credential ordering for token-mode (`orderCredentialsForRequest`).
  - Removed org spend-cap gate (`usageQuery.getOrgCapState` block).
  - Removed org queue wrapper for token-mode execution.
  - After token-mode usage write, increments monthly usage per credential.
  - Removed legacy `x-headroom-*` response headers; uses `x-innies-*` only.

- `api/src/routes/admin.ts`
  - `POST /v1/admin/token-credentials` now allows appending additional credentials (no create-first-only guard).
  - Added optional `monthlyContributionLimitUnits` to create/rotate payloads.
  - `GET /v1/admin/pool-health` now returns totals only (`totalQueueDepth: 0`, `orgQueues: {}`).

### Repository layer / SQL names

- `api/src/repos/tableNames.ts`
  - Table constants renamed to `in_*`.

- Direct-SQL repos migrated from `hr_*` to `in_*`:
  - `api/src/repos/apiKeyRepository.ts`
  - `api/src/repos/idempotencyRepository.ts`
  - `api/src/repos/killSwitchRepository.ts`
  - `api/src/repos/modelCompatibilityRepository.ts`
  - `api/src/repos/sellerKeyRepository.ts`
  - `api/src/repos/usageQueryRepository.ts`

- `api/src/repos/tokenCredentialRepository.ts`
  - Added monthly fields in model and query mappings:
    - `monthly_contribution_limit_units`
    - `monthly_contribution_used_units`
    - `monthly_window_start_at`
  - `create()` computes next `rotation_version` transactionally using latest row lock.
  - `listActiveForRouting()` excludes credentials at monthly cap.
  - `refreshInPlace()` resets monthly window usage on month rollover.
  - `rotate()` supports optional monthly limit input.
  - Added `addMonthlyContributionUsage(id, usageUnits)` atomic cap-aware increment.

### Service wiring

- `api/src/services/routingService.ts`
  - Removed `OrgQueueManager` dependency and queue-run wrapper.

- `api/src/services/runtime.ts`
  - Removed `queueManager` from runtime services and routing service ctor.

### CLI / branding

- `cli/src/commands/login.js`
  - Default URL `https://gateway.innies.ai`.
  - Token validation now expects `in_` prefix.

- `cli/src/commands/claude.js`
  - Env var namespace migrated from `HEADROOM_*` to `INNIES_*`.

- `cli/src/commands/link.js`
  - Wrapper calls `innies claude`.

- `cli/src/config.js`, `cli/src/utils.js`
  - UX strings updated to `in_` tokens and `gateway.innies.ai`.

### Docs/scripts/tests

- Updated:
  - `docs/API_CONTRACT.md`
  - `docs/specs/C1_TEAM_SETUP_GUIDE.md`
  - `api/scripts/token_mode_manual_check.sh`
  - tests for renamed SQL table strings and new token repo behavior:
    - `api/tests/tokenCredentialRepository.test.ts`
    - `api/tests/proxy.tokenMode.route.test.ts`
    - `api/tests/admin.tokenCredentials.route.test.ts`
    - `api/tests/routingService.test.ts`
    - `api/tests/usageMeteringWriter.test.ts`
    - `api/tests/usageMeteringWriter.test.js`

- Package rename:
  - `api/package.json` name changed `headroom-api` -> `innies-api`.
  - `api/package-lock.json` updated accordingly.

## 3) New migrations added (untracked files)

- `migrations/003_token_mode_multi_active.sql`
  - Drops single-active partial unique index for token credentials.

- `migrations/004_token_mode_weekly_limits.sql`
- `migrations/004_token_mode_weekly_limits_no_extensions.sql`
  - Adds weekly contribution limit/usage/window columns + checks/index.

- `migrations/005_hard_cutover_in_prefix.sql`
- `migrations/005_hard_cutover_in_prefix_no_extensions.sql`
  - Hard-renames enums/functions/tables/indexes from `hr_*` to `in_*`.

- `migrations/006_token_mode_monthly_limits.sql`
- `migrations/006_token_mode_monthly_limits_no_extensions.sql`
  - Renames token cap fields/window from weekly to monthly on `in_token_credentials`.

## 4) Required migration run order

For existing DBs already on 001/002:

1. `003_token_mode_multi_active.sql`
2. `004_token_mode_weekly_limits_no_extensions.sql`
3. `005_hard_cutover_in_prefix_no_extensions.sql`
4. `006_token_mode_monthly_limits_no_extensions.sql` (or extension variant)

Note: `004` intentionally targets `hr_*` and must run **before** `005`.

## 5) Verification completed

Local code checks:

- `cd api && npm run build` passed.
- `cd api && npm test` passed (25 tests).

Manual runtime checks already performed in thread:

- 4 buyer tokens successfully called `/v1/proxy/v1/messages` with `200` responses.
- Responses showed `x-innies-token-credential-id` across different credential IDs, confirming multi-credential routing.
- DB verification showed `in_*` tables present and `hr_token_credentials` absent after cutover.

## 6) Audit focus for other agents

Ask reviewers to verify these specifically:

1. **Migration integrity**
- `005` rename script safety/idempotency on current production-like state.
- No missed `hr_*` references in runtime-critical SQL paths.

2. **Weekly limit semantics**
- Correct monthly rollover behavior under concurrent requests.
- `addMonthlyContributionUsage` race behavior and cap enforcement.

3. **Routing behavior correctness**
- Request-distributed token selection does not starve credentials.
- Failure/retry matrix still aligns with token-mode spec.

4. **Scope fidelity**
- Confirm org spend-cap and org concurrency throttling are removed from enforcement path.
- Confirm C1 non-streaming token-mode behavior unchanged.

5. **Brand cutover completeness**
- No remaining runtime contract dependencies on `x-headroom-*`, `HEADROOM_*`, `hr_*`.

## 7) Known residuals / non-blocking notes

- Some historical planning docs in `planning/` still reference old naming (`headroom/hr_*`), intentionally not fully rewritten.
- `pool-health` response keeps queue keys with zero/empty values for compatibility; no queue enforcement remains.

## 8) Current git status snapshot

- Modified files: 28
- New migration files: 5
- Diff footprint: ~361 insertions / ~283 deletions
