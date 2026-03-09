import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AppError } from '../src/utils/errors.js';

type AnalyticsRouteModule = typeof import('../src/routes/analytics.js');

type MockReq = {
  method: string;
  path: string;
  originalUrl: string;
  query: Record<string, unknown>;
  params: Record<string, string>;
  auth?: {
    apiKeyId: string;
    orgId: string | null;
    scope: 'buyer_proxy' | 'admin';
  };
  header: (name: string) => string | undefined;
};

type MockRes = {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  headersSent: boolean;
  writableEnded: boolean;
  setHeader: (name: string, value: string) => void;
  status: (code: number) => MockRes;
  json: (payload: unknown) => void;
  send: (payload: unknown) => void;
};

function createMockReq(input: {
  method: string;
  path: string;
  headers?: Record<string, string>;
  query?: Record<string, unknown>;
  params?: Record<string, string>;
}): MockReq {
  const lower = Object.fromEntries(
    Object.entries(input.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])
  );

  return {
    method: input.method.toUpperCase(),
    path: input.path,
    originalUrl: input.path,
    query: input.query ?? {},
    params: input.params ?? {},
    header: (name: string) => lower[name.toLowerCase()]
  };
}

function createMockRes(): MockRes {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    headersSent: false,
    writableEnded: false,
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      this.headersSent = true;
      this.writableEnded = true;
    },
    send(payload: unknown) {
      this.body = payload;
      this.headersSent = true;
      this.writableEnded = true;
    }
  };
}

function applyError(err: unknown, res: MockRes): void {
  if (err instanceof z.ZodError) {
    res.status(400).json({ code: 'invalid_request', message: 'Invalid request', issues: err.issues });
    return;
  }
  if (err instanceof AppError) {
    res.status(err.status).json({ code: err.code, message: err.message, details: err.details });
    return;
  }
  const message = err instanceof Error ? err.message : 'Unexpected error';
  res.status(500).json({ code: 'internal_error', message });
}

async function invoke(handle: (req: any, res: any, next: (error?: unknown) => void) => unknown, req: MockReq, res: MockRes): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let nextCalled = false;
    const next = (error?: unknown) => {
      nextCalled = true;
      if (error) applyError(error, res);
      resolve();
    };

    Promise.resolve(handle(req, res, next))
      .then(() => {
        if (!nextCalled) resolve();
      })
      .catch(reject);
  });
}

async function invokeHandlers(
  handlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>,
  req: MockReq,
  res: MockRes
): Promise<void> {
  for (const handle of handlers) {
    if (res.writableEnded) break;
    await invoke(handle, req, res);
  }
}

function getRouteHandlers(router: any, routePath: string, method: 'get') {
  const layer = router.stack.find((entry: any) => entry?.route?.path === routePath && entry?.route?.methods?.[method]);
  if (!layer) throw new Error(`route not found: ${routePath}`);
  return layer.route.stack.map((stackEntry: any) => stackEntry.handle);
}

function createApiKeysRepo(scope: 'admin' | 'buyer_proxy' = 'admin') {
  return {
    findActiveByHash: vi.fn().mockResolvedValue({
      id: '99999999-9999-4999-8999-999999999999',
      org_id: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      scope,
      is_active: true,
      expires_at: null,
      preferred_provider: null
    }),
    touchLastUsed: vi.fn().mockResolvedValue(undefined)
  };
}

function createAnalyticsRepo() {
  return {
    getTokenUsage: vi.fn().mockResolvedValue([]),
    getTokenHealth: vi.fn().mockResolvedValue([]),
    getTokenRouting: vi.fn().mockResolvedValue([]),
    getSystemSummary: vi.fn().mockResolvedValue({}),
    getTimeSeries: vi.fn().mockResolvedValue([]),
    getRecentRequests: vi.fn().mockResolvedValue([]),
    getAnomalies: vi.fn().mockResolvedValue({ checks: {}, ok: true })
  };
}

describe('analytics routes', () => {
  let createAnalyticsRouter: AnalyticsRouteModule['createAnalyticsRouter'];

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/innies_test';
    process.env.SELLER_SECRET_ENC_KEY_B64 = process.env.SELLER_SECRET_ENC_KEY_B64 || Buffer.alloc(32, 7).toString('base64');
    ({ createAnalyticsRouter } = await import('../src/routes/analytics.js'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects non-admin API keys', async () => {
    const apiKeys = createApiKeysRepo('buyer_proxy');
    const analytics = createAnalyticsRepo();
    const router = createAnalyticsRouter({ apiKeys: apiKeys as any, analytics });
    const handlers = getRouteHandlers(router as any, '/v1/admin/analytics/tokens', 'get');
    const req = createMockReq({
      method: 'GET',
      path: '/v1/admin/analytics/tokens',
      headers: {
        authorization: 'Bearer buyer_token'
      }
    });
    const res = createMockRes();

    await invokeHandlers(handlers, req, res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ code: 'forbidden', message: 'Invalid API key scope' });
    expect(analytics.getTokenUsage).not.toHaveBeenCalled();
  });

  it('normalizes 30d and codex aliases on token usage queries', async () => {
    const apiKeys = createApiKeysRepo();
    const analytics = createAnalyticsRepo();
    analytics.getTokenUsage.mockResolvedValue([
      {
        credentialId: '11111111-1111-4111-8111-111111111111',
        debugLabel: 'alpha',
        provider: 'codex',
        status: 'active',
        requests: 12,
        usageUnits: 44,
        retailEquivalentMinor: 7,
        inputTokens: 1200,
        outputTokens: 80,
        bySource: {
          openclaw: { requests: 10, usageUnits: 30 }
        }
      }
    ]);

    const router = createAnalyticsRouter({ apiKeys: apiKeys as any, analytics });
    const handlers = getRouteHandlers(router as any, '/v1/admin/analytics/tokens', 'get');
    const req = createMockReq({
      method: 'GET',
      path: '/v1/admin/analytics/tokens',
      headers: {
        authorization: 'Bearer admin_token'
      },
      query: {
        window: '30d',
        provider: 'CoDeX',
        source: 'CLI-CODEX'
      }
    });
    const res = createMockRes();

    await invokeHandlers(handlers, req, res);

    expect(analytics.getTokenUsage).toHaveBeenCalledWith({
      window: '1m',
      provider: 'openai',
      source: 'cli-codex'
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      window: '1m',
      tokens: [
        {
          credentialId: '11111111-1111-4111-8111-111111111111',
          debugLabel: 'alpha',
          provider: 'openai',
          status: 'active',
          requests: 12,
          usageUnits: 44,
          retailEquivalentMinor: 7,
          inputTokens: 1200,
          outputTokens: 80,
          bySource: {
            openclaw: { requests: 10, usageUnits: 30 },
            'cli-claude': { requests: 0, usageUnits: 0 },
            'cli-codex': { requests: 0, usageUnits: 0 },
            direct: { requests: 0, usageUnits: 0 }
          }
        }
      ]
    });
  });

  it('defaults 24h timeseries requests to hourly granularity', async () => {
    const apiKeys = createApiKeysRepo();
    const analytics = createAnalyticsRepo();
    analytics.getTimeSeries.mockResolvedValue([
      {
        bucket: '2026-03-08T12:00:00.000Z',
        requests: 3,
        usageUnits: 9,
        errorRate: 0.25,
        latencyP50Ms: 1200
      }
    ]);

    const router = createAnalyticsRouter({ apiKeys: apiKeys as any, analytics });
    const handlers = getRouteHandlers(router as any, '/v1/admin/analytics/timeseries', 'get');
    const req = createMockReq({
      method: 'GET',
      path: '/v1/admin/analytics/timeseries',
      headers: {
        authorization: 'Bearer admin_token'
      },
      query: {
        window: '24h'
      }
    });
    const res = createMockRes();

    await invokeHandlers(handlers, req, res);

    expect(analytics.getTimeSeries).toHaveBeenCalledWith({
      window: '24h',
      provider: undefined,
      source: undefined,
      credentialId: undefined,
      granularity: 'hour'
    });
    expect(res.body).toEqual({
      window: '24h',
      granularity: 'hour',
      series: [
        {
          date: '2026-03-08T12:00:00.000Z',
          requests: 3,
          usageUnits: 9,
          errorRate: 0.25,
          latencyP50Ms: 1200
        }
      ]
    });
  });

  it('returns request-log previews with normalized filters', async () => {
    const apiKeys = createApiKeysRepo();
    const analytics = createAnalyticsRepo();
    analytics.getRecentRequests.mockResolvedValue([
      {
        request_id: 'req_123',
        created_at: '2026-03-08T15:00:00.000Z',
        credential_id: '11111111-1111-4111-8111-111111111111',
        credential_label: 'alpha',
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        source: 'openclaw',
        translated: true,
        streaming: true,
        upstream_status: 200,
        latency_ms: 450,
        ttfb_ms: 120,
        input_tokens: 1000,
        output_tokens: 50,
        usage_units: 200,
        prompt_preview: 'hello',
        response_preview: 'world'
      }
    ]);

    const router = createAnalyticsRouter({ apiKeys: apiKeys as any, analytics });
    const handlers = getRouteHandlers(router as any, '/v1/admin/analytics/requests', 'get');
    const req = createMockReq({
      method: 'GET',
      path: '/v1/admin/analytics/requests',
      headers: {
        authorization: 'Bearer admin_token'
      },
      query: {
        limit: '20',
        minLatencyMs: '250',
        credentialId: '11111111-1111-4111-8111-111111111111'
      }
    });
    const res = createMockRes();

    await invokeHandlers(handlers, req, res);

    expect(analytics.getRecentRequests).toHaveBeenCalledWith({
      window: '24h',
      provider: undefined,
      source: undefined,
      credentialId: '11111111-1111-4111-8111-111111111111',
      limit: 20,
      model: undefined,
      minLatencyMs: 250
    });
    expect(res.body).toEqual({
      window: '24h',
      limit: 20,
      requests: [
        {
          requestId: 'req_123',
          createdAt: '2026-03-08T15:00:00.000Z',
          credentialId: '11111111-1111-4111-8111-111111111111',
          credentialLabel: 'alpha',
          provider: 'anthropic',
          model: 'claude-opus-4-6',
          source: 'openclaw',
          translated: true,
          streaming: true,
          upstreamStatus: 200,
          latencyMs: 450,
          ttfbMs: 120,
          inputTokens: 1000,
          outputTokens: 50,
          usageUnits: 200,
          prompt: 'hello',
          response: 'world'
        }
      ]
    });
  });

  it('normalizes health query aliases and preserves non-null cycle/utilization metrics', async () => {
    const apiKeys = createApiKeysRepo();
    const analytics = createAnalyticsRepo();
    analytics.getTokenHealth.mockResolvedValue([
      {
        credential_id: '11111111-1111-4111-8111-111111111111',
        debug_label: 'alpha',
        provider: 'codex',
        status: 'active',
        consecutive_failure_count: 1,
        last_failed_status: 401,
        last_failed_at: '2026-03-08T01:00:00.000Z',
        maxed_at: '2026-03-07T12:00:00.000Z',
        next_probe_at: null,
        last_probe_at: '2026-03-08T03:00:00.000Z',
        monthly_contribution_limit_units: 500000,
        monthly_contribution_used_units: 123000,
        monthly_window_start_at: '2026-03-01T00:00:00.000Z',
        maxed_events_7d: 2,
        requests_before_maxed_last_window: 340,
        avg_requests_before_maxed: 287.5,
        avg_usage_units_before_maxed: 52000,
        avg_recovery_time_ms: 1800000,
        estimated_daily_capacity_units: 156000,
        maxing_cycles_observed: 2,
        utilization_rate_24h: 1.08,
        created_at: '2026-02-15T00:00:00.000Z',
        expires_at: '2026-06-01T00:00:00.000Z'
      }
    ]);

    const router = createAnalyticsRouter({ apiKeys: apiKeys as any, analytics });
    const handlers = getRouteHandlers(router as any, '/v1/admin/analytics/tokens/health', 'get');
    const req = createMockReq({
      method: 'GET',
      path: '/v1/admin/analytics/tokens/health',
      headers: {
        authorization: 'Bearer admin_token'
      },
      query: {
        window: '30d',
        provider: 'CoDeX',
        source: 'OPENCLAW'
      }
    });
    const res = createMockRes();

    await invokeHandlers(handlers, req, res);

    expect(analytics.getTokenHealth).toHaveBeenCalledWith({
      window: '1m',
      provider: 'openai',
      source: 'openclaw'
    });
    expect(res.body).toEqual({
      window: '1m',
      tokens: [
        {
          credentialId: '11111111-1111-4111-8111-111111111111',
          debugLabel: 'alpha',
          provider: 'openai',
          status: 'active',
          consecutiveFailures: 1,
          lastFailedStatus: 401,
          lastFailedAt: '2026-03-08T01:00:00.000Z',
          maxedAt: '2026-03-07T12:00:00.000Z',
          nextProbeAt: null,
          lastProbeAt: '2026-03-08T03:00:00.000Z',
          monthlyContributionLimitUnits: 500000,
          monthlyContributionUsedUnits: 123000,
          monthlyWindowStartAt: '2026-03-01T00:00:00.000Z',
          maxedEvents7d: 2,
          requestsBeforeMaxedLastWindow: 340,
          avgRequestsBeforeMaxed: 287.5,
          avgUsageUnitsBeforeMaxed: 52000,
          avgRecoveryTimeMs: 1800000,
          estimatedDailyCapacityUnits: 156000,
          maxingCyclesObserved: 2,
          utilizationRate24h: 1.08,
          createdAt: '2026-02-15T00:00:00.000Z',
          expiresAt: '2026-06-01T00:00:00.000Z'
        }
      ]
    });
  });

  it('passes through thin-evidence health nulls while keeping cycle counts numeric', async () => {
    const apiKeys = createApiKeysRepo();
    const analytics = createAnalyticsRepo();
    analytics.getTokenHealth.mockResolvedValue([
      {
        credential_id: '22222222-2222-4222-8222-222222222222',
        debug_label: 'beta',
        provider: 'anthropic',
        status: 'active',
        consecutive_failure_count: 0,
        last_failed_status: null,
        last_failed_at: null,
        maxed_at: null,
        next_probe_at: null,
        last_probe_at: null,
        monthly_contribution_limit_units: null,
        monthly_contribution_used_units: 0,
        monthly_window_start_at: null,
        maxed_events_7d: 0,
        requests_before_maxed_last_window: null,
        avg_requests_before_maxed: null,
        avg_usage_units_before_maxed: null,
        avg_recovery_time_ms: null,
        estimated_daily_capacity_units: null,
        maxing_cycles_observed: 0,
        utilization_rate_24h: null,
        created_at: '2026-02-20T00:00:00.000Z',
        expires_at: null
      }
    ]);

    const router = createAnalyticsRouter({ apiKeys: apiKeys as any, analytics });
    const handlers = getRouteHandlers(router as any, '/v1/admin/analytics/tokens/health', 'get');
    const req = createMockReq({
      method: 'GET',
      path: '/v1/admin/analytics/tokens/health',
      headers: {
        authorization: 'Bearer admin_token'
      }
    });
    const res = createMockRes();

    await invokeHandlers(handlers, req, res);

    expect(analytics.getTokenHealth).toHaveBeenCalledWith({
      window: '7d',
      provider: undefined,
      source: undefined
    });
    expect(res.body).toEqual({
      window: '7d',
      tokens: [
        {
          credentialId: '22222222-2222-4222-8222-222222222222',
          debugLabel: 'beta',
          provider: 'anthropic',
          status: 'active',
          consecutiveFailures: 0,
          lastFailedStatus: null,
          lastFailedAt: null,
          maxedAt: null,
          nextProbeAt: null,
          lastProbeAt: null,
          monthlyContributionLimitUnits: null,
          monthlyContributionUsedUnits: 0,
          monthlyWindowStartAt: null,
          maxedEvents7d: 0,
          requestsBeforeMaxedLastWindow: null,
          avgRequestsBeforeMaxed: null,
          avgUsageUnitsBeforeMaxed: null,
          avgRecoveryTimeMs: null,
          estimatedDailyCapacityUnits: null,
          maxingCyclesObserved: 0,
          utilizationRate24h: null,
          createdAt: '2026-02-20T00:00:00.000Z',
          expiresAt: null
        }
      ]
    });
  });

  it('passes through descoped null system fields', async () => {
    const apiKeys = createApiKeysRepo();
    const analytics = createAnalyticsRepo();
    analytics.getSystemSummary.mockResolvedValue({
      total_requests: 1450,
      total_usage_units: 320000,
      translation_overhead: null,
      top_buyers: [
        {
          api_key_id: '22222222-2222-4222-8222-222222222222',
          org_id: '33333333-3333-4333-8333-333333333333',
          requests: 800,
          usage_units: 180000,
          percent_of_total: 0.56
        }
      ]
    });

    const router = createAnalyticsRouter({ apiKeys: apiKeys as any, analytics });
    const handlers = getRouteHandlers(router as any, '/v1/admin/analytics/system', 'get');
    const req = createMockReq({
      method: 'GET',
      path: '/v1/admin/analytics/system',
      headers: {
        authorization: 'Bearer admin_token'
      }
    });
    const res = createMockRes();

    await invokeHandlers(handlers, req, res);

    expect(res.body).toEqual({
      window: '24h',
      totalRequests: 1450,
      totalUsageUnits: 320000,
      byProvider: {},
      byModel: {},
      latencyP50Ms: null,
      latencyP95Ms: null,
      ttfbP50Ms: null,
      ttfbP95Ms: null,
      errorRate: 0,
      fallbackRate: 0,
      activeTokens: 0,
      maxedTokens: 0,
      totalTokens: 0,
      maxedEvents7d: 0,
      bySource: {
        openclaw: { requests: 0, usageUnits: 0 },
        'cli-claude': { requests: 0, usageUnits: 0 },
        'cli-codex': { requests: 0, usageUnits: 0 },
        direct: { requests: 0, usageUnits: 0 }
      },
      translationOverhead: null,
      topBuyers: [
        {
          apiKeyId: '22222222-2222-4222-8222-222222222222',
          orgId: '33333333-3333-4333-8333-333333333333',
          requests: 800,
          usageUnits: 180000,
          percentOfTotal: 0.56
        }
      ]
    });
  });

  it('returns implemented anomaly counts and flips ok false when any check is non-zero', async () => {
    const apiKeys = createApiKeysRepo();
    const analytics = createAnalyticsRepo();
    analytics.getAnomalies.mockResolvedValue({
      checks: {
        missing_debug_labels: 0,
        unresolved_credential_ids_in_token_mode_usage: 0,
        null_credential_ids_in_routing: 0,
        stale_aggregate_windows: 2,
        usage_ledger_vs_aggregate_mismatch_count: 1
      }
    });

    const router = createAnalyticsRouter({ apiKeys: apiKeys as any, analytics });
    const handlers = getRouteHandlers(router as any, '/v1/admin/analytics/anomalies', 'get');
    const req = createMockReq({
      method: 'GET',
      path: '/v1/admin/analytics/anomalies',
      headers: {
        authorization: 'Bearer admin_token'
      },
      query: {
        provider: 'CoDeX',
        source: 'direct'
      }
    });
    const res = createMockRes();

    await invokeHandlers(handlers, req, res);

    expect(analytics.getAnomalies).toHaveBeenCalledWith({
      window: '24h',
      provider: 'openai',
      source: 'direct'
    });
    expect(res.body).toEqual({
      window: '24h',
      checks: {
        missingDebugLabels: 0,
        unresolvedCredentialIdsInTokenModeUsage: 0,
        nullCredentialIdsInRouting: 0,
        staleAggregateWindows: 2,
        usageLedgerVsAggregateMismatchCount: 1
      },
      ok: false
    });
  });

  it('rejects request-log limits above the contract maximum', async () => {
    const apiKeys = createApiKeysRepo();
    const analytics = createAnalyticsRepo();
    const router = createAnalyticsRouter({ apiKeys: apiKeys as any, analytics });
    const handlers = getRouteHandlers(router as any, '/v1/admin/analytics/requests', 'get');
    const req = createMockReq({
      method: 'GET',
      path: '/v1/admin/analytics/requests',
      headers: {
        authorization: 'Bearer admin_token'
      },
      query: {
        limit: '201'
      }
    });
    const res = createMockRes();

    await invokeHandlers(handlers, req, res);

    expect(res.statusCode).toBe(400);
    expect((res.body as any).code).toBe('invalid_request');
    expect(analytics.getRecentRequests).not.toHaveBeenCalled();
  });
});
