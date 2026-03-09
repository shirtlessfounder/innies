import { RequestLogRepository } from '../repos/requestLogRepository.js';
import type { JobDefinition } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function readRetentionDays(): number {
  const raw = process.env.REQUEST_LOG_RETENTION_DAYS;
  const parsed = raw ? Number(raw) : 30;
  if (!Number.isFinite(parsed) || parsed <= 0) return 30;
  return Math.floor(parsed);
}

export function createRequestLogRetentionJob(repo: RequestLogRepository): JobDefinition {
  return {
    name: 'request-log-retention-daily',
    scheduleMs: DAY_MS,
    async run(ctx) {
      const retentionDays = readRetentionDays();
      const result = await repo.purgeOlderThan(retentionDays, ctx.now);
      ctx.logger.info('request log retention complete', {
        deletedCount: result.deletedCount,
        retentionDays,
        asOf: ctx.now.toISOString()
      });
    }
  };
}
