import { describe, expect, it, vi } from 'vitest';
import {
  parseAdminSessionBackfillArgs,
  runAdminSessionBackfill
} from '../src/scripts/adminSessionBackfill.js';

describe('adminSessionBackfill', () => {
  it('validates the command-line contract for window, batch size, and max batches', () => {
    expect(parseAdminSessionBackfillArgs([
      '--window=7d',
      '--batch-size=200',
      '--max-batches=3'
    ])).toEqual({
      window: '7d',
      batchSize: 200,
      maxBatches: 3
    });

    expect(() => parseAdminSessionBackfillArgs([])).toThrow('Missing required --window');
    expect(() => parseAdminSessionBackfillArgs(['--window=weird', '--batch-size=200'])).toThrow('Invalid --window');
    expect(() => parseAdminSessionBackfillArgs(['--window=7d', '--batch-size=0'])).toThrow('Invalid --batch-size');
    expect(() => parseAdminSessionBackfillArgs(['--window=7d', '--batch-size=200', '--max-batches=0'])).toThrow('Invalid --max-batches');
  });

  it('scans archived attempts in bounded batches until the session-backed window is exhausted', async () => {
    const outbox = {
      enqueueMissingArchivedAttempts: vi.fn()
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(0)
    };

    const result = await runAdminSessionBackfill({
      outbox,
      now: () => new Date('2026-03-31T12:00:00Z'),
      window: '7d',
      batchSize: 2,
      log: {
        info: vi.fn()
      }
    });

    expect(outbox.enqueueMissingArchivedAttempts).toHaveBeenCalledTimes(3);
    expect(outbox.enqueueMissingArchivedAttempts).toHaveBeenNthCalledWith(1, {
      start: new Date('2026-03-24T12:00:00Z'),
      end: new Date('2026-03-31T12:00:00Z'),
      limit: 2
    });
    expect(result).toEqual({
      window: '7d',
      requestedWindow: {
        start: '2026-03-24T12:00:00.000Z',
        end: '2026-03-31T12:00:00.000Z'
      },
      batchSize: 2,
      batchesProcessed: 3,
      insertedCount: 4
    });
  });
});
