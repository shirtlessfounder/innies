import { describe, expect, it, vi } from 'vitest';
import { createLoggerSpy } from './testHelpers.js';
import { createWalletProjectorJob } from '../src/jobs/walletProjectorJob.js';

describe('walletProjectorJob', () => {
  it('projects due wallet events and leaves success rows marked projected by the service path', async () => {
    const listDueForProjector = vi.fn().mockResolvedValue([
      {
        metering_event_id: 'meter_1',
        projector: 'wallet',
        state: 'pending_projection',
        retry_count: 0
      }
    ]);
    const walletService = {
      projectMeteringEvent: vi.fn().mockResolvedValue(undefined)
    };
    const job = createWalletProjectorJob({
      walletService: walletService as any,
      meteringProjectorStateRepo: {
        listDueForProjector
      } as any
    });
    const { logger, errorCalls } = createLoggerSpy();

    await job.run({
      now: new Date('2026-03-20T12:00:00Z'),
      logger
    });

    expect(listDueForProjector).toHaveBeenCalledWith({
      projector: 'wallet',
      now: new Date('2026-03-20T12:00:00Z'),
      limit: 50
    });
    expect(walletService.projectMeteringEvent).toHaveBeenCalledWith('meter_1');
    expect(errorCalls).toHaveLength(0);
  });

  it('schedules retries for transient wallet projection failures', async () => {
    const markPendingRetry = vi.fn().mockResolvedValue(undefined);
    const walletService = {
      projectMeteringEvent: vi.fn().mockRejectedValue(new Error('temporary failure'))
    };
    const job = createWalletProjectorJob({
      walletService: walletService as any,
      meteringProjectorStateRepo: {
        listDueForProjector: vi.fn().mockResolvedValue([{
          metering_event_id: 'meter_2',
          projector: 'wallet',
          state: 'pending_projection',
          retry_count: 1
        }]),
        markPendingRetry
      } as any,
      maxRetries: 3,
      retryDelayMs: 60_000
    });
    const { logger } = createLoggerSpy();

    await job.run({
      now: new Date('2026-03-20T12:00:00Z'),
      logger
    });

    expect(markPendingRetry).toHaveBeenCalledWith(expect.objectContaining({
      meteringEventId: 'meter_2',
      projector: 'wallet',
      retryCount: 2,
      lastErrorCode: 'wallet_projection_failed',
      lastErrorMessage: 'temporary failure'
    }));
  });

  it('escalates repeated failures to operator correction', async () => {
    const markNeedsOperatorCorrection = vi.fn().mockResolvedValue(undefined);
    const walletService = {
      projectMeteringEvent: vi.fn().mockRejectedValue(new Error('permanent failure'))
    };
    const job = createWalletProjectorJob({
      walletService: walletService as any,
      meteringProjectorStateRepo: {
        listDueForProjector: vi.fn().mockResolvedValue([{
          metering_event_id: 'meter_3',
          projector: 'wallet',
          state: 'pending_projection',
          retry_count: 2
        }]),
        markNeedsOperatorCorrection
      } as any,
      maxRetries: 3,
      retryDelayMs: 60_000
    });
    const { logger } = createLoggerSpy();

    await job.run({
      now: new Date('2026-03-20T12:00:00Z'),
      logger
    });

    expect(markNeedsOperatorCorrection).toHaveBeenCalledWith(expect.objectContaining({
      meteringEventId: 'meter_3',
      projector: 'wallet',
      retryCount: 3,
      lastErrorCode: 'wallet_projection_failed',
      lastErrorMessage: 'permanent failure'
    }));
  });
});
