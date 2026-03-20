import type { MeteringProjectorStateRepository } from '../repos/meteringProjectorStateRepository.js';
import type { WalletService } from '../services/wallet/walletService.js';
import type { JobDefinition } from './types.js';

const DEFAULT_SCHEDULE_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 60_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BATCH_SIZE = 50;

function readIntEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

export function createWalletProjectorJob(input: {
  walletService: Pick<WalletService, 'projectMeteringEvent'>;
  meteringProjectorStateRepo: Pick<
    MeteringProjectorStateRepository,
    'listDueForProjector' | 'markPendingRetry' | 'markNeedsOperatorCorrection'
  >;
  retryDelayMs?: number;
  maxRetries?: number;
}): JobDefinition {
  const retryDelayMs = input.retryDelayMs ?? readIntEnv('WALLET_PROJECTOR_RETRY_DELAY_MS', DEFAULT_RETRY_DELAY_MS);
  const maxRetries = input.maxRetries ?? readIntEnv('WALLET_PROJECTOR_MAX_RETRIES', DEFAULT_MAX_RETRIES);

  return {
    name: 'wallet-projector',
    scheduleMs: readIntEnv('WALLET_PROJECTOR_SCHEDULE_MS', DEFAULT_SCHEDULE_MS),
    runOnStart: true,
    async run(ctx) {
      const rows = await input.meteringProjectorStateRepo.listDueForProjector({
        projector: 'wallet',
        now: ctx.now,
        limit: DEFAULT_BATCH_SIZE
      });

      for (const row of rows) {
        try {
          await input.walletService.projectMeteringEvent(row.metering_event_id);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'unknown error';
          const retryCount = row.retry_count + 1;

          if (retryCount >= maxRetries) {
            await input.meteringProjectorStateRepo.markNeedsOperatorCorrection({
              meteringEventId: row.metering_event_id,
              projector: 'wallet',
              retryCount,
              lastAttemptAt: ctx.now,
              nextRetryAt: null,
              lastErrorCode: 'wallet_projection_failed',
              lastErrorMessage: message
            });
            ctx.logger.error('wallet projection requires operator correction', {
              meteringEventId: row.metering_event_id,
              retryCount,
              errorMessage: message
            });
            continue;
          }

          await input.meteringProjectorStateRepo.markPendingRetry({
            meteringEventId: row.metering_event_id,
            projector: 'wallet',
            retryCount,
            lastAttemptAt: ctx.now,
            nextRetryAt: new Date(ctx.now.getTime() + retryDelayMs),
            lastErrorCode: 'wallet_projection_failed',
            lastErrorMessage: message
          });
          ctx.logger.info('wallet projection retry scheduled', {
            meteringEventId: row.metering_event_id,
            retryCount,
            retryDelayMs
          });
        }
      }
    }
  };
}
