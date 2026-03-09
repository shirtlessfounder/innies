import { AggregatesRepository } from '../repos/aggregatesRepository.js';
import type { JobDefinition } from './types.js';

const FIVE_MIN_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const COMPACTION_UTC_HOUR = 2;

function toUtcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function msUntilNextUtcHour(now: Date, utcHour: number): number {
  const next = new Date(now);
  next.setUTCHours(utcHour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.getTime() - now.getTime();
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

export function createDailyAggregatesCompactionJob(
  repo: AggregatesRepository,
  now: Date = new Date()
): JobDefinition {
  return {
    name: 'daily-aggregates-nightly-compaction',
    scheduleMs: DAY_MS,
    initialDelayMs: msUntilNextUtcHour(now, COMPACTION_UTC_HOUR),
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
