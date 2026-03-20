import type { EarningsProjectorService } from '../services/earnings/earningsProjectorService.js';
import type { JobDefinition } from './types.js';

const DEFAULT_EARNINGS_PROJECTOR_POLL_MS = 60_000;
const DEFAULT_EARNINGS_PROJECTOR_BATCH_SIZE = 25;

function readPositiveIntEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

export function createEarningsProjectorJob(service: EarningsProjectorService): JobDefinition {
  const batchSize = readPositiveIntEnv('EARNINGS_PROJECTOR_BATCH_SIZE', DEFAULT_EARNINGS_PROJECTOR_BATCH_SIZE);

  return {
    name: 'earnings-projector-minute',
    scheduleMs: readPositiveIntEnv('EARNINGS_PROJECTOR_POLL_MS', DEFAULT_EARNINGS_PROJECTOR_POLL_MS),
    async run(ctx) {
      const result = await service.retryBacklog({ limit: batchSize });
      ctx.logger.info('earnings projector batch processed', result);
    }
  };
}
