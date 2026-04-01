import { describe, expect, it } from 'vitest';
import type { AdminAnalysisProjectionOutboxRow } from '../src/repos/adminAnalysisProjectionOutboxRepository.js';
import { createAdminAnalysisProjectorJob } from '../src/jobs/adminAnalysisProjectorJob.js';
import { buildDefaultJobs } from '../src/jobs/registry.js';
import { MockSqlClient, createLoggerSpy } from './testHelpers.js';
import { RetryableProjectionDependencyError } from '../src/services/adminAnalysis/adminAnalysisProjectorService.js';

function outboxRow(input?: Partial<AdminAnalysisProjectionOutboxRow>): AdminAnalysisProjectionOutboxRow {
  return {
    id: 'analysis_outbox_1',
    request_attempt_archive_id: 'archive_1',
    request_id: 'req_1',
    attempt_no: 1,
    org_id: 'org_1',
    api_key_id: 'api_1',
    projection_state: 'pending_projection',
    retry_count: 0,
    next_attempt_at: '2026-03-31T22:00:00Z',
    last_attempted_at: null,
    processed_at: null,
    last_error: null,
    created_at: '2026-03-31T21:59:00Z',
    updated_at: '2026-03-31T21:59:00Z',
    ...input
  };
}

describe('admin analysis projector job', () => {
  it('is registered in the default job list', () => {
    const jobs = buildDefaultJobs(new MockSqlClient());

    expect(jobs.some((job) => job.name === 'admin-analysis-projector')).toBe(true);
  });

  it('claims a bounded due batch and marks successful projections projected', async () => {
    const rows = [outboxRow(), outboxRow({ id: 'analysis_outbox_2', request_attempt_archive_id: 'archive_2' })];
    const calls: string[] = [];
    const job = createAdminAnalysisProjectorJob({
      projectorService: {
        async projectQueuedAttempt(row) {
          calls.push(row.request_attempt_archive_id);
          return {
            sessionKey: `session:${row.request_attempt_archive_id}`,
            requestAttemptArchiveId: row.request_attempt_archive_id
          };
        }
      },
      analysisProjectionOutboxRepo: {
        async listDue(input) {
          expect(input.limit).toBe(2);
          return rows;
        },
        async markProjected(input) {
          calls.push(`projected:${input.requestAttemptArchiveId}`);
          return outboxRow({
            request_attempt_archive_id: input.requestAttemptArchiveId,
            projection_state: 'projected',
            processed_at: input.projectedAt.toISOString()
          });
        },
        async markPendingRetry() {
          throw new Error('should not retry successful projections');
        },
        async markNeedsOperatorCorrection() {
          throw new Error('should not escalate successful projections');
        }
      },
      batchSize: 2
    });
    const { logger } = createLoggerSpy();

    await job.run({ now: new Date('2026-03-31T22:10:00Z'), logger });

    expect(job.runOnStart).toBe(true);
    expect(calls).toEqual([
      'archive_1',
      'projected:archive_1',
      'archive_2',
      'projected:archive_2'
    ]);
  });

  it('schedules retries when projection fails below the max retry threshold', async () => {
    const retryCalls: Array<Record<string, unknown>> = [];
    const job = createAdminAnalysisProjectorJob({
      projectorService: {
        async projectQueuedAttempt() {
          throw new RetryableProjectionDependencyError('waiting for admin session projection');
        }
      },
      analysisProjectionOutboxRepo: {
        async listDue() {
          return [outboxRow({ retry_count: 1 })];
        },
        async markProjected() {
          throw new Error('should not mark projected on failure');
        },
        async markPendingRetry(input) {
          retryCalls.push(input as unknown as Record<string, unknown>);
          return outboxRow({
            request_attempt_archive_id: input.requestAttemptArchiveId,
            retry_count: input.retryCount,
            last_error: input.lastError,
            last_attempted_at: input.lastAttemptedAt.toISOString(),
            next_attempt_at: input.nextAttemptAt.toISOString()
          });
        },
        async markNeedsOperatorCorrection() {
          throw new Error('should not escalate before max retries');
        }
      },
      retryDelayMs: 15_000,
      maxRetries: 3
    });
    const { logger, infoCalls } = createLoggerSpy();
    const now = new Date('2026-03-31T22:10:00Z');

    await job.run({ now, logger });

    expect(retryCalls).toEqual([{
      requestAttemptArchiveId: 'archive_1',
      retryCount: 2,
      lastAttemptedAt: now,
      nextAttemptAt: new Date(now.getTime() + 15_000),
      lastError: 'waiting for admin session projection'
    }]);
    expect(infoCalls.some((call) => call.message.includes('admin analysis projection retry scheduled'))).toBe(true);
  });

  it('moves rows to operator correction after the max retry threshold', async () => {
    const correctionCalls: Array<Record<string, unknown>> = [];
    const job = createAdminAnalysisProjectorJob({
      projectorService: {
        async projectQueuedAttempt() {
          throw new Error('permanent failure');
        }
      },
      analysisProjectionOutboxRepo: {
        async listDue() {
          return [outboxRow({ retry_count: 2 })];
        },
        async markProjected() {
          throw new Error('should not mark projected on failure');
        },
        async markPendingRetry() {
          throw new Error('should not retry after max retries');
        },
        async markNeedsOperatorCorrection(input) {
          correctionCalls.push(input as unknown as Record<string, unknown>);
          return outboxRow({
            request_attempt_archive_id: input.requestAttemptArchiveId,
            projection_state: 'needs_operator_correction',
            retry_count: input.retryCount,
            last_error: input.lastError
          });
        }
      },
      maxRetries: 3
    });
    const { logger, errorCalls } = createLoggerSpy();
    const now = new Date('2026-03-31T22:10:00Z');

    await job.run({ now, logger });

    expect(correctionCalls).toEqual([{
      requestAttemptArchiveId: 'archive_1',
      retryCount: 3,
      lastAttemptedAt: now,
      lastError: 'permanent failure'
    }]);
    expect(errorCalls.some((call) => call.message.includes('admin analysis projection requires operator correction'))).toBe(true);
  });
});
