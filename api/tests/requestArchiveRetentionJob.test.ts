import { describe, expect, it } from 'vitest';
import {
  createRequestArchiveRetentionJob,
  type RequestArchiveRetentionRepo
} from '../src/jobs/requestArchiveRetentionJob.js';
import { createLoggerSpy } from './testHelpers.js';

type CallLog = {
  name: string;
  args: unknown;
};

function createRepoSpy(batchResults: Record<string, number[]>): {
  repo: RequestArchiveRetentionRepo;
  calls: CallLog[];
} {
  const calls: CallLog[] = [];
  const pop = (key: string): number => {
    const next = batchResults[key]?.shift();
    return typeof next === 'number' ? next : 0;
  };
  const repo: RequestArchiveRetentionRepo = {
    async deleteArchivesOlderThan(input) {
      calls.push({ name: 'deleteArchivesOlderThan', args: input });
      return { deletedCount: pop('deleteArchivesOlderThan') };
    },
    async sweepOrphanedRawBlobs(input) {
      calls.push({ name: 'sweepOrphanedRawBlobs', args: input });
      return { deletedCount: pop('sweepOrphanedRawBlobs') };
    },
    async sweepOrphanedMessageBlobs(input) {
      calls.push({ name: 'sweepOrphanedMessageBlobs', args: input });
      return { deletedCount: pop('sweepOrphanedMessageBlobs') };
    },
    async purgeProjectedSessionOutbox(input) {
      calls.push({ name: 'purgeProjectedSessionOutbox', args: input });
      return { deletedCount: pop('purgeProjectedSessionOutbox') };
    },
    async purgeProjectedAnalysisOutbox(input) {
      calls.push({ name: 'purgeProjectedAnalysisOutbox', args: input });
      return { deletedCount: pop('purgeProjectedAnalysisOutbox') };
    }
  };
  return { repo, calls };
}

function withEnv<T>(values: Record<string, string | undefined>, run: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(values)) {
    prev[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, prior] of Object.entries(prev)) {
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
  }
}

describe('createRequestArchiveRetentionJob', () => {
  it('runs hourly with the correct job name', () => {
    const { repo } = createRepoSpy({});
    const job = createRequestArchiveRetentionJob(repo);

    expect(job.name).toBe('request-archive-retention-hourly');
    expect(job.scheduleMs).toBe(60 * 60 * 1000);
  });

  it('defaults retention to 30 days for archives and 7 days for projected outboxes', async () => {
    const { repo, calls } = createRepoSpy({
      deleteArchivesOlderThan: [0],
      sweepOrphanedRawBlobs: [0],
      sweepOrphanedMessageBlobs: [0],
      purgeProjectedSessionOutbox: [0],
      purgeProjectedAnalysisOutbox: [0]
    });
    const job = createRequestArchiveRetentionJob(repo);
    const { logger, infoCalls } = createLoggerSpy();
    const now = new Date('2026-04-17T21:00:00Z');

    await withEnv(
      {
        REQUEST_ARCHIVE_RETENTION_DAYS: undefined,
        REQUEST_ARCHIVE_OUTBOX_RETENTION_DAYS: undefined
      },
      () => job.run({ now, logger })
    );

    const archiveCall = calls.find((c) => c.name === 'deleteArchivesOlderThan');
    expect(archiveCall).toBeDefined();
    const archiveCutoff = (archiveCall!.args as { cutoff: Date }).cutoff;
    expect(archiveCutoff.toISOString()).toBe('2026-03-18T21:00:00.000Z');

    const sessionCall = calls.find((c) => c.name === 'purgeProjectedSessionOutbox');
    expect(sessionCall).toBeDefined();
    const sessionCutoff = (sessionCall!.args as { cutoff: Date }).cutoff;
    expect(sessionCutoff.toISOString()).toBe('2026-04-10T21:00:00.000Z');

    expect(infoCalls.at(-1)?.message).toContain('request archive retention complete');
  });

  it('respects REQUEST_ARCHIVE_RETENTION_DAYS and REQUEST_ARCHIVE_OUTBOX_RETENTION_DAYS env overrides', async () => {
    const { repo, calls } = createRepoSpy({
      deleteArchivesOlderThan: [0],
      sweepOrphanedRawBlobs: [0],
      sweepOrphanedMessageBlobs: [0],
      purgeProjectedSessionOutbox: [0],
      purgeProjectedAnalysisOutbox: [0]
    });
    const job = createRequestArchiveRetentionJob(repo);
    const { logger } = createLoggerSpy();
    const now = new Date('2026-04-17T00:00:00Z');

    await withEnv(
      {
        REQUEST_ARCHIVE_RETENTION_DAYS: '3',
        REQUEST_ARCHIVE_OUTBOX_RETENTION_DAYS: '1'
      },
      () => job.run({ now, logger })
    );

    const archiveCutoff = (calls.find((c) => c.name === 'deleteArchivesOlderThan')!.args as { cutoff: Date }).cutoff;
    expect(archiveCutoff.toISOString()).toBe('2026-04-14T00:00:00.000Z');

    const sessionCutoff = (calls.find((c) => c.name === 'purgeProjectedSessionOutbox')!.args as { cutoff: Date }).cutoff;
    expect(sessionCutoff.toISOString()).toBe('2026-04-16T00:00:00.000Z');
  });

  it('keeps looping delete batches until a short batch is returned, capped at maxBatches', async () => {
    const { repo, calls } = createRepoSpy({
      // 3 full batches, then 2 less-than-full → loop exits on first short batch
      deleteArchivesOlderThan: [5000, 5000, 5000, 37],
      sweepOrphanedRawBlobs: [0],
      sweepOrphanedMessageBlobs: [0],
      purgeProjectedSessionOutbox: [0],
      purgeProjectedAnalysisOutbox: [0]
    });
    const job = createRequestArchiveRetentionJob(repo, { batchSize: 5000, maxBatchesPerPhase: 50 });
    const { logger, infoCalls } = createLoggerSpy();

    await job.run({ now: new Date('2026-04-17T00:00:00Z'), logger });

    const archiveCalls = calls.filter((c) => c.name === 'deleteArchivesOlderThan');
    expect(archiveCalls).toHaveLength(4);

    const summary = infoCalls.at(-1)?.fields as Record<string, number>;
    expect(summary.deletedArchives).toBe(15037);
  });

  it('stops each phase at maxBatchesPerPhase even if rows remain', async () => {
    const { repo, calls } = createRepoSpy({
      deleteArchivesOlderThan: [5000, 5000, 5000, 5000, 5000],
      sweepOrphanedRawBlobs: [0],
      sweepOrphanedMessageBlobs: [0],
      purgeProjectedSessionOutbox: [0],
      purgeProjectedAnalysisOutbox: [0]
    });
    const job = createRequestArchiveRetentionJob(repo, { batchSize: 5000, maxBatchesPerPhase: 2 });
    const { logger } = createLoggerSpy();

    await job.run({ now: new Date('2026-04-17T00:00:00Z'), logger });

    const archiveCalls = calls.filter((c) => c.name === 'deleteArchivesOlderThan');
    expect(archiveCalls).toHaveLength(2);
  });

  it('runs archive deletes before orphan sweeps so dangling blobs are reachable', async () => {
    const { repo, calls } = createRepoSpy({
      deleteArchivesOlderThan: [1],
      sweepOrphanedRawBlobs: [1],
      sweepOrphanedMessageBlobs: [1],
      purgeProjectedSessionOutbox: [1],
      purgeProjectedAnalysisOutbox: [1]
    });
    const job = createRequestArchiveRetentionJob(repo);
    const { logger } = createLoggerSpy();

    await job.run({ now: new Date('2026-04-17T00:00:00Z'), logger });

    const names = calls.map((c) => c.name);
    expect(names.indexOf('deleteArchivesOlderThan')).toBeLessThan(names.indexOf('sweepOrphanedRawBlobs'));
    expect(names.indexOf('deleteArchivesOlderThan')).toBeLessThan(names.indexOf('sweepOrphanedMessageBlobs'));
  });
});
