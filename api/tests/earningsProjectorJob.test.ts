import { describe, expect, it, vi } from 'vitest';
import { createEarningsProjectorJob } from '../src/jobs/earningsProjectorJob.js';
import { createLoggerSpy } from './testHelpers.js';

describe('createEarningsProjectorJob', () => {
  it('retries a bounded backlog batch and logs the result', async () => {
    const retryBacklog = vi.fn().mockResolvedValue({
      processed: 2,
      projected: 1,
      failed: 1
    });
    const { logger, infoCalls } = createLoggerSpy();
    const job = createEarningsProjectorJob({
      retryBacklog
    } as any);

    await job.run({
      now: new Date('2026-03-20T17:00:00Z'),
      logger
    });

    expect(retryBacklog).toHaveBeenCalledWith({ limit: 25 });
    expect(infoCalls).toEqual([{
      message: 'earnings projector batch processed',
      fields: {
        processed: 2,
        projected: 1,
        failed: 1
      }
    }]);
  });
});
