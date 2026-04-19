process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/innies_test';
process.env.SELLER_SECRET_ENC_KEY_B64 = process.env.SELLER_SECRET_ENC_KEY_B64 || Buffer.alloc(32, 7).toString('base64');

import { beforeAll, describe, expect, it } from 'vitest';

type RouteModule = typeof import('../src/routes/adminMeLiveSessions.js');
type TypesModule = typeof import('../src/services/adminLive/myLiveSessionsTypes.js');
type MyLiveSessionsFeed = TypesModule extends { MyLiveSessionsFeed: infer T } ? T : any;

type ListFeedFn = (input: { apiKeyIds: string[]; windowHours?: number }) => any | Promise<any>;
type AnyHandler = (req: any, res: any, next: (error?: unknown) => void) => unknown;

let ADMIN_ME_LIVE_SESSIONS_PATH: string;
let buildAdminMeLiveSessionsRouter: RouteModule['buildAdminMeLiveSessionsRouter'];

beforeAll(async () => {
  const mod = await import('../src/routes/adminMeLiveSessions.js');
  ADMIN_ME_LIVE_SESSIONS_PATH = mod.ADMIN_ME_LIVE_SESSIONS_PATH;
  buildAdminMeLiveSessionsRouter = mod.buildAdminMeLiveSessionsRouter;
});

function extractGetHandlers(router: any, path: string): AnyHandler[] {
  const layer = router.stack.find((entry: any) => entry.route?.path === path);
  if (!layer) throw new Error(`route not found: ${path}`);
  return layer.route.stack.map((s: any) => s.handle);
}

function createMockRes() {
  const headers: Record<string, string> = {};
  const state: { statusCode: number; body: unknown } = { statusCode: 200, body: undefined };
  const res: any = {
    get statusCode() { return state.statusCode; },
    get body() { return state.body; },
    get headers() { return headers; },
    setHeader(name: string, value: string) { headers[name] = value; },
    status(code: number) { state.statusCode = code; return res; },
    json(payload: unknown) { state.body = payload; }
  };
  return res;
}

function createLiveSessionsFake(handler: ListFeedFn) {
  const calls: Array<{ apiKeyIds: string[]; windowHours?: number }> = [];
  const service = {
    async listFeed(input: { apiKeyIds: string[]; windowHours?: number }) {
      calls.push({ apiKeyIds: input.apiKeyIds, windowHours: input.windowHours });
      return handler(input);
    }
  };
  return { service, calls };
}

function emptyFeed(overrides: Partial<any> = {}): any {
  return {
    generatedAt: '2026-04-19T00:00:00.000Z',
    windowHours: 24,
    pollIntervalSeconds: 5,
    apiKeyIds: [],
    sessions: [],
    ...overrides
  };
}

function getHandler(service: { listFeed: ListFeedFn }): AnyHandler {
  const router = buildAdminMeLiveSessionsRouter({ liveSessions: service as any });
  const handlers = extractGetHandlers(router, ADMIN_ME_LIVE_SESSIONS_PATH);
  return handlers[handlers.length - 1];
}

describe('GET /v1/admin/me/live-sessions', () => {
  const validUuid1 = 'f3f97490-540f-4d13-ba1b-2ad1adff1ff1';
  const validUuid2 = '9f700001-1111-4111-8111-111111111111';

  it('returns the feed from the service on happy path', async () => {
    const feed = emptyFeed({
      apiKeyIds: [validUuid1],
      sessions: [
        {
          sessionKey: 'sess_hello',
          apiKeyId: validUuid1,
          startedAt: '2026-04-19T00:00:00.000Z',
          lastActivityAt: '2026-04-19T00:05:00.000Z',
          turnCount: 1,
          providerSet: ['openai'],
          modelSet: ['gpt-5.4'],
          turns: []
        }
      ]
    });
    const { service, calls } = createLiveSessionsFake(() => feed);
    const handler = getHandler(service);

    const req = { query: { api_key_ids: validUuid1 } };
    const res = createMockRes();
    await handler(req, res, (err) => { if (err) throw err; });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(feed);
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(calls).toEqual([{ apiKeyIds: [validUuid1], windowHours: undefined }]);
  });

  it('parses comma-separated api_key_ids and deduplicates', async () => {
    const { service, calls } = createLiveSessionsFake(() => emptyFeed());
    const handler = getHandler(service);

    const req = { query: { api_key_ids: `${validUuid1}, ${validUuid2}, ${validUuid1}` } };
    const res = createMockRes();
    await handler(req, res, () => {});

    expect(calls[0].apiKeyIds).toEqual([validUuid1, validUuid2]);
  });

  it('forwards window_hours to the service as a number', async () => {
    const { service, calls } = createLiveSessionsFake(() => emptyFeed());
    const handler = getHandler(service);

    const req = { query: { api_key_ids: validUuid1, window_hours: '6' } };
    const res = createMockRes();
    await handler(req, res, () => {});

    expect(calls[0].windowHours).toBe(6);
  });

  it('returns 400 when api_key_ids is missing', async () => {
    const { service } = createLiveSessionsFake(() => emptyFeed());
    const handler = getHandler(service);

    const req = { query: {} };
    const res = createMockRes();
    await handler(req, res, () => {});

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual(expect.objectContaining({ code: 'invalid_query' }));
  });

  it('returns 400 when api_key_ids contains a non-uuid entry', async () => {
    const { service } = createLiveSessionsFake(() => emptyFeed());
    const handler = getHandler(service);

    const req = { query: { api_key_ids: `${validUuid1},not-a-uuid` } };
    const res = createMockRes();
    await handler(req, res, () => {});

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual(
      expect.objectContaining({
        code: 'invalid_query',
        message: expect.stringContaining('not-a-uuid')
      })
    );
  });

  it('returns 400 when window_hours is not a number', async () => {
    const { service } = createLiveSessionsFake(() => emptyFeed());
    const handler = getHandler(service);

    const req = { query: { api_key_ids: validUuid1, window_hours: 'abc' } };
    const res = createMockRes();
    await handler(req, res, () => {});

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual(expect.objectContaining({ code: 'invalid_query' }));
  });
});
