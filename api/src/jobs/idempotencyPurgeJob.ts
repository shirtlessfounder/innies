import { IdempotencyRepository } from '../repos/idempotencyRepository.js';
import type { JobDefinition } from './types.js';

const HOUR_MS = 60 * 60 * 1000;

export function createIdempotencyPurgeJob(repo: IdempotencyRepository): JobDefinition {
  return {
    name: 'idempotency-purge-hourly',
    scheduleMs: HOUR_MS,
    async run(ctx) {
      const result = await repo.purgeExpired(ctx.now);
      ctx.logger.info('idempotency purge complete', {
        deletedCount: result.deletedCount,
        asOf: ctx.now.toISOString()
      });
    }
  };
}
