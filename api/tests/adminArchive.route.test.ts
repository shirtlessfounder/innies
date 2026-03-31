import { beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AppError } from '../src/utils/errors.js';

type AdminArchiveRouteModule = typeof import('../src/routes/adminArchive.js');

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
      is_frozen: false,
      expires_at: null,
      preferred_provider: null,
      name: 'admin-key'
    }),
    touchLastUsed: vi.fn().mockResolvedValue(undefined)
  };
}

function encodeCursor(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

describe('admin archive routes', () => {
  let createAdminArchiveRouter: AdminArchiveRouteModule['createAdminArchiveRouter'];

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/innies_test';
    process.env.SELLER_SECRET_ENC_KEY_B64 = process.env.SELLER_SECRET_ENC_KEY_B64 || Buffer.alloc(32, 7).toString('base64');
    ({ createAdminArchiveRouter } = await import('../src/routes/adminArchive.js'));
  });

  it('lists archive sessions through the admin-only route contract', async () => {
    const apiKeys = createApiKeysRepo('admin');
    const adminArchive = {
      listSessions: vi.fn().mockResolvedValue({
        window: '7d',
        limit: 2,
        sessions: [{
          sessionKey: 'cli:idle:org:api:req_1',
          sessionType: 'cli',
          groupingBasis: 'idle_gap',
          sourceSessionId: null,
          sourceRunId: null,
          orgId: 'org_1',
          startedAt: '2026-03-31T22:00:00.000Z',
          endedAt: '2026-03-31T22:05:00.000Z',
          durationMs: 300000,
          requestCount: 2,
          attemptCount: 2,
          inputTokens: 10,
          outputTokens: 20,
          providerSet: ['anthropic'],
          modelSet: ['claude-opus-4-1'],
          statusSummary: { success: 2 },
          previewSample: { promptPreview: 'hello', responsePreview: 'world' }
        }],
        nextCursor: encodeCursor({
          lastActivityAt: '2026-03-31T22:05:00.000Z',
          sessionKey: 'cli:idle:org:api:req_1'
        })
      }),
      getSession: vi.fn(),
      listSessionEvents: vi.fn(),
      getAttempt: vi.fn()
    };
    const router = createAdminArchiveRouter({ apiKeys, adminArchive });
    const handlers = getRouteHandlers(router, '/v1/admin/archive/sessions', 'get');
    const req = createMockReq({
      method: 'GET',
      path: '/v1/admin/archive/sessions',
      headers: { 'x-api-key': 'sk-admin' },
      query: { limit: '2', sessionType: 'cli', window: '7d' }
    });
    const res = createMockRes();

    await invokeHandlers(handlers, req, res);

    expect(res.statusCode).toBe(200);
    expect(adminArchive.listSessions).toHaveBeenCalledWith({
      window: '7d',
      sessionType: 'cli',
      orgId: undefined,
      provider: undefined,
      model: undefined,
      status: undefined,
      limit: 2,
      cursor: undefined
    });
    expect(res.body).toEqual(expect.objectContaining({
      window: '7d',
      limit: 2,
      sessions: [expect.objectContaining({ sessionKey: 'cli:idle:org:api:req_1' })]
    }));
  });

  it('rejects non-admin keys for archive routes', async () => {
    const router = createAdminArchiveRouter({
      apiKeys: createApiKeysRepo('buyer_proxy'),
      adminArchive: {
        listSessions: vi.fn(),
        getSession: vi.fn(),
        listSessionEvents: vi.fn(),
        getAttempt: vi.fn()
      }
    });
    const handlers = getRouteHandlers(router, '/v1/admin/archive/sessions', 'get');
    const req = createMockReq({
      method: 'GET',
      path: '/v1/admin/archive/sessions',
      headers: { 'x-api-key': 'sk-buyer' }
    });
    const res = createMockRes();

    await invokeHandlers(handlers, req, res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ code: 'forbidden', message: 'Invalid API key scope' });
  });

  it('returns 404 for an unknown session detail lookup', async () => {
    const router = createAdminArchiveRouter({
      apiKeys: createApiKeysRepo('admin'),
      adminArchive: {
        listSessions: vi.fn(),
        getSession: vi.fn().mockResolvedValue(null),
        listSessionEvents: vi.fn(),
        getAttempt: vi.fn()
      }
    });
    const handlers = getRouteHandlers(router, '/v1/admin/archive/sessions/:sessionKey', 'get');
    const req = createMockReq({
      method: 'GET',
      path: '/v1/admin/archive/sessions/openclaw%3Arun%3Arun_1',
      headers: { 'x-api-key': 'sk-admin' },
      params: { sessionKey: 'openclaw:run:run_1' }
    });
    const res = createMockRes();

    await invokeHandlers(handlers, req, res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ code: 'not_found', message: 'Archive session not found', details: undefined });
  });

  it('validates stable list and event cursors', async () => {
    const router = createAdminArchiveRouter({
      apiKeys: createApiKeysRepo('admin'),
      adminArchive: {
        listSessions: vi.fn(),
        getSession: vi.fn(),
        listSessionEvents: vi.fn(),
        getAttempt: vi.fn()
      }
    });
    const listHandlers = getRouteHandlers(router, '/v1/admin/archive/sessions', 'get');
    const eventsHandlers = getRouteHandlers(router, '/v1/admin/archive/sessions/:sessionKey/events', 'get');

    const listReq = createMockReq({
      method: 'GET',
      path: '/v1/admin/archive/sessions',
      headers: { 'x-api-key': 'sk-admin' },
      query: { cursor: 'bad-cursor' }
    });
    const listRes = createMockRes();
    await invokeHandlers(listHandlers, listReq, listRes);

    const eventsReq = createMockReq({
      method: 'GET',
      path: '/v1/admin/archive/sessions/openclaw%3Arun%3Arun_1/events',
      headers: { 'x-api-key': 'sk-admin' },
      params: { sessionKey: 'openclaw:run:run_1' },
      query: { cursor: 'bad-cursor' }
    });
    const eventsRes = createMockRes();
    await invokeHandlers(eventsHandlers, eventsReq, eventsRes);

    expect(listRes.statusCode).toBe(400);
    expect(eventsRes.statusCode).toBe(400);
  });

  it('serves session events and exact attempt drilldown payloads', async () => {
    const router = createAdminArchiveRouter({
      apiKeys: createApiKeysRepo('admin'),
      adminArchive: {
        listSessions: vi.fn(),
        getSession: vi.fn(),
        listSessionEvents: vi.fn().mockResolvedValue({
          sessionKey: 'openclaw:run:run_1',
          events: [{
            eventType: 'attempt_status',
            eventTime: '2026-03-31T22:00:05.000Z',
            requestId: 'req_1',
            attemptNo: 1,
            ordinal: -1,
            side: null,
            role: null,
            contentType: null,
            content: null,
            provider: 'openai',
            model: 'gpt-5.4',
            streaming: true,
            status: 'success',
            upstreamStatus: 200
          }],
          nextCursor: null
        }),
        getAttempt: vi.fn().mockResolvedValue({
          attempt: {
            requestId: 'req_1',
            attemptNo: 1,
            status: 'success'
          },
          request: [],
          response: [],
          raw: []
        })
      }
    });
    const eventsHandlers = getRouteHandlers(router, '/v1/admin/archive/sessions/:sessionKey/events', 'get');
    const attemptHandlers = getRouteHandlers(router, '/v1/admin/archive/requests/:requestId/attempts/:attemptNo', 'get');

    const eventsReq = createMockReq({
      method: 'GET',
      path: '/v1/admin/archive/sessions/openclaw%3Arun%3Arun_1/events',
      headers: { 'x-api-key': 'sk-admin' },
      params: { sessionKey: 'openclaw:run:run_1' },
      query: {
        limit: '1',
        cursor: encodeCursor({
          eventTime: '2026-03-31T22:00:00.000Z',
          requestId: 'req_0',
          attemptNo: 1,
          sortOrdinal: -1
        })
      }
    });
    const eventsRes = createMockRes();
    await invokeHandlers(eventsHandlers, eventsReq, eventsRes);

    const attemptReq = createMockReq({
      method: 'GET',
      path: '/v1/admin/archive/requests/req_1/attempts/1',
      headers: { 'x-api-key': 'sk-admin' },
      params: { requestId: 'req_1', attemptNo: '1' }
    });
    const attemptRes = createMockRes();
    await invokeHandlers(attemptHandlers, attemptReq, attemptRes);

    expect(eventsRes.statusCode).toBe(200);
    expect(eventsRes.body).toEqual(expect.objectContaining({
      sessionKey: 'openclaw:run:run_1',
      events: [expect.objectContaining({ eventType: 'attempt_status' })]
    }));
    expect(attemptRes.statusCode).toBe(200);
    expect(attemptRes.body).toEqual(expect.objectContaining({
      attempt: expect.objectContaining({ requestId: 'req_1', attemptNo: 1, status: 'success' })
    }));
  });
});
