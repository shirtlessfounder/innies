import { describe, expect, it } from 'vitest';
import { MeteringProjectorStateRepository } from '../src/repos/meteringProjectorStateRepository.js';
import { MockSqlClient } from './testHelpers.js';

describe('MeteringProjectorStateRepository', () => {
  it('creates pending projector rows keyed by metering event and projector', async () => {
    const db = new MockSqlClient({
      rows: [{ metering_event_id: 'meter_1', projector: 'wallet', state: 'pending_projection' }],
      rowCount: 1
    });
    const repo = new MeteringProjectorStateRepository(db);

    await repo.ensurePending({
      meteringEventId: 'meter_1',
      projector: 'wallet'
    });

    expect(db.queries).toHaveLength(1);
    expect(db.queries[0].sql).toContain('insert into in_metering_projector_states');
    expect(db.queries[0].sql).toContain('on conflict (metering_event_id, projector)');
    expect(db.queries[0].params).toContain('wallet');
    expect(db.queries[0].params).toContain('pending_projection');
  });

  it('marks projector rows as projected', async () => {
    const db = new MockSqlClient({
      rows: [{ metering_event_id: 'meter_1', projector: 'wallet', state: 'projected' }],
      rowCount: 1
    });
    const repo = new MeteringProjectorStateRepository(db);

    await repo.markProjected({
      meteringEventId: 'meter_1',
      projector: 'wallet'
    });

    expect(db.queries[0].sql).toContain('update in_metering_projector_states');
    expect(db.queries[0].params).toContain('projected');
  });

  it('records shared retry metadata when a projector needs operator correction', async () => {
    const db = new MockSqlClient({
      rows: [{
        metering_event_id: 'meter_2',
        projector: 'earnings',
        state: 'needs_operator_correction',
        retry_count: 4
      }],
      rowCount: 1
    });
    const repo = new MeteringProjectorStateRepository(db);

    await repo.markNeedsOperatorCorrection({
      meteringEventId: 'meter_2',
      projector: 'earnings',
      retryCount: 4,
      lastAttemptAt: new Date('2026-03-19T22:00:00Z'),
      nextRetryAt: new Date('2026-03-19T22:30:00Z'),
      lastErrorCode: 'projection_failed',
      lastErrorMessage: 'wallet projection mismatch'
    });

    expect(db.queries[0].sql).toContain('update in_metering_projector_states');
    expect(db.queries[0].params).toContain('needs_operator_correction');
    expect(db.queries[0].params).toContain(4);
    expect(db.queries[0].params).toContain('projection_failed');
    expect(db.queries[0].params).toContain('wallet projection mismatch');
  });

  it('lists due pending projection rows for a projector', async () => {
    const db = new MockSqlClient({
      rows: [{
        metering_event_id: 'meter_3',
        projector: 'wallet',
        state: 'pending_projection'
      }],
      rowCount: 1
    });
    const repo = new MeteringProjectorStateRepository(db);

    const rows = await repo.listDueForProjector({
      projector: 'wallet',
      now: new Date('2026-03-20T12:00:00Z'),
      limit: 25
    });

    expect(rows).toHaveLength(1);
    expect(db.queries[0].sql).toContain('next_retry_at is null or next_retry_at <= $2');
    expect(db.queries[0].params).toEqual(['wallet', new Date('2026-03-20T12:00:00Z'), 25]);
  });

  it('schedules a retry while keeping the projector pending', async () => {
    const db = new MockSqlClient({
      rows: [{
        metering_event_id: 'meter_4',
        projector: 'wallet',
        state: 'pending_projection',
        retry_count: 2
      }],
      rowCount: 1
    });
    const repo = new MeteringProjectorStateRepository(db);

    await repo.markPendingRetry({
      meteringEventId: 'meter_4',
      projector: 'wallet',
      retryCount: 2,
      lastAttemptAt: new Date('2026-03-20T12:05:00Z'),
      nextRetryAt: new Date('2026-03-20T12:10:00Z'),
      lastErrorCode: 'projection_retry',
      lastErrorMessage: 'temporary failure'
    });

    expect(db.queries[0].sql).toContain('state = $3');
    expect(db.queries[0].params).toContain('pending_projection');
    expect(db.queries[0].params).toContain('projection_retry');
  });

  it('requeues a stuck wallet projector row for manual retry', async () => {
    const db = new MockSqlClient({
      rows: [{
        metering_event_id: 'meter_5',
        projector: 'wallet',
        state: 'pending_projection',
        retry_count: 0
      }],
      rowCount: 1
    });
    const repo = new MeteringProjectorStateRepository(db);

    await repo.requeueForRetry({
      meteringEventId: 'meter_5',
      projector: 'wallet'
    });

    expect(db.queries[0].sql).toContain('last_error_code = null');
    expect(db.queries[0].params).toContain('pending_projection');
  });
});
