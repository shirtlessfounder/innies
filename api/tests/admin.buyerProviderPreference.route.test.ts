import { describe, expect, it, beforeAll, beforeEach, afterEach, vi } from 'vitest';
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

function getRouteHandlers(router: any, routePath: string, method: 'get' | 'patch'): Array<(req: any, res: any, next: (error?: unknown) => void) => unknown> {
  const layer = router.stack.find((entry: any) => entry?.route?.path === routePath && entry?.route?.methods?.[method]);
  if (!layer) throw new Error(`route not found: ${routePath}`);
  return layer.route.stack.map((s: any) => s.handle);
}

describe('admin buyer-key provider preference routes', () => {
  let runtimeModule: RuntimeModule;
  let getHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;
  let patchHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/innies_test';
    process.env.SELLER_SECRET_ENC_KEY_B64 = process.env.SELLER_SECRET_ENC_KEY_B64 || Buffer.alloc(32, 7).toString('base64');
    runtimeModule = await import('../src/services/runtime.js');
    const mod = await import('../src/routes/admin.js') as AdminRouteModule;
    getHandlers = getRouteHandlers(mod.default as any, '/v1/admin/buyer-keys/:id/provider-preference', 'get');
    patchHandlers = getRouteHandlers(mod.default as any, '/v1/admin/buyer-keys/:id/provider-preference', 'patch');
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.BUYER_PROVIDER_PREFERENCE_DEFAULT;

    vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'findActiveByHash').mockResolvedValue({
      id: '99999999-9999-4999-8999-999999999999',
      org_id: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      scope: 'admin',
      is_active: true,
      expires_at: null,
      preferred_provider: null
    } as any);
    vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'touchLastUsed').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns default effective provider when buyer key preference is unset', async () => {
    const getSpy = vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'getBuyerProviderPreference').mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      org_id: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      scope: 'buyer_proxy',
      preferred_provider: null,
      provider_preference_updated_at: null
    } as any);

    const req = createMockReq({
      method: 'GET',
      path: '/v1/admin/buyer-keys/11111111-1111-4111-8111-111111111111/provider-preference',
      headers: {
        authorization: 'Bearer in_admin_token'
      },
      params: { id: '11111111-1111-4111-8111-111111111111' }
    });
    const res = createMockRes();

    await invoke(getHandlers[0], req, res);
    await invoke(getHandlers[1], req, res);

    expect(res.statusCode).toBe(200);
    expect((res.body as any).preferredProvider).toBeNull();
    expect((res.body as any).effectiveProvider).toBe('anthropic');
    expect((res.body as any).source).toBe('default');
    expect(getSpy).toHaveBeenCalledTimes(1);
  });

  it('returns configured default effective provider when buyer key preference is unset', async () => {
    process.env.BUYER_PROVIDER_PREFERENCE_DEFAULT = 'codex';
    vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'getBuyerProviderPreference').mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      org_id: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      scope: 'buyer_proxy',
      preferred_provider: null,
      provider_preference_updated_at: null
    } as any);

    const req = createMockReq({
      method: 'GET',
      path: '/v1/admin/buyer-keys/11111111-1111-4111-8111-111111111111/provider-preference',
      headers: {
        authorization: 'Bearer in_admin_token'
      },
      params: { id: '11111111-1111-4111-8111-111111111111' }
    });
    const res = createMockRes();

    await invoke(getHandlers[0], req, res);
    await invoke(getHandlers[1], req, res);

    expect(res.statusCode).toBe(200);
    expect((res.body as any).preferredProvider).toBeNull();
    expect((res.body as any).effectiveProvider).toBe('openai');
    expect((res.body as any).source).toBe('default');
  });

  it('normalizes codex alias to openai on patch and persists preference', async () => {
    const getSpy = vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'getBuyerProviderPreference').mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      org_id: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      scope: 'buyer_proxy',
      preferred_provider: null,
      provider_preference_updated_at: null
    } as any);

    vi.spyOn(runtimeModule.runtime.services.idempotency, 'start').mockResolvedValue({
      replay: false,
      input: {
        scope: 'admin_buyer_provider_preference_update_v1',
        tenantScope: '818d0cc7-7ed2-469f-b690-a977e72a921d',
        idempotencyKey: 'abcdefghijklmnopqrstuvwxyz123456',
        requestHash: 'h'
      }
    } as any);

    const setSpy = vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'setBuyerProviderPreference').mockResolvedValue(true);
    const commitSpy = vi.spyOn(runtimeModule.runtime.services.idempotency, 'commit').mockResolvedValue(undefined);
    const auditSpy = vi.spyOn(runtimeModule.runtime.repos.auditLogs, 'createEvent').mockResolvedValue({ id: 'a' } as any);

    const req = createMockReq({
      method: 'PATCH',
      path: '/v1/admin/buyer-keys/11111111-1111-4111-8111-111111111111/provider-preference',
      headers: {
        authorization: 'Bearer in_admin_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123456'
      },
      params: { id: '11111111-1111-4111-8111-111111111111' },
      body: { preferredProvider: 'CoDeX' }
    });
    const res = createMockRes();

    await invoke(patchHandlers[0], req, res);
    await invoke(patchHandlers[1], req, res);

    expect(res.statusCode).toBe(200);
    expect((res.body as any).preferredProvider).toBe('openai');
    expect((res.body as any).effectiveProvider).toBe('openai');
    expect((res.body as any).source).toBe('explicit');
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledWith({
      id: '11111111-1111-4111-8111-111111111111',
      preferredProvider: 'openai'
    });
    expect(commitSpy).toHaveBeenCalledTimes(1);
    expect(auditSpy).toHaveBeenCalledTimes(1);
  });

  it('returns deterministic 404 when buyer key does not exist', async () => {
    vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'getBuyerProviderPreference').mockResolvedValue(null);

    const req = createMockReq({
      method: 'GET',
      path: '/v1/admin/buyer-keys/11111111-1111-4111-8111-111111111111/provider-preference',
      headers: {
        authorization: 'Bearer in_admin_token'
      },
      params: { id: '11111111-1111-4111-8111-111111111111' }
    });
    const res = createMockRes();

    await invoke(getHandlers[0], req, res);
    await invoke(getHandlers[1], req, res);

    expect(res.statusCode).toBe(404);
    expect((res.body as any).code).toBe('invalid_request');
    expect(String((res.body as any).message)).toContain('Buyer key not found');
  });

  it('returns deterministic 409 when preference migration is not applied yet', async () => {
    vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'getBuyerProviderPreference').mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      org_id: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      scope: 'buyer_proxy',
      preferred_provider: null,
      provider_preference_updated_at: null
    } as any);
    vi.spyOn(runtimeModule.runtime.services.idempotency, 'start').mockResolvedValue({
      replay: false,
      input: {
        scope: 'admin_buyer_provider_preference_update_v1',
        tenantScope: '818d0cc7-7ed2-469f-b690-a977e72a921d',
        idempotencyKey: 'abcdefghijklmnopqrstuvwxyz123456',
        requestHash: 'h'
      }
    } as any);
    const setSpy = vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'setBuyerProviderPreference').mockRejectedValue({
      code: '42703',
      column: 'preferred_provider',
      message: 'column "preferred_provider" does not exist'
    });
    const commitSpy = vi.spyOn(runtimeModule.runtime.services.idempotency, 'commit').mockResolvedValue(undefined);
    const auditSpy = vi.spyOn(runtimeModule.runtime.repos.auditLogs, 'createEvent').mockResolvedValue({ id: 'a' } as any);

    const req = createMockReq({
      method: 'PATCH',
      path: '/v1/admin/buyer-keys/11111111-1111-4111-8111-111111111111/provider-preference',
      headers: {
        authorization: 'Bearer in_admin_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123456'
      },
      params: { id: '11111111-1111-4111-8111-111111111111' },
      body: { preferredProvider: 'openai' }
    });
    const res = createMockRes();

    await invoke(patchHandlers[0], req, res);
    await invoke(patchHandlers[1], req, res);

    expect(res.statusCode).toBe(409);
    expect((res.body as any).code).toBe('conflict');
    expect(String((res.body as any).message)).toContain('migration not applied');
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(commitSpy).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
  });
});
