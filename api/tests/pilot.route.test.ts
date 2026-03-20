import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AppError } from '../src/utils/errors.js';

type RuntimeModule = typeof import('../src/services/runtime.js');
type PilotRouteModule = typeof import('../src/routes/pilot.js');

type MockReq = {
  method: string;
  path: string;
  originalUrl: string;
  body: unknown;
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  auth?: unknown;
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
  body?: unknown;
  query?: Record<string, string | undefined>;
  headers?: Record<string, string>;
  params?: Record<string, string>;
}): MockReq {
  const lower = Object.fromEntries(
    Object.entries(input.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])
  );
  return {
    method: input.method.toUpperCase(),
    path: input.path,
    originalUrl: input.path,
    body: input.body ?? {},
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
      if (error) {
        applyError(error, res);
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

function getRouteHandlers(router: any, routePath: string, method: 'get' | 'post'): Array<(req: any, res: any, next: (error?: unknown) => void) => unknown> {
  const layer = router.stack.find((entry: any) => entry?.route?.path === routePath && entry?.route?.methods?.[method]);
  if (!layer) throw new Error(`route not found: ${routePath}`);
  return layer.route.stack.map((s: any) => s.handle);
}

describe('pilot session routes', () => {
  let runtimeModule: RuntimeModule;
  let callbackHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;
  let sessionHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;
  let impersonateHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;
  let clearHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/innies_test';
    process.env.SELLER_SECRET_ENC_KEY_B64 = process.env.SELLER_SECRET_ENC_KEY_B64 || Buffer.alloc(32, 7).toString('base64');
    runtimeModule = await import('../src/services/runtime.js');
    const mod = await import('../src/routes/pilot.js') as PilotRouteModule;
    callbackHandlers = getRouteHandlers(mod.default as any, '/v1/pilot/auth/github/callback', 'get');
    sessionHandlers = getRouteHandlers(mod.default as any, '/v1/pilot/session', 'get');
    impersonateHandlers = getRouteHandlers(mod.default as any, '/v1/pilot/session/impersonate', 'post');
    clearHandlers = getRouteHandlers(mod.default as any, '/v1/pilot/session/impersonation/clear', 'post');
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates a Darryn session from the GitHub callback and sets a cookie', async () => {
    vi.spyOn(runtimeModule.runtime.services.pilotSessions, 'createSessionFromGithubCallback').mockResolvedValue({
      token: 'signed.token',
      session: {
        contextKind: 'darryn_self',
        actor: { userId: 'user_darryn', githubLogin: 'darryn', role: 'buyer' },
        active: { userId: 'user_darryn', githubLogin: 'darryn', orgId: 'org_fnf' }
      }
    } as any);

    const req = createMockReq({
      method: 'GET',
      path: '/v1/pilot/auth/github/callback',
      query: {
        code: 'oauth_code',
        mode: 'darryn'
      }
    });
    const res = createMockRes();

    await invoke(callbackHandlers[0], req, res);

    expect(res.statusCode).toBe(200);
    expect((res.body as any).ok).toBe(true);
    expect((res.body as any).session.contextKind).toBe('darryn_self');
    expect(res.headers['set-cookie']).toContain('innies_pilot_session=signed.token');
  });

  it('reads the current pilot session from a bearer token', async () => {
    vi.spyOn(runtimeModule.runtime.services.pilotSessions, 'readFromRequest').mockReturnValue({
      contextKind: 'admin_self',
      actor: { userId: 'user_admin', githubLogin: 'adminuser', role: 'admin' },
      active: { userId: 'user_admin', githubLogin: 'adminuser', orgId: 'org_innies' }
    } as any);

    const req = createMockReq({
      method: 'GET',
      path: '/v1/pilot/session',
      headers: {
        authorization: 'Bearer signed.token'
      }
    });
    const res = createMockRes();

    await invoke(sessionHandlers[0], req, res);

    expect(res.statusCode).toBe(200);
    expect((res.body as any).session.contextKind).toBe('admin_self');
  });

  it('creates an impersonated Darryn session from an admin session', async () => {
    vi.spyOn(runtimeModule.runtime.services.pilotSessions, 'impersonateFromRequest').mockResolvedValue({
      token: 'impersonated.token',
      session: {
        contextKind: 'admin_impersonation',
        actor: { userId: 'user_admin', githubLogin: 'adminuser', role: 'admin' },
        active: { userId: 'user_darryn', githubLogin: 'darryn', orgId: 'org_fnf' }
      }
    } as any);

    const req = createMockReq({
      method: 'POST',
      path: '/v1/pilot/session/impersonate',
      headers: {
        authorization: 'Bearer signed.token'
      },
      body: {
        githubLogin: 'darryn'
      }
    });
    const res = createMockRes();

    await invoke(impersonateHandlers[0], req, res);

    expect(res.statusCode).toBe(200);
    expect((res.body as any).session.contextKind).toBe('admin_impersonation');
    expect(res.headers['set-cookie']).toContain('innies_pilot_session=impersonated.token');
  });

  it('clears impersonation back to admin self-context', async () => {
    vi.spyOn(runtimeModule.runtime.services.pilotSessions, 'clearImpersonationFromRequest').mockResolvedValue({
      token: 'cleared.token',
      session: {
        contextKind: 'admin_self',
        actor: { userId: 'user_admin', githubLogin: 'adminuser', role: 'admin' },
        active: { userId: 'user_admin', githubLogin: 'adminuser', orgId: 'org_innies' }
      }
    } as any);

    const req = createMockReq({
      method: 'POST',
      path: '/v1/pilot/session/impersonation/clear',
      headers: {
        authorization: 'Bearer impersonated.token'
      }
    });
    const res = createMockRes();

    await invoke(clearHandlers[0], req, res);

    expect(res.statusCode).toBe(200);
    expect((res.body as any).session.contextKind).toBe('admin_self');
    expect(res.headers['set-cookie']).toContain('innies_pilot_session=cleared.token');
  });
});
