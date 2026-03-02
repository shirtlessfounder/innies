import { ReconciliationRepository } from '../repos/reconciliationRepository.js';
import type { JobDefinition } from './types.js';

const HOUR_MS = 60 * 60 * 1000;

function toUtcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isAfterTwoUtc(date: Date): boolean {
  return date.getUTCHours() >= 2;
}

export type ReconciliationProviderSnapshot = {
  provider: string;
  expectedUnits: number;
  actualUnits: number;
  deltaMinor?: number;
  notes?: string;
};

export type ReconciliationDataSource = {
  snapshot(runDate: string): Promise<ReconciliationProviderSnapshot[]>;
};

export function createReconciliationJob(
  repo: ReconciliationRepository,
  source: ReconciliationDataSource
): JobDefinition {
  let lastRunDate: string | null = null;

  return {
    name: 'reconciliation-daily-0200-utc',
    scheduleMs: HOUR_MS,
    async run(ctx) {
      const runDate = toUtcDateString(ctx.now);
      if (!isAfterTwoUtc(ctx.now) || lastRunDate === runDate) {
        ctx.logger.info('reconciliation skipped (window not open or already processed)', { now: ctx.now.toISOString() });
        return;
      }
      const snapshots = await source.snapshot(runDate);

      for (const snapshot of snapshots) {
        const saved = await repo.upsertRun({
          runDate,
          provider: snapshot.provider,
          expectedUnits: snapshot.expectedUnits,
          actualUnits: snapshot.actualUnits,
          deltaMinor: snapshot.deltaMinor,
          notes: snapshot.notes
        });

        ctx.logger.info('reconciliation row written', {
          provider: snapshot.provider,
          status: saved.status,
          deltaPct: saved.deltaPct
        });
      }

      lastRunDate = runDate;
    }
  };
}
