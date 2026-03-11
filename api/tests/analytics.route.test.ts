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
    getBuyers: vi.fn().mockResolvedValue([]),
    getBuyerTimeSeries: vi.fn().mockResolvedValue([]),
    getRecentRequests: vi.fn().mockResolvedValue([]),
    getEvents: vi.fn().mockResolvedValue([]),
    getAnomalies: vi.fn().mockResolvedValue({ checks: {}, ok: true })
  };
}

describe('analytics routes', () => {
  let createAnalyticsRouter: AnalyticsRouteModule['createAnalyticsRouter'];

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/innies_test';
    process.env.SELLER_SECRET_ENC_KEY_B64 = process.env.SELLER_SECRET_ENC_KEY_B64 || Buffer.alloc(32, 7).toString('base64');
    process.env.BUYER_PROVIDER_PREFERENCE_DEFAULT = 'anthropic';
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
        attempts: 12,
        requests: 12,
        usageUnits: 44,
        retailEquivalentMinor: 7,
        inputTokens: 1200,
        outputTokens: 80,
        bySource: {
          openclaw: { attempts: 10, requests: 10, usageUnits: 30 }
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
          displayKey: 'cred_1111...1111',
          debugLabel: 'alpha',
          provider: 'openai',
          status: 'active',
          attempts: 12,
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

  it('defaults 24h timeseries requests to 15m granularity', async () => {
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
      granularity: '15m'
    });
    expect(res.body).toEqual({
      window: '24h',
      granularity: '15m',
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

  it('defaults 5h timeseries requests to 5m granularity', async () => {
    const apiKeys = createApiKeysRepo();
    const analytics = createAnalyticsRepo();
    const router = createAnalyticsRouter({ apiKeys: apiKeys as any, analytics });
    const handlers = getRouteHandlers(router as any, '/v1/admin/analytics/timeseries', 'get');
    const req = createMockReq({
      method: 'GET',
      path: '/v1/admin/analytics/timeseries',
      headers: {
        authorization: 'Bearer admin_token'
      },
      query: {
        window: '5h'
      }
    });
    const res = createMockRes();

    await invokeHandlers(handlers, req, res);

    expect(analytics.getTimeSeries).toHaveBeenCalledWith({
      window: '5h',
      provider: undefined,
      source: undefined,
      credentialId: undefined,
      granularity: '5m'
    });
    expect(res.body).toEqual({
      window: '5h',
      granularity: '5m',
      series: []
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
          attemptNo: 1,
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

  it('returns buyer analytics including zero-usage rows and display fallbacks', async () => {
    const apiKeys = createApiKeysRepo();
    const analytics = createAnalyticsRepo();
    analytics.getBuyers.mockResolvedValue([
      {
        api_key_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        label: 'alpha-buyer',
        org_id: '818d0cc7-7ed2-469f-b690-a977e72a921d',
        org_name: 'alpha-org',
        preferred_provider: null,
        effective_provider: 'anthropic',
        request_count: 0,
        attempt_count: 0,
        usage_units: 0,
        retail_equivalent_minor: 0,
        percent_of_total: 0,
        last_seen_at: null,
        error_rate: 0,
        by_source: []
      }
    ]);

    const router = createAnalyticsRouter({ apiKeys: apiKeys as any, analytics });
    const handlers = getRouteHandlers(router as any, '/v1/admin/analytics/buyers', 'get');
    const req = createMockReq({
      method: 'GET',
      path: '/v1/admin/analytics/buyers',
      headers: {
        authorization: 'Bearer admin_token'
      },
      query: {
        window: '5h',
        provider: 'codex',
        source: 'direct'
      }
    });
    const res = createMockRes();

    await invokeHandlers(handlers, req, res);

    expect(analytics.getBuyers).toHaveBeenCalledWith({
      window: '5h',
      provider: 'openai',
      source: 'direct'
    });
    expect(res.body).toEqual({
      window: '5h',
      buyers: [
        {
          apiKeyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          displayKey: 'key_aaaa...aaaa',
          label: 'alpha-buyer',
          orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
          orgLabel: 'alpha-org',
          preferredProvider: null,
          effectiveProvider: 'anthropic',
          requests: 0,
          attempts: 0,
          usageUnits: 0,
          retailEquivalentMinor: 0,
          percentOfTotal: 0,
          lastSeenAt: null,
          latencyP50Ms: null,
          errorRate: 0,
          bySource: {
            openclaw: { requests: 0, usageUnits: 0 },
            'cli-claude': { requests: 0, usageUnits: 0 },
            'cli-codex': { requests: 0, usageUnits: 0 },
            direct: { requests: 0, usageUnits: 0 }
          }
        }
      ]
    });
  });

  it('returns buyer timeseries with multiple apiKeyId filters', async () => {
    const apiKeys = createApiKeysRepo();
    const analytics = createAnalyticsRepo();
    analytics.getBuyerTimeSeries.mockResolvedValue([
      {
        bucket: '2026-03-08T15:00:00.000Z',
        api_key_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        request_count: 4,
        usage_units: 80
      }
    ]);

    const router = createAnalyticsRouter({ apiKeys: apiKeys as any, analytics });
    const handlers = getRouteHandlers(router as any, '/v1/admin/analytics/buyers/timeseries', 'get');
    const req = createMockReq({
      method: 'GET',
      path: '/v1/admin/analytics/buyers/timeseries',
      headers: {
        authorization: 'Bearer admin_token'
      },
      query: {
        window: '24h',
        apiKeyId: [
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
        ]
      }
    });
    const res = createMockRes();

    await invokeHandlers(handlers, req, res);

    expect(analytics.getBuyerTimeSeries).toHaveBeenCalledWith({
      window: '24h',
      provider: undefined,
      source: undefined,
      apiKeyIds: [
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      ],
      granularity: '15m'
    });
    expect(res.body).toEqual({
      window: '24h',
      granularity: '15m',
      series: [
        {
          date: '2026-03-08T15:00:00.000Z',
          apiKeyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          requests: 4,
          usageUnits: 80,
          errorRate: 0,
          latencyP50Ms: null
        }
      ]
    });
  });

  it('returns lifecycle events with severity and metadata', async () => {
    const apiKeys = createApiKeysRepo();
    const analytics = createAnalyticsRepo();
    analytics.getEvents.mockResolvedValue([
      {
        id: 'event_1',
        event_type: 'maxed',
        created_at: '2026-03-08T15:00:00.000Z',
        provider: 'openai',
        credential_id: '11111111-1111-4111-8111-111111111111',
        credential_label: 'alpha',
        summary: 'credential maxed',
        severity: 'warn',
        status_code: 401,
        reason: 'upstream_401_consecutive_failure',
        metadata: { threshold: 3 }
      }
    ]);

    const router = createAnalyticsRouter({ apiKeys: apiKeys as any, analytics });
    const handlers = getRouteHandlers(router as any, '/v1/admin/analytics/events', 'get');
    const req = createMockReq({
      method: 'GET',
      path: '/v1/admin/analytics/events',
      headers: {
        authorization: 'Bearer admin_token'
      },
      query: {
        window: '5h',
        provider: 'codex',
        limit: '10'
      }
    });
    const res = createMockRes();

    await invokeHandlers(handlers, req, res);

    expect(analytics.getEvents).toHaveBeenCalledWith({
      window: '5h',
      provider: 'openai',
      limit: 10
    });
    expect(res.body).toEqual({
      window: '5h',
      limit: 10,
      events: [
        {
          id: 'event_1',
          type: 'maxed',
          createdAt: '2026-03-08T15:00:00.000Z',
          provider: 'openai',
          credentialId: '11111111-1111-4111-8111-111111111111',
          credentialLabel: 'alpha',
          summary: 'credential maxed',
          severity: 'warn',
          statusCode: 401,
          reason: 'upstream_401_consecutive_failure',
          metadata: { threshold: 3 }
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
        consecutive_rate_limit_count: 5,
        last_failed_status: 401,
        last_failed_at: '2026-03-08T01:00:00.000Z',
        last_rate_limited_at: '2026-03-08T02:00:00.000Z',
        maxed_at: '2026-03-07T12:00:00.000Z',
        rate_limited_until: '2026-03-08T03:00:00.000Z',
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
          displayKey: 'cred_1111...1111',
          debugLabel: 'alpha',
          provider: 'openai',
          status: 'active',
          consecutiveFailures: 1,
          consecutiveRateLimitCount: 5,
          lastFailedStatus: 401,
          lastFailedAt: '2026-03-08T01:00:00.000Z',
          lastRateLimitedAt: '2026-03-08T02:00:00.000Z',
          maxedAt: '2026-03-07T12:00:00.000Z',
          rateLimitedUntil: '2026-03-08T03:00:00.000Z',
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
        consecutive_rate_limit_count: 0,
        last_failed_status: null,
        last_failed_at: null,
        last_rate_limited_at: null,
        maxed_at: null,
        rate_limited_until: null,
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
          displayKey: 'cred_2222...2222',
          debugLabel: 'beta',
          provider: 'anthropic',
          status: 'active',
          consecutiveFailures: 0,
          consecutiveRateLimitCount: 0,
          lastFailedStatus: null,
          lastFailedAt: null,
          lastRateLimitedAt: null,
          maxedAt: null,
          rateLimitedUntil: null,
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

  it('returns dashboard snapshots with merged token rows', async () => {
    const apiKeys = createApiKeysRepo();
    const analytics = createAnalyticsRepo();
    analytics.getSystemSummary.mockResolvedValue({
      total_requests: 10,
      total_usage_units: 100,
      active_tokens: 1,
      maxed_tokens: 0,
      total_tokens: 1,
      maxed_events_7d: 0,
      error_rate: 0.1,
      fallback_rate: 0.2,
      by_provider: [],
      by_model: [],
      by_source: []
    });
    analytics.getTokenUsage.mockResolvedValue([
      {
        credential_id: '11111111-1111-4111-8111-111111111111',
        debug_label: 'alpha',
        provider: 'openai',
        status: 'active',
        attempts: 12,
        requests: 10,
        usage_units: 100,
        retail_equivalent_minor: 100,
        input_tokens: 80,
        output_tokens: 20,
        by_source: []
      }
    ]);
    analytics.getTokenHealth.mockResolvedValue([
      {
        credential_id: '11111111-1111-4111-8111-111111111111',
        debug_label: 'alpha',
        provider: 'openai',
        status: 'active',
        consecutive_rate_limit_count: 5,
        rate_limited_until: '2099-03-08T12:00:00.000Z',
        monthly_contribution_used_units: 55,
        monthly_contribution_limit_units: 500,
        maxed_events_7d: 2,
        utilization_rate_24h: 0.75
      }
    ]);
    analytics.getTokenRouting.mockResolvedValue([
      {
        credential_id: '11111111-1111-4111-8111-111111111111',
        debug_label: 'alpha',
        provider: 'openai',
        latency_p50_ms: 220,
        auth_failures_24h: 1,
        rate_limited_24h: 2
      }
    ]);
    analytics.getBuyers.mockResolvedValue([]);
    analytics.getAnomalies.mockResolvedValue({ checks: {}, ok: true });
    analytics.getEvents.mockResolvedValue([]);

    const router = createAnalyticsRouter({ apiKeys: apiKeys as any, analytics });
    const handlers = getRouteHandlers(router as any, '/v1/admin/analytics/dashboard', 'get');
    const req = createMockReq({
      method: 'GET',
      path: '/v1/admin/analytics/dashboard',
      headers: {
        authorization: 'Bearer admin_token'
      },
      query: {
        window: '5h',
        provider: 'codex',
        source: 'openclaw'
      }
    });
    const res = createMockRes();

    await invokeHandlers(handlers, req, res);

    expect(analytics.getSystemSummary).toHaveBeenCalledWith({
      window: '5h',
      provider: 'openai',
      source: 'openclaw'
    });
    expect(analytics.getBuyers).toHaveBeenCalledWith({
      window: '5h',
      provider: 'openai',
      source: 'openclaw'
    });
    expect(analytics.getEvents).toHaveBeenCalledWith({
      window: '5h',
      provider: 'openai',
      limit: 20
    });
    expect((res.body as any).window).toBe('5h');
    expect(typeof (res.body as any).snapshotAt).toBe('string');
    expect((res.body as any).tokens).toEqual([
      {
        credentialId: '11111111-1111-4111-8111-111111111111',
        displayKey: 'cred_1111...1111',
        debugLabel: 'alpha',
        provider: 'openai',
        status: 'rate_limited',
        attempts: 12,
        requests: 10,
        usageUnits: 100,
        percentOfWindow: 1,
        utilizationRate24h: 0.75,
        maxedEvents7d: 2,
        monthlyContributionUsedUnits: 55,
        monthlyContributionLimitUnits: 500,
        latencyP50Ms: 220,
        errorRate: 0,
        authFailures24h: 1,
        rateLimited24h: 2
      }
    ]);
  });

  it('preserves routing-only token attempt counts in dashboard snapshots', async () => {
    const apiKeys = createApiKeysRepo();
    const analytics = createAnalyticsRepo();
    analytics.getSystemSummary.mockResolvedValue({
      total_requests: 0,
      total_usage_units: 0,
      active_tokens: 1,
      maxed_tokens: 0,
      total_tokens: 1,
      maxed_events_7d: 0,
      error_rate: 0,
      fallback_rate: 0,
      by_provider: [],
      by_model: [],
      by_source: []
    });
    analytics.getTokenUsage.mockResolvedValue([]);
    analytics.getTokenHealth.mockResolvedValue([]);
    analytics.getTokenRouting.mockResolvedValue([
      {
        credential_id: '22222222-2222-4222-8222-222222222222',
        debug_label: 'beta',
        provider: 'anthropic',
        total_attempts: 7,
        latency_p50_ms: 180,
        auth_failures_24h: 2,
        rate_limited_24h: 1
      }
    ]);
    analytics.getBuyers.mockResolvedValue([]);
    analytics.getAnomalies.mockResolvedValue({ checks: {}, ok: true });
    analytics.getEvents.mockResolvedValue([]);

    const router = createAnalyticsRouter({ apiKeys: apiKeys as any, analytics });
    const handlers = getRouteHandlers(router as any, '/v1/admin/analytics/dashboard', 'get');
    const req = createMockReq({
      method: 'GET',
      path: '/v1/admin/analytics/dashboard',
      headers: {
        authorization: 'Bearer admin_token'
      },
      query: {
        window: '24h'
      }
    });
    const res = createMockRes();

    await invokeHandlers(handlers, req, res);

    expect((res.body as any).tokens).toEqual([
      {
        credentialId: '22222222-2222-4222-8222-222222222222',
        displayKey: 'cred_2222...2222',
        debugLabel: 'beta',
        provider: 'anthropic',
        status: 'active',
        attempts: 7,
        requests: 0,
        usageUnits: 0,
        percentOfWindow: 0,
        latencyP50Ms: 180,
        errorRate: 0,
        authFailures24h: 2,
        rateLimited24h: 1
      }
    ]);
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
