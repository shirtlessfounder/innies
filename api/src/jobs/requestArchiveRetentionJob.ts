import type {
  RetentionBatchResult,
  RetentionCutoffInput,
  RetentionSweepInput
} from '../repos/requestArchiveRetentionRepository.js';
import type { JobDefinition, JobRunContext } from './types.js';

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_ARCHIVE_RETENTION_DAYS = 30;
const DEFAULT_OUTBOX_RETENTION_DAYS = 7;
const DEFAULT_BATCH_SIZE = 5000;
const DEFAULT_MAX_BATCHES_PER_PHASE = 10;

export type RequestArchiveRetentionRepo = {
  deleteArchivesOlderThan(input: RetentionCutoffInput): Promise<RetentionBatchResult>;
  sweepOrphanedRawBlobs(input: RetentionSweepInput): Promise<RetentionBatchResult>;
  sweepOrphanedMessageBlobs(input: RetentionSweepInput): Promise<RetentionBatchResult>;
  purgeProjectedSessionOutbox(input: RetentionCutoffInput): Promise<RetentionBatchResult>;
  purgeProjectedAnalysisOutbox(input: RetentionCutoffInput): Promise<RetentionBatchResult>;
};

export type RequestArchiveRetentionJobOptions = {
  batchSize?: number;
  maxBatchesPerPhase?: number;
};

function readPositiveIntEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function subtractDays(now: Date, days: number): Date {
  const result = new Date(now.getTime());
  result.setUTCDate(result.getUTCDate() - days);
  return result;
}

async function runCutoffPhase(
  phase: string,
  cutoff: Date,
  batchSize: number,
  maxBatches: number,
  logger: JobRunContext['logger'],
  run: (input: RetentionCutoffInput) => Promise<RetentionBatchResult>
): Promise<number> {
  let total = 0;
  for (let i = 0; i < maxBatches; i += 1) {
    const batch = await run({ cutoff, batchSize });
    total += batch.deletedCount;
    if (batch.deletedCount < batchSize) {
      return total;
    }
  }
  logger.info('request archive retention phase hit batch cap', {
    phase,
    totalDeleted: total,
    maxBatches,
    batchSize
  });
  return total;
}

async function runSweepPhase(
  phase: string,
  batchSize: number,
  maxBatches: number,
  logger: JobRunContext['logger'],
  run: (input: RetentionSweepInput) => Promise<RetentionBatchResult>
): Promise<number> {
  let total = 0;
  for (let i = 0; i < maxBatches; i += 1) {
    const batch = await run({ batchSize });
    total += batch.deletedCount;
    if (batch.deletedCount < batchSize) {
      return total;
    }
  }
  logger.info('request archive retention phase hit batch cap', {
    phase,
    totalDeleted: total,
    maxBatches,
    batchSize
  });
  return total;
}

export function createRequestArchiveRetentionJob(
  repo: RequestArchiveRetentionRepo,
  options: RequestArchiveRetentionJobOptions = {}
): JobDefinition {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxBatches = options.maxBatchesPerPhase ?? DEFAULT_MAX_BATCHES_PER_PHASE;

  return {
    name: 'request-archive-retention-hourly',
    scheduleMs: HOUR_MS,
    async run(ctx) {
      const archiveDays = readPositiveIntEnv(
        'REQUEST_ARCHIVE_RETENTION_DAYS',
        DEFAULT_ARCHIVE_RETENTION_DAYS
      );
      const outboxDays = readPositiveIntEnv(
        'REQUEST_ARCHIVE_OUTBOX_RETENTION_DAYS',
        DEFAULT_OUTBOX_RETENTION_DAYS
      );
      const archiveCutoff = subtractDays(ctx.now, archiveDays);
      const outboxCutoff = subtractDays(ctx.now, outboxDays);

      // Order matters: delete archives first so cascading link rows free up
      // raw/message blob references, then sweep orphans. Outbox purges are
      // independent and can run last.
      const deletedArchives = await runCutoffPhase(
        'deleteArchivesOlderThan',
        archiveCutoff,
        batchSize,
        maxBatches,
        ctx.logger,
        (input) => repo.deleteArchivesOlderThan(input)
      );
      const deletedRawOrphans = await runSweepPhase(
        'sweepOrphanedRawBlobs',
        batchSize,
        maxBatches,
        ctx.logger,
        (input) => repo.sweepOrphanedRawBlobs(input)
      );
      const deletedMessageOrphans = await runSweepPhase(
        'sweepOrphanedMessageBlobs',
        batchSize,
        maxBatches,
        ctx.logger,
        (input) => repo.sweepOrphanedMessageBlobs(input)
      );
      const deletedSessionOutbox = await runCutoffPhase(
        'purgeProjectedSessionOutbox',
        outboxCutoff,
        batchSize,
        maxBatches,
        ctx.logger,
        (input) => repo.purgeProjectedSessionOutbox(input)
      );
      const deletedAnalysisOutbox = await runCutoffPhase(
        'purgeProjectedAnalysisOutbox',
        outboxCutoff,
        batchSize,
        maxBatches,
        ctx.logger,
        (input) => repo.purgeProjectedAnalysisOutbox(input)
      );

      ctx.logger.info('request archive retention complete', {
        archiveRetentionDays: archiveDays,
        outboxRetentionDays: outboxDays,
        archiveCutoff: archiveCutoff.toISOString(),
        outboxCutoff: outboxCutoff.toISOString(),
        deletedArchives,
        deletedRawOrphans,
        deletedMessageOrphans,
        deletedSessionOutbox,
        deletedAnalysisOutbox,
        asOf: ctx.now.toISOString()
      });
    }
  };
}
