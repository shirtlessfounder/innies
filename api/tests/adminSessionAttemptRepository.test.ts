import { describe, expect, it } from 'vitest';
import { AdminSessionAttemptRepository } from '../src/repos/adminSessionAttemptRepository.js';
import { MockSqlClient } from './testHelpers.js';

describe('AdminSessionAttemptRepository', () => {
  it('upserts attempt links by session key and archived attempt id', async () => {
    const db = new MockSqlClient({
      rows: [{
        session_key: 'openclaw:run:run_1',
        request_attempt_archive_id: 'archive_1'
      }],
      rowCount: 1
    });
    const repo = new AdminSessionAttemptRepository(db);

    const row = await repo.upsertAttemptLink({
      sessionKey: 'openclaw:run:run_1',
      requestAttemptArchiveId: 'archive_1',
      requestId: 'req_1',
      attemptNo: 1,
      eventTime: new Date('2026-03-31T22:00:00Z'),
      sequenceNo: 0,
      provider: 'openai',
      model: 'gpt-5.4',
      streaming: true,
      status: 'success'
    });

    expect(row).toEqual(expect.objectContaining({
      session_key: 'openclaw:run:run_1',
      request_attempt_archive_id: 'archive_1'
    }));
    expect(db.queries[0].sql).toContain('insert into in_admin_session_attempts');
    expect(db.queries[0].sql).toContain('on conflict (session_key, request_attempt_archive_id)');
    expect(db.queries[0].sql).toContain('event_time = excluded.event_time');
  });

  it('lists attempts in stable playback order', async () => {
    const db = new MockSqlClient({
      rows: [
        { request_id: 'req_1', attempt_no: 1, sequence_no: 0 },
        { request_id: 'req_1', attempt_no: 2, sequence_no: 1 }
      ],
      rowCount: 2
    });
    const repo = new AdminSessionAttemptRepository(db);

    const rows = await repo.listAttemptsBySessionKey('openclaw:run:run_1');

    expect(rows).toHaveLength(2);
    expect(db.queries[0].sql).toContain('from in_admin_session_attempts');
    expect(db.queries[0].sql).toContain('where session_key = $1');
    expect(db.queries[0].sql).toContain('order by event_time asc, request_id asc, attempt_no asc, sequence_no asc');
  });

  it('finds one attempt link by archived attempt id', async () => {
    const db = new MockSqlClient({
      rows: [{
        session_key: 'openclaw:run:run_1',
        request_attempt_archive_id: 'archive_1'
      }],
      rowCount: 1
    });
    const repo = new AdminSessionAttemptRepository(db);

    const row = await repo.findByArchiveId('archive_1');

    expect(row).toEqual(expect.objectContaining({
      session_key: 'openclaw:run:run_1',
      request_attempt_archive_id: 'archive_1'
    }));
    expect(db.queries[0].sql).toContain('where request_attempt_archive_id = $1');
    expect(db.queries[0].sql).toContain('limit 1');
  });
});
