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

function parseChunkedJsonLog(calls: Array<any[]>, label: string): any {
  const chunks = calls
    .filter((call) => call[0] === label)
    .map((call) => call[1] as { chunk_index?: number; json?: string })
    .sort((a, b) => Number(a.chunk_index ?? 0) - Number(b.chunk_index ?? 0));
  if (chunks.length === 0) {
    throw new Error(`missing chunked log: ${label}`);
  }
  return JSON.parse(chunks.map((chunk) => String(chunk.json ?? '')).join(''));
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
    delete process.env.INNIES_ENABLE_UPSTREAM_DEBUG_HEADERS;
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

  it('logs redacted compat debug context for anthropic upstream invalid_request_error passthroughs', async () => {
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'listActiveForRouting').mockResolvedValue([{
      id: 'debug-cred',
      orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      provider: 'anthropic',
      authScheme: 'bearer',
      accessToken: 'sk-ant-oat01-debug-token',
      refreshToken: null,
      expiresAt: new Date('2026-03-02T00:00:00Z'),
      status: 'active',
      rotationVersion: 1,
      createdAt: new Date('2026-03-01T00:00:00Z'),
      updatedAt: new Date('2026-03-01T00:00:00Z'),
      revokedAt: null,
      monthlyContributionLimitUnits: null,
      monthlyContributionUsedUnits: 0,
      monthlyWindowStartAt: new Date('2026-03-01T00:00:00Z'),
      debugLabel: 'shirtless'
    } as any]);

    const compatDebugSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'Error' }
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
        'content-type': 'application/json',
        'x-request-id': 'req_test_invalid_400',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14'
      },
      body: {
        model: 'claude-opus-4-6',
        stream: true,
        max_tokens: 4096,
        system: 'top-secret-system',
        messages: [
          { role: 'assistant', content: 'prior assistant content' },
          { role: 'user', content: [{ type: 'text', text: 'secret prompt' }] }
        ],
        tools: [{ name: 'lookup', description: 'sensitive tool config', input_schema: { type: 'object' } }],
        tool_choice: 'auto',
        thinking: { type: 'enabled', budget_tokens: 2048 },
        metadata: { secret: 'value' }
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);
    await invoke(handlers[2], req, res);

    expect(res.statusCode).toBe(400);
    const compatDebugCalls = compatDebugSpy.mock.calls.filter((call) => call[0] === '[compat-invalid-request-debug]');
    expect(compatDebugCalls).toHaveLength(1);
    const compatPayloadCalls = compatDebugSpy.mock.calls.filter((call) => call[0] === '[compat-invalid-request-payload-json]');
    expect(compatPayloadCalls).toHaveLength(1);
    const compatPayloadJson = JSON.parse(String(compatPayloadCalls[0]?.[1] ?? '{}'));
    expect(compatPayloadJson.request_id).toBe('req_test_invalid_400');
    expect(JSON.stringify(compatPayloadJson.payload)).toContain('secret prompt');
    expect(JSON.stringify(compatPayloadJson.payload)).toContain('top-secret-system');
    const compatPayloadChunked = parseChunkedJsonLog(compatDebugSpy.mock.calls, '[compat-invalid-request-payload-json-chunk]');
    expect(compatPayloadChunked.request_id).toBe('req_test_invalid_400');
    expect(JSON.stringify(compatPayloadChunked.payload)).toContain('secret prompt');
    expect(JSON.stringify(compatPayloadChunked.payload)).toContain('top-secret-system');

    const compatDebugPayload = compatDebugCalls[0]?.[1] as any;
    expect(compatDebugPayload).toMatchObject({
      request_id: 'req_test_invalid_400',
      credential_id: 'debug-cred',
      credential_label: 'shirtless',
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      proxied_path: '/v1/messages',
      anthropic_version: '2023-06-01',
      anthropic_beta: 'fine-grained-tool-streaming-2025-05-14',
      upstream_status: 400,
      upstream_error_type: 'invalid_request_error',
      upstream_error_message: 'Error',
      request_shape: {
        stream: true,
        message_count: 2,
        assistant_message_count: 1,
        last_message_role: 'user',
        last_message_content_types: ['text'],
        assistant_prefill_suspected: false,
        system_present: true,
        tool_count: 1,
        tool_result_block_count: 0,
        tool_choice_present: true,
        tool_choice_type: 'auto',
        thinking_present: true,
        thinking_type: 'enabled',
        thinking_budget_tokens: 2048,
        assistant_thinking_block_count: 0,
        assistant_tool_use_block_count: 0,
        max_tokens: 4096,
        max_output_tokens: null,
        metadata_present: true,
        history_analysis: {
          missing_tool_use_id_message_indexes: [],
          missing_tool_result_id_message_indexes: [],
          tool_result_after_non_tool_result_message_indexes: [],
          orphan_tool_result_message_indexes: [],
          tool_result_adjacency_violations: [],
          tool_result_id_mismatch_violations: [],
          unsigned_thinking_with_tool_use_message_indexes: [],
          pending_tool_use_message_index: null,
          pending_tool_use_ids: null
        }
      }
    });
    const compatDebugChunked = parseChunkedJsonLog(compatDebugSpy.mock.calls, '[compat-invalid-request-debug-json-chunk]');
    expect(compatDebugChunked.request_shape.message_trace_tail).toMatchObject([
      {
        index: 0,
        role: 'assistant',
        content_kind: 'string'
      },
      {
        index: 1,
        role: 'user',
        content_kind: 'array'
      }
    ]);
    expect(compatDebugPayload.request_shape.message_trace_tail).toMatchObject([
      {
        index: 0,
        role: 'assistant',
        content_kind: 'string',
        string_chars: 23,
        block_count: 0,
        block_types: [],
        text_block_count: 0,
        text_chars: 23,
        tool_use_ids: [],
        tool_result_ids: [],
        thinking_block_count: 0,
        thinking_signature_count: 0,
        thinking_signature_missing_count: 0
      },
      {
        index: 1,
        role: 'user',
        content_kind: 'array',
        string_chars: null,
        block_count: 1,
        block_types: ['text'],
        text_block_count: 1,
        text_chars: 13,
        tool_use_ids: [],
        tool_result_ids: [],
        thinking_block_count: 0,
        thinking_signature_count: 0,
        thinking_signature_missing_count: 0
      }
    ]);
    const upstreamRequestChunked = parseChunkedJsonLog(compatDebugSpy.mock.calls, '[compat-upstream-request-json-chunk]');
    expect(upstreamRequestChunked).toMatchObject({
      request_id: 'req_test_invalid_400',
      attempt_no: 1,
      credential_id: 'debug-cred',
      credential_label: 'shirtless',
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      proxied_path: '/v1/messages',
      method: 'POST',
      target_url: 'https://api.anthropic.com/v1/messages'
    });
    expect(JSON.stringify(upstreamRequestChunked.payload)).toContain('secret prompt');
    expect(JSON.stringify(upstreamRequestChunked.payload)).toContain('top-secret-system');
    expect(String(upstreamRequestChunked.headers.authorization)).toContain('redacted');
    expect(String(upstreamRequestChunked.headers.authorization)).not.toContain('sk-ant-oat01-debug-token');

    const upstreamResponseChunked = parseChunkedJsonLog(compatDebugSpy.mock.calls, '[compat-upstream-response-json-chunk]');
    expect(upstreamResponseChunked).toMatchObject({
      request_id: 'req_test_invalid_400',
      attempt_no: 1,
      credential_id: 'debug-cred',
      credential_label: 'shirtless',
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      proxied_path: '/v1/messages',
      upstream_status: 400,
      upstream_content_type: 'application/json'
    });
    expect(String(upstreamResponseChunked.raw_body_text)).toContain('"invalid_request_error"');
    expect(upstreamResponseChunked.parsed_body).toEqual({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'Error'
      }
    });

    const serializedPayload = JSON.stringify(compatDebugPayload);
    expect(serializedPayload).not.toContain('top-secret-system');
    expect(serializedPayload).not.toContain('secret prompt');
    expect(serializedPayload).not.toContain('prior assistant content');
    expect(serializedPayload).not.toContain('sensitive tool config');

    upstreamSpy.mockRestore();
    compatDebugSpy.mockRestore();
  });

  it('logs redacted local validation context when compat request is rejected before upstream', async () => {
    const localValidationSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'msg_unused', usage: { input_tokens: 1, output_tokens: 1 } }), {
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
        'x-request-id': 'req_test_local_validation_400',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14'
      },
      body: {
        model: 'claude-opus-4-6',
        stream: true,
        max_tokens: 4096,
        thinking: { type: 'adaptive' },
        messages: [
          { role: 'user', content: 'start' },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'private reasoning without signature' },
              { type: 'tool_use', id: 'toolu_local_validation_1', name: 'lookup', input: {} }
            ]
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'not first' },
              { type: 'tool_result', tool_use_id: 'toolu_local_validation_1', content: 'done' }
            ]
          }
        ]
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);
    await invoke(handlers[2], req, res);

    expect(res.statusCode).toBe(400);
    expect(upstreamSpy).not.toHaveBeenCalled();

    const validationCalls = localValidationSpy.mock.calls.filter((call) => call[0] === '[compat-local-validation-failed]');
    expect(validationCalls).toHaveLength(1);
    const validationPayloadCalls = localValidationSpy.mock.calls.filter((call) => call[0] === '[compat-local-validation-payload-json]');
    expect(validationPayloadCalls).toHaveLength(1);
    const validationPayloadJson = JSON.parse(String(validationPayloadCalls[0]?.[1] ?? '{}'));
    expect(validationPayloadJson.request_id).toBe('req_test_local_validation_400');
    expect(JSON.stringify(validationPayloadJson.payload)).toContain('private reasoning without signature');
    expect(JSON.stringify(validationPayloadJson.payload)).toContain('not first');
    const validationPayloadChunked = parseChunkedJsonLog(localValidationSpy.mock.calls, '[compat-local-validation-payload-json-chunk]');
    expect(validationPayloadChunked.request_id).toBe('req_test_local_validation_400');
    expect(JSON.stringify(validationPayloadChunked.payload)).toContain('private reasoning without signature');
    expect(JSON.stringify(validationPayloadChunked.payload)).toContain('not first');

    const validationPayload = validationCalls[0]?.[1] as any;
    expect(validationPayload).toMatchObject({
      request_id: 'req_test_local_validation_400',
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      proxied_path: '/v1/messages',
      anthropic_version: '2023-06-01',
      anthropic_beta: 'fine-grained-tool-streaming-2025-05-14',
      validation_message: 'assistant thinking blocks preserved with thinking.type="adaptive" must include signature',
      request_shape: {
        message_count: 3,
        history_analysis: {
          tool_result_after_non_tool_result_message_indexes: [2],
          unsigned_thinking_with_tool_use_message_indexes: [1]
        }
      }
    });
    const validationChunked = parseChunkedJsonLog(localValidationSpy.mock.calls, '[compat-local-validation-failed-json-chunk]');
    expect(validationChunked.request_shape.history_analysis).toMatchObject({
      tool_result_after_non_tool_result_message_indexes: [2],
      unsigned_thinking_with_tool_use_message_indexes: [1]
    });

    const serializedPayload = JSON.stringify(validationPayload);
    expect(serializedPayload).not.toContain('private reasoning without signature');
    expect(serializedPayload).not.toContain('not first');

    upstreamSpy.mockRestore();
    localValidationSpy.mockRestore();
  });

  it('preserves inbound anthropic-version and anthropic-beta headers while adding oauth beta upstream', async () => {
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
    expect(headers['anthropic-beta']).toContain('oauth-2025-04-20');
    expect(headers['anthropic-beta']).not.toContain('claude-code-20250219');
    expect(headers['anthropic-beta']).not.toContain('interleaved-thinking-2025-05-14');
    expect(res.statusCode).toBe(200);

    upstreamSpy.mockRestore();
  });

  it('returns first-pass upstream lane debug headers on compat SSE responses when explicitly enabled', async () => {
    process.env.ANTHROPIC_UPSTREAM_BASE_URL = 'https://anthropic.internal.test';
    process.env.INNIES_ENABLE_UPSTREAM_DEBUG_HEADERS = 'true';

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
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14',
        'x-innies-debug-upstream-lane': '1'
      },
      body: {
        model: 'claude-opus-4-6',
        stream: true,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'hi' }]
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);
    await invoke(handlers[2], req, res);

    expect(upstreamSpy).toHaveBeenCalledTimes(1);
    expect(res.headers['x-innies-debug-upstream-target-url']).toBe('https://anthropic.internal.test/v1/messages');
    expect(res.headers['x-innies-debug-upstream-proxied-path']).toBe('/v1/messages');
    expect(res.headers['x-innies-debug-upstream-provider']).toBe('anthropic');
    expect(res.headers['x-innies-debug-upstream-stream']).toBe('true');
    expect(res.headers['x-innies-debug-upstream-token-kind']).toBe('anthropic_oauth');
    expect(res.headers['x-innies-debug-upstream-authorization']).toBe('Bearer <redacted:23>');
    expect(res.headers['x-innies-debug-upstream-anthropic-version']).toBe('2023-06-01');
    expect(res.headers['x-innies-debug-upstream-anthropic-beta']).toBe('fine-grained-tool-streaming-2025-05-14,oauth-2025-04-20');
    expect(res.headers['x-innies-debug-upstream-accept']).toBe('text/event-stream');
    expect(res.headers['x-innies-debug-upstream-request-id']).toMatch(/^req_/);
    expect(res.headers['x-innies-debug-upstream-header-names']).toBe(
      'accept,anthropic-beta,anthropic-version,authorization,content-type,x-request-id'
    );
    expect(String(res.body)).toContain('event: message_start');

    upstreamSpy.mockRestore();
  });

  it('fails over to second credential on upstream 5xx for compat route (non-streaming)', async () => {
    const anthropicCreds = [
      {
        id: 'cred-a',
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
        id: 'cred-b',
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
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'listActiveForRouting').mockImplementation(
      async (_orgId: string, provider: string) => provider === 'anthropic' ? anthropicCreds : []
    );
    const upstreamSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message: 'upstream outage' }
      }), {
        status: 503,
        headers: { 'content-type': 'application/json' }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'msg_ok',
        type: 'message',
        usage: { input_tokens: 5, output_tokens: 5 },
        content: [{ type: 'text', text: 'hello' }]
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

    const routingEventCalls = (runtimeModule.runtime.repos.routingEvents.insert as any).mock.calls
      .map(([event]: [any]) => event);
    const firstAttemptEvents = routingEventCalls.filter((event: any) => event.attemptNo === 1);

    expect(upstreamSpy).toHaveBeenCalledTimes(2);
    expect(routingEventCalls).toHaveLength(2);
    expect(firstAttemptEvents).toHaveLength(1);
    expect(firstAttemptEvents[0]).toMatchObject({
      attemptNo: 1,
      upstreamStatus: 503,
      errorCode: 'upstream_5xx_passthrough'
    });
    expect(res.statusCode).toBe(200);

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

  it('preserves adaptive thinking without injecting budget tokens', async () => {
    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'msg_thinking_adaptive', usage: { input_tokens: 7, output_tokens: 9 } }), {
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
        thinking: { type: 'adaptive' }
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
    expect(body.thinking).toEqual({ type: 'adaptive' });

    upstreamSpy.mockRestore();
  });

  it('returns deterministic 400 when extended thinking forces tool_choice tool', async () => {
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
        thinking: { type: 'adaptive' },
        tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
        tool_choice: { type: 'tool', name: 'lookup' }
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);
    await invoke(handlers[2], req, res);

    expect(res.statusCode).toBe(400);
    expect((res.body as any).type).toBe('error');
    expect((res.body as any).error?.type).toBe('invalid_request_error');
    expect(String((res.body as any).error?.message)).toContain('tool_choice');
    expect(String((res.body as any).error?.message)).toContain('"auto" or "none"');
    expect(upstreamSpy).not.toHaveBeenCalled();

    upstreamSpy.mockRestore();
  });

  it('returns deterministic 400 when extended thinking request ends with assistant prefill', async () => {
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
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'prefilled answer start' }
        ],
        thinking: { type: 'adaptive' }
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);
    await invoke(handlers[2], req, res);

    expect(res.statusCode).toBe(400);
    expect((res.body as any).type).toBe('error');
    expect((res.body as any).error?.type).toBe('invalid_request_error');
    expect(String((res.body as any).error?.message)).toContain('assistant prefill');
    expect(upstreamSpy).not.toHaveBeenCalled();

    upstreamSpy.mockRestore();
  });

  it('returns deterministic 400 when tool_result blocks are not first in a user message', async () => {
    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'msg_history_order_1', usage: { input_tokens: 5, output_tokens: 7 } }), {
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
        messages: [
          { role: 'user', content: 'start' },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_order_1', name: 'lookup', input: {} }]
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'result follows' },
              { type: 'tool_result', tool_use_id: 'toolu_order_1', content: 'done' }
            ]
          }
        ]
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);
    await invoke(handlers[2], req, res);

    expect(res.statusCode).toBe(400);
    expect((res.body as any).type).toBe('error');
    expect((res.body as any).error?.type).toBe('invalid_request_error');
    expect(String((res.body as any).error?.message)).toContain('tool_result');
    expect(String((res.body as any).error?.message)).toContain('first');
    expect(upstreamSpy).not.toHaveBeenCalled();

    upstreamSpy.mockRestore();
  });

  it('returns deterministic 400 when assistant tool_use is not immediately followed by user tool_result blocks', async () => {
    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'msg_history_gap_1', usage: { input_tokens: 5, output_tokens: 7 } }), {
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
        messages: [
          { role: 'user', content: 'start' },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_gap_1', name: 'lookup', input: {} }]
          },
          { role: 'user', content: 'waiting on tool output' }
        ]
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);
    await invoke(handlers[2], req, res);

    expect(res.statusCode).toBe(400);
    expect((res.body as any).type).toBe('error');
    expect((res.body as any).error?.type).toBe('invalid_request_error');
    expect(String((res.body as any).error?.message)).toContain('immediately follow');
    expect(String((res.body as any).error?.message)).toContain('tool_result');
    expect(upstreamSpy).not.toHaveBeenCalled();

    upstreamSpy.mockRestore();
  });

  it('returns deterministic 400 when extended thinking history includes unsigned assistant thinking blocks', async () => {
    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'msg_history_thinking_1', usage: { input_tokens: 5, output_tokens: 7 } }), {
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
        thinking: { type: 'adaptive' },
        messages: [
          { role: 'user', content: 'start' },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'private reasoning without signature' },
              { type: 'tool_use', id: 'toolu_think_1', name: 'lookup', input: {} }
            ]
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_think_1', content: 'done' }]
          }
        ]
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);
    await invoke(handlers[2], req, res);

    expect(res.statusCode).toBe(400);
    expect((res.body as any).type).toBe('error');
    expect((res.body as any).error?.type).toBe('invalid_request_error');
    expect(String((res.body as any).error?.message)).toContain('thinking');
    expect(String((res.body as any).error?.message)).toContain('signature');
    expect(upstreamSpy).not.toHaveBeenCalled();

    upstreamSpy.mockRestore();
  });

  it('allows valid extended thinking tool history when signed thinking is preserved and tool_result comes first', async () => {
    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'msg_history_valid_1', usage: { input_tokens: 5, output_tokens: 7 } }), {
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
        thinking: { type: 'adaptive' },
        messages: [
          { role: 'user', content: 'start' },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'private reasoning', signature: 'sig_history_valid_1' },
              { type: 'tool_use', id: 'toolu_valid_1', name: 'lookup', input: {} }
            ]
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_valid_1', content: 'done' },
              { type: 'text', text: 'please continue' }
            ]
          }
        ]
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);
    await invoke(handlers[2], req, res);

    expect(res.statusCode).toBe(200);
    expect(upstreamSpy).toHaveBeenCalledTimes(1);

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

  it('keeps default oauth betas on the first blocked-403 attempt when no inbound anthropic-beta header is present', async () => {
    const upstreamSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'Your request was blocked.' }
      }), {
        status: 403,
        headers: { 'content-type': 'application/json' }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'msg_blocked_default_beta_retry_ok',
        usage: { input_tokens: 4, output_tokens: 5 }
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

    expect(res.statusCode).toBe(200);
    expect(upstreamSpy).toHaveBeenCalledTimes(2);

    const firstHeaders = (upstreamSpy.mock.calls[0]?.[1] as RequestInit)?.headers as Record<string, string>;
    const secondHeaders = (upstreamSpy.mock.calls[1]?.[1] as RequestInit)?.headers as Record<string, string>;

    expect(firstHeaders['anthropic-beta']).toContain('fine-grained-tool-streaming-2025-05-14');
    expect(firstHeaders['anthropic-beta']).toContain('interleaved-thinking-2025-05-14');
    expect(firstHeaders['anthropic-beta']).toContain('oauth-2025-04-20');
    expect(firstHeaders['anthropic-beta']).toContain('claude-code-20250219');
    expect(secondHeaders['anthropic-beta']).toBeUndefined();

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
        max_tokens: 4096,
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'x', description: 'x', input_schema: { type: 'object', properties: {} } }],
        tool_choice: 'auto',
        thinking: { type: 'enabled', budget_tokens: 1024 }
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
    expect(firstHeaders['anthropic-beta']).toContain('oauth-2025-04-20');
    expect(firstHeaders['anthropic-beta']).not.toContain('claude-code-20250219');
    expect(firstHeaders['anthropic-beta']).not.toContain('interleaved-thinking-2025-05-14');
    expect(firstBody.stream).toBe(true);
    expect(firstBody.tools).toBeDefined();
    expect(firstBody.tool_choice).toEqual({ type: 'auto' });
    expect(firstBody.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });

    expect(secondHeaders.authorization).toBe('Bearer sk-ant-oat01-test-token');
    expect(secondHeaders['anthropic-beta']).toContain('fine-grained-tool-streaming-2025-05-14');
    expect(secondHeaders['anthropic-beta']).toContain('oauth-2025-04-20');
    expect(secondHeaders['anthropic-beta']).toContain('claude-code-20250219');
    expect(secondHeaders['anthropic-beta']).toContain('interleaved-thinking-2025-05-14');
    expect(secondBody.stream).toBe(true);
    expect(secondBody.tools).toBeDefined();
    expect(secondBody.tool_choice).toEqual({ type: 'auto' });
    expect(secondBody.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
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

  it('fails over to second credential on upstream 5xx for compat route (streaming)', async () => {
    const anthropicCreds = [
      {
        id: 'cred-a',
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
        id: 'cred-b',
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
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'listActiveForRouting').mockImplementation(
      async (_orgId: string, provider: string) => provider === 'anthropic' ? anthropicCreds : []
    );
    const upstreamSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message: 'upstream outage' }
      }), {
        status: 500,
        headers: { 'content-type': 'application/json' }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'msg_stream_ok',
        type: 'message',
        usage: { input_tokens: 5, output_tokens: 5 },
        content: [{ type: 'text', text: 'hello' }]
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
        stream: true,
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

    upstreamSpy.mockRestore();
  });

  it('returns terminal 5xx passthrough when all compat credentials fail (non-streaming)', async () => {
    const anthropicCreds = [
      {
        id: 'cred-a',
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
        id: 'cred-b',
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
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'listActiveForRouting').mockImplementation(
      async (_orgId: string, provider: string) => provider === 'anthropic' ? anthropicCreds : []
    );
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

    expect(upstreamSpy).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(503);
    expect((res.body as any).error?.type).toBe('api_error');

    upstreamSpy.mockRestore();
  });

  it('returns terminal 5xx passthrough when all compat credentials fail (streaming)', async () => {
    const anthropicCreds = [
      {
        id: 'cred-a',
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
        id: 'cred-b',
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
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'listActiveForRouting').mockImplementation(
      async (_orgId: string, provider: string) => provider === 'anthropic' ? anthropicCreds : []
    );
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
        stream: true,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }]
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);
    await invoke(handlers[2], req, res);

    expect(upstreamSpy).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(503);
    expect((res.body as any)?.error?.type).toBe('api_error');

    upstreamSpy.mockRestore();
  });

  it('does not change auth 401/403 retry behavior on compat route', async () => {
    const upstreamSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        type: 'error',
        error: { type: 'authentication_error', message: 'invalid x-api-key' }
      }), {
        status: 401,
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

    // 401 should still be handled as auth failure, not as a 5xx failover
    expect(res.statusCode).toBe(401);

    upstreamSpy.mockRestore();
  });
});
