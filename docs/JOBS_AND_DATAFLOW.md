# Jobs and Dataflow

## Purpose
Current-state reference for Innies background jobs and core dataflow in production.

## Dataflow (High Level)
1. Request hits `POST /v1/proxy/*` or `POST /v1/messages`.
2. Auth + org policy gates run.
3. Routing selects seller key or token credential.
4. Upstream call executes with retry/failover policy.
5. Routing attempt/outcome is written to `in_routing_events`.
6. Usage/metering writes append rows to `in_usage_ledger`.
7. Aggregate/reconciliation jobs roll up and validate data.

## Core Tables
From `api/src/repos/tableNames.ts`:

- `in_api_keys`
- `in_seller_keys`
- `in_token_credentials`
- `in_routing_events`
- `in_usage_ledger`
- `in_daily_aggregates`
- `in_reconciliation_runs`
- `in_idempotency_keys`
- `in_audit_log_events`

## Job Registry
Registered in `api/src/jobs/registry.ts`.

### `idempotency-purge-hourly`
- Source: `idempotencyPurgeJob.ts`
- Default cadence: hourly
- Action: deletes expired rows from `in_idempotency_keys`

### `seller-key-healthcheck-5m`
- Source: `keyHealthJob.ts`
- Default cadence: every 5 minutes
- Action: probes provider health for seller keys and updates key health/quarantine state
- Main env knobs:
  - `KEY_HEALTHCHECK_ENABLED`
  - `KEY_HEALTHCHECK_MAX_KEYS`
  - `KEY_HEALTHCHECK_TIMEOUT_MS`
  - `KEY_HEALTHCHECK_QUARANTINE_THRESHOLD`

### `token-credential-healthcheck-hourly`
- Source: `tokenCredentialHealthJob.ts`
- Default cadence: hourly
- Action: probes `maxed` token credentials and reactivates successful ones
- Main env knobs:
  - `TOKEN_CREDENTIAL_PROBE_ENABLED`
  - `TOKEN_CREDENTIAL_PROBE_SCHEDULE_MS`
  - `TOKEN_CREDENTIAL_PROBE_MAX_KEYS`
  - `TOKEN_CREDENTIAL_PROBE_TIMEOUT_MS`
  - `TOKEN_CREDENTIAL_PROBE_INTERVAL_HOURS`
  - `TOKEN_CREDENTIAL_PROBE_MODEL`

### `daily-aggregates-incremental-5m`
- Source: `dailyAggregatesJob.ts`
- Default cadence: every 5 minutes
- Action: incremental upsert into `in_daily_aggregates` from recent usage

### `daily-aggregates-nightly-compaction`
- Source: `dailyAggregatesJob.ts`
- Default cadence: daily
- Action: compact/touch previous day aggregate rows

### `reconciliation-daily-0200-utc`
- Source: `reconciliationJob.ts`
- Default cadence: hourly trigger with once-per-day gate after 02:00 UTC
- Action: writes/upserts reconciliation outcomes into `in_reconciliation_runs`

## Token Credential Lifecycle (Maxed)
- Runtime path can mark a credential `maxed` after repeated configured auth-like failures.
- Default maxing behavior is conservative (`401` only) with threshold-based transition.
- `maxed` credentials are excluded from active routing until probe job reactivates them.
- Source of contract details/env behavior: `docs/API_CONTRACT.md`.

## Observability
Primary signals:
- App logs (job completion + retry/stream/routing audit lines)
- `in_routing_events` for per-request routing/outcome analysis
- `in_usage_ledger` for metering and reconciliation inputs
- `docs/ANALYTICS_VALIDATION.md` for Phase 1 analytics SQL checks, source classification, and dashboard-consumer mapping

## Tests
- Job behavior: `api/tests/jobs.test.ts`, `api/tests/tokenCredentialHealthJob.test.ts`
- Repository behavior: `api/tests/tokenCredentialRepository.test.ts`
- Route behavior (routing/failover/compat):
  - `api/tests/proxy.tokenMode.route.test.ts`
  - `api/tests/anthropicCompat.route.test.ts`
