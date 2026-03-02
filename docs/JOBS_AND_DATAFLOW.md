# Jobs and Dataflow (Agent 3)

## Scope
This document defines the Agent 3 data-plane components for Checkpoint 1:

- Repository layer abstractions for SQL-backed writes.
- Metering write path for usage, correction, and reversal rows.
- Scheduler framework and default job cadence.
- Dashboard shell data adapters and mock-backed pages.

## Repository Layer

Implemented in `api/src/repos`.

- `sqlClient.ts`
  - Defines the minimal SQL abstraction (`query`, `transaction`) to decouple repo code from a concrete DB driver.
- `usageLedgerRepository.ts`
  - Primary usage row insert.
  - Correction row insert (requires source event).
  - Reversal row insert (requires source event).
- `idempotencyRepository.ts`
  - Idempotency read/write + expired key purge.
- `aggregatesRepository.ts`
  - Incremental recompute/upsert for touched days into `hr_daily_aggregates`.
  - Nightly compaction touchpoint.
- `reconciliationRepository.ts`
  - Upsert daily reconciliation run records.

## Metering Write Path

Implemented in `api/src/services/metering/usageMeteringWriter.ts`.

- `recordUsage(event)`
  - Writes an append-only `usage` row.
- `recordCorrection(sourceEventId, event, note)`
  - Writes `correction` with source linkage.
- `recordReversal(sourceEventId, event, note)`
  - Writes `reversal` with source linkage.

Guarantees:
- No in-place mutation of existing ledger rows.
- Correction/reversal lineage is explicit through `source_event_id`.

## Job Framework and Schedules

Implemented in `api/src/jobs`.

- `scheduler.ts`
  - Generic in-process scheduler with immediate first run.
  - Structured info/error logging hook.

Default job registry in `registry.ts`:

1. `idempotency-purge-hourly`
- Source: `idempotencyPurgeJob.ts`
- Cadence: hourly.
- Action: delete expired rows from `hr_idempotency_keys`.

2. `daily-aggregates-incremental-5m`
- Source: `dailyAggregatesJob.ts`
- Cadence: every 5 minutes.
- Action: recompute touched usage days from `hr_usage_ledger` and upsert `hr_daily_aggregates`.

3. `daily-aggregates-nightly-compaction`
- Source: `dailyAggregatesJob.ts`
- Cadence: daily.
- Action: compact/touch previous day aggregates.

4. `reconciliation-daily-0200-utc`
- Source: `reconciliationJob.ts`
- Cadence: hourly trigger with once-per-day gate after 02:00 UTC.
- Action: writes reconciliation rows to `hr_reconciliation_runs`.

## Dashboard Shell (Mock Adapters)

Implemented in `ui/src`.

- `lib/mockAdapters.ts`
  - Mock providers for seller keys, buyer usage, and pool health.
- `app/seller-keys/page.tsx`
- `app/buyer-usage/page.tsx`
- `app/pool-health/page.tsx`

These pages are shell-only and intended to be wired to real API data after Agent 1 contract stabilization.

## Test Coverage

- `api/tests/usageMeteringWriter.test.ts`
  - Verifies usage/correction/reversal write path behavior.
- `api/tests/jobs.test.ts`
  - Verifies job cadence constants and core run-path behavior.

## Integration Notes

- Agent 1 publishes final API contract and routing event payload shape.
- Agent 3 repo/service code should then bind request/response DTOs to these repos.
- UI shell adapters can be swapped with real fetchers once `GET /v1/usage/me` and `GET /v1/admin/pool-health` are live.
