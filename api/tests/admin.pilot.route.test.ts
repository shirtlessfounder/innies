import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AppError } from '../src/utils/errors.js';

type RuntimeModule = typeof import('../src/services/runtime.js');
type AdminRouteModule = typeof import('../src/routes/admin.js');

type MockReq = {
  method: string;
  path: string;
  originalUrl: string;
  body: unknown;
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
  body?: unknown;
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

function getRouteHandlers(router: any, routePath: string, method: 'post'): Array<(req: any, res: any, next: (error?: unknown) => void) => unknown> {
  const layer = router.stack.find((entry: any) => entry?.route?.path === routePath && entry?.route?.methods?.[method]);
  if (!layer) throw new Error(`route not found: ${routePath}`);
  return layer.route.stack.map((s: any) => s.handle);
}

describe('admin pilot routes', () => {
  let runtimeModule: RuntimeModule;
  let sessionHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;
  let cutoverHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;
  let rollbackHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/innies_test';
    process.env.SELLER_SECRET_ENC_KEY_B64 = process.env.SELLER_SECRET_ENC_KEY_B64 || Buffer.alloc(32, 7).toString('base64');
    runtimeModule = await import('../src/services/runtime.js');
    const mod = await import('../src/routes/admin.js') as AdminRouteModule;
    sessionHandlers = getRouteHandlers(mod.default as any, '/v1/admin/pilot/session', 'post');
    cutoverHandlers = getRouteHandlers(mod.default as any, '/v1/admin/pilot/cutover', 'post');
    rollbackHandlers = getRouteHandlers(mod.default as any, '/v1/admin/pilot/rollback', 'post');
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'findActiveByHash').mockResolvedValue({
      id: '99999999-9999-4999-8999-999999999999',
      org_id: 'org_innies',
      scope: 'admin',
      is_active: true,
      expires_at: null,
      preferred_provider: null,
      is_frozen: false
    } as any);
    vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'touchLastUsed').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('mints an admin impersonation session token', async () => {
    vi.spyOn(runtimeModule.runtime.services.pilotSessions, 'issueSession').mockReturnValue('admin-session-token');

    const req = createMockReq({
      method: 'POST',
      path: '/v1/admin/pilot/session',
      headers: {
        authorization: 'Bearer in_admin_token',
        'content-type': 'application/json'
      },
      body: {
        mode: 'impersonation',
        targetUserId: 'user_darryn',
        targetOrgId: 'org_fnf',
        targetOrgSlug: 'fnf',
        targetOrgName: 'Friends & Family',
        githubLogin: 'darryn',
        userEmail: 'darryn@example.com'
      }
    });
    const res = createMockRes();

    await invoke(sessionHandlers[0], req, res);
    await invoke(sessionHandlers[1], req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      ok: true,
      sessionToken: 'admin-session-token',
      session: expect.objectContaining({
        sessionKind: 'admin_impersonation',
        effectiveOrgId: 'org_fnf',
        impersonatedUserId: 'user_darryn'
      })
    }));
    expect(res.headers['set-cookie']).toContain('innies_pilot_session=admin-session-token');
  });

  it('starts a cutover through the cutover service', async () => {
    const cutover = vi.spyOn(runtimeModule.runtime.services.pilotCutovers, 'cutover').mockResolvedValue({
      targetOrgId: 'org_fnf',
      targetUserId: 'user_darryn',
      cutoverRecord: { id: 'cut_1', effective_at: '2026-03-20T00:00:00Z' }
    } as any);

    const req = createMockReq({
      method: 'POST',
      path: '/v1/admin/pilot/cutover',
      headers: {
        authorization: 'Bearer in_admin_token',
        'content-type': 'application/json'
      },
      body: {
        sourceOrgId: 'org_innies',
        targetOrgSlug: 'fnf',
        targetOrgName: 'Friends & Family',
        targetUserEmail: 'darryn@example.com',
        targetUserDisplayName: 'Darryn',
        buyerKeyIds: ['buyer_1'],
        tokenCredentialIds: ['cred_1']
      }
    });
    const res = createMockRes();

    await invoke(cutoverHandlers[0], req, res);
    await invoke(cutoverHandlers[1], req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      ok: true,
      cutoverId: 'cut_1',
      targetOrgId: 'org_fnf',
      targetUserId: 'user_darryn'
    }));
    expect(cutover).toHaveBeenCalledWith({
      sourceOrgId: 'org_innies',
      targetOrgSlug: 'fnf',
      targetOrgName: 'Friends & Family',
      targetUserEmail: 'darryn@example.com',
      targetUserDisplayName: 'Darryn',
      buyerKeyIds: ['buyer_1'],
      tokenCredentialIds: ['cred_1'],
      actorUserId: null,
      effectiveAt: undefined
    });
  });

  it('starts a rollback through the cutover service', async () => {
    vi.spyOn(runtimeModule.runtime.services.pilotCutovers, 'rollback').mockResolvedValue({
      rollbackRecord: { id: 'rollback_1', effective_at: '2026-03-20T01:00:00Z' }
    } as any);

    const req = createMockReq({
      method: 'POST',
      path: '/v1/admin/pilot/rollback',
      headers: {
        authorization: 'Bearer in_admin_token',
        'content-type': 'application/json'
      },
      body: {
        sourceCutoverId: 'cut_1',
        targetOrgId: 'org_innies',
        buyerKeyIds: ['buyer_1'],
        tokenCredentialIds: ['cred_1']
      }
    });
    const res = createMockRes();

    await invoke(rollbackHandlers[0], req, res);
    await invoke(rollbackHandlers[1], req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      ok: true,
      rollbackId: 'rollback_1'
    }));
  });
});
