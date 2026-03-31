# Admin Session Archive API Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add native Innies admin endpoints for unified CLI/OpenClaw session analytics and full-fidelity archive playback, backed by the existing prompt archive plus a small Postgres session projection layer.

**Architecture:** Keep the current archive tables as write-side truth and keep `in_request_log` as the cheap preview/read model. Add a session projection outbox, session summary/attempt-link tables, a background projector job, a dedicated admin archive router, and a migration of `GET /v1/admin/analytics/sessions` from ad-hoc SQL grouping to the new projection-backed session model.

**Tech Stack:** TypeScript, Express, Postgres repositories, background jobs, Vitest, npm build

---

## File Map

### Create

- `docs/migrations/026_admin_session_archive_projection.sql`
- `docs/migrations/026_admin_session_archive_projection_no_extensions.sql`
- `api/src/repos/adminSessionProjectionOutboxRepository.ts`
- `api/src/repos/adminSessionRepository.ts`
- `api/src/repos/adminSessionAttemptRepository.ts`
- `api/src/services/adminArchive/adminArchiveTypes.ts`
- `api/src/services/adminArchive/sessionGrouping.ts`
- `api/src/services/adminArchive/adminSessionProjectorService.ts`
- `api/src/services/adminArchive/adminArchiveReadService.ts`
- `api/src/jobs/adminSessionProjectorJob.ts`
- `api/src/routes/adminArchive.ts`
- `api/tests/adminSessionArchiveMigrations.test.ts`
- `api/tests/adminSessionProjectionOutboxRepository.test.ts`
- `api/tests/adminSessionRepository.test.ts`
- `api/tests/adminSessionAttemptRepository.test.ts`
- `api/tests/adminSessionProjectorService.test.ts`
- `api/tests/adminSessionProjectorJob.test.ts`
- `api/tests/adminArchive.route.test.ts`

### Modify

- `api/src/repos/tableNames.ts`
- `api/src/repos/requestAttemptArchiveRepository.ts`
- `api/src/repos/messageBlobRepository.ts`
- `api/src/repos/rawBlobRepository.ts`
- `api/src/repos/requestLogRepository.ts`
- `api/src/services/archive/archiveTypes.ts`
- `api/src/services/archive/requestArchiveService.ts`
- `api/src/services/runtime.ts`
- `api/src/jobs/registry.ts`
- `api/src/server.ts`
- `api/src/routes/analytics.ts`
- `api/src/repos/analyticsRepository.ts`
- `api/tests/requestAttemptArchiveRepository.test.ts`
- `api/tests/messageBlobRepository.test.ts`
- `api/tests/rawBlobRepository.test.ts`
- `api/tests/requestArchiveService.test.ts`
- `api/tests/analytics.route.test.ts`
- `api/tests/analyticsRepository.test.ts`
- `docs/API_CONTRACT.md`
- `docs/ANALYTICS.md`
- `docs/JOBS_AND_DATAFLOW.md`

### Check For Compile/Test Fallout

- `api/tests/jobs.test.ts`
- `api/tests/server.entrypoint.test.ts`
- `api/tests/runtime.pilotCutoverService.test.ts`

These are not expected to need behavioral changes, but runtime/job registry changes may require fixture or compile fallout fixes.

## Chunk 1: Add Session Projection Persistence And Archive Enqueue

### Task 1: Add failing migration tests and register the new tables

**Files:**
- Create: `api/tests/adminSessionArchiveMigrations.test.ts`
- Create: `docs/migrations/026_admin_session_archive_projection.sql`
- Create: `docs/migrations/026_admin_session_archive_projection_no_extensions.sql`
- Modify: `api/src/repos/tableNames.ts`

- [ ] **Step 1: Write the failing migration contract tests**

Add tests that assert both `026` migration variants:
- create `in_admin_session_projection_outbox`
- create `in_admin_sessions`
- create `in_admin_session_attempts`
- add the expected uniqueness and lookup indexes
- keep the primary and no-extensions variants aligned
- include guarded `niyant` grants for the new tables
- register the new table names in `TABLES`

- [ ] **Step 2: Run the targeted migration tests**

Run:
```bash
cd api && npm test -- adminSessionArchiveMigrations.test.ts
```

Expected: FAIL because the migration files and table-name constants do not exist yet

- [ ] **Step 3: Add the projection schema**

Implement the migrations and `TABLES` entries with this minimal contract:

- `in_admin_session_projection_outbox`
  - attempt reference
  - projector state / retry fields
  - created/updated timestamps
- `in_admin_sessions`
  - `session_key`
  - `session_type`
  - `grouping_basis`
  - `org_id`
  - `api_key_id`
  - `source_session_id`
  - `source_run_id`
  - `started_at`
  - `ended_at`
  - `last_activity_at`
  - summary/count/token fields
  - preview sample JSON or text fields
- `in_admin_session_attempts`
  - `session_key`
  - `request_attempt_archive_id`
  - `request_id`
  - `attempt_no`
  - `event_time`
  - `sequence_no`
  - provider/model/status fields

Model the outbox retry columns after the existing projector-state style so the job can reuse the same operational shape:

```ts
type ProjectionOutboxState = 'pending_projection' | 'projected' | 'needs_operator_correction';
```

- [ ] **Step 4: Re-run the targeted migration tests**

Run:
```bash
cd api && npm test -- adminSessionArchiveMigrations.test.ts
```

Expected: PASS for migration contract and table-name coverage

- [ ] **Step 5: Commit**

```bash
git add docs/migrations/026_admin_session_archive_projection.sql docs/migrations/026_admin_session_archive_projection_no_extensions.sql api/src/repos/tableNames.ts api/tests/adminSessionArchiveMigrations.test.ts
git commit -m "feat: add admin session projection schema"
```

### Task 2: Add failing repository tests for the outbox and session projection tables

**Files:**
- Create: `api/tests/adminSessionProjectionOutboxRepository.test.ts`
- Create: `api/tests/adminSessionRepository.test.ts`
- Create: `api/tests/adminSessionAttemptRepository.test.ts`
- Create: `api/src/repos/adminSessionProjectionOutboxRepository.ts`
- Create: `api/src/repos/adminSessionRepository.ts`
- Create: `api/src/repos/adminSessionAttemptRepository.ts`

- [ ] **Step 1: Write the failing repository tests**

Cover:
- outbox enqueue idempotency by archived attempt
- outbox due-batch selection ordered by oldest pending row
- outbox retry / projected / operator-correction state transitions
- session upsert by `session_key`
- lookup of the latest session in the same projection lane
- attempt-link upsert by `(session_key, request_attempt_archive_id)`
- stable event ordering by `(event_time, request_id, attempt_no, sequence_no)`

- [ ] **Step 2: Run the targeted repository tests**

Run:
```bash
cd api && npm test -- adminSessionProjectionOutboxRepository.test.ts adminSessionRepository.test.ts adminSessionAttemptRepository.test.ts
```

Expected: FAIL because the repositories do not exist yet

- [ ] **Step 3: Implement the minimal repositories**

Implement repository methods with the exact read/write operations the projector needs:

```ts
enqueueAttempt(...)
listDue(...)
markProjected(...)
markPendingRetry(...)
markNeedsOperatorCorrection(...)

upsertSession(...)
findBySessionKey(...)
findLatestInLane(...)

upsertAttemptLink(...)
listAttemptsBySessionKey(...)
```

Lane lookup in `AdminSessionRepository` should be based on:
- `org_id`
- `api_key_id`
- `session_type`

Do not expose `content_hash` or blob ids in these repos; these are session-projection repos, not archive repos.

- [ ] **Step 4: Re-run the targeted repository tests**

Run:
```bash
cd api && npm test -- adminSessionProjectionOutboxRepository.test.ts adminSessionRepository.test.ts adminSessionAttemptRepository.test.ts
```

Expected: PASS for projection repository coverage

- [ ] **Step 5: Commit**

```bash
git add api/src/repos/adminSessionProjectionOutboxRepository.ts api/src/repos/adminSessionRepository.ts api/src/repos/adminSessionAttemptRepository.ts api/tests/adminSessionProjectionOutboxRepository.test.ts api/tests/adminSessionRepository.test.ts api/tests/adminSessionAttemptRepository.test.ts
git commit -m "feat: add admin session projection repositories"
```

### Task 3: Enqueue archived attempts for session projection from the archive write path

**Files:**
- Modify: `api/src/services/archive/archiveTypes.ts`
- Modify: `api/src/services/archive/requestArchiveService.ts`
- Modify: `api/tests/requestArchiveService.test.ts`

- [ ] **Step 1: Write the failing archive-service tests**

Add tests that assert:
- `archiveAttempt(...)` enqueues one projection outbox row in the same successful transaction
- duplicate replay does not enqueue a mismatched second outbox row
- rollback on outbox failure leaves no orphaned archive/message/raw-blob rows

- [ ] **Step 2: Run the targeted archive-service tests**

Run:
```bash
cd api && npm test -- requestArchiveService.test.ts
```

Expected: FAIL on missing projection outbox enqueue behavior

- [ ] **Step 3: Extend the archive service transaction**

Add a repo-factory seam for the new outbox repository and write the outbox row inside `RequestArchiveService.archiveAttempt(...)` after the archived attempt row exists:

```ts
const archive = await repos.requestAttemptArchives.upsertArchive(...);
await repos.sessionProjectionOutbox.enqueueAttempt({ requestAttemptArchiveId: archive.id, ... });
```

Use the archived attempt id as the durable handoff key. Do not derive session grouping in the write path.

- [ ] **Step 4: Re-run the targeted archive-service tests**

Run:
```bash
cd api && npm test -- requestArchiveService.test.ts
```

Expected: PASS for archive enqueue and rollback coverage

- [ ] **Step 5: Commit**

```bash
git add api/src/services/archive/archiveTypes.ts api/src/services/archive/requestArchiveService.ts api/tests/requestArchiveService.test.ts
git commit -m "feat: enqueue admin session projection from archive writes"
```

## Chunk 2: Build The Session Grouping And Projection Worker

### Task 4: Add failing tests for unified session grouping and projector behavior

**Files:**
- Create: `api/src/services/adminArchive/adminArchiveTypes.ts`
- Create: `api/src/services/adminArchive/sessionGrouping.ts`
- Create: `api/src/services/adminArchive/adminSessionProjectorService.ts`
- Create: `api/tests/adminSessionProjectorService.test.ts`

- [ ] **Step 1: Write the failing projector-service tests**

Cover at least these cases:
- OpenClaw attempt with explicit `openclaw_session_id` groups as one `openclaw` session
- OpenClaw attempt with only `openclaw_run_id` groups as one `openclaw` session
- CLI attempts with `request_source = cli-claude` and small idle gaps append to one `cli` session
- CLI attempt after the idle threshold creates a new session
- `request_source = direct` is ignored by the session projector in v1
- the projector recomputes summary counts/tokens/previews after appending an attempt

- [ ] **Step 2: Run the targeted projector-service tests**

Run:
```bash
cd api && npm test -- adminSessionProjectorService.test.ts
```

Expected: FAIL because the grouping helpers and projector service do not exist yet

- [ ] **Step 3: Implement the grouping and projection service**

Create source-normalization and grouping helpers that reuse existing routing metadata:

```ts
type AdminSessionType = 'cli' | 'openclaw';
type AdminSessionGroupingBasis = 'explicit_session_id' | 'explicit_run_id' | 'idle_gap' | 'request_fallback';
```

Rules:
- derive `request_source` from `routing_events.route_decision->>'request_source'`
- map `openclaw` to `sessionType = 'openclaw'`
- map `cli-claude` and `cli-codex` to `sessionType = 'cli'`
- ignore `direct` in v1
- use stable session keys:
  - `openclaw:session:<id>`
  - `openclaw:run:<id>`
  - `cli:idle:<org>:<apiKey>:<anchorRequestId>`
  - fallback only if there is no usable lane key

Do not rename session keys later when a singleton gains more attempts; use a stable idle-gap key anchored to the first request.

- [ ] **Step 4: Re-run the targeted projector-service tests**

Run:
```bash
cd api && npm test -- adminSessionProjectorService.test.ts
```

Expected: PASS for grouping and summary recomputation coverage

- [ ] **Step 5: Commit**

```bash
git add api/src/services/adminArchive/adminArchiveTypes.ts api/src/services/adminArchive/sessionGrouping.ts api/src/services/adminArchive/adminSessionProjectorService.ts api/tests/adminSessionProjectorService.test.ts
git commit -m "feat: add admin session projector service"
```

### Task 5: Add the background job and runtime wiring for session projection

**Files:**
- Create: `api/src/jobs/adminSessionProjectorJob.ts`
- Create: `api/tests/adminSessionProjectorJob.test.ts`
- Modify: `api/src/services/runtime.ts`
- Modify: `api/src/jobs/registry.ts`
- Modify: `api/tests/jobs.test.ts`

- [ ] **Step 1: Write the failing job/runtime tests**

Add tests that assert:
- the new job is registered by default
- the job claims pending outbox rows in bounded batches
- a successful projection marks the row `projected`
- projector failures schedule retries and eventually move to operator-correction state

- [ ] **Step 2: Run the targeted job/runtime tests**

Run:
```bash
cd api && npm test -- adminSessionProjectorJob.test.ts jobs.test.ts
```

Expected: FAIL because the session projector job is not registered or implemented yet

- [ ] **Step 3: Implement the projector job and runtime wiring**

Follow the existing `walletProjectorJob` shape:
- `runOnStart: true`
- bounded batch size
- env-driven schedule/retry defaults
- retry / operator-correction transitions

Wire the new repos/service into `runtime.ts` and `jobs/registry.ts`.

- [ ] **Step 4: Re-run the targeted job/runtime tests**

Run:
```bash
cd api && npm test -- adminSessionProjectorJob.test.ts jobs.test.ts
```

Expected: PASS for projector-job wiring and retry behavior

- [ ] **Step 5: Commit**

```bash
git add api/src/jobs/adminSessionProjectorJob.ts api/src/services/runtime.ts api/src/jobs/registry.ts api/tests/adminSessionProjectorJob.test.ts api/tests/jobs.test.ts
git commit -m "feat: wire admin session projector job"
```

## Chunk 3: Add Archive Read Services And Admin Archive Endpoints

### Task 6: Add failing tests for the archive read helpers

**Files:**
- Modify: `api/src/repos/requestAttemptArchiveRepository.ts`
- Modify: `api/src/repos/messageBlobRepository.ts`
- Modify: `api/src/repos/rawBlobRepository.ts`
- Modify: `api/src/repos/requestLogRepository.ts`
- Modify: `api/tests/requestAttemptArchiveRepository.test.ts`
- Modify: `api/tests/messageBlobRepository.test.ts`
- Modify: `api/tests/rawBlobRepository.test.ts`

- [ ] **Step 1: Write the failing repository-read tests**

Add tests for:
- `RequestAttemptArchiveRepository.findByRequestAttempt(requestId, attemptNo)`
- `RequestAttemptArchiveRepository.listByIds(ids)`
- `MessageBlobRepository.findByIds(ids)`
- `RawBlobRepository.findByIds(ids)`
- `RequestLogRepository.findByOrgRequestAttempt(orgId, requestId, attemptNo)`

- [ ] **Step 2: Run the targeted repository-read tests**

Run:
```bash
cd api && npm test -- requestAttemptArchiveRepository.test.ts messageBlobRepository.test.ts rawBlobRepository.test.ts
```

Expected: FAIL because the new read helpers do not exist yet

- [ ] **Step 3: Implement the minimal archive read helpers**

Keep these helpers read-only and focused:
- exact by-id or by-attempt lookups only
- deterministic ordering
- no archive reconstruction logic in the repos themselves

- [ ] **Step 4: Re-run the targeted repository-read tests**

Run:
```bash
cd api && npm test -- requestAttemptArchiveRepository.test.ts messageBlobRepository.test.ts rawBlobRepository.test.ts
```

Expected: PASS for the new archive read helpers

- [ ] **Step 5: Commit**

```bash
git add api/src/repos/requestAttemptArchiveRepository.ts api/src/repos/messageBlobRepository.ts api/src/repos/rawBlobRepository.ts api/src/repos/requestLogRepository.ts api/tests/requestAttemptArchiveRepository.test.ts api/tests/messageBlobRepository.test.ts api/tests/rawBlobRepository.test.ts
git commit -m "feat: add archive read helpers for admin session playback"
```

### Task 7: Add failing route tests for the new admin archive endpoints

**Files:**
- Create: `api/src/routes/adminArchive.ts`
- Create: `api/src/services/adminArchive/adminArchiveReadService.ts`
- Create: `api/tests/adminArchive.route.test.ts`
- Modify: `api/src/server.ts`

- [ ] **Step 1: Write the failing admin-archive route tests**

Cover:
- `GET /v1/admin/archive/sessions`
- `GET /v1/admin/archive/sessions/:sessionKey`
- `GET /v1/admin/archive/sessions/:sessionKey/events`
- `GET /v1/admin/archive/requests/:requestId/attempts/:attemptNo`
- admin auth enforcement
- `404` on unknown session key
- stable cursor validation for session lists and event lists

- [ ] **Step 2: Run the targeted route tests**

Run:
```bash
cd api && npm test -- adminArchive.route.test.ts
```

Expected: FAIL because the route file and read service do not exist yet

- [ ] **Step 3: Implement the read service and route layer**

Build `AdminArchiveReadService` to:
- list projected sessions
- load one projected session summary
- reconstruct ordered session playback events
- reconstruct one exact archived attempt

Playback event rules:
- synthesize one `attempt_status` event per attempt from archive metadata
- emit request messages in `side='request', ordinal asc`
- emit response messages in `side='response', ordinal asc`
- use attempt-level timestamps for ordering because archive storage does not have per-message timestamps

Mount the new router from `api/src/server.ts` instead of growing `admin.ts` further.

- [ ] **Step 4: Re-run the targeted route tests**

Run:
```bash
cd api && npm test -- adminArchive.route.test.ts
```

Expected: PASS for route contracts, auth, and unknown-resource behavior

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/adminArchive.ts api/src/services/adminArchive/adminArchiveReadService.ts api/src/server.ts api/tests/adminArchive.route.test.ts
git commit -m "feat: add admin archive session endpoints"
```

## Chunk 4: Migrate The Existing Analytics Sessions Endpoint To The Projection

### Task 8: Add failing route tests for the new unified sessions query contract

**Files:**
- Modify: `api/tests/analytics.route.test.ts`
- Modify: `api/src/routes/analytics.ts`

- [ ] **Step 1: Write the failing analytics-route tests**

Update `GET /v1/admin/analytics/sessions` coverage so it asserts:
- `sessionType=cli|openclaw` is accepted
- the response emits:
  - `sessionType`
  - `sessionKey`
  - `groupingBasis`
  - `durationMs`
  - `providerSet`
  - `modelSet`
  - `previewSample`
- `source` remains accepted only as a compatibility alias:
  - `openclaw` -> `sessionType=openclaw`
  - `cli-claude` / `cli-codex` -> `sessionType=cli`
- `source=direct` is rejected for the unified session endpoint

- [ ] **Step 2: Run the targeted analytics route tests**

Run:
```bash
cd api && npm test -- analytics.route.test.ts
```

Expected: FAIL on missing `sessionType` support or old response field names

- [ ] **Step 3: Implement the route-layer contract migration**

Implement in `api/src/routes/analytics.ts`:
- a dedicated sessions query schema that prefers `sessionType`
- compatibility transform from legacy `source`
- normalized response rows that match the new unified session contract
- existing admin auth and cursor behavior preserved

- [ ] **Step 4: Re-run the targeted analytics route tests**

Run:
```bash
cd api && npm test -- analytics.route.test.ts
```

Expected: PASS for the updated sessions route contract

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/analytics.ts api/tests/analytics.route.test.ts
git commit -m "feat: update analytics sessions route for unified session types"
```

### Task 9: Add failing repository tests and SQL for projection-backed session analytics

**Files:**
- Modify: `api/src/repos/analyticsRepository.ts`
- Modify: `api/tests/analyticsRepository.test.ts`

- [ ] **Step 1: Write the failing analytics-repository tests**

Replace the old approximate-session expectations with tests that assert:
- `getSessions(...)` reads from `in_admin_sessions`
- the query applies `sessionType`, `provider`, `orgId`, and `model` filters
- cursor pagination orders by `(last_activity_at desc, session_key desc)` or the chosen stable summary ordering
- the return shape is `{ sessions, nextCursor }`
- preview samples come from the projection row, not ad-hoc joins to full archive content

- [ ] **Step 2: Run the targeted analytics repository tests**

Run:
```bash
cd api && npm test -- analyticsRepository.test.ts
```

Expected: FAIL because `getSessions(...)` still uses the old heuristic SQL over raw routing tables

- [ ] **Step 3: Implement the projection-backed repository query**

Implement `getSessions(...)` against `in_admin_sessions`:
- filter by `session_type`
- support provider/model/org filters
- preserve bounded cursor pagination with `limit + 1`
- return summary rows only

Do not reconstruct full message graphs in `AnalyticsRepository`.

- [ ] **Step 4: Re-run the targeted analytics repository tests**

Run:
```bash
cd api && npm test -- analyticsRepository.test.ts
```

Expected: PASS for the new projection-backed session analytics query

- [ ] **Step 5: Commit**

```bash
git add api/src/repos/analyticsRepository.ts api/tests/analyticsRepository.test.ts
git commit -m "feat: back analytics sessions with admin session projections"
```

## Chunk 5: Docs And Verification

### Task 10: Document the new admin archive/session API surface

**Files:**
- Modify: `docs/API_CONTRACT.md`
- Modify: `docs/ANALYTICS.md`
- Modify: `docs/JOBS_AND_DATAFLOW.md`

- [ ] **Step 1: Add the failing docs diff**

Document:
- the new `/v1/admin/archive/...` endpoints
- the updated `GET /v1/admin/analytics/sessions` contract
- the new background projector job and projection tables

- [ ] **Step 2: Build the final docs text**

Update each doc with:
- request/response examples
- auth requirements
- cursor semantics
- note that full archive reads are admin-only
- note that session playback is reconstructed server-side from the archive

- [ ] **Step 3: Run a docs sanity pass**

Run:
```bash
rg -n "/v1/admin/archive|/v1/admin/analytics/sessions|admin session projector" docs api/src
```

Expected: all new endpoint/job references resolve to the implemented paths

- [ ] **Step 4: Commit**

```bash
git add docs/API_CONTRACT.md docs/ANALYTICS.md docs/JOBS_AND_DATAFLOW.md
git commit -m "docs: document admin session archive api"
```

### Task 11: Run focused verification, then the full API gate

**Files:**
- Modify only if failures require follow-up fixes in earlier task files

- [ ] **Step 1: Run the focused tests for the new surface**

Run:
```bash
cd api && npm test -- adminSessionArchiveMigrations.test.ts adminSessionProjectionOutboxRepository.test.ts adminSessionRepository.test.ts adminSessionAttemptRepository.test.ts requestArchiveService.test.ts adminSessionProjectorService.test.ts adminSessionProjectorJob.test.ts adminArchive.route.test.ts analytics.route.test.ts analyticsRepository.test.ts
```

Expected: PASS for the new archive/session workstream

- [ ] **Step 2: Run the full API test suite**

Run:
```bash
cd api && npm test
```

Expected: PASS for the full Vitest suite

- [ ] **Step 3: Run the API build**

Run:
```bash
cd api && npm run build
```

Expected: PASS with no TypeScript errors

- [ ] **Step 4: Commit any last verification-driven fixes**

```bash
git add [paths touched by verification fixes]
git commit -m "test: finish admin session archive api verification"
```

- [ ] **Step 5: Prepare handoff summary**

Capture:
- migration ids added
- new admin endpoints
- projector job name and schedule envs
- verification commands and outcomes

## Notes For The Implementer

- Reuse the existing request-source derivation semantics rather than inventing a second classifier:
  - `openclaw`
  - `cli-claude`
  - `cli-codex`
  - `direct`
- In v1, project only `openclaw` and `cli-*` requests into admin sessions.
- Keep direct/archive blob internals server-side.
- Treat the archive truth tables as canonical and the session tables as disposable/read-optimized projections.
- Do not block this plan on a new read-only admin API-key scope; use the existing admin scope in v1.

Plan complete and saved to `docs/superpowers/plans/2026-03-31-admin-session-archive-api.md`. Ready to execute?
