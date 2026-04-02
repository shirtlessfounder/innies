import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/innies_test';
process.env.SELLER_SECRET_ENC_KEY_B64 = process.env.SELLER_SECRET_ENC_KEY_B64 || Buffer.alloc(32, 7).toString('base64');

type MockReq = {
  method: string;
  path: string;
  originalUrl: string;
  params: Record<string, string>;
  query: Record<string, unknown>;
  header: (name: string) => string | undefined;
};

type MockRes = {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  headersSent: boolean;
  writableEnded: boolean;
  setHeader: (name: string, value: string) => void;
  getHeader: (name: string) => string | undefined;
  status: (code: number) => MockRes;
  json: (payload: unknown) => void;
  send: (payload?: unknown) => void;
};

function createMockReq(input: {
  method: string;
  path: string;
  headers?: Record<string, string>;
}): MockReq {
  const lower = Object.fromEntries(
    Object.entries(input.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])
  );

  return {
    method: input.method.toUpperCase(),
    path: input.path,
    originalUrl: input.path,
    params: {},
    query: {},
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
    getHeader(name: string) {
      return this.headers[name.toLowerCase()];
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
    send(payload?: unknown) {
      this.body = payload;
      this.headersSent = true;
      this.writableEnded = true;
    }
  };
}

async function invoke(
  handle: (req: any, res: any, next: (error?: unknown) => void) => unknown,
  req: MockReq,
  res: MockRes
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let nextCalled = false;
    const next = (error?: unknown) => {
      nextCalled = true;
      if (error) {
        reject(error);
        return;
      }
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

function getRouteHandlers(router: any, routePath: string, method: 'get' | 'options') {
  const layer = router.stack.find((entry: any) => entry?.route?.path === routePath && entry?.route?.methods?.[method]);
  if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${routePath}`);
  return layer.route.stack.map((stackEntry: any) => stackEntry.handle);
}

async function loadRouteModule() {
  return import('../src/routes/publicInnies.js');
}

async function loadRuntimeModule() {
  return import('../src/services/runtime.js');
}

describe('public innies routes', () => {
  const originalPublicOrigins = process.env.INNIES_PUBLIC_WEB_ORIGINS;

  beforeEach(() => {
    if (originalPublicOrigins == null) {
      delete process.env.INNIES_PUBLIC_WEB_ORIGINS;
      return;
    }
    process.env.INNIES_PUBLIC_WEB_ORIGINS = originalPublicOrigins;
  });

  it('serves the live sessions feed without api key auth and applies fallback cors + cache headers', async () => {
    const { createPublicInniesRouter } = await loadRouteModule();
    const liveSessions = {
      listFeed: vi.fn().mockResolvedValue({
        orgSlug: 'innies',
        generatedAt: '2026-04-02T18:00:00.000Z',
        sessions: []
      })
    };
    const router = createPublicInniesRouter({
      liveSessions,
      env: {}
    });
    const handlers = getRouteHandlers(router, '/v1/public/innies/live-sessions', 'get');
    const req = createMockReq({
      method: 'GET',
      path: '/v1/public/innies/live-sessions',
      headers: { origin: 'http://localhost:3000' }
    });
    const res = createMockRes();

    await invokeHandlers(handlers, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      orgSlug: 'innies',
      generatedAt: '2026-04-02T18:00:00.000Z',
      sessions: []
    });
    expect(liveSessions.listFeed).toHaveBeenCalledTimes(1);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(res.headers['access-control-allow-methods']).toBe('GET, OPTIONS');
    expect(res.headers['access-control-allow-headers']).toBe('Content-Type');
    expect(res.headers.vary).toBe('Origin');
    expect(res.headers['cache-control']).toBe('public, max-age=5, stale-while-revalidate=25');
  });

  it('answers preflight requests for explicitly configured public web origins', async () => {
    const { createPublicInniesRouter } = await loadRouteModule();
    const liveSessions = {
      listFeed: vi.fn()
    };
    const router = createPublicInniesRouter({
      liveSessions,
      env: {
        INNIES_PUBLIC_WEB_ORIGINS: 'https://public.innies.work, https://preview.innies.work'
      } as NodeJS.ProcessEnv
    });
    const handlers = getRouteHandlers(router, '/v1/public/innies/live-sessions', 'options');
    const req = createMockReq({
      method: 'OPTIONS',
      path: '/v1/public/innies/live-sessions',
      headers: { origin: 'https://preview.innies.work' }
    });
    const res = createMockRes();

    await invokeHandlers(handlers, req, res);

    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://preview.innies.work');
    expect(res.headers['access-control-allow-methods']).toBe('GET, OPTIONS');
    expect(res.headers['access-control-allow-headers']).toBe('Content-Type');
    expect(res.headers.vary).toBe('Origin');
    expect(liveSessions.listFeed).not.toHaveBeenCalled();
  });

  it('uses explicit public origins instead of the fallback allowlist when configured', async () => {
    const { createPublicInniesRouter } = await loadRouteModule();
    const liveSessions = {
      listFeed: vi.fn().mockResolvedValue({
        orgSlug: 'innies',
        generatedAt: '2026-04-02T18:00:00.000Z',
        sessions: []
      })
    };
    const router = createPublicInniesRouter({
      liveSessions,
      env: {
        INNIES_PUBLIC_WEB_ORIGINS: 'https://public.innies.work'
      } as NodeJS.ProcessEnv
    });
    const handlers = getRouteHandlers(router, '/v1/public/innies/live-sessions', 'get');
    const req = createMockReq({
      method: 'GET',
      path: '/v1/public/innies/live-sessions',
      headers: { origin: 'http://localhost:3000' }
    });
    const res = createMockRes();

    await invokeHandlers(handlers, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-methods']).toBe('GET, OPTIONS');
    expect(res.headers['access-control-allow-headers']).toBe('Content-Type');
    expect(res.headers.vary).toBe('Origin');
  });

  it('constructs the default public live sessions service from runtime sql, org access, and api keys', async () => {
    const [{ createPublicInniesRouter }, { runtime }] = await Promise.all([
      loadRouteModule(),
      loadRuntimeModule()
    ]);
    const liveSessions = {
      listFeed: vi.fn().mockResolvedValue({
        orgSlug: 'innies',
        generatedAt: '2026-04-02T18:00:00.000Z',
        sessions: []
      })
    };
    const serviceFactory = vi.fn().mockReturnValue(liveSessions);

    createPublicInniesRouter({ serviceFactory });

    expect(serviceFactory).toHaveBeenCalledTimes(1);
    expect(serviceFactory).toHaveBeenCalledWith({
      sql: runtime.sql,
      orgAccess: runtime.repos.orgAccess,
      apiKeys: runtime.repos.apiKeys
    });
  });
});
