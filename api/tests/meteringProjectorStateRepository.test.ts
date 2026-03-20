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
});
