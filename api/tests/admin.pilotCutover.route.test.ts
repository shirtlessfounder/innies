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

function getRouteHandlers(router: any, routePath: string): Array<(req: any, res: any, next: (error?: unknown) => void) => unknown> {
  const layer = router.stack.find((entry: any) => entry?.route?.path === routePath);
  if (!layer) throw new Error(`route not found: ${routePath}`);
  return layer.route.stack.map((s: any) => s.handle);
}

describe('admin pilot cutover routes', () => {
  let runtimeModule: RuntimeModule;
  let cutoverHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;
  let rollbackHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/innies_test';
    process.env.SELLER_SECRET_ENC_KEY_B64 = process.env.SELLER_SECRET_ENC_KEY_B64 || Buffer.alloc(32, 7).toString('base64');
    runtimeModule = await import('../src/services/runtime.js');
    const mod = await import('../src/routes/admin.js') as AdminRouteModule;
    cutoverHandlers = getRouteHandlers(mod.default as any, '/v1/admin/pilot/darryn/cutover');
    rollbackHandlers = getRouteHandlers(mod.default as any, '/v1/admin/pilot/darryn/rollback');
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'findActiveByHash').mockResolvedValue({
      id: '99999999-9999-4999-8999-999999999999',
      org_id: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      scope: 'admin',
      is_active: true,
      expires_at: null,
      preferred_provider: null,
      active_freeze_operation_kind: null
    } as any);
    vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'touchLastUsed').mockResolvedValue(undefined);
    vi.spyOn(runtimeModule.runtime.services.idempotency, 'start').mockResolvedValue({
      replay: false,
      input: {
        scope: 'admin_pilot_cutover_v1',
        tenantScope: '818d0cc7-7ed2-469f-b690-a977e72a921d',
        idempotencyKey: 'abcdefghijklmnopqrstuvwxyz123456',
        requestHash: 'h'
      }
    } as any);
    vi.spyOn(runtimeModule.runtime.services.idempotency, 'commit').mockResolvedValue(undefined);
    vi.spyOn(runtimeModule.runtime.repos.auditLogs, 'createEvent').mockResolvedValue({ id: 'audit_1' } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('commits Darryn cutover through the pilot access service', async () => {
    vi.spyOn(runtimeModule.runtime.services.pilotAccess, 'performCutover').mockResolvedValue({
      cutoverId: 'cutover_1',
      sourceOrgId: 'org_innies',
      targetOrgId: 'org_fnf',
      buyerKeyId: '11111111-1111-4111-8111-111111111111',
      tokenCredentialIds: ['22222222-2222-4222-8222-222222222222']
    } as any);

    const req = createMockReq({
      method: 'POST',
      path: '/v1/admin/pilot/darryn/cutover',
      headers: {
        authorization: 'Bearer in_admin_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123456'
      },
      body: {
        buyerKeyId: '11111111-1111-4111-8111-111111111111',
        tokenCredentialIds: ['22222222-2222-4222-8222-222222222222'],
        darrynEmail: 'darryn@example.com',
        darrynDisplayName: 'Darryn',
        darrynGithubLogin: 'darryn'
      }
    });
    const res = createMockRes();

    await invoke(cutoverHandlers[0], req, res);
    await invoke(cutoverHandlers[1], req, res);

    expect(res.statusCode).toBe(200);
    expect((res.body as any).ok).toBe(true);
    expect((res.body as any).cutoverId).toBe('cutover_1');
    expect(runtimeModule.runtime.services.pilotAccess.performCutover).toHaveBeenCalledWith(expect.objectContaining({
      buyerKeyId: '11111111-1111-4111-8111-111111111111',
      tokenCredentialIds: ['22222222-2222-4222-8222-222222222222'],
      darrynEmail: 'darryn@example.com',
      darrynGithubLogin: 'darryn'
    }));
  });

  it('commits rollback for future admissions through the pilot access service', async () => {
    vi.spyOn(runtimeModule.runtime.services.idempotency, 'start').mockResolvedValue({
      replay: false,
      input: {
        scope: 'admin_pilot_rollback_v1',
        tenantScope: '818d0cc7-7ed2-469f-b690-a977e72a921d',
        idempotencyKey: 'abcdefghijklmnopqrstuvwxyz123456',
        requestHash: 'h'
      }
    } as any);
    vi.spyOn(runtimeModule.runtime.services.pilotAccess, 'performRollback').mockResolvedValue({
      rollbackId: 'rollback_1',
      sourceCutoverId: 'cutover_1',
      revertedOrgId: 'org_innies',
      buyerKeyId: '11111111-1111-4111-8111-111111111111',
      tokenCredentialIds: ['22222222-2222-4222-8222-222222222222']
    } as any);

    const req = createMockReq({
      method: 'POST',
      path: '/v1/admin/pilot/darryn/rollback',
      headers: {
        authorization: 'Bearer in_admin_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123456'
      },
      body: {
        buyerKeyId: '11111111-1111-4111-8111-111111111111',
        tokenCredentialIds: ['22222222-2222-4222-8222-222222222222']
      }
    });
    const res = createMockRes();

    await invoke(rollbackHandlers[0], req, res);
    await invoke(rollbackHandlers[1], req, res);

    expect(res.statusCode).toBe(200);
    expect((res.body as any).ok).toBe(true);
    expect((res.body as any).rollbackId).toBe('rollback_1');
    expect(runtimeModule.runtime.services.pilotAccess.performRollback).toHaveBeenCalledWith({
      buyerKeyId: '11111111-1111-4111-8111-111111111111',
      tokenCredentialIds: ['22222222-2222-4222-8222-222222222222'],
      sourceCutoverId: undefined,
      createdByUserId: null
    });
  });
});
