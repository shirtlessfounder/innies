import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
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

describe('compat translation e2e', () => {
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
    process.env.ANTHROPIC_COMPAT_ENDPOINT_ENABLED = 'true';
    process.env.TOKEN_MODE_ENABLED_ORGS = '818d0cc7-7ed2-469f-b690-a977e72a921d';
    process.env.ANTHROPIC_COMPAT_MAX_MESSAGE_COUNT = '1000';
    process.env.ANTHROPIC_COMPAT_MAX_REQUEST_BYTES = '5000000';
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
    vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'touchLastUsed').mockResolvedValue(undefined);
    vi.spyOn(runtimeModule.runtime.repos.killSwitch, 'isDisabled').mockResolvedValue(false);
    vi.spyOn(runtimeModule.runtime.repos.modelCompatibility, 'findActive').mockImplementation(async (provider: string, model: string) => {
      if (provider === 'openai' && model === 'gpt-5.4') {
        return { provider: 'openai', model: 'gpt-5.4', supports_streaming: false } as any;
      }
      if (provider === 'anthropic' && model === 'claude-opus-4-6') {
        return { provider: 'anthropic', model: 'claude-opus-4-6', supports_streaming: false } as any;
      }
      return null as any;
    });
    vi.spyOn(runtimeModule.runtime.repos.routingEvents, 'insert').mockResolvedValue(undefined);
    vi.spyOn(runtimeModule.runtime.services.metering, 'recordUsage').mockResolvedValue({ id: 'u1', entry_type: 'usage' } as any);
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
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'addMonthlyContributionUsage').mockResolvedValue(true);
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'recordSuccess').mockResolvedValue(true);
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'recordFailureAndMaybeMax').mockResolvedValue({
      status: 'active',
      consecutiveFailures: 1
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
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_COMPAT_ENDPOINT_ENABLED;
    delete process.env.TOKEN_MODE_ENABLED_ORGS;
    delete process.env.ANTHROPIC_COMPAT_MAX_MESSAGE_COUNT;
    delete process.env.ANTHROPIC_COMPAT_MAX_REQUEST_BYTES;
    delete process.env.OPENAI_UPSTREAM_BASE_URL;
    delete process.env.COMPAT_CODEX_DEFAULT_MODEL;
    vi.restoreAllMocks();
  });

  it('round-trips tool_use ids across translated openai compat turns', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'resp_turn_1',
        status: 'completed',
        usage: { input_tokens: 7, output_tokens: 5 },
        output: [
          {
            type: 'function_call',
            id: 'fc_turn_1',
            call_id: 'call_compat_1',
            name: 'lookup_repo',
            arguments: '{"name":"innies"}'
          }
        ]
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'resp_turn_2',
        status: 'completed',
        usage: { input_tokens: 6, output_tokens: 4 },
        output: [
          {
            type: 'message',
            id: 'msg_turn_2',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'final answer' }]
          }
        ]
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      }));

    const req1 = createMockReq({
      method: 'POST',
      path: '/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01'
      },
      body: {
        model: 'claude-opus-4-6',
        max_tokens: 64,
        tools: [{ name: 'lookup_repo', description: 'lookup repo', input_schema: { type: 'object', properties: { name: { type: 'string' } } } }],
        tool_choice: { type: 'tool', name: 'lookup_repo' },
        messages: [{ role: 'user', content: 'look up innies' }]
      }
    });
    const res1 = createMockRes();

    await invoke(handlers[0], req1, res1);
    await invoke(handlers[1], req1, res1);
    await invoke(handlers[2], req1, res1);

    expect(res1.statusCode).toBe(200);
    expect((res1.body as any).content).toEqual([
      { type: 'tool_use', id: 'call_compat_1', name: 'lookup_repo', input: { name: 'innies' } }
    ]);

    const toolUseId = ((res1.body as any).content?.[0] as any)?.id;
    expect(toolUseId).toBe('call_compat_1');

    const req2 = createMockReq({
      method: 'POST',
      path: '/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01'
      },
      body: {
        model: 'claude-opus-4-6',
        max_tokens: 64,
        tools: [{ name: 'lookup_repo', description: 'lookup repo', input_schema: { type: 'object', properties: { name: { type: 'string' } } } }],
        tool_choice: { type: 'auto' },
        messages: [
          { role: 'user', content: 'look up innies' },
          { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'lookup_repo', input: { name: 'innies' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'repo lookup complete' }] }
        ]
      }
    });
    const res2 = createMockRes();

    await invoke(handlers[0], req2, res2);
    await invoke(handlers[1], req2, res2);
    await invoke(handlers[2], req2, res2);

    expect(res2.statusCode).toBe(200);
    expect((res2.body as any).content).toEqual([{ type: 'text', text: 'final answer' }]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const secondRequestBody = JSON.parse(String((fetchSpy.mock.calls[1]?.[1] as RequestInit)?.body ?? '{}'));
    expect(secondRequestBody.input).toEqual([
      { type: 'message', role: 'user', content: 'look up innies' },
      { type: 'function_call', call_id: 'call_compat_1', name: 'lookup_repo', arguments: '{"name":"innies"}' },
      { type: 'function_call_output', call_id: 'call_compat_1', output: 'repo lookup complete' }
    ]);

    fetchSpy.mockRestore();
  });
});
