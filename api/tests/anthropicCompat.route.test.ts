import { describe, expect, it, beforeAll, beforeEach, afterEach, vi } from 'vitest';
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
    expect(headers['anthropic-beta']).toBe('foo-2026-01-01,bar-2026-02-02');
    expect(res.statusCode).toBe(200);

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
    expect(firstHeaders['anthropic-beta']).toBe('oauth-2025-04-20,claude-code-20250219');
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
    expect(firstHeaders['anthropic-beta']).toBe('fine-grained-tool-streaming-2025-05-14');
    expect(firstBody.stream).toBe(true);
    expect(firstBody.tools).toBeDefined();
    expect(firstBody.tool_choice).toEqual({ type: 'auto' });

    expect(secondHeaders.authorization).toBe('Bearer sk-ant-oat01-test-token');
    expect(secondHeaders['anthropic-beta']).toContain('oauth-2025-04-20');
    expect(secondHeaders['anthropic-beta']).toContain('claude-code-20250219');
    expect(secondBody.stream).toBe(false);
    expect(secondBody.tools).toBeUndefined();
    expect(secondBody.tool_choice).toBeUndefined();
    expect(secondBody.thinking).toBeUndefined();
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
});
