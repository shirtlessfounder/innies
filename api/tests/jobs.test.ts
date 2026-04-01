import { describe, expect, it } from 'vitest';
import { createIdempotencyPurgeJob } from '../src/jobs/idempotencyPurgeJob.js';
import {
  createDailyAggregatesCompactionJob,
  createDailyAggregatesIncrementalJob
} from '../src/jobs/dailyAggregatesJob.js';
import { createReconciliationJob } from '../src/jobs/reconciliationJob.js';
import { AggregatesRepository } from '../src/repos/aggregatesRepository.js';
import { IdempotencyRepository } from '../src/repos/idempotencyRepository.js';
import { ReconciliationRepository } from '../src/repos/reconciliationRepository.js';
import { buildDefaultJobs } from '../src/jobs/registry.js';
import { MockSqlClient, createLoggerSpy } from './testHelpers.js';

describe('jobs', () => {
  it('runs idempotency purge hourly job', async () => {
    const db = new MockSqlClient({ rows: [], rowCount: 3 });
    const repo = new IdempotencyRepository(db);
    const job = createIdempotencyPurgeJob(repo);
    const { logger, infoCalls } = createLoggerSpy();

    await job.run({ now: new Date('2026-03-01T01:00:00Z'), logger });

    expect(job.scheduleMs).toBe(60 * 60 * 1000);
    expect(infoCalls[0].message).toContain('idempotency purge complete');
  });

  it('runs aggregate jobs', async () => {
    const db = new MockSqlClient({ rows: [], rowCount: 2 });
    const repo = new AggregatesRepository(db);
    const incremental = createDailyAggregatesIncrementalJob(repo);
    const compaction = createDailyAggregatesCompactionJob(repo, new Date('2026-03-02T01:15:00Z'));
    const { logger, infoCalls } = createLoggerSpy();

    await incremental.run({ now: new Date('2026-03-01T03:00:00Z'), logger });
    await compaction.run({ now: new Date('2026-03-02T03:00:00Z'), logger });

    expect(incremental.scheduleMs).toBe(5 * 60 * 1000);
    expect(compaction.scheduleMs).toBe(24 * 60 * 60 * 1000);
    expect(compaction.initialDelayMs).toBe(45 * 60 * 1000);
    expect(infoCalls).toHaveLength(2);
    expect(db.queries[0]?.sql).toContain("(created_at at time zone 'utc')::date");
  });

  it('runs reconciliation job at/after 02:00 UTC', async () => {
    const db = new MockSqlClient({ rows: [{ id: 'recon_1', status: 'ok', delta_pct: 0 }], rowCount: 1 });
    const repo = new ReconciliationRepository(db);
    const job = createReconciliationJob(repo, {
      async snapshot() {
        return [
          {
            provider: 'anthropic',
            expectedUnits: 1000,
            actualUnits: 998,
            deltaMinor: 24
          }
        ];
      }
    });

    const { logger, infoCalls } = createLoggerSpy();
    await job.run({ now: new Date('2026-03-01T02:10:00Z'), logger });

    expect(job.scheduleMs).toBe(60 * 60 * 1000);
    expect(infoCalls.some((call) => call.message.includes('reconciliation row written'))).toBe(true);
  });

  it('registers the admin session projector job by default', () => {
    const jobs = buildDefaultJobs(new MockSqlClient());

    expect(jobs.map((job) => job.name)).toContain('admin-session-projector');
  });

  it('registers the admin analysis projector job by default', () => {
    const jobs = buildDefaultJobs(new MockSqlClient());

    expect(jobs.map((job) => job.name)).toContain('admin-analysis-projector');
  });
});
