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
7. Request preview rows land in `in_request_log`; full archive writes land in the archive tables.
8. Archive writes enqueue one row in `in_admin_session_projection_outbox` in the same transaction.
9. The admin session projector job upserts `in_admin_sessions` + `in_admin_session_attempts`.
10. Aggregate/reconciliation jobs roll up and validate data.

## Core Tables
From `api/src/repos/tableNames.ts`:

- `in_api_keys`
- `in_admin_session_projection_outbox`
- `in_admin_sessions`
- `in_admin_session_attempts`
- `in_seller_keys`
- `in_token_credentials`
- `in_routing_events`
- `in_usage_ledger`
- `in_request_log`
- `in_request_attempt_archives`
- `in_request_attempt_messages`
- `in_message_blobs`
- `in_request_attempt_raw_blobs`
- `in_raw_blobs`
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
- Default cadence: every 10 minutes
- Action: probes `maxed` token credentials and reactivates successful ones
- Main env knobs:
  - `TOKEN_CREDENTIAL_PROBE_ENABLED`
  - `TOKEN_CREDENTIAL_PROBE_SCHEDULE_MS`
  - `TOKEN_CREDENTIAL_PROBE_MAX_KEYS`
  - `TOKEN_CREDENTIAL_PROBE_TIMEOUT_MS`
  - `TOKEN_CREDENTIAL_PROBE_INTERVAL_MINUTES`
  - `TOKEN_CREDENTIAL_PROBE_MODEL`

### `admin-session-projector`
- Source: `adminSessionProjectorJob.ts`
- Default cadence: every 30 seconds; also runs on startup
- Action: drains `in_admin_session_projection_outbox`, projects CLI/OpenClaw archived attempts into unified admin sessions, marks retries/operator-correction state
- Main env knobs:
  - `ADMIN_SESSION_PROJECTOR_SCHEDULE_MS`
  - `ADMIN_SESSION_PROJECTOR_RETRY_DELAY_MS`
  - `ADMIN_SESSION_PROJECTOR_MAX_RETRIES`
  - `ADMIN_SESSION_PROJECTOR_BATCH_SIZE`

### `daily-aggregates-incremental-5m`
- Source: `dailyAggregatesJob.ts`
- Default cadence: every 5 minutes
- Action: incremental upsert into `in_daily_aggregates` from recent usage using UTC day buckets

### `daily-aggregates-nightly-compaction`
- Source: `dailyAggregatesJob.ts`
- Default cadence: runs on startup, then daily at the next 02:00 UTC boundary
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

## Prompt Archive + Session Projection
- Canonical write-side truth for prompts/responses/raw artifacts lives in:
  - `in_request_attempt_archives`
  - `in_request_attempt_messages`
  - `in_message_blobs`
  - `in_request_attempt_raw_blobs`
  - `in_raw_blobs`
- The archive write path transactionally enqueues projection work in `in_admin_session_projection_outbox`.
- The projector currently creates unified sessions only for `openclaw`, `cli-claude`, and `cli-codex` request sources.
- Session grouping precedence:
  - explicit source session id
  - explicit source run id
  - idle-gap grouping in the same `(org_id, api_key_id, session_type)` lane
  - request fallback
- `direct` traffic is ignored by the v1 projector.
- Read surfaces:
  - `GET /v1/admin/analytics/sessions` reads projection summaries from `in_admin_sessions`
  - `GET /v1/admin/archive/sessions*` uses the same projection for indexing/detail
  - `GET /v1/admin/archive/sessions/:sessionKey/events` and `GET /v1/admin/archive/requests/:requestId/attempts/:attemptNo` reconstruct payloads server-side from archive tables

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
