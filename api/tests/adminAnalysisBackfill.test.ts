import { describe, expect, it, vi } from 'vitest';
import {
  parseAdminAnalysisBackfillArgs,
  runAdminAnalysisBackfill
} from '../src/scripts/adminAnalysisBackfill.js';

describe('adminAnalysisBackfill', () => {
  it('validates the command-line contract for window, batch size, and max batches', () => {
    expect(parseAdminAnalysisBackfillArgs([
      '--window=7d',
      '--batch-size=200',
      '--max-batches=3'
    ])).toEqual({
      window: '7d',
      batchSize: 200,
      maxBatches: 3
    });

    expect(() => parseAdminAnalysisBackfillArgs([])).toThrow('Missing required --window');
    expect(() => parseAdminAnalysisBackfillArgs(['--window=weird', '--batch-size=200'])).toThrow('Invalid --window');
    expect(() => parseAdminAnalysisBackfillArgs(['--window=7d', '--batch-size=0'])).toThrow('Invalid --batch-size');
    expect(() => parseAdminAnalysisBackfillArgs(['--window=7d', '--batch-size=200', '--max-batches=0'])).toThrow('Invalid --max-batches');
  });

  it('scans archived attempts in bounded batches until the window is exhausted', async () => {
    const outbox = {
      requeueWaitingForSessionProjection: vi.fn().mockResolvedValue(3),
      enqueueMissingArchivedAttempts: vi.fn()
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(0)
    };

    const result = await runAdminAnalysisBackfill({
      outbox,
      now: () => new Date('2026-03-31T12:00:00Z'),
      window: '7d',
      batchSize: 2,
      log: {
        info: vi.fn()
      }
    });

    expect(outbox.requeueWaitingForSessionProjection).toHaveBeenCalledTimes(1);
    expect(outbox.requeueWaitingForSessionProjection).toHaveBeenCalledWith({
      start: new Date('2026-03-24T12:00:00Z'),
      end: new Date('2026-03-31T12:00:00Z'),
      limit: 2
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
      requeuedCount: 3,
      batchesProcessed: 3,
      insertedCount: 4
    });
  });

  it('respects max-batches for restart-safe incremental replay', async () => {
    const outbox = {
      requeueWaitingForSessionProjection: vi.fn().mockResolvedValue(0),
      enqueueMissingArchivedAttempts: vi.fn()
        .mockResolvedValueOnce(200)
        .mockResolvedValueOnce(200)
    };

    const result = await runAdminAnalysisBackfill({
      outbox,
      now: () => new Date('2026-03-31T12:00:00Z'),
      window: '24h',
      batchSize: 200,
      maxBatches: 1,
      log: {
        info: vi.fn()
      }
    });

    expect(outbox.enqueueMissingArchivedAttempts).toHaveBeenCalledTimes(1);
    expect(result.batchesProcessed).toBe(1);
    expect(result.insertedCount).toBe(200);
    expect(result.requeuedCount).toBe(0);
  });
});
