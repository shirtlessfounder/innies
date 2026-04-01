import { describe, expect, it } from 'vitest';
import { AdminAnalysisProjectionOutboxRepository } from '../src/repos/adminAnalysisProjectionOutboxRepository.js';
import { MockSqlClient, SequenceSqlClient } from './testHelpers.js';

describe('AdminAnalysisProjectionOutboxRepository', () => {
  it('enqueues archived attempts idempotently by archived attempt id', async () => {
    const db = new MockSqlClient({
      rows: [{
        id: 'analysis_outbox_1',
        request_attempt_archive_id: 'archive_1'
      }],
      rowCount: 1
    });
    const repo = new AdminAnalysisProjectionOutboxRepository(db, () => 'analysis_outbox_1');

    const row = await repo.enqueueAttempt({
      requestAttemptArchiveId: 'archive_1',
      requestId: 'req_1',
      attemptNo: 2,
      orgId: 'org_1',
      apiKeyId: 'api_1'
    });

    expect(row).toEqual(expect.objectContaining({ id: 'analysis_outbox_1', request_attempt_archive_id: 'archive_1' }));
    expect(db.queries).toHaveLength(1);
    expect(db.queries[0].sql).toContain('insert into in_admin_analysis_request_projection_outbox');
    expect(db.queries[0].sql).toContain('on conflict (request_attempt_archive_id)');
    expect(db.queries[0].sql).toContain('updated_at = now()');
    expect(db.queries[0].params).toContain('analysis_outbox_1');
    expect(db.queries[0].params).toContain('archive_1');
  });

  it('lists due rows ordered by oldest pending retry window first', async () => {
    const db = new MockSqlClient({
      rows: [
        { request_attempt_archive_id: 'archive_2' },
        { request_attempt_archive_id: 'archive_3' }
      ],
      rowCount: 2
    });
    const repo = new AdminAnalysisProjectionOutboxRepository(db);
    const now = new Date('2026-03-31T22:00:00Z');

    const rows = await repo.listDue({ now, limit: 25 });

    expect(rows).toHaveLength(2);
    expect(db.queries[0].sql).toContain("where projection_state = 'pending_projection'");
    expect(db.queries[0].sql).toContain('and next_attempt_at <= $1');
    expect(db.queries[0].sql).toContain('order by next_attempt_at asc, created_at asc, request_attempt_archive_id asc');
    expect(db.queries[0].params).toEqual([now, 25]);
  });

  it('marks rows projected, pending retry, and operator correction', async () => {
    const projectedAt = new Date('2026-03-31T22:01:00Z');
    const retryAt = new Date('2026-03-31T22:05:00Z');
    const db = new SequenceSqlClient([
      { rows: [{ projection_state: 'projected' }], rowCount: 1 },
      { rows: [{ projection_state: 'pending_projection', retry_count: 2 }], rowCount: 1 },
      { rows: [{ projection_state: 'needs_operator_correction', retry_count: 3 }], rowCount: 1 }
    ]);
    const repo = new AdminAnalysisProjectionOutboxRepository(db);

    await repo.markProjected({
      requestAttemptArchiveId: 'archive_1',
      projectedAt
    });
    await repo.markPendingRetry({
      requestAttemptArchiveId: 'archive_1',
      retryCount: 2,
      lastAttemptedAt: projectedAt,
      nextAttemptAt: retryAt,
      lastError: 'projection failed'
    });
    await repo.markNeedsOperatorCorrection({
      requestAttemptArchiveId: 'archive_1',
      retryCount: 3,
      lastAttemptedAt: retryAt,
      lastError: 'projection failed permanently'
    });

    expect(db.queries).toHaveLength(3);
    expect(db.queries[0].sql).toContain("projection_state = 'projected'");
    expect(db.queries[1].sql).toContain("projection_state = 'pending_projection'");
    expect(db.queries[1].sql).toContain('next_attempt_at = $4');
    expect(db.queries[2].sql).toContain("projection_state = 'needs_operator_correction'");
    expect(db.queries[2].sql).toContain('next_attempt_at = null');
  });

  it('counts pending rows within a time window', async () => {
    const db = new MockSqlClient({
      rows: [{ pending_count: '7' }],
      rowCount: 1
    });
    const repo = new AdminAnalysisProjectionOutboxRepository(db);
    const start = new Date('2026-03-24T00:00:00Z');
    const end = new Date('2026-03-31T00:00:00Z');

    const count = await repo.countPendingInWindow({ start, end });

    expect(count).toBe(7);
    expect(db.queries[0].sql).toContain('count(*)::bigint as pending_count');
    expect(db.queries[0].sql).toContain("projection_state = 'pending_projection'");
    expect(db.queries[0].params).toEqual([start, end]);
  });

  it('enqueues missing archived attempts in bounded batches while skipping queued or projected rows', async () => {
    const db = new SequenceSqlClient([
      {
        rows: [{
          id: 'archive_1',
          request_id: 'req_1',
          attempt_no: 2,
          org_id: 'org_1',
          api_key_id: 'api_1'
        }],
        rowCount: 1
      },
      {
        rows: [{ request_attempt_archive_id: 'archive_1' }],
        rowCount: 1
      }
    ]);
    const repo = new AdminAnalysisProjectionOutboxRepository(db, () => 'analysis_outbox_1');
    const start = new Date('2026-03-24T00:00:00Z');
    const end = new Date('2026-03-31T00:00:00Z');

    const insertedCount = await repo.enqueueMissingArchivedAttempts({
      start,
      end,
      limit: 100
    });

    expect(insertedCount).toBe(1);
    expect(db.queries[0].sql).toContain('from in_request_attempt_archives a');
    expect(db.queries[0].sql).toContain('left join in_routing_events re');
    expect(db.queries[0].sql).toContain('left join in_admin_analysis_request_projection_outbox o');
    expect(db.queries[0].sql).toContain('left join in_admin_analysis_requests r');
    expect(db.queries[0].sql).toContain('o.request_attempt_archive_id is null');
    expect(db.queries[0].sql).toContain('r.request_attempt_archive_id is null');
    expect(db.queries[0].sql).toContain("nullif(re.route_decision->>'request_source', '') in ('openclaw', 'cli-claude', 'cli-codex')");
    expect(db.queries[0].sql).toContain("nullif(re.route_decision->>'provider_selection_reason', '') = 'cli_provider_pinned'");
    expect(db.queries[0].sql).toContain("coalesce(nullif(re.route_decision->>'openclaw_run_id', ''), a.openclaw_run_id) is not null");
    expect(db.queries[0].sql).toContain('order by a.started_at asc, a.id asc');
    expect(db.queries[1].sql).toContain('insert into in_admin_analysis_request_projection_outbox');
    expect(db.queries[1].sql).toContain('json_to_recordset');
    expect(String(db.queries[1].params?.[0])).toContain('analysis_outbox_1');
    expect(String(db.queries[1].params?.[0])).toContain('archive_1');
  });

  it('requeues dependency-blocked rows that were waiting on admin session projection', async () => {
    const db = new MockSqlClient({
      rows: [{ request_attempt_archive_id: 'archive_1' }],
      rowCount: 1
    });
    const repo = new AdminAnalysisProjectionOutboxRepository(db);
    const start = new Date('2026-03-24T00:00:00Z');
    const end = new Date('2026-03-31T00:00:00Z');

    const requeuedCount = await repo.requeueWaitingForSessionProjection({
      start,
      end,
      limit: 50
    });

    expect(requeuedCount).toBe(1);
    expect(db.queries[0].sql).toContain('update in_admin_analysis_request_projection_outbox');
    expect(db.queries[0].sql).toContain("projection_state = 'pending_projection'");
    expect(db.queries[0].sql).toContain("projection_state = 'needs_operator_correction'");
    expect(db.queries[0].sql).toContain("last_error like 'admin analysis projection waiting for admin session %'");
  });
});
