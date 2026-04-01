import { beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AppError } from '../src/utils/errors.js';

type AdminAnalysisRouteModule = typeof import('../src/routes/adminAnalysis.js');
type ServerModule = typeof import('../src/server.js');

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

function collectRoutePaths(stack: any, routes = new Set<string>()): Set<string> {
  for (const layer of stack ?? []) {
    if (layer?.route?.path) {
      routes.add(layer.route.path);
    }
    if (layer?.handle?.stack) {
      collectRoutePaths(layer.handle.stack, routes);
    }
  }
  return routes;
}

function createApiKeysRepo(scope: 'admin' | 'buyer_proxy' = 'admin') {
  return {
    findActiveByHash: vi.fn().mockResolvedValue({
      id: '99999999-9999-4999-8999-999999999999',
      org_id: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      scope,
      is_active: true,
      is_frozen: false,
      expires_at: null,
      preferred_provider: null,
      name: 'admin-key'
    }),
    touchLastUsed: vi.fn().mockResolvedValue(undefined)
  };
}

function createAdminAnalysisRead() {
  return {
    getOverview: vi.fn().mockResolvedValue({
      window: '7d',
      requestedWindow: {
        start: '2026-03-24T12:00:00.000Z',
        end: '2026-03-31T12:00:00.000Z'
      },
      coverage: {
        requestedWindow: {
          start: '2026-03-24T12:00:00.000Z',
          end: '2026-03-31T12:00:00.000Z'
        },
        projectedCoverage: {
          start: '2026-03-24T00:00:00.000Z',
          end: '2026-03-31T00:00:00.000Z'
        },
        projectedRequestCount: 12,
        pendingProjectionCount: 0,
        isComplete: true
      },
      totals: {
        totalRequests: 12,
        totalSessions: 5,
        totalTokens: 3400
      },
      categoryMix: [{ taskCategory: 'debugging', count: 7 }],
      tagHighlights: [{ tag: 'postgres', count: 4 }],
      signalCounts: { retryCount: 2, failureCount: 1 }
    }),
    getCategoryTrends: vi.fn().mockResolvedValue({
      window: '7d',
      requestedWindow: {
        start: '2026-03-24T12:00:00.000Z',
        end: '2026-03-31T12:00:00.000Z'
      },
      days: [{ day: '2026-03-31', taskCategory: 'debugging', count: 3 }]
    }),
    getTagTrends: vi.fn().mockResolvedValue({
      window: '7d',
      requestedWindow: {
        start: '2026-03-24T12:00:00.000Z',
        end: '2026-03-31T12:00:00.000Z'
      },
      topTags: [{ tag: 'postgres', count: 4 }],
      cooccurringTags: [{ tag: 'postgres', coTag: 'migration', count: 2 }]
    }),
    getInterestingSignals: vi.fn().mockResolvedValue({
      window: '7d',
      requestedWindow: {
        start: '2026-03-24T12:00:00.000Z',
        end: '2026-03-31T12:00:00.000Z'
      },
      signals: {
        retryCount: 2,
        failureCount: 1,
        partialCount: 1,
        highTokenCount: 3,
        crossProviderRescueCount: 1,
        toolUseCount: 4,
        longSessionCount: 1,
        highTokenSessionCount: 1,
        retryHeavySessionCount: 1,
        crossProviderSessionCount: 1,
        multiModelSessionCount: 1
      }
    }),
    getRequestSamples: vi.fn().mockResolvedValue({
      window: '24h',
      requestedWindow: {
        start: '2026-03-30T12:00:00.000Z',
        end: '2026-03-31T12:00:00.000Z'
      },
      coverage: {
        requestedWindow: {
          start: '2026-03-30T12:00:00.000Z',
          end: '2026-03-31T12:00:00.000Z'
        },
        projectedCoverage: {
          start: '2026-03-30T12:00:00.000Z',
          end: '2026-03-31T11:55:00.000Z'
        },
        projectedRequestCount: 42,
        pendingProjectionCount: 3,
        isComplete: false
      },
      samples: [{
        request_attempt_archive_id: 'archive_1',
        request_id: 'req_1',
        attempt_no: 2,
        session_key: 'openclaw:run:run_1',
        org_id: '11111111-1111-4111-8111-111111111111',
        api_key_id: '22222222-2222-4222-8222-222222222222',
        session_type: 'openclaw',
        grouping_basis: 'explicit_run_id',
        source: 'openclaw',
        provider: 'openai',
        model: 'gpt-5.2',
        status: 'partial',
        started_at: '2026-03-31T11:00:00.000Z',
        completed_at: '2026-03-31T11:05:00.000Z',
        input_tokens: 1200,
        output_tokens: 400,
        user_message_preview: 'fix the migration mismatch',
        assistant_text_preview: 'I found the missing index',
        task_category: 'debugging',
        task_tags: ['postgres', 'migration'],
        is_retry: true,
        is_failure: false,
        is_partial: true,
        is_high_token: false,
        is_cross_provider_rescue: true,
        has_tool_use: true,
        interestingness_score: 87
      }]
    }),
    getSessionSamples: vi.fn().mockResolvedValue({
      window: '24h',
      requestedWindow: {
        start: '2026-03-30T12:00:00.000Z',
        end: '2026-03-31T12:00:00.000Z'
      },
      coverage: {
        requestedWindow: {
          start: '2026-03-30T12:00:00.000Z',
          end: '2026-03-31T12:00:00.000Z'
        },
        projectedCoverage: {
          start: '2026-03-30T12:00:00.000Z',
          end: '2026-03-31T11:55:00.000Z'
        },
        projectedRequestCount: 42,
        pendingProjectionCount: 3,
        isComplete: false
      },
      samples: [{
        session_key: 'openclaw:run:run_1',
        org_id: '11111111-1111-4111-8111-111111111111',
        session_type: 'openclaw',
        grouping_basis: 'explicit_run_id',
        started_at: '2026-03-31T10:00:00.000Z',
        ended_at: '2026-03-31T11:05:00.000Z',
        last_activity_at: '2026-03-31T11:05:00.000Z',
        request_count: 4,
        attempt_count: 5,
        input_tokens: 4000,
        output_tokens: 1200,
        primary_task_category: 'debugging',
        task_category_breakdown: { debugging: 3, feature_building: 1 },
        task_tag_set: ['postgres', 'migration'],
        is_long_session: true,
        is_high_token_session: false,
        is_retry_heavy_session: true,
        is_cross_provider_session: true,
        is_multi_model_session: true,
        interestingness_score: 90
      }]
    }),
    getRequestDetail: vi.fn().mockResolvedValue({
      requestId: 'req_1',
      attemptNo: 2,
      sessionKey: 'openclaw:run:run_1',
      row: {
        request_attempt_archive_id: 'archive_1',
        request_id: 'req_1',
        attempt_no: 2,
        session_key: 'openclaw:run:run_1',
        org_id: '11111111-1111-4111-8111-111111111111',
        api_key_id: '22222222-2222-4222-8222-222222222222',
        session_type: 'openclaw',
        grouping_basis: 'explicit_run_id',
        source: 'openclaw',
        provider: 'openai',
        model: 'gpt-5.2',
        status: 'partial',
        started_at: '2026-03-31T11:00:00.000Z',
        completed_at: '2026-03-31T11:05:00.000Z',
        input_tokens: 1200,
        output_tokens: 400,
        user_message_preview: 'fix the migration mismatch',
        assistant_text_preview: 'I found the missing index',
        task_category: 'debugging',
        task_tags: ['postgres', 'migration'],
        is_retry: true,
        is_failure: false,
        is_partial: true,
        is_high_token: false,
        is_cross_provider_rescue: true,
        has_tool_use: true,
        interestingness_score: 87
      }
    }),
    getSessionDetail: vi.fn().mockResolvedValue({
      sessionKey: 'openclaw:run:run_1',
      row: {
        session_key: 'openclaw:run:run_1',
        org_id: '11111111-1111-4111-8111-111111111111',
        session_type: 'openclaw',
        grouping_basis: 'explicit_run_id',
        started_at: '2026-03-31T10:00:00.000Z',
        ended_at: '2026-03-31T11:05:00.000Z',
        last_activity_at: '2026-03-31T11:05:00.000Z',
        request_count: 4,
        attempt_count: 5,
        input_tokens: 4000,
        output_tokens: 1200,
        primary_task_category: 'debugging',
        task_category_breakdown: { debugging: 3, feature_building: 1 },
        task_tag_set: ['postgres', 'migration'],
        is_long_session: true,
        is_high_token_session: false,
        is_retry_heavy_session: true,
        is_cross_provider_session: true,
        is_multi_model_session: true,
        interestingness_score: 90
      }
    })
  };
}

describe('admin analysis routes', () => {
  let createAdminAnalysisRouter: AdminAnalysisRouteModule['createAdminAnalysisRouter'];
  let createApp: ServerModule['createApp'];

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/innies_test';
    process.env.SELLER_SECRET_ENC_KEY_B64 = process.env.SELLER_SECRET_ENC_KEY_B64 || Buffer.alloc(32, 7).toString('base64');
    ({ createAdminAnalysisRouter } = await import('../src/routes/adminAnalysis.js'));
    ({ createApp } = await import('../src/server.js'));
  });

  it('exposes all eight approved admin analysis endpoints and registers them on the app', () => {
    const router = createAdminAnalysisRouter({
      apiKeys: createApiKeysRepo('admin'),
      adminAnalysis: createAdminAnalysisRead()
    });

    expect(getRouteHandlers(router, '/v1/admin/analysis/overview', 'get')).toHaveLength(2);
    expect(getRouteHandlers(router, '/v1/admin/analysis/categories', 'get')).toHaveLength(2);
    expect(getRouteHandlers(router, '/v1/admin/analysis/tags', 'get')).toHaveLength(2);
    expect(getRouteHandlers(router, '/v1/admin/analysis/interesting-signals', 'get')).toHaveLength(2);
    expect(getRouteHandlers(router, '/v1/admin/analysis/samples/requests', 'get')).toHaveLength(2);
    expect(getRouteHandlers(router, '/v1/admin/analysis/samples/sessions', 'get')).toHaveLength(2);
    expect(getRouteHandlers(router, '/v1/admin/analysis/requests/:requestId/attempts/:attemptNo', 'get')).toHaveLength(2);
    expect(getRouteHandlers(router, '/v1/admin/analysis/sessions/:sessionKey', 'get')).toHaveLength(2);

    const app = createApp();
    const paths = collectRoutePaths((app as any)._router?.stack);

    expect(paths.has('/v1/admin/analysis/overview')).toBe(true);
    expect(paths.has('/v1/admin/analysis/categories')).toBe(true);
    expect(paths.has('/v1/admin/analysis/tags')).toBe(true);
    expect(paths.has('/v1/admin/analysis/interesting-signals')).toBe(true);
    expect(paths.has('/v1/admin/analysis/samples/requests')).toBe(true);
    expect(paths.has('/v1/admin/analysis/samples/sessions')).toBe(true);
    expect(paths.has('/v1/admin/analysis/requests/:requestId/attempts/:attemptNo')).toBe(true);
    expect(paths.has('/v1/admin/analysis/sessions/:sessionKey')).toBe(true);
  });

  it('enforces admin auth and forwards normalized overview filters to the read service', async () => {
    const apiKeys = createApiKeysRepo('admin');
    const adminAnalysis = createAdminAnalysisRead();
    const router = createAdminAnalysisRouter({ apiKeys, adminAnalysis });
    const handlers = getRouteHandlers(router, '/v1/admin/analysis/overview', 'get');
    const req = createMockReq({
      method: 'GET',
      path: '/v1/admin/analysis/overview',
      headers: { 'x-api-key': 'sk-admin' },
      query: {
        window: '7d',
        compare: 'prev',
        orgId: '11111111-1111-4111-8111-111111111111',
        sessionType: 'openclaw',
        provider: 'openai',
        source: 'openclaw',
        taskCategory: 'debugging',
        taskTag: 'postgres'
      }
    });
    const res = createMockRes();

    await invokeHandlers(handlers, req, res);

    expect(res.statusCode).toBe(200);
    expect(adminAnalysis.getOverview).toHaveBeenCalledWith({
      window: '7d',
      compare: 'prev',
      orgId: '11111111-1111-4111-8111-111111111111',
      sessionType: 'openclaw',
      provider: 'openai',
      source: 'openclaw',
      taskCategory: 'debugging',
      taskTag: 'postgres'
    });
    expect(res.body).toEqual(expect.objectContaining({
      window: '7d',
      totals: expect.objectContaining({ totalRequests: 12 }),
      coverage: expect.objectContaining({ isComplete: true })
    }));
  });

  it('rejects non-admin API keys for analysis routes', async () => {
    const router = createAdminAnalysisRouter({
      apiKeys: createApiKeysRepo('buyer_proxy'),
      adminAnalysis: createAdminAnalysisRead()
    });
    const handlers = getRouteHandlers(router, '/v1/admin/analysis/overview', 'get');
    const req = createMockReq({
      method: 'GET',
      path: '/v1/admin/analysis/overview',
      headers: { 'x-api-key': 'sk-buyer' }
    });
    const res = createMockRes();

    await invokeHandlers(handlers, req, res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ code: 'forbidden', message: 'Invalid API key scope' });
  });

  it('rejects invalid filters and compare=prev for window=all', async () => {
    const router = createAdminAnalysisRouter({
      apiKeys: createApiKeysRepo('admin'),
      adminAnalysis: {
        ...createAdminAnalysisRead(),
        getCategoryTrends: vi.fn().mockRejectedValue(new AppError('invalid_request', 400, 'compare=prev is not supported for window=all'))
      }
    });

    const invalidHandlers = getRouteHandlers(router, '/v1/admin/analysis/samples/requests', 'get');
    const invalidReq = createMockReq({
      method: 'GET',
      path: '/v1/admin/analysis/samples/requests',
      headers: { 'x-api-key': 'sk-admin' },
      query: { taskCategory: 'not-a-category', sampleSize: '0' }
    });
    const invalidRes = createMockRes();

    await invokeHandlers(invalidHandlers, invalidReq, invalidRes);

    expect(invalidRes.statusCode).toBe(400);
    expect(invalidRes.body).toEqual(expect.objectContaining({
      code: 'invalid_request',
      message: 'Invalid request'
    }));

    const compareHandlers = getRouteHandlers(router, '/v1/admin/analysis/categories', 'get');
    const compareReq = createMockReq({
      method: 'GET',
      path: '/v1/admin/analysis/categories',
      headers: { 'x-api-key': 'sk-admin' },
      query: { window: 'all', compare: 'prev' }
    });
    const compareRes = createMockRes();

    await invokeHandlers(compareHandlers, compareReq, compareRes);

    expect(compareRes.statusCode).toBe(400);
    expect(compareRes.body).toEqual({
      code: 'invalid_request',
      message: 'compare=prev is not supported for window=all',
      details: undefined
    });
  });

  it('normalizes request sample rows to camelCase fields and archive references', async () => {
    const adminAnalysis = createAdminAnalysisRead();
    const router = createAdminAnalysisRouter({
      apiKeys: createApiKeysRepo('admin'),
      adminAnalysis
    });
    const handlers = getRouteHandlers(router, '/v1/admin/analysis/samples/requests', 'get');
    const req = createMockReq({
      method: 'GET',
      path: '/v1/admin/analysis/samples/requests',
      headers: { 'x-api-key': 'sk-admin' },
      query: { window: '24h', sampleSize: '10' }
    });
    const res = createMockRes();

    await invokeHandlers(handlers, req, res);

    expect(adminAnalysis.getRequestSamples).toHaveBeenCalledWith({
      window: '24h',
      orgId: undefined,
      sessionType: undefined,
      provider: undefined,
      source: undefined,
      taskCategory: undefined,
      taskTag: undefined,
      sampleSize: 10
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      window: '24h',
      coverage: expect.objectContaining({
        projectedRequestCount: 42,
        pendingProjectionCount: 3,
        isComplete: false
      }),
      samples: [expect.objectContaining({
        requestAttemptArchiveId: 'archive_1',
        requestId: 'req_1',
        attemptNo: 2,
        sessionKey: 'openclaw:run:run_1',
        userMessagePreview: 'fix the migration mismatch',
        assistantTextPreview: 'I found the missing index',
        taskCategory: 'debugging',
        taskTags: ['postgres', 'migration'],
        signals: expect.objectContaining({
          isRetry: true,
          isPartial: true,
          isCrossProviderRescue: true,
          hasToolUse: true
        }),
        archiveRefs: {
          requestAttempt: '/v1/admin/archive/requests/req_1/attempts/2',
          session: '/v1/admin/archive/sessions/openclaw%3Arun%3Arun_1'
        }
      })]
    }));
    expect(JSON.stringify(res.body)).not.toContain('request_attempt_archive_id');
  });

  it('normalizes session detail rows to camelCase fields and archive references', async () => {
    const router = createAdminAnalysisRouter({
      apiKeys: createApiKeysRepo('admin'),
      adminAnalysis: createAdminAnalysisRead()
    });
    const handlers = getRouteHandlers(router, '/v1/admin/analysis/sessions/:sessionKey', 'get');
    const req = createMockReq({
      method: 'GET',
      path: '/v1/admin/analysis/sessions/openclaw%3Arun%3Arun_1',
      headers: { 'x-api-key': 'sk-admin' },
      params: { sessionKey: 'openclaw:run:run_1' }
    });
    const res = createMockRes();

    await invokeHandlers(handlers, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      sessionKey: 'openclaw:run:run_1',
      sessionType: 'openclaw',
      primaryTaskCategory: 'debugging',
      taskTagSet: ['postgres', 'migration'],
      signals: expect.objectContaining({
        isLongSession: true,
        isRetryHeavySession: true,
        isCrossProviderSession: true,
        isMultiModelSession: true
      }),
      archiveRefs: {
        session: '/v1/admin/archive/sessions/openclaw%3Arun%3Arun_1',
        sessionEvents: '/v1/admin/archive/sessions/openclaw%3Arun%3Arun_1/events'
      }
    }));
    expect(JSON.stringify(res.body)).not.toContain('task_category_breakdown');
  });

  it('returns 404 for unknown request detail rows', async () => {
    const router = createAdminAnalysisRouter({
      apiKeys: createApiKeysRepo('admin'),
      adminAnalysis: {
        ...createAdminAnalysisRead(),
        getRequestDetail: vi.fn().mockResolvedValue(null)
      }
    });
    const handlers = getRouteHandlers(router, '/v1/admin/analysis/requests/:requestId/attempts/:attemptNo', 'get');
    const req = createMockReq({
      method: 'GET',
      path: '/v1/admin/analysis/requests/req_404/attempts/1',
      headers: { 'x-api-key': 'sk-admin' },
      params: { requestId: 'req_404', attemptNo: '1' }
    });
    const res = createMockRes();

    await invokeHandlers(handlers, req, res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({
      code: 'not_found',
      message: 'Analysis request attempt not found',
      details: undefined
    });
  });
});
