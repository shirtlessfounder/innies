import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { AdminAnalysisProjectionOutboxRepository } from '../repos/adminAnalysisProjectionOutboxRepository.js';
import { buildPgClient } from '../repos/pgClient.js';
import { readRequiredEnv } from '../utils/env.js';

export type AdminAnalysisBackfillWindow = '24h' | '7d' | '1m' | 'all';

type AdminAnalysisBackfillArgs = {
  window: AdminAnalysisBackfillWindow;
  batchSize: number;
  maxBatches?: number;
};

type AdminAnalysisBackfillLogger = {
  info: (message: string, fields?: Record<string, unknown>) => void;
};

const WINDOW_VALUES = new Set<AdminAnalysisBackfillWindow>(['24h', '7d', '1m', 'all']);

export function parseAdminAnalysisBackfillArgs(argv: string[]): AdminAnalysisBackfillArgs {
  const flags = readFlags(argv);
  const window = flags.window;
  if (!window) {
    throw new Error('Missing required --window');
  }
  if (!WINDOW_VALUES.has(window as AdminAnalysisBackfillWindow)) {
    throw new Error(`Invalid --window: ${window}`);
  }

  const batchSizeRaw = flags['batch-size'];
  const batchSize = Number(batchSizeRaw);
  if (!batchSizeRaw || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 2000) {
    throw new Error(`Invalid --batch-size: ${batchSizeRaw ?? ''}`);
  }

  const maxBatchesRaw = flags['max-batches'];
  const maxBatches = maxBatchesRaw == null ? undefined : Number(maxBatchesRaw);
  if (
    maxBatchesRaw != null
    && (!Number.isInteger(maxBatches) || (maxBatches as number) < 1)
  ) {
    throw new Error(`Invalid --max-batches: ${maxBatchesRaw}`);
  }

  return {
    window: window as AdminAnalysisBackfillWindow,
    batchSize,
    maxBatches
  };
}

export async function runAdminAnalysisBackfill(input: {
  outbox: Pick<AdminAnalysisProjectionOutboxRepository, 'enqueueMissingArchivedAttempts'>;
  window: AdminAnalysisBackfillWindow;
  batchSize: number;
  maxBatches?: number;
  now?: () => Date;
  log?: AdminAnalysisBackfillLogger;
}) {
  const now = input.now?.() ?? new Date();
  const bounds = resolveWindowBounds(input.window, now);
  const log = input.log ?? { info() {} };

  let batchesProcessed = 0;
  let insertedCount = 0;

  while (input.maxBatches == null || batchesProcessed < input.maxBatches) {
    const inserted = await input.outbox.enqueueMissingArchivedAttempts({
      start: bounds.start,
      end: bounds.end,
      limit: input.batchSize
    });
    batchesProcessed += 1;
    insertedCount += inserted;

    log.info('admin analysis backfill batch processed', {
      batchNumber: batchesProcessed,
      inserted,
      batchSize: input.batchSize,
      window: input.window,
      requestedWindow: serializeBounds(bounds)
    });

    if (inserted < input.batchSize) {
      break;
    }
  }

  return {
    window: input.window,
    requestedWindow: serializeBounds(bounds),
    batchSize: input.batchSize,
    batchesProcessed,
    insertedCount
  };
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseAdminAnalysisBackfillArgs(argv);
  const sql = buildPgClient(readRequiredEnv('DATABASE_URL'));

  try {
    const summary = await runAdminAnalysisBackfill({
      outbox: new AdminAnalysisProjectionOutboxRepository(sql),
      window: args.window,
      batchSize: args.batchSize,
      maxBatches: args.maxBatches,
      log: {
        info(message, fields) {
          // eslint-disable-next-line no-console
          console.log(`[admin-analysis-backfill] ${message}`, fields ?? {});
        }
      }
    });

    // eslint-disable-next-line no-console
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await sql.end();
  }
}

function readFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      continue;
    }

    const trimmed = value.slice(2);
    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex >= 0) {
      flags[trimmed.slice(0, equalsIndex)] = trimmed.slice(equalsIndex + 1);
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      flags[trimmed] = next;
      index += 1;
      continue;
    }

    flags[trimmed] = '';
  }

  return flags;
}

function resolveWindowBounds(window: AdminAnalysisBackfillWindow, now: Date): {
  start: Date;
  end: Date;
} {
  switch (window) {
    case '24h':
      return { start: new Date(now.getTime() - 24 * 60 * 60 * 1000), end: now };
    case '7d':
      return { start: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), end: now };
    case '1m':
      return { start: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000), end: now };
    case 'all':
      return { start: new Date(0), end: now };
  }
}

function serializeBounds(bounds: { start: Date; end: Date }) {
  return {
    start: bounds.start.toISOString(),
    end: bounds.end.toISOString()
  };
}

function shouldAutoRun(input: {
  moduleUrl: string;
  entryArgv?: string;
}): boolean {
  if (!input.entryArgv) {
    return false;
  }
  return pathToFileURL(input.entryArgv).href === input.moduleUrl;
}

if (shouldAutoRun({
  moduleUrl: import.meta.url,
  entryArgv: process.argv[1]
})) {
  main().catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : 'Unexpected error');
    process.exitCode = 1;
  });
}
