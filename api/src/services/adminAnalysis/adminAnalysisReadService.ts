import type { AdminAnalysisQueryRepository, AdminAnalysisWindowSlice } from '../../repos/adminAnalysisQueryRepository.js';
import { AppError } from '../../utils/errors.js';

export type AdminAnalysisWindow = '24h' | '7d' | '1m' | 'all';
export type AdminAnalysisCompare = 'prev';

export class AdminAnalysisReadService {
  constructor(private readonly deps: {
    queries: Partial<Pick<
      AdminAnalysisQueryRepository,
      | 'getOverview'
      | 'getCategoryTrends'
      | 'getTagTrends'
      | 'getInterestingSignals'
      | 'listRequestSamples'
      | 'listSessionSamples'
      | 'getRequestDetail'
      | 'getSessionDetail'
      | 'getCoverage'
    >>;
    now?: () => Date;
  }) {}

  async getOverview(input: AdminAnalysisFilterInput & {
    compare?: AdminAnalysisCompare;
  }) {
    const current = resolveWindowBounds(input.window, this.now());
    const comparison = resolveComparisonBounds(input.window, input.compare, current);
    const currentFilters = buildSlice(current, input);
    const currentOverview = await requireMethod(this.deps.queries.getOverview, 'getOverview')(currentFilters);
    const coverage = await requireMethod(this.deps.queries.getCoverage, 'getCoverage')(current);

    return {
      window: input.window,
      requestedWindow: serializeBounds(current),
      coverage: toCoverage(current, coverage),
      ...currentOverview,
      comparison: comparison
        ? toComparison(
          serializeBounds(comparison),
          await requireMethod(this.deps.queries.getOverview, 'getOverview')(buildSlice(comparison, input)),
          currentOverview
        )
        : undefined
    };
  }

  async getCategoryTrends(input: AdminAnalysisFilterInput & {
    compare?: AdminAnalysisCompare;
  }) {
    const current = resolveWindowBounds(input.window, this.now());
    const comparison = resolveComparisonBounds(input.window, input.compare, current);
    const rows = await requireMethod(this.deps.queries.getCategoryTrends, 'getCategoryTrends')(buildSlice(current, input));
    return {
      window: input.window,
      requestedWindow: serializeBounds(current),
      days: rows,
      comparison: comparison
        ? {
          previousWindow: serializeBounds(comparison),
          days: await requireMethod(this.deps.queries.getCategoryTrends, 'getCategoryTrends')(buildSlice(comparison, input))
        }
        : undefined
    };
  }

  async getTagTrends(input: AdminAnalysisFilterInput & {
    compare?: AdminAnalysisCompare;
  }) {
    const current = resolveWindowBounds(input.window, this.now());
    const comparison = resolveComparisonBounds(input.window, input.compare, current);
    const currentTrends = await requireMethod(this.deps.queries.getTagTrends, 'getTagTrends')(buildSlice(current, input));
    return {
      window: input.window,
      requestedWindow: serializeBounds(current),
      ...currentTrends,
      comparison: comparison
        ? {
          previousWindow: serializeBounds(comparison),
          ...(await requireMethod(this.deps.queries.getTagTrends, 'getTagTrends')(buildSlice(comparison, input)))
        }
        : undefined
    };
  }

  async getInterestingSignals(input: AdminAnalysisFilterInput & {
    compare?: AdminAnalysisCompare;
  }) {
    const current = resolveWindowBounds(input.window, this.now());
    const comparison = resolveComparisonBounds(input.window, input.compare, current);
    const currentSignals = await requireMethod(this.deps.queries.getInterestingSignals, 'getInterestingSignals')(buildSlice(current, input));
    return {
      window: input.window,
      requestedWindow: serializeBounds(current),
      signals: currentSignals,
      comparison: comparison
        ? {
          previousWindow: serializeBounds(comparison),
          signals: await requireMethod(this.deps.queries.getInterestingSignals, 'getInterestingSignals')(buildSlice(comparison, input))
        }
        : undefined
    };
  }

  async getRequestSamples(input: AdminAnalysisFilterInput & {
    sampleSize: number;
  }) {
    const bounds = resolveWindowBounds(input.window, this.now());
    const [samples, coverage] = await Promise.all([
      requireMethod(this.deps.queries.listRequestSamples, 'listRequestSamples')({
        ...buildSlice(bounds, input),
        sampleSize: input.sampleSize
      }),
      requireMethod(this.deps.queries.getCoverage, 'getCoverage')(bounds)
    ]);

    return {
      window: input.window,
      requestedWindow: serializeBounds(bounds),
      coverage: toCoverage(bounds, coverage),
      samples
    };
  }

  async getSessionSamples(input: AdminAnalysisFilterInput & {
    sampleSize: number;
  }) {
    const bounds = resolveWindowBounds(input.window, this.now());
    const [samples, coverage] = await Promise.all([
      requireMethod(this.deps.queries.listSessionSamples, 'listSessionSamples')({
        ...buildSlice(bounds, input),
        sampleSize: input.sampleSize
      }),
      requireMethod(this.deps.queries.getCoverage, 'getCoverage')(bounds)
    ]);

    return {
      window: input.window,
      requestedWindow: serializeBounds(bounds),
      coverage: toCoverage(bounds, coverage),
      samples
    };
  }

  getRequestDetail(requestId: string, attemptNo: number) {
    return requireMethod(this.deps.queries.getRequestDetail, 'getRequestDetail')(requestId, attemptNo);
  }

  getSessionDetail(sessionKey: string) {
    return requireMethod(this.deps.queries.getSessionDetail, 'getSessionDetail')(sessionKey);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}

type AdminAnalysisFilterInput = {
  window: AdminAnalysisWindow;
  orgId?: string;
  sessionType?: 'cli' | 'openclaw';
  provider?: string;
  source?: string;
  taskCategory?: string;
  taskTag?: string;
};

function requireMethod<T>(value: T | undefined, name: string): T {
  if (value) return value;
  throw new Error(`admin analysis read service missing dependency: ${name}`);
}

function buildSlice(bounds: WindowBounds, input: Omit<AdminAnalysisFilterInput, 'window'>): AdminAnalysisWindowSlice {
  return {
    start: bounds.start,
    end: bounds.end,
    orgId: input.orgId,
    sessionType: input.sessionType,
    provider: input.provider,
    source: input.source,
    taskCategory: input.taskCategory as AdminAnalysisWindowSlice['taskCategory'],
    taskTag: input.taskTag
  };
}

type WindowBounds = {
  start: Date;
  end: Date;
};

function resolveWindowBounds(window: AdminAnalysisWindow, now: Date): WindowBounds {
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

function resolveComparisonBounds(
  window: AdminAnalysisWindow,
  compare: AdminAnalysisCompare | undefined,
  current: WindowBounds
): WindowBounds | null {
  if (!compare) return null;
  if (window === 'all') {
    throw new AppError('invalid_request', 400, 'compare=prev is not supported for window=all');
  }

  const durationMs = current.end.getTime() - current.start.getTime();
  return {
    start: new Date(current.start.getTime() - durationMs),
    end: new Date(current.start.getTime())
  };
}

function serializeBounds(bounds: WindowBounds) {
  return {
    start: bounds.start.toISOString(),
    end: bounds.end.toISOString()
  };
}

function toCoverage(bounds: WindowBounds, coverage: {
  projectedRequestCount: number;
  pendingProjectionCount: number;
  firstProjectedAt: string | null;
  lastProjectedAt: string | null;
}) {
  return {
    requestedWindow: serializeBounds(bounds),
    projectedCoverage: {
      start: coverage.firstProjectedAt,
      end: coverage.lastProjectedAt
    },
    projectedRequestCount: coverage.projectedRequestCount,
    pendingProjectionCount: coverage.pendingProjectionCount,
    isComplete: coverage.pendingProjectionCount === 0
  };
}

function toComparison(
  previousWindow: { start: string; end: string },
  previous: {
    totals: { totalRequests: number; totalSessions: number; totalTokens: number };
  },
  current: {
    totals: { totalRequests: number; totalSessions: number; totalTokens: number };
  }
) {
  return {
    previousWindow,
    totals: previous.totals,
    deltas: {
      totalRequests: current.totals.totalRequests - previous.totals.totalRequests,
      totalSessions: current.totals.totalSessions - previous.totals.totalSessions,
      totalTokens: current.totals.totalTokens - previous.totals.totalTokens
    },
    percentDeltas: {
      totalRequests: percentDelta(current.totals.totalRequests, previous.totals.totalRequests),
      totalSessions: percentDelta(current.totals.totalSessions, previous.totals.totalSessions),
      totalTokens: percentDelta(current.totals.totalTokens, previous.totals.totalTokens)
    }
  };
}

function percentDelta(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return ((current - previous) / previous) * 100;
}
