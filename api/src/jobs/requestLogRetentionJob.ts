import { RequestLogRepository } from '../repos/requestLogRepository.js';
import type { JobDefinition } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export function readRequestLogRetentionDays(): number | null {
  const raw = process.env.REQUEST_LOG_RETENTION_DAYS;
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

export function createRequestLogRetentionJob(
  repo: RequestLogRepository,
  retentionDays: number
): JobDefinition {
  return {
    name: 'request-log-retention-daily',
    scheduleMs: DAY_MS,
    async run(ctx) {
      const result = await repo.purgeOlderThan(retentionDays, ctx.now);
      ctx.logger.info('request log retention complete', {
        deletedCount: result.deletedCount,
        retentionDays,
        asOf: ctx.now.toISOString()
      });
    }
  };
}
