import { Writable } from 'node:stream';
import { describe, expect, it, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import { AppError } from '../src/utils/errors.js';

type RuntimeModule = typeof import('../src/services/runtime.js');
type ProxyRouteModule = typeof import('../src/routes/proxy.js');

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

function createStreamingMockRes(): MockRes & {
  write: (chunk: unknown) => void;
  end: (chunk?: unknown) => void;
  flushHeaders: () => void;
  flush: () => void;
  socket: {
    setKeepAlive: () => void;
    setNoDelay: () => void;
  };
} {
  const res = createMockRes() as MockRes & {
    write: (chunk: unknown) => void;
    end: (chunk?: unknown) => void;
    flushHeaders: () => void;
    flush: () => void;
    socket: {
      setKeepAlive: () => void;
      setNoDelay: () => void;
    };
  };

  res.write = (chunk: unknown) => {
    const next = typeof chunk === 'string' ? chunk : Buffer.from(chunk as any).toString('utf8');
    res.body = typeof res.body === 'string' ? `${res.body}${next}` : next;
  };
  res.end = (chunk?: unknown) => {
    if (chunk !== undefined) {
      res.write(chunk);
    }
    res.headersSent = true;
    res.writableEnded = true;
  };
  res.flushHeaders = () => {
    res.headersSent = true;
  };
  res.flush = () => undefined;
  res.socket = {
    setKeepAlive: () => undefined,
    setNoDelay: () => undefined
  };

  return res;
}

function createRealWritableStreamingMockRes(): MockRes & Writable & {
  flushHeaders: () => void;
  flush: () => void;
  socket: {
    setKeepAlive: () => void;
    setNoDelay: () => void;
  };
} {
  let body = '';
  const res = new Writable({
    write(chunk, _encoding, callback) {
      const next = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      body += next;
      callback();
    }
  }) as MockRes & Writable & {
    flushHeaders: () => void;
    flush: () => void;
    socket: {
      setKeepAlive: () => void;
      setNoDelay: () => void;
    };
  };

  res.statusCode = 200;
  res.headers = {};
  res.headersSent = false;
  Object.defineProperty(res, 'body', {
    get() {
      return body;
    },
    set(value: unknown) {
      body = typeof value === 'string' ? value : String(value ?? '');
    },
    configurable: true
  });
  res.setHeader = function setHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value;
  };
  res.status = function status(code: number) {
    this.statusCode = code;
    return this;
  };
  res.json = function json(payload: unknown) {
    this.setHeader('content-type', 'application/json');
    this.headersSent = true;
    this.end(JSON.stringify(payload));
  };
  res.send = function send(payload: unknown) {
    this.headersSent = true;
    this.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  };
  res.flushHeaders = () => {
    res.headersSent = true;
  };
  res.flush = () => undefined;
  res.socket = {
    setKeepAlive: () => undefined,
    setNoDelay: () => undefined
  };

  return res;
}

function createBackpressuredClosingStreamingMockRes(): MockRes & Writable & {
  flushHeaders: () => void;
  flush: () => void;
  socket: {
    setKeepAlive: () => void;
    setNoDelay: () => void;
  };
} {
  let body = '';
  let writeCount = 0;
  let res: MockRes & Writable & {
    flushHeaders: () => void;
    flush: () => void;
    socket: {
      setKeepAlive: () => void;
      setNoDelay: () => void;
    };
  };
  res = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, callback) {
      const next = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      body += next;
      writeCount += 1;
      if (writeCount === 2) {
        setImmediate(() => {
          res.destroy(Object.assign(new Error('client disconnected'), { code: 'ECONNRESET' }));
          callback();
        });
        return;
      }
      callback();
    }
  }) as MockRes & Writable & {
    flushHeaders: () => void;
    flush: () => void;
    socket: {
      setKeepAlive: () => void;
      setNoDelay: () => void;
    };
  };

  res.on('error', () => undefined);
  res.statusCode = 200;
  res.headers = {};
  res.headersSent = false;
  Object.defineProperty(res, 'body', {
    get() {
      return body;
    },
    set(value: unknown) {
      body = typeof value === 'string' ? value : String(value ?? '');
    },
    configurable: true
  });
  res.setHeader = function setHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value;
  };
  res.status = function status(code: number) {
    this.statusCode = code;
    return this;
  };
  res.json = function json(payload: unknown) {
    this.setHeader('content-type', 'application/json');
    this.headersSent = true;
    this.end(JSON.stringify(payload));
  };
  res.send = function send(payload: unknown) {
    this.headersSent = true;
    this.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  };
  res.flushHeaders = () => {
    res.headersSent = true;
  };
  res.flush = () => undefined;
  res.socket = {
    setKeepAlive: () => undefined,
    setNoDelay: () => undefined
  };

  return res;
}

function createFakeOpenAiOauthToken(input?: {
  accountId?: string;
  clientId?: string;
  exp?: number;
}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: 'https://auth.openai.com',
    aud: ['https://api.openai.com/v1'],
    client_id: input?.clientId ?? 'app_test_codex',
    exp: input?.exp ?? Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/auth': {
      chatgpt_account_id: input?.accountId ?? 'acct_codex_1'
    }
  })).toString('base64url');
  return `${header}.${payload}.signature`;
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

describe('proxy token-mode route behavior', () => {
  let runtimeModule: RuntimeModule;
  let handlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/innies_test';
    process.env.SELLER_SECRET_ENC_KEY_B64 = process.env.SELLER_SECRET_ENC_KEY_B64 || Buffer.alloc(32, 7).toString('base64');
    runtimeModule = await import('../src/services/runtime.js');
    const proxyMod = await import('../src/routes/proxy.js') as ProxyRouteModule;
    handlers = getRouteHandlers(proxyMod.default as any, '/v1/proxy/*');
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.TOKEN_REFRESH_ENDPOINT;
    delete process.env.BUYER_PROVIDER_PREFERENCE_DEFAULT;

    vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'findActiveByHash').mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      org_id: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      scope: 'buyer_proxy',
      is_active: true,
      expires_at: null,
      preferred_provider: null
    } as any);
    vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'touchLastUsed').mockResolvedValue(undefined);
    vi.spyOn(runtimeModule.runtime.repos.killSwitch, 'isDisabled').mockResolvedValue(false);
    vi.spyOn(runtimeModule.runtime.repos.modelCompatibility, 'findActive').mockResolvedValue({
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-latest',
      supports_streaming: true
    } as any);
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
    vi.spyOn(runtimeModule.runtime.repos.routingEvents, 'insert').mockResolvedValue(undefined);
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'addMonthlyContributionUsage').mockResolvedValue(true);
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'recordSuccess').mockResolvedValue(true);
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'recordFailureAndMaybeMax').mockResolvedValue({
      status: 'active',
      consecutiveFailures: 1
    } as any);
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'recordRateLimitAndMaybeMax').mockResolvedValue({
      status: 'active',
      consecutiveRateLimits: 1,
      rateLimitedUntil: null,
      newlyMaxed: false
    } as any);
    vi.spyOn(runtimeModule.runtime.services.metering, 'recordUsage').mockResolvedValue({
      id: 'usage_1',
      entry_type: 'usage'
    } as any);
  });

  afterEach(() => {
    delete process.env.BUYER_PROVIDER_PREFERENCE_DEFAULT;
    delete process.env.TOKEN_MODE_ENABLED_ORGS;
    delete process.env.ANTHROPIC_UPSTREAM_BASE_URL;
    delete process.env.OPENAI_UPSTREAM_BASE_URL;
    delete process.env.COMPAT_CODEX_DEFAULT_MODEL;
    vi.restoreAllMocks();
  });

  it('blocks non-allowlisted org when token-mode policy is active', async () => {
    process.env.TOKEN_MODE_ENABLED_ORGS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const listSpy = vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'listActiveForRouting').mockResolvedValue([]);

    const req = createMockReq({
      method: 'POST',
      path: '/v1/proxy/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123456',
        'anthropic-version': '2023-06-01',
        'x-innies-provider-pin': 'true'
      },
      body: {
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-latest',
        streaming: false,
        payload: { model: 'claude-3-5-sonnet-latest', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res); // auth middleware
    await invoke(handlers[1], req, res); // route handler

    expect(res.statusCode).toBe(403);
    expect((res.body as any).code).toBe('forbidden');
    expect(String((res.body as any).message)).toContain('Token mode not enabled');
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('injects anthropic oauth beta headers for bearer setup-token credentials', async () => {
    process.env.TOKEN_MODE_ENABLED_ORGS = '818d0cc7-7ed2-469f-b690-a977e72a921d';
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
    const markExpiredSpy = vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'markExpired').mockResolvedValue(true as any);
    const authFailureSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'bad token' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' }
      })
    );

    const req = createMockReq({
      method: 'POST',
      path: '/v1/proxy/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123456',
        'anthropic-version': '2023-06-01'
      },
      body: {
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-latest',
        streaming: false,
        payload: { model: 'claude-3-5-sonnet-latest', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res); // auth middleware
    await invoke(handlers[1], req, res); // route handler

    expect(res.statusCode).toBe(401);
    expect((res.body as any).code).toBe('unauthorized');
    expect(String((res.body as any).message)).toContain('All token credentials unauthorized or expired');
    expect(upstreamSpy).toHaveBeenCalled();
    const fetchArgs = upstreamSpy.mock.calls[0];
    const headers = (fetchArgs?.[1] as RequestInit)?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-ant-oat01-test-token');
    expect(headers['anthropic-beta']).toContain('oauth-2025-04-20');
    expect(headers['anthropic-beta']).toContain('claude-code-20250219');
    expect(markExpiredSpy).not.toHaveBeenCalled();
    const authFailureCalls = authFailureSpy.mock.calls.filter((c) => c[0] === '[auth-failure-audit] attempt');
    expect(authFailureCalls.length).toBeGreaterThan(0);
    const authAudit = authFailureCalls[0]?.[1] as any;
    expect(authAudit?.upstream_status).toBe(401);
    expect(authAudit?.org_id).toBe('818d0cc7-7ed2-469f-b690-a977e72a921d');
    expect(authAudit?.provider).toBe('anthropic');
    expect(authAudit?.model).toBe('claude-3-5-sonnet-latest');
    expect(String(authAudit?.openclaw_run_id ?? '')).toMatch(/^run_req_/);

    authFailureSpy.mockRestore();
    upstreamSpy.mockRestore();
  });

  it('fails over on upstream 403 to next token credential without expiring first credential', async () => {
    process.env.TOKEN_MODE_ENABLED_ORGS = '818d0cc7-7ed2-469f-b690-a977e72a921d';
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'listActiveForRouting').mockResolvedValue([
      {
        id: 'aaaa2222-2222-4222-8222-222222222222',
        orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
        provider: 'anthropic',
        authScheme: 'bearer',
        accessToken: 'sk-ant-oat01-first',
        refreshToken: null,
        expiresAt: new Date('2026-03-02T00:00:00Z'),
        status: 'active',
        rotationVersion: 2,
        createdAt: new Date('2026-03-01T00:00:00Z'),
        updatedAt: new Date('2026-03-01T00:00:00Z'),
        revokedAt: null,
        monthlyContributionLimitUnits: null,
        monthlyContributionUsedUnits: 0,
        monthlyWindowStartAt: new Date('2026-03-01T00:00:00Z')
      } as any,
      {
        id: 'bbbb3333-3333-4333-8333-333333333333',
        orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
        provider: 'anthropic',
        authScheme: 'bearer',
        accessToken: 'sk-ant-oat01-second',
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
      } as any
    ]);
    const markExpiredSpy = vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'markExpired').mockResolvedValue(true as any);
    const authFailureSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const upstreamSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        type: 'error',
        error: { type: 'permission_error', message: 'Your request was blocked.' }
      }), {
        status: 403,
        headers: { 'content-type': 'application/json' }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'msg_ok',
        usage: { input_tokens: 7, output_tokens: 9 },
        content: [{ type: 'text', text: 'ok' }]
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      }));

    const req = createMockReq({
      method: 'POST',
      path: '/v1/proxy/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123456',
        'anthropic-version': '2023-06-01'
      },
      body: {
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-latest',
        streaming: false,
        payload: { model: 'claude-3-5-sonnet-latest', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res); // auth middleware
    await invoke(handlers[1], req, res); // route handler

    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect((res.body as any).id).toBe('msg_ok');
    expect(upstreamSpy).toHaveBeenCalledTimes(2);
    expect(markExpiredSpy).not.toHaveBeenCalled();
    const authFailureCalls = authFailureSpy.mock.calls.filter((c) => c[0] === '[auth-failure-audit] attempt');
    expect(authFailureCalls).toHaveLength(0);

    authFailureSpy.mockRestore();
    upstreamSpy.mockRestore();
  });

  it('retries once with oauth-safe payload when compat mode gets oauth-unsupported 401', async () => {
    process.env.TOKEN_MODE_ENABLED_ORGS = '818d0cc7-7ed2-469f-b690-a977e72a921d';
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'listActiveForRouting').mockResolvedValue([{
      id: 'eeee6666-6666-4666-8666-666666666666',
      orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      provider: 'anthropic',
      authScheme: 'bearer',
      accessToken: 'sk-ant-oat01-compat-test',
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

    const upstreamSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        type: 'error',
        error: { type: 'authentication_error', message: 'OAuth authentication is currently not supported.' }
      }), {
        status: 401,
        headers: { 'content-type': 'application/json' }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'msg_compat_ok',
        usage: { input_tokens: 7, output_tokens: 9 },
        content: [{ type: 'text', text: 'ok' }]
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      }));

    const req = createMockReq({
      method: 'POST',
      path: '/v1/proxy/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123456',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14'
      },
      body: {
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-latest',
        streaming: true,
        payload: {
          model: 'claude-3-5-sonnet-latest',
          stream: true,
          max_tokens: 16,
          tools: [{ name: 'x', description: 'x', input_schema: { type: 'object', properties: {} } }],
          tool_choice: { type: 'auto' },
          messages: [{ role: 'user', content: 'hi' }]
        }
      }
    });
    (req as any).inniesCompatMode = true;
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);

    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect((res.body as any).id).toBe('msg_compat_ok');
    expect(upstreamSpy).toHaveBeenCalledTimes(2);

    const firstHeaders = (upstreamSpy.mock.calls[0]?.[1] as RequestInit)?.headers as Record<string, string>;
    const secondHeaders = (upstreamSpy.mock.calls[1]?.[1] as RequestInit)?.headers as Record<string, string>;
    const firstBody = JSON.parse(String((upstreamSpy.mock.calls[0]?.[1] as RequestInit)?.body ?? '{}'));
    const secondBody = JSON.parse(String((upstreamSpy.mock.calls[1]?.[1] as RequestInit)?.body ?? '{}'));

    expect(firstHeaders['anthropic-beta']).toContain('fine-grained-tool-streaming-2025-05-14');
    expect(secondHeaders['anthropic-beta']).toContain('oauth-2025-04-20');
    expect(secondHeaders['anthropic-beta']).toContain('claude-code-20250219');
    expect(firstBody.stream).toBe(true);
    expect(firstBody.tools).toBeDefined();
    expect(firstBody.tool_choice).toEqual({ type: 'auto' });
    expect(secondBody.stream).toBe(true);
    expect(secondBody.tools).toBeDefined();
    expect(secondBody.tool_choice).toEqual({ type: 'auto' });

    upstreamSpy.mockRestore();
  });

  it('retries once with oauth-safe payload when compat mode gets authentication_error 401 on tool-stream payload', async () => {
    process.env.TOKEN_MODE_ENABLED_ORGS = '818d0cc7-7ed2-469f-b690-a977e72a921d';
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'listActiveForRouting').mockResolvedValue([{
      id: 'ffff7777-7777-4777-8777-777777777777',
      orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      provider: 'anthropic',
      authScheme: 'bearer',
      accessToken: 'sk-ant-oat01-compat-test-2',
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

    const upstreamSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        type: 'error',
        error: { type: 'authentication_error', message: 'invalid auth mode' }
      }), {
        status: 401,
        headers: { 'content-type': 'application/json' }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'msg_compat_ok_2',
        usage: { input_tokens: 3, output_tokens: 5 },
        content: [{ type: 'text', text: 'ok' }]
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      }));

    const req = createMockReq({
      method: 'POST',
      path: '/v1/proxy/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123456',
        'anthropic-version': '2023-06-01'
      },
      body: {
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-latest',
        streaming: true,
        payload: {
          model: 'claude-3-5-sonnet-latest',
          stream: true,
          max_tokens: 16,
          tools: [{ name: 'x', description: 'x', input_schema: { type: 'object', properties: {} } }],
          tool_choice: { type: 'auto' },
          messages: [{ role: 'user', content: 'hi' }]
        }
      }
    });
    (req as any).inniesCompatMode = true;
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);

    expect(res.statusCode).toBe(200);
    expect((res.body as any).id).toBe('msg_compat_ok_2');
    expect(upstreamSpy).toHaveBeenCalledTimes(2);
    upstreamSpy.mockRestore();
  });

  it('normalizes on oauth auth-error retry for OpenClaw-shaped api-key+stream payload', async () => {
    process.env.TOKEN_MODE_ENABLED_ORGS = '818d0cc7-7ed2-469f-b690-a977e72a921d';
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'listActiveForRouting').mockResolvedValue([{
      id: 'abab7777-7777-4777-8777-777777777777',
      orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      provider: 'anthropic',
      authScheme: 'x_api_key',
      accessToken: 'sk-ant-oat01-openclaw-shaped',
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

    const upstreamSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        type: 'error',
        error: { type: 'authentication_error', message: 'OAuth authentication is currently not supported.' }
      }), {
        status: 401,
        headers: { 'content-type': 'application/json' }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'msg_preflight_ok',
        usage: { input_tokens: 3, output_tokens: 4 },
        content: [{ type: 'text', text: 'ok' }]
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      }));

    const req = createMockReq({
      method: 'POST',
      path: '/v1/proxy/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123456',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14'
      },
      body: {
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-latest',
        streaming: true,
        payload: {
          model: 'claude-3-5-sonnet-latest',
          stream: true,
          max_tokens: 16,
          tools: [{ name: 'x', description: 'x', input_schema: { type: 'object', properties: {} } }],
          tool_choice: { type: 'auto' },
          messages: [{ role: 'user', content: 'hi' }]
        }
      }
    });
    (req as any).inniesCompatMode = true;
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);

    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect((res.body as any).id).toBe('msg_preflight_ok');
    expect(upstreamSpy).toHaveBeenCalledTimes(2);

    const firstHeaders = (upstreamSpy.mock.calls[0]?.[1] as RequestInit)?.headers as Record<string, string>;
    const secondHeaders = (upstreamSpy.mock.calls[1]?.[1] as RequestInit)?.headers as Record<string, string>;
    const firstBody = JSON.parse(String((upstreamSpy.mock.calls[0]?.[1] as RequestInit)?.body ?? '{}'));
    const secondBody = JSON.parse(String((upstreamSpy.mock.calls[1]?.[1] as RequestInit)?.body ?? '{}'));

    expect(firstHeaders.authorization).toBe('Bearer sk-ant-oat01-openclaw-shaped');
    expect(firstHeaders['x-api-key']).toBeUndefined();
    expect(firstHeaders['anthropic-beta']).toContain('fine-grained-tool-streaming-2025-05-14');
    expect(firstBody.stream).toBe(true);
    expect(firstBody.tools).toBeDefined();

    expect(secondHeaders.authorization).toBe('Bearer sk-ant-oat01-openclaw-shaped');
    expect(secondHeaders['x-api-key']).toBeUndefined();
    expect(secondHeaders['anthropic-beta']).toContain('oauth-2025-04-20');
    expect(secondHeaders['anthropic-beta']).toContain('claude-code-20250219');
    expect(secondBody.stream).toBe(true);
    expect(secondBody.tools).toBeDefined();
    expect(secondBody.tool_choice).toEqual({ type: 'auto' });
    upstreamSpy.mockRestore();
  });

  it('drops beta headers on blocked-403 compat retry', async () => {
    process.env.TOKEN_MODE_ENABLED_ORGS = '818d0cc7-7ed2-469f-b690-a977e72a921d';
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'listActiveForRouting').mockResolvedValue([{
      id: 'acac7777-7777-4777-8777-777777777777',
      orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      provider: 'anthropic',
      authScheme: 'bearer',
      accessToken: 'sk-ant-oat01-blocked-compat',
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

    const upstreamSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        type: 'error',
        error: { type: 'permission_error', message: 'Your request was blocked.' }
      }), {
        status: 403,
        headers: { 'content-type': 'application/json' }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'msg_blocked_ok',
        usage: { input_tokens: 2, output_tokens: 2 },
        content: [{ type: 'text', text: 'ok' }]
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      }));

    const req = createMockReq({
      method: 'POST',
      path: '/v1/proxy/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123456',
        'anthropic-version': '2023-06-01'
      },
      body: {
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-latest',
        streaming: false,
        payload: {
          model: 'claude-3-5-sonnet-latest',
          max_tokens: 16,
          messages: [{ role: 'user', content: 'hi' }]
        }
      }
    });
    (req as any).inniesCompatMode = true;
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);

    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect((res.body as any).id).toBe('msg_blocked_ok');
    expect(upstreamSpy).toHaveBeenCalledTimes(2);

    const firstHeaders = (upstreamSpy.mock.calls[0]?.[1] as RequestInit)?.headers as Record<string, string>;
    const secondHeaders = (upstreamSpy.mock.calls[1]?.[1] as RequestInit)?.headers as Record<string, string>;
    expect(firstHeaders['anthropic-beta']).toContain('oauth-2025-04-20');
    expect(firstHeaders['anthropic-beta']).toContain('claude-code-20250219');
    expect(secondHeaders['anthropic-beta']).toBeUndefined();
    upstreamSpy.mockRestore();
  });

  it('fails over on upstream 403 in stream mode without expiring first credential', async () => {
    process.env.TOKEN_MODE_ENABLED_ORGS = '818d0cc7-7ed2-469f-b690-a977e72a921d';
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'listActiveForRouting').mockResolvedValue([
      {
        id: 'cccc4444-4444-4444-8444-444444444444',
        orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
        provider: 'anthropic',
        authScheme: 'bearer',
        accessToken: 'sk-ant-oat01-first-stream',
        refreshToken: null,
        expiresAt: new Date('2026-03-02T00:00:00Z'),
        status: 'active',
        rotationVersion: 2,
        createdAt: new Date('2026-03-01T00:00:00Z'),
        updatedAt: new Date('2026-03-01T00:00:00Z'),
        revokedAt: null,
        monthlyContributionLimitUnits: null,
        monthlyContributionUsedUnits: 0,
        monthlyWindowStartAt: new Date('2026-03-01T00:00:00Z')
      } as any,
      {
        id: 'dddd5555-5555-4555-8555-555555555555',
        orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
        provider: 'anthropic',
        authScheme: 'bearer',
        accessToken: 'sk-ant-oat01-second-stream',
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
      } as any
    ]);
    const markExpiredSpy = vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'markExpired').mockResolvedValue(true as any);
    const authFailureSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const upstreamSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        type: 'error',
        error: { type: 'permission_error', message: 'Your request was blocked.' }
      }), {
        status: 403,
        headers: { 'content-type': 'application/json' }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'msg_stream_ok',
        usage: { input_tokens: 6, output_tokens: 10 },
        content: [{ type: 'text', text: 'ok' }]
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      }));

    const req = createMockReq({
      method: 'POST',
      path: '/v1/proxy/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123456',
        'anthropic-version': '2023-06-01'
      },
      body: {
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-latest',
        streaming: true,
        payload: {
          model: 'claude-3-5-sonnet-latest',
          stream: true,
          max_tokens: 16,
          messages: [{ role: 'user', content: 'hi' }]
        }
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res); // auth middleware
    await invoke(handlers[1], req, res); // route handler

    expect(res.statusCode).toBe(200);
    expect((res.body as any).id).toBe('msg_stream_ok');
    expect(upstreamSpy).toHaveBeenCalledTimes(2);
    expect(markExpiredSpy).not.toHaveBeenCalled();
    const authFailureCalls = authFailureSpy.mock.calls.filter((c) => c[0] === '[auth-failure-audit] attempt');
    expect(authFailureCalls).toHaveLength(0);

    authFailureSpy.mockRestore();
    upstreamSpy.mockRestore();
  });

  it('preserves upstream success when monthly contribution increment cannot be recorded', async () => {
    process.env.TOKEN_MODE_ENABLED_ORGS = '818d0cc7-7ed2-469f-b690-a977e72a921d';
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'listActiveForRouting').mockResolvedValue([{
      id: '33333333-3333-4333-8333-333333333333',
      orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      provider: 'anthropic',
      authScheme: 'x_api_key',
      accessToken: 'sk-ant-api-test',
      refreshToken: null,
      expiresAt: new Date('2026-03-02T00:00:00Z'),
      status: 'active',
      rotationVersion: 1,
      createdAt: new Date('2026-03-01T00:00:00Z'),
      updatedAt: new Date('2026-03-01T00:00:00Z'),
      revokedAt: null,
      monthlyContributionLimitUnits: 100,
      monthlyContributionUsedUnits: 95,
      monthlyWindowStartAt: new Date('2026-03-01T00:00:00Z')
    } as any]);
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'addMonthlyContributionUsage').mockResolvedValue(false);

    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        id: 'msg_1',
        usage: { input_tokens: 10, output_tokens: 10 },
        content: [{ type: 'text', text: 'ok' }]
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );

    const req = createMockReq({
      method: 'POST',
      path: '/v1/proxy/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123456',
        'anthropic-version': '2023-06-01'
      },
      body: {
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-latest',
        streaming: false,
        payload: { model: 'claude-3-5-sonnet-latest', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res); // auth middleware
    await invoke(handlers[1], req, res); // route handler

    expect(upstreamSpy).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect((res.body as any).id).toBe('msg_1');
    expect((res.body as any).content?.[0]?.text).toBe('ok');

    upstreamSpy.mockRestore();
  });

  it('tracks oauth 429s through the rate-limit lifecycle instead of the auth-failure max path', async () => {
    process.env.TOKEN_MODE_ENABLED_ORGS = '818d0cc7-7ed2-469f-b690-a977e72a921d';
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'listActiveForRouting').mockResolvedValue([{
      id: 'bbbb8888-8888-4888-8888-888888888888',
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
    const recordFailureSpy = vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'recordFailureAndMaybeMax');
    const recordRateLimitSpy = vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'recordRateLimitAndMaybeMax');
    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }), {
        status: 429,
        headers: { 'content-type': 'application/json' }
      })
    );

    const req = createMockReq({
      method: 'POST',
      path: '/v1/proxy/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123456',
        'anthropic-version': '2023-06-01'
      },
      body: {
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-latest',
        streaming: false,
        payload: { model: 'claude-3-5-sonnet-latest', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);

    expect(res.statusCode).toBe(429);
    expect(recordFailureSpy).not.toHaveBeenCalled();
    expect(recordRateLimitSpy).toHaveBeenCalledWith(expect.objectContaining({
      id: 'bbbb8888-8888-4888-8888-888888888888',
      statusCode: 429,
      cooldownThreshold: 5,
      threshold: 15,
      reason: 'upstream_429_consecutive_rate_limit'
    }));
    upstreamSpy.mockRestore();
  });

  it('does not bypass the 429 threshold even when the provider body signals exhaustion', async () => {
    process.env.TOKEN_MODE_ENABLED_ORGS = '818d0cc7-7ed2-469f-b690-a977e72a921d';
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'listActiveForRouting').mockResolvedValue([{
      id: 'cccc9999-9999-4999-8999-999999999999',
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
    const recordFailureSpy = vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'recordFailureAndMaybeMax');
    const recordRateLimitSpy = vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'recordRateLimitAndMaybeMax').mockResolvedValue({
      status: 'maxed',
      consecutiveRateLimits: 6,
      rateLimitedUntil: null,
      newlyMaxed: true
    } as any);
    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        type: 'error',
        error: { type: 'rate_limit_error', message: 'You have hit your usage limit. Try again at 6 PM.' }
      }), {
        status: 429,
        headers: { 'content-type': 'application/json' }
      })
    );

    const req = createMockReq({
      method: 'POST',
      path: '/v1/proxy/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123456',
        'anthropic-version': '2023-06-01'
      },
      body: {
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-latest',
        streaming: false,
        payload: { model: 'claude-3-5-sonnet-latest', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);

    expect(res.statusCode).toBe(429);
    expect(recordFailureSpy).not.toHaveBeenCalled();
    expect(recordRateLimitSpy).toHaveBeenCalledWith(expect.objectContaining({
      id: 'cccc9999-9999-4999-8999-999999999999',
      statusCode: 429,
      cooldownThreshold: 5,
      threshold: 15,
      reason: 'upstream_429_consecutive_rate_limit'
    }));
    upstreamSpy.mockRestore();
  });

  it('routes standard openai credentials with bearer auth and openai upstream base URL', async () => {
    process.env.TOKEN_MODE_ENABLED_ORGS = '818d0cc7-7ed2-469f-b690-a977e72a921d';
    process.env.OPENAI_UPSTREAM_BASE_URL = 'https://openai.internal.test';
    vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'findActiveByHash').mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      org_id: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      scope: 'buyer_proxy',
      is_active: true,
      expires_at: null,
      preferred_provider: 'openai'
    } as any);
    vi.spyOn(runtimeModule.runtime.repos.modelCompatibility, 'findActive').mockResolvedValue({
      provider: 'openai',
      model: 'gpt-5.4',
      supports_streaming: false
    } as any);
    const listSpy = vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'listActiveForRouting').mockResolvedValue([{
      id: 'dddd0000-0000-4000-8000-000000000000',
      orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      provider: 'openai',
      authScheme: 'x_api_key',
      accessToken: 'openai-key-live',
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
    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'resp_ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );

    const req = createMockReq({
      method: 'POST',
      path: '/v1/proxy/v1/responses',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123456',
        'x-innies-provider-pin': 'true'
      },
      body: {
        provider: 'codex',
        model: 'gpt-5.4',
        streaming: false,
        payload: { model: 'gpt-5.4', input: 'hello' }
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);

    expect(res.statusCode).toBe(200);
    expect((res.body as any).id).toBe('resp_ok');
    expect(upstreamSpy).toHaveBeenCalledTimes(1);
    expect(listSpy).toHaveBeenCalledWith('818d0cc7-7ed2-469f-b690-a977e72a921d', 'openai');
    const [targetUrl, init] = upstreamSpy.mock.calls[0] as [URL, RequestInit];
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(String(targetUrl)).toContain('https://openai.internal.test/v1/responses');
    expect(headers.authorization).toBe('Bearer openai-key-live');
    expect(headers['anthropic-version']).toBeUndefined();
    upstreamSpy.mockRestore();
  });

  it('accepts native codex/openai responses bodies on /v1/proxy/v1/responses and records pinned routing', async () => {
    process.env.TOKEN_MODE_ENABLED_ORGS = '818d0cc7-7ed2-469f-b690-a977e72a921d';
    process.env.OPENAI_UPSTREAM_BASE_URL = 'https://openai.internal.test';
    vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'findActiveByHash').mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      org_id: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      scope: 'buyer_proxy',
      is_active: true,
      expires_at: null,
      preferred_provider: null
    } as any);
    vi.spyOn(runtimeModule.runtime.repos.modelCompatibility, 'findActive').mockResolvedValue({
      provider: 'openai',
      model: 'gpt-5.4',
      supports_streaming: false
    } as any);
    const listSpy = vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'listActiveForRouting').mockResolvedValue([{
      id: 'dddd0001-0000-4000-8000-000000000000',
      orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      provider: 'openai',
      authScheme: 'x_api_key',
      accessToken: 'openai-key-native',
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
    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'resp_native_ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );

    const req = createMockReq({
      method: 'POST',
      path: '/v1/proxy/v1/responses',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123456',
        'x-request-id': 'req_native_codex',
        'x-innies-provider-pin': 'true'
      },
      body: {
        model: 'gpt-5.4',
        input: 'hello from native codex',
        stream: false
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);

    expect(res.statusCode).toBe(200);
    expect((res.body as any).id).toBe('resp_native_ok');
    expect(listSpy).toHaveBeenCalledWith('818d0cc7-7ed2-469f-b690-a977e72a921d', 'openai');
    const [targetUrl, init] = upstreamSpy.mock.calls[0] as [URL, RequestInit];
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(String(targetUrl)).toBe('https://openai.internal.test/v1/responses');
    expect(headers.authorization).toBe('Bearer openai-key-native');
    expect(headers['x-request-id']).toBe('req_native_codex');
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'gpt-5.4',
      input: 'hello from native codex',
      stream: false
    });
    expect(runtimeModule.runtime.repos.routingEvents.insert).toHaveBeenCalledWith(expect.objectContaining({
      routeDecision: expect.objectContaining({
        reason: 'cli_provider_pinned',
        provider_selection_reason: 'cli_provider_pinned',
        provider_effective: 'openai',
        provider_plan: ['openai']
      })
    }));
    upstreamSpy.mockRestore();
  });

  it('accepts native anthropic message bodies on /v1/proxy/v1/messages and preserves claude-cli pinning', async () => {
    process.env.TOKEN_MODE_ENABLED_ORGS = '818d0cc7-7ed2-469f-b690-a977e72a921d';
    process.env.ANTHROPIC_UPSTREAM_BASE_URL = 'https://anthropic.internal.test';
    vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'findActiveByHash').mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      org_id: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      scope: 'buyer_proxy',
      is_active: true,
      expires_at: null,
      preferred_provider: 'openai'
    } as any);
    vi.spyOn(runtimeModule.runtime.repos.modelCompatibility, 'findActive').mockResolvedValue({
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      supports_streaming: false
    } as any);
    const listSpy = vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'listActiveForRouting').mockResolvedValue([{
      id: 'aaaa0001-0000-4000-8000-000000000000',
      orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      provider: 'anthropic',
      authScheme: 'bearer',
      accessToken: 'sk-ant-oat01-native-token',
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
    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'msg_native_ok', type: 'message' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );

    const req = createMockReq({
      method: 'POST',
      path: '/v1/proxy/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123456',
        'x-app': 'cli',
        'user-agent': 'claude-cli/1.0.0'
      },
      body: {
        model: 'claude-opus-4-6',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'hi from native claude' }],
        stream: false
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);

    expect(res.statusCode).toBe(200);
    expect((res.body as any).id).toBe('msg_native_ok');
    expect(listSpy).toHaveBeenCalledWith('818d0cc7-7ed2-469f-b690-a977e72a921d', 'anthropic');
    const [targetUrl, init] = upstreamSpy.mock.calls[0] as [URL, RequestInit];
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(String(targetUrl)).toBe('https://anthropic.internal.test/v1/messages');
    expect(headers.authorization).toBe('Bearer sk-ant-oat01-native-token');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'claude-opus-4-6',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'hi from native claude' }],
      stream: false
    });
    expect(runtimeModule.runtime.repos.routingEvents.insert).toHaveBeenCalledWith(expect.objectContaining({
      routeDecision: expect.objectContaining({
        reason: 'cli_provider_pinned',
        provider_selection_reason: 'cli_provider_pinned',
        provider_effective: 'anthropic',
        provider_plan: ['anthropic']
      })
    }));
    upstreamSpy.mockRestore();
  });

  it('routes codex oauth credentials to the ChatGPT backend with account header and store=false', async () => {
    process.env.TOKEN_MODE_ENABLED_ORGS = '818d0cc7-7ed2-469f-b690-a977e72a921d';
    const oauthToken = createFakeOpenAiOauthToken({ accountId: 'acct_codex_live' });
    vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'findActiveByHash').mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      org_id: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      scope: 'buyer_proxy',
      is_active: true,
      expires_at: null,
      preferred_provider: 'openai'
    } as any);
    vi.spyOn(runtimeModule.runtime.repos.modelCompatibility, 'findActive').mockResolvedValue({
      provider: 'openai',
      model: 'gpt-5.4',
      supports_streaming: false
    } as any);
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'listActiveForRouting').mockResolvedValue([{
      id: 'dddd1111-0000-4000-8000-000000000000',
      orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      provider: 'openai',
      authScheme: 'bearer',
      accessToken: oauthToken,
      refreshToken: 'rt_codex_live',
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
    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'resp_codex_oauth_ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );

    const req = createMockReq({
      method: 'POST',
      path: '/v1/proxy/v1/responses',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123456',
        'x-innies-provider-pin': 'true'
      },
      body: {
        provider: 'codex',
        model: 'gpt-5.4',
        streaming: false,
        payload: { model: 'gpt-5.4', input: 'hello', store: true }
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);

    expect(res.statusCode).toBe(200);
    expect((res.body as any).id).toBe('resp_codex_oauth_ok');
    const [targetUrl, init] = upstreamSpy.mock.calls[0] as [URL, RequestInit];
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(String(targetUrl)).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(headers.authorization).toBe(`Bearer ${oauthToken}`);
    expect(headers['chatgpt-account-id']).toBe('acct_codex_live');
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'gpt-5.4',
      input: 'hello',
      instructions: 'You are a helpful assistant.',
      store: false,
      stream: true
    });
    upstreamSpy.mockRestore();
  });

  it('forces stream=true for streaming codex oauth responses requests and synthesizes native Responses SSE for JSON upstream success', async () => {
    process.env.TOKEN_MODE_ENABLED_ORGS = '818d0cc7-7ed2-469f-b690-a977e72a921d';
    const oauthToken = createFakeOpenAiOauthToken({
      accountId: 'acct_codex_stream',
      clientId: 'app_codex_stream'
    });

    vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'findActiveByHash').mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      org_id: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      scope: 'buyer_proxy',
      is_active: true,
      expires_at: null,
      preferred_provider: 'openai'
    } as any);
    vi.spyOn(runtimeModule.runtime.repos.modelCompatibility, 'findActive').mockResolvedValue({
      provider: 'openai',
      model: 'gpt-5.4',
      supports_streaming: true
    } as any);
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'listActiveForRouting').mockResolvedValue([{
      id: 'dddd1112-0000-4000-8000-000000000000',
      orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      provider: 'openai',
      authScheme: 'bearer',
      accessToken: oauthToken,
      refreshToken: 'rt_codex_stream',
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
    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        id: 'resp_codex_stream_ok',
        model: 'gpt-5.4',
        status: 'completed',
        usage: { input_tokens: 5, output_tokens: 7 },
        output: [{
          type: 'message',
          id: 'msg_codex_stream_1',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'hello from codex' }],
          status: 'completed'
        }]
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );

    const req = createMockReq({
      method: 'POST',
      path: '/v1/proxy/v1/responses',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123456',
        'x-innies-provider-pin': 'true'
      },
      body: {
        model: 'gpt-5.4',
        stream: true,
        instructions: 'Reply with one word only.',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }]
      }
    });
    const res = createStreamingMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(String(res.body)).toContain('data: {"type":"response.created"');
    expect(String(res.body)).toContain('"type":"response.output_item.added"');
    expect(String(res.body)).toContain('"type":"response.output_text.delta"');
    expect(String(res.body)).toContain('"delta":"hello from codex"');
    expect(String(res.body)).toContain('"type":"response.completed"');
    expect(String(res.body)).not.toContain('event: message_start');
    const [targetUrl, init] = upstreamSpy.mock.calls[0] as [URL, RequestInit];
    expect(String(targetUrl)).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'gpt-5.4',
      instructions: 'Reply with one word only.',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      store: false,
      stream: true
    });
    upstreamSpy.mockRestore();
  });

  it('passes through mislabelled upstream SSE bodies for native codex responses requests', async () => {
    process.env.TOKEN_MODE_ENABLED_ORGS = '818d0cc7-7ed2-469f-b690-a977e72a921d';
    const oauthToken = createFakeOpenAiOauthToken({
      accountId: 'acct_codex_stream',
      clientId: 'app_codex_stream'
    });

    vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'findActiveByHash').mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      org_id: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      scope: 'buyer_proxy',
      is_active: true,
      expires_at: null,
      preferred_provider: 'openai'
    } as any);
    vi.spyOn(runtimeModule.runtime.repos.modelCompatibility, 'findActive').mockResolvedValue({
      provider: 'openai',
      model: 'gpt-5.4',
      supports_streaming: true
    } as any);
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'listActiveForRouting').mockResolvedValue([{
      id: 'dddd1113-0000-4000-8000-000000000000',
      orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      provider: 'openai',
      authScheme: 'bearer',
      accessToken: oauthToken,
      refreshToken: 'rt_codex_stream',
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

    const upstreamSse = [
      'data: {"type":"response.created","response":{"id":"resp_upstream_1","status":"in_progress","usage":{"input_tokens":0,"output_tokens":0}}}\n\n',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_upstream_1","role":"assistant","content":[],"status":"in_progress"}}\n\n',
      'data: {"type":"response.output_text.delta","output_index":0,"item_id":"msg_upstream_1","content_index":0,"delta":"hello"}\n\n',
      'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_upstream_1","role":"assistant","content":[{"type":"output_text","text":"hello"}],"status":"completed"}}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_upstream_1","status":"completed","usage":{"input_tokens":5,"output_tokens":7}}}\n\n',
      'data: [DONE]\n\n'
    ].join('');
    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(upstreamSse, {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );

    const req = createMockReq({
      method: 'POST',
      path: '/v1/proxy/v1/responses',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123456',
        'x-innies-provider-pin': 'true'
      },
      body: {
        model: 'gpt-5.4',
        stream: true,
        instructions: 'Reply with one word only.',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }]
      }
    });
    const res = createStreamingMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(String(res.body)).toContain('data: {"type":"response.created"');
    expect(String(res.body)).toContain('"delta":"hello"');
    expect(String(res.body)).toContain('"type":"response.completed"');
    expect(String(res.body)).not.toContain(': keepalive');
    upstreamSpy.mockRestore();
  });

  it('translates mislabelled upstream codex SSE bodies into anthropic SSE for compat streaming requests', async () => {
    process.env.TOKEN_MODE_ENABLED_ORGS = '818d0cc7-7ed2-469f-b690-a977e72a921d';
    const oauthToken = createFakeOpenAiOauthToken({
      accountId: 'acct_codex_stream_compat',
      clientId: 'app_codex_stream_compat'
    });

    vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'findActiveByHash').mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      org_id: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      scope: 'buyer_proxy',
      is_active: true,
      expires_at: null,
      preferred_provider: 'openai'
    } as any);
    vi.spyOn(runtimeModule.runtime.repos.modelCompatibility, 'findActive').mockImplementation(async (provider: string, model: string) => {
      if (provider === 'openai' && model === 'gpt-5.4') {
        return { provider: 'openai', model: 'gpt-5.4', supports_streaming: true } as any;
      }
      if (provider === 'anthropic' && model === 'claude-opus-4-6') {
        return { provider: 'anthropic', model: 'claude-opus-4-6', supports_streaming: true } as any;
      }
      return null as any;
    });
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'listActiveForRouting').mockImplementation(async (_orgId: string, provider: string) => {
      if (provider !== 'openai') return [];
      return [{
        id: 'dddd1113-compat-0000-4000-8000-000000000000',
        orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
        provider: 'openai',
        authScheme: 'bearer',
        accessToken: oauthToken,
        refreshToken: 'rt_codex_stream_compat',
        expiresAt: new Date('2026-03-02T00:00:00Z'),
        status: 'active',
        rotationVersion: 1,
        createdAt: new Date('2026-03-01T00:00:00Z'),
        updatedAt: new Date('2026-03-01T00:00:00Z'),
        revokedAt: null,
        monthlyContributionLimitUnits: null,
        monthlyContributionUsedUnits: 0,
        monthlyWindowStartAt: new Date('2026-03-01T00:00:00Z')
      } as any];
    });

    const streamLatencySpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const upstreamSse = [
      'data: {"type":"response.created","response":{"id":"resp_compat_mislabelled_proxy","status":"in_progress","usage":{"input_tokens":0,"output_tokens":0}}}\n\n',
      'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_compat_mislabelled_proxy","role":"assistant","content":[{"type":"output_text","text":"working on it"}],"status":"completed"}}\n\n',
      'data: {"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","id":"fc_compat_mislabelled_proxy","call_id":"call_compat_mislabelled_proxy","name":"lookup_repo","arguments":"{\\"name\\":\\"innies\\"}","status":"completed"}}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_compat_mislabelled_proxy","status":"completed","usage":{"input_tokens":5,"output_tokens":7}}}\n\n',
      'data: [DONE]\n\n'
    ].join('');
    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(upstreamSse, {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );

    const req = createMockReq({
      method: 'POST',
      path: '/v1/proxy/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123456',
        'anthropic-version': '2023-06-01'
      },
      body: {
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        streaming: true,
        payload: {
          model: 'claude-opus-4-6',
          stream: true,
          max_tokens: 64,
          tools: [{ name: 'lookup_repo', description: 'lookup repo', input_schema: { type: 'object', properties: { name: { type: 'string' } } } }],
          tool_choice: { type: 'tool', name: 'lookup_repo' },
          messages: [{ role: 'user', content: 'hi' }]
        }
      }
    });
    (req as any).inniesCompatMode = true;
    const res = createStreamingMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(String(res.body)).toContain('"type":"text_delta","text":"working on it"');
    expect(String(res.body)).toContain('"type":"tool_use","id":"call_compat_mislabelled_proxy","name":"lookup_repo"');
    expect(String(res.body)).toContain('"type":"input_json_delta","partial_json":"{\\"name\\":\\"innies\\"}"');

    const routeDecision = (runtimeModule.runtime.repos.routingEvents.insert as any).mock.calls.at(-1)?.[0]?.routeDecision;
    expect(routeDecision?.translated).toBe(true);
    expect(routeDecision?.translated_path).toBe('/v1/responses');
    expect(routeDecision?.provider_preferred).toBe('openai');
    expect(routeDecision?.provider_effective).toBe('openai');

    const latencyCalls = streamLatencySpy.mock.calls.filter((call) => call[0] === '[stream-latency]');
    expect(latencyCalls.length).toBeGreaterThan(0);
    const lastLatency = latencyCalls[latencyCalls.length - 1]?.[1] as any;
    expect(lastLatency?.stream_mode).toBe('synthetic_bridge');
    expect(lastLatency?.synthetic_content_block_count).toBe(2);
    expect(lastLatency?.synthetic_content_block_types).toBe('text,tool_use');

    upstreamSpy.mockRestore();
    streamLatencySpy.mockRestore();
  });

  it('falls back to anthropic when translated openai compat non-stream responses report response.failed inside a 200 SSE body', async () => {
    process.env.TOKEN_MODE_ENABLED_ORGS = '818d0cc7-7ed2-469f-b690-a977e72a921d';
    process.env.COMPAT_CODEX_DEFAULT_MODEL = 'gpt-5.4';
    const oauthToken = createFakeOpenAiOauthToken({
      accountId: 'acct_codex_failed_fallback',
      clientId: 'app_codex_failed_fallback'
    });

    vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'findActiveByHash').mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      org_id: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      scope: 'buyer_proxy',
      is_active: true,
      expires_at: null,
      preferred_provider: 'openai'
    } as any);
    vi.spyOn(runtimeModule.runtime.repos.modelCompatibility, 'findActive').mockImplementation(async (provider: string, model: string) => {
      if (provider === 'openai' && model === 'gpt-5.4') {
        return { provider: 'openai', model: 'gpt-5.4', supports_streaming: false } as any;
      }
      if (provider === 'anthropic' && model === 'claude-opus-4-6') {
        return { provider: 'anthropic', model: 'claude-opus-4-6', supports_streaming: false } as any;
      }
      return null as any;
    });
    const listSpy = vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'listActiveForRouting').mockImplementation(async (_orgId: string, provider: string) => {
      if (provider === 'openai') {
        return [{
          id: 'failed-openai-cred-nonstream',
          orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
          provider: 'openai',
          authScheme: 'bearer',
          accessToken: oauthToken,
          refreshToken: 'rt_failed_fallback',
          expiresAt: new Date('2026-03-02T00:00:00Z'),
          status: 'active',
          rotationVersion: 1,
          createdAt: new Date('2026-03-01T00:00:00Z'),
          updatedAt: new Date('2026-03-01T00:00:00Z'),
          revokedAt: null,
          monthlyContributionLimitUnits: null,
          monthlyContributionUsedUnits: 0,
          monthlyWindowStartAt: new Date('2026-03-01T00:00:00Z')
        } as any];
      }
      if (provider === 'anthropic') {
        return [{
          id: 'fallback-anthropic-cred-nonstream',
          orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
          provider: 'anthropic',
          authScheme: 'bearer',
          accessToken: 'sk-ant-oat01-fallback-nonstream',
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
        } as any];
      }
      return [];
    });

    const upstreamSse = [
      'data: {"type":"response.created","response":{"id":"resp_failed_fallback_1","status":"in_progress"}}\n\n',
      'data: {"type":"response.failed","response":{"id":"resp_failed_fallback_1","status":"failed","error":{"message":"upstream boom"}}}\n\n',
      'data: [DONE]\n\n'
    ].join('');
    const upstreamSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(upstreamSse, {
        status: 200,
        headers: { 'content-type': 'application/json' }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'msg_failed_fallback_ok',
        usage: { input_tokens: 2, output_tokens: 3 },
        content: [{ type: 'text', text: 'fallback ok' }]
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      }));

    const req = createMockReq({
      method: 'POST',
      path: '/v1/proxy/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123456',
        'anthropic-version': '2023-06-01'
      },
      body: {
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        streaming: false,
        payload: {
          model: 'claude-opus-4-6',
          max_tokens: 32,
          messages: [{ role: 'user', content: 'hi' }]
        }
      }
    });
    (req as any).inniesCompatMode = true;
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);

    expect(res.statusCode).toBe(200);
    expect((res.body as any).id).toBe('msg_failed_fallback_ok');
    expect(listSpy.mock.calls.map((call) => call[1])).toEqual(['openai', 'anthropic']);
    expect(upstreamSpy).toHaveBeenCalledTimes(2);
    expect(runtimeModule.runtime.repos.tokenCredentials.recordSuccess).toHaveBeenCalledTimes(1);
    expect(runtimeModule.runtime.repos.tokenCredentials.recordSuccess).toHaveBeenCalledWith('fallback-anthropic-cred-nonstream');
    expect(runtimeModule.runtime.services.metering.recordUsage).toHaveBeenCalledTimes(1);
    expect(runtimeModule.runtime.repos.tokenCredentials.addMonthlyContributionUsage).toHaveBeenCalledTimes(1);
    const routingCalls = (runtimeModule.runtime.repos.routingEvents.insert as any).mock.calls.map((call: any[]) => call[0]);
    expect(routingCalls[0]).toEqual(expect.objectContaining({
      errorCode: 'upstream_failed_stream',
      upstreamStatus: 500
    }));
    const routeDecision = routingCalls.at(-1)?.routeDecision;
    expect(routeDecision?.provider_preferred).toBe('openai');
    expect(routeDecision?.provider_effective).toBe('anthropic');
    expect(routeDecision?.provider_fallback_from).toBe('openai');
    expect(routeDecision?.provider_fallback_reason).toBe('capacity_unavailable');

    upstreamSpy.mockRestore();
    delete process.env.COMPAT_CODEX_DEFAULT_MODEL;
  });

  it('falls back to anthropic streaming when translated openai compat responses report response.failed inside a 200 SSE body', async () => {
    process.env.TOKEN_MODE_ENABLED_ORGS = '818d0cc7-7ed2-469f-b690-a977e72a921d';
    process.env.COMPAT_CODEX_DEFAULT_MODEL = 'gpt-5.4';
    const oauthToken = createFakeOpenAiOauthToken({
      accountId: 'acct_codex_failed_stream_fallback',
      clientId: 'app_codex_failed_stream_fallback'
    });

    vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'findActiveByHash').mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      org_id: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      scope: 'buyer_proxy',
      is_active: true,
      expires_at: null,
      preferred_provider: 'openai'
    } as any);
    vi.spyOn(runtimeModule.runtime.repos.modelCompatibility, 'findActive').mockImplementation(async (provider: string, model: string) => {
      if (provider === 'openai' && model === 'gpt-5.4') {
        return { provider: 'openai', model: 'gpt-5.4', supports_streaming: true } as any;
      }
      if (provider === 'anthropic' && model === 'claude-opus-4-6') {
        return { provider: 'anthropic', model: 'claude-opus-4-6', supports_streaming: true } as any;
      }
      return null as any;
    });
    const listSpy = vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'listActiveForRouting').mockImplementation(async (_orgId: string, provider: string) => {
      if (provider === 'openai') {
        return [{
          id: 'failed-openai-cred-stream',
          orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
          provider: 'openai',
          authScheme: 'bearer',
          accessToken: oauthToken,
          refreshToken: 'rt_failed_stream_fallback',
          expiresAt: new Date('2026-03-02T00:00:00Z'),
          status: 'active',
          rotationVersion: 1,
          createdAt: new Date('2026-03-01T00:00:00Z'),
          updatedAt: new Date('2026-03-01T00:00:00Z'),
          revokedAt: null,
          monthlyContributionLimitUnits: null,
          monthlyContributionUsedUnits: 0,
          monthlyWindowStartAt: new Date('2026-03-01T00:00:00Z')
        } as any];
      }
      if (provider === 'anthropic') {
        return [{
          id: 'fallback-anthropic-cred-stream',
          orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
          provider: 'anthropic',
          authScheme: 'bearer',
          accessToken: 'sk-ant-oat01-fallback-stream',
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
        } as any];
      }
      return [];
    });

    const upstreamSse = [
      'data: {"type":"response.created","response":{"id":"resp_failed_fallback_stream","status":"in_progress"}}\n\n',
      'data: {"type":"response.failed","response":{"id":"resp_failed_fallback_stream","status":"failed","error":{"message":"upstream boom"}}}\n\n',
      'data: [DONE]\n\n'
    ].join('');
    const upstreamSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(upstreamSse, {
        status: 200,
        headers: { 'content-type': 'application/json' }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'msg_failed_stream_fallback_ok',
        usage: { input_tokens: 2, output_tokens: 3 },
        content: [{ type: 'text', text: 'fallback stream ok' }]
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      }));

    const req = createMockReq({
      method: 'POST',
      path: '/v1/proxy/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123456',
        'anthropic-version': '2023-06-01'
      },
      body: {
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        streaming: true,
        payload: {
          model: 'claude-opus-4-6',
          stream: true,
          max_tokens: 32,
          messages: [{ role: 'user', content: 'hi' }]
        }
      }
    });
    (req as any).inniesCompatMode = true;
    const res = createStreamingMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(String(res.body)).toContain('event: content_block_delta');
    expect(String(res.body)).toContain('"text":"fallback stream ok"');
    expect(listSpy.mock.calls.map((call) => call[1])).toEqual(['openai', 'anthropic']);
    expect(upstreamSpy).toHaveBeenCalledTimes(2);
    expect(runtimeModule.runtime.repos.tokenCredentials.recordSuccess).toHaveBeenCalledTimes(1);
    expect(runtimeModule.runtime.repos.tokenCredentials.recordSuccess).toHaveBeenCalledWith('fallback-anthropic-cred-stream');
    expect(runtimeModule.runtime.services.metering.recordUsage).toHaveBeenCalledTimes(1);
    const routeDecision = (runtimeModule.runtime.repos.routingEvents.insert as any).mock.calls.at(-1)?.[0]?.routeDecision;
    expect(routeDecision?.provider_preferred).toBe('openai');
    expect(routeDecision?.provider_effective).toBe('anthropic');
    expect(routeDecision?.provider_fallback_from).toBe('openai');
    expect(routeDecision?.provider_fallback_reason).toBe('capacity_unavailable');

    upstreamSpy.mockRestore();
    delete process.env.COMPAT_CODEX_DEFAULT_MODEL;
  });

  it('terminates codex passthrough streams with response.failed when upstream SSE drops before completion', async () => {
    process.env.TOKEN_MODE_ENABLED_ORGS = '818d0cc7-7ed2-469f-b690-a977e72a921d';
    const oauthToken = createFakeOpenAiOauthToken({
      accountId: 'acct_codex_stream',
      clientId: 'app_codex_stream'
    });

    vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'findActiveByHash').mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      org_id: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      scope: 'buyer_proxy',
      is_active: true,
      expires_at: null,
      preferred_provider: 'openai'
    } as any);
    vi.spyOn(runtimeModule.runtime.repos.modelCompatibility, 'findActive').mockResolvedValue({
      provider: 'openai',
      model: 'gpt-5.4',
      supports_streaming: true
    } as any);
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'listActiveForRouting').mockResolvedValue([{
      id: 'dddd1114-0000-4000-8000-000000000000',
      orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      provider: 'openai',
      authScheme: 'bearer',
      accessToken: oauthToken,
      refreshToken: 'rt_codex_stream',
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

    const encoder = new TextEncoder();
    const upstreamStream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"response.created","response":{"id":"resp_drop_1","status":"in_progress","usage":{"input_tokens":0,"output_tokens":0}}}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_drop_1","role":"assistant","content":[],"status":"in_progress"}}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","output_index":0,"item_id":"msg_drop_1","content_index":0,"delta":"partial"}\n\n'));
        controller.error(new Error('upstream reset'));
      }
    });
    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(upstreamStream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' }
      })
    );

    const req = createMockReq({
      method: 'POST',
      path: '/v1/proxy/v1/responses',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123456',
        'x-innies-provider-pin': 'true'
      },
      body: {
        model: 'gpt-5.4',
        stream: true,
        instructions: 'Reply with one word only.',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }]
      }
    });
    const res = createRealWritableStreamingMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);

    expect(res.statusCode).toBe(200);
    expect(String(res.body)).toContain('"type":"response.failed"');
    expect(String(res.body)).toContain('data: [DONE]');
    expect(res.writableEnded).toBe(true);
    expect(runtimeModule.runtime.repos.tokenCredentials.recordSuccess).not.toHaveBeenCalled();
    expect(runtimeModule.runtime.services.metering.recordUsage).not.toHaveBeenCalled();
    expect(runtimeModule.runtime.repos.tokenCredentials.addMonthlyContributionUsage).not.toHaveBeenCalled();
    expect(runtimeModule.runtime.repos.routingEvents.insert).toHaveBeenLastCalledWith(expect.objectContaining({
      errorCode: 'stream_truncated',
      upstreamStatus: 200
    }));
    upstreamSpy.mockRestore();
  });

  it('terminates anthropic passthrough streams with anthropic SSE when upstream SSE drops before completion', async () => {
    process.env.TOKEN_MODE_ENABLED_ORGS = '818d0cc7-7ed2-469f-b690-a977e72a921d';
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'listActiveForRouting').mockResolvedValue([{
      id: 'dddd1115-0000-4000-8000-000000000000',
      orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      provider: 'anthropic',
      authScheme: 'x_api_key',
      accessToken: 'sk-ant-oat01-stream-drop',
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

    const encoder = new TextEncoder();
    const upstreamStream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_drop_2","type":"message","role":"assistant","model":"claude-3-5-sonnet-latest","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0}}}\n\n'));
        controller.enqueue(encoder.encode('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n'));
        controller.error(new Error('upstream reset'));
      }
    });
    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(upstreamStream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' }
      })
    );

    const req = createMockReq({
      method: 'POST',
      path: '/v1/proxy/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123456',
        'anthropic-version': '2023-06-01'
      },
      body: {
        model: 'claude-3-5-sonnet-latest',
        stream: true,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hello' }]
      }
    });
    const res = createRealWritableStreamingMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);

    expect(res.statusCode).toBe(200);
    expect(String(res.body)).toContain('event: message_stop');
    expect(String(res.body)).toContain('[Innies stream error: upstream stream ended before completion]');
    expect(String(res.body)).not.toContain('"type":"response.failed"');
    expect(runtimeModule.runtime.repos.tokenCredentials.recordSuccess).not.toHaveBeenCalled();
    expect(runtimeModule.runtime.services.metering.recordUsage).not.toHaveBeenCalled();
    expect(runtimeModule.runtime.repos.tokenCredentials.addMonthlyContributionUsage).not.toHaveBeenCalled();
    expect(runtimeModule.runtime.repos.routingEvents.insert).toHaveBeenLastCalledWith(expect.objectContaining({
      errorCode: 'stream_truncated',
      upstreamStatus: 200
    }));
    upstreamSpy.mockRestore();
  });

  it('does not meter or hang when the downstream client disconnects while backpressured', async () => {
    process.env.TOKEN_MODE_ENABLED_ORGS = '818d0cc7-7ed2-469f-b690-a977e72a921d';
    const oauthToken = createFakeOpenAiOauthToken({
      accountId: 'acct_codex_backpressure',
      clientId: 'app_codex_backpressure'
    });

    vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'findActiveByHash').mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      org_id: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      scope: 'buyer_proxy',
      is_active: true,
      expires_at: null,
      preferred_provider: 'openai'
    } as any);
    vi.spyOn(runtimeModule.runtime.repos.modelCompatibility, 'findActive').mockResolvedValue({
      provider: 'openai',
      model: 'gpt-5.4',
      supports_streaming: true
    } as any);
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'listActiveForRouting').mockResolvedValue([{
      id: 'dddd1116-0000-4000-8000-000000000000',
      orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      provider: 'openai',
      authScheme: 'bearer',
      accessToken: oauthToken,
      refreshToken: 'rt_codex_backpressure',
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

    const encoder = new TextEncoder();
    const upstreamStream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"response.created","response":{"id":"resp_backpressure_1","status":"in_progress","usage":{"input_tokens":0,"output_tokens":0}}}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","output_index":0,"item_id":"msg_backpressure_1","content_index":0,"delta":"partial"}\n\n'));
        controller.close();
      }
    });
    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(upstreamStream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' }
      })
    );

    const req = createMockReq({
      method: 'POST',
      path: '/v1/proxy/v1/responses',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123456',
        'x-innies-provider-pin': 'true'
      },
      body: {
        model: 'gpt-5.4',
        stream: true,
        instructions: 'Reply with one word only.',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }]
      }
    });
    const res = createBackpressuredClosingStreamingMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);

    expect(res.destroyed).toBe(true);
    expect(String(res.body)).not.toContain('"type":"response.failed"');
    expect(runtimeModule.runtime.repos.tokenCredentials.recordSuccess).not.toHaveBeenCalled();
    expect(runtimeModule.runtime.services.metering.recordUsage).not.toHaveBeenCalled();
    expect(runtimeModule.runtime.repos.tokenCredentials.addMonthlyContributionUsage).not.toHaveBeenCalled();
    expect(runtimeModule.runtime.services.idempotency.commit).not.toHaveBeenCalled();
    expect(runtimeModule.runtime.repos.routingEvents.insert).toHaveBeenLastCalledWith(expect.objectContaining({
      errorCode: 'stream_truncated',
      upstreamStatus: 200
    }));
    upstreamSpy.mockRestore();
  }, 1000);

  it('refreshes codex oauth credentials against auth.openai.com before failing over', async () => {
    process.env.TOKEN_MODE_ENABLED_ORGS = '818d0cc7-7ed2-469f-b690-a977e72a921d';
    const firstToken = createFakeOpenAiOauthToken({
      accountId: 'acct_codex_refresh',
      clientId: 'app_refresh_client'
    });
    const secondToken = createFakeOpenAiOauthToken({
      accountId: 'acct_codex_refresh',
      clientId: 'app_refresh_client',
      exp: Math.floor(Date.now() / 1000) + 7200
    });

    vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'findActiveByHash').mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      org_id: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      scope: 'buyer_proxy',
      is_active: true,
      expires_at: null,
      preferred_provider: 'openai'
    } as any);
    vi.spyOn(runtimeModule.runtime.repos.modelCompatibility, 'findActive').mockResolvedValue({
      provider: 'openai',
      model: 'gpt-5.4',
      supports_streaming: false
    } as any);
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'listActiveForRouting').mockResolvedValue([{
      id: 'dddd2222-0000-4000-8000-000000000000',
      orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      provider: 'openai',
      authScheme: 'bearer',
      accessToken: firstToken,
      refreshToken: 'rt_codex_old',
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
    const refreshInPlaceSpy = vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'refreshInPlace').mockResolvedValue({
      id: 'dddd2222-0000-4000-8000-000000000000',
      orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      provider: 'openai',
      authScheme: 'bearer',
      accessToken: secondToken,
      refreshToken: 'rt_codex_new',
      expiresAt: new Date('2026-03-03T00:00:00Z'),
      status: 'active',
      rotationVersion: 1,
      createdAt: new Date('2026-03-01T00:00:00Z'),
      updatedAt: new Date('2026-03-01T00:00:00Z'),
      revokedAt: null,
      monthlyContributionLimitUnits: null,
      monthlyContributionUsedUnits: 0,
      monthlyWindowStartAt: new Date('2026-03-01T00:00:00Z')
    } as any);

    let upstreamAttempts = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://chatgpt.com/backend-api/codex/responses') {
        upstreamAttempts += 1;
        if (upstreamAttempts === 1) {
          return new Response(JSON.stringify({ error: { message: 'expired' } }), {
            status: 401,
            headers: { 'content-type': 'application/json' }
          });
        }
        return new Response(JSON.stringify({ id: 'resp_codex_refresh_ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url === 'https://auth.openai.com/oauth/token') {
        expect(String(init?.body)).toContain('grant_type=refresh_token');
        expect(String(init?.body)).toContain('client_id=app_refresh_client');
        expect(String(init?.body)).toContain('refresh_token=rt_codex_old');
        return new Response(JSON.stringify({
          access_token: secondToken,
          refresh_token: 'rt_codex_new',
          expires_in: 3600
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`unexpected fetch target: ${url}`);
    });

    const req = createMockReq({
      method: 'POST',
      path: '/v1/proxy/v1/responses',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123456'
      },
      body: {
        provider: 'codex',
        model: 'gpt-5.4',
        streaming: false,
        payload: { model: 'gpt-5.4', input: 'hello' }
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);

    expect(res.statusCode).toBe(200);
    expect((res.body as any).id).toBe('resp_codex_refresh_ok');
    expect(refreshInPlaceSpy).toHaveBeenCalledWith(expect.objectContaining({
      id: 'dddd2222-0000-4000-8000-000000000000',
      accessToken: secondToken,
      refreshToken: 'rt_codex_new'
    }));
    const secondUpstreamCall = fetchSpy.mock.calls.filter(([target]) => String(target) === 'https://chatgpt.com/backend-api/codex/responses')[1];
    const secondHeaders = (secondUpstreamCall?.[1]?.headers ?? {}) as Record<string, string>;
    expect(secondHeaders.authorization).toBe(`Bearer ${secondToken}`);
    fetchSpy.mockRestore();
  });

  it('translates compat anthropic requests onto openai responses when buyer preference is openai', async () => {
    process.env.TOKEN_MODE_ENABLED_ORGS = '818d0cc7-7ed2-469f-b690-a977e72a921d';
    process.env.OPENAI_UPSTREAM_BASE_URL = 'https://openai.internal.test';
    process.env.COMPAT_CODEX_DEFAULT_MODEL = 'gpt-5.4';
    vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'findActiveByHash').mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      org_id: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      scope: 'buyer_proxy',
      is_active: true,
      expires_at: null,
      preferred_provider: 'openai'
    } as any);
    vi.spyOn(runtimeModule.runtime.repos.modelCompatibility, 'findActive').mockImplementation(async (provider: string, model: string) => {
      if (provider === 'openai' && model === 'gpt-5.4') {
        return { provider: 'openai', model: 'gpt-5.4', supports_streaming: false } as any;
      }
      if (provider === 'anthropic' && model === 'claude-opus-4-6') {
        return { provider: 'anthropic', model: 'claude-opus-4-6', supports_streaming: false } as any;
      }
      return null as any;
    });
    const listSpy = vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'listActiveForRouting').mockImplementation(async (_orgId: string, provider: string) => {
      if (provider !== 'openai') return [];
      return [{
        id: 'dddd3333-0000-4000-8000-000000000000',
        orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
        provider: 'openai',
        authScheme: 'bearer',
        accessToken: 'openai-key-translated',
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
      } as any];
    });
    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        id: 'resp_translated_ok',
        status: 'incomplete',
        usage: { input_tokens: 5, output_tokens: 7 },
        output: [
          {
            type: 'message',
            id: 'msg_1',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'working on it' }]
          },
          {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'lookup_repo',
            arguments: '{\"name\":\"innies\"}'
          }
        ]
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );

    const req = createMockReq({
      method: 'POST',
      path: '/v1/proxy/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123456',
        'anthropic-version': '2023-06-01'
      },
      body: {
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        streaming: false,
        payload: {
          model: 'claude-opus-4-6',
          max_tokens: 64,
          tools: [{ name: 'lookup_repo', description: 'lookup repo', input_schema: { type: 'object', properties: { name: { type: 'string' } } } }],
          tool_choice: { type: 'tool', name: 'lookup_repo' },
          messages: [{ role: 'user', content: 'hi' }]
        }
      }
    });
    (req as any).inniesCompatMode = true;
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);

    expect(res.statusCode).toBe(200);
    expect((res.body as any).id).toBe('resp_translated_ok');
    expect((res.body as any).content).toEqual([
      { type: 'text', text: 'working on it' },
      { type: 'tool_use', id: 'call_1', name: 'lookup_repo', input: { name: 'innies' } }
    ]);
    expect((res.body as any).stop_reason).toBe('tool_use');
    expect(listSpy.mock.calls.map((call) => call[1])).toEqual(['openai']);

    const [targetUrl, init] = upstreamSpy.mock.calls[0] as [URL, RequestInit];
    expect(String(targetUrl)).toBe('https://openai.internal.test/v1/responses');
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'gpt-5.4',
      input: [{ type: 'message', role: 'user', content: 'hi' }],
      tools: [{ type: 'function', name: 'lookup_repo' }],
      tool_choice: { type: 'function', name: 'lookup_repo' },
      instructions: 'You are a helpful assistant.'
    });

    const routeDecision = (runtimeModule.runtime.repos.routingEvents.insert as any).mock.calls[0]?.[0]?.routeDecision;
    expect(routeDecision?.translated).toBe(true);
    expect(routeDecision?.original_provider).toBe('anthropic');
    expect(routeDecision?.translated_path).toBe('/v1/responses');
    expect(routeDecision?.provider_preferred).toBe('openai');
    expect(routeDecision?.provider_effective).toBe('openai');
    upstreamSpy.mockRestore();
    delete process.env.COMPAT_CODEX_DEFAULT_MODEL;
  });

  it('strips translated token-limit params for openai oauth compat requests', async () => {
    process.env.TOKEN_MODE_ENABLED_ORGS = '818d0cc7-7ed2-469f-b690-a977e72a921d';
    process.env.COMPAT_CODEX_DEFAULT_MODEL = 'gpt-5.4';
    const oauthToken = createFakeOpenAiOauthToken({
      accountId: 'acct_codex_compat',
      clientId: 'app_codex_compat'
    });

    vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'findActiveByHash').mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      org_id: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      scope: 'buyer_proxy',
      is_active: true,
      expires_at: null,
      preferred_provider: 'openai'
    } as any);
    vi.spyOn(runtimeModule.runtime.repos.modelCompatibility, 'findActive').mockImplementation(async (provider: string, model: string) => {
      if (provider === 'openai' && model === 'gpt-5.4') {
        return { provider: 'openai', model: 'gpt-5.4', supports_streaming: false } as any;
      }
      if (provider === 'anthropic' && model === 'claude-opus-4-6') {
        return { provider: 'anthropic', model: 'claude-opus-4-6', supports_streaming: false } as any;
      }
      return null as any;
    });
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'listActiveForRouting').mockImplementation(async (_orgId: string, provider: string) => {
      if (provider !== 'openai') return [];
      return [{
        id: 'dddd3334-0000-4000-8000-000000000000',
        orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
        provider: 'openai',
        authScheme: 'bearer',
        accessToken: oauthToken,
        refreshToken: 'rt_codex_compat',
        expiresAt: new Date('2026-03-02T00:00:00Z'),
        status: 'active',
        rotationVersion: 1,
        createdAt: new Date('2026-03-01T00:00:00Z'),
        updatedAt: new Date('2026-03-01T00:00:00Z'),
        revokedAt: null,
        monthlyContributionLimitUnits: null,
        monthlyContributionUsedUnits: 0,
        monthlyWindowStartAt: new Date('2026-03-01T00:00:00Z')
      } as any];
    });

    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        id: 'resp_translated_oauth_ok',
        status: 'completed',
        usage: { input_tokens: 2, output_tokens: 3 },
        output: [{ type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }]
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );

    const req = createMockReq({
      method: 'POST',
      path: '/v1/proxy/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123456',
        'anthropic-version': '2023-06-01'
      },
      body: {
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        streaming: false,
        payload: {
          model: 'claude-opus-4-6',
          max_tokens: 64,
          tools: [{ name: 'lookup_repo', description: 'lookup repo', input_schema: { type: 'object', properties: { name: { type: 'string' } } } }],
          tool_choice: { type: 'tool', name: 'lookup_repo' },
          messages: [{ role: 'user', content: 'hi' }]
        }
      }
    });
    (req as any).inniesCompatMode = true;
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);

    expect(res.statusCode).toBe(200);
    const [targetUrl, init] = upstreamSpy.mock.calls[0] as [URL, RequestInit];
    expect(String(targetUrl)).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'gpt-5.4',
      store: false,
      instructions: 'You are a helpful assistant.',
      stream: true,
      tools: [{
        type: 'function',
        name: 'lookup_repo',
        description: 'lookup repo',
        parameters: { type: 'object', properties: { name: { type: 'string' } } }
      }],
      tool_choice: {
        type: 'function',
        name: 'lookup_repo'
      }
    });
    expect(JSON.parse(String(init.body)).max_tokens).toBeUndefined();
    expect(JSON.parse(String(init.body)).max_output_tokens).toBeUndefined();

    upstreamSpy.mockRestore();
    delete process.env.COMPAT_CODEX_DEFAULT_MODEL;
  });

  it('buffers codex oauth SSE success back into anthropic JSON for non-stream compat requests', async () => {
    process.env.TOKEN_MODE_ENABLED_ORGS = '818d0cc7-7ed2-469f-b690-a977e72a921d';
    process.env.COMPAT_CODEX_DEFAULT_MODEL = 'gpt-5.4';
    const oauthToken = createFakeOpenAiOauthToken({
      accountId: 'acct_codex_compat_sse',
      clientId: 'app_codex_compat_sse'
    });

    vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'findActiveByHash').mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      org_id: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      scope: 'buyer_proxy',
      is_active: true,
      expires_at: null,
      preferred_provider: 'openai'
    } as any);
    vi.spyOn(runtimeModule.runtime.repos.modelCompatibility, 'findActive').mockImplementation(async (provider: string, model: string) => {
      if (provider === 'openai' && model === 'gpt-5.4') {
        return { provider: 'openai', model: 'gpt-5.4', supports_streaming: true } as any;
      }
      if (provider === 'anthropic' && model === 'claude-opus-4-6') {
        return { provider: 'anthropic', model: 'claude-opus-4-6', supports_streaming: false } as any;
      }
      return null as any;
    });
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'listActiveForRouting').mockImplementation(async (_orgId: string, provider: string) => {
      if (provider !== 'openai') return [];
      return [{
        id: 'dddd3336-0000-4000-8000-000000000000',
        orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
        provider: 'openai',
        authScheme: 'bearer',
        accessToken: oauthToken,
        refreshToken: 'rt_codex_compat_sse',
        expiresAt: new Date('2026-03-02T00:00:00Z'),
        status: 'active',
        rotationVersion: 1,
        createdAt: new Date('2026-03-01T00:00:00Z'),
        updatedAt: new Date('2026-03-01T00:00:00Z'),
        revokedAt: null,
        monthlyContributionLimitUnits: null,
        monthlyContributionUsedUnits: 0,
        monthlyWindowStartAt: new Date('2026-03-01T00:00:00Z')
      } as any];
    });

    const upstreamSse = [
      'data: {"type":"response.created","response":{"id":"resp_compat_sse_1","model":"gpt-5.4","status":"in_progress"}}\n\n',
      'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_compat_sse_1","role":"assistant","content":[{"type":"output_text","text":"working on it"}],"status":"completed"}}\n\n',
      'data: {"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","id":"fc_compat_sse_1","call_id":"call_compat_sse_1","name":"lookup_repo","arguments":"{\\"name\\":\\"innies\\"}","status":"completed"}}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_compat_sse_1","status":"completed","usage":{"input_tokens":5,"output_tokens":7}}}\n\n',
      'data: [DONE]\n\n'
    ].join('');
    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(upstreamSse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' }
      })
    );

    const req = createMockReq({
      method: 'POST',
      path: '/v1/proxy/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123456',
        'anthropic-version': '2023-06-01'
      },
      body: {
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        streaming: false,
        payload: {
          model: 'claude-opus-4-6',
          max_tokens: 64,
          tools: [{ name: 'lookup_repo', description: 'lookup repo', input_schema: { type: 'object', properties: { name: { type: 'string' } } } }],
          tool_choice: { type: 'tool', name: 'lookup_repo' },
          messages: [{ role: 'user', content: 'hi' }]
        }
      }
    });
    (req as any).inniesCompatMode = true;
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);

    expect(res.statusCode).toBe(200);
    expect((res.body as any).id).toBe('resp_compat_sse_1');
    expect((res.body as any).content).toEqual([
      { type: 'text', text: 'working on it' },
      { type: 'tool_use', id: 'call_compat_sse_1', name: 'lookup_repo', input: { name: 'innies' } }
    ]);
    expect((res.body as any).stop_reason).toBe('tool_use');
    expect((res.body as any).usage).toEqual({ input_tokens: 5, output_tokens: 7 });

    const [targetUrl, init] = upstreamSpy.mock.calls[0] as [URL, RequestInit];
    expect(String(targetUrl)).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'gpt-5.4',
      instructions: 'You are a helpful assistant.',
      stream: true,
      store: false,
      tools: [{ type: 'function', name: 'lookup_repo' }],
      tool_choice: { type: 'function', name: 'lookup_repo' }
    });

    upstreamSpy.mockRestore();
    delete process.env.COMPAT_CODEX_DEFAULT_MODEL;
  });

  it('drops anthropic thinking history from translated openai oauth compat input', async () => {
    process.env.TOKEN_MODE_ENABLED_ORGS = '818d0cc7-7ed2-469f-b690-a977e72a921d';
    process.env.COMPAT_CODEX_DEFAULT_MODEL = 'gpt-5.4';
    const oauthToken = createFakeOpenAiOauthToken({
      accountId: 'acct_codex_thinking',
      clientId: 'app_codex_thinking'
    });

    vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'findActiveByHash').mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      org_id: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      scope: 'buyer_proxy',
      is_active: true,
      expires_at: null,
      preferred_provider: 'openai'
    } as any);
    vi.spyOn(runtimeModule.runtime.repos.modelCompatibility, 'findActive').mockImplementation(async (provider: string, model: string) => {
      if (provider === 'openai' && model === 'gpt-5.4') {
        return { provider: 'openai', model: 'gpt-5.4', supports_streaming: false } as any;
      }
      if (provider === 'anthropic' && model === 'claude-opus-4-6') {
        return { provider: 'anthropic', model: 'claude-opus-4-6', supports_streaming: false } as any;
      }
      return null as any;
    });
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'listActiveForRouting').mockImplementation(async (_orgId: string, provider: string) => {
      if (provider !== 'openai') return [];
      return [{
        id: 'dddd3335-0000-4000-8000-000000000000',
        orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
        provider: 'openai',
        authScheme: 'bearer',
        accessToken: oauthToken,
        refreshToken: 'rt_codex_thinking',
        expiresAt: new Date('2026-03-02T00:00:00Z'),
        status: 'active',
        rotationVersion: 1,
        createdAt: new Date('2026-03-01T00:00:00Z'),
        updatedAt: new Date('2026-03-01T00:00:00Z'),
        revokedAt: null,
        monthlyContributionLimitUnits: null,
        monthlyContributionUsedUnits: 0,
        monthlyWindowStartAt: new Date('2026-03-01T00:00:00Z')
      } as any];
    });

    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        id: 'resp_translated_oauth_ok',
        status: 'completed',
        usage: { input_tokens: 2, output_tokens: 3 },
        output: [{ type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }]
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );

    const req = createMockReq({
      method: 'POST',
      path: '/v1/proxy/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123456',
        'anthropic-version': '2023-06-01'
      },
      body: {
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        streaming: false,
        payload: {
          model: 'claude-opus-4-6',
          max_tokens: 64,
          messages: [
            { role: 'user', content: 'hi' },
            {
              role: 'assistant',
              content: [
                { type: 'thinking', thinking: 'internal scratchpad' },
                { type: 'text', text: 'working' }
              ]
            }
          ]
        }
      }
    });
    (req as any).inniesCompatMode = true;
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);

    expect(res.statusCode).toBe(200);
    const [, init] = upstreamSpy.mock.calls[0] as [URL, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.input).toEqual([
      { type: 'message', role: 'user', content: 'hi' },
      { type: 'message', role: 'assistant', content: 'working' }
    ]);
    expect(body.input.some((item: Record<string, unknown>) => item.type === 'reasoning')).toBe(false);

    upstreamSpy.mockRestore();
    delete process.env.COMPAT_CODEX_DEFAULT_MODEL;
  });

  it('falls back from translated openai compat lane to native anthropic compat lane when openai capacity is unavailable', async () => {
    process.env.TOKEN_MODE_ENABLED_ORGS = '818d0cc7-7ed2-469f-b690-a977e72a921d';
    process.env.COMPAT_CODEX_DEFAULT_MODEL = 'gpt-5.4';
    vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'findActiveByHash').mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      org_id: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      scope: 'buyer_proxy',
      is_active: true,
      expires_at: null,
      preferred_provider: 'openai'
    } as any);
    vi.spyOn(runtimeModule.runtime.repos.modelCompatibility, 'findActive').mockImplementation(async (provider: string, model: string) => {
      if (provider === 'openai' && model === 'gpt-5.4') {
        return { provider: 'openai', model: 'gpt-5.4', supports_streaming: false } as any;
      }
      if (provider === 'anthropic' && model === 'claude-opus-4-6') {
        return { provider: 'anthropic', model: 'claude-opus-4-6', supports_streaming: false } as any;
      }
      return null as any;
    });
    const listSpy = vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'listActiveForRouting').mockImplementation(async (_orgId: string, provider: string) => {
      if (provider === 'openai') return [];
      if (provider === 'anthropic') {
        return [{
          id: 'eeee7777-0000-4000-8000-000000000000',
          orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
          provider: 'anthropic',
          authScheme: 'bearer',
          accessToken: 'sk-ant-oat01-native-fallback',
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
        } as any];
      }
      return [];
    });
    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        id: 'msg_native_fallback',
        usage: { input_tokens: 2, output_tokens: 3 },
        content: [{ type: 'text', text: 'fallback ok' }]
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );

    const req = createMockReq({
      method: 'POST',
      path: '/v1/proxy/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123456',
        'anthropic-version': '2023-06-01'
      },
      body: {
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        streaming: false,
        payload: {
          model: 'claude-opus-4-6',
          max_tokens: 32,
          messages: [{ role: 'user', content: 'hi' }]
        }
      }
    });
    (req as any).inniesCompatMode = true;
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);

    expect(res.statusCode).toBe(200);
    expect((res.body as any).id).toBe('msg_native_fallback');
    expect(listSpy.mock.calls.map((call) => call[1])).toEqual(['openai', 'anthropic']);
    const routeDecision = (runtimeModule.runtime.repos.routingEvents.insert as any).mock.calls[0]?.[0]?.routeDecision;
    expect(routeDecision?.translated).toBeUndefined();
    expect(routeDecision?.provider_preferred).toBe('openai');
    expect(routeDecision?.provider_effective).toBe('anthropic');
    expect(routeDecision?.provider_fallback_from).toBe('openai');
    expect(routeDecision?.provider_fallback_reason).toBe('capacity_unavailable');
    upstreamSpy.mockRestore();
    delete process.env.COMPAT_CODEX_DEFAULT_MODEL;
  });

  it('applies stored buyer-key provider preference ahead of an unpinned request provider', async () => {
    process.env.TOKEN_MODE_ENABLED_ORGS = '818d0cc7-7ed2-469f-b690-a977e72a921d';
    vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'findActiveByHash').mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      org_id: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      scope: 'buyer_proxy',
      is_active: true,
      expires_at: null,
      preferred_provider: 'openai'
    } as any);

    vi.spyOn(runtimeModule.runtime.repos.modelCompatibility, 'findActive').mockImplementation(async (provider: string) => {
      if (provider === 'openai') {
        return { provider: 'openai', model: 'gpt-5.4', supports_streaming: false } as any;
      }
      if (provider === 'anthropic') {
        return { provider: 'anthropic', model: 'gpt-5.4', supports_streaming: false } as any;
      }
      return null as any;
    });

    const listSpy = vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'listActiveForRouting').mockImplementation(async (_orgId: string, provider: string) => {
      if (provider === 'openai') return [];
      if (provider === 'anthropic') {
        return [{
          id: 'eeee0000-0000-4000-8000-000000000000',
          orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
          provider: 'anthropic',
          authScheme: 'bearer',
          accessToken: 'sk-ant-oat01-fallback',
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
        } as any];
      }
      return [];
    });

    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'resp_pref_fallback_ok', usage: { input_tokens: 2, output_tokens: 3 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );

    const req = createMockReq({
      method: 'POST',
      path: '/v1/proxy/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123456',
        'anthropic-version': '2023-06-01'
      },
      body: {
        provider: 'anthropic',
        model: 'gpt-5.4',
        streaming: false,
        payload: { model: 'gpt-5.4', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);

    expect(res.statusCode).toBe(200);
    expect((res.body as any).id).toBe('resp_pref_fallback_ok');
    expect(listSpy.mock.calls.map((call) => call[1])).toEqual(['openai', 'anthropic']);
    const routeDecision = (runtimeModule.runtime.repos.routingEvents.insert as any).mock.calls[0]?.[0]?.routeDecision;
    expect(routeDecision?.reason).toBe('fallback_provider_selected');
    expect(routeDecision?.provider_selection_reason).toBe('fallback_provider_selected');
    expect(routeDecision?.provider_preferred).toBe('openai');
    expect(routeDecision?.provider_effective).toBe('anthropic');
    expect(routeDecision?.provider_fallback_from).toBe('openai');
    expect(routeDecision?.provider_fallback_reason).toBe('capacity_unavailable');
    upstreamSpy.mockRestore();
  });

  it('does not switch provider when request includes an explicit provider pin signal', async () => {
    process.env.TOKEN_MODE_ENABLED_ORGS = '818d0cc7-7ed2-469f-b690-a977e72a921d';
    vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'findActiveByHash').mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      org_id: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      scope: 'buyer_proxy',
      is_active: true,
      expires_at: null,
      preferred_provider: 'openai'
    } as any);

    const listSpy = vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'listActiveForRouting').mockResolvedValue([{
      id: 'ffff0000-0000-4000-8000-000000000000',
      orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      provider: 'anthropic',
      authScheme: 'bearer',
      accessToken: 'sk-ant-oat01-pinned',
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

    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'resp_pinned_ok', usage: { input_tokens: 1, output_tokens: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );

    const req = createMockReq({
      method: 'POST',
      path: '/v1/proxy/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123456',
        'anthropic-version': '2023-06-01',
        'x-innies-provider-pin': 'true'
      },
      body: {
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-latest',
        streaming: false,
        payload: { model: 'claude-3-5-sonnet-latest', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);

    expect(res.statusCode).toBe(200);
    expect((res.body as any).id).toBe('resp_pinned_ok');
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(listSpy.mock.calls[0]?.[1]).toBe('anthropic');
    const routeDecision = (runtimeModule.runtime.repos.routingEvents.insert as any).mock.calls[0]?.[0]?.routeDecision;
    expect(routeDecision?.reason).toBe('cli_provider_pinned');
    expect(routeDecision?.provider_preferred).toBe('anthropic');
    upstreamSpy.mockRestore();
  });

  it('pins real claude cli traffic without requiring an explicit Innies pin header', async () => {
    process.env.TOKEN_MODE_ENABLED_ORGS = '818d0cc7-7ed2-469f-b690-a977e72a921d';
    vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'findActiveByHash').mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      org_id: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      scope: 'buyer_proxy',
      is_active: true,
      expires_at: null,
      preferred_provider: 'openai'
    } as any);

    const listSpy = vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'listActiveForRouting').mockResolvedValue([{
      id: '99990000-0000-4000-8000-000000000000',
      orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      provider: 'anthropic',
      authScheme: 'bearer',
      accessToken: 'sk-ant-cli-pinned',
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

    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'resp_claude_cli_pinned', usage: { input_tokens: 1, output_tokens: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );

    const req = createMockReq({
      method: 'POST',
      path: '/v1/proxy/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123456',
        'anthropic-version': '2023-06-01',
        'user-agent': 'claude-cli/2.1.63 (external, sdk-cli)',
        'x-app': 'cli'
      },
      body: {
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-latest',
        streaming: false,
        payload: { model: 'claude-3-5-sonnet-latest', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);

    expect(res.statusCode).toBe(200);
    expect((res.body as any).id).toBe('resp_claude_cli_pinned');
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(listSpy.mock.calls[0]?.[1]).toBe('anthropic');
    const routeDecision = (runtimeModule.runtime.repos.routingEvents.insert as any).mock.calls[0]?.[0]?.routeDecision;
    expect(routeDecision?.reason).toBe('cli_provider_pinned');
    expect(routeDecision?.provider_preferred).toBe('anthropic');
    expect(routeDecision?.provider_effective).toBe('anthropic');
    upstreamSpy.mockRestore();
  });

  it('falls back when the preferred provider fails preflight eligibility', async () => {
    process.env.TOKEN_MODE_ENABLED_ORGS = '818d0cc7-7ed2-469f-b690-a977e72a921d';
    vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'findActiveByHash').mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      org_id: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      scope: 'buyer_proxy',
      is_active: true,
      expires_at: null,
      preferred_provider: 'openai'
    } as any);
    vi.spyOn(runtimeModule.runtime.repos.modelCompatibility, 'findActive').mockImplementation(async (provider: string) => {
      if (provider === 'openai') return null as any;
      if (provider === 'anthropic') {
        return { provider: 'anthropic', model: 'gpt-5.4', supports_streaming: false } as any;
      }
      return null as any;
    });
    const listSpy = vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'listActiveForRouting').mockImplementation(async (_orgId: string, provider: string) => {
      if (provider !== 'anthropic') return [];
      return [{
        id: 'abcd0000-0000-4000-8000-000000000000',
        orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
        provider: 'anthropic',
        authScheme: 'bearer',
        accessToken: 'sk-ant-oat01-preflight-fallback',
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
      } as any];
    });
    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'resp_preflight_fallback_ok', usage: { input_tokens: 1, output_tokens: 2 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );

    const req = createMockReq({
      method: 'POST',
      path: '/v1/proxy/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123456',
        'anthropic-version': '2023-06-01'
      },
      body: {
        provider: 'anthropic',
        model: 'gpt-5.4',
        streaming: false,
        payload: { model: 'gpt-5.4', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);

    expect(res.statusCode).toBe(200);
    expect((res.body as any).id).toBe('resp_preflight_fallback_ok');
    expect(listSpy.mock.calls.map((call) => call[1])).toEqual(['anthropic']);
    const routeDecision = (runtimeModule.runtime.repos.routingEvents.insert as any).mock.calls[0]?.[0]?.routeDecision;
    expect(routeDecision?.reason).toBe('fallback_provider_selected');
    expect(routeDecision?.provider_preferred).toBe('openai');
    expect(routeDecision?.provider_effective).toBe('anthropic');
    expect(routeDecision?.provider_fallback_from).toBe('openai');
    expect(routeDecision?.provider_fallback_reason).toBe('model_invalid');
    upstreamSpy.mockRestore();
  });

  it('uses the configured default buyer provider when no explicit preference is stored', async () => {
    process.env.BUYER_PROVIDER_PREFERENCE_DEFAULT = 'openai';
    process.env.TOKEN_MODE_ENABLED_ORGS = '818d0cc7-7ed2-469f-b690-a977e72a921d';
    vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'findActiveByHash').mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      org_id: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      scope: 'buyer_proxy',
      is_active: true,
      expires_at: null,
      preferred_provider: null
    } as any);
    vi.spyOn(runtimeModule.runtime.repos.modelCompatibility, 'findActive').mockImplementation(async (provider: string) => {
      if (provider === 'openai') {
        return { provider: 'openai', model: 'gpt-5.4', supports_streaming: false } as any;
      }
      if (provider === 'anthropic') {
        return { provider: 'anthropic', model: 'gpt-5.4', supports_streaming: false } as any;
      }
      return null as any;
    });
    const listSpy = vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'listActiveForRouting').mockImplementation(async (_orgId: string, provider: string) => {
      if (provider !== 'openai') return [];
      return [{
        id: 'eeee0000-0000-4000-8000-000000000000',
        orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
        provider: 'openai',
        authScheme: 'bearer',
        accessToken: 'sk-openai-pref-default',
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
      } as any];
    });
    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'resp_default_pref_ok', usage: { input_tokens: 1, output_tokens: 2 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );

    const req = createMockReq({
      method: 'POST',
      path: '/v1/proxy/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123456'
      },
      body: {
        model: 'gpt-5.4',
        streaming: false,
        payload: { model: 'gpt-5.4', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);

    expect(res.statusCode).toBe(200);
    expect((res.body as any).id).toBe('resp_default_pref_ok');
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(listSpy.mock.calls[0]?.[1]).toBe('openai');
    const routeDecision = (runtimeModule.runtime.repos.routingEvents.insert as any).mock.calls[0]?.[0]?.routeDecision;
    expect(routeDecision?.reason).toBe('preferred_provider_selected');
    expect(routeDecision?.provider_preferred).toBe('openai');
    expect(routeDecision?.provider_effective).toBe('openai');
    upstreamSpy.mockRestore();
  });

  it('always adds the alternate provider as fallback for defaulted buyer preference', async () => {
    process.env.BUYER_PROVIDER_PREFERENCE_DEFAULT = 'anthropic';
    process.env.TOKEN_MODE_ENABLED_ORGS = '818d0cc7-7ed2-469f-b690-a977e72a921d';
    vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'findActiveByHash').mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      org_id: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      scope: 'buyer_proxy',
      is_active: true,
      expires_at: null,
      preferred_provider: null
    } as any);
    vi.spyOn(runtimeModule.runtime.repos.modelCompatibility, 'findActive').mockImplementation(async (provider: string) => {
      if (provider === 'anthropic') return null as any;
      if (provider === 'openai') {
        return { provider: 'openai', model: 'gpt-5.4', supports_streaming: false } as any;
      }
      return null as any;
    });
    const listSpy = vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'listActiveForRouting').mockImplementation(async (_orgId: string, provider: string) => {
      if (provider !== 'openai') return [];
      return [{
        id: 'eeee1111-0000-4000-8000-000000000000',
        orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
        provider: 'openai',
        authScheme: 'bearer',
        accessToken: 'sk-openai-default-fallback',
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
      } as any];
    });
    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'resp_default_fallback_ok', usage: { input_tokens: 1, output_tokens: 2 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );

    const req = createMockReq({
      method: 'POST',
      path: '/v1/proxy/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123456',
        'anthropic-version': '2023-06-01'
      },
      body: {
        provider: 'anthropic',
        model: 'gpt-5.4',
        streaming: false,
        payload: { model: 'gpt-5.4', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);

    expect(res.statusCode).toBe(200);
    expect((res.body as any).id).toBe('resp_default_fallback_ok');
    expect(listSpy.mock.calls.map((call) => call[1])).toEqual(['openai']);
    const routeDecision = (runtimeModule.runtime.repos.routingEvents.insert as any).mock.calls[0]?.[0]?.routeDecision;
    expect(routeDecision?.reason).toBe('fallback_provider_selected');
    expect(routeDecision?.provider_preferred).toBe('anthropic');
    expect(routeDecision?.provider_effective).toBe('openai');
    expect(routeDecision?.provider_fallback_from).toBe('anthropic');
    expect(routeDecision?.provider_fallback_reason).toBe('model_invalid');
    upstreamSpy.mockRestore();
  });
});
