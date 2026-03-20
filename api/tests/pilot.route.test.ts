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
  query: Record<string, string>;
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
  redirect: (code: number, location: string) => void;
};

function createMockReq(input: {
  method: string;
  path: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  params?: Record<string, string>;
}): MockReq {
  const lower = Object.fromEntries(
    Object.entries(input.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])
  );
  return {
    method: input.method.toUpperCase(),
    path: input.path,
    originalUrl: input.path,
    body: {},
    params: input.params ?? {},
    query: input.query ?? {},
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
    },
    redirect(code: number, location: string) {
      this.statusCode = code;
      this.headers.location = location;
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

describe('pilot routes', () => {
  let runtimeModule: RuntimeModule;
  let sessionHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;
  let walletHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;
  let walletLedgerHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;
  let authStartHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;
  let authCallbackHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;
  let logoutHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/innies_test';
    process.env.SELLER_SECRET_ENC_KEY_B64 = process.env.SELLER_SECRET_ENC_KEY_B64 || Buffer.alloc(32, 7).toString('base64');
    runtimeModule = await import('../src/services/runtime.js');
    const mod = await import('../src/routes/pilot.js') as PilotRouteModule;
    sessionHandlers = getRouteHandlers(mod.default as any, '/v1/pilot/session', 'get');
    walletHandlers = getRouteHandlers(mod.default as any, '/v1/pilot/wallet', 'get');
    walletLedgerHandlers = getRouteHandlers(mod.default as any, '/v1/pilot/wallet/ledger', 'get');
    authStartHandlers = getRouteHandlers(mod.default as any, '/v1/pilot/auth/github/start', 'get');
    authCallbackHandlers = getRouteHandlers(mod.default as any, '/v1/pilot/auth/github/callback', 'get');
    logoutHandlers = getRouteHandlers(mod.default as any, '/v1/pilot/session/logout', 'post');
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the current pilot session from a bearer token', async () => {
    vi.spyOn(runtimeModule.runtime.services.pilotSessions, 'readTokenFromRequest').mockReturnValue('pilot-token');
    vi.spyOn(runtimeModule.runtime.services.pilotSessions, 'readSession').mockReturnValue({
      sessionKind: 'darryn_self',
      actorUserId: 'user_darryn',
      actorApiKeyId: null,
      actorOrgId: 'org_fnf',
      effectiveOrgId: 'org_fnf',
      effectiveOrgSlug: 'fnf',
      effectiveOrgName: 'Friends & Family',
      githubLogin: 'darryn',
      userEmail: 'darryn@example.com',
      impersonatedUserId: null,
      issuedAt: '2026-03-20T00:00:00Z',
      expiresAt: '2026-03-20T01:00:00Z'
    } as any);

    const req = createMockReq({
      method: 'GET',
      path: '/v1/pilot/session',
      headers: {
        authorization: 'Bearer pilot-token'
      }
    });
    const res = createMockRes();

    await invoke(sessionHandlers[0], req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      ok: true,
      session: expect.objectContaining({
        sessionKind: 'darryn_self',
        effectiveOrgId: 'org_fnf',
        githubLogin: 'darryn'
      })
    }));
  });

  it('returns the pilot wallet balance for the effective org', async () => {
    vi.spyOn(runtimeModule.runtime.services.pilotSessions, 'readTokenFromRequest').mockReturnValue('pilot-token');
    vi.spyOn(runtimeModule.runtime.services.pilotSessions, 'readSession').mockReturnValue({
      sessionKind: 'darryn_self',
      actorUserId: 'user_darryn',
      actorApiKeyId: null,
      actorOrgId: 'org_fnf',
      effectiveOrgId: 'org_fnf',
      effectiveOrgSlug: 'fnf',
      effectiveOrgName: 'Friends & Family',
      githubLogin: 'darryn',
      userEmail: 'darryn@example.com',
      impersonatedUserId: null,
      issuedAt: '2026-03-20T00:00:00Z',
      expiresAt: '2026-03-20T01:00:00Z'
    } as any);
    vi.spyOn(runtimeModule.runtime.services.wallets, 'getWalletSnapshot').mockResolvedValue({
      walletId: 'org_fnf',
      ownerOrgId: 'org_fnf',
      balanceMinor: 1250,
      currency: 'USD'
    } as any);

    const req = createMockReq({
      method: 'GET',
      path: '/v1/pilot/wallet',
      headers: {
        authorization: 'Bearer pilot-token'
      }
    });
    const res = createMockRes();

    await invoke(walletHandlers[0], req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      ok: true,
      wallet: expect.objectContaining({
        walletId: 'org_fnf',
        balanceMinor: 1250
      })
    }));
  });

  it('returns pilot wallet ledger history for the effective org', async () => {
    vi.spyOn(runtimeModule.runtime.services.pilotSessions, 'readTokenFromRequest').mockReturnValue('pilot-token');
    vi.spyOn(runtimeModule.runtime.services.pilotSessions, 'readSession').mockReturnValue({
      sessionKind: 'darryn_self',
      actorUserId: 'user_darryn',
      actorApiKeyId: null,
      actorOrgId: 'org_fnf',
      effectiveOrgId: 'org_fnf',
      effectiveOrgSlug: 'fnf',
      effectiveOrgName: 'Friends & Family',
      githubLogin: 'darryn',
      userEmail: 'darryn@example.com',
      impersonatedUserId: null,
      issuedAt: '2026-03-20T00:00:00Z',
      expiresAt: '2026-03-20T01:00:00Z'
    } as any);
    vi.spyOn(runtimeModule.runtime.services.wallets, 'listWalletLedger').mockResolvedValue({
      entries: [{
        id: 'wallet_entry_1',
        wallet_id: 'org_fnf',
        effect_type: 'manual_credit',
        amount_minor: 5000
      }],
      nextCursor: null
    } as any);

    const req = createMockReq({
      method: 'GET',
      path: '/v1/pilot/wallet/ledger',
      headers: {
        authorization: 'Bearer pilot-token'
      }
    });
    const res = createMockRes();

    await invoke(walletLedgerHandlers[0], req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      ok: true,
      ledger: [expect.objectContaining({
        id: 'wallet_entry_1'
      })],
      nextCursor: null
    }));
  });

  it('redirects to GitHub auth with a signed state token', async () => {
    const buildAuthorizationUrl = vi.spyOn(runtimeModule.runtime.services.pilotGithubAuth, 'buildAuthorizationUrl')
      .mockReturnValue('https://github.com/login/oauth/authorize?state=signed');

    const req = createMockReq({
      method: 'GET',
      path: '/v1/pilot/auth/github/start',
      query: { returnTo: '/pilot' }
    });
    const res = createMockRes();

    await invoke(authStartHandlers[0], req, res);

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://github.com/login/oauth/authorize?state=signed');
    expect(buildAuthorizationUrl).toHaveBeenCalledWith({ returnTo: '/pilot' });
  });

  it('drops unsafe external returnTo values before starting GitHub auth', async () => {
    const buildAuthorizationUrl = vi.spyOn(runtimeModule.runtime.services.pilotGithubAuth, 'buildAuthorizationUrl')
      .mockReturnValue('https://github.com/login/oauth/authorize?state=signed');

    const req = createMockReq({
      method: 'GET',
      path: '/v1/pilot/auth/github/start',
      query: { returnTo: 'https://evil.example.com/phish' }
    });
    const res = createMockRes();

    await invoke(authStartHandlers[0], req, res);

    expect(res.statusCode).toBe(302);
    expect(buildAuthorizationUrl).toHaveBeenCalledWith({ returnTo: undefined });
  });

  it('handles the GitHub callback by setting the pilot session cookie and redirecting', async () => {
    vi.spyOn(runtimeModule.runtime.services.pilotGithubAuth, 'finishOauthCallback').mockResolvedValue({
      sessionToken: 'signed-session-token',
      returnTo: '/pilot',
      session: {
        sessionKind: 'darryn_self',
        actorUserId: 'user_darryn',
        effectiveOrgId: 'org_fnf',
        githubLogin: 'darryn',
        userEmail: 'darryn@example.com'
      }
    } as any);

    const req = createMockReq({
      method: 'GET',
      path: '/v1/pilot/auth/github/callback',
      query: { code: 'oauth-code', state: 'oauth-state' }
    });
    const res = createMockRes();

    await invoke(authCallbackHandlers[0], req, res);

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/pilot');
    expect(res.headers['set-cookie']).toContain('innies_pilot_session=signed-session-token');
    expect(res.headers['set-cookie']).toContain('HttpOnly');
  });

  it('falls back to /pilot when the callback returnTo is unsafe', async () => {
    vi.spyOn(runtimeModule.runtime.services.pilotGithubAuth, 'finishOauthCallback').mockResolvedValue({
      sessionToken: 'signed-session-token',
      returnTo: 'https://evil.example.com/phish',
      session: {
        sessionKind: 'darryn_self',
        actorUserId: 'user_darryn',
        effectiveOrgId: 'org_fnf',
        githubLogin: 'darryn',
        userEmail: 'darryn@example.com'
      }
    } as any);

    const req = createMockReq({
      method: 'GET',
      path: '/v1/pilot/auth/github/callback',
      query: { code: 'oauth-code', state: 'oauth-state' }
    });
    const res = createMockRes();

    await invoke(authCallbackHandlers[0], req, res);

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/pilot');
  });

  it('clears the pilot session cookie on logout', async () => {
    const req = createMockReq({
      method: 'POST',
      path: '/v1/pilot/session/logout'
    });
    const res = createMockRes();

    await invoke(logoutHandlers[0], req, res);

    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toContain('innies_pilot_session=');
    expect(res.headers['set-cookie']).toContain('Max-Age=0');
  });
});
