import { describe, expect, it, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import { AppError } from '../src/utils/errors.js';

type RuntimeModule = typeof import('../src/services/runtime.js');
type AdminRouteModule = typeof import('../src/routes/admin.js');
type ProbeModule = typeof import('../src/services/tokenCredentialProbe.js');

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

describe('admin token credential routes idempotent replay', () => {
  let runtimeModule: RuntimeModule;
  let probeModule: ProbeModule;
  let createHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;
  let rotateHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;
  let revokeHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;
  let refreshTokenHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;
  let probeHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/innies_test';
    process.env.SELLER_SECRET_ENC_KEY_B64 = process.env.SELLER_SECRET_ENC_KEY_B64 || Buffer.alloc(32, 7).toString('base64');
    runtimeModule = await import('../src/services/runtime.js');
    probeModule = await import('../src/services/tokenCredentialProbe.js');
    const mod = await import('../src/routes/admin.js') as AdminRouteModule;
    createHandlers = getRouteHandlers(mod.default as any, '/v1/admin/token-credentials');
    rotateHandlers = getRouteHandlers(mod.default as any, '/v1/admin/token-credentials/rotate');
    revokeHandlers = getRouteHandlers(mod.default as any, '/v1/admin/token-credentials/:id/revoke');
    refreshTokenHandlers = getRouteHandlers(mod.default as any, '/v1/admin/token-credentials/:id/refresh-token');
    probeHandlers = getRouteHandlers(mod.default as any, '/v1/admin/token-credentials/:id/probe');
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'findActiveByHash').mockResolvedValue({
      id: '99999999-9999-4999-8999-999999999999',
      org_id: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      scope: 'admin',
      is_active: true,
      expires_at: null
    } as any);
    vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'touchLastUsed').mockResolvedValue(undefined);

    vi.spyOn(runtimeModule.runtime.services.idempotency, 'start').mockResolvedValue({
      replay: true,
      responseCode: 200,
      responseBody: { ok: true, replayed: true }
    } as any);

    vi.spyOn(runtimeModule.runtime.services.tokenCredentials, 'create').mockResolvedValue({
      id: 'x',
      rotationVersion: 1
    } as any);
    vi.spyOn(runtimeModule.runtime.services.tokenCredentials, 'rotate').mockResolvedValue({
      id: 'y',
      previousId: 'x',
      rotationVersion: 2
    } as any);
    vi.spyOn(runtimeModule.runtime.services.tokenCredentials, 'revoke').mockResolvedValue(true);
    vi.spyOn(runtimeModule.runtime.services.tokenCredentials, 'setRefreshToken').mockResolvedValue(true);
    vi.spyOn(probeModule, 'probeAndUpdateTokenCredential').mockResolvedValue({
      ok: true,
      statusCode: 200,
      reason: 'ok',
      reactivated: true,
      status: 'active',
      nextProbeAt: null
    });
    vi.spyOn(runtimeModule.runtime.repos.auditLogs, 'createEvent').mockResolvedValue({ id: 'audit_1' } as any);
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'getById').mockResolvedValue({
      id: 'z',
      orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      provider: 'anthropic',
      debugLabel: 'oauth-main-1',
      status: 'maxed',
      expiresAt: new Date('2026-03-20T00:00:00.000Z')
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('replays create/rotate/revoke/refresh-token/probe deterministically without executing mutations', async () => {
    const headers = {
      authorization: 'Bearer in_admin_token',
      'content-type': 'application/json',
      'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123456'
    };

    const reqCreate = createMockReq({
      method: 'POST',
      path: '/v1/admin/token-credentials',
      headers,
      body: {
        orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
        provider: 'anthropic',
        authScheme: 'x_api_key',
        accessToken: 'tok_1',
        expiresAt: '2026-03-02T00:00:00.000Z'
      }
    });
    const resCreate = createMockRes();
    await invoke(createHandlers[0], reqCreate, resCreate);
    await invoke(createHandlers[1], reqCreate, resCreate);
    expect(resCreate.statusCode).toBe(200);
    expect(resCreate.headers['x-idempotent-replay']).toBe('true');
    expect((resCreate.body as any).replayed).toBe(true);

    const reqRotate = createMockReq({
      method: 'POST',
      path: '/v1/admin/token-credentials/rotate',
      headers,
      body: {
        orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
        provider: 'anthropic',
        authScheme: 'x_api_key',
        accessToken: 'tok_2',
        expiresAt: '2026-03-03T00:00:00.000Z'
      }
    });
    const resRotate = createMockRes();
    await invoke(rotateHandlers[0], reqRotate, resRotate);
    await invoke(rotateHandlers[1], reqRotate, resRotate);
    expect(resRotate.statusCode).toBe(200);
    expect(resRotate.headers['x-idempotent-replay']).toBe('true');
    expect((resRotate.body as any).replayed).toBe(true);

    const reqRevoke = createMockReq({
      method: 'POST',
      path: '/v1/admin/token-credentials/11111111-1111-4111-8111-111111111111/revoke',
      headers,
      params: { id: '11111111-1111-4111-8111-111111111111' }
    });
    const resRevoke = createMockRes();
    await invoke(revokeHandlers[0], reqRevoke, resRevoke);
    await invoke(revokeHandlers[1], reqRevoke, resRevoke);
    expect(resRevoke.statusCode).toBe(200);
    expect(resRevoke.headers['x-idempotent-replay']).toBe('true');
    expect((resRevoke.body as any).replayed).toBe(true);

    const reqRefresh = createMockReq({
      method: 'PATCH',
      path: '/v1/admin/token-credentials/11111111-1111-4111-8111-111111111111/refresh-token',
      headers,
      params: { id: '11111111-1111-4111-8111-111111111111' },
      body: {
        refreshToken: 'rt_1'
      }
    });
    const resRefresh = createMockRes();
    await invoke(refreshTokenHandlers[0], reqRefresh, resRefresh);
    await invoke(refreshTokenHandlers[1], reqRefresh, resRefresh);
    expect(resRefresh.statusCode).toBe(200);
    expect(resRefresh.headers['x-idempotent-replay']).toBe('true');
    expect((resRefresh.body as any).replayed).toBe(true);

    const reqProbe = createMockReq({
      method: 'POST',
      path: '/v1/admin/token-credentials/11111111-1111-4111-8111-111111111111/probe',
      headers,
      params: { id: '11111111-1111-4111-8111-111111111111' }
    });
    const resProbe = createMockRes();
    await invoke(probeHandlers[0], reqProbe, resProbe);
    await invoke(probeHandlers[1], reqProbe, resProbe);
    expect(resProbe.statusCode).toBe(200);
    expect(resProbe.headers['x-idempotent-replay']).toBe('true');
    expect((resProbe.body as any).replayed).toBe(true);

    expect(runtimeModule.runtime.services.tokenCredentials.create).not.toHaveBeenCalled();
    expect(runtimeModule.runtime.services.tokenCredentials.rotate).not.toHaveBeenCalled();
    expect(runtimeModule.runtime.services.tokenCredentials.revoke).not.toHaveBeenCalled();
    expect(runtimeModule.runtime.services.tokenCredentials.setRefreshToken).not.toHaveBeenCalled();
    expect(runtimeModule.runtime.repos.tokenCredentials.getById).not.toHaveBeenCalled();
    expect(probeModule.probeAndUpdateTokenCredential).not.toHaveBeenCalled();
  });

  it('allows creating additional credentials for same org/provider', async () => {
    vi.spyOn(runtimeModule.runtime.services.idempotency, 'start').mockResolvedValue({
      replay: false,
      input: {
        scope: 'admin_token_credentials_create_v1',
        tenantScope: '818d0cc7-7ed2-469f-b690-a977e72a921d',
        idempotencyKey: 'abcdefghijklmnopqrstuvwxyz123456',
        requestHash: 'h'
      }
    } as any);
    const createSpy = vi.spyOn(runtimeModule.runtime.services.tokenCredentials, 'create').mockResolvedValue({
      id: 'new_cred_1',
      rotationVersion: 4
    } as any);
    const commitSpy = vi.spyOn(runtimeModule.runtime.services.idempotency, 'commit').mockResolvedValue(undefined);

    const req = createMockReq({
      method: 'POST',
      path: '/v1/admin/token-credentials',
      headers: {
        authorization: 'Bearer in_admin_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123456'
      },
      body: {
        orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
        provider: 'anthropic',
        authScheme: 'x_api_key',
        accessToken: 'tok_1',
        expiresAt: '2026-03-02T00:00:00.000Z'
      }
    });
    const res = createMockRes();

    await invoke(createHandlers[0], req, res);
    await invoke(createHandlers[1], req, res);

    expect(res.statusCode).toBe(200);
    expect((res.body as any).ok).toBe(true);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(commitSpy).toHaveBeenCalledTimes(1);
  });

  it('maps create unique-constraint race to deterministic 409 contract', async () => {
    vi.spyOn(runtimeModule.runtime.services.idempotency, 'start').mockResolvedValue({
      replay: false,
      input: {
        scope: 'admin_token_credentials_create_v1',
        tenantScope: '818d0cc7-7ed2-469f-b690-a977e72a921d',
        idempotencyKey: 'abcdefghijklmnopqrstuvwxyz123456',
        requestHash: 'h'
      }
    } as any);
    const createSpy = vi.spyOn(runtimeModule.runtime.services.tokenCredentials, 'create').mockRejectedValue({ code: '23505' });
    const commitSpy = vi.spyOn(runtimeModule.runtime.services.idempotency, 'commit').mockResolvedValue(undefined);

    const req = createMockReq({
      method: 'POST',
      path: '/v1/admin/token-credentials',
      headers: {
        authorization: 'Bearer in_admin_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123456'
      },
      body: {
        orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
        provider: 'anthropic',
        authScheme: 'x_api_key',
        accessToken: 'tok_1',
        expiresAt: '2026-03-02T00:00:00.000Z'
      }
    });
    const res = createMockRes();

    await invoke(createHandlers[0], req, res);
    await invoke(createHandlers[1], req, res);

    expect(res.statusCode).toBe(409);
    expect((res.body as any).code).toBe('invalid_request');
    expect(String((res.body as any).message)).toContain('write conflict');
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(commitSpy).not.toHaveBeenCalled();
  });

  it('normalizes codex provider alias to openai for create and rotate', async () => {
    vi.spyOn(runtimeModule.runtime.services.idempotency, 'start')
      .mockResolvedValueOnce({
        replay: false,
        input: {
          scope: 'admin_token_credentials_create_v1',
          tenantScope: '818d0cc7-7ed2-469f-b690-a977e72a921d',
          idempotencyKey: 'abcdefghijklmnopqrstuvwxyz123456',
          requestHash: 'create_h'
        }
      } as any)
      .mockResolvedValueOnce({
        replay: false,
        input: {
          scope: 'admin_token_credentials_rotate_v1',
          tenantScope: '818d0cc7-7ed2-469f-b690-a977e72a921d',
          idempotencyKey: 'abcdefghijklmnopqrstuvwxyz123457',
          requestHash: 'rotate_h'
        }
      } as any);

    const createSpy = vi.spyOn(runtimeModule.runtime.services.tokenCredentials, 'create').mockResolvedValue({
      id: 'new_cred_codex',
      rotationVersion: 1
    } as any);
    const rotateSpy = vi.spyOn(runtimeModule.runtime.services.tokenCredentials, 'rotate').mockResolvedValue({
      id: 'new_cred_codex_rotated',
      previousId: 'new_cred_codex',
      rotationVersion: 2
    } as any);
    const commitSpy = vi.spyOn(runtimeModule.runtime.services.idempotency, 'commit').mockResolvedValue(undefined);

    const reqCreate = createMockReq({
      method: 'POST',
      path: '/v1/admin/token-credentials',
      headers: {
        authorization: 'Bearer in_admin_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123456'
      },
      body: {
        orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
        provider: 'CoDeX',
        authScheme: 'bearer',
        accessToken: 'codex_tok_1',
        expiresAt: '2026-03-05T00:00:00.000Z'
      }
    });
    const resCreate = createMockRes();

    await invoke(createHandlers[0], reqCreate, resCreate);
    await invoke(createHandlers[1], reqCreate, resCreate);
    expect(resCreate.statusCode).toBe(200);
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openai'
      }),
      expect.any(Object)
    );

    const reqRotate = createMockReq({
      method: 'POST',
      path: '/v1/admin/token-credentials/rotate',
      headers: {
        authorization: 'Bearer in_admin_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123457'
      },
      body: {
        orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
        provider: 'codex',
        authScheme: 'bearer',
        accessToken: 'codex_tok_2',
        expiresAt: '2026-03-06T00:00:00.000Z'
      }
    });
    const resRotate = createMockRes();

    await invoke(rotateHandlers[0], reqRotate, resRotate);
    await invoke(rotateHandlers[1], reqRotate, resRotate);
    expect(resRotate.statusCode).toBe(200);
    expect(rotateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openai'
      }),
      expect.any(Object)
    );
    expect(commitSpy).toHaveBeenCalledTimes(2);
  });

  it('sets and clears refresh tokens for an existing credential by id', async () => {
    vi.spyOn(runtimeModule.runtime.services.idempotency, 'start')
      .mockResolvedValueOnce({
        replay: false,
        input: {
          scope: 'admin_token_credentials_refresh_token_v1',
          tenantScope: '818d0cc7-7ed2-469f-b690-a977e72a921d',
          idempotencyKey: 'abcdefghijklmnopqrstuvwxyz123456',
          requestHash: 'refresh_h_1'
        }
      } as any)
      .mockResolvedValueOnce({
        replay: false,
        input: {
          scope: 'admin_token_credentials_refresh_token_v1',
          tenantScope: '818d0cc7-7ed2-469f-b690-a977e72a921d',
          idempotencyKey: 'abcdefghijklmnopqrstuvwxyz123457',
          requestHash: 'refresh_h_2'
        }
      } as any);

    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'getById').mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d'
    } as any);
    const updateSpy = vi.spyOn(runtimeModule.runtime.services.tokenCredentials, 'setRefreshToken').mockResolvedValue(true);
    const commitSpy = vi.spyOn(runtimeModule.runtime.services.idempotency, 'commit').mockResolvedValue(undefined);

    const reqSet = createMockReq({
      method: 'PATCH',
      path: '/v1/admin/token-credentials/11111111-1111-4111-8111-111111111111/refresh-token',
      headers: {
        authorization: 'Bearer in_admin_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123456'
      },
      params: { id: '11111111-1111-4111-8111-111111111111' },
      body: {
        refreshToken: 'rt_live'
      }
    });
    const resSet = createMockRes();
    await invoke(refreshTokenHandlers[0], reqSet, resSet);
    await invoke(refreshTokenHandlers[1], reqSet, resSet);

    expect(resSet.statusCode).toBe(200);
    expect((resSet.body as any)).toEqual({
      ok: true,
      id: '11111111-1111-4111-8111-111111111111',
      hasRefreshToken: true
    });
    expect(updateSpy).toHaveBeenNthCalledWith(
      1,
      '11111111-1111-4111-8111-111111111111',
      '818d0cc7-7ed2-469f-b690-a977e72a921d',
      'rt_live',
      expect.any(Object)
    );

    const reqClear = createMockReq({
      method: 'PATCH',
      path: '/v1/admin/token-credentials/11111111-1111-4111-8111-111111111111/refresh-token',
      headers: {
        authorization: 'Bearer in_admin_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123457'
      },
      params: { id: '11111111-1111-4111-8111-111111111111' },
      body: {
        refreshToken: null
      }
    });
    const resClear = createMockRes();
    await invoke(refreshTokenHandlers[0], reqClear, resClear);
    await invoke(refreshTokenHandlers[1], reqClear, resClear);

    expect(resClear.statusCode).toBe(200);
    expect((resClear.body as any)).toEqual({
      ok: true,
      id: '11111111-1111-4111-8111-111111111111',
      hasRefreshToken: false
    });
    expect(updateSpy).toHaveBeenNthCalledWith(
      2,
      '11111111-1111-4111-8111-111111111111',
      '818d0cc7-7ed2-469f-b690-a977e72a921d',
      null,
      expect.any(Object)
    );
    expect(commitSpy).toHaveBeenCalledTimes(2);
  });

  it('probes a maxed credential immediately and returns active on success', async () => {
    vi.spyOn(runtimeModule.runtime.services.idempotency, 'start').mockResolvedValue({
      replay: false,
      input: {
        scope: 'admin_token_credentials_probe_v1',
        tenantScope: '818d0cc7-7ed2-469f-b690-a977e72a921d',
        idempotencyKey: 'abcdefghijklmnopqrstuvwxyz123458',
        requestHash: 'probe_h_1'
      }
    } as any);

    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'getById').mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      provider: 'openai',
      debugLabel: 'niyant-codex',
      status: 'maxed',
      expiresAt: new Date('2026-03-20T00:00:00.000Z')
    } as any);
    const probeSpy = vi.spyOn(probeModule, 'probeAndUpdateTokenCredential').mockResolvedValue({
      ok: true,
      statusCode: 200,
      reason: 'ok',
      reactivated: true,
      status: 'active',
      nextProbeAt: null
    });
    const commitSpy = vi.spyOn(runtimeModule.runtime.services.idempotency, 'commit').mockResolvedValue(undefined);

    const req = createMockReq({
      method: 'POST',
      path: '/v1/admin/token-credentials/11111111-1111-4111-8111-111111111111/probe',
      headers: {
        authorization: 'Bearer in_admin_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123458'
      },
      params: { id: '11111111-1111-4111-8111-111111111111' }
    });
    const res = createMockRes();

    await invoke(probeHandlers[0], req, res);
    await invoke(probeHandlers[1], req, res);

    expect(res.statusCode).toBe(200);
    expect((res.body as any)).toEqual({
      ok: true,
      id: '11111111-1111-4111-8111-111111111111',
      provider: 'openai',
      debugLabel: 'niyant-codex',
      probeOk: true,
      reactivated: true,
      status: 'active',
      upstreamStatus: 200,
      reason: 'ok',
      nextProbeAt: null
    });
    expect(probeSpy).toHaveBeenCalledTimes(1);
    expect(commitSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects manual probe when the credential is not maxed', async () => {
    vi.spyOn(runtimeModule.runtime.services.idempotency, 'start').mockResolvedValue({
      replay: false,
      input: {
        scope: 'admin_token_credentials_probe_v1',
        tenantScope: '818d0cc7-7ed2-469f-b690-a977e72a921d',
        idempotencyKey: 'abcdefghijklmnopqrstuvwxyz123459',
        requestHash: 'probe_h_2'
      }
    } as any);
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'getById').mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      provider: 'openai',
      debugLabel: 'niyant-codex',
      status: 'active',
      expiresAt: new Date('2026-03-20T00:00:00.000Z')
    } as any);

    const req = createMockReq({
      method: 'POST',
      path: '/v1/admin/token-credentials/11111111-1111-4111-8111-111111111111/probe',
      headers: {
        authorization: 'Bearer in_admin_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123459'
      },
      params: { id: '11111111-1111-4111-8111-111111111111' }
    });
    const res = createMockRes();

    await invoke(probeHandlers[0], req, res);
    await invoke(probeHandlers[1], req, res);

    expect(res.statusCode).toBe(409);
    expect((res.body as any).code).toBe('invalid_request');
    expect(String((res.body as any).message)).toContain('must be maxed');
    expect(probeModule.probeAndUpdateTokenCredential).not.toHaveBeenCalled();
  });
});
