import { AggregatesRepository } from '../repos/aggregatesRepository.js';
import type { JobDefinition } from './types.js';

const FIVE_MIN_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function toUtcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function createDailyAggregatesIncrementalJob(repo: AggregatesRepository): JobDefinition {
  return {
    name: 'daily-aggregates-incremental-5m',
    scheduleMs: FIVE_MIN_MS,
    async run(ctx) {
      const since = new Date(ctx.now.getTime() - FIVE_MIN_MS * 3);
      const result = await repo.incrementalUpdate(since);
      ctx.logger.info('daily aggregate incremental update complete', {
        since: since.toISOString(),
        upsertedRows: result.upsertedRows
      });
    }
  };
}

export function createDailyAggregatesCompactionJob(repo: AggregatesRepository): JobDefinition {
  return {
    name: 'daily-aggregates-nightly-compaction',
    scheduleMs: DAY_MS,
    async run(ctx) {
      const yesterday = new Date(ctx.now.getTime() - DAY_MS);
      const result = await repo.compactDay(toUtcDateString(yesterday));
      ctx.logger.info('daily aggregate compaction complete', {
        day: toUtcDateString(yesterday),
        compactedDays: result.compactedDays
      });
    }
  };
}
