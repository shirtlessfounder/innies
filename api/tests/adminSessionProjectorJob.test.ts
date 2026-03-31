import { describe, expect, it } from 'vitest';
import type { AdminSessionProjectionOutboxRow } from '../src/repos/adminSessionProjectionOutboxRepository.js';
import { createAdminSessionProjectorJob } from '../src/jobs/adminSessionProjectorJob.js';
import { MockSqlClient, createLoggerSpy } from './testHelpers.js';
import { buildDefaultJobs } from '../src/jobs/registry.js';

function outboxRow(input?: Partial<AdminSessionProjectionOutboxRow>): AdminSessionProjectionOutboxRow {
  return {
    id: 'outbox_1',
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

describe('admin session projector job', () => {
  it('is registered in the default job list', () => {
    const jobs = buildDefaultJobs(new MockSqlClient());

    expect(jobs.some((job) => job.name === 'admin-session-projector')).toBe(true);
  });

  it('claims a bounded due batch and marks successful projections projected', async () => {
    const rows = [outboxRow(), outboxRow({ id: 'outbox_2', request_attempt_archive_id: 'archive_2' })];
    const calls: string[] = [];
    const job = createAdminSessionProjectorJob({
      projectorService: {
        async projectQueuedAttempt(row) {
          calls.push(row.request_attempt_archive_id);
          return {
            outcome: 'projected',
            sessionKey: `session:${row.request_attempt_archive_id}`,
            sessionType: 'cli',
            groupingBasis: 'idle_gap',
            wasNewAttempt: true
          };
        }
      },
      sessionProjectionOutboxRepo: {
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
    const job = createAdminSessionProjectorJob({
      projectorService: {
        async projectQueuedAttempt() {
          throw new Error('boom');
        }
      },
      sessionProjectionOutboxRepo: {
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
      lastError: 'boom'
    }]);
    expect(infoCalls.some((call) => call.message.includes('admin session projection retry scheduled'))).toBe(true);
  });

  it('moves rows to operator correction after the max retry threshold', async () => {
    const correctionCalls: Array<Record<string, unknown>> = [];
    const job = createAdminSessionProjectorJob({
      projectorService: {
        async projectQueuedAttempt() {
          throw new Error('permanent failure');
        }
      },
      sessionProjectionOutboxRepo: {
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
    expect(errorCalls.some((call) => call.message.includes('admin session projection requires operator correction'))).toBe(true);
  });
});
