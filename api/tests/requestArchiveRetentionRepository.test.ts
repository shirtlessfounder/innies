import { describe, expect, it } from 'vitest';
import { RequestArchiveRetentionRepository } from '../src/repos/requestArchiveRetentionRepository.js';
import { SequenceSqlClient } from './testHelpers.js';

describe('RequestArchiveRetentionRepository', () => {
  it('deletes archives older than the cutoff in bounded batches', async () => {
    const db = new SequenceSqlClient([
      { rows: [], rowCount: 5000 }
    ]);
    const repo = new RequestArchiveRetentionRepository(db);
    const cutoff = new Date('2026-04-01T00:00:00Z');

    const result = await repo.deleteArchivesOlderThan({ cutoff, batchSize: 5000 });

    expect(result).toEqual({ deletedCount: 5000 });
    expect(db.queries).toHaveLength(1);
    expect(db.queries[0].sql).toContain('delete from in_request_attempt_archives');
    expect(db.queries[0].sql).toContain('where id in (');
    expect(db.queries[0].sql).toContain('select id');
    expect(db.queries[0].sql).toContain('from in_request_attempt_archives');
    expect(db.queries[0].sql).toContain('where created_at < $1');
    expect(db.queries[0].sql).toContain('order by created_at asc');
    expect(db.queries[0].sql).toContain('limit $2');
    expect(db.queries[0].params).toEqual([cutoff, 5000]);
  });

  it('sweeps orphaned raw blobs with no attempt references', async () => {
    const db = new SequenceSqlClient([
      { rows: [], rowCount: 1234 }
    ]);
    const repo = new RequestArchiveRetentionRepository(db);

    const result = await repo.sweepOrphanedRawBlobs({ batchSize: 5000 });

    expect(result).toEqual({ deletedCount: 1234 });
    expect(db.queries).toHaveLength(1);
    expect(db.queries[0].sql).toContain('delete from in_raw_blobs');
    expect(db.queries[0].sql).toContain('where id in (');
    expect(db.queries[0].sql).toContain('not exists (');
    expect(db.queries[0].sql).toContain('from in_request_attempt_raw_blobs');
    expect(db.queries[0].sql).toContain('limit $1');
    expect(db.queries[0].params).toEqual([5000]);
  });

  it('sweeps orphaned message blobs with no attempt references', async () => {
    const db = new SequenceSqlClient([
      { rows: [], rowCount: 7 }
    ]);
    const repo = new RequestArchiveRetentionRepository(db);

    const result = await repo.sweepOrphanedMessageBlobs({ batchSize: 5000 });

    expect(result).toEqual({ deletedCount: 7 });
    expect(db.queries).toHaveLength(1);
    expect(db.queries[0].sql).toContain('delete from in_message_blobs');
    expect(db.queries[0].sql).toContain('not exists (');
    expect(db.queries[0].sql).toContain('from in_request_attempt_messages');
    expect(db.queries[0].sql).toContain('limit $1');
    expect(db.queries[0].params).toEqual([5000]);
  });

  it('purges projected admin-session outbox rows older than the cutoff', async () => {
    const db = new SequenceSqlClient([
      { rows: [], rowCount: 42 }
    ]);
    const repo = new RequestArchiveRetentionRepository(db);
    const cutoff = new Date('2026-04-11T00:00:00Z');

    const result = await repo.purgeProjectedSessionOutbox({ cutoff, batchSize: 5000 });

    expect(result).toEqual({ deletedCount: 42 });
    expect(db.queries).toHaveLength(1);
    expect(db.queries[0].sql).toContain('delete from in_admin_session_projection_outbox');
    expect(db.queries[0].sql).toContain("projection_state = 'projected'");
    expect(db.queries[0].sql).toContain('processed_at < $1');
    expect(db.queries[0].params).toEqual([cutoff, 5000]);
  });

  it('purges projected admin-analysis outbox rows older than the cutoff', async () => {
    const db = new SequenceSqlClient([
      { rows: [], rowCount: 11 }
    ]);
    const repo = new RequestArchiveRetentionRepository(db);
    const cutoff = new Date('2026-04-11T00:00:00Z');

    const result = await repo.purgeProjectedAnalysisOutbox({ cutoff, batchSize: 5000 });

    expect(result).toEqual({ deletedCount: 11 });
    expect(db.queries).toHaveLength(1);
    expect(db.queries[0].sql).toContain('delete from in_admin_analysis_request_projection_outbox');
    expect(db.queries[0].sql).toContain("projection_state = 'projected'");
    expect(db.queries[0].sql).toContain('processed_at < $1');
    expect(db.queries[0].params).toEqual([cutoff, 5000]);
  });

  it('clamps batch size to a minimum of 1', async () => {
    const db = new SequenceSqlClient([
      { rows: [], rowCount: 0 }
    ]);
    const repo = new RequestArchiveRetentionRepository(db);

    await repo.deleteArchivesOlderThan({
      cutoff: new Date('2026-04-01T00:00:00Z'),
      batchSize: -5
    });

    expect(db.queries[0].params?.[1]).toBe(1);
  });
});
