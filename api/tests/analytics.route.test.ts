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
    getDailyTrends: vi.fn().mockResolvedValue([]),
    getCapHistory: vi.fn().mockResolvedValue({ cycles: [], nextCursor: null }),
    getSessions: vi.fn().mockResolvedValue({ sessions: [], nextCursor: null }),
    getEvents: vi.fn().mockResolvedValue([]),
    getAnomalies: vi.fn().mockResolvedValue({ checks: {}, ok: true })
  };
}

function createDashboardSnapshotStore() {
  return {
    get: vi.fn().mockResolvedValue(null),
    refreshIfLockAvailable: vi.fn().mockResolvedValue(null)
  };
}

function createDashboardSnapshotPayload(overrides: Record<string, unknown> = {}) {
  return {
    window: '24h',
    snapshotAt: '2026-03-12T12:00:00.000Z',
    summary: {
      totalRequests: 0,
      totalUsageUnits: 0,
      activeTokens: 0,
      maxedTokens: 0,
      totalTokens: 0,
      maxedEvents7d: 0,
      errorRate: 0,
      fallbackRate: 0,
      byProvider: [],
      byModel: [],
      bySource: []
    },
    tokens: [],
    buyers: [],
    anomalies: {
      checks: {
        missingDebugLabels: 0,
        unresolvedCredentialIdsInTokenModeUsage: 0,
        nullCredentialIdsInRouting: 0,
        staleAggregateWindows: null,
        usageLedgerVsAggregateMismatchCount: null
      },
      ok: true
    },
    events: [],
    warnings: [],
    ...overrides
  };
}

function createDashboardSnapshotRecord(
  payload = createDashboardSnapshotPayload(),
  refreshedAt = '2026-03-12T12:00:00.000Z',
  filters: { provider?: string; source?: string; orgId?: string } = {}
) {
  return {
    cacheKey: `dashboard:v5:${payload.window}:${filters.provider ?? '_'}:${filters.source ?? '_'}:${filters.orgId ?? '_'}`,
    window: payload.window,
    provider: filters.provider,
    source: filters.source,
    payload,
    snapshotAt: new Date(String(payload.snapshotAt)),
    refreshedAt: new Date(refreshedAt)
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
    vi.useRealTimers();
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

  it('preserves auth diagnosis fields on token health responses', async () => {
    const apiKeys = createApiKeysRepo();
    const analytics = createAnalyticsRepo();
    analytics.getTokenHealth.mockResolvedValue([
      {
        credential_id: '11111111-1111-4111-8111-111111111111',
        debug_label: 'niyant-codex',
        provider: 'openai',
        status: 'maxed',
        auth_diagnosis: 'access_token_expired_local',
        access_token_expires_at: '2026-03-14T15:49:35.000Z',
        refresh_token_state: 'missing'
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

    expect((res.body as any)).toEqual({
      window: '7d',
      tokens: [
        expect.objectContaining({
          credentialId: '11111111-1111-4111-8111-111111111111',
          status: 'maxed',
          authDiagnosis: 'access_token_expired_local',
          accessTokenExpiresAt: '2026-03-14T15:49:35.000Z',
          refreshTokenState: 'missing'
        })
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
    const cursor = Buffer.from(JSON.stringify({
      createdAt: '2026-03-08T14:59:00.000Z',
      requestId: 'req_122',
      attemptNo: 1
    }), 'utf8').toString('base64url');
    analytics.getRecentRequests.mockResolvedValue({
      requests: [
        {
          request_id: 'req_123',
          attempt_no: 2,
          created_at: '2026-03-08T15:00:00.000Z',
          credential_id: '11111111-1111-4111-8111-111111111111',
          credential_label: 'alpha',
          provider: 'anthropic',
          model: 'claude-opus-4-6',
          source: 'openclaw',
          translated: true,
          rescued: true,
          rescue_scope: 'cross_provider',
          rescue_initial_provider: 'openai',
          rescue_initial_credential_id: '22222222-2222-4222-8222-222222222222',
          rescue_initial_failure_code: 'upstream_400',
          rescue_initial_failure_status: 400,
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
      ],
      nextCursor: cursor
    });

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
        credentialId: '11111111-1111-4111-8111-111111111111',
        cursor
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
      minLatencyMs: 250,
      cursor
    });
    expect(res.body).toEqual({
      window: '24h',
      limit: 20,
      nextCursor: cursor,
      requests: [
        {
          requestId: 'req_123',
          attemptNo: 2,
          createdAt: '2026-03-08T15:00:00.000Z',
          credentialId: '11111111-1111-4111-8111-111111111111',
          credentialLabel: 'alpha',
          provider: 'anthropic',
          model: 'claude-opus-4-6',
          source: 'openclaw',
          translated: true,
          rescued: true,
          rescueScope: 'cross_provider',
          rescueInitialProvider: 'openai',
          rescueInitialCredentialId: '22222222-2222-4222-8222-222222222222',
          rescueInitialFailureCode: 'upstream_400',
          rescueInitialFailureStatus: 400,
          streaming: true,
          upstreamStatus: 200,
          latencyMs: 450,
          ttfbMs: 120,
          inputTokens: 1000,
          outputTokens: 50,
          usageUnits: 200,
          promptPreview: 'hello',
          responsePreview: 'world'
        }
      ]
    });
  });

  it('returns daily trends with normalized filters', async () => {
    const apiKeys = createApiKeysRepo();
    const analytics = createAnalyticsRepo();
    analytics.getDailyTrends.mockResolvedValue([
      {
        day: '2026-03-08',
        requests: 42,
        attempts: 45,
        usage_units: 12345,
        input_tokens: 6789,
        output_tokens: 321,
        error_rate: 0.12,
        avg_latency_ms: 512,
        provider_split: {
          anthropic: { requests: 30, usageUnits: 9000 },
          openai: { requests: 12, usageUnits: 3345 }
        },
        source_split: {
          openclaw: { requests: 40, usageUnits: 12000 },
          direct: { requests: 2, usageUnits: 345 }
        }
      }
    ]);

    const router = createAnalyticsRouter({ apiKeys: apiKeys as any, analytics });
    const handlers = getRouteHandlers(router as any, '/v1/admin/analytics/daily-trends', 'get');
    const req = createMockReq({
      method: 'GET',
      path: '/v1/admin/analytics/daily-trends',
      headers: {
        authorization: 'Bearer admin_token'
      },
      query: {
        window: '30d',
        provider: 'codex',
        source: 'openclaw',
        orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d'
      }
    });
    const res = createMockRes();

    await invokeHandlers(handlers, req, res);

    expect(analytics.getDailyTrends).toHaveBeenCalledWith({
      window: '1m',
      provider: 'openai',
      source: 'openclaw',
      orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d'
    });
    expect(res.body).toEqual({
      window: '1m',
      days: [
        {
          day: '2026-03-08',
          requests: 42,
          attempts: 45,
          usageUnits: 12345,
          inputTokens: 6789,
          outputTokens: 321,
          errorRate: 0.12,
          avgLatencyMs: 512,
          providerSplit: {
            anthropic: { requests: 30, usageUnits: 9000 },
            openai: { requests: 12, usageUnits: 3345 }
          },
          sourceSplit: {
            openclaw: { requests: 40, usageUnits: 12000 },
            direct: { requests: 2, usageUnits: 345 }
          }
        }
      ]
    });
  });

  it('returns cap history with normalized filters and pagination', async () => {
    const apiKeys = createApiKeysRepo();
    const analytics = createAnalyticsRepo();
    const cursor = Buffer.from(JSON.stringify({
      exhaustedAt: '2026-03-08T14:59:00.000Z',
      credentialId: '11111111-1111-4111-8111-111111111111',
      windowKind: '5h',
      eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    }), 'utf8').toString('base64url');
    analytics.getCapHistory.mockResolvedValue({
      cycles: [
        {
          credential_id: '11111111-1111-4111-8111-111111111111',
          credential_label: 'alpha',
          provider: 'anthropic',
          window_kind: '5h',
          exhausted_at: '2026-03-08T15:00:00.000Z',
          cleared_at: null,
          recovery_minutes: null,
          usage_units_before_cap: 1200,
          requests_before_cap: 25,
          exhaustion_reason: 'reserve_exhausted'
        }
      ],
      nextCursor: cursor
    });

    const router = createAnalyticsRouter({ apiKeys: apiKeys as any, analytics });
    const handlers = getRouteHandlers(router as any, '/v1/admin/analytics/cap-history', 'get');
    const req = createMockReq({
      method: 'GET',
      path: '/v1/admin/analytics/cap-history',
      headers: {
        authorization: 'Bearer admin_token'
      },
      query: {
        provider: 'codex',
        credentialId: '11111111-1111-4111-8111-111111111111',
        limit: '10',
        cursor
      }
    });
    const res = createMockRes();

    await invokeHandlers(handlers, req, res);

    expect(analytics.getCapHistory).toHaveBeenCalledWith({
      window: '7d',
      provider: 'openai',
      orgId: undefined,
      credentialId: '11111111-1111-4111-8111-111111111111',
      limit: 10,
      cursor
    });
    expect(res.body).toEqual({
      window: '7d',
      limit: 10,
      nextCursor: cursor,
      cycles: [
        {
          credentialId: '11111111-1111-4111-8111-111111111111',
          credentialLabel: 'alpha',
          provider: 'anthropic',
          windowKind: '5h',
          exhaustedAt: '2026-03-08T15:00:00.000Z',
          clearedAt: null,
          recoveryMinutes: null,
          usageUnitsBeforeCap: 1200,
          requestsBeforeCap: 25,
          exhaustionReason: 'reserve_exhausted'
        }
      ]
    });
  });

  it('returns session analytics with normalized filters and preview samples', async () => {
    const apiKeys = createApiKeysRepo();
    const analytics = createAnalyticsRepo();
    const cursor = Buffer.from(JSON.stringify({
      lastActivityAt: '2026-03-08T16:05:00.000Z',
      sessionKey: 'openclaw:session:oc_session_123'
    }), 'utf8').toString('base64url');
    analytics.getSessions.mockResolvedValue({
      sessions: [
        {
          session_key: 'openclaw:session:oc_session_123',
          session_type: 'openclaw',
          grouping_basis: 'explicit_session_id',
          started_at: '2026-03-08T15:00:00.000Z',
          ended_at: '2026-03-08T16:05:00.000Z',
          duration_ms: 3900000,
          request_count: 8,
          attempt_count: 10,
          input_tokens: 18000,
          output_tokens: 2300,
          provider_set: ['anthropic', 'openai'],
          model_set: ['claude-opus-4-6', 'gpt-5.2'],
          status_summary: { success: 8, failed: 2 },
          preview_sample: {
            promptPreview: 'fix this bug',
            responsePreview: 'here is a patch'
          }
        }
      ],
      nextCursor: cursor
    });

    const router = createAnalyticsRouter({ apiKeys: apiKeys as any, analytics });
    const handlers = getRouteHandlers(router as any, '/v1/admin/analytics/sessions', 'get');
    const req = createMockReq({
      method: 'GET',
      path: '/v1/admin/analytics/sessions',
      headers: {
        authorization: 'Bearer admin_token'
      },
      query: {
        window: '30d',
        provider: 'codex',
        sessionType: 'openclaw',
        orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
        limit: '15',
        cursor
      }
    });
    const res = createMockRes();

    await invokeHandlers(handlers, req, res);

    expect(analytics.getSessions).toHaveBeenCalledWith({
      window: '1m',
      provider: 'openai',
      source: undefined,
      sessionType: 'openclaw',
      orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      limit: 15,
      cursor
    });
    expect(res.body).toEqual({
      window: '1m',
      limit: 15,
      nextCursor: cursor,
      sessions: [
        {
          sessionKey: 'openclaw:session:oc_session_123',
          sessionType: 'openclaw',
          groupingBasis: 'explicit_session_id',
          startedAt: '2026-03-08T15:00:00.000Z',
          endedAt: '2026-03-08T16:05:00.000Z',
          durationMs: 3900000,
          requestCount: 8,
          attemptCount: 10,
          inputTokens: 18000,
          outputTokens: 2300,
          providerSet: ['anthropic', 'openai'],
          modelSet: ['claude-opus-4-6', 'gpt-5.2'],
          statusSummary: { success: 8, failed: 2 },
          previewSample: {
            promptPreview: 'fix this bug',
            responsePreview: 'here is a patch'
          }
        }
      ]
    });
  });

  it('accepts legacy source aliases for sessions and rejects direct', async () => {
    const apiKeys = createApiKeysRepo();
    const analytics = createAnalyticsRepo();
    const router = createAnalyticsRouter({ apiKeys: apiKeys as any, analytics });
    const handlers = getRouteHandlers(router as any, '/v1/admin/analytics/sessions', 'get');

    const aliasReq = createMockReq({
      method: 'GET',
      path: '/v1/admin/analytics/sessions',
      headers: {
        authorization: 'Bearer admin_token'
      },
      query: {
        source: 'cli-codex'
      }
    });
    const aliasRes = createMockRes();
    await invokeHandlers(handlers, aliasReq, aliasRes);

    expect(analytics.getSessions).toHaveBeenCalledWith({
      window: '7d',
      provider: undefined,
      source: 'cli-codex',
      sessionType: 'cli',
      orgId: undefined,
      limit: 20,
      cursor: undefined
    });

    const directReq = createMockReq({
      method: 'GET',
      path: '/v1/admin/analytics/sessions',
      headers: {
        authorization: 'Bearer admin_token'
      },
      query: {
        source: 'direct'
      }
    });
    const directRes = createMockRes();
    await invokeHandlers(handlers, directReq, directRes);

    expect(directRes.statusCode).toBe(400);
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
          fiveHourReservePercent: null,
          fiveHourUtilizationRatio: null,
          fiveHourResetsAt: null,
          fiveHourContributionCapExhausted: null,
          sevenDayReservePercent: null,
          sevenDayUtilizationRatio: null,
          sevenDayResetsAt: null,
          sevenDayContributionCapExhausted: null,
          providerUsageFetchedAt: null,
          claudeFiveHourCapExhaustionCyclesObserved: null,
          claudeFiveHourUsageUnitsBeforeCapExhaustionLastWindow: null,
          claudeFiveHourAvgUsageUnitsBeforeCapExhaustion: null,
          claudeSevenDayCapExhaustionCyclesObserved: null,
          claudeSevenDayUsageUnitsBeforeCapExhaustionLastWindow: null,
          claudeSevenDayAvgUsageUnitsBeforeCapExhaustion: null,
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
          fiveHourReservePercent: null,
          fiveHourUtilizationRatio: null,
          fiveHourResetsAt: null,
          fiveHourContributionCapExhausted: null,
          sevenDayReservePercent: null,
          sevenDayUtilizationRatio: null,
          sevenDayResetsAt: null,
          sevenDayContributionCapExhausted: null,
          providerUsageFetchedAt: null,
          claudeFiveHourCapExhaustionCyclesObserved: null,
          claudeFiveHourUsageUnitsBeforeCapExhaustionLastWindow: null,
          claudeFiveHourAvgUsageUnitsBeforeCapExhaustion: null,
          claudeSevenDayCapExhaustionCyclesObserved: null,
          claudeSevenDayUsageUnitsBeforeCapExhaustionLastWindow: null,
          claudeSevenDayAvgUsageUnitsBeforeCapExhaustion: null,
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

  it('passes through Claude provider-usage contribution-cap fields when present', async () => {
    const apiKeys = createApiKeysRepo();
    const analytics = createAnalyticsRepo();
    analytics.getTokenHealth.mockResolvedValue([
      {
        credential_id: '33333333-3333-4333-8333-333333333333',
        debug_label: 'gamma',
        provider: 'anthropic',
        status: 'active',
        consecutive_failure_count: 0,
        consecutive_rate_limit_count: 1,
        last_failed_status: null,
        last_failed_at: null,
        last_rate_limited_at: '2026-03-09T02:00:00.000Z',
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
        five_hour_reserve_percent: 20,
        five_hour_utilization_ratio: 0.6,
        five_hour_resets_at: '2026-03-09T05:00:00.000Z',
        five_hour_contribution_cap_exhausted: false,
        seven_day_reserve_percent: 10,
        seven_day_utilization_ratio: 0.72,
        seven_day_resets_at: '2026-03-12T00:00:00.000Z',
        seven_day_contribution_cap_exhausted: true,
        provider_usage_fetched_at: '2026-03-09T02:01:00.000Z',
        claude_five_hour_cap_exhaustion_cycles_observed: 2,
        claude_five_hour_usage_units_before_cap_exhaustion_last_window: 48000,
        claude_five_hour_avg_usage_units_before_cap_exhaustion: 47000,
        claude_seven_day_cap_exhaustion_cycles_observed: 1,
        claude_seven_day_usage_units_before_cap_exhaustion_last_window: 220000,
        claude_seven_day_avg_usage_units_before_cap_exhaustion: 220000,
        created_at: '2026-02-21T00:00:00.000Z',
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
      },
      query: {
        provider: 'anthropic'
      }
    });
    const res = createMockRes();

    await invokeHandlers(handlers, req, res);

    expect(res.body).toEqual({
      window: '7d',
      tokens: [
        {
          credentialId: '33333333-3333-4333-8333-333333333333',
          displayKey: 'cred_3333...3333',
          debugLabel: 'gamma',
          provider: 'anthropic',
          status: 'active',
          consecutiveFailures: 0,
          consecutiveRateLimitCount: 1,
          lastFailedStatus: null,
          lastFailedAt: null,
          lastRateLimitedAt: '2026-03-09T02:00:00.000Z',
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
          fiveHourReservePercent: 20,
          fiveHourUtilizationRatio: 0.6,
          fiveHourResetsAt: '2026-03-09T05:00:00.000Z',
          fiveHourContributionCapExhausted: false,
          sevenDayReservePercent: 10,
          sevenDayUtilizationRatio: 0.72,
          sevenDayResetsAt: '2026-03-12T00:00:00.000Z',
          sevenDayContributionCapExhausted: true,
          providerUsageFetchedAt: '2026-03-09T02:01:00.000Z',
          claudeFiveHourCapExhaustionCyclesObserved: 2,
          claudeFiveHourUsageUnitsBeforeCapExhaustionLastWindow: 48000,
          claudeFiveHourAvgUsageUnitsBeforeCapExhaustion: 47000,
          claudeSevenDayCapExhaustionCyclesObserved: 1,
          claudeSevenDayUsageUnitsBeforeCapExhaustionLastWindow: 220000,
          claudeSevenDayAvgUsageUnitsBeforeCapExhaustion: 220000,
          createdAt: '2026-02-21T00:00:00.000Z',
          expiresAt: null
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
        utilization_rate_24h: 0.75,
        five_hour_reserve_percent: null,
        five_hour_utilization_ratio: null,
        five_hour_resets_at: null,
        five_hour_contribution_cap_exhausted: null,
        seven_day_reserve_percent: null,
        seven_day_utilization_ratio: null,
        seven_day_resets_at: null,
        seven_day_contribution_cap_exhausted: null,
        provider_usage_fetched_at: null
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
    expect((res.body as any).warnings).toEqual([
      'alpha: provider_usage_snapshot_missing - Codex token has no provider-usage snapshot yet; dashboard usage state may lag until one arrives.'
    ]);
    expect((res.body as any).tokens).toEqual([
      {
        credentialId: '11111111-1111-4111-8111-111111111111',
        displayKey: 'cred_1111...1111',
        debugLabel: 'alpha',
        provider: 'openai',
        rawStatus: 'active',
        status: 'active*',
        compactStatus: 'active*',
        expandedStatus: 'active, excluded: rate_limited',
        statusSource: null,
        exclusionReason: 'rate_limited',
        attempts: 12,
        requests: 10,
        usageUnits: 100,
        percentOfWindow: 1,
        utilizationRate24h: 0.75,
        maxedEvents7d: 2,
        monthlyContributionUsedUnits: 55,
        monthlyContributionLimitUnits: 500,
        fiveHourReservePercent: null,
        fiveHourUtilizationRatio: null,
        fiveHourResetsAt: null,
        fiveHourContributionCapExhausted: null,
        sevenDayReservePercent: null,
        sevenDayUtilizationRatio: null,
        sevenDayResetsAt: null,
        sevenDayContributionCapExhausted: null,
        providerUsageFetchedAt: null,
        claudeFiveHourCapExhaustionCyclesObserved: null,
        claudeFiveHourUsageUnitsBeforeCapExhaustionLastWindow: null,
        claudeFiveHourAvgUsageUnitsBeforeCapExhaustion: null,
        claudeSevenDayCapExhaustionCyclesObserved: null,
        claudeSevenDayUsageUnitsBeforeCapExhaustionLastWindow: null,
        claudeSevenDayAvgUsageUnitsBeforeCapExhaustion: null,
        latencyP50Ms: 220,
        errorRate: 0,
        authFailures24h: 1,
        rateLimited24h: 2
      }
    ]);
  });

  it('marks Codex dashboard token rows as benched when provider usage shows an exhausted window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-12T12:10:00.000Z'));

    const apiKeys = createApiKeysRepo();
    const analytics = createAnalyticsRepo();
    analytics.getSystemSummary.mockResolvedValue({
      total_requests: 10,
      total_usage_units: 100,
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
    analytics.getTokenUsage.mockResolvedValue([
      {
        credential_id: '55555555-5555-4555-8555-555555555555',
        debug_label: 'codex-alpha',
        provider: 'openai',
        status: 'active',
        attempts: 5,
        requests: 5,
        usage_units: 100,
        by_source: []
      }
    ]);
    analytics.getTokenHealth.mockResolvedValue([
      {
        credential_id: '55555555-5555-4555-8555-555555555555',
        debug_label: 'codex-alpha',
        provider: 'openai',
        status: 'active',
        consecutive_rate_limit_count: 0,
        rate_limited_until: null,
        monthly_contribution_used_units: 0,
        monthly_contribution_limit_units: null,
        maxed_events_7d: 0,
        utilization_rate_24h: null,
        five_hour_reserve_percent: null,
        five_hour_utilization_ratio: 1,
        five_hour_resets_at: '2026-03-12T14:00:00.000Z',
        five_hour_contribution_cap_exhausted: null,
        seven_day_reserve_percent: null,
        seven_day_utilization_ratio: 0.2,
        seven_day_resets_at: '2026-03-15T00:00:00.000Z',
        seven_day_contribution_cap_exhausted: null,
        provider_usage_fetched_at: '2026-03-12T12:09:00.000Z'
      }
    ]);
    analytics.getTokenRouting.mockResolvedValue([]);
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
      }
    });
    const res = createMockRes();

    await invokeHandlers(handlers, req, res);

    expect((res.body as any).summary).toEqual(expect.objectContaining({
      activeTokens: 0,
      maxedTokens: 1,
      totalTokens: 1
    }));
    expect((res.body as any).tokens).toEqual([
      expect.objectContaining({
        credentialId: '55555555-5555-4555-8555-555555555555',
        provider: 'openai',
        rawStatus: 'active',
        status: 'benched',
        compactStatus: 'benched',
        expandedStatus: 'benched, source: usage_exhausted',
        statusSource: 'usage_exhausted',
        exclusionReason: null,
        fiveHourUtilizationRatio: 1,
        providerUsageFetchedAt: '2026-03-12T12:09:00.000Z'
      })
    ]);
    expect((res.body as any).warnings).toEqual([
      'codex-alpha: usage_exhausted_5h - Codex usage is exhausted for the 5h window until 2026-03-12T14:00:00.000Z.'
    ]);
  });

  it('marks Claude dashboard token rows as benched when provider usage has exhausted a contribution cap', async () => {
    const apiKeys = createApiKeysRepo();
    const analytics = createAnalyticsRepo();
    analytics.getSystemSummary.mockResolvedValue({
      total_requests: 10,
      total_usage_units: 100,
      active_tokens: 0,
      maxed_tokens: 1,
      total_tokens: 1,
      maxed_events_7d: 0,
      error_rate: 0,
      fallback_rate: 0,
      by_provider: [],
      by_model: [],
      by_source: []
    });
    analytics.getTokenUsage.mockResolvedValue([
      {
        credential_id: '22222222-2222-4222-8222-222222222222',
        debug_label: 'claude-alpha',
        provider: 'anthropic',
        status: 'active',
        attempts: 5,
        requests: 5,
        usage_units: 100,
        by_source: []
      }
    ]);
    analytics.getTokenHealth.mockResolvedValue([
      {
        credential_id: '22222222-2222-4222-8222-222222222222',
        debug_label: 'claude-alpha',
        provider: 'anthropic',
        status: 'active',
        consecutive_rate_limit_count: 0,
        rate_limited_until: null,
        monthly_contribution_used_units: 0,
        monthly_contribution_limit_units: null,
        maxed_events_7d: 0,
        utilization_rate_24h: null,
        five_hour_reserve_percent: 20,
        five_hour_utilization_ratio: 0.81,
        five_hour_resets_at: '2026-03-12T14:00:00.000Z',
        five_hour_contribution_cap_exhausted: true,
        seven_day_reserve_percent: 0,
        seven_day_utilization_ratio: 0.2,
        seven_day_resets_at: '2026-03-15T00:00:00.000Z',
        seven_day_contribution_cap_exhausted: false,
        provider_usage_fetched_at: '2026-03-12T12:00:00.000Z'
      }
    ]);
    analytics.getTokenRouting.mockResolvedValue([]);
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
      }
    });
    const res = createMockRes();

    await invokeHandlers(handlers, req, res);

    expect((res.body as any).summary).toEqual(expect.objectContaining({
      activeTokens: 0,
      maxedTokens: 1,
      totalTokens: 1
    }));
    expect((res.body as any).tokens).toEqual([
      expect.objectContaining({
        credentialId: '22222222-2222-4222-8222-222222222222',
        provider: 'anthropic',
        rawStatus: 'active',
        status: 'benched',
        compactStatus: 'benched',
        expandedStatus: 'benched, source: cap_exhausted',
        statusSource: 'cap_exhausted',
        exclusionReason: null,
        fiveHourContributionCapExhausted: true
      })
    ]);
  });

  it('derives dashboard summary token counts from visible token rows and hides expired credentials', async () => {
    const apiKeys = createApiKeysRepo();
    const analytics = createAnalyticsRepo();
    analytics.getSystemSummary.mockResolvedValue({
      total_requests: 10,
      total_usage_units: 100,
      active_tokens: 1,
      maxed_tokens: 1,
      total_tokens: 2,
      maxed_events_7d: 0,
      error_rate: 0,
      fallback_rate: 0,
      by_provider: [],
      by_model: [],
      by_source: []
    });
    analytics.getTokenUsage.mockResolvedValue([
      {
        credential_id: '11111111-1111-4111-8111-111111111111',
        debug_label: 'active-row',
        provider: 'openai',
        status: 'active',
        attempts: 5,
        requests: 5,
        usage_units: 100,
        by_source: []
      }
    ]);
    analytics.getTokenHealth.mockResolvedValue([
      {
        credential_id: '11111111-1111-4111-8111-111111111111',
        debug_label: 'active-row',
        provider: 'openai',
        status: 'active',
        consecutive_rate_limit_count: 0,
        rate_limited_until: null,
        monthly_contribution_used_units: 0,
        monthly_contribution_limit_units: null,
        maxed_events_7d: 0,
        utilization_rate_24h: null,
        five_hour_reserve_percent: null,
        five_hour_utilization_ratio: null,
        five_hour_resets_at: null,
        five_hour_contribution_cap_exhausted: null,
        seven_day_reserve_percent: null,
        seven_day_utilization_ratio: null,
        seven_day_resets_at: null,
        seven_day_contribution_cap_exhausted: null,
        provider_usage_fetched_at: null
      },
      {
        credential_id: '22222222-2222-4222-8222-222222222222',
        debug_label: 'expired-maxed-row',
        provider: 'anthropic',
        status: 'expired',
        consecutive_rate_limit_count: 0,
        rate_limited_until: null,
        monthly_contribution_used_units: 0,
        monthly_contribution_limit_units: null,
        maxed_events_7d: 0,
        utilization_rate_24h: null,
        five_hour_reserve_percent: 20,
        five_hour_utilization_ratio: 0.95,
        five_hour_resets_at: '2026-03-12T14:00:00.000Z',
        five_hour_contribution_cap_exhausted: true,
        seven_day_reserve_percent: 0,
        seven_day_utilization_ratio: 0.2,
        seven_day_resets_at: '2026-03-15T00:00:00.000Z',
        seven_day_contribution_cap_exhausted: false,
        provider_usage_fetched_at: '2026-03-12T12:00:00.000Z'
      }
    ]);
    analytics.getTokenRouting.mockResolvedValue([]);
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
      }
    });
    const res = createMockRes();

    await invokeHandlers(handlers, req, res);

    expect((res.body as any).summary).toEqual(expect.objectContaining({
      activeTokens: 1,
      maxedTokens: 0,
      totalTokens: 1
    }));
    expect((res.body as any).tokens).toEqual([
      expect.objectContaining({
        credentialId: '11111111-1111-4111-8111-111111111111',
        rawStatus: 'active',
        status: 'active',
        compactStatus: 'active',
        expandedStatus: 'active'
      })
    ]);
  });

  it('keeps legacy Claude maxed status visible as backend benched in dashboard rows', async () => {
    const apiKeys = createApiKeysRepo();
    const analytics = createAnalyticsRepo();
    analytics.getSystemSummary.mockResolvedValue({
      total_requests: 10,
      total_usage_units: 100,
      active_tokens: 0,
      maxed_tokens: 1,
      total_tokens: 1,
      maxed_events_7d: 0,
      error_rate: 0,
      fallback_rate: 0,
      by_provider: [],
      by_model: [],
      by_source: []
    });
    analytics.getTokenUsage.mockResolvedValue([
      {
        credential_id: '33333333-3333-4333-8333-333333333333',
        debug_label: 'legacy-claude-maxed',
        provider: 'anthropic',
        status: 'maxed',
        attempts: 5,
        requests: 5,
        usage_units: 100,
        by_source: []
      }
    ]);
    analytics.getTokenHealth.mockResolvedValue([
      {
        credential_id: '33333333-3333-4333-8333-333333333333',
        debug_label: 'legacy-claude-maxed',
        provider: 'anthropic',
        status: 'maxed',
        consecutive_rate_limit_count: 15,
        rate_limited_until: null,
        monthly_contribution_used_units: 0,
        monthly_contribution_limit_units: null,
        maxed_events_7d: 1,
        utilization_rate_24h: null,
        five_hour_reserve_percent: 0,
        five_hour_utilization_ratio: 0.55,
        five_hour_resets_at: '2026-03-12T20:00:00.000Z',
        five_hour_contribution_cap_exhausted: false,
        seven_day_reserve_percent: 0,
        seven_day_utilization_ratio: 0.18,
        seven_day_resets_at: '2026-03-20T10:00:00.000Z',
        seven_day_contribution_cap_exhausted: false,
        provider_usage_fetched_at: '2026-03-12T12:00:00.000Z'
      }
    ]);
    analytics.getTokenRouting.mockResolvedValue([]);
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
      }
    });
    const res = createMockRes();

    await invokeHandlers(handlers, req, res);

    expect((res.body as any).summary).toEqual(expect.objectContaining({
      activeTokens: 0,
      maxedTokens: 1,
      totalTokens: 1
    }));
    expect((res.body as any).tokens).toEqual([
      expect.objectContaining({
        credentialId: '33333333-3333-4333-8333-333333333333',
        provider: 'anthropic',
        rawStatus: 'maxed',
        status: 'benched',
        compactStatus: 'benched',
        expandedStatus: 'benched, source: backend_maxed',
        statusSource: 'backend_maxed',
        exclusionReason: null,
        fiveHourContributionCapExhausted: false,
        sevenDayContributionCapExhausted: false
      })
    ]);
  });

  it('surfaces auth-failed Claude maxed credentials as auth_failed warnings instead of stale quota warnings', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-13T22:10:00.000Z'));

    const apiKeys = createApiKeysRepo();
    const analytics = createAnalyticsRepo();
    analytics.getSystemSummary.mockResolvedValue({
      total_requests: 10,
      total_usage_units: 100,
      active_tokens: 0,
      maxed_tokens: 1,
      total_tokens: 1,
      maxed_events_7d: 0,
      error_rate: 0,
      fallback_rate: 0,
      by_provider: [],
      by_model: [],
      by_source: []
    });
    analytics.getTokenUsage.mockResolvedValue([
      {
        credential_id: '44444444-4444-4444-8444-444444444444',
        debug_label: 'darryn',
        provider: 'anthropic',
        status: 'maxed',
        attempts: 5,
        requests: 5,
        usage_units: 100,
        by_source: []
      }
    ]);
    analytics.getTokenHealth.mockResolvedValue([
      {
        credential_id: '44444444-4444-4444-8444-444444444444',
        debug_label: 'darryn',
        provider: 'anthropic',
        status: 'maxed',
        consecutive_failure_count: 30,
        consecutive_rate_limit_count: 0,
        last_failed_status: 401,
        rate_limited_until: null,
        next_probe_at: '2026-03-13T23:34:18.269Z',
        monthly_contribution_used_units: 0,
        monthly_contribution_limit_units: null,
        maxed_events_7d: 1,
        utilization_rate_24h: null,
        five_hour_reserve_percent: 0,
        five_hour_utilization_ratio: 0.55,
        five_hour_resets_at: '2026-03-14T00:00:00.686Z',
        five_hour_contribution_cap_exhausted: false,
        seven_day_reserve_percent: 0,
        seven_day_utilization_ratio: 0.18,
        seven_day_resets_at: '2026-03-20T14:00:00.686Z',
        seven_day_contribution_cap_exhausted: false,
        provider_usage_fetched_at: '2026-03-13T21:04:16.710Z',
        last_refresh_error: 'upstream_401_consecutive_failure'
      }
    ]);
    analytics.getTokenRouting.mockResolvedValue([]);
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
      }
    });
    const res = createMockRes();

    await invokeHandlers(handlers, req, res);

    expect((res.body as any).summary).toEqual(expect.objectContaining({
      activeTokens: 0,
      maxedTokens: 1,
      totalTokens: 1
    }));
    expect((res.body as any).tokens).toEqual([
      expect.objectContaining({
        credentialId: '44444444-4444-4444-8444-444444444444',
        provider: 'anthropic',
        rawStatus: 'maxed',
        status: 'benched',
        compactStatus: 'benched',
        expandedStatus: 'benched, source: backend_maxed',
        statusSource: 'backend_maxed',
        exclusionReason: null
      })
    ]);
    expect((res.body as any).warnings).toEqual([
      'darryn: auth_failed - Claude credential is parked after upstream 401 failures; next probe at 2026-03-13T23:34:18.269Z.'
    ]);
  });

  it('surfaces Claude provider-usage warnings in dashboard snapshots', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-12T12:10:00.000Z'));

    const apiKeys = createApiKeysRepo();
    const analytics = createAnalyticsRepo();
    analytics.getSystemSummary.mockResolvedValue({
      total_requests: 10,
      total_usage_units: 100,
      active_tokens: 2,
      maxed_tokens: 0,
      total_tokens: 2,
      maxed_events_7d: 0,
      error_rate: 0,
      fallback_rate: 0,
      by_provider: [],
      by_model: [],
      by_source: []
    });
    analytics.getTokenUsage.mockResolvedValue([]);
    analytics.getTokenHealth.mockResolvedValue([
      {
        credential_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        debug_label: 'alpha',
        provider: 'anthropic',
        status: 'active',
        monthly_contribution_used_units: 0,
        maxed_events_7d: 0,
        maxing_cycles_observed: 0,
        five_hour_reserve_percent: 20,
        five_hour_utilization_ratio: null,
        five_hour_resets_at: null,
        five_hour_contribution_cap_exhausted: null,
        seven_day_reserve_percent: 0,
        seven_day_utilization_ratio: null,
        seven_day_resets_at: null,
        seven_day_contribution_cap_exhausted: null,
        provider_usage_fetched_at: null,
        last_refresh_error: null
      },
      {
        credential_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        debug_label: 'beta',
        provider: 'anthropic',
        status: 'active',
        monthly_contribution_used_units: 0,
        maxed_events_7d: 0,
        maxing_cycles_observed: 0,
        five_hour_reserve_percent: 0,
        five_hour_utilization_ratio: 0.55,
        five_hour_resets_at: '2026-03-12T14:00:00.000Z',
        five_hour_contribution_cap_exhausted: false,
        seven_day_reserve_percent: 10,
        seven_day_utilization_ratio: 0.95,
        seven_day_resets_at: '2026-03-15T00:00:00.000Z',
        seven_day_contribution_cap_exhausted: true,
        provider_usage_fetched_at: '2026-03-12T11:59:00.000Z',
        last_refresh_error: null
      }
    ]);
    analytics.getTokenRouting.mockResolvedValue([]);
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
      }
    });
    const res = createMockRes();

    await invokeHandlers(handlers, req, res);

    expect((res.body as any).warnings).toEqual([
      'alpha: provider_usage_snapshot_missing - reserved Claude token has no provider-usage snapshot yet; pooled routing excludes it until one arrives.',
      'beta: provider_usage_snapshot_soft_stale - last Claude usage snapshot is 11m old; routing is still using the last successful snapshot.',
      'beta: usage_exhausted_7d - pooled Claude routing is at the 7d cap until 2026-03-15T00:00:00.000Z.'
    ]);
  });

  it('hides expired Claude rows from dashboard output and suppresses stale provider-usage warnings', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-14T13:45:00.000Z'));

    const apiKeys = createApiKeysRepo();
    const analytics = createAnalyticsRepo();
    analytics.getSystemSummary.mockResolvedValue({
      total_requests: 10,
      total_usage_units: 100,
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
    analytics.getTokenHealth.mockResolvedValue([
      {
        credential_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        debug_label: 'shirtless',
        provider: 'anthropic',
        status: 'active',
        monthly_contribution_used_units: 0,
        maxed_events_7d: 0,
        maxing_cycles_observed: 0,
        five_hour_reserve_percent: 10,
        five_hour_utilization_ratio: 0.9,
        five_hour_resets_at: '2026-03-14T10:00:00.269Z',
        five_hour_contribution_cap_exhausted: true,
        seven_day_reserve_percent: 15,
        seven_day_utilization_ratio: 0.59,
        seven_day_resets_at: '2026-03-20T04:00:00.269Z',
        seven_day_contribution_cap_exhausted: false,
        provider_usage_fetched_at: '2026-03-14T09:58:51.583Z',
        last_refresh_error: 'provider_usage_fetch_backoff_active',
        expires_at: '2026-03-14T10:03:52.209Z'
      }
    ]);
    analytics.getTokenRouting.mockResolvedValue([]);
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
      }
    });
    const res = createMockRes();

    await invokeHandlers(handlers, req, res);

    expect((res.body as any).summary).toEqual(expect.objectContaining({
      activeTokens: 0,
      maxedTokens: 0,
      totalTokens: 0
    }));
    expect((res.body as any).tokens).toEqual([]);
    expect((res.body as any).warnings).toEqual([]);
  });

  it('keeps true 100%-usage exhaustion warnings visible without degrading them into stale-snapshot warnings', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-12T12:20:00.000Z'));

    const apiKeys = createApiKeysRepo();
    const analytics = createAnalyticsRepo();
    analytics.getSystemSummary.mockResolvedValue({
      total_requests: 10,
      total_usage_units: 100,
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
    analytics.getTokenHealth.mockResolvedValue([
      {
        credential_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        debug_label: 'beta',
        provider: 'anthropic',
        status: 'active',
        monthly_contribution_used_units: 0,
        maxed_events_7d: 0,
        maxing_cycles_observed: 0,
        five_hour_reserve_percent: 0,
        five_hour_utilization_ratio: 1,
        five_hour_resets_at: '2026-03-12T13:00:00.000Z',
        five_hour_contribution_cap_exhausted: true,
        seven_day_reserve_percent: 0,
        seven_day_utilization_ratio: 0.4,
        seven_day_resets_at: '2026-03-15T00:00:00.000Z',
        seven_day_contribution_cap_exhausted: false,
        provider_usage_fetched_at: '2026-03-12T12:00:00.000Z',
        last_refresh_error: null
      }
    ]);
    analytics.getTokenRouting.mockResolvedValue([]);
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
      }
    });
    const res = createMockRes();

    await invokeHandlers(handlers, req, res);

    expect((res.body as any).warnings).toEqual([
      'beta: usage_exhausted_5h - pooled Claude routing is at the 5h cap until 2026-03-12T13:00:00.000Z.'
    ]);
  });

  it('surfaces missing-snapshot and fetch/backoff warnings even before any Claude snapshot exists', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-12T12:10:00.000Z'));

    const apiKeys = createApiKeysRepo();
    const analytics = createAnalyticsRepo();
    analytics.getSystemSummary.mockResolvedValue({
      total_requests: 10,
      total_usage_units: 100,
      active_tokens: 3,
      maxed_tokens: 0,
      total_tokens: 3,
      maxed_events_7d: 0,
      error_rate: 0,
      fallback_rate: 0,
      by_provider: [],
      by_model: [],
      by_source: []
    });
    analytics.getTokenUsage.mockResolvedValue([]);
    analytics.getTokenHealth.mockResolvedValue([
      {
        credential_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        debug_label: 'alpha',
        provider: 'anthropic',
        status: 'active',
        monthly_contribution_used_units: 0,
        maxed_events_7d: 0,
        maxing_cycles_observed: 0,
        five_hour_reserve_percent: 20,
        five_hour_utilization_ratio: null,
        five_hour_resets_at: null,
        five_hour_contribution_cap_exhausted: null,
        seven_day_reserve_percent: 0,
        seven_day_utilization_ratio: null,
        seven_day_resets_at: null,
        seven_day_contribution_cap_exhausted: null,
        provider_usage_fetched_at: null,
        last_refresh_error: null
      },
      {
        credential_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        debug_label: 'beta',
        provider: 'anthropic',
        status: 'active',
        monthly_contribution_used_units: 0,
        maxed_events_7d: 0,
        maxing_cycles_observed: 0,
        five_hour_reserve_percent: 0,
        five_hour_utilization_ratio: null,
        five_hour_resets_at: null,
        five_hour_contribution_cap_exhausted: null,
        seven_day_reserve_percent: 0,
        seven_day_utilization_ratio: null,
        seven_day_resets_at: null,
        seven_day_contribution_cap_exhausted: null,
        provider_usage_fetched_at: null,
        last_refresh_error: 'provider_usage_fetch_failed'
      },
      {
        credential_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        debug_label: 'gamma',
        provider: 'anthropic',
        status: 'active',
        monthly_contribution_used_units: 0,
        maxed_events_7d: 0,
        maxing_cycles_observed: 0,
        five_hour_reserve_percent: 0,
        five_hour_utilization_ratio: null,
        five_hour_resets_at: null,
        five_hour_contribution_cap_exhausted: null,
        seven_day_reserve_percent: 0,
        seven_day_utilization_ratio: null,
        seven_day_resets_at: null,
        seven_day_contribution_cap_exhausted: null,
        provider_usage_fetched_at: null,
        last_refresh_error: 'provider_usage_fetch_backoff_active'
      }
    ]);
    analytics.getTokenRouting.mockResolvedValue([]);
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
      }
    });
    const res = createMockRes();

    await invokeHandlers(handlers, req, res);

    expect((res.body as any).warnings).toEqual([
      'alpha: provider_usage_snapshot_missing - reserved Claude token has no provider-usage snapshot yet; pooled routing excludes it until one arrives.',
      'beta: provider_usage_fetch_failed - last Claude usage refresh failed; dashboard freshness/cap state may lag until a successful refresh.',
      'gamma: provider_usage_fetch_backoff_active - Claude usage refresh is temporarily backing off after recent fetch failures; dashboard freshness/cap state may lag until retry.'
    ]);
  });

  it('does not surface provider-usage warnings for revoked or expired Claude credentials', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-12T12:10:00.000Z'));

    const apiKeys = createApiKeysRepo();
    const analytics = createAnalyticsRepo();
    analytics.getSystemSummary.mockResolvedValue({
      total_requests: 10,
      total_usage_units: 100,
      active_tokens: 1,
      maxed_tokens: 0,
      total_tokens: 3,
      maxed_events_7d: 0,
      error_rate: 0,
      fallback_rate: 0,
      by_provider: [],
      by_model: [],
      by_source: []
    });
    analytics.getTokenUsage.mockResolvedValue([]);
    analytics.getTokenHealth.mockResolvedValue([
      {
        credential_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        debug_label: 'alpha',
        provider: 'anthropic',
        status: 'active',
        monthly_contribution_used_units: 0,
        maxed_events_7d: 0,
        maxing_cycles_observed: 0,
        five_hour_reserve_percent: 0,
        five_hour_utilization_ratio: 0.55,
        five_hour_resets_at: '2026-03-12T14:00:00.000Z',
        five_hour_contribution_cap_exhausted: false,
        seven_day_reserve_percent: 0,
        seven_day_utilization_ratio: 0.65,
        seven_day_resets_at: '2026-03-15T00:00:00.000Z',
        seven_day_contribution_cap_exhausted: false,
        provider_usage_fetched_at: '2026-03-12T12:09:00.000Z',
        last_refresh_error: 'provider_usage_fetch_failed'
      },
      {
        credential_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        debug_label: 'beta',
        provider: 'anthropic',
        status: 'revoked',
        monthly_contribution_used_units: 0,
        maxed_events_7d: 0,
        maxing_cycles_observed: 0,
        five_hour_reserve_percent: 0,
        five_hour_utilization_ratio: null,
        five_hour_resets_at: null,
        five_hour_contribution_cap_exhausted: null,
        seven_day_reserve_percent: 0,
        seven_day_utilization_ratio: null,
        seven_day_resets_at: null,
        seven_day_contribution_cap_exhausted: null,
        provider_usage_fetched_at: null,
        last_refresh_error: 'provider_usage_fetch_backoff_active'
      },
      {
        credential_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        debug_label: 'gamma',
        provider: 'anthropic',
        status: 'expired',
        monthly_contribution_used_units: 0,
        maxed_events_7d: 0,
        maxing_cycles_observed: 0,
        five_hour_reserve_percent: 20,
        five_hour_utilization_ratio: null,
        five_hour_resets_at: null,
        five_hour_contribution_cap_exhausted: null,
        seven_day_reserve_percent: 0,
        seven_day_utilization_ratio: null,
        seven_day_resets_at: null,
        seven_day_contribution_cap_exhausted: null,
        provider_usage_fetched_at: null,
        last_refresh_error: null
      }
    ]);
    analytics.getTokenRouting.mockResolvedValue([]);
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
      }
    });
    const res = createMockRes();

    await invokeHandlers(handlers, req, res);

    expect((res.body as any).warnings).toEqual([
      'alpha: provider_usage_fetch_failed - last Claude usage refresh failed; dashboard freshness/cap state may lag until a successful refresh.'
    ]);
  });

  it('returns a fresh cached dashboard snapshot without recomputing analytics', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-12T12:00:02.000Z'));

    const apiKeys = createApiKeysRepo();
    const analytics = createAnalyticsRepo();
    const dashboardSnapshots = createDashboardSnapshotStore();
    const cachedPayload = createDashboardSnapshotPayload({
      snapshotAt: '2026-03-12T12:00:01.000Z',
      summary: {
        totalRequests: 42,
        totalUsageUnits: 88,
        activeTokens: 2,
        maxedTokens: 0,
        totalTokens: 2,
        maxedEvents7d: 0,
        errorRate: 0.1,
        fallbackRate: 0.05,
        byProvider: [],
        byModel: [],
        bySource: []
      }
    });
    dashboardSnapshots.get.mockResolvedValue(
      createDashboardSnapshotRecord(cachedPayload, '2026-03-12T12:00:01.000Z')
    );

    const router = createAnalyticsRouter({
      apiKeys: apiKeys as any,
      analytics,
      dashboardSnapshots: dashboardSnapshots as any
    });
    const handlers = getRouteHandlers(router as any, '/v1/admin/analytics/dashboard', 'get');
    const req = createMockReq({
      method: 'GET',
      path: '/v1/admin/analytics/dashboard',
      headers: {
        authorization: 'Bearer admin_token'
      }
    });
    const res = createMockRes();

    await invokeHandlers(handlers, req, res);

    expect(dashboardSnapshots.refreshIfLockAvailable).not.toHaveBeenCalled();
    expect(analytics.getSystemSummary).not.toHaveBeenCalled();
    expect(res.body).toEqual(cachedPayload);
  });

  it('threads orgId through admin dashboard cache lookups and analytics queries', async () => {
    const apiKeys = createApiKeysRepo();
    const analytics = createAnalyticsRepo();
    analytics.getEvents.mockResolvedValue([]);
    const dashboardSnapshots = createDashboardSnapshotStore();
    dashboardSnapshots.get.mockResolvedValue(null);
    dashboardSnapshots.refreshIfLockAvailable.mockImplementation(async (_query, buildPayload) => (
      createDashboardSnapshotRecord(await buildPayload(), '2026-03-12T12:00:10.000Z', {
        orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d'
      })
    ));

    const router = createAnalyticsRouter({
      apiKeys: apiKeys as any,
      analytics,
      dashboardSnapshots: dashboardSnapshots as any
    });
    const handlers = getRouteHandlers(router as any, '/v1/admin/analytics/dashboard', 'get');
    const req = createMockReq({
      method: 'GET',
      path: '/v1/admin/analytics/dashboard',
      headers: {
        authorization: 'Bearer admin_token'
      },
      query: {
        orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d'
      }
    });
    const res = createMockRes();

    await invokeHandlers(handlers, req, res);

    expect(dashboardSnapshots.get).toHaveBeenCalledWith({
      window: '24h',
      provider: undefined,
      source: undefined,
      orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d'
    });
    expect(dashboardSnapshots.refreshIfLockAvailable).toHaveBeenCalledWith(
      {
        window: '24h',
        provider: undefined,
        source: undefined,
        orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d'
      },
      expect.any(Function)
    );
    expect(analytics.getSystemSummary).toHaveBeenCalledWith({
      window: '24h',
      provider: undefined,
      source: undefined,
      orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d'
    });
    expect(analytics.getTokenUsage).toHaveBeenCalledWith({
      window: '24h',
      provider: undefined,
      source: undefined,
      orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d'
    });
  });

  it('threads orgId through admin timeseries filters', async () => {
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
        window: '24h',
        credentialId: '11111111-1111-4111-8111-111111111111',
        orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d'
      }
    });
    const res = createMockRes();

    await invokeHandlers(handlers, req, res);

    expect(analytics.getTimeSeries).toHaveBeenCalledWith({
      window: '24h',
      provider: undefined,
      source: undefined,
      credentialId: '11111111-1111-4111-8111-111111111111',
      granularity: '15m',
      orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d'
    });
  });

  it('refreshes a stale dashboard snapshot when the refresh lock is available', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-12T12:00:10.000Z'));

    const apiKeys = createApiKeysRepo();
    const analytics = createAnalyticsRepo();
    const dashboardSnapshots = createDashboardSnapshotStore();
    dashboardSnapshots.get.mockResolvedValue(
      createDashboardSnapshotRecord(undefined, '2026-03-12T12:00:00.000Z')
    );
    dashboardSnapshots.refreshIfLockAvailable.mockImplementation(async (_query, buildPayload) => (
      createDashboardSnapshotRecord(await buildPayload(), '2026-03-12T12:00:10.000Z')
    ));
    analytics.getSystemSummary.mockResolvedValue({
      total_requests: 5,
      total_usage_units: 50,
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
    analytics.getEvents.mockResolvedValue([]);

    const router = createAnalyticsRouter({
      apiKeys: apiKeys as any,
      analytics,
      dashboardSnapshots: dashboardSnapshots as any
    });
    const handlers = getRouteHandlers(router as any, '/v1/admin/analytics/dashboard', 'get');
    const req = createMockReq({
      method: 'GET',
      path: '/v1/admin/analytics/dashboard',
      headers: {
        authorization: 'Bearer admin_token'
      }
    });
    const res = createMockRes();

    await invokeHandlers(handlers, req, res);

    expect(dashboardSnapshots.refreshIfLockAvailable).toHaveBeenCalledTimes(1);
    expect(analytics.getSystemSummary).toHaveBeenCalledWith({
      window: '24h',
      provider: undefined,
      source: undefined
    });
    expect((res.body as any).summary).toEqual(expect.objectContaining({
      totalRequests: 5,
      totalUsageUnits: 50,
      activeTokens: 1,
      maxedTokens: 0,
      totalTokens: 1,
      maxedEvents7d: 0,
      errorRate: 0,
      fallbackRate: 0
    }));
  });

  it('serves the stale dashboard snapshot while another request is refreshing it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-12T12:00:10.000Z'));

    const apiKeys = createApiKeysRepo();
    const analytics = createAnalyticsRepo();
    const dashboardSnapshots = createDashboardSnapshotStore();
    const stalePayload = createDashboardSnapshotPayload({
      snapshotAt: '2026-03-12T11:59:59.000Z',
      summary: {
        totalRequests: 9,
        totalUsageUnits: 90,
        activeTokens: 3,
        maxedTokens: 1,
        totalTokens: 4,
        maxedEvents7d: 1,
        errorRate: 0.2,
        fallbackRate: 0.1,
        byProvider: [],
        byModel: [],
        bySource: []
      }
    });
    dashboardSnapshots.get.mockResolvedValue(
      createDashboardSnapshotRecord(stalePayload, '2026-03-12T12:00:00.000Z')
    );
    dashboardSnapshots.refreshIfLockAvailable.mockResolvedValue(null);

    const router = createAnalyticsRouter({
      apiKeys: apiKeys as any,
      analytics,
      dashboardSnapshots: dashboardSnapshots as any
    });
    const handlers = getRouteHandlers(router as any, '/v1/admin/analytics/dashboard', 'get');
    const req = createMockReq({
      method: 'GET',
      path: '/v1/admin/analytics/dashboard',
      headers: {
        authorization: 'Bearer admin_token'
      }
    });
    const res = createMockRes();

    await invokeHandlers(handlers, req, res);

    expect(analytics.getSystemSummary).not.toHaveBeenCalled();
    expect(res.body).toEqual(stalePayload);
  });

  it('falls back to inline dashboard computation on a cold miss when no lock is available', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-12T12:00:10.000Z'));

    const apiKeys = createApiKeysRepo();
    const analytics = createAnalyticsRepo();
    const dashboardSnapshots = createDashboardSnapshotStore();
    dashboardSnapshots.get.mockResolvedValue(null);
    dashboardSnapshots.refreshIfLockAvailable.mockResolvedValue(null);
    analytics.getSystemSummary.mockResolvedValue({
      total_requests: 7,
      total_usage_units: 77,
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
    analytics.getEvents.mockResolvedValue([]);

    const router = createAnalyticsRouter({
      apiKeys: apiKeys as any,
      analytics,
      dashboardSnapshots: dashboardSnapshots as any
    });
    const handlers = getRouteHandlers(router as any, '/v1/admin/analytics/dashboard', 'get');
    const req = createMockReq({
      method: 'GET',
      path: '/v1/admin/analytics/dashboard',
      headers: {
        authorization: 'Bearer admin_token'
      }
    });
    const res = createMockRes();

    await invokeHandlers(handlers, req, res);

    expect(dashboardSnapshots.refreshIfLockAvailable).toHaveBeenCalledTimes(1);
    expect(analytics.getSystemSummary).toHaveBeenCalledTimes(1);
    expect((res.body as any).summary).toEqual(expect.objectContaining({
      totalRequests: 7,
      totalUsageUnits: 77,
      activeTokens: 1,
      maxedTokens: 0,
      totalTokens: 1,
      maxedEvents7d: 0,
      errorRate: 0,
      fallbackRate: 0
    }));
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
        rawStatus: 'active',
        status: 'active',
        compactStatus: 'active',
        expandedStatus: 'active',
        statusSource: null,
        exclusionReason: null,
        attempts: 7,
        requests: 0,
        usageUnits: 0,
        percentOfWindow: 0,
        utilizationRate24h: null,
        maxedEvents7d: 0,
        monthlyContributionUsedUnits: 0,
        monthlyContributionLimitUnits: null,
        fiveHourReservePercent: null,
        fiveHourUtilizationRatio: null,
        fiveHourResetsAt: null,
        fiveHourContributionCapExhausted: null,
        sevenDayReservePercent: null,
        sevenDayUtilizationRatio: null,
        sevenDayResetsAt: null,
        sevenDayContributionCapExhausted: null,
        providerUsageFetchedAt: null,
        claudeFiveHourCapExhaustionCyclesObserved: null,
        claudeFiveHourUsageUnitsBeforeCapExhaustionLastWindow: null,
        claudeFiveHourAvgUsageUnitsBeforeCapExhaustion: null,
        claudeSevenDayCapExhaustionCyclesObserved: null,
        claudeSevenDayUsageUnitsBeforeCapExhaustionLastWindow: null,
        claudeSevenDayAvgUsageUnitsBeforeCapExhaustion: null,
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

  it('rejects invalid request-log cursors', async () => {
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
        cursor: 'not-base64url-json'
      }
    });
    const res = createMockRes();

    await invokeHandlers(handlers, req, res);

    expect(res.statusCode).toBe(400);
    expect((res.body as any).code).toBe('invalid_request');
    expect(analytics.getRecentRequests).not.toHaveBeenCalled();
  });

  it('rejects invalid sessions cursors', async () => {
    const apiKeys = createApiKeysRepo();
    const analytics = createAnalyticsRepo();
    const router = createAnalyticsRouter({ apiKeys: apiKeys as any, analytics });
    const handlers = getRouteHandlers(router as any, '/v1/admin/analytics/sessions', 'get');
    const req = createMockReq({
      method: 'GET',
      path: '/v1/admin/analytics/sessions',
      headers: {
        authorization: 'Bearer admin_token'
      },
      query: {
        cursor: 'not-base64url-json'
      }
    });
    const res = createMockRes();

    await invokeHandlers(handlers, req, res);

    expect(res.statusCode).toBe(400);
    expect((res.body as any).code).toBe('invalid_request');
    expect(analytics.getSessions).not.toHaveBeenCalled();
  });
});
