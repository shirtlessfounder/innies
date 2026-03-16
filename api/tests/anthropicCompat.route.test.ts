import { describe, expect, it, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { z } from 'zod';
import { AppError } from '../src/utils/errors.js';
import { resetAnthropicUsageRetryStateForTests } from '../src/services/tokenCredentialProviderUsageRetryState.js';

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

type MockRes = PassThrough & {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  headersSent: boolean;
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
  const stream = new PassThrough() as MockRes;
  stream.statusCode = 200;
  stream.headers = {};
  stream.body = undefined;
  stream.headersSent = false;
  let rawBody = '';

  stream.on('data', (chunk) => {
    rawBody += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  });
  stream.on('finish', () => {
    stream.headersSent = true;
    if (stream.body === undefined && rawBody.length > 0) {
      stream.body = rawBody;
    }
  });

  stream.setHeader = function setHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value;
  };
  stream.status = function status(code: number) {
    this.statusCode = code;
    return this;
  };
  stream.json = function json(payload: unknown) {
    this.body = payload;
    this.headersSent = true;
    this.end();
  };
  stream.send = function send(payload: unknown) {
    this.body = payload;
    this.headersSent = true;
    this.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  };

  return stream;
}

function applyError(err: unknown, res: MockRes, req?: MockReq): void {
  if (err instanceof z.ZodError) {
    res.status(400).json({ code: 'invalid_request', message: 'Invalid request', issues: err.issues });
    return;
  }
  if (err instanceof AppError) {
    // Mirror production behavior: compat requests get Anthropic-shaped error envelopes
    if (req?.inniesCompatMode) {
      const anthropicErrorType =
        err.status === 401 ? 'authentication_error'
        : err.status === 403 ? 'permission_error'
        : err.status === 429 ? 'rate_limit_error'
        : err.status === 404 ? 'not_found_error'
        : err.status >= 400 && err.status < 500 ? 'invalid_request_error'
        : 'api_error';
      const anthropicStatus = err.status >= 500 ? 500 : err.status;
      res.status(anthropicStatus).json({
        type: 'error',
        error: { type: anthropicErrorType, message: err.message }
      });
      return;
    }
    res.status(err.status).json({ code: err.code, message: err.message, details: err.details });
    return;
  }
  const message = err instanceof Error ? err.message : 'Unexpected error';
  if (req?.inniesCompatMode) {
    res.status(500).json({
      type: 'error',
      error: { type: 'api_error', message }
    });
    return;
  }
  res.status(500).json({ code: 'internal_error', message });
}

async function invoke(handle: (req: any, res: any, next: (error?: unknown) => void) => unknown, req: MockReq, res: MockRes): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let nextCalled = false;
    const next = (error?: unknown) => {
      nextCalled = true;
      if (error) {
        applyError(error, res, req);
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
      chatgpt_account_id: input?.accountId ?? 'acct_codex_compat'
    }
  })).toString('base64url');
  return `${header}.${payload}.signature`;
}

function setupTranslatedCompatOpenAiRoute(runtimeModule: RuntimeModule) {
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
      id: 'openai-compat-cred',
      orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      provider: 'openai',
      authScheme: 'bearer',
      accessToken: 'openai-compat-token',
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
    process.env.ANTHROPIC_COMPAT_MAX_MESSAGE_COUNT = '1000';
    process.env.ANTHROPIC_COMPAT_MAX_REQUEST_BYTES = '5000000';

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
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'recordSuccess').mockResolvedValue(true);
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'recordFailureAndMaybeMax').mockResolvedValue({
      status: 'active',
      consecutiveFailures: 1
    } as any);
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'recordRateLimitAndApplyCooldown').mockResolvedValue({
      status: 'active',
      consecutiveRateLimits: 1,
      rateLimitedUntil: null,
      backoffKind: 'none'
    } as any);
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'recordRateLimitAndMaybeMax').mockResolvedValue({
      status: 'active',
      consecutiveRateLimits: 1,
      rateLimitedUntil: null,
      newlyMaxed: false
    } as any);
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'clearRateLimitBackoff').mockResolvedValue(false);
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentialProviderUsage, 'listByTokenCredentialIds').mockResolvedValue([]);
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentialProviderUsage, 'upsertSnapshot').mockImplementation(async (input: any) => ({
      tokenCredentialId: input.tokenCredentialId,
      orgId: input.orgId,
      provider: input.provider,
      usageSource: input.usageSource ?? 'anthropic_oauth_usage',
      fiveHourUtilizationRatio: input.fiveHourUtilizationRatio,
      fiveHourResetsAt: input.fiveHourResetsAt,
      sevenDayUtilizationRatio: input.sevenDayUtilizationRatio,
      sevenDayResetsAt: input.sevenDayResetsAt,
      rawPayload: input.rawPayload,
      fetchedAt: input.fetchedAt,
      createdAt: input.fetchedAt,
      updatedAt: input.fetchedAt
    }));
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
    delete process.env.ANTHROPIC_COMPAT_MAX_MESSAGE_COUNT;
    delete process.env.ANTHROPIC_COMPAT_MAX_REQUEST_BYTES;
    delete process.env.OPENAI_UPSTREAM_BASE_URL;
    delete process.env.COMPAT_CODEX_DEFAULT_MODEL;
    resetAnthropicUsageRetryStateForTests();
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

  it('routes buyer-pref openai compat requests to responses with translated payload and no compat pin', async () => {
    const oauthToken = createFakeOpenAiOauthToken({ accountId: 'acct_codex_compat_live' });
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
        return {
          provider: 'openai',
          model: 'gpt-5.4',
          supports_streaming: false
        } as any;
      }
      return null as any;
    });
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'listActiveForRouting').mockImplementation(async (_orgId: string, provider: string) => {
      if (provider === 'openai') {
        return [{
          id: '33333333-3333-4333-8333-333333333333',
          orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
          provider: 'openai',
          authScheme: 'bearer',
          accessToken: oauthToken,
          refreshToken: 'rt_test',
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

    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      id: 'resp_compat_openai_ok'
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }));

    const req = createMockReq({
      method: 'POST',
      path: '/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01'
      },
      body: {
        model: 'claude-opus-4-6',
        max_tokens: 2048,
        system: [
          { type: 'text', text: 'be concise', cache_control: { type: 'ephemeral' } }
        ],
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hi there' }] }
        ],
        tools: [
          { name: 'lookup', description: 'lookup docs', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }
        ],
        tool_choice: { type: 'tool', name: 'lookup' },
        thinking: { type: 'enabled', budget_tokens: 1024 }
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);
    await invoke(handlers[2], req, res);

    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect((res.body as any).id).toBe('resp_compat_openai_ok');
    expect(upstreamSpy).toHaveBeenCalledTimes(1);

    const [targetUrl, init] = upstreamSpy.mock.calls[0] ?? [];
    const headers = (init as RequestInit)?.headers as Record<string, string>;
    const body = JSON.parse(String((init as RequestInit)?.body ?? '{}'));
    expect(String(targetUrl)).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(headers.authorization).toBe(`Bearer ${oauthToken}`);
    expect(headers['chatgpt-account-id']).toBe('acct_codex_compat_live');
    expect(body).toEqual({
      model: 'gpt-5.4',
      input: [
        { type: 'message', role: 'user', content: 'hi there' }
      ],
      instructions: 'be concise',
      tools: [
        {
          type: 'function',
          name: 'lookup',
          description: 'lookup docs',
          parameters: { type: 'object', properties: { q: { type: 'string' } } }
        }
      ],
      tool_choice: {
        type: 'function',
        name: 'lookup'
      },
      reasoning: { effort: 'high' },
      store: false,
      stream: true
    });

    const routeDecision = ((runtimeModule.runtime.repos.routingEvents.insert as any).mock.calls.at(-1)?.[0]?.routeDecision ?? {}) as Record<string, unknown>;
    expect(routeDecision.reason).toBe('preferred_provider_selected');
    expect(routeDecision.provider_preferred).toBe('openai');
    expect(routeDecision.provider_effective).toBe('openai');
    expect(routeDecision.provider_plan).toEqual(['openai', 'anthropic']);
    upstreamSpy.mockRestore();
  });

  it('maps translated openai 401 responses into anthropic authentication_error envelopes', async () => {
    setupTranslatedCompatOpenAiRoute(runtimeModule);
    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'bad oauth token' }
    }), {
      status: 401,
      headers: { 'content-type': 'application/json' }
    }));

    const req = createMockReq({
      method: 'POST',
      path: '/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01'
      },
      body: {
        model: 'claude-opus-4-6',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'hi' }]
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);
    await invoke(handlers[2], req, res);

    expect(res.statusCode).toBe(401);
    expect((res.body as any)).toEqual({
      type: 'error',
      error: {
        type: 'authentication_error',
        message: 'bad oauth token'
      }
    });

    upstreamSpy.mockRestore();
  });

  it('collapses translated codex SSE into anthropic JSON for non-stream compat requests', async () => {
    setupTranslatedCompatOpenAiRoute(runtimeModule);
    const upstreamSse = [
      'data: {"type":"response.created","response":{"id":"resp_compat_sse","status":"in_progress"}}\n\n',
      'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_compat_sse","role":"assistant","content":[{"type":"output_text","text":"hello from codex"}],"status":"completed"}}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_compat_sse","status":"completed","usage":{"input_tokens":5,"output_tokens":7},"output":[{"type":"message","id":"msg_compat_sse","role":"assistant","content":[{"type":"output_text","text":"hello from codex"}],"status":"completed"}]}}\n\n',
      'data: [DONE]\n\n'
    ].join('');
    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(upstreamSse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' }
    }));

    const req = createMockReq({
      method: 'POST',
      path: '/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01'
      },
      body: {
        model: 'claude-opus-4-6',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'hi' }]
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);
    await invoke(handlers[2], req, res);

    expect(res.statusCode).toBe(200);
    expect((res.body as any).content).toEqual([{ type: 'text', text: 'hello from codex' }]);
    expect((res.body as any).stop_reason).toBe('end_turn');
    expect((res.body as any).usage).toEqual({ input_tokens: 5, output_tokens: 7 });

    const [, init] = upstreamSpy.mock.calls[0] as [URL, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'gpt-5.4',
      instructions: 'You are a helpful assistant.',
      input: [{ type: 'message', role: 'user', content: 'hi' }]
    });

    upstreamSpy.mockRestore();
  });

  it('maps translated openai 429 responses into anthropic rate_limit_error envelopes', async () => {
    setupTranslatedCompatOpenAiRoute(runtimeModule);
    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'slow down' }
    }), {
      status: 429,
      headers: { 'content-type': 'application/json' }
    }));

    const req = createMockReq({
      method: 'POST',
      path: '/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01'
      },
      body: {
        model: 'claude-opus-4-6',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'hi' }]
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);
    await invoke(handlers[2], req, res);

    expect(res.statusCode).toBe(429);
    expect((res.body as any)).toEqual({
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: 'slow down'
      }
    });

    upstreamSpy.mockRestore();
  });

  it('maps translated openai 5xx responses into anthropic api_error envelopes with status 500', async () => {
    setupTranslatedCompatOpenAiRoute(runtimeModule);
    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'upstream outage' }
    }), {
      status: 502,
      headers: { 'content-type': 'application/json' }
    }));

    const req = createMockReq({
      method: 'POST',
      path: '/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01'
      },
      body: {
        model: 'claude-opus-4-6',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'hi' }]
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);
    await invoke(handlers[2], req, res);

    expect(res.statusCode).toBe(500);
    expect((res.body as any)).toEqual({
      type: 'error',
      error: {
        type: 'api_error',
        message: 'upstream outage'
      }
    });

    upstreamSpy.mockRestore();
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
    // Compat requests get anthropic-shaped error envelopes even for pre-proxy validation
    expect((res.body as any).type).toBe('error');
    expect((res.body as any).error?.type).toBe('permission_error');
    expect(String((res.body as any).error?.message)).toContain('Token mode not enabled');
  });

  it('supports stream=true requests on compat route', async () => {
    const idemStartSpy = vi.spyOn(runtimeModule.runtime.services.idempotency, 'start');
    const meteringSpy = vi.spyOn(runtimeModule.runtime.services.metering, 'recordUsage');
    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'msg_stream_1', usage: { input_tokens: 10, output_tokens: 10 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );

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

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(String(res.body)).toContain('event: message_start');
    expect(String(res.body)).toContain('event: message_stop');
    expect(idemStartSpy).not.toHaveBeenCalled();
    expect(upstreamSpy).toHaveBeenCalledTimes(1);
    expect(meteringSpy).toHaveBeenCalledTimes(1);
    const meteringArgs = meteringSpy.mock.calls[0]?.[0] as any;
    expect(String(meteringArgs?.note ?? '')).toContain('metering_source=payload_usage');
    expect(String(meteringArgs?.note ?? '')).toContain('stream_mode=synthetic_bridge');
    upstreamSpy.mockRestore();
  });

  it('preserves tool_use blocks in synthetic bridge with input_json_delta', async () => {
    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        id: 'msg_tool_1',
        usage: { input_tokens: 20, output_tokens: 10 },
        content: [
          { type: 'text', text: 'working on it' },
          { type: 'tool_use', id: 'toolu_123', name: 'gh_read_repo', input: { repo: 'shirtlessfounder/innies' } }
        ]
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );

    const req = createMockReq({
      method: 'POST',
      path: '/v1/messages',
      headers: { authorization: 'Bearer in_test_token', 'content-type': 'application/json' },
      body: { model: 'claude-opus-4-6', stream: true, max_tokens: 32, messages: [{ role: 'user', content: 'read repo' }] }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);
    await invoke(handlers[2], req, res);

    const body = String(res.body ?? '');
    expect(res.statusCode).toBe(200);
    expect(body).toContain('event: content_block_start');
    expect(body).toContain('"type":"tool_use"');
    expect(body).toContain('"id":"toolu_123"');
    expect(body).toContain('"name":"gh_read_repo"');
    expect(body).toContain('"type":"input_json_delta"');
    expect(body).toContain('"partial_json":"{\\"repo\\":\\"shirtlessfounder/innies\\"}"');
    upstreamSpy.mockRestore();
  });

  it('preserves unknown non-text content blocks in synthetic bridge', async () => {
    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        id: 'msg_unknown_block',
        usage: { input_tokens: 6, output_tokens: 4 },
        content: [{ type: 'citations', source: 'repo', value: 'README.md' }]
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );

    const req = createMockReq({
      method: 'POST',
      path: '/v1/messages',
      headers: { authorization: 'Bearer in_test_token', 'content-type': 'application/json' },
      body: { model: 'claude-opus-4-6', stream: true, max_tokens: 16, messages: [{ role: 'user', content: 'cite sources' }] }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);
    await invoke(handlers[2], req, res);

    const body = String(res.body ?? '');
    expect(res.statusCode).toBe(200);
    expect(body).toContain('"type":"citations"');
    expect(body).toContain('"source":"repo"');
    expect(body).toContain('event: content_block_stop');
    upstreamSpy.mockRestore();
  });

  it('passes through SSE stream chunks on compat route', async () => {
    const meteringSpy = vi.spyOn(runtimeModule.runtime.services.metering, 'recordUsage');
    const routingSpy = vi.spyOn(runtimeModule.runtime.repos.routingEvents, 'insert');
    const streamLatencySpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const encoder = new TextEncoder();
    const sseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: message_start\ndata: {"type":"message_start"}\n\n'));
        controller.enqueue(encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
        controller.close();
      }
    });
    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(sseBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' }
      })
    );

    const req = createMockReq({
      method: 'POST',
      path: '/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'x-openclaw-run-id': 'oc_run_123',
        'x-openclaw-session-id': 'oc_sess_456'
      },
      body: { model: 'claude-opus-4-6', stream: true, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);
    await invoke(handlers[2], req, res);

    expect(upstreamSpy).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.headers['cache-control']).toBe('no-cache, no-transform');
    expect(res.headers['x-accel-buffering']).toBe('no');
    expect(String(res.body)).toContain(': keepalive');
    expect(String(res.body)).toContain('event: message_start');
    expect(String(res.body)).toContain('event: message_stop');
    expect(meteringSpy).toHaveBeenCalledTimes(1);
    const meteringArgs = meteringSpy.mock.calls[0]?.[0] as any;
    expect(String(meteringArgs?.note ?? '')).toContain('metering_source=stream_estimate');
    const latencyCalls = streamLatencySpy.mock.calls.filter((c) => c[0] === '[stream-latency]');
    expect(latencyCalls.length).toBeGreaterThan(0);
    const lastLatency = latencyCalls[latencyCalls.length - 1]?.[1] as any;
    expect(lastLatency?.stream_mode).toBe('passthrough');
    expect(lastLatency?.bridge_build_ms).toBeNull();
    expect(lastLatency?.openclaw_run_id).toBe('oc_run_123');
    expect(lastLatency?.openclaw_session_id).toBe('oc_sess_456');
    const routingArgs = routingSpy.mock.calls[0]?.[0] as any;
    expect(routingArgs?.routeDecision?.openclaw_run_id).toBe('oc_run_123');
    expect(routingArgs?.routeDecision?.openclaw_session_id).toBe('oc_sess_456');
    upstreamSpy.mockRestore();
    streamLatencySpy.mockRestore();
  });

  it('translates openai streaming responses back into anthropic SSE when buyer preference is openai', async () => {
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
        id: 'openai-stream-cred',
        orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
        provider: 'openai',
        authScheme: 'bearer',
        accessToken: 'openai-stream-token',
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
    const encoder = new TextEncoder();
    const sseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_compat_1\",\"status\":\"in_progress\",\"usage\":{\"input_tokens\":0,\"output_tokens\":0}}}\\n\\n'));
        controller.enqueue(encoder.encode('data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"function_call\",\"id\":\"fc_1\",\"call_id\":\"call_1\",\"name\":\"lookup_repo\",\"arguments\":\"\"}}\\n\\n'));
        controller.enqueue(encoder.encode('data: {\"type\":\"response.function_call_arguments.delta\",\"delta\":\"{\\\\\"name\\\\\":\\\\\"innies\\\\\"}\"}\\n\\n'));
        controller.enqueue(encoder.encode('data: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"type\":\"function_call\",\"id\":\"fc_1\",\"call_id\":\"call_1\",\"name\":\"lookup_repo\",\"arguments\":\"{\\\\\"name\\\\\":\\\\\"innies\\\\\"}\"}}\\n\\n'));
        controller.enqueue(encoder.encode('data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_compat_1\",\"status\":\"completed\",\"usage\":{\"input_tokens\":9,\"output_tokens\":4}}}\\n\\n'));
        controller.close();
      }
    });
    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(sseBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' }
      })
    );

    const req = createMockReq({
      method: 'POST',
      path: '/v1/messages',
      headers: { authorization: 'Bearer in_test_token', 'content-type': 'application/json' },
      body: {
        model: 'claude-opus-4-6',
        stream: true,
        max_tokens: 32,
        tools: [{ name: 'lookup_repo', description: 'lookup repo', input_schema: { type: 'object', properties: { name: { type: 'string' } } } }],
        tool_choice: { type: 'tool', name: 'lookup_repo' },
        messages: [{ role: 'user', content: 'hi' }]
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);
    await invoke(handlers[2], req, res);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');

    const [targetUrl, init] = upstreamSpy.mock.calls[0] as [URL, RequestInit];
    expect(String(targetUrl)).toBe('https://openai.internal.test/v1/responses');
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'gpt-5.4',
      input: [{ type: 'message', role: 'user', content: 'hi' }],
      tools: [{ type: 'function', name: 'lookup_repo' }],
      tool_choice: { type: 'function', name: 'lookup_repo' }
    });
    const routeDecision = (runtimeModule.runtime.repos.routingEvents.insert as any).mock.calls[0]?.[0]?.routeDecision;
    expect(routeDecision?.translated).toBe(true);
    expect(routeDecision?.translated_path).toBe('/v1/responses');
    expect(routeDecision?.provider_preferred).toBe('openai');
    expect(routeDecision?.provider_effective).toBe('openai');
    upstreamSpy.mockRestore();
    delete process.env.OPENAI_UPSTREAM_BASE_URL;
    delete process.env.COMPAT_CODEX_DEFAULT_MODEL;
  });

  it('translates mislabelled codex SSE bodies into anthropic SSE when buyer preference is openai', async () => {
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
        id: 'openai-stream-cred-mislabelled',
        orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
        provider: 'openai',
        authScheme: 'bearer',
        accessToken: 'openai-stream-token',
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
    const streamLatencySpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const upstreamSse = [
      'data: {"type":"response.created","response":{"id":"resp_compat_mislabelled","status":"in_progress","usage":{"input_tokens":0,"output_tokens":0}}}\n\n',
      'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_compat_mislabelled","role":"assistant","content":[{"type":"output_text","text":"hello from codex"}],"status":"completed"}}\n\n',
      'data: {"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","id":"fc_compat_mislabelled","call_id":"call_compat_mislabelled","name":"lookup_repo","arguments":"{\\"name\\":\\"innies\\"}","status":"completed"}}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_compat_mislabelled","status":"completed","usage":{"input_tokens":9,"output_tokens":4}}}\n\n',
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
      path: '/v1/messages',
      headers: { authorization: 'Bearer in_test_token', 'content-type': 'application/json' },
      body: {
        model: 'claude-opus-4-6',
        stream: true,
        max_tokens: 32,
        tools: [{ name: 'lookup_repo', description: 'lookup repo', input_schema: { type: 'object', properties: { name: { type: 'string' } } } }],
        tool_choice: { type: 'tool', name: 'lookup_repo' },
        messages: [{ role: 'user', content: 'hi' }]
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);
    await invoke(handlers[2], req, res);

    const body = String(res.body ?? '');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(body).toContain('event: content_block_start');
    expect(body).toContain('"type":"text_delta","text":"hello from codex"');
    expect(body).toContain('"type":"tool_use","id":"call_compat_mislabelled","name":"lookup_repo"');
    expect(body).toContain('"type":"input_json_delta","partial_json":"{\\"name\\":\\"innies\\"}"');
    expect(body).toContain('"stop_reason":"tool_use"');

    const latencyCalls = streamLatencySpy.mock.calls.filter((call) => call[0] === '[stream-latency]');
    expect(latencyCalls.length).toBeGreaterThan(0);
    const lastLatency = latencyCalls[latencyCalls.length - 1]?.[1] as any;
    expect(lastLatency?.stream_mode).toBe('synthetic_bridge');
    expect(lastLatency?.synthetic_content_block_count).toBe(2);
    expect(lastLatency?.synthetic_content_block_types).toBe('text,tool_use');

    upstreamSpy.mockRestore();
    streamLatencySpy.mockRestore();
    delete process.env.OPENAI_UPSTREAM_BASE_URL;
    delete process.env.COMPAT_CODEX_DEFAULT_MODEL;
  });

  it('maps mislabelled failed codex SSE bodies into anthropic error responses when buyer preference is openai', async () => {
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
        id: 'openai-stream-cred-failed-mislabelled',
        orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
        provider: 'openai',
        authScheme: 'bearer',
        accessToken: 'openai-stream-token',
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
    const upstreamSse = [
      'data: {"type":"response.created","response":{"id":"resp_compat_failed","status":"in_progress"}}\n\n',
      'data: {"type":"response.failed","response":{"id":"resp_compat_failed","status":"failed","error":{"message":"upstream boom"}}}\n\n',
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
      path: '/v1/messages',
      headers: { authorization: 'Bearer in_test_token', 'content-type': 'application/json' },
      body: {
        model: 'claude-opus-4-6',
        stream: true,
        max_tokens: 32,
        messages: [{ role: 'user', content: 'hi' }]
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);
    await invoke(handlers[2], req, res);

    expect(res.statusCode).toBe(500);
    expect(res.headers['content-type']).toContain('application/json');
    expect((res.body as any)).toEqual({
      type: 'error',
      error: {
        type: 'api_error',
        message: 'upstream boom'
      }
    });

    upstreamSpy.mockRestore();
    delete process.env.OPENAI_UPSTREAM_BASE_URL;
    delete process.env.COMPAT_CODEX_DEFAULT_MODEL;
  });

  it('derives run correlation id when compat request omits OpenClaw IDs', async () => {
    const routingSpy = vi.spyOn(runtimeModule.runtime.repos.routingEvents, 'insert');
    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'msg_derived_run', usage: { input_tokens: 4, output_tokens: 3 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );

    const req = createMockReq({
      method: 'POST',
      path: '/v1/messages',
      headers: { authorization: 'Bearer in_test_token', 'content-type': 'application/json' },
      body: { model: 'claude-opus-4-6', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);
    await invoke(handlers[2], req, res);

    expect(res.statusCode).toBe(200);
    const routingArgs = routingSpy.mock.calls[0]?.[0] as any;
    expect(String(routingArgs?.routeDecision?.openclaw_run_id ?? '')).toMatch(/^run_req_/);
    expect(routingArgs?.routeDecision?.openclaw_session_id).toBeNull();
    upstreamSpy.mockRestore();
  });

  it('uses metadata-based OpenClaw correlation ids when headers are absent', async () => {
    const routingSpy = vi.spyOn(runtimeModule.runtime.repos.routingEvents, 'insert');
    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'msg_meta_corr', usage: { input_tokens: 5, output_tokens: 2 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );

    const req = createMockReq({
      method: 'POST',
      path: '/v1/messages',
      headers: { authorization: 'Bearer in_test_token', 'content-type': 'application/json' },
      body: {
        model: 'claude-opus-4-6',
        max_tokens: 8,
        messages: [{ role: 'user', content: 'hi' }],
        metadata: {
          openclaw_run_id: 'meta_run_1',
          openclaw_session_id: 'meta_sess_1'
        }
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);
    await invoke(handlers[2], req, res);

    expect(res.statusCode).toBe(200);
    const routingArgs = routingSpy.mock.calls[0]?.[0] as any;
    expect(routingArgs?.routeDecision?.openclaw_run_id).toBe('meta_run_1');
    expect(routingArgs?.routeDecision?.openclaw_session_id).toBe('meta_sess_1');
    upstreamSpy.mockRestore();
  });

  it('records metering_source=stream_usage when SSE usage frames are present', async () => {
    const meteringSpy = vi.spyOn(runtimeModule.runtime.services.metering, 'recordUsage');
    const encoder = new TextEncoder();
    const sseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: message_start\ndata: {"type":"message_start"}\n\n'));
        controller.enqueue(encoder.encode('event: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":11,"output_tokens":7}}\n\n'));
        controller.enqueue(encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
        controller.close();
      }
    });
    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(sseBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' }
      })
    );

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

    expect(res.statusCode).toBe(200);
    expect(meteringSpy).toHaveBeenCalledTimes(1);
    const meteringArgs = meteringSpy.mock.calls[0]?.[0] as any;
    expect(String(meteringArgs?.note ?? '')).toContain('metering_source=stream_usage');
    upstreamSpy.mockRestore();
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

  it('rejects deterministic when messages exceed configured max count', async () => {
    process.env.ANTHROPIC_COMPAT_MAX_MESSAGE_COUNT = '2';
    const upstreamSpy = vi.spyOn(globalThis, 'fetch');
    const req = createMockReq({
      method: 'POST',
      path: '/v1/messages',
      headers: { authorization: 'Bearer in_test_token', 'content-type': 'application/json' },
      body: {
        model: 'claude-opus-4-6',
        max_tokens: 8,
        messages: [
          { role: 'user', content: '1' },
          { role: 'user', content: '2' },
          { role: 'user', content: '3' }
        ]
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);
    await invoke(handlers[2], req, res);

    expect(res.statusCode).toBe(400);
    expect((res.body as any).code).toBe('invalid_request');
    expect(JSON.stringify((res.body as any).issues ?? [])).toContain('messages exceeds max allowed count');
    expect(upstreamSpy).not.toHaveBeenCalled();
    upstreamSpy.mockRestore();
  });

  it('rejects deterministic when request payload exceeds configured max bytes', async () => {
    process.env.ANTHROPIC_COMPAT_MAX_REQUEST_BYTES = '200';
    const upstreamSpy = vi.spyOn(globalThis, 'fetch');
    const req = createMockReq({
      method: 'POST',
      path: '/v1/messages',
      headers: { authorization: 'Bearer in_test_token', 'content-type': 'application/json' },
      body: {
        model: 'claude-opus-4-6',
        max_tokens: 8,
        messages: [{ role: 'user', content: 'x'.repeat(400) }]
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);
    await invoke(handlers[2], req, res);

    expect(res.statusCode).toBe(400);
    expect((res.body as any).code).toBe('invalid_request');
    expect(String((res.body as any).message ?? '')).toContain('request payload exceeds max allowed bytes');
    expect(upstreamSpy).not.toHaveBeenCalled();
    upstreamSpy.mockRestore();
  });

  it('rejects by content-length fast-path when declared size exceeds max bytes', async () => {
    process.env.ANTHROPIC_COMPAT_MAX_REQUEST_BYTES = '200';
    const upstreamSpy = vi.spyOn(globalThis, 'fetch');
    const req = createMockReq({
      method: 'POST',
      path: '/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'content-length': '999999'
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

    expect(res.statusCode).toBe(400);
    expect((res.body as any).code).toBe('invalid_request');
    expect(String((res.body as any).message)).toContain('request payload exceeds max allowed bytes');
    expect(upstreamSpy).not.toHaveBeenCalled();
    upstreamSpy.mockRestore();
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

  it('supports missing idempotency key in stream mode with no persistence', async () => {
    const idemStartSpy = vi.spyOn(runtimeModule.runtime.services.idempotency, 'start');
    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'msg_stream_nokey', usage: { input_tokens: 3, output_tokens: 2 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );

    const req = createMockReq({
      method: 'POST',
      path: '/v1/messages',
      headers: { authorization: 'Bearer in_test_token', 'content-type': 'application/json' },
      body: { model: 'claude-opus-4-6', stream: true, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);
    await invoke(handlers[2], req, res);

    expect(res.statusCode).toBe(200);
    expect(String(res.body)).toContain('event: message_start');
    expect(String(res.body)).toContain('event: message_stop');
    expect(idemStartSpy).not.toHaveBeenCalled();
    expect(upstreamSpy).toHaveBeenCalledTimes(1);

    upstreamSpy.mockRestore();
  });

  it('keeps 200 SSE response when synthetic-bridge post-end bookkeeping fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(runtimeModule.runtime.services.metering, 'recordUsage').mockRejectedValue(new Error('metering failed'));
    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'msg_stream_1', usage: { input_tokens: 10, output_tokens: 10 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );

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

    expect(res.statusCode).toBe(200);
    expect(String(res.body)).toContain('event: message_start');
    expect(String(res.body)).toContain('event: message_stop');
    expect(warnSpy).toHaveBeenCalled();
    upstreamSpy.mockRestore();
    warnSpy.mockRestore();
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

  it('preserves inbound anthropic-version and anthropic-beta headers to upstream', async () => {
    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'msg_headers_1', usage: { input_tokens: 5, output_tokens: 5 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );

    const req = createMockReq({
      method: 'POST',
      path: '/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'anthropic-version': '2024-10-22',
        'anthropic-beta': 'foo-2026-01-01,bar-2026-02-02'
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

    const fetchArgs = upstreamSpy.mock.calls[0];
    const headers = (fetchArgs?.[1] as RequestInit)?.headers as Record<string, string>;
    expect(headers['anthropic-version']).toBe('2024-10-22');
    expect(headers['anthropic-beta']).toContain('foo-2026-01-01');
    expect(headers['anthropic-beta']).toContain('bar-2026-02-02');
    expect(res.statusCode).toBe(200);

    upstreamSpy.mockRestore();
  });

  it('passes through upstream 5xx status/body for compat route after exhausting all credentials', async () => {
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'listActiveForRouting').mockImplementation(async (_orgId: string, provider: string) => {
      if (provider !== 'anthropic') return [];
      return [
      {
        id: 'cred-5xx-a',
        orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
        provider: 'anthropic',
        authScheme: 'bearer',
        accessToken: 'sk-ant-oat01-first',
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
      } as any,
      {
        id: 'cred-5xx-b',
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
      ];
    });

    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
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

    // Both credentials should be tried before returning the terminal 5xx
    expect(upstreamSpy).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(503);
    expect((res.body as any).error?.type).toBe('api_error');

    upstreamSpy.mockRestore();
  });

  it('normalizes thinking.enabled budget_tokens to 1024 when missing', async () => {
    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'msg_thinking_1', usage: { input_tokens: 5, output_tokens: 5 } }), {
        status: 200,
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
        max_tokens: 2048,
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'enabled' }
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);
    await invoke(handlers[2], req, res);

    expect(res.statusCode).toBe(200);
    expect(upstreamSpy).toHaveBeenCalledTimes(1);
    const fetchArgs = upstreamSpy.mock.calls[0];
    const body = JSON.parse(String((fetchArgs?.[1] as RequestInit)?.body ?? '{}'));
    expect(body.thinking?.type).toBe('enabled');
    expect(body.thinking?.budget_tokens).toBe(1024);

    upstreamSpy.mockRestore();
  });

  it('returns deterministic 400 when thinking budget_tokens is >= max_tokens', async () => {
    const upstreamSpy = vi.spyOn(globalThis, 'fetch');
    const req = createMockReq({
      method: 'POST',
      path: '/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json'
      },
      body: {
        model: 'claude-opus-4-6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'enabled', budget_tokens: 1024 }
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);
    await invoke(handlers[2], req, res);

    expect(res.statusCode).toBe(400);
    expect((res.body as any).code).toBe('invalid_request');
    expect(String((res.body as any).message)).toContain('thinking.enabled requires max_tokens');
    expect(upstreamSpy).not.toHaveBeenCalled();

    upstreamSpy.mockRestore();
  });

  it('normalizes thinking budget_tokens below 1024 up to 1024', async () => {
    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'msg_thinking_2', usage: { input_tokens: 4, output_tokens: 6 } }), {
        status: 200,
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
        max_tokens: 4096,
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'enabled', budget_tokens: 32 }
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);
    await invoke(handlers[2], req, res);

    expect(res.statusCode).toBe(200);
    expect(upstreamSpy).toHaveBeenCalledTimes(1);
    const fetchArgs = upstreamSpy.mock.calls[0];
    const body = JSON.parse(String((fetchArgs?.[1] as RequestInit)?.body ?? '{}'));
    expect(body.thinking?.budget_tokens).toBe(1024);

    upstreamSpy.mockRestore();
  });

  it('returns deterministic 400 when thinking budget_tokens is not a positive integer', async () => {
    const upstreamSpy = vi.spyOn(globalThis, 'fetch');
    const req = createMockReq({
      method: 'POST',
      path: '/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json'
      },
      body: {
        model: 'claude-opus-4-6',
        max_tokens: 4096,
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'enabled', budget_tokens: 1024.5 }
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);
    await invoke(handlers[2], req, res);

    expect(res.statusCode).toBe(400);
    expect((res.body as any).code).toBe('invalid_request');
    expect(String((res.body as any).message)).toContain('positive integer');
    expect(upstreamSpy).not.toHaveBeenCalled();

    upstreamSpy.mockRestore();
  });

  it('returns deterministic 400 when thinking budget_tokens is >= max_output_tokens', async () => {
    const upstreamSpy = vi.spyOn(globalThis, 'fetch');
    const req = createMockReq({
      method: 'POST',
      path: '/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json'
      },
      body: {
        model: 'claude-opus-4-6',
        max_output_tokens: 1024,
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'enabled', budget_tokens: 1024 }
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);
    await invoke(handlers[2], req, res);

    expect(res.statusCode).toBe(400);
    expect((res.body as any).code).toBe('invalid_request');
    expect(String((res.body as any).message)).toContain('max_tokens');
    expect(upstreamSpy).not.toHaveBeenCalled();

    upstreamSpy.mockRestore();
  });

  it('normalizes tool_choice string to object for compat requests', async () => {
    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'msg_tool_choice_1', usage: { input_tokens: 3, output_tokens: 4 } }), {
        status: 200,
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
        max_tokens: 256,
        messages: [{ role: 'user', content: 'hi' }],
        tool_choice: 'auto'
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);
    await invoke(handlers[2], req, res);

    expect(res.statusCode).toBe(200);
    expect(upstreamSpy).toHaveBeenCalledTimes(1);
    const fetchArgs = upstreamSpy.mock.calls[0];
    const body = JSON.parse(String((fetchArgs?.[1] as RequestInit)?.body ?? '{}'));
    expect(body.tool_choice).toEqual({ type: 'auto' });

    upstreamSpy.mockRestore();
  });

  it('retries once with sanitized beta headers when upstream returns policy-blocked 403', async () => {
    const upstreamSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'Your request was blocked.' }
      }), {
        status: 403,
        headers: { 'content-type': 'application/json' }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'msg_retry_ok',
        usage: { input_tokens: 5, output_tokens: 6 }
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      }));

    const req = createMockReq({
      method: 'POST',
      path: '/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'anthropic-beta': 'oauth-2025-04-20,claude-code-20250219'
      },
      body: {
        model: 'claude-opus-4-6',
        max_tokens: 2048,
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'enabled', budget_tokens: 1024 }
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);
    await invoke(handlers[2], req, res);

    expect(res.statusCode).toBe(200);
    expect(upstreamSpy).toHaveBeenCalledTimes(2);
    const firstHeaders = (upstreamSpy.mock.calls[0]?.[1] as RequestInit)?.headers as Record<string, string>;
    const secondHeaders = (upstreamSpy.mock.calls[1]?.[1] as RequestInit)?.headers as Record<string, string>;
    const firstBody = JSON.parse(String((upstreamSpy.mock.calls[0]?.[1] as RequestInit)?.body ?? '{}'));
    const secondBody = JSON.parse(String((upstreamSpy.mock.calls[1]?.[1] as RequestInit)?.body ?? '{}'));
    expect(firstHeaders['anthropic-beta']).toContain('oauth-2025-04-20');
    expect(firstHeaders['anthropic-beta']).toContain('claude-code-20250219');
    expect(secondHeaders['anthropic-beta']).toBeUndefined();
    expect(firstBody.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
    expect(secondBody.thinking).toBeUndefined();

    upstreamSpy.mockRestore();
  });

  it('passes through blocked 403 when compat retry is still blocked', async () => {
    const upstreamSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'Your request was blocked.' }
      }), {
        status: 403,
        headers: { 'content-type': 'application/json' }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'Your request was blocked.' }
      }), {
        status: 403,
        headers: { 'content-type': 'application/json' }
      }));

    const req = createMockReq({
      method: 'POST',
      path: '/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'anthropic-beta': 'oauth-2025-04-20,claude-code-20250219'
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

    expect(upstreamSpy).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(403);
    expect((res.body as any).error?.message).toContain('blocked');

    upstreamSpy.mockRestore();
  });

  it('retries blocked 403 once in stream mode with thinking stripped', async () => {
    const upstreamSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'Your request was blocked.' }
      }), {
        status: 403,
        headers: { 'content-type': 'application/json' }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'msg_stream_retry_ok',
        usage: { input_tokens: 9, output_tokens: 8 }
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      }));

    const req = createMockReq({
      method: 'POST',
      path: '/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'anthropic-beta': 'oauth-2025-04-20,claude-code-20250219'
      },
      body: {
        model: 'claude-opus-4-6',
        stream: true,
        max_tokens: 2048,
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'enabled', budget_tokens: 1024 }
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);
    await invoke(handlers[2], req, res);

    expect(res.statusCode).toBe(200);
    expect(upstreamSpy).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String((upstreamSpy.mock.calls[0]?.[1] as RequestInit)?.body ?? '{}'));
    const secondBody = JSON.parse(String((upstreamSpy.mock.calls[1]?.[1] as RequestInit)?.body ?? '{}'));
    expect(firstBody.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
    expect(secondBody.thinking).toBeUndefined();

    upstreamSpy.mockRestore();
  });

  it('retries once on oauth-incompatible 401 with oauth-safe payload on /v1/messages', async () => {
    const retryAuditSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const upstreamSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        type: 'error',
        error: { type: 'authentication_error', message: 'OAuth authentication is currently not supported.' }
      }), {
        status: 401,
        headers: { 'content-type': 'application/json' }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'msg_oauth_retry_ok',
        usage: { input_tokens: 7, output_tokens: 9 }
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      }));

    const req = createMockReq({
      method: 'POST',
      path: '/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14'
      },
      body: {
        model: 'claude-opus-4-6',
        stream: true,
        max_tokens: 256,
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'x', description: 'x', input_schema: { type: 'object', properties: {} } }],
        tool_choice: 'auto'
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);
    await invoke(handlers[2], req, res);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(String(res.body)).toContain('event: message_start');
    expect(String(res.body)).toContain('event: message_stop');
    expect(upstreamSpy).toHaveBeenCalledTimes(2);

    const firstHeaders = (upstreamSpy.mock.calls[0]?.[1] as RequestInit)?.headers as Record<string, string>;
    const secondHeaders = (upstreamSpy.mock.calls[1]?.[1] as RequestInit)?.headers as Record<string, string>;
    const firstBody = JSON.parse(String((upstreamSpy.mock.calls[0]?.[1] as RequestInit)?.body ?? '{}'));
    const secondBody = JSON.parse(String((upstreamSpy.mock.calls[1]?.[1] as RequestInit)?.body ?? '{}'));

    expect(firstHeaders.authorization).toBe('Bearer sk-ant-oat01-test-token');
    expect(firstHeaders['anthropic-beta']).toContain('fine-grained-tool-streaming-2025-05-14');
    expect(firstBody.stream).toBe(true);
    expect(firstBody.tools).toBeDefined();
    expect(firstBody.tool_choice).toEqual({ type: 'auto' });

    expect(secondHeaders.authorization).toBe('Bearer sk-ant-oat01-test-token');
    expect(secondHeaders['anthropic-beta']).toContain('oauth-2025-04-20');
    expect(secondHeaders['anthropic-beta']).toContain('claude-code-20250219');
    expect(secondBody.stream).toBe(true);
    expect(secondBody.tools).toBeDefined();
    expect(secondBody.tool_choice).toEqual({ type: 'auto' });
    const retryCalls = retryAuditSpy.mock.calls.filter((c) => c[0] === '[retry-audit] attempt');
    expect(retryCalls.length).toBeGreaterThan(0);
    const retryAudit = retryCalls[0]?.[1] as any;
    expect(retryAudit?.retry_reason).toBe('oauth_401_compat_retry');
    expect(retryAudit?.org_id).toBe('818d0cc7-7ed2-469f-b690-a977e72a921d');
    expect(retryAudit?.model).toBe('claude-opus-4-6');
    expect(String(retryAudit?.openclaw_run_id ?? '')).toMatch(/^run_req_/);

    retryAuditSpy.mockRestore();
    upstreamSpy.mockRestore();
  });

  // --- Translated compat error mapping tests ---

  it('returns anthropic-shaped 401 when translated openai path returns 401', async () => {
    const oauthToken = createFakeOpenAiOauthToken();
    vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'findActiveByHash').mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      org_id: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      scope: 'buyer_proxy',
      is_active: true,
      expires_at: null,
      preferred_provider: 'openai'
    } as any);
    vi.spyOn(runtimeModule.runtime.repos.modelCompatibility, 'findActive').mockImplementation(async (provider: string) => {
      if (provider === 'openai') return { provider: 'openai', model: 'gpt-5.4', supports_streaming: false } as any;
      if (provider === 'anthropic') return { provider: 'anthropic', model: 'claude-opus-4-6', supports_streaming: false } as any;
      return null as any;
    });
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'listActiveForRouting').mockImplementation(async (_orgId: string, provider: string) => {
      if (provider === 'openai') return [{
        id: 'err-401-cred',
        orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
        provider: 'openai',
        authScheme: 'bearer',
        accessToken: oauthToken,
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
      return [];
    });

    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ error: { message: 'invalid api key' } }),
      { status: 401, headers: { 'content-type': 'application/json' } }
    ));

    const req = createMockReq({
      method: 'POST',
      path: '/v1/messages',
      headers: { authorization: 'Bearer in_test', 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: { model: 'claude-opus-4-6', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);
    await invoke(handlers[2], req, res);

    // Compat error envelope: openai 401 → credential exhaustion → fallback to anthropic (no creds) → capacity error
    // The key assertion: error is anthropic-shaped, NOT innies-native
    const body = res.body as any;
    expect(body?.type).toBe('error');
    expect(typeof body?.error?.type).toBe('string');
    expect(typeof body?.error?.message).toBe('string');
    upstreamSpy.mockRestore();
  });

  it('returns anthropic-shaped 429 when translated openai path returns 429', async () => {
    const oauthToken = createFakeOpenAiOauthToken();
    vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'findActiveByHash').mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      org_id: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      scope: 'buyer_proxy',
      is_active: true,
      expires_at: null,
      preferred_provider: 'openai'
    } as any);
    vi.spyOn(runtimeModule.runtime.repos.modelCompatibility, 'findActive').mockImplementation(async (provider: string) => {
      if (provider === 'openai') return { provider: 'openai', model: 'gpt-5.4', supports_streaming: false } as any;
      if (provider === 'anthropic') return { provider: 'anthropic', model: 'claude-opus-4-6', supports_streaming: false } as any;
      return null as any;
    });
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'listActiveForRouting').mockImplementation(async (_orgId: string, provider: string) => {
      if (provider === 'openai') return [{
        id: 'err-429-cred',
        orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
        provider: 'openai',
        authScheme: 'bearer',
        accessToken: oauthToken,
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
      return [];
    });

    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ error: { message: 'rate limited' } }),
      { status: 429, headers: { 'content-type': 'application/json' } }
    ));

    const req = createMockReq({
      method: 'POST',
      path: '/v1/messages',
      headers: { authorization: 'Bearer in_test', 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: { model: 'claude-opus-4-6', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);
    await invoke(handlers[2], req, res);

    // Compat error envelope: all errors on translated paths are anthropic-shaped
    const body = res.body as any;
    expect(body?.type).toBe('error');
    expect(typeof body?.error?.type).toBe('string');
    expect(typeof body?.error?.message).toBe('string');
    upstreamSpy.mockRestore();
  });

  it('returns anthropic-shaped 500 when translated openai path returns 502', async () => {
    const oauthToken = createFakeOpenAiOauthToken();
    vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'findActiveByHash').mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      org_id: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      scope: 'buyer_proxy',
      is_active: true,
      expires_at: null,
      preferred_provider: 'openai'
    } as any);
    vi.spyOn(runtimeModule.runtime.repos.modelCompatibility, 'findActive').mockImplementation(async (provider: string) => {
      if (provider === 'openai') return { provider: 'openai', model: 'gpt-5.4', supports_streaming: false } as any;
      if (provider === 'anthropic') return { provider: 'anthropic', model: 'claude-opus-4-6', supports_streaming: false } as any;
      return null as any;
    });
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'listActiveForRouting').mockImplementation(async (_orgId: string, provider: string) => {
      if (provider === 'openai') return [{
        id: 'err-502-cred',
        orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
        provider: 'openai',
        authScheme: 'bearer',
        accessToken: oauthToken,
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
      return [];
    });

    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ error: { message: 'bad gateway' } }),
      { status: 502, headers: { 'content-type': 'application/json' } }
    ));

    const req = createMockReq({
      method: 'POST',
      path: '/v1/messages',
      headers: { authorization: 'Bearer in_test', 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: { model: 'claude-opus-4-6', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);
    await invoke(handlers[2], req, res);

    // Compat error envelope: all terminal errors are anthropic-shaped, never innies-native
    const body = res.body as any;
    expect(body?.type).toBe('error');
    expect(typeof body?.error?.type).toBe('string');
    expect(typeof body?.error?.message).toBe('string');
    upstreamSpy.mockRestore();
  });

  it('non-streaming: fails over to second credential when first returns 5xx (strict passthrough)', async () => {
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'listActiveForRouting').mockImplementation(async (_orgId: string, provider: string) => {
      if (provider !== 'anthropic') return [];
      return [
      {
        id: 'cred-failover-a',
        orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
        provider: 'anthropic',
        authScheme: 'bearer',
        accessToken: 'sk-ant-oat01-first',
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
      } as any,
      {
        id: 'cred-failover-b',
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
      ];
    });

    const upstreamSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message: 'upstream outage' }
      }), {
        status: 500,
        headers: { 'content-type': 'application/json' }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'msg_ok',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
        usage: { input_tokens: 5, output_tokens: 3 }
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      }));

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

    expect(upstreamSpy).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(200);
    expect((res.body as any).id).toBe('msg_ok');

    upstreamSpy.mockRestore();
  });

  it('streaming: fails over to second credential when first returns 5xx (strict passthrough)', async () => {
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'listActiveForRouting').mockImplementation(async (_orgId: string, provider: string) => {
      if (provider !== 'anthropic') return [];
      return [
      {
        id: 'cred-stream-a',
        orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
        provider: 'anthropic',
        authScheme: 'bearer',
        accessToken: 'sk-ant-oat01-first',
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
      } as any,
      {
        id: 'cred-stream-b',
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
      ];
    });

    const upstreamSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message: 'upstream outage' }
      }), {
        status: 502,
        headers: { 'content-type': 'application/json' }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'msg_stream_ok',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'streamed' }],
        usage: { input_tokens: 5, output_tokens: 3 }
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      }));

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
        stream: true,
        messages: [{ role: 'user', content: 'hi' }]
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);
    await invoke(handlers[2], req, res);

    expect(upstreamSpy).toHaveBeenCalledTimes(2);

    upstreamSpy.mockRestore();
  });

  it('terminal 5xx passthrough: returns raw 5xx body when all credentials exhausted and no provider fallback', async () => {
    // Pin to anthropic only (no fallback provider)
    vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'findActiveByHash').mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      org_id: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      scope: 'buyer_proxy',
      is_active: true,
      expires_at: null,
      preferred_provider: 'anthropic'
    } as any);
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'listActiveForRouting').mockImplementation(async (_orgId: string, provider: string) => {
      if (provider !== 'anthropic') return [];
      return [{
        id: 'cred-terminal-a',
        orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
        provider: 'anthropic',
        authScheme: 'bearer',
        accessToken: 'sk-ant-oat01-only',
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
        type: 'error',
        error: { type: 'api_error', message: 'service unavailable' }
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

    expect(res.statusCode).toBe(503);
    expect((res.body as any).type).toBe('error');
    expect((res.body as any).error?.type).toBe('api_error');
    expect((res.body as any).error?.message).toBe('service unavailable');

    upstreamSpy.mockRestore();
  });

  it('cross-provider fallback: exhausts anthropic credentials then falls back to openai', async () => {
    setupTranslatedCompatOpenAiRoute(runtimeModule);

    // Override to provide both anthropic and openai credentials
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'listActiveForRouting').mockImplementation(async (_orgId: string, provider: string) => {
      if (provider === 'anthropic') {
        return [{
          id: 'cred-anthro-fallback',
          orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
          provider: 'anthropic',
          authScheme: 'bearer',
          accessToken: 'sk-ant-oat01-anthro',
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
      if (provider === 'openai') {
        return [{
          id: 'openai-compat-cred',
          orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
          provider: 'openai',
          authScheme: 'bearer',
          accessToken: createFakeOpenAiOauthToken(),
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

    // Anthropic call: 500, OpenAI call: 200
    const upstreamSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message: 'anthropic outage' }
      }), {
        status: 500,
        headers: { 'content-type': 'application/json' }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'resp_openai_fallback',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'openai response' }] }],
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 }
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      }));

    const req = createMockReq({
      method: 'POST',
      path: '/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01'
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

    // First call was Anthropic (5xx), second call was OpenAI (200)
    expect(upstreamSpy).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(200);

    upstreamSpy.mockRestore();
  });
});
