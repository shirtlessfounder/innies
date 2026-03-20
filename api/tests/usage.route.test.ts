import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AppError } from '../src/utils/errors.js';

type RuntimeModule = typeof import('../src/services/runtime.js');
type UsageRouteModule = typeof import('../src/routes/usage.js');

type MockReq = {
  method: string;
  path: string;
  originalUrl: string;
  body: unknown;
  params: Record<string, string>;
  query?: Record<string, string>;
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
  headers?: Record<string, string>;
  params?: Record<string, string>;
  query?: Record<string, string>;
}): MockReq {
  const lower = Object.fromEntries(
    Object.entries(input.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])
  );
  return {
    method: input.method.toUpperCase(),
    path: input.path,
    originalUrl: input.path,
    body: {},
    params: input.params ?? {},
    query: input.query ?? {},
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

function getRouteHandlers(router: any, routePath: string, method: 'get'): Array<(req: any, res: any, next: (error?: unknown) => void) => unknown> {
  const layer = router.stack.find((entry: any) => entry?.route?.path === routePath && entry?.route?.methods?.[method]);
  if (!layer) throw new Error(`route not found: ${routePath}`);
  return layer.route.stack.map((entry: any) => entry.handle);
}

describe('usage routes', () => {
  let runtimeModule: RuntimeModule;
  let requestHistoryHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/innies_test';
    process.env.SELLER_SECRET_ENC_KEY_B64 = process.env.SELLER_SECRET_ENC_KEY_B64 || Buffer.alloc(32, 7).toString('base64');
    runtimeModule = await import('../src/services/runtime.js');
    const mod = await import('../src/routes/usage.js') as UsageRouteModule;
    requestHistoryHandlers = getRouteHandlers(mod.default as any, '/v1/usage/me/requests', 'get');
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'findActiveByHash').mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      org_id: 'org_fnf',
      scope: 'buyer_proxy',
      is_active: true,
      expires_at: null
    } as any);
    vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'touchLastUsed').mockResolvedValue(undefined);
    vi.spyOn(runtimeModule.runtime.repos.routingAttribution, 'listOrgRequestHistory').mockResolvedValue([{
      request_id: 'req_1',
      attempt_no: 1,
      session_id: 'sess_1',
      admission_org_id: 'org_fnf',
      admission_cutover_id: 'cut_1',
      admission_routing_mode: 'self-free',
      consumer_org_id: 'org_fnf',
      buyer_key_id: 'buyer_1',
      serving_org_id: 'org_fnf',
      provider_account_id: 'acct_1',
      token_credential_id: 'cred_1',
      capacity_owner_user_id: 'user_1',
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      rate_card_version_id: 'rate_1',
      input_tokens: 11,
      output_tokens: 22,
      usage_units: 33,
      buyer_debit_minor: 0,
      contributor_earnings_minor: 0,
      currency: 'USD',
      metadata: null,
      created_at: '2026-03-20T10:00:00.000Z',
      prompt_preview: 'hello',
      response_preview: 'world',
      route_decision: { reason: 'cli_provider_pinned' },
      projector_states: []
    }] as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns post-cutover request history for the caller org', async () => {
    const req = createMockReq({
      method: 'GET',
      path: '/v1/usage/me/requests',
      headers: {
        authorization: 'Bearer in_buyer_token'
      }
    });
    const res = createMockRes();

    await invoke(requestHistoryHandlers[0], req, res);
    await invoke(requestHistoryHandlers[1], req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      orgId: 'org_fnf',
      requests: [expect.objectContaining({ request_id: 'req_1' })],
      nextCursor: null
    }));
    expect(runtimeModule.runtime.repos.routingAttribution.listOrgRequestHistory).toHaveBeenCalledWith({
      orgId: 'org_fnf',
      limit: 20,
      cursor: null,
      historyScope: 'post_cutover'
    });
  });

  it('accepts and emits full request-history cursors', async () => {
    const decodedCursor = {
      createdAt: '2026-03-19T09:00:00.000Z',
      requestId: 'req_8',
      attemptNo: 2
    };
    const encodedCursor = Buffer.from(JSON.stringify(decodedCursor), 'utf8').toString('base64url');
    vi.spyOn(runtimeModule.runtime.repos.routingAttribution, 'listOrgRequestHistory').mockResolvedValue([{
      request_id: 'req_9',
      attempt_no: 3,
      session_id: 'sess_1',
      admission_org_id: 'org_fnf',
      admission_cutover_id: 'cut_1',
      admission_routing_mode: 'self-free',
      consumer_org_id: 'org_fnf',
      buyer_key_id: 'buyer_1',
      serving_org_id: 'org_fnf',
      provider_account_id: 'acct_1',
      token_credential_id: 'cred_1',
      capacity_owner_user_id: 'user_1',
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      rate_card_version_id: 'rate_1',
      input_tokens: 11,
      output_tokens: 22,
      usage_units: 33,
      buyer_debit_minor: 0,
      contributor_earnings_minor: 0,
      currency: 'USD',
      metadata: null,
      created_at: '2026-03-20T10:00:00.000Z',
      prompt_preview: 'hello',
      response_preview: 'world',
      route_decision: { reason: 'cli_provider_pinned' },
      projector_states: []
    }] as any);

    const req = createMockReq({
      method: 'GET',
      path: '/v1/usage/me/requests',
      headers: {
        authorization: 'Bearer in_buyer_token'
      },
      query: {
        limit: '1',
        cursor: encodedCursor
      }
    });
    const res = createMockRes();

    await invoke(requestHistoryHandlers[0], req, res);
    await invoke(requestHistoryHandlers[1], req, res);

    expect(runtimeModule.runtime.repos.routingAttribution.listOrgRequestHistory).toHaveBeenCalledWith({
      orgId: 'org_fnf',
      limit: 1,
      cursor: decodedCursor,
      historyScope: 'post_cutover'
    });
    expect(res.body).toEqual(expect.objectContaining({
      nextCursor: Buffer.from(JSON.stringify({
        createdAt: '2026-03-20T10:00:00.000Z',
        requestId: 'req_9',
        attemptNo: 3
      }), 'utf8').toString('base64url')
    }));
  });
});
