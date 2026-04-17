import type { LiveLaneProjectorService } from '../services/liveLanes/liveLaneProjectorService.js';
import type { JobDefinition } from './types.js';

const DEFAULT_LIVE_LANE_PROJECTOR_POLL_MS = 30_000;
const DEFAULT_LIVE_LANE_PROJECTOR_BATCH_SIZE = 25;
const DEFAULT_LIVE_LANE_PROJECTOR_BACKFILL_LIMIT = 100;

function readPositiveIntEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

export function createLiveLaneProjectorJob(service: LiveLaneProjectorService): JobDefinition {
  const batchSize = readPositiveIntEnv(
    'LIVE_LANE_PROJECTOR_BATCH_SIZE',
    DEFAULT_LIVE_LANE_PROJECTOR_BATCH_SIZE
  );
  const backfillLimit = readPositiveIntEnv(
    'LIVE_LANE_PROJECTOR_BACKFILL_LIMIT',
    DEFAULT_LIVE_LANE_PROJECTOR_BACKFILL_LIMIT
  );

  return {
    name: 'live-lane-projector',
    scheduleMs: readPositiveIntEnv(
      'LIVE_LANE_PROJECTOR_POLL_MS',
      DEFAULT_LIVE_LANE_PROJECTOR_POLL_MS
    ),
    runOnStart: true,
    async run(ctx) {
      const result = await service.retryBacklog({
        limit: batchSize,
        backfillLimit
      });
      ctx.logger.info('live lane projector batch processed', {
        ...result,
        asOf: ctx.now.toISOString()
      });
    }
  };
}
