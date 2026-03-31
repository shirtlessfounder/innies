import type { AdminSessionProjectionOutboxRepository } from '../repos/adminSessionProjectionOutboxRepository.js';
import type { AdminSessionProjectorService } from '../services/adminArchive/adminSessionProjectorService.js';
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

export function createAdminSessionProjectorJob(input: {
  projectorService: Pick<AdminSessionProjectorService, 'projectQueuedAttempt'>;
  sessionProjectionOutboxRepo: Pick<
    AdminSessionProjectionOutboxRepository,
    'listDue' | 'markProjected' | 'markPendingRetry' | 'markNeedsOperatorCorrection'
  >;
  retryDelayMs?: number;
  maxRetries?: number;
  batchSize?: number;
}): JobDefinition {
  const retryDelayMs = input.retryDelayMs ?? readIntEnv('ADMIN_SESSION_PROJECTOR_RETRY_DELAY_MS', DEFAULT_RETRY_DELAY_MS);
  const maxRetries = input.maxRetries ?? readIntEnv('ADMIN_SESSION_PROJECTOR_MAX_RETRIES', DEFAULT_MAX_RETRIES);
  const batchSize = input.batchSize ?? readIntEnv('ADMIN_SESSION_PROJECTOR_BATCH_SIZE', DEFAULT_BATCH_SIZE);

  return {
    name: 'admin-session-projector',
    scheduleMs: readIntEnv('ADMIN_SESSION_PROJECTOR_SCHEDULE_MS', DEFAULT_SCHEDULE_MS),
    runOnStart: true,
    async run(ctx) {
      const rows = await input.sessionProjectionOutboxRepo.listDue({
        now: ctx.now,
        limit: batchSize
      });

      for (const row of rows) {
        try {
          await input.projectorService.projectQueuedAttempt(row);
          await input.sessionProjectionOutboxRepo.markProjected({
            requestAttemptArchiveId: row.request_attempt_archive_id,
            projectedAt: ctx.now
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'unknown error';
          const retryCount = row.retry_count + 1;

          if (retryCount >= maxRetries) {
            await input.sessionProjectionOutboxRepo.markNeedsOperatorCorrection({
              requestAttemptArchiveId: row.request_attempt_archive_id,
              retryCount,
              lastAttemptedAt: ctx.now,
              lastError: message
            });
            ctx.logger.error('admin session projection requires operator correction', {
              requestAttemptArchiveId: row.request_attempt_archive_id,
              retryCount,
              errorMessage: message
            });
            continue;
          }

          await input.sessionProjectionOutboxRepo.markPendingRetry({
            requestAttemptArchiveId: row.request_attempt_archive_id,
            retryCount,
            lastAttemptedAt: ctx.now,
            nextAttemptAt: new Date(ctx.now.getTime() + retryDelayMs),
            lastError: message
          });
          ctx.logger.info('admin session projection retry scheduled', {
            requestAttemptArchiveId: row.request_attempt_archive_id,
            retryCount,
            retryDelayMs
          });
        }
      }
    }
  };
}
