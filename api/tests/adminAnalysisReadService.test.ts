import { describe, expect, it } from 'vitest';
import { AppError } from '../src/utils/errors.js';
import { AdminAnalysisReadService } from '../src/services/adminAnalysis/adminAnalysisReadService.js';

describe('AdminAnalysisReadService', () => {
  it('adds previous-window comparison blocks for finite windows', async () => {
    const overviewCalls: Array<Record<string, unknown>> = [];
    const service = new AdminAnalysisReadService({
      now: () => new Date('2026-03-31T12:00:00Z'),
      queries: {
        async getOverview(input) {
          overviewCalls.push(input as unknown as Record<string, unknown>);
          if (overviewCalls.length === 1) {
            return {
              totals: { totalRequests: 12, totalSessions: 5, totalTokens: 3400 },
              categoryMix: [{ taskCategory: 'debugging', count: 7 }],
              tagHighlights: [{ tag: 'postgres', count: 4 }],
              signalCounts: { retryCount: 2, failureCount: 1 }
            };
          }
          return {
            totals: { totalRequests: 9, totalSessions: 4, totalTokens: 2500 },
            categoryMix: [{ taskCategory: 'debugging', count: 5 }],
            tagHighlights: [{ tag: 'postgres', count: 2 }],
            signalCounts: { retryCount: 1, failureCount: 0 }
          };
        },
        async getCoverage() {
          return {
            projectedRequestCount: 12,
            pendingProjectionCount: 0,
            firstProjectedAt: '2026-03-24T00:00:00Z',
            lastProjectedAt: '2026-03-31T00:00:00Z'
          };
        }
      }
    });

    const result = await service.getOverview({
      window: '7d',
      compare: 'prev'
    });

    expect(overviewCalls).toHaveLength(2);
    expect(result.comparison).toEqual(expect.objectContaining({
      previousWindow: {
        start: '2026-03-17T12:00:00.000Z',
        end: '2026-03-24T12:00:00.000Z'
      },
      totals: {
        totalRequests: 9,
        totalSessions: 4,
        totalTokens: 2500
      },
      deltas: {
        totalRequests: 3,
        totalSessions: 1,
        totalTokens: 900
      }
    }));
    expect(result.coverage.isComplete).toBe(true);
  });

  it('rejects compare=prev for the all window', async () => {
    const service = new AdminAnalysisReadService({
      queries: {
        async getOverview() {
          throw new Error('should not query on invalid compare');
        },
        async getCoverage() {
          throw new Error('should not query on invalid compare');
        }
      }
    });

    await expect(service.getOverview({
      window: 'all',
      compare: 'prev'
    })).rejects.toBeInstanceOf(AppError);
  });

  it('adds coverage metadata to request and session sample responses', async () => {
    const service = new AdminAnalysisReadService({
      now: () => new Date('2026-03-31T12:00:00Z'),
      queries: {
        async listRequestSamples() {
          return [{ request_attempt_archive_id: 'archive_1' }];
        },
        async listSessionSamples() {
          return [{ session_key: 'openclaw:session:sess_1' }];
        },
        async getCoverage() {
          return {
            projectedRequestCount: 42,
            pendingProjectionCount: 3,
            firstProjectedAt: '2026-03-24T00:00:00Z',
            lastProjectedAt: '2026-03-31T00:00:00Z'
          };
        }
      }
    });

    const requestSamples = await service.getRequestSamples({
      window: '24h',
      sampleSize: 10
    });
    const sessionSamples = await service.getSessionSamples({
      window: '24h',
      sampleSize: 10
    });

    expect(requestSamples.samples).toEqual([{ request_attempt_archive_id: 'archive_1' }]);
    expect(requestSamples.coverage.pendingProjectionCount).toBe(3);
    expect(requestSamples.coverage.isComplete).toBe(false);
    expect(sessionSamples.samples).toEqual([{ session_key: 'openclaw:session:sess_1' }]);
    expect(sessionSamples.coverage.projectedRequestCount).toBe(42);
  });
});
