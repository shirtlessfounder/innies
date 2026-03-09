import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
    Object.entries(input.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])
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
    if (chunk !== undefined) res.write(chunk);
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
      if (error) applyError(error, res);
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
  return layer.route.stack.map((entry: any) => entry.handle);
}

describe('proxy seller-mode route behavior', () => {
  let runtimeModule: RuntimeModule;
  let handlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/innies_test';
    process.env.SELLER_SECRET_ENC_KEY_B64 = process.env.SELLER_SECRET_ENC_KEY_B64 || Buffer.alloc(32, 7).toString('base64');
    runtimeModule = await import('../src/services/runtime.js');
    const proxyModule = await import('../src/routes/proxy.js') as ProxyRouteModule;
    handlers = getRouteHandlers(proxyModule.default as any, '/v1/proxy/*');
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.TOKEN_MODE_ENABLED_ORGS;

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
      model: 'claude-opus-4-6',
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
    vi.spyOn(runtimeModule.runtime.repos.sellerKeys, 'listActiveForRouting').mockResolvedValue([{
      id: 'seller-key-1',
      orgId: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      status: 'active',
      priorityWeight: 1,
      monthlyCapacityUsedUnits: 0,
      supportsStreaming: true
    } as any]);
    vi.spyOn(runtimeModule.runtime.repos.sellerKeys, 'getSecret').mockResolvedValue({
      id: 'seller-key-1',
      secret: 'sk-seller-live'
    } as any);
    vi.spyOn(runtimeModule.runtime.repos.sellerKeys, 'addCapacityUsage').mockResolvedValue(true);
    vi.spyOn(runtimeModule.runtime.repos.routingEvents, 'insert').mockResolvedValue(undefined);
    vi.spyOn(runtimeModule.runtime.services.metering, 'recordUsage').mockResolvedValue({
      id: 'usage_1',
      entry_type: 'usage'
    } as any);
  });

  afterEach(() => {
    delete process.env.TOKEN_MODE_ENABLED_ORGS;
    vi.restoreAllMocks();
  });

  it('records seller-mode non-stream requests with openclaw source metadata and ttfb', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      id: 'resp_seller_ok',
      usage: { input_tokens: 12, output_tokens: 3 }
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
        'x-openclaw-run-id': 'oc_run_123'
      },
      body: {
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        streaming: false,
        payload: {
          model: 'claude-opus-4-6',
          max_tokens: 16,
          messages: [{ role: 'user', content: 'hello' }]
        }
      }
    });
    const res = createMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-innies-upstream-key-id']).toBe('seller-key-1');
    expect(runtimeModule.runtime.repos.routingEvents.insert).toHaveBeenCalledWith(expect.objectContaining({
      ttfbMs: expect.any(Number),
      routeDecision: expect.objectContaining({
        reason: 'weighted_round_robin',
        provider_selection_reason: 'preferred_provider_selected',
        request_source: 'openclaw',
        openclaw_run_id: 'oc_run_123'
      })
    }));
  });

  it('records seller-mode streaming cli requests with pinned source metadata and ttfb', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      "event: message_start\ndata: {\"message\":{\"usage\":{\"input_tokens\":7,\"output_tokens\":2}}}\n\n",
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' }
      }
    ));

    const req = createMockReq({
      method: 'POST',
      path: '/v1/proxy/v1/messages',
      headers: {
        authorization: 'Bearer in_test_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123456',
        'anthropic-version': '2023-06-01',
        'x-app': 'cli',
        'user-agent': 'claude-cli/1.0'
      },
      body: {
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        streaming: true,
        payload: {
          model: 'claude-opus-4-6',
          stream: true,
          max_tokens: 16,
          messages: [{ role: 'user', content: 'hello' }]
        }
      }
    });
    const res = createStreamingMockRes();

    await invoke(handlers[0], req, res);
    await invoke(handlers[1], req, res);

    expect(res.writableEnded).toBe(true);
    expect(runtimeModule.runtime.repos.routingEvents.insert).toHaveBeenCalledWith(expect.objectContaining({
      ttfbMs: expect.any(Number),
      routeDecision: expect.objectContaining({
        reason: 'weighted_round_robin',
        provider_selection_reason: 'cli_provider_pinned',
        request_source: 'cli-claude'
      })
    }));
  });
});
