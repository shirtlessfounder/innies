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
});
