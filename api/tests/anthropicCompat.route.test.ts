import { describe, expect, it, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import { AppError } from '../src/utils/errors.js';

type RuntimeModule = typeof import('../src/services/runtime.js');
type CompatRouteModule = typeof import('../src/routes/anthropicCompat.js');

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
  inniesCompatMode?: boolean;
  inniesProxiedPath?: string;
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

describe('anthropic compat route', () => {
  let runtimeModule: RuntimeModule;
  let handlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/innies_test';
    process.env.SELLER_SECRET_ENC_KEY_B64 = process.env.SELLER_SECRET_ENC_KEY_B64 || Buffer.alloc(32, 7).toString('base64');
    runtimeModule = await import('../src/services/runtime.js');
    const mod = await import('../src/routes/anthropicCompat.js') as CompatRouteModule;
    handlers = getRouteHandlers(mod.default as any, '/v1/messages');
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.TOKEN_REFRESH_ENDPOINT;
    process.env.ANTHROPIC_COMPAT_ENDPOINT_ENABLED = 'true';
    process.env.TOKEN_MODE_ENABLED_ORGS = '818d0cc7-7ed2-469f-b690-a977e72a921d';

    vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'findActiveByHash').mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      org_id: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      scope: 'buyer_proxy',
      is_active: true,
      expires_at: null
    } as any);
    vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'touchLastUsed').mockResolvedValue(undefined);
    vi.spyOn(runtimeModule.runtime.repos.killSwitch, 'isDisabled').mockResolvedValue(false);
    vi.spyOn(runtimeModule.runtime.repos.modelCompatibility, 'findActive').mockResolvedValue({
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      supports_streaming: true
    } as any);
    vi.spyOn(runtimeModule.runtime.repos.routingEvents, 'insert').mockResolvedValue(undefined);
    vi.spyOn(runtimeModule.runtime.services.metering, 'recordUsage').mockResolvedValue({ id: 'u1', entry_type: 'usage' } as any);
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'listActiveForRouting').mockResolvedValue([{
      id: '22222222-2222-4222-8222-222222222222',
      orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      provider: 'anthropic',
      authScheme: 'bearer',
      accessToken: 'sk-ant-oat01-test-token',
      refreshToken: null,
      expiresAt: new Date('2026-03-02T00:00:00Z'),
      status: 'active',
      rotationVersion: 1,
      createdAt: new Date('2026-03-01T00:00:00Z'),
      updatedAt: new Date('2026-03-01T00:00:00Z'),
      revokedAt: null,
      monthlyContributionLimitUnits: null,
      monthlyContributionUsedUnits: 0,
      monthlyWindowStartAt: new Date('2026-03-01T00:00:00Z')
    } as any]);
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'addMonthlyContributionUsage').mockResolvedValue(true);
    vi.spyOn(runtimeModule.runtime.services.idempotency, 'start').mockResolvedValue({
      replay: false,
      input: {
        scope: 'proxy.v1',
        tenantScope: '818d0cc7-7ed2-469f-b690-a977e72a921d',
        idempotencyKey: 'abcdefghijklmnopqrstuvwxyz123456',
        requestHash: 'h'
      }
    } as any);
    vi.spyOn(runtimeModule.runtime.services.idempotency, 'commit').mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_COMPAT_ENDPOINT_ENABLED;
    delete process.env.TOKEN_MODE_ENABLED_ORGS;
    vi.restoreAllMocks();
  });

  it('returns deterministic 404 when compat endpoint flag is off', async () => {
    process.env.ANTHROPIC_COMPAT_ENDPOINT_ENABLED = 'false';

    const req = createMockReq({ method: 'POST', path: '/v1/messages', body: { model: 'claude-opus-4-6' } });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    expect(res.statusCode).toBe(404);
    expect((res.body as any).code).toBe('not_found');
  });

  it('returns 403 when compat route org is not token-enabled', async () => {
    process.env.TOKEN_MODE_ENABLED_ORGS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    const req = createMockReq({
      method: 'POST',
      path: '/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json'
      },
      body: {
        model: 'claude-opus-4-6',
        max_tokens: 8,
        messages: [{ role: 'user', content: 'hi' }]
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);
    await invoke(handlers[2], req, res);

    expect(res.statusCode).toBe(403);
    expect((res.body as any).code).toBe('forbidden');
    expect(String((res.body as any).message)).toContain('Token mode not enabled');
  });

  it('rejects stream=true deterministically for C1', async () => {
    const req = createMockReq({
      method: 'POST',
      path: '/v1/messages',
      headers: { authorization: 'Bearer in_test_token', 'content-type': 'application/json' },
      body: { model: 'claude-opus-4-6', stream: true, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);
    await invoke(handlers[2], req, res);

    expect(res.statusCode).toBe(400);
    expect((res.body as any).code).toBe('model_invalid');
  });

  it('rejects missing messages validation for compat request', async () => {
    const req = createMockReq({
      method: 'POST',
      path: '/v1/messages',
      headers: { authorization: 'Bearer in_test_token', 'content-type': 'application/json' },
      body: { model: 'claude-opus-4-6', max_tokens: 8 }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);
    await invoke(handlers[2], req, res);

    expect(res.statusCode).toBe(400);
    expect((res.body as any).code).toBe('invalid_request');
  });

  it('rejects when both max_tokens and max_output_tokens are missing', async () => {
    const req = createMockReq({
      method: 'POST',
      path: '/v1/messages',
      headers: { authorization: 'Bearer in_test_token', 'content-type': 'application/json' },
      body: { model: 'claude-opus-4-6', messages: [{ role: 'user', content: 'hi' }] }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);
    await invoke(handlers[2], req, res);

    expect(res.statusCode).toBe(400);
    expect((res.body as any).code).toBe('invalid_request');
  });

  it('supports missing idempotency key with no persistence and returns upstream success', async () => {
    const idemStartSpy = vi.spyOn(runtimeModule.runtime.services.idempotency, 'start');
    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'msg_1', usage: { input_tokens: 10, output_tokens: 10 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );

    const req = createMockReq({
      method: 'POST',
      path: '/v1/messages',
      headers: { authorization: 'Bearer in_test_token', 'content-type': 'application/json' },
      body: { model: 'claude-opus-4-6', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);
    await invoke(handlers[2], req, res);

    expect(res.statusCode).toBe(200);
    expect(idemStartSpy).not.toHaveBeenCalled();
    expect(upstreamSpy).toHaveBeenCalledTimes(1);

    upstreamSpy.mockRestore();
  });

  it('returns 409 replay-not-supported on duplicate when idempotency key is provided', async () => {
    vi.spyOn(runtimeModule.runtime.services.idempotency, 'start').mockResolvedValue({
      replay: true,
      responseCode: 200,
      responseBody: { ok: true }
    } as any);

    const req = createMockReq({
      method: 'POST',
      path: '/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123456'
      },
      body: { model: 'claude-opus-4-6', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);
    await invoke(handlers[2], req, res);

    expect(res.statusCode).toBe(409);
    expect((res.body as any).code).toBe('proxy_replay_not_supported');
  });

  it('passes through upstream 4xx status/body for compat route', async () => {
    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'bad model' }
      }), {
        status: 400,
        headers: { 'content-type': 'application/json' }
      })
    );

    const req = createMockReq({
      method: 'POST',
      path: '/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json'
      },
      body: {
        model: 'claude-opus-4-6',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }]
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);
    await invoke(handlers[2], req, res);

    expect(upstreamSpy).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(400);
    expect((res.body as any).error?.type).toBe('invalid_request_error');

    upstreamSpy.mockRestore();
  });

  it('passes through upstream 5xx status/body for compat route', async () => {
    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message: 'upstream outage' }
      }), {
        status: 503,
        headers: { 'content-type': 'application/json' }
      })
    );

    const req = createMockReq({
      method: 'POST',
      path: '/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json'
      },
      body: {
        model: 'claude-opus-4-6',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }]
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);
    await invoke(handlers[2], req, res);

    expect(upstreamSpy).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(503);
    expect((res.body as any).error?.type).toBe('api_error');

    upstreamSpy.mockRestore();
  });
});
